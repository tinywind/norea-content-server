import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { digest, type PackageManifest } from '../src/packages.ts';
import { deviceHeaders } from './access.ts';

const identity = { pluginId: 'lookup-fixture', novelId: 'book', novelPath: '/book' };
const id = digest(JSON.stringify([identity.pluginId, identity.novelPath]));
async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/catalog-server-first-'));
  const app = await buildApp({ dataDir, anonymousRead: false });
  const headers = await deviceHeaders(app);
  const metadata = { schemaVersion: 1, identity, novel: { name: 'Synthetic lookup', isLocal: false }, cover: null, chapters: { '1': 'Stored chapter', '2': 'Metadata only' } };
  const work = await app.inject({ method: 'PUT', url: '/api/v1/works/' + id, headers, payload: metadata });
  assert.equal(work.statusCode, 200, work.body);
  const lookup = (chapterPath: string, number: string, includeUnavailable = false) =>
    '/api/v1/catalog/chapter?' + new URLSearchParams({ pluginId: identity.pluginId, novelPath: identity.novelPath, chapterPath, chapterNumber: number, ...(includeUnavailable ? { includeUnavailable: 'true' } : {}) });
  const upload = async (incomplete: boolean) => {
    const files = { 'content.html': Buffer.from('<p>Synthetic body</p>'), 'manifest.json': Buffer.from(JSON.stringify({ version: 1, complete: !incomplete, media: { files: incomplete ? [{ fileName: 'page.png', path: '', status: 'missing' }] : [] } })) };
    const manifest: PackageManifest = { packageVersion: 1, layout: 'chapter-files', identity: { ...identity, chapterPath: '/chapter/1' }, novel: { name: 'Synthetic lookup', isLocal: false },
      chapter: { name: 'Stored chapter', position: 1, chapterNumber: '1', contentType: 'html', page: '1' }, bodyPath: 'content.html',
      files: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, modifiedAt: 1 })) };
    const form = new FormData(); form.append('metadata', JSON.stringify(manifest));
    for (const [path, bytes] of Object.entries(files)) form.append(path, new Blob([bytes]), path);
    const request = new Request('http://fixture', { method: 'POST', body: form });
    const response = await app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  return { app, headers, dataDir, lookup, upload, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('a saved chapter title with no body package is an exact catalog miss', async () => {
  const f = await fixture();
  try {
    for (const includeUnavailable of [false, true]) {
      const response = await f.app.inject({ url: f.lookup('/chapter/2', '2', includeUnavailable), headers: f.headers });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().message, 'Chapter not found');
    }
    const work = await f.app.inject({ url: '/api/v1/works/' + id, headers: f.headers });
    assert.equal(work.json().metadata.chapters['2'], 'Metadata only');
  } finally { await f.close(); }
});

test('a manifest with a missing physical body returns catalog 404, while transfer failure remains a transfer error', async () => {
  const f = await fixture();
  try {
    const entry = await f.upload(false);
    assert.equal((await f.app.inject({ url: f.lookup('/chapter/1', '1'), headers: f.headers })).statusCode, 200);
    const folder = join(f.dataDir, 'contents/lookup-fixture/book/1');
    await unlink(join(folder, 'content.html'));
    assert.ok((await readFile(join(folder, 'manifest.json'))).length > 0);
    const response = await f.app.inject({ url: f.lookup('/chapter/1', '1'), headers: f.headers });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().message, 'Chapter files are unavailable');
    const saved = await f.app.inject({ url: f.lookup('/chapter/1', '1', true), headers: f.headers });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().deleted, false);
    const transfer = await f.app.inject({ url: '/api/v1/chapters/' + entry.id + '/files?revision=' + entry.revision + '&path=content.html', headers: f.headers });
    assert.equal(transfer.statusCode, 410, transfer.body);
  } finally { await f.close(); }
});

test('a present body with incomplete media remains downloadable from the content server', async () => {
  const f = await fixture();
  try {
    const entry = await f.upload(true);
    const response = await f.app.inject({ url: f.lookup('/chapter/1', '1'), headers: f.headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().id, entry.id);
    assert.equal(response.json().complete, false);
  } finally { await f.close(); }
});

test('storage I/O and authorization failures are never reported as chapter absence', async () => {
  const f = await fixture();
  const original = fs.lstatSync;
  try {
    await f.upload(false);
    const url = f.lookup('/chapter/1', '1');
    assert.equal((await f.app.inject(url)).statusCode, 401);
    fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === join(f.dataDir, 'contents/lookup-fixture/book/1/content.html')) throw Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' });
      return original(...args);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    const response = await f.app.inject({ url, headers: f.headers });
    assert.equal(response.statusCode, 500, response.body);
  } finally { fs.lstatSync = original; syncBuiltinESMExports(); await f.close(); }
});
