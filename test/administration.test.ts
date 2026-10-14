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
    const source = join(s.original, 'contents/removed-source/Removed/1-First'); await mkdir(source, { recursive: true });
    await writeFile(join(source, '..', 'novel.json'), JSON.stringify({ schemaVersion: 1, identity: { pluginId: 'removed-source', novelPath: '/gone' }, novel: { name: 'Removed work', isLocal: false, author: null, artist: null, cover: null, summary: null, status: null, rating: null, genres: null }, cover: null }));
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
    const work = join(s.dataDir, 'contents/example/Work'); const chapter = join(work, '1-First');
    await mkdir(chapter, { recursive: true });
    await writeFile(join(work, 'novel.json'), JSON.stringify({ identity: { pluginId: 'example', novelPath: '/work' }, novel: { name: 'Work' } }));
    await writeFile(join(chapter, 'content.html'), '<p>Saved chapter</p>');
    await mkdir(join(work, '2-Unsupported', 'loose-media'), { recursive: true });
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
    for (const page of ['overview', 'plugins', 'storage', 'content', 'jobs', 'devices', 'settings']) {
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
    const work = join(s.dataDir, 'contents/example/Work'); const chapter = join(work, '1-First');
    await mkdir(chapter, { recursive: true });
    await writeFile(join(work, 'novel.json'), JSON.stringify({ schemaVersion: 1, identity: { pluginId: 'example', novelPath: '/work' }, novel: { name: 'Work', author: null, artist: null, cover: null, summary: null, status: null, rating: null, genres: null, isLocal: false }, cover: null }));
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
      await mkdir(join(work, '1-One'), { recursive: true });
      await writeFile(join(work, 'novel.json'), JSON.stringify({ identity: { pluginId: 'example', novelPath: '/' + name }, novel: { name } }));
      await writeFile(join(work, '1-One/content.html'), '<p>Original chapter</p>');
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
    const chapter = join(s.dataDir, 'contents/example/First/1-One');
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
