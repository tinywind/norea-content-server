import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { saveWork } from '../src/works.ts';
import { deviceHeaders } from './access.ts';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function archive(files: Record<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, value] of Object.entries(files)) zip.addBuffer(value, name, { compress: false });
  zip.end(); const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'inventory-'));
  const db = openDatabase(dataDir);
  saveWork(db, dataDir, { schemaVersion: 1, identity: { pluginId: 'source', novelId: 'work', novelPath: '/work' }, novel: { name: 'Work', cover: null, author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false }, cover: null });
  const app = await buildApp({ dataDir, anonymousRead: false });
  const headers = await deviceHeaders(app);
  const upload = async (files: Record<string, Buffer>) => {
    const metadata = { packageVersion: 1, layout: 'chapter-files', identity: { pluginId: 'source', novelId: 'work', novelPath: '/work', chapterPath: '/chapter/1' }, novel: { name: 'Work', isLocal: false }, chapter: { name: 'First', position: 1, chapterNumber: '1', contentType: 'html', page: '1' }, bodyPath: 'content.html', files: Object.entries(files).map(([path, value]) => ({ path, size: value.length, modifiedAt: 1 })) };
    const form = new FormData(); form.append('metadata', JSON.stringify(metadata));
    for (const [path, value] of Object.entries(files)) form.append(path, new Blob([new Uint8Array(value)]), path);
    const request = new Request('http://localhost', { method: 'POST', body: form });
    const response = await app.inject({ method: 'POST', url: '/api/v1/chapter-files?conflictPolicy=replace-server', headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  return { app, db, dataDir, headers, upload, close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true }); } };
}

test('inventory hashes actual partial media and excludes corrupt entries', async () => {
  const f = await fixture();
  try {
    const good = Buffer.from('healthy'); const bad = Buffer.from('damaged');
    const zip = await archive({ 'good.png': good, 'bad.png': bad }); zip[zip.indexOf(bad)] ^= 1;
    const body = Buffer.from('chapter');
    const manifest = { version: 1, complete: false, updatedAt: 1, media: { files: ['good.png', 'bad.png', 'missing.png'].map(fileName => ({ fileName, path: `media/${fileName}`, sourceUrl: fileName, status: 'remote', bytes: 0, updatedAt: 1 })) } };
    const entry = await f.upload({ 'content.html': body, 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'media.zip': zip });
    const url = `/api/v1/chapters/${entry.id}/storage-inventory?revision=${entry.revision}`;
    assert.equal((await f.app.inject(url)).statusCode, 401);
    const result = await f.app.inject({ url, headers: f.headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { identity: entry.manifest.identity, revision: entry.revision, inventory: { body: { sha256: hash(body), bytes: body.length }, expectedAssetKeys: ['media/bad.png', 'media/good.png', 'media/missing.png'], storedAssets: [{ key: 'media/good.png', sha256: hash(good), bytes: good.length }] } });
    assert.equal((await f.app.inject({ url: url.replace(entry.revision, '0'.repeat(64)), headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ url: `/api/v1/chapters/${'0'.repeat(64)}/storage-inventory?revision=${entry.revision}`, headers: f.headers })).statusCode, 404);
    const row = f.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    for (const malformed of [
      { version: 1, media: { files: [] } },
      { version: 1, complete: false, updatedAt: 1, media: { files: [{ fileName: 'good.png', path: 'media/good.png' }] } },
    ]) {
      const content = JSON.stringify(malformed).padEnd(manifestBytes.length);
      await writeFile(join(f.dataDir, row.directory, 'manifest.json'), content);
      const invalid = await f.app.inject({ url, headers: f.headers });
      assert.equal(invalid.statusCode, 200, invalid.body);
      assert.equal(invalid.json().inventory.expectedAssetKeys, null);
    }
    await writeFile(join(f.dataDir, row.directory, 'manifest.json'), manifestBytes);
    await writeFile(join(f.dataDir, row.directory, 'media.zip'), Buffer.alloc(zip.length));
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 410);
    const presence = url + '&presenceOnly=true';
    const bodyOnly = await f.app.inject({ url: presence, headers: f.headers });
    assert.equal(bodyOnly.statusCode, 200, bodyOnly.body);
    assert.deepEqual(bodyOnly.json().inventory, { body: { sha256: hash(body), bytes: body.length }, expectedAssetKeys: null, storedAssets: [] });
    assert.equal((await f.app.inject(presence)).statusCode, 401);
    await unlink(join(f.dataDir, row.directory, 'manifest.json'));
    await unlink(join(f.dataDir, row.directory, 'media.zip'));
    assert.equal((await f.app.inject({ url: presence, headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 410);
    await writeFile(join(f.dataDir, row.directory, 'media.zip'), zip);
    await unlink(join(f.dataDir, row.directory, 'content.html'));
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 410);
  } finally { await f.close(); }
});

test('inventory reports empty declarations, malformed manifest and deleted copies', async () => {
  const f = await fixture();
  try {
    const manifest = Buffer.from('{"version":1,"complete":true,"updatedAt":1,"media":{"files":[]}}');
    const entry = await f.upload({ 'content.html': Buffer.from('body'), 'manifest.json': manifest });
    const url = `/api/v1/chapters/${entry.id}/storage-inventory?revision=${entry.revision}`;
    assert.deepEqual((await f.app.inject({ url, headers: f.headers })).json().inventory.expectedAssetKeys, []);
    const row = f.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    await writeFile(join(f.dataDir, row.directory, 'manifest.json'), Buffer.alloc(manifest.length, 33));
    const result = await f.app.inject({ url, headers: f.headers });
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().inventory.expectedAssetKeys, null);
    await f.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: f.headers });
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 410);
  } finally { await f.close(); }
});

test('equal partial inventories retain the actual distinct stored keys', async () => {
  const f = await fixture();
  try {
    const body = Buffer.from('same body');
    const names = ['a.png', 'b.png', 'c.png'];
    const manifest = Buffer.from(JSON.stringify({ version: 1, complete: false, updatedAt: 1, media: { files: names.map(fileName => ({ fileName, path: `media/${fileName}`, sourceUrl: fileName, status: 'remote', bytes: 0, updatedAt: 1 })) } }));
    const make = async (selected: string[]) => f.upload({ 'content.html': body, 'manifest.json': manifest, 'media.zip': await archive(Object.fromEntries(selected.map(name => [name, Buffer.from(name)]))) });
    const first = await make(['a.png', 'b.png']);
    const read = async (entry: { id: string; revision: string }) => {
      const result = await f.app.inject({ url: `/api/v1/chapters/${entry.id}/storage-inventory?revision=${entry.revision}`, headers: f.headers });
      assert.equal(result.statusCode, 200, result.body); return result.json().inventory;
    };
    const left = await read(first);
    const right = await read(await make(['b.png', 'c.png']));
    assert.deepEqual(left.body, right.body);
    assert.deepEqual(left.expectedAssetKeys, right.expectedAssetKeys);
    assert.deepEqual(left.storedAssets.map((asset: { key: string }) => asset.key), ['media/a.png', 'media/b.png']);
    assert.deepEqual(right.storedAssets.map((asset: { key: string }) => asset.key), ['media/b.png', 'media/c.png']);
    assert.equal((await read(await f.upload({ 'content.html': body }))).expectedAssetKeys, null);
  } finally { await f.close(); }
});
