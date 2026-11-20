import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import type { ChapterCompositionV1 } from '../src/chapter-composition.ts';
import { digest, type CatalogEntry, type PackageManifest } from '../src/packages.ts';
import type { DatabaseReclaimResult } from '../src/db.ts';
import {
  readUserStateComposition,
  USER_STATE_MAX_BYTES,
  type AdminUserStateStats,
  type UserStateMaintenanceResult,
  type UserStateRetentionPatch,
} from '../src/user-state.ts';
import {
  parseUserStateMergeResponse,
  parseUserStateReadResponse,
  parseUserStateRecord,
  parseUserStateWorkspace,
  userStateEntityKey,
  type UserStateEntity,
  type UserStateOperation,
  type UserStateRecord,
  type UserStateValue,
} from '../src/user-state-protocol.ts';
import { recoverDiscardedMigrationChapters } from '../src/work-migration-recovery.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const DAY_MS = 86_400_000;
const BASE_NOW = 1_760_000_000_000;

interface RetentionSnapshotResponse {
  version: 1;
  workspaceId: string;
  epoch: string;
  headRevision: number;
  snapshotRevision: number;
  nextEntityKey: string | null;
  hasMore: boolean;
  seedAllowed: boolean;
  seedCutoffAt: number | null;
  records: UserStateRecord[];
}

interface RetentionStateResponse {
  version: 1;
  workspaceId: string;
  epoch: string;
  headRevision: number;
  compactedThrough: number;
  seedAllowed: boolean;
  seedCutoffAt: number | null;
}

interface AdminCompactResponse {
  maintenance: Omit<UserStateMaintenanceResult, 'reclaimed'> & { reclaimed: DatabaseReclaimResult };
  state: AdminUserStateStats;
}

interface AdminResetResponse {
  reset: boolean;
  previousEpoch: string;
  state: AdminUserStateStats;
}

const work = (sourceNovelId = 'novel-1', pluginId = 'example-source') => ({
  pluginId,
  sourceNovelId,
  novelPath: `/novel/${sourceNovelId}`,
  name: `Work ${sourceNovelId}`,
});
const chapter = (path = '/chapter/1') => ({ chapterPath: path });
const library = (id = 'novel-1'): UserStateEntity => ({ kind: 'library', work: work(id) });
const reading = (id = 'novel-1', chapterPath = '/chapter/1'): UserStateEntity => ({
  kind: 'reading',
  work: work(id),
  chapter: chapter(chapterPath),
});
const bookmark = (id = 'novel-1', chapterPath = '/chapter/1'): UserStateEntity => ({
  kind: 'bookmark',
  work: work(id),
  chapter: chapter(chapterPath),
});
const resume = (id = 'novel-1'): UserStateEntity => ({ kind: 'resume', work: work(id) });
const category = (categoryId: string): UserStateEntity => ({ kind: 'category', categoryId });
const membership = (categoryId: string, id = 'novel-1'): UserStateEntity => ({
  kind: 'membership',
  work: work(id),
  categoryId,
});
const compositionEntity = (id = 'novel-1'): UserStateEntity => ({ kind: 'composition', work: work(id) });

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

function makeComposition(count = 2, padding = ''): ChapterCompositionV1 {
  return {
    version: 1,
    updatedAt: 1_700_000_000_000,
    entries: Array.from({ length: count }, (_, index) => ({
      id: `entry-${index}`,
      path: `norea-composed:entry-${index}`,
      storageChapterNumber: String(index + 1),
      primarySource: 0,
      sources: [
        {
          pluginId: 'example-source',
          novelId: 'novel-1',
          novelPath: '/novel/novel-1',
          chapterPath: `/source/1/${index}`,
          sourceChapterId: `source-${index}`,
          chapterNumber: String(index + 1),
          name: padding || `Source ${index}`,
          position: index,
          page: '1',
          contentType: 'text',
          releaseTime: padding || null,
        },
      ],
      user: {
        included: index !== 1,
        order: index === 0 ? 1 : index === 1 ? 0 : index,
        name: padding || null,
        chapterNumber: null,
      },
    })),
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactKeys(obj: unknown, expected: readonly string[], label: string): void {
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), `${label} must be an object`);
  const actual = Object.keys(obj).sort();
  assert.deepEqual(actual, [...expected].sort(), `${label} keys mismatch`);
}

function assertStrictSnapshotResponse(raw: unknown): RetentionSnapshotResponse {
  assertExactKeys(
    raw,
    [
      'version',
      'workspaceId',
      'epoch',
      'headRevision',
      'snapshotRevision',
      'nextEntityKey',
      'hasMore',
      'seedAllowed',
      'seedCutoffAt',
      'records',
    ],
    'snapshot response',
  );
  const res = raw as RetentionSnapshotResponse;
  assert.equal(res.version, 1);
  assert.ok(typeof res.workspaceId === 'string' && res.workspaceId.length > 0);
  assert.ok(typeof res.epoch === 'string' && res.epoch.length > 0);
  assert.ok(Number.isSafeInteger(res.headRevision) && res.headRevision >= 0);
  assert.ok(Number.isSafeInteger(res.snapshotRevision) && res.snapshotRevision >= 0);
  assert.ok(res.snapshotRevision <= res.headRevision);
  assert.ok(res.nextEntityKey === null || typeof res.nextEntityKey === 'string');
  assert.equal(typeof res.hasMore, 'boolean');
  assert.equal(typeof res.seedAllowed, 'boolean');
  assert.ok(res.seedCutoffAt === null || (Number.isSafeInteger(res.seedCutoffAt) && res.seedCutoffAt >= 0));
  assert.ok(Array.isArray(res.records));
  const parsedRecords = res.records.map(parseUserStateRecord);
  for (let i = 1; i < parsedRecords.length; i++) {
    const prevKey = userStateEntityKey(parsedRecords[i - 1].entity);
    const currKey = userStateEntityKey(parsedRecords[i].entity);
    assert.ok(prevKey < currKey, `snapshot records must be strictly ordered by entity_key: ${prevKey} < ${currKey}`);
  }
  if (!res.hasMore) assert.equal(res.nextEntityKey, null);
  else assert.ok(res.nextEntityKey !== null && parsedRecords.length > 0);
  return { ...res, records: parsedRecords };
}

function assertStrictRetentionResponse(raw: unknown): RetentionStateResponse {
  assertExactKeys(
    raw,
    ['version', 'workspaceId', 'epoch', 'headRevision', 'compactedThrough', 'seedAllowed', 'seedCutoffAt'],
    'retention response',
  );
  const res = raw as RetentionStateResponse;
  assert.equal(res.version, 1);
  assert.ok(typeof res.workspaceId === 'string' && res.workspaceId.length > 0);
  assert.ok(typeof res.epoch === 'string' && res.epoch.length > 0);
  assert.ok(Number.isSafeInteger(res.headRevision) && res.headRevision >= 0);
  assert.ok(Number.isSafeInteger(res.compactedThrough) && res.compactedThrough >= 0);
  assert.ok(res.compactedThrough <= res.headRevision);
  assert.equal(typeof res.seedAllowed, 'boolean');
  assert.ok(res.seedCutoffAt === null || (Number.isSafeInteger(res.seedCutoffAt) && res.seedCutoffAt >= 0));
  return res;
}

async function setup(options: { anonymousRead?: boolean; t?: TestContext; startNow?: number } = {}) {
  if (options.t) {
    options.t.mock.timers.enable({ apis: ['Date'], now: options.startNow ?? BASE_NOW });
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-e2e-retention-'));
  let app!: Awaited<ReturnType<typeof buildApp>>;
  let deviceA!: { authorization: string };
  let deviceB!: { authorization: string };
  let opened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    opened = await buildApp({ dataDir, anonymousRead: options.anonymousRead ?? true });
    app = opened;
    deviceA = await deviceHeaders(app, 'Device A');
    deviceB = await deviceHeaders(app, 'Device B');
  } catch (error) {
    await opened?.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  let cachedAdmin: { headers: { authorization: string }; issuedAt: number } | null = null;

  const admin = async () => {
    const now = Date.now();
    if (!cachedAdmin || now - cachedAdmin.issuedAt >= 12 * 3600_000) {
      cachedAdmin = { headers: await consoleHeaders(app, dataDir), issuedAt: now };
    }
    return cachedAdmin.headers;
  };

  const restart = async () => {
    await app.close();
    app = await buildApp({ dataDir, anonymousRead: options.anonymousRead ?? true });
    cachedAdmin = null;
  };

  const getApp = () => app;

  const workspace = async (headers = deviceA) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/user-state', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const raw = res.json();
    assertExactKeys(raw, ['version', 'workspaceId', 'epoch', 'headRevision'], 'GET /api/v1/user-state');
    return parseUserStateWorkspace(raw);
  };

  const mergeRaw = async (
    operations: unknown[],
    headers = deviceA,
    binding?: { workspaceId: string; epoch: string },
  ) => {
    const scope = binding ?? (await workspace(headers));
    return app.inject({
      method: 'POST',
      url: '/api/v1/user-state/merge',
      headers,
      payload: { workspaceId: scope.workspaceId, epoch: scope.epoch, operations },
    });
  };

  const merge = async (
    operations: UserStateOperation[],
    headers = deviceA,
    binding?: { workspaceId: string; epoch: string },
  ) => {
    const res = await mergeRaw(operations, headers, binding);
    assert.equal(res.statusCode, 200, res.body.slice(0, 1000));
    assert.equal(res.headers['cache-control'], 'no-store');
    const raw = res.json();
    assertExactKeys(raw, ['version', 'workspaceId', 'epoch', 'headRevision', 'results'], 'POST /api/v1/user-state/merge');
    return parseUserStateMergeResponse(raw);
  };

  const readRaw = async (
    after = 0,
    through?: number,
    limit = 200,
    headers = deviceA,
    binding?: { workspaceId: string; epoch: string },
  ) => {
    const scope = binding ?? (await workspace(headers));
    return app.inject({
      method: 'POST',
      url: '/api/v1/user-state/read',
      headers,
      payload: {
        workspaceId: scope.workspaceId,
        epoch: scope.epoch,
        after,
        ...(through === undefined ? {} : { through }),
        limit,
      },
    });
  };

  const read = async (
    after = 0,
    through?: number,
    limit = 200,
    headers = deviceA,
    binding?: { workspaceId: string; epoch: string },
  ) => {
    const res = await readRaw(after, through, limit, headers, binding);
    assert.equal(res.statusCode, 200, res.body.slice(0, 1000));
    assert.equal(res.headers['cache-control'], 'no-store');
    const raw = res.json();
    assertExactKeys(
      raw,
      ['version', 'workspaceId', 'epoch', 'headRevision', 'through', 'nextCursor', 'hasMore', 'records'],
      'POST /api/v1/user-state/read',
    );
    return parseUserStateReadResponse(raw);
  };

  const retention = async (headers = deviceA) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/user-state/retention', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    return assertStrictRetentionResponse(res.json());
  };

  const snapshotRaw = async (
    afterEntityKey?: string | null,
    limit?: number,
    headers = deviceA,
    binding?: { workspaceId: string; epoch: string },
  ) => {
    const scope = binding ?? (await workspace(headers));
    return app.inject({
      method: 'POST',
      url: '/api/v1/user-state/snapshot',
      headers,
      payload: {
        workspaceId: scope.workspaceId,
        epoch: scope.epoch,
        ...(afterEntityKey !== undefined ? { afterEntityKey } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    });
  };

  const snapshot = async (
    afterEntityKey?: string | null,
    limit?: number,
    headers = deviceA,
    binding?: { workspaceId: string; epoch: string },
  ) => {
    const res = await snapshotRaw(afterEntityKey, limit, headers, binding);
    assert.equal(res.statusCode, 200, res.body.slice(0, 1000));
    assert.equal(res.headers['cache-control'], 'no-store');
    return assertStrictSnapshotResponse(res.json());
  };

  const adminUserState = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/user-state', headers: await admin() });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    return res.json() as AdminUserStateStats;
  };

  const adminCompact = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/user-state/compact', headers: await admin() });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    return res.json() as AdminCompactResponse;
  };

  const adminReset = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/user-state/reset', headers: await admin() });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    return res.json() as AdminResetResponse;
  };

  const adminPatchRetention = async (payload: UserStateRetentionPatch | Record<string, unknown>) => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/user-state/retention',
      headers: await admin(),
      payload,
    });
    return res;
  };

  const withDb = <T>(fn: (db: DatabaseSync) => T, readOnly = true): T => {
    const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const uploadBackup = async (name: string, payload: Buffer, headers = deviceA) => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/device-backups/${encodeURIComponent(name)}`,
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-backup-sha256': sha256Hex(payload),
      },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  const advanceDaysAndCompact = async (days: number) => {
    assert.ok(options.t, 'TestContext required for mock timers');
    options.t.mock.timers.tick(days * DAY_MS);
    return adminCompact();
  };

  const advanceUntil = async (
    predicate: () => boolean,
    daySteps: readonly number[] = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 365, 730],
  ): Promise<boolean> => {
    assert.ok(options.t, 'TestContext required for mock timers');
    let previous = 0;
    for (const targetDay of daySteps) {
      const delta = targetDay - previous;
      if (delta > 0) options.t.mock.timers.tick(delta * DAY_MS);
      previous = targetDay;
      await adminCompact();
      if (predicate()) return true;
    }
    return false;
  };

  return {
    dataDir,
    get app() {
      return getApp();
    },
    deviceA,
    deviceB,
    admin,
    restart,
    workspace,
    mergeRaw,
    merge,
    readRaw,
    read,
    retention,
    snapshotRaw,
    snapshot,
    adminUserState,
    adminCompact,
    adminReset,
    adminPatchRetention,
    withDb,
    uploadBackup,
    advanceDaysAndCompact,
    advanceUntil,
    close: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function createWorkAndChapter(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: { authorization: string },
  pluginId: string,
  novelId: string,
  novelPath: string,
  chapterPath: string,
  chapterNumber: string,
  html = '<p>Chapter body</p>',
): Promise<{ workId: string; chapterEntry: CatalogEntry }> {
  const workId = digest(JSON.stringify([pluginId, novelPath]));
  const workPut = await app.inject({
    method: 'PUT',
    url: `/api/v1/works/${workId}`,
    headers,
    payload: {
      schemaVersion: 1,
      identity: { pluginId, novelId, novelPath },
      novel: {
        name: `Work ${novelId}`,
        author: null,
        artist: null,
        summary: null,
        status: null,
        genres: null,
        rating: null,
        isLocal: false,
      },
      cover: null,
      chapters: { [chapterNumber]: `Episode ${chapterNumber}` },
    },
  });
  assert.equal(workPut.statusCode, 200, workPut.body);

  const bytes = Buffer.from(html, 'utf8');
  const manifest: PackageManifest = {
    packageVersion: 1,
    layout: 'chapter-files',
    identity: { pluginId, novelId, novelPath, chapterPath },
    novel: { name: `Work ${novelId}`, isLocal: false },
    chapter: {
      name: `Episode ${chapterNumber}`,
      position: Number(chapterNumber),
      chapterNumber,
      contentType: 'html',
      page: '1',
    },
    bodyPath: 'content.html',
    files: [{ path: 'content.html', size: bytes.length, modifiedAt: BASE_NOW }],
  };
  const form = new FormData();
  form.append('metadata', JSON.stringify(manifest));
  form.append('content.html', new Blob([bytes]), 'content.html');
  const req = new Request('http://fixture', { method: 'POST', body: form });
  const chRes = await app.inject({
    method: 'POST',
    url: '/api/v1/chapter-files?conflictPolicy=replace-server',
    headers: { ...headers, 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  assert.equal(chRes.statusCode, 200, chRes.body);
  return { workId, chapterEntry: chRes.json<CatalogEntry>() };
}

// ============================================================================
// TIER 1: Feature Coverage (Happy-Path Isolated Tests)
// ============================================================================

test('[T1-A1] headRevision increases monotonically across creations and tombstones', async t => {
  const f = await setup({ t });
  try {
    const created = await f.merge([1, 2, 3, 4, 5].map(i => op(library(`n-${i}`), { inLibrary: true, addedAt: 100 + i })));
    assert.equal(created.headRevision, 5);
    assert.equal((await f.workspace()).headRevision, 5);

    const deleted = await f.merge([
      op(library('n-1'), { inLibrary: false, addedAt: null }, created.results[0].current!.revision),
      op(library('n-2'), { inLibrary: false, addedAt: null }, created.results[1].current!.revision),
    ]);
    assert.equal(deleted.headRevision, 7);
    assert.equal((await f.workspace()).headRevision, 7);
    assert.equal((await f.read(0)).headRevision, 7);
  } finally {
    await f.close();
  }
});

test('[T1-A2] headRevision stays monotonic after superseded_at compaction deletes older revisions', async t => {
  const f = await setup({ t });
  try {
    let baseRev = 0;
    for (let i = 1; i <= 10; i++) {
      const m = await f.merge([op(reading('n-1'), { progress: i * 10, readAt: BASE_NOW + i }, baseRev)]);
      baseRev = m.results[0].current!.revision;
      assert.equal(baseRev, i);
    }
    assert.equal((await f.workspace()).headRevision, 10);

    await f.advanceDaysAndCompact(400);
    const compactedChanges = f.withDb(db =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_changes').get() as { n: number }).n),
    );
    assert.equal(compactedChanges, 1);
    assert.equal((await f.workspace()).headRevision, 10);

    const next = await f.merge([op(reading('n-1'), { progress: 50, readAt: BASE_NOW + 20 }, baseRev)]);
    assert.equal(next.results[0].current!.revision, 11);
    assert.equal(next.headRevision, 11);
    assert.equal((await f.workspace()).headRevision, 11);
  } finally {
    await f.close();
  }
});

test('[T1-A3] GET /user-state, POST /read, and POST /merge emit strict protocol schemas across all merge statuses', async t => {
  const f = await setup({ t });
  try {
    const ws = await f.workspace();
    assert.equal(ws.version, 1);

    const catA = await f.merge([op(category('cat-a'), { name: 'Action', sort: 1, deleted: false })]);
    assert.equal(catA.results[0].status, 'applied');

    const seedHit = await f.merge([
      op(category('cat-a'), { name: 'Action2', sort: 2, deleted: false }, 0, true),
      op(category('cat-a'), { name: 'Action', sort: 1, deleted: false }, catA.results[0].current!.revision),
      op(category('cat-b'), { name: 'Action', sort: 3, deleted: false }, 0, true),
      op(membership('missing-cat'), { included: true }),
    ]);
    assert.deepEqual(
      seedHit.results.map(r => r.status),
      ['seed-skipped', 'unchanged', 'aliased', 'conflict'],
    );
    assert.equal(seedHit.results[2].categoryAlias?.to, 'cat-a');
    assert.equal(seedHit.results[3].reason, 'category-missing');

    const readRes = await f.read(0);
    assert.equal(readRes.records.length, 1);
  } finally {
    await f.close();
  }
});

test('[T1-A4] issued (entity_key, revision) payloads remain byte-identical across subsequent updates', async t => {
  const f = await setup({ t });
  try {
    const first = await f.merge([op(reading('n-imm'), { progress: 50, readAt: 1000 })]);
    const rev1 = first.results[0].current!;
    const rawRev1Before = JSON.stringify((await f.read(0)).records[0]);

    await f.merge([op(reading('n-imm'), { progress: 80, readAt: 2000 }, rev1.revision)]);
    const afterRead = await f.read(0);
    assert.equal(afterRead.records.length, 2);
    assert.equal(JSON.stringify(afterRead.records[0]), rawRev1Before);
    const dbRaw = f.withDb(db =>
      (db.prepare('SELECT record FROM user_state_changes WHERE revision=?').get(rev1.revision) as { record: string }).record,
    );
    assert.equal(dbRaw, rawRev1Before);
  } finally {
    await f.close();
  }
});

test('[T1-A6] user_state_meta.head_revision stays synchronized across publish(), policy 2-B, and server restarts', async t => {
  const f = await setup({ t });
  try {
    await f.merge([op(reading('n-meta'), { progress: 70, readAt: BASE_NOW - 100 * DAY_MS })]);
    const metaAfterPublish = f.withDb(db =>
      Number((db.prepare('SELECT head_revision FROM user_state_meta WHERE singleton=1').get() as { head_revision: number }).head_revision),
    );
    assert.equal(metaAfterPublish, 1);

    const patchRes = await f.adminPatchRetention({ stripReadingTimestamps: { enabled: true, days: 30 } });
    assert.equal(patchRes.statusCode, 200, patchRes.body);
    await f.adminCompact();

    const wsAfter2b = await f.workspace();
    assert.equal(wsAfter2b.headRevision, 2);
    const metaAfter2b = f.withDb(db =>
      Number((db.prepare('SELECT head_revision FROM user_state_meta WHERE singleton=1').get() as { head_revision: number }).head_revision),
    );
    assert.equal(metaAfter2b, 2);

    await f.restart();
    assert.equal((await f.workspace()).headRevision, 2);
  } finally {
    await f.close();
  }
});

test('[T1-B1] superseded_at marks prior revisions non-null in O(1) while latest revision stays NULL', async t => {
  const f = await setup({ t });
  try {
    let rev = 0;
    for (let i = 1; i <= 4; i++) {
      const m = await f.merge([op(reading('n-sup'), { progress: i * 25, readAt: BASE_NOW + i }, rev)]);
      rev = m.results[0].current!.revision;
    }
    const rows = f.withDb(db =>
      db.prepare('SELECT revision, superseded_at FROM user_state_changes ORDER BY revision').all() as {
        revision: number;
        superseded_at: number | null;
      }[],
    );
    assert.equal(rows.length, 4);
    for (const r of rows.slice(0, 3)) {
      assert.ok(typeof r.superseded_at === 'number' && Number.isSafeInteger(r.superseded_at), `rev ${r.revision} must have superseded_at`);
    }
    assert.equal(rows[3].superseded_at, null);
  } finally {
    await f.close();
  }
});

test('[T1-B2] superseded_at compaction deletes old change rows after grace while preserving latest revision across restart', async t => {
  const f = await setup({ t });
  try {
    let rev = 0;
    for (let i = 1; i <= 4; i++) {
      const m = await f.merge([op(reading('n-cmp'), { progress: i * 25, readAt: BASE_NOW + i }, rev)]);
      rev = m.results[0].current!.revision;
    }
    // Before grace period elapses, compaction must keep all 4 rows
    t.mock.timers.tick(60_000);
    await f.adminCompact();
    assert.equal((await f.read(0)).records.length, 4);

    // Advance past grace and test startup compaction via restart() directly (without calling adminCompact)
    t.mock.timers.tick(400 * DAY_MS);
    await f.restart();

    const remaining = f.withDb(db =>
      db.prepare('SELECT revision FROM user_state_changes ORDER BY revision').all() as { revision: number }[],
    );
    assert.deepEqual(
      remaining.map(r => r.revision),
      [4],
    );
    const readAfter = await f.read(0);
    assert.equal(readAfter.records.length, 1);
    assert.equal(readAfter.records[0].revision, 4);
  } finally {
    await f.close();
  }
});

test('[T1-B3] 2-stage user_state_operations stage-1 nulls result while preserving (operation_id, payload_hash)', async t => {
  const f = await setup({ t });
  try {
    const op1 = op(library('n-op1'), { inLibrary: true, addedAt: 10 });
    await f.merge([op1]);

    const reachedStage1 = await f.advanceUntil(() =>
      f.withDb(db => {
        const row = db
          .prepare('SELECT operation_id, payload_hash, result, created_at FROM user_state_operations WHERE operation_id=?')
          .get(op1.operationId) as
          | { operation_id: string; payload_hash: string; result: string | null; created_at: number }
          | undefined;
        return Boolean(row && row.result === null && typeof row.payload_hash === 'string' && row.payload_hash.length === 64);
      }),
    );
    assert.equal(reachedStage1, true, 'expected stage-1 cleanup to null result while keeping operation_id & payload_hash');

    const op2 = op(library('n-op2'), { inLibrary: true, addedAt: 20 });
    const res2 = await f.merge([op2]);
    assert.equal(res2.results[0].status, 'applied');
  } finally {
    await f.close();
  }
});

test('[T1-B4] 2-stage user_state_operations stage-2 deletes old fingerprints without affecting records or headRevision', async t => {
  const f = await setup({ t });
  try {
    const op1 = op(library('n-op-s2'), { inLibrary: true, addedAt: 10 });
    await f.merge([op1]);

    await f.advanceDaysAndCompact(730);
    const count = f.withDb(db =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_operations WHERE operation_id=?').get(op1.operationId) as { n: number }).n),
    );
    assert.equal(count, 0);
    assert.equal((await f.workspace()).headRevision, 1);
    assert.equal((await f.read(0)).records.length, 1);
  } finally {
    await f.close();
  }
});

test('[T1-B5] transitional user_state_current_* retirement keeps readingStateVersion=1, reads composition from user_state_records, and keeps migration recovery working', async t => {
  const f = await setup({ t });
  try {
    const capRes = await f.app.inject('/api/v1/capabilities');
    assert.equal(capRes.statusCode, 200);
    const caps = capRes.json();
    assert.equal(caps.readingStateVersion, 1);
    assert.equal(caps.userStateCurrentVersion, undefined);

    const comp = makeComposition(2);
    await f.merge([op(compositionEntity('n-comp'), { composition: comp })]);
    const readBack = f.withDb(db =>
      readUserStateComposition(db, { pluginId: 'example-source', novelId: 'n-comp', novelPath: '/novel/n-comp' }),
    );
    assert.deepEqual(readBack, comp);

    const currentRoute = await f.app.inject({ url: '/api/v1/user-state/current', headers: f.deviceA });
    assert.equal(currentRoute.statusCode, 404);
  } finally {
    await f.close();
  }
});

test('[T1-B6] server SQLite uses PRAGMA auto_vacuum = INCREMENTAL and reclaims freelist & WAL on compact', async t => {
  const f = await setup({ t });
  try {
    const initialVacuum = f.withDb(db => Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum));
    assert.equal(initialVacuum, 2);

    const createOps = Array.from({ length: 200 }, (_, i) =>
      op(reading(`w-${i}`), { progress: 10, readAt: BASE_NOW }),
    );
    const first = await f.merge(createOps);
    const updateOps = first.results.map((r, i) =>
      op(reading(`w-${i}`), { progress: 100, readAt: BASE_NOW + 1000 }, r.current!.revision),
    );
    await f.merge(updateOps);

    f.withDb(db => {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }, false);
    const beforeStats = await f.adminUserState();
    const changesBefore = f.withDb(db =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_changes').get() as { n: number }).n),
    );
    const opsBefore = f.withDb(db =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_operations').get() as { n: number }).n),
    );
    assert.equal(changesBefore, 400);
    assert.equal(opsBefore, 400);

    await f.advanceDaysAndCompact(400);
    const afterStats = await f.adminUserState();
    assert.equal(afterStats.autoVacuum, 2);
    assert.equal(afterStats.freelistPages, 0);
    assert.equal(afterStats.walBytes, 0);
    assert.ok(
      afterStats.dbBytes < beforeStats.dbBytes,
      `expected dbBytes (${afterStats.dbBytes}) < beforeStats.dbBytes (${beforeStats.dbBytes})`,
    );
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_changes').get() as { n: number }).n)),
      200,
    );
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_operations').get() as { n: number }).n)),
      0,
    );
  } finally {
    await f.close();
  }
});

test('[T1-C1] GET /api/v1/admin/user-state reports accurate counts, SQLite stats, and retention defaults', async t => {
  const f = await setup({ t });
  try {
    const m1 = await f.merge([
      op(library('w-active'), { inLibrary: true, addedAt: BASE_NOW }),
      op(library('w-tomb'), { inLibrary: true, addedAt: BASE_NOW }),
      op(category('c1'), { name: 'Sci-Fi', sort: 1, deleted: false }),
    ]);
    await f.merge([
      op(library('w-tomb'), { inLibrary: false, addedAt: null }, m1.results[1].current!.revision),
      op(category('c2'), { name: 'Sci-Fi', sort: 2, deleted: false }, 0, true),
    ]);

    const stats = await f.adminUserState();
    const ws = await f.workspace();
    assert.equal(stats.workspaceId, ws.workspaceId);
    assert.equal(stats.epoch, ws.epoch);
    assert.equal(stats.headRevision, 4);
    assert.equal(stats.compactedThrough, 0);
    assert.equal(stats.autoVacuum, 2);
    assert.ok(Number.isSafeInteger(stats.dbBytes) && stats.dbBytes > 0);
    assert.ok(Number.isSafeInteger(stats.walBytes) && stats.walBytes >= 0);
    assert.equal(stats.retention.pruneNonLibraryReading.enabled, false);
    assert.equal(stats.retention.stripReadingTimestamps.enabled, false);
    assert.equal(stats.retention.slidingWindow.enabled, false);
    assert.equal(stats.retention.tombstoneGc.graceDays, 30);

    assert.equal(stats.records.total, 3);
    assert.equal(stats.records.active, 2);
    assert.equal(stats.records.tombstones, 1);

    assert.equal(stats.changes.total, 4);
    assert.equal(stats.operations.total, 5);
    assert.equal(stats.categoryAliases.total, 1);

    assert.equal(stats.tables.length, 5);
    const recTable = stats.tables.find(tbl => tbl.name === 'user_state_records');
    assert.ok(recTable);
    assert.equal(recTable.rows, 3);
    assert.ok(Number.isSafeInteger(recTable.bytes) && recTable.bytes > 0);
  } finally {
    await f.close();
  }
});

test('[T1-C2] POST /api/v1/admin/user-state/compact compacts eligible rows and reclaims freelist/WAL', async t => {
  const f = await setup({ t });
  try {
    const m1 = await f.merge([op(reading('w-c2'), { progress: 20, readAt: BASE_NOW })]);
    await f.merge([op(reading('w-c2'), { progress: 90, readAt: BASE_NOW + 10 }, m1.results[0].current!.revision)]);

    const compacted = await f.advanceDaysAndCompact(400);
    assert.equal(compacted.maintenance.deletedChanges, 1);
    assert.equal(compacted.maintenance.deletedOperations, 2);
    assert.equal(compacted.state.headRevision, 2);
    assert.equal(compacted.state.freelistPages, 0);
    assert.equal(compacted.state.walBytes, 0);
    assert.equal((await f.read(0)).records.length, 1);
  } finally {
    await f.close();
  }
});

test('[T1-C3] DELETE /api/v1/device-backups/:name deletes slot and blob with device auth', async t => {
  const f = await setup({ t });
  try {
    await f.uploadBackup('Phone', Buffer.from('PK\u0003\u0004 phone backup'));
    const delRes = await f.app.inject({
      method: 'DELETE',
      url: '/api/v1/device-backups/Phone',
      headers: f.deviceA,
    });
    assert.equal(delRes.statusCode, 200, delRes.body);
    assert.deepEqual(delRes.json(), { deleted: true, deviceName: 'Phone' });

    const listRes = await f.app.inject({ method: 'GET', url: '/api/v1/device-backups', headers: f.deviceA });
    assert.deepEqual(listRes.json(), { items: [] });
    assert.deepEqual(await readdir(join(f.dataDir, 'device-backups', 'slots')), []);
    assert.deepEqual(await readdir(join(f.dataDir, 'device-backups', 'blobs')), []);
  } finally {
    await f.close();
  }
});

test('[T1-C4] GET and DELETE /api/v1/admin/device-backups/:name manage backups with console auth', async t => {
  const f = await setup({ t });
  try {
    await f.uploadBackup('Tablet', Buffer.from('PK\u0003\u0004 tablet backup'));
    const adminHeaders = await f.admin();
    const listRes = await f.app.inject({ method: 'GET', url: '/api/v1/admin/device-backups', headers: adminHeaders });
    assert.equal(listRes.statusCode, 200, listRes.body);
    assert.equal(listRes.json().items.length, 1);
    assert.equal(listRes.json().items[0].deviceName, 'Tablet');

    const delRes = await f.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/device-backups/Tablet',
      headers: adminHeaders,
    });
    assert.equal(delRes.statusCode, 200, delRes.body);
    assert.deepEqual(delRes.json(), { deleted: true, deviceName: 'Tablet' });

    const getAfter = await f.app.inject({ method: 'GET', url: '/api/v1/device-backups/Tablet', headers: f.deviceA });
    assert.equal(getAfter.statusCode, 404);
  } finally {
    await f.close();
  }
});

test('[T1-C5] POST /api/v1/admin/user-state/reset clears all user_state_* tables, rotates epoch, and preserves devices/catalog', async t => {
  const f = await setup({ t });
  try {
    const beforeWs = await f.workspace();
    await f.merge([
      op(library('w-rst'), { inLibrary: true, addedAt: BASE_NOW }),
      op(category('cat-1'), { name: 'Drama', sort: 1, deleted: false }),
      op(category('cat-2'), { name: 'Drama', sort: 2, deleted: false }, 0, true),
    ]);
    await f.uploadBackup('KeepMe', Buffer.from('PK keep backup'));
    const syncKey = 'a'.repeat(64);
    const rsRes = await f.app.inject({
      method: 'POST',
      url: '/api/v1/reading-state/merge',
      headers: f.deviceA,
      payload: {
        syncKey,
        entries: [
          {
            pluginId: 'example-source',
            sourceNovelId: 'n-1',
            novelPath: '/novel/n-1',
            chapterPath: '/ch/1',
            chapterNumber: '1',
            page: '1',
            unread: false,
            progress: 100,
            bookmark: false,
            readAt: 1700000000,
          },
        ],
      },
    });
    assert.equal(rsRes.statusCode, 200);

    const resetStats = await f.adminReset();
    assert.equal(resetStats.reset, true);
    assert.equal(resetStats.previousEpoch, beforeWs.epoch);
    assert.notEqual(resetStats.state.epoch, beforeWs.epoch);
    assert.equal(resetStats.state.workspaceId, beforeWs.workspaceId);
    assert.equal(resetStats.state.headRevision, 0);
    assert.equal(resetStats.state.compactedThrough, 0);

    const counts = f.withDb(db => ({
      records: Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_records').get() as { n: number }).n),
      changes: Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_changes').get() as { n: number }).n),
      operations: Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_operations').get() as { n: number }).n),
      aliases: Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_category_aliases').get() as { n: number }).n),
      devices: Number((db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n),
      readingState: Number((db.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get() as { n: number }).n),
    }));
    assert.deepEqual(counts, { records: 0, changes: 0, operations: 0, aliases: 0, devices: 2, readingState: 1 });
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/device-backups', headers: f.deviceA })).json().items.length, 1);
  } finally {
    await f.close();
  }
});

test('[T1-C6] /admin/ HTML and /admin/admin.js bundle load with CSP headers', async t => {
  const f = await setup({ t });
  try {
    const html = await f.app.inject('/admin/');
    assert.equal(html.statusCode, 200);
    assert.ok(html.headers['content-security-policy']);
    const js = await f.app.inject('/admin/admin.js');
    assert.equal(js.statusCode, 200);
    assert.ok(js.body.length > 0);
  } finally {
    await f.close();
  }
});

test('[T1-D1] opt-in policies 2-A, 2-B, and 2-C default to disabled and do not prune old records on compact', async t => {
  const f = await setup({ t });
  try {
    const stats = await f.adminUserState();
    assert.equal(stats.retention.pruneNonLibraryReading.enabled, false);
    assert.equal(stats.retention.stripReadingTimestamps.enabled, false);
    assert.equal(stats.retention.slidingWindow.enabled, false);

    const ret = await f.retention();
    assert.equal(ret.seedAllowed, true);
    assert.equal(ret.seedCutoffAt, null);

    const veryOld = BASE_NOW - 500 * DAY_MS;
    await f.merge([
      op(library('w-nonlib'), { inLibrary: false, addedAt: null }),
      op(reading('w-nonlib'), { progress: 60, readAt: veryOld }),
    ]);
    await f.adminCompact();
    const readRes = await f.read(0);
    assert.equal(readRes.records.length, 2);
  } finally {
    await f.close();
  }
});

test('[T1-D2] policy 2-A prunes old non-library reading and resume records while preserving library works', async t => {
  const f = await setup({ t });
  try {
    const patch = await f.adminPatchRetention({ pruneNonLibraryReading: { enabled: true, days: 30 } });
    assert.equal(patch.statusCode, 200, patch.body);

    const oldMs = BASE_NOW - 45 * DAY_MS;
    const oldSec = Math.floor((BASE_NOW - 100 * DAY_MS) / 1000);
    const recentSec = Math.floor((BASE_NOW - 5 * DAY_MS) / 1000);
    await f.merge([
      op(library('w-nonlib'), { inLibrary: false, addedAt: null }),
      op(reading('w-nonlib'), { progress: 50, readAt: oldMs }),
      op(resume('w-nonlib'), { chapter: chapter(), anchor: null, openedAt: oldMs }),
      op(library('w-nonlib-sec'), { inLibrary: false, addedAt: null }),
      op(reading('w-nonlib-sec'), { progress: 60, readAt: oldSec }),
      op(library('w-nonlib-sec-recent'), { inLibrary: false, addedAt: null }),
      op(reading('w-nonlib-sec-recent'), { progress: 70, readAt: recentSec }),
      op(library('w-inlib'), { inLibrary: true, addedAt: oldMs }),
      op(reading('w-inlib'), { progress: 50, readAt: oldMs }),
      op(resume('w-inlib'), { chapter: chapter(), anchor: null, openedAt: oldMs }),
    ]);

    await f.adminCompact();
    const snap = await f.snapshot();
    const keys = new Set(snap.records.map(r => userStateEntityKey(r.entity)));
    assert.equal(keys.has(userStateEntityKey(reading('w-nonlib'))), false);
    assert.equal(keys.has(userStateEntityKey(resume('w-nonlib'))), false);
    assert.equal(keys.has(userStateEntityKey(reading('w-nonlib-sec'))), false);
    assert.equal(keys.has(userStateEntityKey(reading('w-nonlib-sec-recent'))), true);
    assert.equal(keys.has(userStateEntityKey(reading('w-inlib'))), true);
    assert.equal(keys.has(userStateEntityKey(resume('w-inlib'))), true);
  } finally {
    await f.close();
  }
});

test('[T1-D3] policy 2-B clears readAt and resume via new immutable revision while preserving progress', async t => {
  const f = await setup({ t });
  try {
    const patch = await f.adminPatchRetention({ stripReadingTimestamps: { enabled: true, days: 60 } });
    assert.equal(patch.statusCode, 200, patch.body);

    const oldMs = BASE_NOW - 90 * DAY_MS;
    const oldSec = Math.floor((BASE_NOW - 100 * DAY_MS) / 1000);
    const recentSec = Math.floor((BASE_NOW - 10 * DAY_MS) / 1000);
    await f.merge([
      op(reading('w-2b'), { progress: 75, readAt: oldMs }),
      op(resume('w-2b'), {
        chapter: chapter('/ch/7'),
        anchor: { segmentIndex: 1, segmentCount: 5, offset: 0.5, progress: 75, savedAt: oldMs },
        openedAt: oldMs,
      }),
      op(reading('w-2b-sec'), { progress: 65, readAt: oldSec }),
      op(reading('w-2b-sec-recent'), { progress: 40, readAt: recentSec }),
    ]);
    const initialRecords = (await f.read(0)).records;
    const rev1Json = JSON.stringify(initialRecords[0]);
    const rev2Json = JSON.stringify(initialRecords[1]);
    const rev3Json = JSON.stringify(initialRecords[2]);

    await f.adminCompact();
    const after = await f.read(0);
    assert.ok(after.headRevision >= 7);
    assert.equal(JSON.stringify(after.records.find(r => r.revision === 1)), rev1Json);
    assert.equal(JSON.stringify(after.records.find(r => r.revision === 2)), rev2Json);
    assert.equal(JSON.stringify(after.records.find(r => r.revision === 3)), rev3Json);

    const latestReading = after.records.filter(r => userStateEntityKey(r.entity) === userStateEntityKey(reading('w-2b'))).at(-1)!;
    assert.ok(latestReading.revision > 4);
    assert.deepEqual(latestReading.value, { progress: 75, readAt: null });

    const latestResume = after.records.filter(r => userStateEntityKey(r.entity) === userStateEntityKey(resume('w-2b'))).at(-1)!;
    assert.ok(latestResume.revision > 4);
    assert.deepEqual(latestResume.value, { chapter: null, anchor: null, openedAt: null });

    const latestSecOld = after.records.filter(r => userStateEntityKey(r.entity) === userStateEntityKey(reading('w-2b-sec'))).at(-1)!;
    assert.ok(latestSecOld.revision > 4);
    assert.deepEqual(latestSecOld.value, { progress: 65, readAt: null });

    const secRecentRecords = after.records.filter(r => userStateEntityKey(r.entity) === userStateEntityKey(reading('w-2b-sec-recent')));
    assert.equal(secRecentRecords.length, 1);
    assert.deepEqual(secRecentRecords[0].value, { progress: 40, readAt: recentSec });
  } finally {
    await f.close();
  }
});

test('[T1-D4] policy 2-C enforces sliding window retention and exposes seedCutoffAt', async t => {
  const f = await setup({ t });
  try {
    const patch = await f.adminPatchRetention({ slidingWindow: { enabled: true, months: 6 } });
    assert.equal(patch.statusCode, 200, patch.body);

    const eightMonthsAgo = BASE_NOW - 240 * DAY_MS;
    const oneMonthAgo = BASE_NOW - 30 * DAY_MS;
    await f.merge([
      op(reading('w-old'), { progress: 100, readAt: eightMonthsAgo }),
      op(reading('w-recent'), { progress: 40, readAt: oneMonthAgo }),
    ]);

    await f.adminCompact();
    const ret = await f.retention();
    assert.ok(ret.seedCutoffAt !== null && ret.seedCutoffAt > eightMonthsAgo && ret.seedCutoffAt < BASE_NOW);
    assert.equal(ret.headRevision, 2);

    const snap = await f.snapshot();
    const keys = new Set(snap.records.map(r => userStateEntityKey(r.entity)));
    assert.equal(keys.has(userStateEntityKey(reading('w-old'))), false);
    assert.equal(keys.has(userStateEntityKey(reading('w-recent'))), true);
  } finally {
    await f.close();
  }
});

test('[T1-E1] GET /api/v1/capabilities advertises userStateRetentionVersion=1 alongside readingStateVersion=1', async t => {
  const f = await setup({ t });
  try {
    const res = await f.app.inject('/api/v1/capabilities');
    assert.equal(res.statusCode, 200);
    const caps = res.json();
    assert.equal(caps.userStateRetentionVersion, 1);
    assert.equal(caps.readingStateVersion, 1);
    assert.equal(caps.userStateVersion, 1);
    assert.equal(caps.deviceBackupVersion, 1);
  } finally {
    await f.close();
  }
});

test('[T1-E2] physical GC deletes tombstones from user_state_records and user_state_changes and advances compactedThrough', async t => {
  const f = await setup({ t });
  try {
    const active = await f.merge([
      op(library('w-keep'), { inLibrary: true, addedAt: BASE_NOW }),
      op(bookmark('w-keep'), { bookmarked: true }),
      op(library('w-del'), { inLibrary: true, addedAt: BASE_NOW }),
      op(reading('w-del'), { progress: 50, readAt: BASE_NOW }),
      op(category('cat-del'), { name: 'Temp', sort: 1, deleted: false }),
    ]);
    await f.merge([
      op(bookmark('w-keep', '/chapter/tomb'), { bookmarked: false }),
      op(library('w-del'), { inLibrary: false, addedAt: null }, active.results[2].current!.revision),
      op(reading('w-del'), { progress: 0, readAt: null }, active.results[3].current!.revision),
      op(category('cat-del'), { name: 'Temp', sort: 1, deleted: true }, active.results[4].current!.revision),
    ]);

    await f.advanceDaysAndCompact(400);
    const ret = await f.retention();
    assert.ok(ret.compactedThrough > 0);
    assert.ok(ret.headRevision >= ret.compactedThrough);

    const expectedSurviving = [userStateEntityKey(library('w-keep')), userStateEntityKey(bookmark('w-keep'))].sort();
    const remainingKeys = f.withDb(db =>
      (db.prepare('SELECT entity_key FROM user_state_records ORDER BY entity_key').all() as { entity_key: string }[]).map(
        r => r.entity_key,
      ),
    );
    assert.deepEqual(remainingKeys.sort(), expectedSurviving);

    const remainingChangeKeys = f.withDb(db =>
      (db.prepare('SELECT entity_key FROM user_state_changes ORDER BY entity_key').all() as { entity_key: string }[]).map(
        r => r.entity_key,
      ),
    );
    assert.deepEqual(remainingChangeKeys.sort(), expectedSurviving);
  } finally {
    await f.close();
  }
});

test('[T1-E3] POST /api/v1/user-state/read with cursor < compactedThrough returns 410 Gone (cursor-compacted)', async t => {
  const f = await setup({ t });
  try {
    await f.merge([op(bookmark('w-gc'), { bookmarked: false })]);
    await f.advanceDaysAndCompact(400);
    const ret = await f.retention();
    assert.ok(ret.compactedThrough > 0);

    const res = await f.readRaw(0);
    assert.equal(res.statusCode, 410, res.body);
    assert.equal(res.json().code, 'cursor-compacted');
    assert.ok(typeof res.json().message === 'string' && res.json().message.length > 0);
  } finally {
    await f.close();
  }
});

test('[T1-E4] POST /api/v1/user-state/snapshot paginates deterministically by entity_key', async t => {
  const f = await setup({ t });
  try {
    await f.merge([
      op(library('w-1'), { inLibrary: true, addedAt: BASE_NOW }),
      op(library('w-2'), { inLibrary: true, addedAt: BASE_NOW }),
      op(library('w-3'), { inLibrary: true, addedAt: BASE_NOW }),
      op(library('w-4'), { inLibrary: true, addedAt: BASE_NOW }),
      op(library('w-5'), { inLibrary: true, addedAt: BASE_NOW }),
      op(bookmark('w-tomb'), { bookmarked: false }),
    ]);
    await f.advanceDaysAndCompact(400);

    const p1 = await f.snapshot(null, 2);
    assert.equal(p1.records.length, 2);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.snapshotRevision, p1.headRevision);

    const p2 = await f.snapshot(p1.nextEntityKey, 2);
    assert.equal(p2.records.length, 2);
    assert.equal(p2.hasMore, true);

    const p3 = await f.snapshot(p2.nextEntityKey, 2);
    assert.equal(p3.records.length, 1);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.nextEntityKey, null);

    const allKeys = [...p1.records, ...p2.records, ...p3.records].map(r => userStateEntityKey(r.entity));
    assert.equal(allKeys.length, 5);
    assert.deepEqual(allKeys, [...allKeys].sort());
  } finally {
    await f.close();
  }
});

test('[T1-E5] seed: true for physically GCd tombstone returns seed-skipped (current: null) without resurrecting', async t => {
  const f = await setup({ t });
  try {
    const bm = bookmark('w-noresurrect');
    const created = await f.merge([op(bm, { bookmarked: true })]);
    await f.merge([op(bm, { bookmarked: false }, created.results[0].current!.revision)]);
    await f.advanceDaysAndCompact(400);

    const ret = await f.retention();
    assert.ok(ret.compactedThrough > 0);
    assert.equal(ret.seedAllowed, false);

    const seedRes = await f.merge([op(bm, { bookmarked: true }, 0, true)], f.deviceB);
    assert.equal(seedRes.results[0].status, 'seed-skipped');
    assert.equal(seedRes.results[0].current, null);

    const count = f.withDb(db =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_records WHERE entity_key=?').get(userStateEntityKey(bm)) as { n: number }).n),
    );
    assert.equal(count, 0);
  } finally {
    await f.close();
  }
});

// ============================================================================
// TIER 2: Boundary & Corner Cases
// ============================================================================

test('[T2-A1] POST /merge and POST /read reject unregistered fields with 400 and zero DB writes', async t => {
  const f = await setup({ t });
  try {
    const ws = await f.workspace();
    const badMerge = await f.mergeRaw([{ ...op(library(), { inLibrary: true, addedAt: 1 }), localId: 1 }], f.deviceA, ws);
    assert.equal(badMerge.statusCode, 400);

    const badRead = await f.app.inject({
      method: 'POST',
      url: '/api/v1/user-state/read',
      headers: f.deviceA,
      payload: { workspaceId: ws.workspaceId, epoch: ws.epoch, after: 0, cursorMode: 'x' },
    });
    assert.equal(badRead.statusCode, 400);
    assert.equal((await f.workspace()).headRevision, 0);
  } finally {
    await f.close();
  }
});

test('[T2-A1b] wrong workspace/epoch returns 409 and local pluginId batch rolls back atomically with 400', async t => {
  const f = await setup({ t });
  try {
    const ws = await f.workspace();
    assert.equal((await f.mergeRaw([], f.deviceA, { workspaceId: randomUUID(), epoch: ws.epoch })).statusCode, 409);
    assert.equal((await f.mergeRaw([], f.deviceA, { workspaceId: ws.workspaceId, epoch: randomUUID() })).statusCode, 409);
    const localOp = op({ kind: 'library', work: work('n-loc', 'local') }, { inLibrary: true, addedAt: 1 });
    const badBatch = await f.mergeRaw([op(library('n-ok'), { inLibrary: true, addedAt: 1 }), localOp], f.deviceA, ws);
    assert.equal(badBatch.statusCode, 400);
    assert.equal((await f.workspace()).headRevision, 0);
  } finally {
    await f.close();
  }
});

test('[T2-A5] empty DB handles read(after: 0), compaction, and restart at headRevision 0', async t => {
  const f = await setup({ t });
  try {
    const ws = await f.workspace();
    assert.equal(ws.headRevision, 0);
    const readRes = await f.read(0);
    assert.equal(readRes.through, 0);
    assert.equal(readRes.nextCursor, 0);
    assert.equal(readRes.hasMore, false);
    assert.deepEqual(readRes.records, []);

    await f.advanceDaysAndCompact(400);
    await f.restart();
    const after = await f.workspace();
    assert.equal(after.headRevision, 0);
    assert.equal(after.workspaceId, ws.workspaceId);
    assert.equal(after.epoch, ws.epoch);
  } finally {
    await f.close();
  }
});

test('[T2-A6] duplicate operationId, seed with baseRevision > 0, or seed: false reject atomically with 400', async t => {
  const f = await setup({ t });
  try {
    const valid = op(library('w-v'), { inLibrary: true, addedAt: 1 });
    const dup = op(library('w-dup'), { inLibrary: true, addedAt: 2 });
    assert.equal((await f.mergeRaw([dup, dup])).statusCode, 400);
    assert.equal((await f.mergeRaw([valid, op(library('w-bad1'), { inLibrary: true, addedAt: 1 }, 1, true)])).statusCode, 400);
    assert.equal((await f.mergeRaw([valid, { ...op(library('w-bad2'), { inLibrary: true, addedAt: 1 }), seed: false }])).statusCode, 400);
    assert.equal((await f.workspace()).headRevision, 0);
  } finally {
    await f.close();
  }
});

test('[T2-B1] superseded_at compaction never deletes latest revision even when years old', async t => {
  const f = await setup({ t });
  try {
    const r1 = await f.merge([op(reading('w-old-latest'), { progress: 30, readAt: BASE_NOW })]);
    await f.merge([op(reading('w-old-latest'), { progress: 60, readAt: BASE_NOW + 10 }, r1.results[0].current!.revision)]);

    // Before grace: rev 1 still present
    t.mock.timers.tick(1000);
    await f.adminCompact();
    assert.equal((await f.read(0)).records.length, 2);

    // Years later: rev 1 deleted, latest rev 2 preserved
    await f.advanceDaysAndCompact(1000);
    const after = await f.read(0);
    assert.equal(after.records.length, 1);
    assert.equal(after.records[0].revision, 2);
  } finally {
    await f.close();
  }
});

test('[T2-B2] stale operation_id replay after stage-1 cleanup returns 409 for both exact and tampered payloads and rolls back batch', async t => {
  const f = await setup({ t });
  try {
    const op1 = op(reading('w-b2'), { progress: 25, readAt: BASE_NOW });
    const r1 = await f.merge([op1]);
    await f.merge([op(reading('w-b2'), { progress: 90, readAt: BASE_NOW + 50 }, r1.results[0].current!.revision)]);

    const stage1 = await f.advanceUntil(() =>
      f.withDb(db => {
        const row = db
          .prepare('SELECT result, payload_hash FROM user_state_operations WHERE operation_id=?')
          .get(op1.operationId) as { result: string | null; payload_hash: string } | undefined;
        return Boolean(row && row.result === null);
      }),
    );
    assert.equal(stage1, true);

    const headBefore = (await f.workspace()).headRevision;
    // Exact stale replay -> 409 (must not overwrite progress=90 back to 25!)
    const replayExact = await f.mergeRaw([op1]);
    assert.equal(replayExact.statusCode, 409, replayExact.body);

    // Tampered payload replay -> 409
    const tampered = { ...op1, value: { progress: 99, readAt: BASE_NOW } };
    const replayTampered = await f.mergeRaw([tampered]);
    assert.equal(replayTampered.statusCode, 409, replayTampered.body);

    // Batch containing valid op2 + stale op1 rolls back atomically
    const op2 = op(library('w-b2-extra'), { inLibrary: true, addedAt: BASE_NOW });
    const mixed = await f.mergeRaw([op2, op1]);
    assert.equal(mixed.statusCode, 409, mixed.body);
    assert.equal((await f.workspace()).headRevision, headBefore);
    assert.equal(
      f.withDb(db =>
        Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_records WHERE entity_key=?').get(userStateEntityKey(library('w-b2-extra'))) as { n: number }).n),
      ),
      0,
    );
  } finally {
    await f.close();
  }
});

test('[T2-B3] stage-1 receipt cleanup nulls large composition result bodies and reclaims SQLite space', async t => {
  const f = await setup({ t });
  try {
    const bigComp = makeComposition(80, 'p'.repeat(2048));
    const bigOp = op(compositionEntity('w-big'), { composition: bigComp });
    await f.merge([bigOp]);

    f.withDb(db => {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }, false);
    const sizeBefore = (await f.adminUserState()).dbBytes;
    const stage1 = await f.advanceUntil(() =>
      f.withDb(db => {
        const row = db
          .prepare('SELECT result, payload_hash FROM user_state_operations WHERE operation_id=?')
          .get(bigOp.operationId) as { result: string | null; payload_hash: string } | undefined;
        return Boolean(row && row.result === null && row.payload_hash.length === 64);
      }),
    );
    assert.equal(stage1, true);

    const statsAfter = await f.adminUserState();
    assert.equal(statsAfter.freelistPages, 0);
    assert.equal(statsAfter.walBytes, 0);
    assert.ok(statsAfter.dbBytes < sizeBefore, `expected dbBytes (${statsAfter.dbBytes}) < sizeBefore (${sizeBefore})`);
    assert.equal(
      f.withDb(db =>
        Number(
          (db.prepare('SELECT COUNT(*) AS n FROM user_state_records WHERE entity_key=?').get(userStateEntityKey(compositionEntity('w-big'))) as { n: number })
            .n,
        ),
      ),
      1,
    );
  } finally {
    await f.close();
  }
});

test('[T2-B4] upgraded server opens DB containing legacy user_state_current_* tables without checksum errors', async t => {
  const f = await setup({ t });
  try {
    await f.merge([op(library('w-leg'), { inLibrary: true, addedAt: BASE_NOW })]);
    const checksumBefore = f.withDb(db => (db.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum);
    await f.app.close();

    const rawDb = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS user_state_current_meta (singleton INTEGER PRIMARY KEY, epoch TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_state_current_records (entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL);
        INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES('p1','k1','{}');
      `);
    } finally {
      rawDb.close();
    }

    await f.restart();
    const checksumAfter = f.withDb(db => (db.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum);
    assert.equal(checksumAfter, checksumBefore);
    assert.equal((await f.read(0)).records.length, 1);
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get() as { n: number }).n)),
      1,
    );
  } finally {
    await f.close();
  }
});

test('[T2-B5] legacy DB with PRAGMA auto_vacuum = 0 opens cleanly and preserves data across one-time post-backup INCREMENTAL conversion', async t => {
  const f = await setup({ t });
  try {
    await f.merge([op(library('w-vac'), { inLibrary: true, addedAt: BASE_NOW })]);
    const passwordBefore = await readFile(join(f.dataDir, 'admin-password.hash'));
    const checksumBefore = f.withDb(db => (db.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum);
    await f.app.close();

    const rawDb = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      rawDb.exec('PRAGMA auto_vacuum = 0; VACUUM;');
      rawDb.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('prof-b5', 'k-b5', '{}');
      assert.equal(Number((rawDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 0);
    } finally {
      rawDb.close();
    }

    // (a) Upgraded server opens legacy auto_vacuum = 0 DB cleanly without automatic blocking VACUUM on startup
    await f.restart();
    assert.equal(
      f.withDb(db => Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum)),
      0,
    );
    assert.equal(
      f.withDb(db => (db.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum),
      checksumBefore,
    );
    assert.equal((await f.read(0)).records.length, 1);
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get() as { n: number }).n)),
      1,
    );
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n)),
      2,
    );
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), passwordBefore);

    // (b) Perform documented one-time post-backup conversion: PRAGMA auto_vacuum = INCREMENTAL; VACUUM;
    await f.app.close();
    const convDb = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      convDb.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
      assert.equal(Number((convDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 2);
    } finally {
      convDb.close();
    }

    await f.restart();
    assert.equal(
      f.withDb(db => Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum)),
      2,
    );
    assert.equal(
      f.withDb(db => (db.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum),
      checksumBefore,
    );

    // Create churn and verify adminCompact() reclaims pages incrementally while keeping all existing rows intact
    const bigOps = Array.from({ length: 20 }, (_, i) =>
      op(compositionEntity(`w-vac-churn-${i}`), { composition: makeComposition(10, 'v'.repeat(1024)) }),
    );
    const createdChurn = await f.merge(bigOps);
    await f.merge(
      createdChurn.results.map((r, i) =>
        op(compositionEntity(`w-vac-churn-${i}`), { composition: makeComposition(1, 's') }, r.current!.revision),
      ),
    );
    f.withDb(db => {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }, false);
    const sizeBeforeCompact = (await f.adminUserState()).dbBytes;

    const afterCompact = await f.advanceDaysAndCompact(400);
    assert.equal(afterCompact.state.autoVacuum, 2);
    assert.equal(afterCompact.state.freelistPages, 0);
    assert.equal(afterCompact.state.walBytes, 0);
    assert.ok(
      afterCompact.state.dbBytes < sizeBeforeCompact,
      `expected incremental vacuum to shrink dbBytes (${afterCompact.state.dbBytes}) < ${sizeBeforeCompact}`,
    );

    // Reopening again stays 2 and preserves all pre-conversion rows and credentials
    await f.restart();
    assert.equal(
      f.withDb(db => Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum)),
      2,
    );
    assert.equal(
      f.withDb(db => (db.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum),
      checksumBefore,
    );
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get() as { n: number }).n)),
      1,
    );
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_records').get() as { n: number }).n)),
      21,
    );
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n)),
      2,
    );
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), passwordBefore);
  } finally {
    await f.close();
  }
});

test('[T2-B6] read pagination respects limit=1 and 32 MiB byte cap after compaction, returning 413 when single record exceeds budget', async t => {
  const f = await setup({ t });
  try {
    const large = makeComposition(1200, 'x'.repeat(4096));
    for (let i = 1; i <= 3; i++) {
      await f.merge([op(compositionEntity(`large-${i}`), { composition: large })]);
    }
    const p1 = await f.read(0, undefined, 1);
    assert.equal(p1.records.length, 1);
    assert.equal(p1.hasMore, true);

    const capped = await f.read(0);
    assert.equal(capped.records.length, 2);
    assert.equal(capped.hasMore, true);

    // Single stored record exceeding (USER_STATE_MAX_BYTES - RESPONSE_RESERVE) must return 413 on /read
    const huge = makeComposition(2650, 'y'.repeat(4096));
    const hugeRecord: UserStateRecord = {
      entity: compositionEntity('huge-1'),
      value: { composition: huge },
      revision: 4,
      operationId: randomUUID(),
      updatedAt: BASE_NOW,
      deviceId: 'dev-huge',
      deviceName: 'Device A',
    };
    const hugeSerialized = JSON.stringify(hugeRecord);
    assert.ok(Buffer.byteLength(hugeSerialized) + 4096 > USER_STATE_MAX_BYTES);
    const rwDb = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      rwDb.prepare('INSERT INTO user_state_changes(entity_key, record) VALUES(?, ?)').run(
        userStateEntityKey(hugeRecord.entity),
        hugeSerialized,
      );
      rwDb.prepare('UPDATE user_state_meta SET head_revision=4 WHERE singleton=1').run();
    } finally {
      rwDb.close();
    }
    const oversizedRead = await f.readRaw(3, 4);
    assert.equal(oversizedRead.statusCode, 413, oversizedRead.body);
  } finally {
    await f.close();
  }
});

test('[T2-C1] DELETE missing device backup returns 404 on both device and admin routes', async t => {
  const f = await setup({ t });
  try {
    const devRes = await f.app.inject({
      method: 'DELETE',
      url: '/api/v1/device-backups/missing-device',
      headers: f.deviceA,
    });
    assert.equal(devRes.statusCode, 404);
    assert.equal(devRes.json().message, 'No backup exists for this device');

    const admRes = await f.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/device-backups/missing-device',
      headers: await f.admin(),
    });
    assert.equal(admRes.statusCode, 404);
    assert.equal(admRes.json().message, 'No backup exists for this device');
  } finally {
    await f.close();
  }
});

test('[T2-C2] DELETE /api/v1/device-backups/:name rejects invalid or traversal names without touching unrelated files', async t => {
  const f = await setup({ t });
  try {
    await writeFile(join(f.dataDir, 'keep-me.txt'), 'safe');
    for (const invalid of ['   ', 'line\nbreak', 'a'.repeat(201)]) {
      const res = await f.app.inject({
        method: 'DELETE',
        url: `/api/v1/device-backups/${encodeURIComponent(invalid)}`,
        headers: f.deviceA,
      });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(invalid)}: ${res.body}`);
    }
    const traversal = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/device-backups/${encodeURIComponent('../keep-me.txt')}`,
      headers: f.deviceA,
    });
    const traversalBody = traversal.json() as { error?: string; message?: string };
    assert.ok(
      !String(traversalBody.message ?? '').startsWith('Route '),
      `route must exist and not return Fastify unregistered-route 404: ${traversal.body}`,
    );
    assert.ok(
      traversal.statusCode === 400 ||
        (traversal.statusCode === 404 && traversalBody.message === 'No backup exists for this device'),
      `expected 400 or handled 404, got ${traversal.statusCode}: ${traversal.body}`,
    );
    assert.equal(await readFile(join(f.dataDir, 'keep-me.txt'), 'utf8'), 'safe');
  } finally {
    await f.close();
  }
});

test('[T2-C3] admin and device backup endpoints enforce strict auth role separation and blocked-device rejection', async t => {
  const f = await setup({ t });
  try {
    await f.uploadBackup('Phone', Buffer.from('PK test'));
    const adminHeaders = await f.admin();

    for (const [method, url] of [
      ['GET', '/api/v1/admin/user-state'],
      ['POST', '/api/v1/admin/user-state/compact'],
      ['POST', '/api/v1/admin/user-state/reset'],
      ['PATCH', '/api/v1/admin/user-state/retention'],
      ['GET', '/api/v1/admin/device-backups'],
      ['DELETE', '/api/v1/admin/device-backups/Phone'],
    ] as const) {
      assert.equal((await f.app.inject({ method, url })).statusCode, 401, `${method} ${url} unauth`);
      assert.equal((await f.app.inject({ method, url, headers: f.deviceA })).statusCode, 403, `${method} ${url} device`);
    }

    assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/v1/device-backups/Phone' })).statusCode, 401);
    assert.equal(
      (await f.app.inject({ method: 'DELETE', url: '/api/v1/device-backups/Phone', headers: adminHeaders })).statusCode,
      403,
    );

    const rawDb = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      rawDb.exec('UPDATE devices SET blocked=1');
    } finally {
      rawDb.close();
    }
    assert.equal(
      (await f.app.inject({ method: 'DELETE', url: '/api/v1/device-backups/Phone', headers: f.deviceA })).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test('[T2-C4] resetting empty or populated workspace twice issues distinct epochs while preserving works and devices', async t => {
  const f = await setup({ t });
  try {
    await createWorkAndChapter(f.app, f.deviceA, 'src', 'n1', '/n1', '/c1', '1');
    const r1 = await f.adminReset();
    assert.equal(r1.reset, true);
    assert.equal(r1.state.headRevision, 0);
    assert.equal(r1.state.compactedThrough, 0);

    await f.merge([op(library('n1'), { inLibrary: true, addedAt: BASE_NOW })]);
    const r2 = await f.adminReset();
    assert.equal(r2.reset, true);
    assert.equal(r2.previousEpoch, r1.state.epoch);
    assert.notEqual(r2.state.epoch, r1.state.epoch);
    assert.equal(r2.state.headRevision, 0);
    assert.equal(r2.state.compactedThrough, 0);

    const worksCount = f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM works').get() as { n: number }).n));
    assert.equal(worksCount, 1);
  } finally {
    await f.close();
  }
});

test('[T2-C5] concurrent GET backup stream completes cleanly while DELETE removes slot', async t => {
  const f = await setup({ t });
  let req: ReturnType<typeof httpRequest> | undefined;
  try {
    const bigPayload = Buffer.alloc(2 * 1024 * 1024, 65);
    await f.uploadBackup('StreamDev', bigPayload);
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });

    const chunks: Buffer[] = [];
    let headersReceived!: () => void;
    const onHeaders = new Promise<void>(resolve => {
      headersReceived = resolve;
    });
    const completed = new Promise<number>((resolve, reject) => {
      req = httpRequest(`${address}/api/v1/device-backups/StreamDev`, { headers: f.deviceA }, res => {
        res.pause();
        headersReceived();
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(res.statusCode!));
        res.on('error', reject);
        (async () => {
          await onHeaders;
          await new Promise(r => setTimeout(r, 15));
          res.resume();
        })().catch(reject);
      });
      req.on('error', reject);
      req.end();
    });

    await onHeaders;
    const delPromise = f.app.inject({
      method: 'DELETE',
      url: '/api/v1/device-backups/StreamDev',
      headers: f.deviceA,
    });

    const [getStatus, delRes] = await Promise.all([completed, delPromise]);
    assert.equal(getStatus, 200);
    assert.equal(sha256Hex(Buffer.concat(chunks)), sha256Hex(bigPayload));
    assert.equal(delRes.statusCode, 200, delRes.body);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/device-backups/StreamDev', headers: f.deviceA })).statusCode, 404);
    assert.deepEqual(await readdir(join(f.dataDir, 'device-backups', 'staging')), []);
  } finally {
    req?.destroy();
    await f.close();
  }
});

test('[T2-D1] PATCH /api/v1/admin/user-state/retention rejects invalid thresholds and unknown keys with 400', async t => {
  const f = await setup({ t });
  try {
    const before = await f.adminUserState();
    for (const invalid of [
      { pruneNonLibraryReading: { enabled: true, days: -1 } },
      { pruneNonLibraryReading: { enabled: true, days: 0 } },
      { slidingWindow: { enabled: true, months: 0 } },
      { stripReadingTimestamps: { enabled: true, days: 1.5 } },
      { tombstoneGc: { graceDays: -1 } },
      { foo: true },
    ]) {
      const res = await f.adminPatchRetention(invalid);
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(invalid)}`);
    }
    const after = await f.adminUserState();
    assert.deepEqual(after.retention, before.retention);
  } finally {
    await f.close();
  }
});

test('[T2-D2] policy 2-A preserves non-library bookmarks and applies exact day cutoff boundary', async t => {
  const f = await setup({ t });
  try {
    const patch = await f.adminPatchRetention({ pruneNonLibraryReading: { enabled: true, days: 30 } });
    assert.equal(patch.statusCode, 200, patch.body);

    const exactCutoff = BASE_NOW - 30 * DAY_MS;
    await f.merge([
      op(library('w-2a'), { inLibrary: false, addedAt: null }),
      op(bookmark('w-2a'), { bookmarked: true }),
      op(reading('w-2a', '/ch/older'), { progress: 40, readAt: exactCutoff - 1 }),
      op(reading('w-2a', '/ch/exact'), { progress: 40, readAt: exactCutoff }),
    ]);
    await f.adminCompact();
    const keys = new Set((await f.snapshot()).records.map(r => userStateEntityKey(r.entity)));
    assert.equal(keys.has(userStateEntityKey(bookmark('w-2a'))), true);
    assert.equal(keys.has(userStateEntityKey(reading('w-2a', '/ch/older'))), false);
    assert.equal(keys.has(userStateEntityKey(reading('w-2a', '/ch/exact'))), true);
  } finally {
    await f.close();
  }
});

test('[T2-D3] policy 2-B is idempotent and does not emit duplicate revisions on already-scrubbed records', async t => {
  const f = await setup({ t });
  try {
    assert.equal((await f.adminPatchRetention({ stripReadingTimestamps: { enabled: true, days: 30 } })).statusCode, 200);
    await f.merge([
      op(reading('w-idem'), { progress: 80, readAt: BASE_NOW - 60 * DAY_MS }),
      op(resume('w-idem'), { chapter: chapter(), anchor: null, openedAt: BASE_NOW - 60 * DAY_MS }),
    ]);

    await f.adminCompact();
    const headAfterFirst = (await f.workspace()).headRevision;
    await f.adminCompact();
    const headAfterSecond = (await f.workspace()).headRevision;
    assert.equal(headAfterSecond, headAfterFirst);
  } finally {
    await f.close();
  }
});

test('[T2-D4] policy 2-C blocks seed: true older than seedCutoffAt while applying explicit non-seed edits', async t => {
  const f = await setup({ t });
  try {
    assert.equal((await f.adminPatchRetention({ slidingWindow: { enabled: true, months: 3 } })).statusCode, 200);
    await f.adminCompact();
    const ret = await f.retention();
    assert.ok(ret.seedCutoffAt !== null);
    const beforeCutoff = ret.seedCutoffAt - 1;
    const beforeCutoffSec = Math.floor((ret.seedCutoffAt - 10_000) / 1000);

    const opOld = op(reading('w-seed-old'), { progress: 50, readAt: beforeCutoff }, 0, true);
    const opNull = op(reading('w-seed-null'), { progress: 50, readAt: null }, 0, true);
    const opExplicit = op(reading('w-explicit-old'), { progress: 50, readAt: beforeCutoff }, 0, false);
    const opOldSec = op(reading('w-seed-old-sec'), { progress: 50, readAt: beforeCutoffSec }, 0, true);

    const res = await f.merge([opOld, opNull, opExplicit, opOldSec]);
    assert.equal(res.results[0].operationId, opOld.operationId);
    assert.equal(res.results[0].status, 'seed-skipped');
    assert.equal(res.results[0].current, null);

    assert.equal(res.results[1].operationId, opNull.operationId);
    assert.equal(res.results[1].status, 'applied');
    assert.ok(res.results[1].current !== null);
    const nullRecordCount = f.withDb(db =>
      Number(
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM user_state_records WHERE entity_key=?')
            .get(userStateEntityKey(reading('w-seed-null'))) as { n: number }
        ).n,
      ),
    );
    assert.equal(nullRecordCount, 1);

    assert.equal(res.results[2].operationId, opExplicit.operationId);
    assert.equal(res.results[2].status, 'applied');

    assert.equal(res.results[3].operationId, opOldSec.operationId);
    assert.equal(res.results[3].status, 'seed-skipped');
    assert.equal(res.results[3].current, null);
    assert.equal(
      f.withDb(db =>
        Number(
          (
            db
              .prepare('SELECT COUNT(*) AS n FROM user_state_records WHERE entity_key=?')
              .get(userStateEntityKey(reading('w-seed-old-sec'))) as { n: number }
          ).n,
        ),
      ),
      0,
    );
  } finally {
    await f.close();
  }
});

test('[T2-E1] POST /read cursor boundaries around compactedThrough (410 vs 200 vs 409)', async t => {
  const f = await setup({ t });
  try {
    const r1 = await f.merge([op(bookmark('w-e1'), { bookmarked: true })]);
    await f.merge([op(bookmark('w-e1'), { bookmarked: false }, r1.results[0].current!.revision)]);
    await f.advanceDaysAndCompact(400);

    const ret = await f.retention();
    const c = ret.compactedThrough;
    assert.ok(c >= 2);
    assert.equal(ret.headRevision, c);

    const belowZero = await f.readRaw(0);
    assert.equal(belowZero.statusCode, 410);
    assert.equal(belowZero.json().code, 'cursor-compacted');

    const belowOne = await f.readRaw(c - 1);
    assert.equal(belowOne.statusCode, 410);
    assert.equal(belowOne.json().code, 'cursor-compacted');

    const atBoundary = await f.read(c);
    assert.equal(atBoundary.nextCursor, c);
    assert.deepEqual(atBoundary.records, []);

    const ahead = await f.readRaw(c + 1);
    assert.equal(ahead.statusCode, 409);
  } finally {
    await f.close();
  }
});

test('[T2-E2] POST /snapshot validates workspace/epoch (409), limit/fields (400), and deterministic afterEntityKey', async t => {
  const f = await setup({ t });
  try {
    const ws = await f.workspace();
    await f.merge([
      op(library('w-a'), { inLibrary: true, addedAt: BASE_NOW }),
      op(library('w-z'), { inLibrary: true, addedAt: BASE_NOW }),
    ]);

    assert.equal((await f.snapshotRaw(null, 10, f.deviceA, { ...ws, workspaceId: randomUUID() })).statusCode, 409);
    assert.equal((await f.snapshotRaw(null, 10, f.deviceA, { ...ws, epoch: randomUUID() })).statusCode, 409);
    assert.equal((await f.snapshotRaw(null, 0)).statusCode, 400);
    const extraRes = await f.app.inject({
      method: 'POST',
      url: '/api/v1/user-state/snapshot',
      headers: f.deviceA,
      payload: { workspaceId: ws.workspaceId, epoch: ws.epoch, extra: true },
    });
    assert.equal(extraRes.statusCode, 400);

    const afterMid = await f.snapshot(userStateEntityKey(library('w-m')));
    assert.equal(afterMid.records.length, 1);
    assert.equal(userStateEntityKey(afterMid.records[0].entity), userStateEntityKey(library('w-z')));
  } finally {
    await f.close();
  }
});

test('[T2-E3] POST /snapshot returns empty page cleanly when all records were GCd', async t => {
  const f = await setup({ t });
  try {
    const m = await f.merge([op(bookmark('w-all-gone'), { bookmarked: true })]);
    await f.merge([op(bookmark('w-all-gone'), { bookmarked: false }, m.results[0].current!.revision)]);
    await f.advanceDaysAndCompact(400);

    const snap = await f.snapshot();
    assert.deepEqual(snap.records, []);
    assert.equal(snap.hasMore, false);
    assert.equal(snap.nextEntityKey, null);
    assert.equal(snap.headRevision, 2);
    assert.equal(snap.snapshotRevision, snap.headRevision);
    assert.equal(snap.seedAllowed, false);
  } finally {
    await f.close();
  }
});

test('[T2-E6] POST /snapshot returns 413 when a single stored record exceeds 32 MiB response budget', async t => {
  const f = await setup({ t });
  try {
    const huge = makeComposition(2650, 'z'.repeat(4096));
    const hugeRecord: UserStateRecord = {
      entity: compositionEntity('huge-snap'),
      value: { composition: huge },
      revision: 1,
      operationId: randomUUID(),
      updatedAt: BASE_NOW,
      deviceId: 'dev-huge',
      deviceName: 'Device A',
    };
    const hugeSerialized = JSON.stringify(hugeRecord);
    assert.ok(Buffer.byteLength(hugeSerialized) + 4096 > USER_STATE_MAX_BYTES);
    const rwDb = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      const key = userStateEntityKey(hugeRecord.entity);
      rwDb
        .prepare('INSERT INTO user_state_records(entity_key,kind,revision,record) VALUES(?,?,?,?)')
        .run(key, 'composition', 1, hugeSerialized);
      rwDb.prepare('INSERT INTO user_state_changes(entity_key,record) VALUES(?,?)').run(key, hugeSerialized);
      rwDb.prepare('UPDATE user_state_meta SET head_revision=1 WHERE singleton=1').run();
    } finally {
      rwDb.close();
    }
    const res = await f.snapshotRaw(null, 10);
    assert.equal(res.statusCode, 413, res.body);
  } finally {
    await f.close();
  }
});

// ============================================================================
// TIER 3: Cross-Feature Pairwise Combinations
// ============================================================================

test('[T3-01] compaction + headRevision monotonicity + 409 stale receipt replay', async t => {
  const f = await setup({ t });
  try {
    const op1 = op(reading('w-301'), { progress: 10, readAt: BASE_NOW });
    const r1 = await f.merge([op1]);
    const op2 = op(reading('w-301'), { progress: 95, readAt: BASE_NOW + 10 }, r1.results[0].current!.revision);
    await f.merge([op2]);

    const ready = await f.advanceUntil(() =>
      f.withDb(db => {
        const changes = Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_changes').get() as { n: number }).n);
        const row = db.prepare('SELECT result FROM user_state_operations WHERE operation_id=?').get(op1.operationId) as
          | { result: string | null }
          | undefined;
        return changes === 1 && row !== undefined && row.result === null;
      }),
    );
    assert.equal(ready, true);
    assert.equal((await f.workspace()).headRevision, 2);

    const readRes = await f.read(0);
    assert.equal(readRes.records.length, 1);
    assert.equal(readRes.records[0].revision, 2);

    const replay = await f.mergeRaw([op1]);
    assert.equal(replay.statusCode, 409);
    assert.deepEqual((await f.read(0)).records[0].value, { progress: 95, readAt: BASE_NOW + 10 });
  } finally {
    await f.close();
  }
});

test('[T3-02] physical GC + 410 Gone + seed: true anti-resurrection', async t => {
  const f = await setup({ t });
  try {
    const bm = bookmark('w-302');
    const r1 = await f.merge([op(bm, { bookmarked: true })]);
    await f.merge([op(bm, { bookmarked: false }, r1.results[0].current!.revision)]);
    await f.advanceDaysAndCompact(400);

    const readErr = await f.readRaw(0);
    assert.equal(readErr.statusCode, 410);
    assert.equal(readErr.json().code, 'cursor-compacted');

    const seedRes = await f.merge([op(bm, { bookmarked: true }, 0, true)], f.deviceB);
    assert.equal(seedRes.results[0].status, 'seed-skipped');
    assert.equal(seedRes.results[0].current, null);
  } finally {
    await f.close();
  }
});

test('[T3-03] physical GC cleans dangling user_state_category_aliases after canonical category removal', async t => {
  const f = await setup({ t });
  try {
    const c1 = await f.merge([op(category('c-1'), { name: 'Fav', sort: 1, deleted: false })]);
    const c2 = await f.merge([op(category('c-2'), { name: 'Fav', sort: 2, deleted: false }, 0, true)], f.deviceB);
    assert.equal(c2.results[0].status, 'aliased');

    await f.merge([op(membership('c-2', 'w-303'), { included: true })], f.deviceB);
    await f.merge([op(category('c-1'), { name: 'Fav', sort: 1, deleted: true }, c1.results[0].current!.revision)]);

    await f.advanceDaysAndCompact(400);
    const aliasesLeft = f.withDb(db =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_category_aliases WHERE canonical_id=?').get('c-1') as { n: number }).n),
    );
    assert.equal(aliasesLeft, 0);

    const recreate = await f.merge([op(category('c-3'), { name: 'Fav', sort: 3, deleted: false })], f.deviceB);
    assert.equal(recreate.results[0].status, 'applied');
    assert.equal(recreate.results[0].current!.entity.kind, 'category');
  } finally {
    await f.close();
  }
});

test('[T3-04] physical GC preserves work_migration_lineage and work-migration-recovery uses user_state_records', async t => {
  const f = await setup({ t });
  const backupDir = await mkdtemp(join(tmpdir(), 'norea-e2e-mig-bak-'));
  const backupFilesDir = join(backupDir, 'files');
  const stagingRoot = join(backupDir, 'staging');
  try {
    const { mkdir } = await import('node:fs/promises');
    const { openDatabase } = await import('../src/db.ts');
    const backupApp = await buildApp({ dataDir: backupDir, anonymousRead: true });
    const backupHeaders = await deviceHeaders(backupApp, 'Backup');
    const srcBak = await createWorkAndChapter(backupApp, backupHeaders, 'src-p', 'src-1', '/src/1', '/src/1/1', '1', '<p>Source ch1</p>');
    await backupApp.close();

    const folderName = (() => {
      const bdb = new DatabaseSync(join(backupDir, 'metadata.sqlite'), { readOnly: true });
      try {
        const row = bdb.prepare('SELECT directory, path FROM chapters WHERE id=?').get(srcBak.chapterEntry.id) as {
          directory: string;
          path: string | null;
        };
        return (row.path ?? row.directory).split(/[\\/]/).pop()!;
      } finally {
        bdb.close();
      }
    })();
    await mkdir(join(backupFilesDir, folderName), { recursive: true });
    await writeFile(join(backupFilesDir, folderName, 'content.html'), '<p>Source ch1</p>', 'utf8');

    const src = await createWorkAndChapter(f.app, f.deviceA, 'src-p', 'src-1', '/src/1', '/src/1/1', '1', '<p>Source ch1</p>');
    const tgtWorkId = digest(JSON.stringify(['tgt-p', '/tgt/1']));
    const tgtPut = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/works/${tgtWorkId}`,
      headers: f.deviceA,
      payload: {
        schemaVersion: 1,
        identity: { pluginId: 'tgt-p', novelId: 'tgt-1', novelPath: '/tgt/1' },
        novel: {
          name: 'Work tgt-1',
          author: null,
          artist: null,
          summary: null,
          status: null,
          genres: null,
          rating: null,
          isLocal: false,
        },
        cover: null,
        chapters: { '1': 'Episode 1' },
      },
    });
    assert.equal(tgtPut.statusCode, 200, tgtPut.body);

    const srcSnap = (await f.app.inject(`/api/v1/works/${src.workId}/migration-snapshot`)).json();
    const tgtSnap = (await f.app.inject(`/api/v1/works/${tgtWorkId}/migration-snapshot`)).json();
    const srcInv = (await f.app.inject(`/api/v1/chapters/${src.chapterEntry.id}/storage-inventory?revision=${src.chapterEntry.revision}`)).json().inventory;

    const migOpId = randomUUID();
    const fin = await f.app.inject({
      method: 'POST',
      url: `/api/v1/works/${src.workId}/finalize-migration`,
      headers: f.deviceA,
      payload: {
        operationId: migOpId,
        source: { revision: srcSnap.work.revision, chapters: [{ id: src.chapterEntry.id, revision: src.chapterEntry.revision }] },
        target: { id: tgtWorkId, revision: tgtSnap.work.revision },
        mappings: [
          {
            sourceChapterId: src.chapterEntry.id,
            decision: 'delete-source',
            explicitSourceDiscard: { approvedByUser: true, expectedSourceInventory: srcInv },
          },
        ],
        chapterDecisions: [
          {
            sourceChapterPath: '/src/1/1',
            sourceChapterNumber: '1',
            targetChapterPath: '/tgt/1/1',
            targetChapterNumber: '1',
            discardSourceContent: true,
          },
        ],
      },
    });
    assert.equal(fin.statusCode, 200, fin.body);

    // Merge then delete & GC source work user-state while keeping target work reading state
    const srcLib: UserStateEntity = { kind: 'library', work: work('src-1', 'src-p') };
    const tgtRead: UserStateEntity = { kind: 'reading', work: work('tgt-1', 'tgt-p'), chapter: chapter('/tgt/1/1') };
    const m = await f.merge([
      op(srcLib, { inLibrary: true, addedAt: BASE_NOW }),
      op(tgtRead, { progress: 100, readAt: BASE_NOW }),
    ]);
    await f.merge([op(srcLib, { inLibrary: false, addedAt: null }, m.results[0].current!.revision)]);
    await f.advanceDaysAndCompact(400);

    const migList = await f.app.inject('/api/v1/work-migrations');
    assert.equal(migList.statusCode, 200);
    assert.equal(migList.json().items.length, 1);

    const history = await f.app.inject(`/api/v1/works/${tgtWorkId}/migration-history`);
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().items.length, 1);

    assert.equal(
      f.withDb(db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_state_current_records'").get())),
      false,
    );

    await f.app.close();
    const liveDb = openDatabase(f.dataDir);
    try {
      const report = await recoverDiscardedMigrationChapters({
        db: liveDb,
        dataDir: f.dataDir,
        backupDbPath: join(backupDir, 'metadata.sqlite'),
        backupSourceDir: backupFilesDir,
        stagingRoot,
        operationId: migOpId,
        expectedChapterCount: 1,
      });
      assert.equal(report.publishedCount, 1);
    } finally {
      liveDb.close();
    }
    await f.restart();
  } finally {
    await rm(backupDir, { recursive: true, force: true });
    await f.close();
  }
});

test('[T3-05] policy 2-A + physical GC advances compactedThrough and returns 410 Gone with pruned /snapshot', async t => {
  const f = await setup({ t });
  try {
    assert.equal((await f.adminPatchRetention({ pruneNonLibraryReading: { enabled: true, days: 30 } })).statusCode, 200);
    const oldMs = BASE_NOW - 60 * DAY_MS;
    await f.merge([
      op(library('w-lib'), { inLibrary: true, addedAt: oldMs }),
      op(reading('w-lib'), { progress: 100, readAt: oldMs }),
      op(library('w-nonlib'), { inLibrary: false, addedAt: null }),
      op(reading('w-nonlib'), { progress: 50, readAt: oldMs }),
    ]);

    await f.advanceDaysAndCompact(400);
    assert.equal((await f.readRaw(0)).statusCode, 410);
    const snap = await f.snapshot();
    const keys = new Set(snap.records.map(r => userStateEntityKey(r.entity)));
    assert.equal(keys.has(userStateEntityKey(reading('w-lib'))), true);
    assert.equal(keys.has(userStateEntityKey(reading('w-nonlib'))), false);
  } finally {
    await f.close();
  }
});

test('[T3-06] policy 2-B + payload immutability + superseded_at compaction', async t => {
  const f = await setup({ t });
  try {
    assert.equal((await f.adminPatchRetention({ stripReadingTimestamps: { enabled: true, days: 30 } })).statusCode, 200);
    await f.merge([op(reading('w-306'), { progress: 80, readAt: BASE_NOW - 60 * DAY_MS })]);
    const rev1Before = JSON.stringify((await f.read(0)).records[0]);

    await f.adminCompact();
    const beforeCompaction = await f.read(0);
    assert.equal(beforeCompaction.headRevision, 2);
    assert.equal(beforeCompaction.records.length, 2);
    assert.equal(JSON.stringify(beforeCompaction.records[0]), rev1Before);
    assert.deepEqual(beforeCompaction.records[1].value, { progress: 80, readAt: null });

    await f.advanceDaysAndCompact(400);
    const afterCompaction = await f.read(0);
    assert.equal(afterCompaction.records.length, 1);
    assert.equal(afterCompaction.records[0].revision, 2);
  } finally {
    await f.close();
  }
});

test('[T3-07] policy 2-C + seedCutoffAt blocks old seed while allowing explicit edit in same batch', async t => {
  const f = await setup({ t });
  try {
    assert.equal((await f.adminPatchRetention({ slidingWindow: { enabled: true, months: 3 } })).statusCode, 200);
    await f.adminCompact();
    const cutoff = (await f.retention()).seedCutoffAt!;
    const m = await f.merge([
      op(reading('w-307-seed'), { progress: 50, readAt: cutoff - 1000 }, 0, true),
      op(reading('w-307-explicit'), { progress: 50, readAt: cutoff - 1000 }, 0, false),
    ]);
    assert.equal(m.results[0].status, 'seed-skipped');
    assert.equal(m.results[0].current, null);
    assert.equal(m.results[1].status, 'applied');
  } finally {
    await f.close();
  }
});

test('[T3-08] workspace epoch reset + device backup deletion + auto_vacuum reclaim', async t => {
  const f = await setup({ t });
  try {
    await f.merge(Array.from({ length: 150 }, (_, i) => op(library(`w-${i}`), { inLibrary: true, addedAt: BASE_NOW })));
    await f.uploadBackup('Phone', Buffer.from('PK p1'));
    await f.uploadBackup('Tablet', Buffer.from('PK t1'));

    const del = await f.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/device-backups/Phone',
      headers: await f.admin(),
    });
    assert.equal(del.statusCode, 200);

    const oldEpoch = (await f.workspace()).epoch;
    const rst = await f.adminReset();
    assert.equal(rst.reset, true);
    assert.equal(rst.previousEpoch, oldEpoch);
    assert.notEqual(rst.state.epoch, oldEpoch);
    assert.equal(rst.state.headRevision, 0);

    const cmp = await f.adminCompact();
    assert.equal(cmp.state.freelistPages, 0);
    assert.equal(cmp.state.walBytes, 0);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/device-backups/Phone', headers: f.deviceA })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/device-backups/Tablet', headers: f.deviceA })).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('[T3-09] user_state_current_* retirement + readUserStateComposition + 2-stage op cleanup', async t => {
  const f = await setup({ t });
  try {
    const comp = makeComposition(3);
    await f.merge([op(compositionEntity('w-309'), { composition: comp })]);
    await f.advanceDaysAndCompact(730);

    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_operations').get() as { n: number }).n)),
      0,
    );
    const loaded = f.withDb(db =>
      readUserStateComposition(db, { pluginId: 'example-source', novelId: 'w-309', novelPath: '/novel/w-309' }),
    );
    assert.deepEqual(loaded, comp);
  } finally {
    await f.close();
  }
});

test('[T3-10] GET /api/v1/admin/user-state reflects compactable counts and freelist before vs after compact', async t => {
  const f = await setup({ t });
  try {
    const first = await f.merge(
      Array.from({ length: 40 }, (_, i) => op(reading(`w-310-${i}`), { progress: 10, readAt: BASE_NOW })),
    );
    await f.merge(
      first.results.map((r, i) =>
        op(reading(`w-310-${i}`), { progress: 80, readAt: BASE_NOW + 10 }, r.current!.revision),
      ),
    );
    t.mock.timers.tick(400 * DAY_MS);
    const before = await f.adminUserState();
    assert.equal(before.records.total, 40);
    assert.equal(before.records.active, 40);
    assert.equal(before.records.tombstones, 0);
    assert.equal(before.changes.total, 80);
    assert.equal(before.changes.compactable, 40);
    assert.equal(before.operations.total, 80);
    assert.equal(before.tables.find(tbl => tbl.name === 'user_state_records')?.rows, 40);
    assert.equal(before.tables.find(tbl => tbl.name === 'user_state_changes')?.rows, 80);
    assert.equal(before.tables.find(tbl => tbl.name === 'user_state_operations')?.rows, 80);

    const after = await f.adminCompact();
    assert.equal(after.maintenance.deletedChanges, 40);
    assert.equal(after.maintenance.deletedOperations, 80);
    assert.equal(after.state.headRevision, 80);
    assert.equal(after.state.headRevision, before.headRevision);
    assert.equal(after.state.freelistPages, 0);
    assert.equal(after.state.walBytes, 0);

    assert.equal(after.state.records.total, 40);
    assert.equal(after.state.records.active, 40);
    assert.equal(after.state.records.tombstones, 0);
    assert.equal(after.state.changes.total, 40);
    assert.equal(after.state.changes.compactable, 0);
    assert.equal(after.state.operations.total, 0);

    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_changes').get() as { n: number }).n)),
      40,
    );
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_operations').get() as { n: number }).n)),
      0,
    );
  } finally {
    await f.close();
  }
});

test('[T3-21] 413 oversized merge batch rolls back cleanly, smaller bisected batches succeed and later undergo stage-1 cleanup', async t => {
  const f = await setup({ t });
  try {
    const big = makeComposition(1200, 'b'.repeat(4096));
    const ops = [1, 2, 3, 4].map(i => op(compositionEntity(`bisect-${i}`), { composition: big }));
    const tooBig = await f.mergeRaw(ops);
    assert.equal(tooBig.statusCode, 413);
    assert.equal(
      f.withDb(db => Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_operations').get() as { n: number }).n)),
      0,
    );

    await f.merge(ops.slice(0, 2));
    await f.merge(ops.slice(2, 4));
    const stage1 = await f.advanceUntil(() =>
      f.withDb(db => {
        const nulls = Number(
          (db.prepare('SELECT COUNT(*) AS n FROM user_state_operations WHERE result IS NULL').get() as { n: number }).n,
        );
        return nulls === 4;
      }),
    );
    assert.equal(stage1, true);
  } finally {
    await f.close();
  }
});

// ============================================================================
// TIER 4: Real-World Multi-Client & Multi-Step Workflows
// ============================================================================

test('[T4-01] 2-device active reading + compaction + new device join + 409 stale replay', async t => {
  const f = await setup({ t });
  try {
    const staleOps: UserStateOperation[] = [];
    const latestRevs = new Map<string, number>();
    for (let round = 1; round <= 4; round++) {
      const batch = [1, 2, 3, 4, 5].map(ch => {
        const entity = reading('n-401', `/ch/${ch}`);
        const key = userStateEntityKey(entity);
        const o = op(entity, { progress: round * 25, readAt: BASE_NOW + round }, latestRevs.get(key) ?? 0);
        if (round === 1 && ch === 1) staleOps.push(o);
        return o;
      });
      const res = await f.merge(batch, f.deviceA);
      for (const r of res.results) latestRevs.set(userStateEntityKey(r.current!.entity), r.current!.revision);
    }

    const ready = await f.advanceUntil(() =>
      f.withDb(db => {
        const changes = Number((db.prepare('SELECT COUNT(*) AS n FROM user_state_changes').get() as { n: number }).n);
        const row = db
          .prepare('SELECT result FROM user_state_operations WHERE operation_id=?')
          .get(staleOps[0].operationId) as { result: string | null } | undefined;
        return changes === 5 && row !== undefined && row.result === null;
      }),
    );
    assert.equal(ready, true);

    const deviceBRead = await f.read(0, undefined, 200, f.deviceB);
    assert.equal(deviceBRead.headRevision, 20);
    assert.equal(deviceBRead.records.length, 5);
    assert.ok(deviceBRead.records.every(r => (r.value as { progress: number }).progress === 100));

    assert.equal((await f.mergeRaw([staleOps[0]], f.deviceA)).statusCode, 409);
  } finally {
    await f.close();
  }
});

test('[T4-02] offline device reconnecting after physical tombstone GC gets 410 -> /snapshot without seed resurrection', async t => {
  const f = await setup({ t });
  try {
    const initial = await f.merge(
      [1, 2, 3, 4, 5].map(i => op(library(`w-${i}`), { inLibrary: true, addedAt: BASE_NOW })),
      f.deviceA,
    );
    const deviceBInitial = await f.read(0, undefined, 200, f.deviceB);
    assert.equal(deviceBInitial.nextCursor, 5);

    // Device A deletes works 1..3
    await f.merge(
      [1, 2, 3].map(i =>
        op(library(`w-${i}`), { inLibrary: false, addedAt: null }, initial.results[i - 1].current!.revision),
      ),
      f.deviceA,
    );

    await f.advanceDaysAndCompact(400);
    assert.equal((await f.readRaw(deviceBInitial.nextCursor, undefined, 200, f.deviceB)).statusCode, 410);

    const snap = await f.snapshot(null, 1, f.deviceB);
    assert.equal(snap.hasMore, true);
    assert.ok(snap.nextEntityKey !== null);
    const snap2 = await f.snapshot(snap.nextEntityKey, 1, f.deviceB);
    assert.equal(snap2.hasMore, false);
    assert.equal(snap2.nextEntityKey, null);
    const activeIds = [...snap.records, ...snap2.records].map(r => (r.entity as { work: { sourceNovelId: string } }).work.sourceNovelId);
    assert.deepEqual(activeIds.sort(), ['w-4', 'w-5']);

    // Attempting seed: true on deleted w-1 is blocked
    const resSeed = await f.merge([op(library('w-1'), { inLibrary: true, addedAt: BASE_NOW }, 0, true)], f.deviceB);
    assert.equal(resSeed.results[0].status, 'seed-skipped');
    assert.equal(resSeed.results[0].current, null);

    // Explicit edit on w-4 succeeds
    const w4Rev = [...snap.records, ...snap2.records].find(r => (r.entity as { work: { sourceNovelId: string } }).work.sourceNovelId === 'w-4')!.revision;
    const edit = await f.merge([op(reading('w-4'), { progress: 100, readAt: BASE_NOW + 100 }, 0)], f.deviceB);
    assert.equal(edit.results[0].status, 'applied');
    assert.ok(w4Rev > 0);
  } finally {
    await f.close();
  }
});

test('[T4-03] workspace epoch reset + dual-device Mode A re-seed vs Mode B start fresh divergence', async t => {
  const f = await setup({ t });
  try {
    await f.merge(
      [1, 2, 3].map(i => op(reading(`w-e1-${i}`), { progress: 100, readAt: BASE_NOW })),
      f.deviceA,
    );
    const ws1 = await f.workspace(f.deviceA);

    const reset = await f.adminReset();
    assert.equal(reset.reset, true);
    assert.equal(reset.previousEpoch, ws1.epoch);
    assert.notEqual(reset.state.epoch, ws1.epoch);
    assert.equal((await f.readRaw(0, undefined, 200, f.deviceA, ws1)).statusCode, 409);

    // Device A rebinds Mode A (re-seeds)
    const ws2 = await f.workspace(f.deviceA);
    const modeA = await f.merge([op(library('w-a-reseed'), { inLibrary: true, addedAt: BASE_NOW }, 0, true)], f.deviceA, ws2);
    assert.equal(modeA.headRevision, 1);

    // Device B rebinds Mode B (starts fresh at cursor=ws2.headRevision without seeding old E1 chapters, only new edit)
    const ws2B = await f.workspace(f.deviceB);
    const pulled = await f.read(0, undefined, 200, f.deviceB, ws2B);
    assert.equal(pulled.records.length, 1);
    const newEdit = await f.merge([op(reading('w-b-new'), { progress: 30, readAt: BASE_NOW + 50 })], f.deviceB, ws2B);
    assert.equal(newEdit.headRevision, 2);
  } finally {
    await f.close();
  }
});

test('[T4-04] policy 2-C sliding window retention + late client seed filtering', async t => {
  const f = await setup({ t });
  try {
    assert.equal((await f.adminPatchRetention({ slidingWindow: { enabled: true, months: 6 } })).statusCode, 200);
    const oldMs = BASE_NOW - 240 * DAY_MS;
    const recentMs = BASE_NOW - 20 * DAY_MS;
    await f.merge([
      op(reading('w-old-hist'), { progress: 100, readAt: oldMs }),
      op(reading('w-new-hist'), { progress: 50, readAt: recentMs }),
    ]);
    await f.adminCompact();

    const ret = await f.retention();
    assert.ok(ret.seedCutoffAt !== null && ret.compactedThrough >= 0);

    const deviceC = await deviceHeaders(f.app, 'Device C');
    const batch = await f.merge(
      [
        op(reading('w-late-old'), { progress: 80, readAt: oldMs }, 0, true),
        op(reading('w-late-new'), { progress: 80, readAt: recentMs }, 0, true),
      ],
      deviceC,
    );
    assert.equal(batch.results[0].status, 'seed-skipped');
    assert.equal(batch.results[0].current, null);
    assert.equal(batch.results[1].status, 'applied');
  } finally {
    await f.close();
  }
});

test('[T4-05] admin lifecycle: backup deletion, retention config, manual compact, vacuum, and stats drop', async t => {
  const f = await setup({ t });
  try {
    await f.uploadBackup('Phone', Buffer.from('PK phone'));
    await f.uploadBackup('Tablet', Buffer.from('PK tablet'));

    for (let round = 0; round < 5; round++) {
      await f.merge(
        Array.from({ length: 50 }, (_, i) =>
          op(reading(`w-life-${i}`, '/ch/1'), { progress: (round + 1) * 20, readAt: BASE_NOW - 100 * DAY_MS }, round === 0 ? 0 : round * 50 + i + 1 - 50),
        ),
      );
    }
    const nonLib = await f.merge([
      op(library('w-nonlib-405'), { inLibrary: false, addedAt: null }),
      op(reading('w-nonlib-405'), { progress: 40, readAt: BASE_NOW - 100 * DAY_MS }),
    ]);
    assert.ok(nonLib.headRevision >= 252);

    const adminHeaders = await f.admin();
    const backupsList = await f.app.inject({ method: 'GET', url: '/api/v1/admin/device-backups', headers: adminHeaders });
    assert.equal(backupsList.statusCode, 200);
    assert.equal(backupsList.json().items.length, 2);

    const beforeStats = await f.adminUserState();
    assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/v1/admin/device-backups/Phone', headers: adminHeaders })).statusCode, 200);
    assert.equal((await f.adminPatchRetention({ pruneNonLibraryReading: { enabled: true, days: 30 }, stripReadingTimestamps: { enabled: true, days: 60 } })).statusCode, 200);

    await f.advanceDaysAndCompact(400);
    const finalStats = await f.adminUserState();
    assert.ok(finalStats.headRevision >= beforeStats.headRevision);
    assert.equal(finalStats.freelistPages, 0);
    assert.equal(finalStats.walBytes, 0);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/device-backups/Phone', headers: f.deviceA })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/device-backups/Tablet', headers: f.deviceA })).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('[T4-06] work migration + source tombstone GC + /snapshot reconnection preserves lineage and target state', async t => {
  const f = await setup({ t });
  try {
    const src = await createWorkAndChapter(f.app, f.deviceA, 'p-src', 'n-src', '/src/406', '/src/406/1', '1');
    const tgt = await createWorkAndChapter(f.app, f.deviceA, 'p-tgt', 'n-tgt', '/tgt/406', '/tgt/406/1', '1');
    const srcSnap = (await f.app.inject(`/api/v1/works/${src.workId}/migration-snapshot`)).json();
    const tgtSnap = (await f.app.inject(`/api/v1/works/${tgt.workId}/migration-snapshot`)).json();
    const fin = await f.app.inject({
      method: 'POST',
      url: `/api/v1/works/${src.workId}/finalize-migration`,
      headers: f.deviceA,
      payload: {
        operationId: randomUUID(),
        source: { revision: srcSnap.work.revision, chapters: [{ id: src.chapterEntry.id, revision: src.chapterEntry.revision }] },
        target: { id: tgt.workId, revision: tgtSnap.work.revision },
        mappings: [{ sourceChapterId: src.chapterEntry.id, targetChapterId: tgt.chapterEntry.id, targetRevision: tgt.chapterEntry.revision, decision: 'copy-source' }],
      },
    });
    assert.equal(fin.statusCode, 200, fin.body);

    const w1Lib: UserStateEntity = { kind: 'library', work: work('n-src', 'p-src') };
    const w2Read: UserStateEntity = { kind: 'reading', work: work('n-tgt', 'p-tgt'), chapter: chapter('/tgt/406/1') };
    const m1 = await f.merge([op(w1Lib, { inLibrary: true, addedAt: BASE_NOW }), op(w2Read, { progress: 100, readAt: BASE_NOW })]);
    await f.merge([op(w1Lib, { inLibrary: false, addedAt: null }, m1.results[0].current!.revision)]);

    await f.advanceDaysAndCompact(400);
    assert.equal((await f.readRaw(0, undefined, 200, f.deviceB)).statusCode, 410);
    const snap = await f.snapshot(null, 50, f.deviceB);
    assert.equal(snap.records.length, 1);
    assert.equal(userStateEntityKey(snap.records[0].entity), userStateEntityKey(w2Read));
    assert.equal((await f.app.inject(`/api/v1/works/${tgt.workId}/migration-history`)).json().items.length, 1);
  } finally {
    await f.close();
  }
});

test('[T4-09] category alias + deletion + physical GC + cross-device recreation without alias conflict', async t => {
  const f = await setup({ t });
  try {
    const c1 = await f.merge([op(category('cat-1'), { name: 'Sci-Fi', sort: 1, deleted: false })], f.deviceA);
    const c2 = await f.merge([op(category('cat-2'), { name: 'Sci-Fi', sort: 2, deleted: false }, 0, true)], f.deviceB);
    assert.equal(c2.results[0].status, 'aliased');

    await f.merge([op(membership('cat-2', 'w-409'), { included: true })], f.deviceB);
    await f.merge([op(category('cat-1'), { name: 'Sci-Fi', sort: 1, deleted: true }, c1.results[0].current!.revision)], f.deviceA);

    await f.advanceDaysAndCompact(400);
    assert.equal((await f.readRaw(0, undefined, 200, f.deviceB)).statusCode, 410);
    assert.equal((await f.snapshot(null, 50, f.deviceB)).records.length, 0);

    const recreated = await f.merge([op(category('cat-3'), { name: 'Sci-Fi', sort: 1, deleted: false })], f.deviceB);
    assert.equal(recreated.results[0].status, 'applied');
    assert.deepEqual(recreated.results[0].current!.entity, category('cat-3'));
  } finally {
    await f.close();
  }
});

test('[T4-10] legacy DB upgrade continuity with auto_vacuum=0 opening, one-time post-backup conversion, reading_state_entries, and capabilities', async t => {
  const f = await setup({ t });
  try {
    await createWorkAndChapter(f.app, f.deviceA, 'p-410', 'n-410', '/n410', '/n410/1', '1');
    await f.merge([op(compositionEntity('n-410'), { composition: makeComposition(1) })]);
    const passwordBefore = await readFile(join(f.dataDir, 'admin-password.hash'));
    const checksumBefore = f.withDb(db => (db.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum);
    await f.app.close();

    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      db.exec('PRAGMA auto_vacuum = 0; VACUUM;');
      db.exec("CREATE TABLE IF NOT EXISTS user_state_current_records (entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL);");
      db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('prof', 'k', '{}');
    } finally {
      db.close();
    }

    // (a) Upgraded server opens legacy auto_vacuum = 0 DB cleanly without unbacked-up startup VACUUM
    await f.restart();
    assert.equal(f.withDb(d => Number((d.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum)), 0);
    assert.equal(f.withDb(d => (d.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum), checksumBefore);
    assert.equal(f.withDb(d => Number((d.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get() as { n: number }).n)), 1);
    assert.equal(f.withDb(d => Number((d.prepare('SELECT COUNT(*) AS n FROM user_state_records').get() as { n: number }).n)), 1);
    assert.equal(f.withDb(d => Number((d.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n)), 2);
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), passwordBefore);
    assert.ok(f.withDb(d => readUserStateComposition(d, { pluginId: 'example-source', novelId: 'n-410', novelPath: '/novel/n-410' })));
    const caps = (await f.app.inject('/api/v1/capabilities')).json();
    assert.equal(caps.readingStateVersion, 1);
    assert.equal(caps.deviceBackupVersion, 1);
    assert.equal(caps.userStateRetentionVersion, 1);
    assert.equal(caps.userStateCurrentVersion, undefined);

    // (b) Documented one-time post-backup conversion: PRAGMA auto_vacuum = INCREMENTAL; VACUUM;
    await f.app.close();
    const convDb = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      convDb.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
      assert.equal(Number((convDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum), 2);
    } finally {
      convDb.close();
    }

    await f.restart();
    assert.equal(f.withDb(d => Number((d.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum)), 2);

    // Generate reclaimable pages and verify adminCompact() reclaims incrementally while preserving all rows
    const churn = await f.merge(
      Array.from({ length: 15 }, (_, i) =>
        op(compositionEntity(`n-410-churn-${i}`), { composition: makeComposition(10, 'c'.repeat(1024)) }),
      ),
    );
    await f.merge(
      churn.results.map((r, i) =>
        op(compositionEntity(`n-410-churn-${i}`), { composition: makeComposition(1, 'z') }, r.current!.revision),
      ),
    );
    f.withDb(d => {
      d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }, false);
    const sizeBeforeCompact = (await f.adminUserState()).dbBytes;

    const compactStats = await f.advanceDaysAndCompact(400);
    assert.equal(compactStats.state.autoVacuum, 2);
    assert.equal(compactStats.state.freelistPages, 0);
    assert.equal(compactStats.state.walBytes, 0);
    assert.ok(
      compactStats.state.dbBytes < sizeBeforeCompact,
      `expected incremental vacuum to shrink dbBytes (${compactStats.state.dbBytes}) < ${sizeBeforeCompact}`,
    );

    assert.equal(f.withDb(d => (d.prepare('SELECT checksum FROM schema_state').get() as { checksum: string }).checksum), checksumBefore);
    assert.equal(f.withDb(d => Number((d.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get() as { n: number }).n)), 1);
    assert.equal(f.withDb(d => Number((d.prepare('SELECT COUNT(*) AS n FROM user_state_records').get() as { n: number }).n)), 16);
    assert.equal(f.withDb(d => Number((d.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n)), 2);
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), passwordBefore);
    assert.ok(f.withDb(d => readUserStateComposition(d, { pluginId: 'example-source', novelId: 'n-410', novelPath: '/novel/n-410' })));
  } finally {
    await f.close();
  }
});

test('[T4-11] combined 2-A + 2-B long-term hygiene cycle differentiates library vs non-library works', async t => {
  const f = await setup({ t });
  try {
    assert.equal((await f.adminPatchRetention({ pruneNonLibraryReading: { enabled: true, days: 30 }, stripReadingTimestamps: { enabled: true, days: 90 } })).statusCode, 200);
    const d120 = BASE_NOW - 120 * DAY_MS;
    const d45 = BASE_NOW - 45 * DAY_MS;
    await f.merge([
      op(library('w-lib-411'), { inLibrary: true, addedAt: d120 }),
      op(reading('w-lib-411'), { progress: 85, readAt: d120 }),
      op(resume('w-lib-411'), { chapter: chapter(), anchor: null, openedAt: d120 }),
      op(library('w-nonlib-411'), { inLibrary: false, addedAt: null }),
      op(reading('w-nonlib-411'), { progress: 40, readAt: d45 }),
    ]);

    await f.adminCompact();
    const latest = await f.snapshot();
    const libReading = latest.records.find(r => userStateEntityKey(r.entity) === userStateEntityKey(reading('w-lib-411')));
    assert.ok(libReading);
    assert.deepEqual(libReading.value, { progress: 85, readAt: null });

    const libResume = latest.records.find(r => userStateEntityKey(r.entity) === userStateEntityKey(resume('w-lib-411')));
    assert.ok(libResume);
    assert.deepEqual(libResume.value, { chapter: null, anchor: null, openedAt: null });

    const nonLibReading = latest.records.find(r => userStateEntityKey(r.entity) === userStateEntityKey(reading('w-nonlib-411')));
    assert.equal(nonLibReading, undefined);
  } finally {
    await f.close();
  }
});

test('[T4-12] 410 retry under concurrent compaction and multi-page /snapshot converges cleanly', async t => {
  const f = await setup({ t });
  try {
    const seed = await f.merge([1, 2, 3, 4, 5, 6].map(i => op(library(`w-${i}`), { inLibrary: true, addedAt: BASE_NOW })), f.deviceA);
    await f.merge([op(library('w-6'), { inLibrary: false, addedAt: null }, seed.results[5].current!.revision)], f.deviceA);
    await f.advanceDaysAndCompact(400);

    // Device B gets 410 and starts paginated snapshot
    assert.equal((await f.readRaw(0, undefined, 200, f.deviceB)).statusCode, 410);
    const page1 = await f.snapshot(null, 2, f.deviceB);
    assert.equal(page1.hasMore, true);

    // Concurrent write + GC advances compactedThrough past page1.snapshotRevision!
    const m2 = await f.merge([op(library('w-7'), { inLibrary: true, addedAt: BASE_NOW })], f.deviceA);
    await f.merge([op(library('w-7'), { inLibrary: false, addedAt: null }, m2.results[0].current!.revision)], f.deviceA);
    await f.advanceDaysAndCompact(400);

    // Finish initial snapshot pagination, follow-up read(after: snapshotRevision) gets 410 again -> retry snapshot converges
    let cursorKey = page1.nextEntityKey;
    while (cursorKey !== null) {
      const next = await f.snapshot(cursorKey, 2, f.deviceB);
      cursorKey = next.nextEntityKey;
    }
    assert.equal((await f.readRaw(page1.snapshotRevision, undefined, 200, f.deviceB)).statusCode, 410);

    const retryRecords: UserStateRecord[] = [];
    let retryKey: string | null = null;
    let finalRev = 0;
    do {
      const page = await f.snapshot(retryKey, 2, f.deviceB);
      retryRecords.push(...page.records);
      retryKey = page.nextEntityKey;
      finalRev = page.snapshotRevision;
    } while (retryKey !== null);

    assert.equal(retryRecords.length, 5);
    assert.equal((await f.read(finalRev, undefined, 200, f.deviceB)).records.length, 0);
  } finally {
    await f.close();
  }
});
