import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { digest, type CatalogEntry, type PackageManifest } from '../src/packages.ts';
import { rebuildWorkIndex, type NovelMetadataV1 } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const metadata = (): NovelMetadataV1 => ({
  schemaVersion: 1, identity: { pluginId: 'cover-fixture', novelId: 'book', novelPath: '/book' },
  novel: { name: 'Synthetic book', author: 'Current author', artist: null, summary: 'Current summary', status: null, rating: null, genres: null, isLocal: false },
  cover: { fileName: 'cover.png', contentType: 'image/png' }, chapters: { '1': 'First chapter', '2': 'Metadata only' },
});
const id = digest(JSON.stringify(['cover-fixture', '/book']));
const originalCover = Buffer.from('synthetic current cover');
async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/cover-deletion-'));
  const app = await buildApp({ dataDir, anonymousRead: false });
  const headers = await deviceHeaders(app);
  const db = openDatabase(dataDir);
  const folder = join(dataDir, 'contents/cover-fixture/book');
  const putWork = (payload = metadata()) => app.inject({ method: 'PUT', url: '/api/v1/works/' + id, headers, payload });
  const putCover = (payload = originalCover) => app.inject({ method: 'PUT', url: '/api/v1/works/' + id + '/cover', headers: { ...headers, 'content-type': 'image/png' }, payload });
  const snapshot = async () => {
    const response = await app.inject({ url: '/api/v1/works/' + id + '/migration-snapshot', headers });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const clear = (revision: string) => app.inject({ method: 'DELETE', url: '/api/v1/works/' + id + '/cover', headers, payload: { revision } });
  const current = async () => {
    const response = await app.inject({ url: '/api/v1/works/' + id, headers });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const readCover = () => app.inject({ url: '/api/v1/works/' + id + '/cover', headers });
  const body = Buffer.from('<p>Synthetic chapter body</p>');
  assert.equal((await putWork()).statusCode, 200);
  assert.equal((await putCover()).statusCode, 200);
  const manifest: PackageManifest = {
    packageVersion: 1, layout: 'chapter-files', identity: { ...metadata().identity, chapterPath: '/chapter/1' },
    novel: { name: metadata().novel.name, isLocal: false }, chapter: { name: 'First chapter', position: 1, chapterNumber: '1', contentType: 'html', page: '1' },
    bodyPath: 'content.html', files: [{ path: 'content.html', size: body.length, modifiedAt: 1 }],
  };
  const form = new FormData(); form.append('metadata', JSON.stringify(manifest)); form.append('content.html', new Blob([body]), 'content.html');
  const request = new Request('http://fixture', { method: 'POST', body: form });
  const uploaded = await app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  return { app, db, dataDir, folder, headers, body, chapter: uploaded.json<CatalogEntry>(), putWork, putCover, snapshot, clear, current, readCover,
    close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('explicit cover deletion removes every format under the work lock, survives reindex, and preserves chapter bodies and fresh metadata', async () => {
  const f = await fixture();
  const original = fs.renameSync;
  let checkedLock = false;
  try {
    await writeFile(join(f.folder, 'cover.webp'), 'alternate cover');
    await writeFile(join(f.folder, 'cover.gif'), '');
    await writeFile(join(f.folder, 'notes.txt'), 'unrelated user file');
    const before = await f.snapshot();
    assert.deepEqual(before.work.metadata, (await f.current()).metadata);
    assert.equal(before.work.coverSha256, digest(originalCover));
    fs.renameSync = ((from, to) => {
      if (!checkedLock && String(from) === join(f.folder, 'cover.png')) {
        assert.ok(fs.existsSync(join(f.folder, 'novel.json')));
        f.db.exec('PRAGMA busy_timeout=0');
        assert.throws(() => f.db.exec('BEGIN IMMEDIATE'), /locked/);
        checkedLock = true;
      }
      return original(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    const response = await f.clear(before.work.revision);
    fs.renameSync = original; syncBuiltinESMExports();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(checkedLock, true);
    assert.equal(response.json().hasCover, false);
    assert.deepEqual(response.json().metadata, { ...before.work.metadata, cover: null });
    assert.deepEqual((await readdir(f.folder)).sort(), ['1', 'notes.txt', 'novel.json']);
    assert.deepEqual(await readFile(join(f.folder, '1/content.html')), f.body);
    assert.equal(await readFile(join(f.folder, 'notes.txt'), 'utf8'), 'unrelated user file');
    assert.equal((await f.readCover()).statusCode, 404);
    rebuildWorkIndex(f.db, f.dataDir);
    const after = await f.snapshot();
    assert.equal(after.work.coverSha256, null);
    assert.equal(after.work.metadata.cover, null);
    assert.notEqual(after.work.revision, before.work.revision);
    assert.deepEqual(after.chapters, before.chapters);
    const retry = await f.clear(after.work.revision);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().sequence, response.json().sequence);
    assert.deepEqual((await readdir(join(f.folder, '..'))).sort(), ['book']);
  } finally { fs.renameSync = original; syncBuiltinESMExports(); await f.close(); }
});

test('ordinary metadata-only PUT can apply null author without implicitly deleting a stored cover', async () => {
  const f = await fixture();
  try {
    const value = metadata(); value.cover = null; value.novel.author = null;
    const updated = await f.putWork(value);
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().metadata.novel.author, null);
    assert.equal(updated.json().hasCover, true);
    assert.deepEqual((await f.readCover()).rawPayload, originalCover);
    const response = await f.clear((await f.snapshot()).work.revision);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().metadata.novel.author, null);
    assert.equal((await f.readCover()).statusCode, 404);
  } finally { await f.close(); }
});

test('cover removal requires current revision and a registered unblocked device', async () => {
  const f = await fixture();
  try {
    const old = (await f.snapshot()).work.revision;
    const newer = Buffer.from('newer cover');
    assert.equal((await f.putCover(newer)).statusCode, 200);
    assert.equal((await f.clear(old)).statusCode, 409);
    assert.deepEqual((await f.readCover()).rawPayload, newer);
    const revision = (await f.snapshot()).work.revision;
    const url = '/api/v1/works/' + id + '/cover';
    assert.equal((await f.app.inject({ method: 'DELETE', url, payload: { revision } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'DELETE', url, headers: await consoleHeaders(f.app, f.dataDir), payload: { revision } })).statusCode, 403);
    assert.equal((await f.clear('bad')).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/v1/works/' + '0'.repeat(64) + '/cover', headers: f.headers, payload: { revision } })).statusCode, 404);
    f.db.exec('UPDATE devices SET blocked=1');
    assert.equal((await f.clear(revision)).statusCode, 403);
    assert.deepEqual(await readFile(join(f.folder, 'cover.png')), newer);
    assert.deepEqual(await readFile(join(f.folder, '1/content.html')), f.body);
  } finally { await f.close(); }
});

for (const failure of ['metadata-write', 'index-write'] as const) test('cover deletion rolls back exact files and index after ' + failure + ' failure', async () => {
  const f = await fixture();
  const original = fs.renameSync;
  try {
    await writeFile(join(f.folder, 'cover.webp'), 'alternate cover');
    const before = await f.snapshot();
    const metadataBytes = await readFile(join(f.folder, 'novel.json'));
    const row = f.db.prepare('SELECT * FROM works WHERE id=?').get(id);
    const cursor = f.db.prepare('SELECT max(sequence) AS n FROM work_changes').get();
    if (failure === 'metadata-write') {
      fs.renameSync = ((from, to) => {
        if (basename(String(from)).startsWith('.novel.json.') && String(to) === join(f.folder, 'novel.json')) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
        return original(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
    } else f.db.exec("CREATE TRIGGER fail_cover_clear BEFORE UPDATE ON works WHEN json_extract(NEW.entry,'$.hasCover')=0 BEGIN SELECT RAISE(ABORT,'synthetic index failure'); END");
    const response = await f.clear(before.work.revision);
    fs.renameSync = original; syncBuiltinESMExports();
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(await readFile(join(f.folder, 'novel.json')), metadataBytes);
    assert.deepEqual(await readFile(join(f.folder, 'cover.png')), originalCover);
    assert.equal(await readFile(join(f.folder, 'cover.webp'), 'utf8'), 'alternate cover');
    assert.deepEqual(await readFile(join(f.folder, '1/content.html')), f.body);
    assert.deepEqual(f.db.prepare('SELECT * FROM works WHERE id=?').get(id), row);
    assert.deepEqual(f.db.prepare('SELECT max(sequence) AS n FROM work_changes').get(), cursor);
    assert.deepEqual((await readdir(join(f.folder, '..'))).sort(), ['book']);
  } finally { fs.renameSync = original; syncBuiltinESMExports(); await f.close(); }
});

test('cover deletion refuses nonregular cover files without touching other paths', async () => {
  const f = await fixture();
  try {
    const outside = join(f.dataDir, 'outside.png'); await writeFile(outside, 'outside bytes');
    await symlink(outside, join(f.folder, 'cover.webp'));
    const before = await f.snapshot();
    assert.equal((await f.clear(before.work.revision)).statusCode, 400);
    assert.equal(await readFile(outside, 'utf8'), 'outside bytes');
    assert.deepEqual((await f.readCover()).rawPayload, originalCover);
    assert.deepEqual(await readFile(join(f.folder, '1/content.html')), f.body);
  } finally { await f.close(); }
});

test('a cover upload started before explicit clearing cannot overwrite a later selected cover', { timeout: 5000 }, async () => {
  const f = await fixture();
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    const before = await f.snapshot();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const body = Buffer.alloc(128 * 1024, 65);
    f.db.exec('UPDATE devices SET last_seen_at=0');
    let finish!: (result: number | Error) => void;
    const finished = new Promise<number | Error>(done => { finish = done; });
    request = httpRequest(address + '/api/v1/works/' + id + '/cover', { method: 'PUT', headers: { ...f.headers, 'content-type': 'image/png', 'content-length': body.length } }, response => { response.resume(); finish(response.statusCode!); });
    request.on('error', finish);
    request.write(body.subarray(0, 16));
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((f.db.prepare('SELECT last_seen_at AS n FROM devices').get() as { n: number }).n > 0) break;
      await delay(5);
    }
    assert.ok((f.db.prepare('SELECT last_seen_at AS n FROM devices').get() as { n: number }).n > 0);
    assert.equal((await f.clear(before.work.revision)).statusCode, 200);
    const fresh = metadata(); fresh.cover = { fileName: 'cover.webp', contentType: 'image/webp' };
    assert.equal((await f.putWork(fresh)).statusCode, 200);
    const freshBytes = Buffer.from('fresh target cover');
    const uploaded = await f.putCover(freshBytes);
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    request.end(body.subarray(16));
    assert.equal(await finished, 409);
    assert.deepEqual((await f.readCover()).rawPayload, freshBytes);
    assert.equal((await f.current()).sequence, uploaded.json().sequence);
    assert.deepEqual(await readFile(join(f.folder, '1/content.html')), f.body);
  } finally { request?.destroy(); await f.close(); }
});

test('migration snapshot rejects a cover that changes while its metadata revision is being captured', async () => {
  const f = await fixture();
  const original = fs.readFileSync;
  let changed = false;
  try {
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const result = original(...args);
      if (!changed && Buffer.isBuffer(result) && result.equals(originalCover)) {
        changed = true; fs.writeFileSync(join(f.folder, 'cover.png'), 'changed during snapshot');
      }
      return result;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const response = await f.app.inject({ url: '/api/v1/works/' + id + '/migration-snapshot', headers: f.headers });
    assert.equal(changed, true);
    assert.equal(response.statusCode, 409, response.body);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); await f.close(); }
});
