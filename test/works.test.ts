import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { digest } from '../src/packages.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

export function metadata() {
  return { schemaVersion: 1, identity: { pluginId: 'example', novelPath: '/books/1?lang=ko' },
    novel: { name: 'Book', cover: 'https://example.com/cover.png', author: 'Author', artist: null, summary: 'Summary', status: 'ongoing', genres: 'Fantasy', isLocal: false },
    chapters: [{ path: '/chapter/1?lang=ko', name: 'First', chapterNumber: '1', position: 1, page: '1', contentType: 'html', releaseTime: null, directory: '1-First' }],
    cover: { fileName: 'cover.png', contentType: 'image/png', sourceUrl: 'https://example.com/cover.png' }, updatedAt: 100 };
}
const id = digest(JSON.stringify(['example', '/books/1?lang=ko']));
async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/works-'));
  const app = await buildApp({ dataDir, anonymousRead: false });
  const headers = await deviceHeaders(app);
  return { app, dataDir, headers, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('stores a complete work without chapter packages and transfers authenticated cover bytes', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() });
    assert.equal(response.statusCode, 200, response.body);
    const first = response.json(); assert.equal(first.id, id); assert.equal(first.hasCover, false); assert.deepEqual(first.metadata, metadata());
    assert.equal((await f.app.inject(`/api/v1/works/${id}`)).statusCode, 401);
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const upload = await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}/cover`, headers: { ...f.headers, 'content-type': 'image/png' }, payload: image });
    assert.equal(upload.statusCode, 200, upload.body); assert.equal(upload.json().hasCover, true); assert.ok(upload.json().sequence > first.sequence);
    const downloaded = await f.app.inject({ url: `/api/v1/works/${id}/cover`, headers: f.headers });
    assert.deepEqual(downloaded.rawPayload, image); assert.equal(downloaded.headers['content-type'], 'image/png');
    assert.equal((await f.app.inject(`/api/v1/works/${id}/cover`)).statusCode, 401);
    const catalog = (await f.app.inject({ url: `/api/v1/works?after=${first.sequence}&limit=1`, headers: f.headers })).json();
    assert.equal(catalog.items.length, 1); assert.equal(catalog.items[0].hasCover, true); assert.equal(catalog.hasMore, false);
    const admin = await consoleHeaders(f.app, f.dataDir);
    const listed = (await f.app.inject({ url: '/api/v1/admin/works?search=Book', headers: admin })).json();
    assert.equal(listed.total, 1); assert.equal(listed.items[0].chapterCount, 1); assert.equal(listed.items[0].downloadedChapters, 0);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/overview', headers: admin })).json().works, 1);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/admin/works/${id}/cover`, headers: admin })).rawPayload, image);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/works', headers: f.headers })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: admin, payload: metadata() })).statusCode, 403);
    const unchanged = await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() });
    assert.equal(unchanged.json().sequence, upload.json().sequence);
    const changes = await f.app.inject({ url: '/api/v1/changes?catalogAfter=0&workAfter=0&waitSeconds=0', headers: f.headers });
    assert.equal(changes.statusCode, 200, changes.body); assert.equal(changes.json().workCursor, upload.json().sequence);
  } finally { await f.close(); }
});

test('failed atomic replacement keeps the previous metadata and discards its temporary sibling', async t => {
  const f = await fixture();
  try {
    await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() });
    const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Simulated interrupted replace'); }); syncBuiltinESMExports();
    try {
      const response = await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: { ...metadata(), updatedAt: 200 } });
      assert.equal(response.statusCode, 500);
    } finally { rename.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual((await f.app.inject({ url: `/api/v1/works/${id}`, headers: f.headers })).json().metadata, metadata());
    const source = join(f.dataDir, 'contents', 'example'); const folders = await readdir(source);
    assert.deepEqual(await readdir(join(source, folders[0])), ['novel.json']);
  } finally { await f.close(); }
});

test('oversized cover upload preserves existing bytes and work sequence', async () => {
  const f = await fixture();
  try {
    await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() });
    const headers = { ...f.headers, 'content-type': 'image/png' };
    const first = (await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}/cover`, headers, payload: Buffer.from('image') })).json();
    const response = await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}/cover`, headers, payload: Buffer.alloc(10 * 1024 ** 2 + 1) });
    assert.equal(response.statusCode, 413);
    assert.equal((await f.app.inject({ url: `/api/v1/works/${id}/cover`, headers: f.headers })).body, 'image');
    assert.equal((await f.app.inject({ url: `/api/v1/works/${id}`, headers: f.headers })).json().sequence, first.sequence);
  } finally { await f.close(); }
});

test('work change waits wake on metadata writes and reject cursors ahead of the durable log', async () => {
  const f = await fixture();
  try {
    const pending = f.app.inject({ url: '/api/v1/changes?catalogAfter=0&workAfter=0&waitSeconds=2', headers: f.headers });
    const waiting = pending.then(response => response);
    await new Promise(resolve => setTimeout(resolve, 30));
    const write = await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() });
    const result = await waiting;
    assert.equal(result.statusCode, 200); assert.equal(result.json().workCursor, write.json().sequence);
    assert.equal((await f.app.inject({ url: `/api/v1/changes?workAfter=${write.json().sequence + 1}&waitSeconds=0`, headers: f.headers })).statusCode, 409);
  } finally { await f.close(); }
});

test('rejects unsafe metadata and identity mismatches without replacing a valid document', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() })).statusCode, 200);
    const variants = [
      { ...metadata(), identity: { pluginId: 'other', novelPath: '/' } },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], directory: '../outside' }] },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], directory: 'novel.json' }] },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], directory: 'cover.png' }] },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], directory: 'cover' }] },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], directory: 'a'.repeat(241) }] },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], position: 0.5 }] },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], position: -1 }] },
      { ...metadata(), chapters: [{ ...metadata().chapters[0], page: ' ' }] },
      { ...metadata(), chapters: [...metadata().chapters, { ...metadata().chapters[0] }] },
      { ...metadata(), cover: { ...metadata().cover, fileName: '../cover.png' } },
      { ...metadata(), cover: { ...metadata().cover, fileName: 'cover.json' } },
      { ...metadata(), cover: { ...metadata().cover, fileName: 'cover.PNG' } },
      { ...metadata(), cover: { ...metadata().cover, fileName: 'cover.exe' } },
      { ...metadata(), cover: { ...metadata().cover, sourceUrl: ' ' } },
      { ...metadata(), readingProgress: 8 },
    ];
    for (const payload of variants) assert.equal((await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload })).statusCode, 400);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/works/${id}`, headers: f.headers })).json().metadata, metadata());
  } finally { await f.close(); }
});

test('catalog pages and change hints read the index without rescanning authoritative files', async () => {
  const f = await fixture();
  try {
    const first = (await f.app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() })).json();
    const source = join(f.dataDir, 'contents/example'); const [folder] = await readdir(source); const file = join(source, folder, 'novel.json');
    const updated = { ...metadata(), novel: { ...metadata().novel, name: 'File edited now' }, updatedAt: 500 };
    await writeFile(file, JSON.stringify(updated));
    const changes = (await f.app.inject({ url: `/api/v1/changes?workAfter=${first.sequence}&waitSeconds=0`, headers: f.headers })).json();
    assert.equal(changes.workCursor, first.sequence);
    const list = (await f.app.inject({ url: `/api/v1/works?after=${first.sequence}`, headers: f.headers })).json();
    assert.deepEqual(list, { items: [], cursor: first.sequence, hasMore: false });
    await writeFile(file, '{broken');
    assert.deepEqual((await f.app.inject({ url: '/api/v1/works', headers: f.headers })).json().items[0], first);
    assert.equal((await f.app.inject({ url: `/api/v1/changes?workAfter=${first.sequence}&waitSeconds=0`, headers: f.headers })).json().workCursor, first.sequence);
    const admin = await consoleHeaders(f.app, f.dataDir);
    assert.equal((await f.app.inject({ url: '/api/v1/admin/works', headers: admin })).statusCode, 200);
    assert.equal((await f.app.inject({ url: `/api/v1/works/${id}`, headers: f.headers })).statusCode, 400);
    await writeFile(file, JSON.stringify(updated));
    const refreshed = (await f.app.inject({ url: `/api/v1/works/${id}`, headers: f.headers })).json();
    assert.deepEqual(refreshed.metadata, updated); assert.ok(refreshed.sequence > first.sequence);
    assert.deepEqual((await f.app.inject({ url: `/api/v1/works?after=${first.sequence}`, headers: f.headers })).json().items, [refreshed]);
  } finally { await f.close(); }
});

test('rebuilds the work cache from authoritative files and retains its folder on title changes', async () => {
  const f = await fixture(); let app = f.app;
  try {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: metadata() })).statusCode, 200);
    const source = join(f.dataDir, 'contents', 'example'); const folders = await readdir(source); assert.equal(folders.length, 1);
    const file = join(source, folders[0], 'novel.json'); const updated = { ...metadata(), novel: { ...metadata().novel, name: 'Renamed' }, updatedAt: 200 };
    await writeFile(file, JSON.stringify(updated));
    await app.close(); app = await buildApp({ dataDir: f.dataDir });
    assert.deepEqual((await app.inject({ url: `/api/v1/works/${id}`, headers: f.headers })).json().metadata, updated);
    const afterRebuild = { ...updated, novel: { ...updated.novel, name: 'Again' }, updatedAt: 300 };
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers: f.headers, payload: afterRebuild })).statusCode, 200);
    assert.deepEqual(await readdir(source), folders); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), afterRebuild);
    await app.close(); await rm(join(f.dataDir, 'metadata.sqlite')); app = await buildApp({ dataDir: f.dataDir });
    const headers = await deviceHeaders(app);
    assert.deepEqual((await app.inject({ url: `/api/v1/works/${id}`, headers })).json().metadata, afterRebuild);
  } finally { await app.close(); await rm(f.dataDir, { recursive: true, force: true }); }
});
