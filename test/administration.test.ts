import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

async function setup() {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'administration-'));
  const dataDir = join(root, 'server');
  const original = dataDir;
  await mkdir(join(original, 'contents'), { recursive: true });
  await writeFile(join(original, 'untouched.txt'), 'Original stays unchanged');
  const app = await buildApp({ dataDir });
  return { root, dataDir, original, app, admin: () => consoleHeaders(app, dataDir), device: () => deviceHeaders(app), close: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('administration requires a console session and does not expose filesystem paths to devices', async () => {
  const s = await setup();
  try {
    assert.equal((await s.app.inject('/api/v1/admin/overview')).statusCode, 401);
    assert.equal((await s.app.inject({ url: '/api/v1/admin/settings', headers: await s.device() })).statusCode, 403);
    const headers = await s.admin();
    assert.equal((await s.app.inject({ url: '/api/v1/admin/overview', headers })).statusCode, 200);
    const devices = (await s.app.inject({ url: '/api/v1/admin/devices', headers })).json();
    assert.equal(devices.items.length, 1);
    assert.ok(devices.items.every((a: object) => !('key_hash' in a)));
  } finally { await s.close(); }
});

test('single-root scan registers current chapter files without plugins and preserves originals', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    assert.deepEqual((await s.app.inject({ url: '/api/v1/admin/plugins', headers })).json(), { items: [] });
    const body = '<p>Original chapter</p>';
    const source = join(s.original, 'contents/removed-source/Removed/1'); await mkdir(source, { recursive: true });
    await writeFile(join(source, '..', 'novel.json'), JSON.stringify({ schemaVersion: 1, identity: { pluginId: 'removed-source', novelId: 'Removed', novelPath: '/gone' }, novel: { name: 'Removed work', isLocal: false, author: null, artist: null, cover: null, summary: null, status: null, rating: null, genres: null }, cover: null }));
    await writeFile(join(source, 'content.html'), body);
    const started = await s.app.inject({ method: 'POST', url: '/api/v1/admin/storage/scan', headers });
    assert.equal(started.statusCode, 202, started.body);
    let detail;
    for (let i = 0; i < 100; i++) {
      detail = (await s.app.inject({ url: `/api/v1/admin/jobs/${started.json().id}`, headers })).json();
      if (detail.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(detail.job.status, 'completed');
    assert.equal(detail.job.summary.registered, 2);
    const chapter = detail.items.find((item: { chapterId?: string }) => item.chapterId);
    assert.equal((await s.app.inject({ method: 'DELETE', url: '/api/v1/admin/roots/contents', headers })).statusCode, 404);
    assert.equal(await readFile(join(s.original, 'untouched.txt'), 'utf8'), 'Original stays unchanged');
    assert.equal(await readFile(join(source, 'content.html'), 'utf8'), body);
    assert.equal((await s.app.inject(`/api/v1/chapters/${chapter.chapterId}/files?revision=${chapter.revision}&path=content.html`)).body, body);
    assert.equal((await s.app.inject({ url: `/api/v1/admin/jobs/${started.json().id}`, headers })).json().job.status, 'completed');
  } finally { await s.close(); }
});

test('storage root is fixed at startup and scan mutation inputs are strict', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const storage = (await s.app.inject({ url: '/api/v1/admin/storage', headers })).json();
    assert.equal(storage.path, join(s.dataDir, 'contents'));
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/admin/roots', headers, payload: {} })).statusCode, 404);
    for (const payload of [{ path: s.root }, { name: 'Other root' }, { intervalMinutes: 0 }]) {
      assert.equal((await s.app.inject({ method: 'PATCH', url: '/api/v1/admin/storage', headers, payload })).statusCode, 400);
    }
    assert.equal((await s.app.inject({ method: 'PATCH', url: '/api/v1/admin/storage', headers, payload: { mode: 'manual', intervalMinutes: 30, enabled: false } })).statusCode, 200);
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/admin/storage/scan', headers })).statusCode, 202);
    await s.app.close();
    const restarted = await buildApp({ dataDir: s.dataDir });
    try {
      const saved = (await restarted.inject({ url: '/api/v1/admin/storage', headers: await consoleHeaders(restarted, s.dataDir) })).json();
      assert.equal(saved.intervalMinutes, 30); assert.equal(saved.enabled, false);
    } finally { await restarted.close(); }
  } finally { await s.close(); }
});

test('manual scans aggregate reused results and full inspection refreshes edited files', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const work = join(s.dataDir, 'contents/example/Work'); const chapter = join(work, '1');
    await mkdir(chapter, { recursive: true });
    await writeFile(join(work, 'novel.json'), JSON.stringify({ identity: { pluginId: 'example', novelId: 'Work', novelPath: '/work' }, novel: { name: 'Work' } }));
    await writeFile(join(chapter, 'content.html'), '<p>Saved chapter</p>');
    await mkdir(join(work, '2', 'loose-media'), { recursive: true });
    const scan = async (full: boolean) => {
      const started = await s.app.inject({ method: 'POST', url: '/api/v1/admin/storage/scan', headers, payload: { full } });
      assert.equal(started.statusCode, 202, started.body);
      for (let i = 0; i < 200; i++) {
        const detail = (await s.app.inject({ url: `/api/v1/admin/jobs/${started.json().id}`, headers })).json();
        if (detail.job.status !== 'running') { assert.equal(detail.job.status, 'completed'); return detail; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('Scan did not finish');
    };
    assert.equal((await scan(false)).total, 3);
    const cached = await scan(false);
    assert.equal(cached.total, 0); assert.equal(cached.job.summary.scanned, 3);
    assert.equal(cached.job.summary.unchanged, 2); assert.equal(cached.job.summary.skipped, 1);
    await writeFile(join(chapter, 'content.html'), '<p>Changed chapter body</p>');
    assert.equal((await scan(false)).job.summary.registered, 0);
    const inspected = await scan(true);
    assert.equal(inspected.job.summary.registered, 1); assert.equal(inspected.total, 2);
  } finally { await s.close(); }
});

test('access policy survives restart and protects anonymous reads immediately', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const update = await s.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers, payload: { anonymousRead: false } });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal((await s.app.inject('/api/v1/catalog/changes')).statusCode, 401);
    await s.app.close();
    const restarted = await buildApp({ dataDir: s.dataDir });
    try { assert.equal((await restarted.inject('/api/v1/capabilities')).json().anonymousRead, false); }
    finally { await restarted.close(); }
  } finally { await s.close(); }
});

test('console HTML has a strict local-only content policy and catalog supports empty search', async () => {
  const s = await setup();
  try {
    for (const page of ['overview', 'plugins', 'storage', 'content', 'jobs', 'devices', 'user-state', 'settings']) {
      for (const suffix of ['', '/']) {
        const route = await s.app.inject(`/admin/${page}${suffix}`);
        assert.equal(route.statusCode, 200); assert.match(route.headers['content-type'] as string, /text\/html/);
      }
    }
    assert.equal((await s.app.inject('/admin/not-a-route')).statusCode, 404);
    const response = await s.app.inject('/admin/');
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-security-policy'] as string, /default-src 'self'/);
    const result = await s.app.inject({ url: '/api/v1/admin/chapters?search=&deleted=false', headers: await s.admin() });
    assert.deepEqual(result.json(), { items: [], total: 0 });
  } finally { await s.close(); }
});
test('startup removes abandoned multipart files but preserves unrelated staging files', async () => {
  const s = await setup();
  try {
    await s.app.close();
    const unrelated = join(s.dataDir, 'staging', 'keep-me');
    const multipart = join(s.dataDir, 'staging', 'files-12345678-1234-4123-8123-123456789abc');
    await mkdir(unrelated, { recursive: true });
    await mkdir(multipart);
    await writeFile(join(multipart, 'content.html'), 'Partial upload');
    await writeFile(join(unrelated, 'keep.txt'), 'Keep');
    const app = await buildApp({ dataDir: s.dataDir });
    try {
      await assert.rejects(readFile(join(multipart, 'content.html')), /ENOENT/);
      assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'Keep');
    } finally { await app.close(); }
  } finally { await s.close(); }
});

test('change-driven folder watching schedules a new durable scan after a filesystem change', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const response = await s.app.inject({ method: 'PATCH', url: '/api/v1/admin/storage', headers, payload: { mode: 'changes', intervalMinutes: 15 } });
    assert.equal(response.statusCode, 200, response.body);
    const waitForJobs = async (count: number) => {
      for (let i = 0; i < 120; i++) {
        const jobs = (await s.app.inject({ url: '/api/v1/admin/jobs', headers })).json().items;
        if (jobs.length >= count && jobs.every((job: { status: string }) => job.status === 'completed')) return jobs;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail('Scheduled folder scan did not complete');
    };
    await waitForJobs(1);
    await writeFile(join(s.original, 'contents', 'new-file.txt'), 'Source changed');
    const jobs = await waitForJobs(2);
    const results = (await s.app.inject({ url: `/api/v1/admin/jobs/${jobs[0].id}`, headers })).json();
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].status, 'skipped');
    assert.equal(await readFile(join(s.original, 'contents', 'new-file.txt'), 'utf8'), 'Source changed');
  } finally { await s.close(); }
});


test('in-place indexing does not cause repeated change-driven scans', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const work = join(s.dataDir, 'contents/example/Work'); const chapter = join(work, '1');
    await mkdir(chapter, { recursive: true });
    await writeFile(join(work, 'novel.json'), JSON.stringify({ schemaVersion: 1, identity: { pluginId: 'example', novelId: 'Work', novelPath: '/work' }, novel: { name: 'Work', author: null, artist: null, cover: null, summary: null, status: null, rating: null, genres: null, isLocal: false }, cover: null }));
    await writeFile(join(chapter, 'content.html'), '<p>Saved chapter</p>');
    const response = await s.app.inject({ method: 'PATCH', url: '/api/v1/admin/storage', headers, payload: { mode: 'changes', intervalMinutes: 15 } });
    assert.equal(response.statusCode, 200);
    let jobs: { status: string; summary: { registered: number } }[] = [];
    for (let i = 0; i < 120; i++) {
      jobs = (await s.app.inject({ url: '/api/v1/admin/jobs', headers })).json().items;
      if (jobs.length && jobs.every(job => job.status === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed'); assert.equal(jobs[0].summary.registered, 2);
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal((await s.app.inject({ url: '/api/v1/admin/jobs', headers })).json().items.length, 1);
  } finally { await s.close(); }
});

test('filesystem events inspect only the changed work and reconcile removed chapter folders', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    for (const name of ['First', 'Other']) {
      const work = join(s.dataDir, 'contents/example', name);
      await mkdir(join(work, '1'), { recursive: true });
      await writeFile(join(work, 'novel.json'), JSON.stringify({ identity: { pluginId: 'example', novelId: name, novelPath: '/' + name }, novel: { name } }));
      await writeFile(join(work, '1/content.html'), '<p>Original chapter</p>');
    }
    const waitForJob = async (count: number) => {
      for (let i = 0; i < 200; i++) {
        const jobs = (await s.app.inject({ url: '/api/v1/admin/jobs', headers })).json().items;
        if (jobs.length >= count && jobs.every((job: { status: string }) => job.status === 'completed')) return jobs[0];
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail('Filesystem scan did not finish');
    };
    await s.app.inject({ method: 'PATCH', url: '/api/v1/admin/storage', headers, payload: { mode: 'changes', intervalMinutes: 15 } });
    assert.equal((await waitForJob(1)).summary.registered, 4);
    const chapter = join(s.dataDir, 'contents/example/First/1');
    await writeFile(join(chapter, 'content.html'), '<p>Edited chapter body</p>');
    const changed = await waitForJob(2);
    assert.equal(changed.summary.scanned, 2); assert.equal(changed.summary.registered, 1);
    await rm(chapter, { recursive: true });
    const removed = await waitForJob(3);
    assert.equal(removed.summary.removed, 1); assert.equal(removed.summary.scanned, 2);
  } finally { await s.close(); }
});


test('batched scan progress remains consistent and flushes final and cancelled items', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const candidates = 250;
    for (let i = 0; i < candidates; i++) await mkdir(join(s.dataDir, 'contents', 'example', `Work-${i}`), { recursive: true });
    const start = async () => {
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/admin/storage/scan', headers });
      assert.equal(response.statusCode, 202); return response.json().id as string;
    };
    const detail = async (id: string) => (await s.app.inject({ url: `/api/v1/admin/jobs/${id}?limit=100`, headers })).json();
    const id = await start(); let sawProgress = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = await detail(id);
      assert.equal(current.job.summary.scanned, current.total);
      assert.equal(current.job.summary.skipped, current.total);
      if (current.job.status === 'completed') { assert.equal(current.total, candidates); break; }
      if (current.total > 0) sawProgress = true;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await detail(id)).job.status, 'completed'); assert.ok(sawProgress);
    const cancelledId = await start();
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = await detail(cancelledId);
      if (current.total > 0) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const cancelled = await s.app.inject({ method: 'POST', url: `/api/v1/admin/jobs/${cancelledId}/cancel`, headers });
    assert.equal(cancelled.json().status, 'cancelled');
    const current = await detail(cancelledId);
    assert.equal(current.job.summary.scanned, current.total); assert.equal(current.job.summary.skipped, current.total);
    assert.ok(current.total > 0 && current.total < candidates);
    const allItems = [];
    for (let offset = 0; offset < current.total; offset += 100) {
      allItems.push(...(await s.app.inject({ url: `/api/v1/admin/jobs/${cancelledId}?offset=${offset}&limit=100`, headers })).json().items);
    }
    assert.equal(allItems.length, current.total);
    assert.equal(new Set(allItems.map(item => item.path)).size, current.total);
  } finally { await s.close(); }
});


test('failed scans flush pending result items before persisting their final status', async t => {
  const s = await setup();
  try {
    const headers = await s.admin();
    await mkdir(join(s.dataDir, 'contents', 'a', 'Missing metadata'), { recursive: true });
    const unreadable = join(s.dataDir, 'contents', 'b'); await mkdir(unreadable);
    const original = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (...args: Parameters<typeof fs.promises.readdir>) => {
      if (String(args[0]) === unreadable) throw new Error('Injected directory listing failure');
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const started = await s.app.inject({ method: 'POST', url: '/api/v1/admin/storage/scan', headers });
      assert.equal(started.statusCode, 202);
      let detail;
      for (let i = 0; i < 100; i++) {
        detail = (await s.app.inject({ url: `/api/v1/admin/jobs/${started.json().id}`, headers })).json();
        if (detail.job.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(detail.job.status, 'failed'); assert.match(detail.job.error, /Injected directory listing failure/);
      assert.equal(detail.total, 1); assert.equal(detail.items.length, 1);
      assert.equal(detail.job.summary.scanned, 1); assert.equal(detail.job.summary.skipped, 1);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  } finally { await s.close(); }
});

test('admin user-state telemetry, manual compact, retention config, and workspace epoch reset preserve catalog and migrations', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'admin-user-state-'));
  const dataDir = join(root, 'server');
  let clock = Date.now();
  const app = await buildApp({
    dataDir,
    userStateMaintenance: {
      now: () => clock,
      compactionIntervalMs: 0,
      supersededGraceMs: 1_000,
      operationBodyRetentionMs: 1_000,
      operationFingerprintRetentionMs: 2_000,
      tombstoneGraceMs: 5_000,
    },
  });
  try {
    const admin = await consoleHeaders(app, dataDir);
    const device = await deviceHeaders(app, 'Admin-Test-Device');
    const jsAsset = await app.inject('/admin/admin.js');
    assert.equal(jsAsset.statusCode, 200);
    assert.match(jsAsset.headers['content-type'] as string, /text\/javascript/);

    // Auth boundaries on admin user-state endpoints.
    for (const [method, url, payload] of [
      ['GET', '/api/v1/admin/user-state', undefined],
      ['POST', '/api/v1/admin/user-state/compact', {}],
      ['POST', '/api/v1/admin/user-state/reset', {}],
      ['PATCH', '/api/v1/admin/user-state/retention', { tombstoneGc: { graceDays: 10 } }],
    ] as const) {
      assert.equal((await app.inject({ method, url, payload })).statusCode, 401);
      assert.equal((await app.inject({ method, url, payload, headers: device })).statusCode, 403);
    }

    const ws = (await app.inject({ url: '/api/v1/user-state', headers: device })).json();
    const scope = { workspaceId: ws.workspaceId, epoch: ws.epoch };
    const work = { pluginId: 'example-source', sourceNovelId: 'n1', novelPath: '/n1', name: 'N1' };

    // Create records across all 7 kinds (including active and tombstones) + superseded change + alias.
    const merge1 = (await app.inject({
      method: 'POST',
      url: '/api/v1/user-state/merge',
      headers: device,
      payload: {
        ...scope,
        operations: [
          { operationId: 'op-lib-1', entity: { kind: 'library', work }, baseRevision: 0, value: { inLibrary: true, addedAt: 100 } },
          { operationId: 'op-read-1', entity: { kind: 'reading', work, chapter: { chapterPath: '/c1' } }, baseRevision: 0, value: { progress: 50, unread: false, readAt: 100 } },
          { operationId: 'op-read-tomb', entity: { kind: 'reading', work, chapter: { chapterPath: '/c2' } }, baseRevision: 0, value: { progress: 0, unread: true, readAt: null } },
          { operationId: 'op-bm-tomb', entity: { kind: 'bookmark', work, chapter: { chapterPath: '/c1' } }, baseRevision: 0, value: { bookmarked: false } },
          { operationId: 'op-cat-1', entity: { kind: 'category', categoryId: 'cat-1' }, baseRevision: 0, value: { name: 'Shelf', sort: 1, deleted: false } },
          { operationId: 'op-cat-alias', entity: { kind: 'category', categoryId: 'cat-alias' }, baseRevision: 0, value: { name: 'Shelf', sort: 2, deleted: false } },
          { operationId: 'op-mem-1', entity: { kind: 'membership', work, categoryId: 'cat-1' }, baseRevision: 0, value: { included: true } },
          { operationId: 'op-res-1', entity: { kind: 'resume', work }, baseRevision: 0, value: { chapter: null, anchor: null, openedAt: null } },
          { operationId: 'op-comp-1', entity: { kind: 'composition', work }, baseRevision: 0, value: { composition: { version: 1, updatedAt: 1, entries: [] } } },
        ],
      },
    })).json();
    assert.equal(merge1.headRevision, 8);
    // Supersede library entry.
    await app.inject({
      method: 'POST',
      url: '/api/v1/user-state/merge',
      headers: device,
      payload: {
        ...scope,
        operations: [
          { operationId: 'op-lib-2', entity: { kind: 'library', work }, baseRevision: 1, value: { inLibrary: false, addedAt: null } },
        ],
      },
    });

    clock += 3_000;
    const statsRes = await app.inject({ url: '/api/v1/admin/user-state', headers: admin });
    assert.equal(statsRes.statusCode, 200, statsRes.body);
    const stats = statsRes.json();
    assert.equal(stats.workspaceId, ws.workspaceId);
    assert.equal(stats.epoch, ws.epoch);
    assert.equal(stats.headRevision, 9);
    assert.equal(stats.compactedThrough, 0);
    assert.equal(stats.seedAllowed, true);
    assert.equal(stats.seedCutoffAt, null);
    assert.equal(stats.autoVacuum, 2);
    assert.equal(stats.tables.length, 5);
    assert.ok(stats.tables.every((t: { bytes: number; rows: number }) => typeof t.bytes === 'number' && typeof t.rows === 'number'));
    assert.equal(stats.records.total, 8);
    assert.equal(stats.records.active, 4); // reading(c1), category(cat-1), membership, composition
    assert.equal(stats.records.tombstones, 4); // reading(c2), bookmark, library(false), resume(null)
    assert.equal(stats.records.byKind.reading.active, 1);
    assert.equal(stats.records.byKind.reading.tombstones, 1);
    assert.equal(stats.records.byKind.library.tombstones, 1);
    assert.equal(stats.records.byKind.bookmark.tombstones, 1);
    assert.equal(stats.records.byKind.resume.tombstones, 1);
    assert.equal(stats.records.byKind.category.active, 1);
    assert.equal(stats.records.byKind.membership.active, 1);
    assert.equal(stats.records.byKind.composition.active, 1);
    assert.equal(stats.changes.superseded, 1);
    assert.equal(stats.changes.compactable, 1);
    assert.equal(stats.operations.prunableBodies, 10);
    assert.equal(stats.operations.prunableFingerprints, 10);
    assert.equal(stats.categoryAliases.total, 1);
    assert.equal(stats.retention.pruneNonLibraryReading.enabled, false);
    assert.equal(stats.retention.stripReadingTimestamps.enabled, false);
    assert.equal(stats.retention.slidingWindow.enabled, false);
    assert.equal(stats.retention.tombstoneGc.graceDays, 30);

    // Retention validation & persistence.
    for (const invalid of [
      {},
      { unknown: 1 },
      { pruneNonLibraryReading: {} },
      { pruneNonLibraryReading: { unknown: 1 } },
      { pruneNonLibraryReading: { days: 0 } },
      { slidingWindow: { months: 0 } },
      { tombstoneGc: { graceDays: -1 } },
    ]) {
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/admin/user-state/retention', headers: admin, payload: invalid })).statusCode, 400);
    }
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/user-state/retention',
      headers: admin,
      payload: { slidingWindow: { enabled: true, months: 6 } },
    });
    assert.equal(patchRes.statusCode, 200, patchRes.body);
    assert.equal(patchRes.json().retention.slidingWindow.enabled, true);
    assert.equal(patchRes.json().retention.slidingWindow.months, 6);
    assert.ok(typeof patchRes.json().state.seedCutoffAt === 'number');

    // Manual compact + full vacuum zeroes freelistPages & walBytes.
    const compactRes = await app.inject({ method: 'POST', url: '/api/v1/admin/user-state/compact', headers: admin, payload: {} });
    assert.equal(compactRes.statusCode, 200, compactRes.body);
    assert.equal(compactRes.json().state.freelistPages, 0);
    assert.equal(compactRes.json().state.walBytes, 0);

    // Insert non-user-state witnesses (reading_state_entries, admin_settings, work_migration_lineage) to verify reset preserves them.
    const { openDatabase } = await import('../src/db.ts');
    const db = openDatabase(dataDir);
    try {
      db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('p1', 'k1', '{"progress":10}');
      db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run('witness', '"keep"');
    } finally { db.close(); }

    const resetRes = await app.inject({ method: 'POST', url: '/api/v1/admin/user-state/reset', headers: admin });
    assert.equal(resetRes.statusCode, 200, resetRes.body);
    const resetBody = resetRes.json();
    assert.equal(resetBody.reset, true);
    assert.equal(resetBody.previousEpoch, ws.epoch);
    assert.notEqual(resetBody.state.epoch, ws.epoch);
    assert.equal(resetBody.state.workspaceId, ws.workspaceId);
    assert.equal(resetBody.state.headRevision, 0);
    assert.equal(resetBody.state.compactedThrough, 0);
    assert.equal(resetBody.state.seedAllowed, true);
    assert.equal(resetBody.state.seedCutoffAt, null);
    assert.equal(resetBody.state.records.total, 0);
    assert.equal(resetBody.state.changes.total, 0);
    assert.equal(resetBody.state.operations.total, 0);
    assert.equal(resetBody.state.categoryAliases.total, 0);

    // Old epoch client gets 409.
    assert.equal((await app.inject({
      method: 'POST',
      url: '/api/v1/user-state/read',
      headers: device,
      payload: { ...scope, after: 0 },
    })).statusCode, 409);

    // Restart preserves headRevision === 0 and non-user-state tables.
    await app.close();
    const restarted = await buildApp({ dataDir });
    try {
      const wsAfterRestart = (await restarted.inject({ url: '/api/v1/user-state', headers: device })).json();
      assert.equal(wsAfterRestart.epoch, resetBody.state.epoch);
      assert.equal(wsAfterRestart.headRevision, 0);
      const verifyDb = openDatabase(dataDir);
      try {
        assert.equal(verifyDb.prepare('SELECT COUNT(*) AS n FROM reading_state_entries').get()?.n, 1);
        assert.equal(verifyDb.prepare('SELECT value FROM admin_settings WHERE key=?').get('witness')?.value, '"keep"');
      } finally { verifyDb.close(); }
    } finally { await restarted.close(); }
  } finally {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
