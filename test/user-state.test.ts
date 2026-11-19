import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.ts';
import { openDatabase, reclaimDatabaseSpace } from '../src/db.ts';
import {
  cleanupUserStateOperations,
  compactUserStateChanges,
  headRevision,
  maintainUserState,
  readUserStateComposition,
} from '../src/user-state.ts';
import {
  parseUserStateMergeResponse,
  parseUserStateReadResponse,
  parseUserStateWorkspace,
  userStateEntityKey,
  type UserStateEntity,
  type UserStateOperation,
  type UserStateValue,
} from '../src/user-state-protocol.ts';
import { saveWork } from '../src/works.ts';
import { deviceHeaders } from './access.ts';

const work = (sourceNovelId = 'novel-1') => ({
  pluginId: 'example-source',
  sourceNovelId,
  novelPath: `/novel/${sourceNovelId}`,
  name: 'A work',
});
const library = (id = 'novel-1'): UserStateEntity => ({ kind: 'library', work: work(id) });
const reading = (id = 'novel-1', chapterPath = '/chapter/1'): UserStateEntity => ({
  kind: 'reading',
  work: work(id),
  chapter: { chapterPath },
});
const category = (id: string): UserStateEntity => ({ kind: 'category', categoryId: id });
const membership = (id: string, workId = 'novel-1'): UserStateEntity => ({
  kind: 'membership',
  work: work(workId),
  categoryId: id,
});
const operation = (
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

async function createFixture(initialNow = 1_700_000_000_000) {
  let clock = initialNow;
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-user-state-m1-'));
  const app = await buildApp({
    dataDir,
    userStateMaintenance: {
      now: () => clock,
      compactionIntervalMs: 0,
    },
  });
  const headers = await deviceHeaders(app, 'Primary Device');
  const secondHeaders = await deviceHeaders(app, 'Secondary Device');
  const workspace = parseUserStateWorkspace((await app.inject({ url: '/api/v1/user-state', headers })).json());
  const scope = { workspaceId: workspace.workspaceId, epoch: workspace.epoch };
  const merge = (operations: UserStateOperation[], author = headers) =>
    app.inject({ method: 'POST', url: '/api/v1/user-state/merge', headers: author, payload: { ...scope, operations } });
  const read = (after = 0, through?: number, limit = 200, author = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/user-state/read',
      headers: author,
      payload: { ...scope, after, ...(through === undefined ? {} : { through }), limit },
    });
  return {
    app,
    dataDir,
    headers,
    secondHeaders,
    workspace,
    scope,
    now: () => clock,
    advanceTime: (ms: number) => {
      clock += ms;
      return clock;
    },
    merge,
    read,
    close: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('headRevision remains monotonic across compaction, empty change log, and restarts', async () => {
  const f = await createFixture();
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const firstRes = await f.merge([
      operation(library('w1'), { inLibrary: true, addedAt: 100 }),
      operation(library('w2'), { inLibrary: true, addedAt: 200 }),
    ]);
    assert.equal(firstRes.statusCode, 200);
    const first = parseUserStateMergeResponse(firstRes.json());
    assert.equal(first.headRevision, 2);

    const secondRes = await f.merge([
      operation(library('w1'), { inLibrary: false, addedAt: null }, first.results[0].current!.revision),
      operation(library('w2'), { inLibrary: false, addedAt: null }, first.results[1].current!.revision),
    ]);
    assert.equal(secondRes.statusCode, 200);
    const second = parseUserStateMergeResponse(secondRes.json());
    assert.equal(second.headRevision, 4);

    f.advanceTime(8 * 86_400_000);
    const db = openDatabase(f.dataDir);
    try {
      const deleted = compactUserStateChanges(db, f.now(), 7 * 86_400_000);
      assert.equal(deleted, 2);
      assert.equal(headRevision(db), 4);
      // Even if all rows in user_state_changes were absent, head_revision preserves monotonicity.
      db.exec('DELETE FROM user_state_changes');
      assert.equal(headRevision(db), 4);
      const metaRow = db.prepare('SELECT head_revision FROM user_state_meta WHERE singleton=1').get() as { head_revision: number };
      assert.equal(metaRow.head_revision, 4);
    } finally {
      db.close();
    }

    const wsAfterCompact = parseUserStateWorkspace((await f.app.inject({ url: '/api/v1/user-state', headers: f.headers })).json());
    assert.equal(wsAfterCompact.headRevision, 4);
    assert.deepEqual(Object.keys(wsAfterCompact).sort(), ['epoch', 'headRevision', 'version', 'workspaceId']);

    await f.app.close();
    reopened = await buildApp({
      dataDir: f.dataDir,
      userStateMaintenance: { now: f.now, compactionIntervalMs: 0 },
    });
    const wsAfterRestart = parseUserStateWorkspace((await reopened.inject({ url: '/api/v1/user-state', headers: f.headers })).json());
    assert.equal(wsAfterRestart.headRevision, 4);

    const thirdRes = await reopened.inject({
      method: 'POST',
      url: '/api/v1/user-state/merge',
      headers: f.headers,
      payload: { ...f.scope, operations: [operation(library('w3'), { inLibrary: true, addedAt: 300 })] },
    });
    assert.equal(thirdRes.statusCode, 200);
    const third = parseUserStateMergeResponse(thirdRes.json());
    assert.equal(third.headRevision, 5);
    assert.equal(third.results[0].current!.revision, 5);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('superseded_at tracks latest revisions in O(1) across edits, category cascades, and restores while keeping read strict and lossless', async () => {
  const f = await createFixture();
  try {
    const createCat = parseUserStateMergeResponse((await f.merge([
      operation(category('fav'), { name: 'Favourites', sort: 0, deleted: false }),
    ])).json());
    const revCatCreate = createCat.results[0].current!.revision;

    const addMember = parseUserStateMergeResponse((await f.merge([
      operation(membership('fav', 'w1'), { included: true }),
    ])).json());
    const revMemberAdd = addMember.results[0].current!.revision;

    f.advanceTime(1_000);
    const deleteCat = parseUserStateMergeResponse((await f.merge([
      operation(category('fav'), { name: 'Favourites', sort: 0, deleted: true }, revCatCreate),
    ])).json());
    assert.equal(deleteCat.headRevision, 4);

    f.advanceTime(1_000);
    const restoreViaMember = parseUserStateMergeResponse((await f.merge([
      operation(membership('fav', 'w1'), { included: true }, 3),
    ])).json());
    assert.equal(restoreViaMember.headRevision, 6);

    const db = openDatabase(f.dataDir);
    let snapshotPayloads: { revision: number; entity_key: string; record: string; superseded_at: number | null }[];
    try {
      snapshotPayloads = db.prepare('SELECT revision, entity_key, record, superseded_at FROM user_state_changes ORDER BY revision').all() as typeof snapshotPayloads;
      assert.equal(snapshotPayloads.length, 6);
      // Revisions 1, 2, 3, 4 are superseded; revisions 5 (restored category) and 6 (membership) are active.
      assert.notEqual(snapshotPayloads[0].superseded_at, null);
      assert.notEqual(snapshotPayloads[1].superseded_at, null);
      assert.notEqual(snapshotPayloads[2].superseded_at, null);
      assert.notEqual(snapshotPayloads[3].superseded_at, null);
      assert.equal(snapshotPayloads[4].superseded_at, null);
      assert.equal(snapshotPayloads[5].superseded_at, null);
      assert.equal(snapshotPayloads[0].revision, revCatCreate);
      assert.equal(snapshotPayloads[1].revision, revMemberAdd);

      // Before grace period elapses, nothing is deleted.
      assert.equal(compactUserStateChanges(db, f.now() + 6 * 86_400_000, 7 * 86_400_000), 0);
      // After grace period elapses, only superseded rows are deleted.
      const compacted = compactUserStateChanges(db, f.now() + 8 * 86_400_000, 7 * 86_400_000);
      assert.equal(compacted, 4);

      const remaining = db.prepare('SELECT revision, entity_key, record, superseded_at FROM user_state_changes ORDER BY revision').all() as typeof snapshotPayloads;
      assert.equal(remaining.length, 2);
      assert.equal(remaining[0].revision, 5);
      assert.equal(remaining[1].revision, 6);
      // Revision payload immutability: JSON payload strings were never modified in place.
      assert.equal(remaining[0].record, snapshotPayloads[4].record);
      assert.equal(remaining[1].record, snapshotPayloads[5].record);
    } finally {
      db.close();
    }

    // Strict /read on an entirely compacted (after=0, through=4) range still conforms to parseUserStateReadResponse.
    const emptyRangeRes = await f.read(0, 4);
    assert.equal(emptyRangeRes.statusCode, 200);
    const emptyRange = parseUserStateReadResponse(emptyRangeRes.json());
    assert.deepEqual(Object.keys(emptyRange).sort(), ['epoch', 'hasMore', 'headRevision', 'nextCursor', 'records', 'through', 'version', 'workspaceId']);
    assert.equal(emptyRange.records.length, 0);
    assert.equal(emptyRange.hasMore, false);
    assert.equal(emptyRange.nextCursor, 4);
    assert.equal(emptyRange.through, 4);

    // Reading from 0 to head returns only the latest active records for both entities.
    const fullRead = parseUserStateReadResponse((await f.read(0)).json());
    assert.equal(fullRead.records.length, 2);
    assert.deepEqual(fullRead.records.map(r => r.revision), [5, 6]);
    assert.deepEqual(fullRead.records[0].value, { name: 'Favourites', sort: 0, deleted: false });
    assert.deepEqual(fullRead.records[1].value, { included: true });
  } finally {
    await f.close();
  }
});

test('2-stage user_state_operations cleanup nulls bodies, rejects stale replays with 409 atomically, and prunes expired fingerprints', async () => {
  const f = await createFixture();
  try {
    const op1 = operation(reading('w1'), { progress: 45, unread: false, readAt: 1000 });
    const res1 = parseUserStateMergeResponse((await f.merge([op1])).json());
    assert.equal(res1.results[0].status, 'applied');

    // Within body retention: exact replay succeeds idempotently.
    f.advanceTime(12 * 3_600_000);
    const replayOk = parseUserStateMergeResponse((await f.merge([op1], f.secondHeaders)).json());
    assert.deepEqual(replayOk.results[0], res1.results[0]);

    // Advance past body retention (24h), before fingerprint retention (30d).
    f.advanceTime(24 * 3_600_000);
    const db = openDatabase(f.dataDir);
    try {
      const stage1 = cleanupUserStateOperations(db, f.now(), 24 * 3_600_000, 30 * 86_400_000);
      assert.deepEqual(stage1, { nulledBodies: 1, deletedOperations: 0 });
      const row = db.prepare('SELECT payload_hash, result, created_at FROM user_state_operations WHERE operation_id=?').get(op1.operationId) as {
        payload_hash: string;
        result: string | null;
        created_at: number;
      };
      assert.equal(row.result, null);
      assert.ok(row.payload_hash.length === 64);
      assert.equal(row.created_at, 1_700_000_000_000);
    } finally {
      db.close();
    }

    // Stale replay with identical payload returns 409 and does NOT re-apply or mutate state.
    const staleSingle = await f.merge([op1]);
    assert.equal(staleSingle.statusCode, 409);

    // Multi-op batch containing a fresh op + the stale op rejects atomically with 409 before applying the fresh op.
    const freshOp = operation(library('should-not-apply'), { inLibrary: true, addedAt: 99 });
    const staleBatch = await f.merge([freshOp, op1]);
    assert.equal(staleBatch.statusCode, 409);

    // Stale replay with altered payload also returns 409.
    const alteredReplay = await f.merge([{ ...op1, value: { progress: 99, unread: false, readAt: 2000 } }]);
    assert.equal(alteredReplay.statusCode, 409);

    const wsAfter409 = parseUserStateWorkspace((await f.app.inject({ url: '/api/v1/user-state', headers: f.headers })).json());
    assert.equal(wsAfter409.headRevision, 1);
    const readAfter409 = parseUserStateReadResponse((await f.read(0)).json());
    assert.equal(readAfter409.records.length, 1);

    // Clamping check: fingerprintRetentionMs < bodyRetentionMs must clamp fingerprint retention >= bodyRetentionMs.
    const op2 = operation(reading('w2'), { progress: 10, unread: false, readAt: 1001 });
    assert.equal((await f.merge([op2])).statusCode, 200);
    const dbCheck = openDatabase(f.dataDir);
    try {
      const clampedPass = cleanupUserStateOperations(dbCheck, f.now() + 25 * 3_600_000, 24 * 3_600_000, 1_000);
      // op2 was created at f.now(), so at f.now() + 25h both bodyCutoff and clamped fingerprintCutoff are > f.now().
      assert.equal(clampedPass.deletedOperations, 2);
      // Verify clamping when a newer op3 is between 1s and 24h old:
      const op3CreatedAt = f.now() + 20 * 3_600_000;
      dbCheck.prepare('INSERT INTO user_state_operations(device_id,operation_id,payload_hash,result,created_at) VALUES(?,?,?,?,?)')
        .run('dev', 'op3-clamp', 'h', '{"ok":true}', op3CreatedAt);
      const clampRes = cleanupUserStateOperations(dbCheck, op3CreatedAt + 5_000, 24 * 3_600_000, 1_000);
      assert.deepEqual(clampRes, { nulledBodies: 0, deletedOperations: 0 });
      assert.ok(dbCheck.prepare('SELECT 1 FROM user_state_operations WHERE operation_id=?').get('op3-clamp'));
    } finally {
      dbCheck.close();
    }
  } finally {
    await f.close();
  }
});

test('upgrading old DB schema (NOT NULL result, missing head_revision/superseded_at/created_at, legacy current tables) preserves checksum and data', async () => {
  const f = await createFixture(Date.now());
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const op1 = operation(library('upgrade-w1'), { inLibrary: true, addedAt: 10 });
    const res1 = parseUserStateMergeResponse((await f.merge([op1])).json());
    const op2 = operation(library('upgrade-w1'), { inLibrary: false, addedAt: null }, res1.results[0].current!.revision);
    const res2 = parseUserStateMergeResponse((await f.merge([op2])).json());
    assert.equal(res2.headRevision, 2);

    await f.app.close();

    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    let checksumBefore: unknown;
    try {
      checksumBefore = db.prepare('SELECT checksum FROM schema_state').get()?.checksum;
      db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('prof-1', 'chap-1', '{"progress":50}');
      db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run('custom-setting', '"keep"');

      // Recreate old-shape user_state_* tables and legacy user_state_current_* / user_state_delta_* tables.
      db.exec(`
        DROP INDEX IF EXISTS user_state_changes_superseded;
        DROP INDEX IF EXISTS user_state_operations_created_at;
        DROP INDEX IF EXISTS user_state_operations_prunable_body;

        ALTER TABLE user_state_meta RENAME TO user_state_meta_new;
        CREATE TABLE user_state_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL, epoch TEXT NOT NULL);
        INSERT INTO user_state_meta(singleton, workspace_id, epoch) SELECT singleton, workspace_id, epoch FROM user_state_meta_new;
        DROP TABLE user_state_meta_new;

        ALTER TABLE user_state_changes RENAME TO user_state_changes_new;
        CREATE TABLE user_state_changes (revision INTEGER PRIMARY KEY AUTOINCREMENT, entity_key TEXT NOT NULL, record TEXT NOT NULL);
        INSERT INTO user_state_changes(revision, entity_key, record) SELECT revision, entity_key, record FROM user_state_changes_new;
        DROP TABLE user_state_changes_new;

        ALTER TABLE user_state_operations RENAME TO user_state_operations_new;
        CREATE TABLE user_state_operations (device_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(operation_id));
        INSERT INTO user_state_operations(device_id, operation_id, payload_hash, result)
          SELECT device_id, operation_id, payload_hash, result FROM user_state_operations_new;
        DROP TABLE user_state_operations_new;

        CREATE TABLE user_state_current_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), imported_v1 INTEGER NOT NULL);
        CREATE TABLE user_state_current_records (entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL);
        CREATE TABLE user_state_delta_bridge_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), imported_current_v2 INTEGER NOT NULL);
        CREATE TABLE user_state_delta_current_categories (delta_category_id TEXT PRIMARY KEY, current_category_id TEXT NOT NULL UNIQUE);
        CREATE TABLE user_state_delta_current_category_aliases (current_category_id TEXT PRIMARY KEY, delta_category_id TEXT NOT NULL);
        INSERT INTO user_state_current_records(entity_key, kind, item) VALUES('legacy', 'library', '{}');
      `);
    } finally {
      db.close();
    }

    const realNowBeforeReopen = Date.now();
    reopened = await buildApp({ dataDir: f.dataDir });

    const caps = (await reopened.inject('/api/v1/capabilities')).json();
    assert.equal(caps.readingStateVersion, 1);
    assert.equal(caps.userStateVersion, 1);
    assert.equal(caps.userStateCurrentVersion, undefined);
    assert.equal((await reopened.inject({ url: '/api/v1/user-state/current', headers: f.headers })).statusCode, 404);

    // Pre-upgrade receipt replays cleanly after upgrade because created_at was backfilled to ~now, not 0.
    const replayRes = await reopened.inject({
      method: 'POST',
      url: '/api/v1/user-state/merge',
      headers: f.headers,
      payload: { ...f.scope, operations: [op1] },
    });
    assert.equal(replayRes.statusCode, 200, replayRes.body);
    assert.deepEqual(parseUserStateMergeResponse(replayRes.json()).results[0], res1.results[0]);

    const check = openDatabase(f.dataDir);
    try {
      assert.equal(check.prepare('SELECT checksum FROM schema_state').get()?.checksum, checksumBefore);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get()?.n, 1);
      assert.equal(check.prepare('SELECT value FROM admin_settings WHERE key=?').get('custom-setting')?.value, '"keep"');

      // All 5 retired transitional tables were dropped.
      const legacyCount = check.prepare(`SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN (
        'user_state_current_meta', 'user_state_current_records', 'user_state_delta_bridge_meta',
        'user_state_delta_current_categories', 'user_state_delta_current_category_aliases'
      )`).get() as { n: number };
      assert.equal(legacyCount.n, 0);

      // head_revision was backfilled from max(revision) = 2.
      const meta = check.prepare('SELECT head_revision FROM user_state_meta WHERE singleton=1').get() as { head_revision: number };
      assert.equal(meta.head_revision, 2);

      // Pre-upgrade superseded change row (revision 1) got non-null superseded_at; latest (revision 2) stayed null.
      const changes = check.prepare('SELECT revision, superseded_at FROM user_state_changes ORDER BY revision').all() as {
        revision: number;
        superseded_at: number | null;
      }[];
      assert.equal(changes.length, 2);
      assert.ok(changes[0].superseded_at !== null && changes[0].superseded_at >= realNowBeforeReopen);
      assert.equal(changes[1].superseded_at, null);

      // user_state_operations was rebuilt with nullable result and non-zero created_at.
      const opInfo = check.prepare('PRAGMA table_info(user_state_operations)').all() as { name: string; notnull: number }[];
      const resultCol = opInfo.find(c => c.name === 'result');
      const createdCol = opInfo.find(c => c.name === 'created_at');
      assert.equal(resultCol?.notnull, 0);
      assert.ok(createdCol !== undefined);

      const ops = check.prepare('SELECT created_at FROM user_state_operations').all() as { created_at: number }[];
      assert.equal(ops.length, 2);
      assert.ok(ops.every(o => o.created_at >= realNowBeforeReopen));

      // Verify Stage 1 nulling works without NOT NULL constraint failure on the upgraded DB.
      const stage1 = cleanupUserStateOperations(check, Date.now() + 2 * 86_400_000, 86_400_000, 30 * 86_400_000);
      assert.equal(stage1.nulledBodies, 2);
    } finally {
      check.close();
    }
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('new DB uses incremental auto_vacuum, reclaimDatabaseSpace frees pages and truncates WAL, and periodic compaction closes cleanly', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-vacuum-'));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const db = openDatabase(dataDir);
    try {
      const autoVacuum = (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
      assert.equal(autoVacuum, 2);

      // Seed large superseded changes + operations, then compact and reclaim space.
      const bigPadding = 'x'.repeat(16_384);
      const insertChange = db.prepare('INSERT INTO user_state_changes(revision, entity_key, record, superseded_at) VALUES(?,?,?,?)');
      const insertOp = db.prepare('INSERT INTO user_state_operations(device_id, operation_id, payload_hash, result, created_at) VALUES(?,?,?,?,?)');
      for (let i = 1; i <= 40; i++) {
        insertChange.run(i, `k-${i % 5}`, JSON.stringify({ pad: bigPadding }), 100);
        insertOp.run('dev-1', `op-${i}`, 'hash', JSON.stringify({ pad: bigPadding }), 100);
      }
      db.prepare('UPDATE user_state_meta SET head_revision=40 WHERE singleton=1').run();

      const res = maintainUserState(db, {
        now: () => 100 + 31 * 86_400_000,
        supersededGraceMs: 7 * 86_400_000,
        operationBodyRetentionMs: 86_400_000,
        operationFingerprintRetentionMs: 30 * 86_400_000,
      });
      assert.equal(res.deletedChanges, 40);
      assert.equal(res.nulledOperationBodies, 40);
      assert.equal(res.deletedOperations, 40);
      assert.ok(res.reclaimed !== null);
      assert.equal(res.reclaimed.autoVacuum, 2);
      assert.ok(res.reclaimed.freelistBefore > 0);
      assert.equal(res.reclaimed.freelistAfter, 0);
      assert.ok(res.reclaimed.reclaimedPages > 0);
      assert.equal(res.reclaimed.checkpoint.busy, 0);

      assert.throws(() => reclaimDatabaseSpace(db, 0), RangeError);
      assert.equal(headRevision(db), 40);
    } finally {
      db.close();
    }

    // Verify periodic maintenance timer runs on ready, executes compaction, and shuts down cleanly without hanging.
    let clock = 1_700_000_000_000;
    app = await buildApp({
      dataDir,
      userStateMaintenance: {
        now: () => clock,
        supersededGraceMs: 1_000,
        compactionIntervalMs: 25,
      },
    });
    const headers = await deviceHeaders(app);
    const ws = parseUserStateWorkspace((await app.inject({ url: '/api/v1/user-state', headers })).json());
    const scope = { workspaceId: ws.workspaceId, epoch: ws.epoch };
    const first = parseUserStateMergeResponse((await app.inject({
      method: 'POST',
      url: '/api/v1/user-state/merge',
      headers,
      payload: { ...scope, operations: [operation(library('periodic'), { inLibrary: true, addedAt: 1 })] },
    })).json());
    await app.inject({
      method: 'POST',
      url: '/api/v1/user-state/merge',
      headers,
      payload: { ...scope, operations: [operation(library('periodic'), { inLibrary: false, addedAt: null }, first.results[0].current!.revision)] },
    });
    clock += 5_000;
    for (let attempt = 0; attempt < 40; attempt++) {
      const checkDb = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly: true });
      let count = 0;
      try {
        count = Number((checkDb.prepare('SELECT COUNT(*) AS n FROM user_state_changes WHERE superseded_at IS NOT NULL').get() as { n: number }).n);
      } finally {
        checkDb.close();
      }
      if (count === 0) break;
      await delay(20);
    }
    const verifyDb = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly: true });
    try {
      const supersededLeft = Number((verifyDb.prepare('SELECT COUNT(*) AS n FROM user_state_changes WHERE superseded_at IS NOT NULL').get() as { n: number }).n);
      assert.equal(supersededLeft, 0);
    } finally {
      verifyDb.close();
    }
    await app.close();
    app = undefined;
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('readUserStateComposition reads directly from user_state_records without user_state_current_records', async () => {
  const f = await createFixture();
  try {
    const identity = { pluginId: 'example-source', novelId: 'comp-1', novelPath: '/novel/comp-1' };
    const compositionDoc = {
      version: 1 as const,
      updatedAt: 500,
      entries: [{
        id: 'entry-1',
        path: '/ch/1',
        storageChapterNumber: '1',
        primarySource: 0,
        sources: [{
          ...identity,
          chapterPath: '/ch/1',
          sourceChapterId: 'src-1',
          chapterNumber: '1',
          name: 'Source 1',
          position: 1,
          page: '1',
          contentType: 'text' as const,
          releaseTime: null,
        }],
        user: { included: true, order: 1, name: 'Manual Shared Name', chapterNumber: '1' },
      }],
    };
    const mergeRes = await f.merge([
      operation({ kind: 'composition', work: { ...work('comp-1'), sourceNovelId: 'comp-1', novelPath: '/novel/comp-1' } }, { composition: compositionDoc }),
    ]);
    assert.equal(mergeRes.statusCode, 200);

    const db = openDatabase(f.dataDir);
    try {
      const loaded = readUserStateComposition(db, identity);
      assert.deepEqual(loaded, compositionDoc);
      const saved = saveWork(db, f.dataDir, {
        schemaVersion: 1,
        identity,
        novel: { name: 'Comp Work', author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
        cover: null,
        chapters: { '1': 'Source 1' },
      });
      assert.equal(saved.metadata.chapterComposition?.entries[0].user.name, 'Manual Shared Name');
      assert.equal(userStateEntityKey({ kind: 'composition', work: { ...work('comp-1'), sourceNovelId: 'comp-1', novelPath: '/novel/comp-1' } }),
        JSON.stringify(['composition', JSON.stringify(['example-source', 'id', 'comp-1'])]));
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
