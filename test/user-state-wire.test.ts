import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import {
  parseUserStateMergeResponse,
  parseUserStateReadResponse,
  parseUserStateRetentionState,
  parseUserStateSnapshotResponse,
  parseUserStateWorkspace,
  userStateEntityKey,
  type UserStateEntity,
  type UserStateOperation,
  type UserStateRecord,
  type UserStateValue,
} from '../src/user-state-protocol.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const work = (id = 'novel-1') => ({
  pluginId: 'wire-src',
  sourceNovelId: id,
  novelPath: `/novel/${id}`,
  name: `Wire Work ${id}`,
});
const reading = (id = 'novel-1', chapterPath = '/ch/1'): UserStateEntity => ({
  kind: 'reading',
  work: work(id),
  chapter: { chapterPath, name: 'Ch 1' },
});
const bookmark = (id = 'novel-1', chapterPath = '/ch/1'): UserStateEntity => ({
  kind: 'bookmark',
  work: work(id),
  chapter: { chapterPath, name: 'Ch 1' },
});
const category = (categoryId: string): UserStateEntity => ({ kind: 'category', categoryId });
const membership = (categoryId: string, id = 'novel-1'): UserStateEntity => ({
  kind: 'membership',
  work: work(id),
  categoryId,
});
const op = (
  entity: UserStateEntity,
  value: UserStateValue,
  baseRevision = 0,
  seed = false,
): UserStateOperation => ({
  operationId: randomUUID(),
  entity,
  value,
  baseRevision,
  ...(seed ? { seed: true } : {}),
});

test('live TCP HTTP wire protocol exercises capabilities, merge, read, stage-1 409, 410->snapshot pagination, seed-skipped, reset, Policy 2-C, and 413', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-wire-server-'));
  let clock = Date.UTC(2026, 6, 15, 12, 0, 0);
  const app = await buildApp({
    dataDir,
    userStateMaintenance: {
      now: () => clock,
      compactionIntervalMs: 0,
      supersededGraceMs: 1_000,
      operationBodyRetentionMs: 1_000,
      operationFingerprintRetentionMs: 60_000,
      tombstoneGraceMs: 5_000,
    },
  });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const devA = await deviceHeaders(app, 'Wire-Device-A');
    const devB = await deviceHeaders(app, 'Wire-Device-B');
    const devC = await deviceHeaders(app, 'Wire-Device-C');
    const admin = await consoleHeaders(app, dataDir);

    // 1. Capabilities negotiation
    const capsRes = await fetch(`${baseUrl}/api/v1/capabilities`);
    assert.equal(capsRes.status, 200);
    const caps = await capsRes.json();
    assert.equal(caps.readingStateVersion, 1);
    assert.equal(caps.userStateRetentionVersion, 1);

    // 2. Client A reads strict /user-state & /retention and merges state
    const wsA = parseUserStateWorkspace(await (await fetch(`${baseUrl}/api/v1/user-state`, { headers: devA })).json());
    const retA = parseUserStateRetentionState(await (await fetch(`${baseUrl}/api/v1/user-state/retention`, { headers: devA })).json());
    assert.equal(retA.seedAllowed, true);
    assert.equal(retA.compactedThrough, 0);

    const scope = { workspaceId: wsA.workspaceId, epoch: wsA.epoch };
    const opRead = op(reading('w1'), { progress: 65, readAt: clock - 1_000 });
    const opBmTomb = op(bookmark('w1'), { bookmarked: false });
    const opCat = op(category('cat-1'), { name: 'Shelf', sort: 0, deleted: false });
    const opMem = op(membership('cat-1', 'w1'), { included: true });

    const merge1Res = await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...devA, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, operations: [opRead, opBmTomb, opCat, opMem] }),
    });
    assert.equal(merge1Res.status, 200);
    const merge1 = parseUserStateMergeResponse(await merge1Res.json());
    assert.equal(merge1.headRevision, 4);

    // 3. Client B pulls via POST /user-state/read
    const readBRes = await fetch(`${baseUrl}/api/v1/user-state/read`, {
      method: 'POST',
      headers: { ...devB, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, after: 0, through: merge1.headRevision }),
    });
    assert.equal(readBRes.status, 200);
    const readB = parseUserStateReadResponse(await readBRes.json());
    assert.equal(readB.records.length, 4);

    // 4. Stage-1 cleanup -> replay identical operationId returns HTTP 409
    clock += 2_000;
    const compactStage1 = await fetch(`${baseUrl}/api/v1/admin/user-state/compact`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(compactStage1.status, 200);
    const replayRes = await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...devA, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, operations: [opRead] }),
    });
    assert.equal(replayRes.status, 409);

    // 5. Physical tombstone GC -> POST /read with after < compactedThrough returns 410 cursor-compacted
    clock += 10_000;
    const compactGc = await fetch(`${baseUrl}/api/v1/admin/user-state/compact`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(compactGc.status, 200);

    const goneRes = await fetch(`${baseUrl}/api/v1/user-state/read`, {
      method: 'POST',
      headers: { ...devB, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, after: 0, through: 4 }),
    });
    assert.equal(goneRes.status, 410);
    assert.equal((await goneRes.json()).code, 'cursor-compacted');

    // 6. Multi-page POST /user-state/snapshot (limit: 1) + concurrent write during pagination
    const page1Res = await fetch(`${baseUrl}/api/v1/user-state/snapshot`, {
      method: 'POST',
      headers: { ...devB, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, limit: 1 }),
    });
    assert.equal(page1Res.status, 200);
    const page1 = parseUserStateSnapshotResponse(await page1Res.json());
    assert.equal(page1.hasMore, true);
    assert.equal(page1.seedAllowed, false);
    assert.equal(page1.snapshotRevision, 4);

    // Concurrent merge during pagination advances headRevision to 5
    const concurrentOp = op(reading('w2'), { progress: 30, readAt: clock });
    const concurrentMerge = parseUserStateMergeResponse(await (await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...devA, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, operations: [concurrentOp] }),
    })).json());
    assert.equal(concurrentMerge.headRevision, 5);

    const collected: UserStateRecord[] = [...page1.records];
    let snapCursor = page1.nextEntityKey;
    let snapRev = page1.snapshotRevision;
    while (snapCursor !== null) {
      const nextRes = await fetch(`${baseUrl}/api/v1/user-state/snapshot`, {
        method: 'POST',
        headers: { ...devB, 'content-type': 'application/json' },
        body: JSON.stringify({ ...scope, afterEntityKey: snapCursor, limit: 1 }),
      });
      assert.equal(nextRes.status, 200);
      const nextPage = parseUserStateSnapshotResponse(await nextRes.json());
      snapRev = Math.min(snapRev, nextPage.snapshotRevision);
      collected.push(...nextPage.records);
      snapCursor = nextPage.nextEntityKey;
    }
    assert.ok(collected.length >= 3);

    // Follow-up POST /read catches up from snapshotRevision (4) to headRevision (5)
    const catchupRes = parseUserStateReadResponse(await (await fetch(`${baseUrl}/api/v1/user-state/read`, {
      method: 'POST',
      headers: { ...devB, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, after: snapRev, through: concurrentMerge.headRevision }),
    })).json());
    assert.equal(catchupRes.records.length, 1);
    assert.equal(catchupRes.records[0].operationId, concurrentOp.operationId);

    // 7. seed: true when seedAllowed === false: missing/GC'd -> current: null; existing -> current: <record>
    const seedMissing = op(bookmark('w1'), { bookmarked: true }, 0, true);
    const seedExisting = op(reading('w1'), { progress: 99, readAt: clock }, 0, true);
    const seedRes = parseUserStateMergeResponse(await (await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...devC, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, operations: [seedMissing, seedExisting] }),
    })).json());
    assert.equal(seedRes.results[0].status, 'seed-skipped');
    assert.equal(seedRes.results[0].current, null);
    assert.equal(seedRes.results[1].status, 'seed-skipped');
    assert.ok(seedRes.results[1].current !== null);
    assert.equal((seedRes.results[1].current!.value as { progress: number }).progress, 65);

    // Category deletion + membership restore in one merge batch preserves monotonic headRevision
    const catRec = collected.find(r => r.entity.kind === 'category' && r.entity.categoryId === 'cat-1')!;
    const memRec = collected.find(r => r.entity.kind === 'membership' && r.entity.categoryId === 'cat-1')!;
    const batchDelRestore = parseUserStateMergeResponse(await (await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...devA, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope,
        operations: [
          op(category('cat-1'), { name: 'Shelf', sort: 0, deleted: true }, catRec.revision),
          op(membership('cat-1', 'w1'), { included: true }, memRec.revision),
        ],
      }),
    })).json());
    assert.ok(batchDelRestore.headRevision >= concurrentMerge.headRevision);
    assert.equal(batchDelRestore.results[0].status, 'applied');

    // 8. Admin reset rotates epoch; old epoch /read returns 409
    const resetRes = await fetch(`${baseUrl}/api/v1/admin/user-state/reset`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resetRes.status, 200);
    const oldReadAfterReset = await fetch(`${baseUrl}/api/v1/user-state/read`, {
      method: 'POST',
      headers: { ...devB, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, after: 0 }),
    });
    assert.equal(oldReadAfterReset.status, 409);

    // 9. Policy 2-C: compactedThrough > 0 with seedAllowed === true & seedCutoffAt !== null
    const ws2 = parseUserStateWorkspace(await (await fetch(`${baseUrl}/api/v1/user-state`, { headers: devA })).json());
    assert.notEqual(ws2.epoch, scope.epoch);
    assert.equal(ws2.headRevision, 0);
    const scope2 = { workspaceId: ws2.workspaceId, epoch: ws2.epoch };

    const patch2c = await fetch(`${baseUrl}/api/v1/admin/user-state/retention`, {
      method: 'PATCH',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ slidingWindow: { enabled: true, months: 3 } }),
    });
    assert.equal(patch2c.status, 200);

    const oldReadAt = clock - 150 * 86_400_000;
    const recentReadAt = clock - 5 * 86_400_000;
    await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...devA, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope2,
        operations: [
          op(reading('w-old'), { progress: 100, readAt: oldReadAt }),
          op(reading('w-recent'), { progress: 80, readAt: recentReadAt }),
        ],
      }),
    });
    await fetch(`${baseUrl}/api/v1/admin/user-state/compact`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const ret2c = parseUserStateRetentionState(await (await fetch(`${baseUrl}/api/v1/user-state/retention`, { headers: devC })).json());
    assert.ok(ret2c.compactedThrough > 0);
    assert.equal(ret2c.seedAllowed, true);
    assert.ok(ret2c.seedCutoffAt !== null);

    // New Client C gets 410 on /read(after: 0), reconciles via /snapshot, and seeds >= cutoff & readAt: null while skipping < cutoff
    const cRead = await fetch(`${baseUrl}/api/v1/user-state/read`, {
      method: 'POST',
      headers: { ...devC, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope2, after: 0, through: ret2c.headRevision }),
    });
    assert.equal(cRead.status, 410);
    const cSnap = parseUserStateSnapshotResponse(await (await fetch(`${baseUrl}/api/v1/user-state/snapshot`, {
      method: 'POST',
      headers: { ...devC, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope2 }),
    })).json());
    assert.equal(cSnap.records.length, 1);
    assert.equal(cSnap.seedAllowed, true);

    const cSeedOld = op(reading('w-c-old'), { progress: 100, readAt: ret2c.seedCutoffAt! - 1 }, 0, true);
    const cSeedNull = op(reading('w-c-null'), { progress: 50, readAt: null }, 0, true);
    const cSeedRecent = op(reading('w-c-recent'), { progress: 90, readAt: ret2c.seedCutoffAt! + 1_000 }, 0, true);
    const cMerge = parseUserStateMergeResponse(await (await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...devC, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope2, operations: [cSeedOld, cSeedNull, cSeedRecent] }),
    })).json());
    assert.equal(cMerge.results[0].status, 'seed-skipped');
    assert.equal(cMerge.results[0].current, null);
    assert.equal(cMerge.results[1].status, 'applied');
    assert.equal(cMerge.results[2].status, 'applied');

    // 10. Single record > 32 MiB yields HTTP 413 on /read and /snapshot without corrupting state
    const db = openDatabase(dataDir);
    try {
      const giantEntity = reading('w-giant-413');
      const giantKey = userStateEntityKey(giantEntity);
      const nextRev = cMerge.headRevision + 1;
      const giantRecord = JSON.stringify({
        entity: giantEntity,
        value: { progress: 10, readAt: clock },
        revision: nextRev,
        operationId: 'op-giant-413',
        updatedAt: clock,
        deviceId: 'dev',
        deviceName: 'x'.repeat(33 * 1024 * 1024),
      });
      db.prepare('INSERT INTO user_state_records(entity_key,kind,revision,record) VALUES(?,?,?,?)').run(giantKey, 'reading', nextRev, giantRecord);
      db.prepare('INSERT INTO user_state_changes(revision,entity_key,record) VALUES(?,?,?)').run(nextRev, giantKey, giantRecord);
      db.prepare('UPDATE user_state_meta SET head_revision=? WHERE singleton=1').run(nextRev);
    } finally {
      db.close();
    }

    const read413 = await fetch(`${baseUrl}/api/v1/user-state/read`, {
      method: 'POST',
      headers: { ...devA, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope2, after: cMerge.headRevision, through: cMerge.headRevision + 1 }),
    });
    assert.equal(read413.status, 413);

    const snap413 = await fetch(`${baseUrl}/api/v1/user-state/snapshot`, {
      method: 'POST',
      headers: { ...devA, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope2, afterEntityKey: userStateEntityKey(reading('w-giant-412')) }),
    });
    assert.equal(snap413.status, 413);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
