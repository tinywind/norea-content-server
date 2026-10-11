import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { digest } from '../src/packages.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

async function setup() {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'administration-'));
  const dataDir = join(root, 'server');
  const original = join(root, 'original');
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

test('folder scan registers an archived ZIP without plugins and detaching preserves originals and server content', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    assert.deepEqual((await s.app.inject({ url: '/api/v1/admin/plugins', headers })).json(), { items: [] });
    const body = '<p>Archived chapter</p>';
    const manifest = { packageVersion: 1, identity: { pluginId: 'removed-source', novelPath: '/gone', chapterPath: '/first' },
      novel: { name: 'Removed work', isLocal: false }, chapter: { name: 'First', position: 1, contentType: 'html', page: '1' },
      bodyPath: 'content.html', files: [{ path: 'content.html', size: Buffer.byteLength(body), sha256: digest(body) }] };
    const zip = new ZipFile(); zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json'); zip.addBuffer(Buffer.from(body), 'content.html'); zip.end();
    const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const source = join(s.original, 'contents/removed-source/Removed/1-First'); await mkdir(source, { recursive: true });
    await writeFile(join(source, '..', 'novel.json'), JSON.stringify({ schemaVersion: 1, identity: { pluginId: 'removed-source', novelPath: '/gone' }, novel: { ...manifest.novel, author: null, artist: null, cover: null, summary: null, status: null, rating: null, genres: null }, cover: null }));
    const archive = join(source, 'archived.zip'); await writeFile(archive, bytes);
    const registered = await s.app.inject({ method: 'POST', url: '/api/v1/admin/roots', headers, payload: { name: 'Existing library', path: s.original, mode: 'manual', intervalMinutes: 15 } });
    assert.equal(registered.statusCode, 200, registered.body);
    const root = registered.json();
    const started = await s.app.inject({ method: 'POST', url: `/api/v1/admin/roots/${root.id}/scan`, headers });
    assert.equal(started.statusCode, 202, started.body);
    let detail;
    for (let i = 0; i < 100; i++) {
      detail = (await s.app.inject({ url: `/api/v1/admin/jobs/${started.json().id}`, headers })).json();
      if (detail.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(detail.job.status, 'completed');
    assert.equal(detail.job.summary.registered, 2);
    const chapterId = detail.items.find((item: { chapterId?: string }) => item.chapterId).chapterId;
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/admin/roots/${root.id}`, headers })).statusCode, 204);
    assert.equal(await readFile(join(s.original, 'untouched.txt'), 'utf8'), 'Original stays unchanged');
    assert.deepEqual(await readFile(archive), bytes);
    assert.equal((await s.app.inject(`/api/v1/chapters/${chapterId}/package`)).statusCode, 200);
    assert.equal((await s.app.inject({ url: `/api/v1/admin/jobs/${started.json().id}`, headers })).json().job.status, 'completed');
  } finally { await s.close(); }
});

test('server and source paths cannot overlap; root mutation inputs are strict', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    for (const path of [s.dataDir, s.root]) {
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/admin/roots', headers, payload: { name: 'Unsafe', path, mode: 'manual', intervalMinutes: 15 } });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/admin/roots', headers, payload: { name: 'Bad', path: s.original, mode: 'periodic', intervalMinutes: 0 } })).statusCode, 400);
  } finally { await s.close(); }
});

test('access policy survives restart and protects anonymous reads immediately', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const update = await s.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers, payload: { anonymousRead: false } });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal((await s.app.inject('/api/v1/chapters')).statusCode, 401);
    await s.app.close();
    const restarted = await buildApp({ dataDir: s.dataDir });
    try { assert.equal((await restarted.inject('/api/v1/capabilities')).json().anonymousRead, false); }
    finally { await restarted.close(); }
  } finally { await s.close(); }
});

test('console HTML has a strict local-only content policy and catalog supports empty search', async () => {
  const s = await setup();
  try {
    const response = await s.app.inject('/admin/');
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-security-policy'] as string, /default-src 'self'/);
    const result = await s.app.inject({ url: '/api/v1/admin/chapters?search=&deleted=false', headers: await s.admin() });
    assert.deepEqual(result.json(), { items: [], total: 0 });
  } finally { await s.close(); }
});
test('automatic roots queue behind each other instead of dropping simultaneous scans', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    for (let i = 0; i < 3; i++) {
      const path = join(s.root, `source-${i}`);
      await mkdir(join(path, 'contents'), { recursive: true });
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/admin/roots', headers, payload: { name: `Source ${i}`, path, mode: 'periodic', intervalMinutes: 15 } });
      assert.equal(response.statusCode, 200, response.body);
    }
    let jobs: { status: string; rootId: string }[] = [];
    for (let i = 0; i < 100; i++) {
      jobs = (await s.app.inject({ url: '/api/v1/admin/jobs', headers })).json().items;
      if (jobs.length === 3 && jobs.every(job => job.status === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(new Set(jobs.map(job => job.rootId)).size, 3);
    assert.ok(jobs.every(job => job.status === 'completed'));
  } finally { await s.close(); }
});

test('startup removes abandoned importer snapshots but preserves unrelated staging files', async () => {
  const s = await setup();
  try {
    await s.app.close();
    const abandoned = join(s.dataDir, 'staging', 'folder-ABC123');
    const unrelated = join(s.dataDir, 'staging', 'keep-me');
    await mkdir(abandoned, { recursive: true }); await mkdir(unrelated, { recursive: true });
    await writeFile(join(abandoned, 'metadata.sqlite'), 'Private snapshot');
    await writeFile(join(unrelated, 'keep.txt'), 'Keep');
    const app = await buildApp({ dataDir: s.dataDir });
    try {
      await assert.rejects(readFile(join(abandoned, 'metadata.sqlite')), /ENOENT/);
      assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'Keep');
    } finally { await app.close(); }
  } finally { await s.close(); }
});

test('change-driven folder watching schedules a new durable scan after a filesystem change', async () => {
  const s = await setup();
  try {
    const headers = await s.admin();
    const response = await s.app.inject({ method: 'POST', url: '/api/v1/admin/roots', headers, payload: { name: 'Watched source', path: s.original, mode: 'changes', intervalMinutes: 15 } });
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
