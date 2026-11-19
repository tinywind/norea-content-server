import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import {
  DEFAULT_USER_STATE_RETENTION_CONFIG,
  MAX_TIMER_DELAY_MS,
  computeSlidingWindowCutoffMs,
  headRevision,
  maintainUserState,
  updateUserStateRetentionConfig,
} from '../src/user-state.ts';
import {
  parseUserStateMergeResponse,
  parseUserStateReadResponse,
  parseUserStateRetentionState,
  parseUserStateSnapshotResponse,
  parseUserStateWorkspace,
  userStateEntityKey,
  type UserStateEntity,
  type UserStateOperation,
  type UserStateValue,
} from '../src/user-state-protocol.ts';
import { recordWorkMigrationLineage } from '../src/work-migration-lineage.ts';
import { saveWork, deleteWork } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const work = (id = 'novel-1', pluginId = 'example-source') => ({
  pluginId,
  sourceNovelId: id,
  novelPath: `/novel/${id}`,
  name: `Work ${id}`,
});
const library = (id = 'novel-1'): UserStateEntity => ({ kind: 'library', work: work(id) });
const reading = (id = 'novel-1', chapterPath = '/chapter/1'): UserStateEntity => ({
  kind: 'reading',
  work: work(id),
  chapter: { chapterPath },
});
const bookmark = (id = 'novel-1', chapterPath = '/chapter/1'): UserStateEntity => ({
  kind: 'bookmark',
  work: work(id),
  chapter: { chapterPath },
});
const resume = (id = 'novel-1'): UserStateEntity => ({ kind: 'resume', work: work(id) });
const category = (id: string): UserStateEntity => ({ kind: 'category', categoryId: id });
const membership = (id: string, workId = 'novel-1'): UserStateEntity => ({
  kind: 'membership',
  work: work(workId),
  categoryId: id,
});
const composition = (id = 'novel-1'): UserStateEntity => ({ kind: 'composition', work: work(id) });
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

async function createRetentionFixture(initialNow = Date.UTC(2026, 2, 31, 12, 0, 0), tombstoneGraceMs?: number) {
  let clock = initialNow;
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-retention-m2-'));
  const app = await buildApp({
    dataDir,
    userStateMaintenance: {
      now: () => clock,
      compactionIntervalMs: 0,
      ...(tombstoneGraceMs === undefined ? {} : { tombstoneGraceMs }),
    },
  });
  const headers = await deviceHeaders(app, 'Device A');
  const secondHeaders = await deviceHeaders(app, 'Device B');
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
  const retention = (author = headers) => app.inject({ url: '/api/v1/user-state/retention', headers: author });
  const snapshot = (afterEntityKey?: string | null, limit?: number, author = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/user-state/snapshot',
      headers: author,
      payload: {
        ...scope,
        ...(afterEntityKey !== undefined ? { afterEntityKey } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    });
  return {
    app,
    dataDir,
    headers,
    secondHeaders,
    workspace,
    scope,
    now: () => clock,
    setNow: (next: number) => {
      clock = next;
      return clock;
    },
    advanceDays: (days: number) => {
      clock += days * 86_400_000;
      return clock;
    },
    merge,
    read,
    retention,
    snapshot,
    close: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('computeSlidingWindowCutoffMs handles UTC calendar months and month-end clamping accurately', () => {
  assert.equal(
    computeSlidingWindowCutoffMs(Date.UTC(2026, 2, 31, 15, 30, 0), 1),
    Date.UTC(2026, 1, 28, 15, 30, 0),
  );
  assert.equal(
    computeSlidingWindowCutoffMs(Date.UTC(2024, 1, 29, 8, 0, 0), 12),
    Date.UTC(2023, 1, 28, 8, 0, 0),
  );
  assert.equal(
    computeSlidingWindowCutoffMs(Date.UTC(2026, 0, 15, 0, 0, 0), 12),
    Date.UTC(2025, 0, 15, 0, 0, 0),
  );
});

test('Policy 2-A prunes old non-library reading/resume (including Unix-second timestamps) and blocks seed resurrection', async () => {
  const f = await createRetentionFixture();
  try {
    const oldSec = Math.floor((f.now() - 100 * 86_400_000) / 1000);
    const recentSec = Math.floor((f.now() - 5 * 86_400_000) / 1000);

    const mergeRes = parseUserStateMergeResponse((await f.merge([
      op(library('in-lib'), { inLibrary: true, addedAt: oldSec }),
      op(reading('in-lib', '/c1'), { progress: 80, unread: false, readAt: oldSec }),
      op(library('not-lib'), { inLibrary: false, addedAt: null }),
      op(reading('not-lib', '/c1'), { progress: 60, unread: false, readAt: oldSec }),
      op(resume('not-lib'), { chapter: { chapterPath: '/c1' }, anchor: null, openedAt: oldSec }),
      op(bookmark('not-lib', '/c1'), { bookmarked: true }),
      op(reading('untracked', '/c1'), { progress: 30, unread: false, readAt: oldSec }),
      op(reading('recent-nonlib', '/c1'), { progress: 40, unread: false, readAt: recentSec }),
    ])).json());
    assert.equal(mergeRes.headRevision, 8);

    // Disabled by default: maintenance does not prune non-library reading/resume.
    const db = openDatabase(f.dataDir);
    try {
      const disabledRun = maintainUserState(db, { now: f.now, tombstoneGraceMs: 400 * 86_400_000 });
      assert.equal(disabledRun.prunedNonLibraryReading, 0);

      updateUserStateRetentionConfig(db, { pruneNonLibraryReading: { enabled: true, days: 90 } }, f.now());
      const enabledRun = maintainUserState(db, { now: f.now, tombstoneGraceMs: 400 * 86_400_000 });
      assert.equal(enabledRun.prunedNonLibraryReading, 3); // not-lib reading + not-lib resume + untracked reading
      assert.equal(headRevision(db), 8);

      // Verify in-lib reading, recent non-lib reading, and bookmark survived.
      const keys = (db.prepare('SELECT entity_key FROM user_state_records ORDER BY entity_key').all() as { entity_key: string }[]).map(
        r => r.entity_key,
      );
      assert.ok(keys.includes(userStateEntityKey(reading('in-lib', '/c1'))));
      assert.ok(keys.includes(userStateEntityKey(reading('recent-nonlib', '/c1'))));
      assert.ok(keys.includes(userStateEntityKey(bookmark('not-lib', '/c1'))));
      assert.ok(!keys.includes(userStateEntityKey(reading('not-lib', '/c1'))));
      assert.ok(!keys.includes(userStateEntityKey(resume('not-lib'))));
      assert.ok(!keys.includes(userStateEntityKey(reading('untracked', '/c1'))));
    } finally {
      db.close();
    }

    const retState = parseUserStateRetentionState((await f.retention()).json());
    assert.ok(retState.compactedThrough > 0);
    assert.equal(retState.seedAllowed, false);

    // seed: true cannot resurrect pruned non-library reading.
    const seedRes = parseUserStateMergeResponse((await f.merge([
      op(reading('not-lib', '/c1'), { progress: 99, unread: false, readAt: recentSec }, 0, true),
    ], f.secondHeaders)).json());
    assert.equal(seedRes.results[0].status, 'seed-skipped');
    assert.equal(seedRes.results[0].current, null);

    // Explicit edit still succeeds.
    const explicitRes = parseUserStateMergeResponse((await f.merge([
      op(reading('not-lib', '/c1'), { progress: 100, unread: false, readAt: recentSec }, 0, false),
    ], f.secondHeaders)).json());
    assert.equal(explicitRes.results[0].status, 'applied');
    assert.equal(explicitRes.headRevision, 9);
  } finally {
    await f.close();
  }
});

test('Policy 2-B strips readAt and resume via immutable new revisions, preserves progress, and is idempotent', async () => {
  const f = await createRetentionFixture();
  try {
    const oldSec = Math.floor((f.now() - 200 * 86_400_000) / 1000);
    const recentSec = Math.floor((f.now() - 10 * 86_400_000) / 1000);

    const mergeRes = parseUserStateMergeResponse((await f.merge([
      op(reading('w1', '/c1'), { progress: 85, unread: false, readAt: oldSec }),
      op(reading('w1', '/c2'), { progress: 100, unread: false, readAt: recentSec }),
      op(resume('w1'), { chapter: { chapterPath: '/c1' }, anchor: { segmentIndex: 1, segmentCount: 5, offset: 0.4, progress: 85, savedAt: f.now() - 200 * 86_400_000 }, openedAt: oldSec }),
    ])).json());
    assert.equal(mergeRes.headRevision, 3);

    const db = openDatabase(f.dataDir);
    try {
      const beforeChanges = db.prepare('SELECT revision, record FROM user_state_changes ORDER BY revision').all() as {
        revision: number;
        record: string;
      }[];
      updateUserStateRetentionConfig(db, { stripReadingTimestamps: { enabled: true, days: 180 } }, f.now());
      const firstRun = maintainUserState(db, { now: f.now, supersededGraceMs: 400 * 86_400_000, tombstoneGraceMs: 400 * 86_400_000 });
      assert.equal(firstRun.strippedReadingTimestamps, 2);
      assert.equal(headRevision(db), 5);

      // Prior revision JSON payloads were never mutated in place (R1.3).
      const afterChanges = db.prepare('SELECT revision, record, superseded_at FROM user_state_changes ORDER BY revision').all() as {
        revision: number;
        record: string;
        superseded_at: number | null;
      }[];
      assert.equal(afterChanges.length, 5);
      assert.equal(afterChanges[0].record, beforeChanges[0].record);
      assert.notEqual(afterChanges[0].superseded_at, null);
      assert.equal(afterChanges[2].record, beforeChanges[2].record);
      assert.notEqual(afterChanges[2].superseded_at, null);

      // Idempotent second run produces 0 new revisions.
      const secondRun = maintainUserState(db, { now: f.now, supersededGraceMs: 400 * 86_400_000, tombstoneGraceMs: 400 * 86_400_000 });
      assert.equal(secondRun.strippedReadingTimestamps, 0);
      assert.equal(headRevision(db), 5);

      // Before tombstone GC, incremental read from 3 returns both stripped revisions (4 and 5).
      const beforeGcRead = parseUserStateReadResponse((await f.read(3)).json());
      assert.equal(beforeGcRead.records.length, 2);

      // Even after tombstone GC runs, stripped non-zero reading is NOT deleted as a tombstone.
      const laterGc = maintainUserState(db, { now: () => f.now() + 400 * 86_400_000, tombstoneGraceMs: 30 * 86_400_000 });
      assert.equal(laterGc.gcDeletedRecords, 1); // Only the empty resume tombstone (chapter/anchor/openedAt all null) is a tombstone!
      const snap = parseUserStateSnapshotResponse((await f.snapshot()).json());
      const strippedReading = snap.records.find(r => r.entity.kind === 'reading' && r.entity.chapter.chapterPath === '/c1');
      assert.deepEqual(strippedReading?.value, { progress: 85, unread: false, readAt: null });
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('Policy 2-C enforces sliding window + seedCutoffAt while preserving non-reading records and allowing recent seeds', async () => {
  const f = await createRetentionFixture(Date.UTC(2026, 6, 15, 12, 0, 0));
  try {
    const oldMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const oldSec = Math.floor(oldMs / 1000);
    const recentSec = Math.floor(Date.UTC(2026, 5, 1, 0, 0, 0) / 1000);

    await f.merge([
      op(library('w1'), { inLibrary: true, addedAt: oldSec }),
      op(bookmark('w1', '/c1'), { bookmarked: true }),
      op(category('cat-1'), { name: 'Shelf', sort: 0, deleted: false }),
      op(membership('cat-1', 'w1'), { included: true }),
      op(composition('w1'), { composition: { version: 1, updatedAt: 1, entries: [] } }),
      op(reading('w1', '/old'), { progress: 100, unread: false, readAt: oldSec }),
      op(resume('w1'), { chapter: { chapterPath: '/old' }, anchor: null, openedAt: oldSec }),
      op(reading('w1', '/recent'), { progress: 50, unread: false, readAt: recentSec }),
    ]);

    const db = openDatabase(f.dataDir);
    let expectedCutoff: number;
    try {
      updateUserStateRetentionConfig(db, { slidingWindow: { enabled: true, months: 12 } }, f.now());
      expectedCutoff = computeSlidingWindowCutoffMs(f.now(), 12);
      const run = maintainUserState(db, { now: f.now, tombstoneGraceMs: 400 * 86_400_000 });
      assert.equal(run.prunedSlidingWindow, 2); // reading('/old') and resume('w1')
    } finally {
      db.close();
    }

    const retState = parseUserStateRetentionState((await f.retention()).json());
    assert.equal(retState.seedCutoffAt, expectedCutoff);
    assert.equal(retState.seedAllowed, true); // Policy 2-C alone does not set seedBlocked!
    assert.ok(retState.compactedThrough > 0);

    // Batch with old seed (skipped) and recent seed (applied), plus non-seed edit on old chapter (applied).
    const mergeSeedRes = parseUserStateMergeResponse((await f.merge([
      op(reading('w1', '/old-seed'), { progress: 100, unread: false, readAt: oldSec }, 0, true),
      op(resume('w2'), { chapter: { chapterPath: '/c1' }, anchor: null, openedAt: oldSec }, 0, true),
      op(reading('w1', '/recent-seed'), { progress: 70, unread: false, readAt: recentSec }, 0, true),
      op(reading('w1', '/old-explicit'), { progress: 100, unread: false, readAt: oldSec }, 0, false),
    ], f.secondHeaders)).json());
    assert.equal(mergeSeedRes.results[0].status, 'seed-skipped');
    assert.equal(mergeSeedRes.results[0].current, null);
    assert.equal(mergeSeedRes.results[1].status, 'seed-skipped');
    assert.equal(mergeSeedRes.results[1].current, null);
    assert.equal(mergeSeedRes.results[2].status, 'applied');
    assert.equal(mergeSeedRes.results[3].status, 'applied');

    // Non-reading records survived in snapshot.
    const snap = parseUserStateSnapshotResponse((await f.snapshot()).json());
    assert.equal(snap.seedAllowed, true);
    assert.equal(snap.seedCutoffAt, expectedCutoff);
    const kinds = snap.records.map(r => r.entity.kind);
    for (const expectedKind of ['library', 'bookmark', 'category', 'membership', 'composition']) {
      assert.ok(kinds.includes(expectedKind as UserStateEntity['kind']));
    }
    assert.ok(!snap.records.some(r => r.entity.kind === 'reading' && r.entity.chapter.chapterPath === '/old'));

    // Disabling 2-C clears seedCutoffAt.
    const db2 = openDatabase(f.dataDir);
    try {
      updateUserStateRetentionConfig(db2, { slidingWindow: { enabled: false, months: 12 } }, f.now());
    } finally {
      db2.close();
    }
    const retAfterDisable = parseUserStateRetentionState((await f.retention()).json());
    assert.equal(retAfterDisable.seedCutoffAt, null);
  } finally {
    await f.close();
  }
});

test('Physical GC removes expired tombstones across all 6 kinds, cleans dangling aliases, and preserves non-tombstones', async () => {
  const f = await createRetentionFixture(Date.UTC(2026, 0, 1, 0, 0, 0), 30 * 86_400_000);
  try {
    const veryOldDomainSec = Math.floor((f.now() - 500 * 86_400_000) / 1000);
    const createRes = parseUserStateMergeResponse((await f.merge([
      op(library('keep'), { inLibrary: true, addedAt: veryOldDomainSec }),
      op(reading('keep', '/read'), { progress: 0, unread: false, readAt: null }),
      op(library('del-lib'), { inLibrary: false, addedAt: null }),
      op(reading('del-read', '/c1'), { progress: 0, unread: true, readAt: null }),
      op(bookmark('del-bm', '/c1'), { bookmarked: false }),
      op(resume('del-res'), { chapter: null, anchor: null, openedAt: null }),
      op(category('del-cat'), { name: 'TrashCat', sort: 0, deleted: false }),
      op(category('alias-cat'), { name: 'TrashCat', sort: 1, deleted: false }),
      op(membership('del-cat', 'del-lib'), { included: true }),
      op(composition('keep'), { composition: { version: 1, updatedAt: 1, entries: [] } }),
    ])).json());
    const catRev = createRes.results[6].current!.revision;

    // Delete del-cat (cascades membership to included: false tombstone).
    await f.merge([
      op(category('del-cat'), { name: 'TrashCat', sort: 0, deleted: true }, catRev),
    ]);

    // Immediate maintenance (0 days elapsed) must NOT GC freshly committed tombstones, even with old domain timestamps.
    const db = openDatabase(f.dataDir);
    try {
      const immediate = maintainUserState(db, { now: f.now, tombstoneGraceMs: 30 * 86_400_000 });
      assert.equal(immediate.gcDeletedRecords, 0);
      assert.equal(immediate.gcDeletedAliases, 0);

      // Within grace period, category restore via membership still works using preserved alias!
      // Advance 31 days -> all 6 tombstone kinds + alias are GC'd.
      f.advanceDays(31);
      const afterGrace = maintainUserState(db, { now: f.now, tombstoneGraceMs: 30 * 86_400_000 });
      assert.equal(afterGrace.gcDeletedRecords, 6);
      assert.equal(afterGrace.gcDeletedAliases, 1);

      const remaining = db.prepare('SELECT entity_key FROM user_state_records ORDER BY entity_key').all() as { entity_key: string }[];
      assert.equal(remaining.length, 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_state_category_aliases').get()?.n, 0);
    } finally {
      db.close();
    }

    const ret = parseUserStateRetentionState((await f.retention()).json());
    assert.equal(ret.seedAllowed, false);
    assert.ok(ret.compactedThrough > 0);

    // Category name reuse / re-aliasing works safely after alias GC!
    const reuseRes = parseUserStateMergeResponse((await f.merge([
      op(category('new-cat-id'), { name: 'TrashCat', sort: 0, deleted: false }),
    ])).json());
    assert.equal(reuseRes.results[0].status, 'applied');
    const aliasReuseRes = parseUserStateMergeResponse((await f.merge([
      op(category('alias-cat'), { name: 'TrashCat', sort: 1, deleted: false }),
    ], f.secondHeaders)).json());
    assert.equal(aliasReuseRes.results[0].status, 'aliased');
    assert.equal(aliasReuseRes.results[0].categoryAlias?.to, 'new-cat-id');

    // Blocked seed cannot trigger category alias creation or category-missing conflict.
    const blockedSeed = parseUserStateMergeResponse((await f.merge([
      op(category('blocked-cat'), { name: 'TrashCat', sort: 2, deleted: false }, 0, true),
      op(membership('nonexistent-cat', 'keep'), { included: true }, 0, true),
    ], f.secondHeaders)).json());
    assert.equal(blockedSeed.results[0].status, 'seed-skipped');
    assert.equal(blockedSeed.results[0].current, null);
    assert.equal(blockedSeed.results[1].status, 'seed-skipped');
    assert.equal(blockedSeed.results[1].current, null);
  } finally {
    await f.close();
  }
});

test('Physical GC removes retired migration originals after grace while keeping migration lineage and live works intact', async () => {
  const f = await createRetentionFixture(Date.UTC(2026, 0, 1, 0, 0, 0), 30 * 86_400_000);
  try {
    const db = openDatabase(f.dataDir);
    try {
      const sourceMeta = {
        schemaVersion: 1 as const,
        identity: { pluginId: 'example-source', novelId: 'source-1', novelPath: '/novel/source-1' },
        novel: { name: 'Source', author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
        cover: null,
        chapters: { '1': 'Ch 1' },
      };
      const targetMeta = {
        schemaVersion: 1 as const,
        identity: { pluginId: 'example-source', novelId: 'target-1', novelPath: '/novel/target-1' },
        novel: { name: 'Target', author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
        cover: null,
        chapters: { '1': 'Ch 1' },
      };
      const srcEntry = saveWork(db, f.dataDir, sourceMeta);
      const tgtEntry = saveWork(db, f.dataDir, targetMeta);

      // Write non-tombstone user_state_records for both source-1 and target-1.
      await f.merge([
        op(library('source-1'), { inLibrary: true, addedAt: 100 }),
        op(reading('source-1', '/c1'), { progress: 50, unread: false, readAt: 100 }),
        op(library('target-1'), { inLibrary: true, addedAt: 100 }),
      ]);

      // Retire source-1 in catalog and record migration lineage at f.now().
      const deletedWork = deleteWork(db, f.dataDir, srcEntry.id);
      db.exec('BEGIN IMMEDIATE');
      recordWorkMigrationLineage(db, {
        operationId: 'mig-op-1',
        sourceWork: { id: srcEntry.id, revision: srcEntry.metadata.novel.name, identity: sourceMeta.identity, metadata: sourceMeta, coverSha256: null },
        targetWork: { id: tgtEntry.id, revision: tgtEntry.metadata.novel.name, identity: targetMeta.identity, metadata: targetMeta, coverSha256: null },
        deletedSource: { revision: 'rev-1', sequence: deletedWork.sequence },
        mappings: [],
        chapterDecisions: [],
        fullDecisionCoverage: true,
      }, f.now());
      db.exec('COMMIT');

      // Before grace elapses, retired source records remain.
      assert.equal(maintainUserState(db, { now: f.now, tombstoneGraceMs: 30 * 86_400_000 }).gcDeletedRecords, 0);

      // After grace elapses, retired source user_state_records are deleted while target and migration tables remain intact!
      f.advanceDays(31);
      const gcRes = maintainUserState(db, { now: f.now, tombstoneGraceMs: 30 * 86_400_000 });
      assert.equal(gcRes.gcDeletedRecords, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_migration_lineage').get()?.n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_migration_events').get()?.n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_state_records').get()?.n, 1);
      assert.ok(db.prepare('SELECT 1 FROM user_state_records WHERE entity_key=?').get(userStateEntityKey(library('target-1'))));
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('POST /read returns 410 cursor-compacted when after < compactedThrough, 200 at boundary, and 409 on epoch mismatch', async () => {
  const f = await createRetentionFixture(Date.UTC(2026, 0, 1, 0, 0, 0), 30 * 86_400_000);
  try {
    // 0 === 0 on empty DB returns 200.
    const emptyRead = parseUserStateReadResponse((await f.read(0)).json());
    assert.equal(emptyRead.records.length, 0);

    await f.merge([
      op(library('w-tomb'), { inLibrary: false, addedAt: null }), // rev 1
      op(library('w-live'), { inLibrary: true, addedAt: 100 }), // rev 2
      op(library('w-live-2'), { inLibrary: true, addedAt: 200 }), // rev 3
    ]);

    // Supersede rev 2 via rev 4 and compact changes without advancing compactedThrough.
    await f.merge([op(library('w-live'), { inLibrary: true, addedAt: 300 }, 2)]);
    f.advanceDays(10);
    const db = openDatabase(f.dataDir);
    try {
      const lossless = maintainUserState(db, { now: f.now, supersededGraceMs: 7 * 86_400_000, tombstoneGraceMs: 30 * 86_400_000 });
      assert.equal(lossless.deletedChanges, 1);
      assert.equal(lossless.gcDeletedRecords, 0);
    } finally {
      db.close();
    }
    assert.equal((await f.read(0)).statusCode, 200);

    // Advance past tombstone grace (30d) so rev 1 is GC'd -> compactedThrough = 1.
    f.advanceDays(25);
    const db2 = openDatabase(f.dataDir);
    try {
      const gc = maintainUserState(db2, { now: f.now, tombstoneGraceMs: 30 * 86_400_000 });
      assert.equal(gc.gcDeletedRecords, 1);
    } finally {
      db2.close();
    }

    // after < compactedThrough (0 < 1) -> 410 Gone with code: 'cursor-compacted'.
    const goneRes = await f.read(0);
    assert.equal(goneRes.statusCode, 410);
    assert.equal(goneRes.json().code, 'cursor-compacted');

    // after === compactedThrough (1 === 1) -> 200 OK!
    const boundaryRes = await f.read(1);
    assert.equal(boundaryRes.statusCode, 200);
    const parsedBoundary = parseUserStateReadResponse(boundaryRes.json());
    assert.deepEqual(parsedBoundary.records.map(r => r.revision), [3, 4]);

    // 409 namespace/epoch mismatch takes precedence over 410!
    const wrongEpochRes = await f.app.inject({
      method: 'POST',
      url: '/api/v1/user-state/read',
      headers: f.headers,
      payload: { workspaceId: f.scope.workspaceId, epoch: randomUUID(), after: 0 },
    });
    assert.equal(wrongEpochRes.statusCode, 409);
  } finally {
    await f.close();
  }
});

test('POST /snapshot paginates deterministically by entity_key, enforces limits/auth/namespace, and rejects oversized records', async () => {
  const f = await createRetentionFixture();
  try {
    // Empty workspace snapshot.
    const emptySnap = parseUserStateSnapshotResponse((await f.snapshot()).json());
    assert.equal(emptySnap.records.length, 0);
    assert.equal(emptySnap.hasMore, false);
    assert.equal(emptySnap.nextEntityKey, null);
    assert.equal(emptySnap.snapshotRevision, 0);

    // Validation & auth.
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/user-state/snapshot', payload: { ...f.scope } })).statusCode, 401);
    assert.equal((await f.snapshot(null, 0)).statusCode, 400);
    assert.equal((await f.snapshot(null, -1)).statusCode, 400);
    assert.equal((await f.snapshot(123 as unknown as string)).statusCode, 400);
    assert.equal((await f.app.inject({
      method: 'POST',
      url: '/api/v1/user-state/snapshot',
      headers: f.headers,
      payload: { workspaceId: f.scope.workspaceId, epoch: randomUUID() },
    })).statusCode, 409);

    await f.merge([
      op(library('w-c'), { inLibrary: true, addedAt: 1 }),
      op(library('w-a'), { inLibrary: true, addedAt: 2 }),
      op(library('w-b'), { inLibrary: true, addedAt: 3 }),
      op(category('cat-1'), { name: 'Alpha', sort: 0, deleted: false }),
      op(bookmark('w-a', '/c1'), { bookmarked: true }),
    ]);

    const collectedKeys: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await f.snapshot(cursor, 2);
      assert.equal(res.statusCode, 200, res.body);
      const parsed = parseUserStateSnapshotResponse(res.json());
      assert.equal(parsed.snapshotRevision, 5);
      assert.equal(parsed.headRevision, 5);
      for (const rec of parsed.records) collectedKeys.push(userStateEntityKey(rec.entity));
      if (!parsed.hasMore) {
        assert.equal(parsed.nextEntityKey, null);
        break;
      }
      assert.ok(parsed.nextEntityKey !== null);
      cursor = parsed.nextEntityKey;
    }
    assert.equal(collectedKeys.length, 5);
    assert.deepEqual([...collectedKeys].sort(), collectedKeys);

    // Raw 4-column insert works without updated_at, and > 32 MiB single record yields 413.
    const db = openDatabase(f.dataDir);
    try {
      const giantKey = userStateEntityKey(library('w-giant'));
      const giantRecord = JSON.stringify({
        entity: library('w-giant'),
        value: { inLibrary: true, addedAt: 1 },
        revision: 6,
        operationId: 'raw-4col',
        updatedAt: f.now(),
        deviceId: 'dev',
        deviceName: 'x'.repeat(33 * 1024 * 1024),
      });
      db.prepare('INSERT INTO user_state_records(entity_key,kind,revision,record) VALUES(?,?,?,?)')
        .run(giantKey, 'library', 6, giantRecord);
      const res413 = await f.snapshot(cursor === null ? undefined : userStateEntityKey(library('w-c')), 10);
      // Seek directly before w-giant to isolate the oversized record.
      const beforeGiant = await f.snapshot(userStateEntityKey(library('w-c')), 10);
      assert.equal(beforeGiant.statusCode, 413);
      void res413;
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('Pre-M2 database upgrade preserves schema_state.checksum and backfills updated_at and retired_at', async () => {
  const f = await createRetentionFixture(Date.now(), 30 * 86_400_000);
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await f.merge([op(library('pre-m2'), { inLibrary: true, addedAt: 100 })]);
    await f.app.close();

    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    let checksumBefore: unknown;
    try {
      checksumBefore = db.prepare('SELECT checksum FROM schema_state').get()?.checksum;
      db.exec(`
        DROP INDEX IF EXISTS user_state_records_updated_at;
        ALTER TABLE user_state_meta RENAME TO user_state_meta_m2;
        CREATE TABLE user_state_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, head_revision INTEGER NOT NULL DEFAULT 0);
        INSERT INTO user_state_meta(singleton, workspace_id, epoch, head_revision) SELECT singleton, workspace_id, epoch, head_revision FROM user_state_meta_m2;
        DROP TABLE user_state_meta_m2;

        ALTER TABLE user_state_records RENAME TO user_state_records_m2;
        CREATE TABLE user_state_records (entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, category_name TEXT, category_deleted INTEGER, membership_category_id TEXT, membership_included INTEGER, revision INTEGER NOT NULL, record TEXT NOT NULL);
        INSERT INTO user_state_records(entity_key, kind, category_name, category_deleted, membership_category_id, membership_included, revision, record)
          SELECT entity_key, kind, category_name, category_deleted, membership_category_id, membership_included, revision, record FROM user_state_records_m2;
        DROP TABLE user_state_records_m2;

        ALTER TABLE work_migration_events RENAME TO work_migration_events_m2;
        CREATE TABLE work_migration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES work_migration_lineage(operation_id), active INTEGER NOT NULL CHECK(active IN (0,1)));
        DROP TABLE work_migration_events_m2;
      `);
    } finally {
      db.close();
    }

    reopened = await buildApp({ dataDir: f.dataDir, userStateMaintenance: { compactionIntervalMs: 0 } });
    const verify = openDatabase(f.dataDir);
    try {
      assert.equal(verify.prepare('SELECT checksum FROM schema_state').get()?.checksum, checksumBefore);
      const recRow = verify.prepare('SELECT updated_at FROM user_state_records').get() as { updated_at: number | null };
      assert.ok(recRow.updated_at !== null && recRow.updated_at > 0);
      const metaRow = verify.prepare('SELECT compacted_through, seed_blocked, seed_cutoff_at, last_gc_at FROM user_state_meta WHERE singleton=1').get() as {
        compacted_through: number;
        seed_blocked: number;
        seed_cutoff_at: number | null;
        last_gc_at: number | null;
      };
      assert.equal(metaRow.compacted_through, 0);
      assert.equal(metaRow.seed_blocked, 0);
      assert.equal(metaRow.seed_cutoff_at, null);
      assert.ok(typeof metaRow.last_gc_at === 'number' && metaRow.last_gc_at > 0);
      const eventCols = verify.prepare('PRAGMA table_info(work_migration_events)').all() as { name: string }[];
      assert.ok(eventCols.some(c => c.name === 'retired_at'));
      assert.deepEqual(DEFAULT_USER_STATE_RETENTION_CONFIG, {
        pruneNonLibraryReading: { enabled: false, days: 90 },
        stripReadingTimestamps: { enabled: false, days: 180 },
        slidingWindow: { enabled: false, months: 12 },
        tombstoneGc: { graceDays: 30 },
      });
    } finally {
      verify.close();
    }
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('Oversized compactionIntervalMs is clamped to 32-bit signed setInterval maximum without TimeoutOverflowWarning', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-clamp-'));
  const warnings: unknown[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on('warning', onWarning);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp({
      dataDir,
      userStateMaintenance: { compactionIntervalMs: MAX_TIMER_DELAY_MS + 1_000_000 },
    });
    await app.ready();
    assert.equal(warnings.filter(w => (w as Error).name === 'TimeoutOverflowWarning').length, 0);
  } finally {
    process.off('warning', onWarning);
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Membership restore during grace period returns structured conflict when another active category holds the same name', async () => {
  const f = await createRetentionFixture(Date.UTC(2026, 0, 1, 0, 0, 0), 30 * 86_400_000);
  try {
    // 1. Create cat-1 ("Fantasy"), alias cat-2 -> cat-1, then delete cat-1.
    const createRes = parseUserStateMergeResponse((await f.merge([
      op(category('cat-1'), { name: 'Fantasy', sort: 0, deleted: false }),
      op(category('cat-2'), { name: 'Fantasy', sort: 1, deleted: false }),
    ])).json());
    assert.equal(createRes.results[0].status, 'applied');
    assert.equal(createRes.results[1].status, 'aliased');
    assert.deepEqual(createRes.results[1].categoryAlias, { from: 'cat-2', to: 'cat-1' });
    const cat1Rev = createRes.results[0].current!.revision;

    const delRes = parseUserStateMergeResponse((await f.merge([
      op(category('cat-1'), { name: 'Fantasy', sort: 0, deleted: true }, cat1Rev),
    ])).json());
    assert.equal(delRes.results[0].status, 'applied');

    // 2. Within the 30-day grace period, another active category cat-3 claims "Fantasy".
    f.advanceDays(10);
    const claimRes = parseUserStateMergeResponse((await f.merge([
      op(category('cat-3'), { name: 'Fantasy', sort: 0, deleted: false }),
    ])).json());
    assert.equal(claimRes.results[0].status, 'applied');
    const headBeforeCollision = claimRes.headRevision;

    // Confirm seedBlocked is false before testing both non-seed and seed: true membership merges.
    const retState = parseUserStateRetentionState((await f.retention()).json());
    assert.equal(retState.seedAllowed, true);

    // 3. Non-seed membership referencing alias cat-2 -> cat-1 must return HTTP 200 conflict, not HTTP 500.
    const nonSeedHttp = await f.merge([
      op(membership('cat-2', 'w2'), { included: true }),
    ], f.secondHeaders);
    assert.equal(nonSeedHttp.statusCode, 200, nonSeedHttp.body);
    const nonSeedParsed = parseUserStateMergeResponse(nonSeedHttp.json());
    assert.equal(nonSeedParsed.results[0].status, 'conflict');
    assert.equal(nonSeedParsed.results[0].reason, 'category-name-exists');
    assert.deepEqual(nonSeedParsed.results[0].categoryAlias, { from: 'cat-2', to: 'cat-1' });
    assert.equal(nonSeedParsed.headRevision, headBeforeCollision);

    // 4. seed: true membership referencing alias cat-2 while seedBlocked=false must also return HTTP 200 conflict, not HTTP 500.
    const seedHttp = await f.merge([
      op(membership('cat-2', 'w3'), { included: true }, 0, true),
    ], f.secondHeaders);
    assert.equal(seedHttp.statusCode, 200, seedHttp.body);
    const seedParsed = parseUserStateMergeResponse(seedHttp.json());
    assert.equal(seedParsed.results[0].status, 'conflict');
    assert.equal(seedParsed.results[0].reason, 'category-name-exists');
    assert.deepEqual(seedParsed.results[0].categoryAlias, { from: 'cat-2', to: 'cat-1' });
    assert.equal(seedParsed.headRevision, headBeforeCollision);

    // 5. Direct membership referencing deleted cat-1 also returns HTTP 200 conflict.
    const directHttp = await f.merge([
      op(membership('cat-1', 'w4'), { included: true }),
    ], f.secondHeaders);
    assert.equal(directHttp.statusCode, 200, directHttp.body);
    const directParsed = parseUserStateMergeResponse(directHttp.json());
    assert.equal(directParsed.results[0].status, 'conflict');
    assert.equal(directParsed.results[0].reason, 'category-name-exists');
    assert.equal(directParsed.headRevision, headBeforeCollision);

    // 6. Verify cat-3 remains active and cat-1 remains deleted.
    const snap = parseUserStateSnapshotResponse((await f.snapshot()).json());
    const cat3Rec = snap.records.find(r => r.entity.kind === 'category' && r.entity.categoryId === 'cat-3');
    const cat1Rec = snap.records.find(r => r.entity.kind === 'category' && r.entity.categoryId === 'cat-1');
    assert.deepEqual(cat3Rec?.value, { name: 'Fantasy', sort: 0, deleted: false });
    assert.deepEqual(cat1Rec?.value, { name: 'Fantasy', sort: 0, deleted: true });
  } finally {
    await f.close();
  }
});

test('POST /snapshot safely handles MAX_SAFE_INTEGER limit and reserves budget for large nextEntityKey on continuing pages', async () => {
  const f = await createRetentionFixture();
  try {
    await f.merge([
      op(library('w1'), { inLibrary: true, addedAt: 1 }),
      op(library('w2'), { inLibrary: true, addedAt: 2 }),
    ]);

    // MAX_SAFE_INTEGER limit must not overflow limit + 1.
    const maxLimitRes = await f.snapshot(null, Number.MAX_SAFE_INTEGER);
    assert.equal(maxLimitRes.statusCode, 200, maxLimitRes.body);
    const maxLimitParsed = parseUserStateSnapshotResponse(maxLimitRes.json());
    assert.equal(maxLimitParsed.records.length, 2);
    assert.equal(maxLimitParsed.hasMore, false);

    // Continuing page with >16 KiB entity_key near 32 MiB USER_STATE_MAX_BYTES must emit that large nextEntityKey and not exceed USER_STATE_MAX_BYTES.
    let expectedPage1NextKey = '';
    const db = openDatabase(f.dataDir);
    try {
      const makeLargeComp = (novelPath: string, suffix: string, targetBytes: number, revision: number) => {
        const entity: UserStateEntity = {
          kind: 'composition',
          work: {
            pluginId: 'example-source',
            sourceNovelId: null,
            novelPath,
            name: 'Large Comp Work ' + suffix,
          },
        };
        const entityKey = userStateEntityKey(entity);
        const pad4k = 'x'.repeat(4000);
        const entries = [];
        let index = 0;
        let currentBytes = 300;
        while (currentBytes < targetBytes) {
          index++;
          const entry = {
            id: `e-${index}`,
            path: `/c/${index}`,
            storageChapterNumber: String(index),
            sources: [{
              pluginId: 'example-source',
              novelId: 'n1',
              novelPath: pad4k,
              chapterPath: pad4k,
              chapterNumber: String(index),
              name: pad4k,
              position: index,
              page: pad4k,
              contentType: 'html' as const,
              releaseTime: null,
            }],
            primarySource: 0,
            user: { included: false, order: 0, name: pad4k, chapterNumber: null },
          };
          const entryLen = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (currentBytes + entryLen > targetBytes) break;
          entries.push(entry);
          currentBytes += entryLen;
        }
        const record = JSON.stringify({
          entity,
          value: { composition: { version: 1, updatedAt: 1, entries } },
          revision,
          operationId: 'op-comp-' + suffix,
          updatedAt: f.now(),
          deviceId: 'dev-1',
          deviceName: 'Device A',
        });
        return { entityKey, record };
      };
      const bigReadingEntity: UserStateEntity = {
        kind: 'reading',
        work: {
          pluginId: 'example-source',
          sourceNovelId: null,
          novelPath: '/novel/' + 'a'.repeat(8100),
          name: 'n'.repeat(4000),
        },
        chapter: { chapterPath: '/chapter/' + 'b'.repeat(8100), name: 'c'.repeat(4000) },
      };
      const bigKey = userStateEntityKey(bigReadingEntity);
      assert.ok(Buffer.byteLength(bigKey) > 16000);
      // Order: comp1 < comp2 (>18 KiB key) < comp3 (100 KiB) < library < reading.
      // Page 1 fits comp1 + comp2 (including comp2's >18 KiB nextKeyReserve) and breaks on comp3 right at the 32 MiB boundary.
      const comp1 = makeLargeComp('/novel/comp-1', '1', 16_750_000, 10);
      const comp2 = makeLargeComp('/novel/comp-2-' + '가'.repeat(6000), '2', 16_770_000, 11);
      const comp3 = makeLargeComp('/novel/comp-3', '3', 100_000, 12);
      assert.ok(Buffer.byteLength(comp2.entityKey, 'utf8') > 16_000);
      expectedPage1NextKey = comp2.entityKey;
      const bigReadingRecord = JSON.stringify({
        entity: bigReadingEntity,
        value: { progress: 50, unread: false, readAt: 1 },
        revision: 13,
        operationId: 'op-big-reading',
        updatedAt: f.now(),
        deviceId: 'dev-1',
        deviceName: 'Device A',
      });
      const insert = db.prepare('INSERT INTO user_state_records(entity_key,kind,revision,record) VALUES(?,?,?,?)');
      insert.run(comp1.entityKey, 'composition', 10, comp1.record);
      insert.run(comp2.entityKey, 'composition', 11, comp2.record);
      insert.run(comp3.entityKey, 'composition', 12, comp3.record);
      insert.run(bigKey, 'reading', 13, bigReadingRecord);
      db.prepare('UPDATE user_state_meta SET head_revision=13 WHERE singleton=1').run();
    } finally {
      db.close();
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await f.snapshot(cursor);
      assert.equal(res.statusCode, 200, res.body);
      const rawBytes = Buffer.byteLength(res.body, 'utf8');
      assert.ok(rawBytes <= 32 * 1024 * 1024, `page ${page} exceeded 32 MiB: ${rawBytes}`);
      const parsed = parseUserStateSnapshotResponse(res.json());
      if (page === 0) {
        assert.equal(parsed.hasMore, true);
        assert.equal(parsed.nextEntityKey, expectedPage1NextKey);
        assert.ok(Buffer.byteLength(parsed.nextEntityKey!, 'utf8') > 16_000);
        assert.ok(rawBytes > 33_500_000, `expected page 1 near 32 MiB boundary, got ${rawBytes}`);
      }
      for (const rec of parsed.records) collected.push(userStateEntityKey(rec.entity));
      if (!parsed.hasMore) break;
      cursor = parsed.nextEntityKey;
    }
    assert.equal(collected.length, 6);
  } finally {
    await f.close();
  }
});

test('POST /snapshot paginates across valid multi-byte UTF-8 and escaped-quote entity_keys exceeding 32768 bytes/chars', async () => {
  const f = await createRetentionFixture();
  try {
    const quoteNovelPath = '/' + '"'.repeat(8191);
    assert.equal(quoteNovelPath.length, 8192);
    const quoteReading1: UserStateEntity = {
      kind: 'reading',
      work: { pluginId: 'example-source', sourceNovelId: null, novelPath: quoteNovelPath, name: 'Quote Work 1' },
      chapter: { chapterPath: '/c/1' },
    };
    const quoteReading2: UserStateEntity = {
      kind: 'reading',
      work: { pluginId: 'example-source', sourceNovelId: null, novelPath: quoteNovelPath, name: 'Quote Work 2' },
      chapter: { chapterPath: '/c/2' },
    };
    const utf8Reading1: UserStateEntity = {
      kind: 'reading',
      work: { pluginId: 'example-source', sourceNovelId: null, novelPath: '/novel/' + '가'.repeat(6000), name: 'Korean Work 1' },
      chapter: { chapterPath: '/chapter/' + '나'.repeat(6000) },
    };
    const utf8Reading2: UserStateEntity = {
      kind: 'reading',
      work: { pluginId: 'example-source', sourceNovelId: null, novelPath: '/novel/' + '다'.repeat(6000), name: 'Korean Work 2' },
      chapter: { chapterPath: '/chapter/' + '라'.repeat(6000) },
    };

    assert.ok(userStateEntityKey(quoteReading1).length > 32_768);
    assert.ok(userStateEntityKey(quoteReading2).length > 32_768);
    assert.ok(Buffer.byteLength(userStateEntityKey(utf8Reading1), 'utf8') > 32_768);
    assert.ok(Buffer.byteLength(userStateEntityKey(utf8Reading2), 'utf8') > 32_768);

    const mergeRes = await f.merge([
      op(quoteReading1, { progress: 10, unread: false, readAt: 100 }),
      op(quoteReading2, { progress: 20, unread: false, readAt: 200 }),
      op(utf8Reading1, { progress: 30, unread: false, readAt: 300 }),
      op(utf8Reading2, { progress: 40, unread: false, readAt: 400 }),
    ]);
    assert.equal(mergeRes.statusCode, 200, mergeRes.body);

    const expectedKeys = [
      userStateEntityKey(quoteReading1),
      userStateEntityKey(quoteReading2),
      userStateEntityKey(utf8Reading1),
      userStateEntityKey(utf8Reading2),
    ].sort();

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await f.snapshot(cursor, 1);
      assert.equal(res.statusCode, 200, `page ${page} failed: ${res.body}`);
      assert.ok(Buffer.byteLength(res.body, 'utf8') <= 32 * 1024 * 1024);
      const parsed = parseUserStateSnapshotResponse(res.json());
      assert.equal(parsed.records.length, 1);
      collected.push(userStateEntityKey(parsed.records[0].entity));
      if (!parsed.hasMore) {
        assert.equal(parsed.nextEntityKey, null);
        break;
      }
      assert.ok(parsed.nextEntityKey !== null);
      cursor = parsed.nextEntityKey;
    }
    assert.deepEqual(collected, expectedKeys);

    const invalidCursorRes = await f.snapshot('x'.repeat(131073), 1);
    assert.equal(invalidCursorRes.statusCode, 400);
  } finally {
    await f.close();
  }
});

test('POST /snapshot paginates across unpaired UTF-16 surrogate entity_keys exceeding 65536 bytes/chars', async () => {
  const f = await createRetentionFixture();
  try {
    const surrogateReading1: UserStateEntity = {
      kind: 'reading',
      work: { pluginId: 'example-source', sourceNovelId: null, novelPath: '\ud800'.repeat(8192), name: 'Surrogate Work 1' },
      chapter: { chapterPath: '\ud800'.repeat(8192) },
    };
    const surrogateReading2: UserStateEntity = {
      kind: 'reading',
      work: { pluginId: 'example-source', sourceNovelId: null, novelPath: '\ud801'.repeat(8192), name: 'Surrogate Work 2' },
      chapter: { chapterPath: '\ud801'.repeat(8192) },
    };
    const maxSurrogateBookmark: UserStateEntity = {
      kind: 'bookmark',
      work: { pluginId: '\ud800'.repeat(160), sourceNovelId: null, novelPath: '\ud800'.repeat(8192), name: 'Max Surrogate Bookmark' },
      chapter: { chapterPath: '\ud800'.repeat(8192) },
    };

    for (const entity of [surrogateReading1, surrogateReading2, maxSurrogateBookmark]) {
      const key = userStateEntityKey(entity);
      assert.ok(key.length > 106_000, `expected key.length > 106000, got ${key.length}`);
      assert.ok(Buffer.byteLength(key, 'utf8') > 106_000, `expected utf8 bytes > 106000, got ${Buffer.byteLength(key, 'utf8')}`);
    }

    const mergeRes = await f.merge([
      op(surrogateReading1, { progress: 15, unread: false, readAt: 100 }),
      op(surrogateReading2, { progress: 25, unread: false, readAt: 200 }),
      op(maxSurrogateBookmark, { bookmarked: true }),
    ]);
    assert.equal(mergeRes.statusCode, 200, mergeRes.body);

    const expectedKeys = [
      userStateEntityKey(surrogateReading1),
      userStateEntityKey(surrogateReading2),
      userStateEntityKey(maxSurrogateBookmark),
    ].sort();

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await f.snapshot(cursor, 1);
      assert.equal(res.statusCode, 200, `page ${page} failed: ${res.body}`);
      assert.ok(Buffer.byteLength(res.body, 'utf8') <= 32 * 1024 * 1024);
      const parsed = parseUserStateSnapshotResponse(res.json());
      assert.equal(parsed.records.length, 1);
      collected.push(userStateEntityKey(parsed.records[0].entity));
      if (!parsed.hasMore) {
        assert.equal(parsed.nextEntityKey, null);
        break;
      }
      assert.ok(parsed.nextEntityKey !== null);
      cursor = parsed.nextEntityKey;
    }
    assert.deepEqual(collected, expectedKeys);
  } finally {
    await f.close();
  }
});

test('background setInterval runs 2-stage op cleanup, Policy 2-A, tombstone GC, recovers from tick errors, and closes cleanly', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-bg-timer-'));
  let clock = 1_760_000_000_000;
  let nowCalls = 0;
  let faultInjected = false;
  let faultArmed = false;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  const app = await buildApp({
    dataDir,
    userStateMaintenance: {
      now: () => {
        nowCalls += 1;
        if (faultArmed && !faultInjected) {
          faultInjected = true;
          throw new Error('transient tick fault');
        }
        return clock;
      },
      compactionIntervalMs: 25,
      supersededGraceMs: 1_000,
      operationBodyRetentionMs: 1_000,
      operationFingerprintRetentionMs: 2_000,
      tombstoneGraceMs: 5_000,
    },
  });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const device = await deviceHeaders(app, 'TimerDevice');
    const admin = await consoleHeaders(app, dataDir);

    // Enable Policy 2-A (10 days) via admin endpoint.
    const patchRes = await fetch(`${baseUrl}/api/v1/admin/user-state/retention`, {
      method: 'PATCH',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({
        pruneNonLibraryReading: { enabled: true, days: 10 },
        tombstoneGc: { graceDays: 1 },
      }),
    });
    assert.equal(patchRes.status, 200);

    const ws = parseUserStateWorkspace(await (await fetch(`${baseUrl}/api/v1/user-state`, { headers: device })).json());
    const scope = { workspaceId: ws.workspaceId, epoch: ws.epoch };
    const oldReadSec = Math.floor((clock - 20 * 86_400_000) / 1000);
    const recentReadSec = Math.floor((clock - 86_400_000) / 1000);

    const oldReadingOp = op(reading('nonlib-old', '/ch/1'), { progress: 60, unread: false, readAt: oldReadSec });
    const libOp = op(library('lib-kept'), { inLibrary: true, addedAt: oldReadSec });
    const libReadOp = op(reading('lib-kept', '/ch/1'), { progress: 75, unread: false, readAt: recentReadSec });
    const tombOp = op(bookmark('tomb-work', '/ch/1'), { bookmarked: false });

    const mergeRes = await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...device, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, operations: [oldReadingOp, libOp, libReadOp, tombOp] }),
    });
    assert.equal(mergeRes.status, 200);

    // Arm a transient fault for the next background tick, advance clock +1.5s so stage-1 op body nulling is due.
    faultArmed = true;
    clock += 1_500;
    for (let i = 0; i < 40 && !faultInjected; i++) await delay(20);
    assert.equal(faultInjected, true);
    assert.ok(errors.some(msg => msg.includes('transient tick fault')));

    // Following ticks continue running cleanly without manual /compact and perform stage-1 cleanup + Policy 2-A.
    for (let i = 0; i < 40; i++) {
      const stats = await (await fetch(`${baseUrl}/api/v1/admin/user-state`, { headers: admin })).json();
      if (stats.operations.withResult === 0) break;
      await delay(20);
    }

    // Replay of stage-1 cleaned operationId must return 409 Conflict.
    const replayRes = await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...device, 'content-type': 'application/json' },
      body: JSON.stringify({ ...scope, operations: [libOp] }),
    });
    assert.equal(replayRes.status, 409);

    // Advance clock past tombstoneGraceMs (5s) and operationFingerprintRetentionMs (2s) -> pure background ticks GC tombstones & delete fingerprints.
    clock += 10_000;
    let finalStats!: {
      compactedThrough: number;
      seedAllowed: boolean;
      records: { tombstones: number; total: number };
      operations: { total: number };
    };
    for (let i = 0; i < 60; i++) {
      finalStats = await (await fetch(`${baseUrl}/api/v1/admin/user-state`, { headers: admin })).json();
      if (finalStats.records.tombstones === 0 && finalStats.operations.total === 0 && finalStats.compactedThrough > 0) break;
      await delay(25);
    }
    assert.equal(finalStats.records.tombstones, 0);
    assert.equal(finalStats.operations.total, 0);
    assert.ok(finalStats.compactedThrough > 0);
    assert.equal(finalStats.seedAllowed, false);

    // Verify clean shutdown clears timer without DB-closed errors.
    const callsBeforeClose = nowCalls;
    await app.close();
    await delay(80);
    assert.equal(nowCalls, callsBeforeClose);
    assert.equal(errors.filter(msg => !msg.includes('transient tick fault')).length, 0);
  } finally {
    console.error = origError;
    await app.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('NaN and non-positive compactionIntervalMs do not spin background maintenance timers', async () => {
  for (const intervalMs of [Number.NaN, 0, -50]) {
    const dataDir = await mkdtemp(join(tmpdir(), 'norea-nan-timer-'));
    let calls = 0;
    const app = await buildApp({
      dataDir,
      userStateMaintenance: {
        now: () => {
          calls += 1;
          return 1_760_000_000_000;
        },
        compactionIntervalMs: intervalMs,
      },
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const callsAtReady = calls;
      await delay(60);
      assert.equal(calls, callsAtReady, `expected no timer ticks for interval=${intervalMs}`);
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
