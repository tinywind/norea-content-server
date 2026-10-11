import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';
import { DatabaseSync } from 'node:sqlite';

async function setup(anonymousRead = true) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'test-'));
  const app = await buildApp({ dataDir, anonymousRead });
  return { app, dataDir, device: () => deviceHeaders(app), admin: () => consoleHeaders(app, dataDir), close: async () => { await app.close(); await rm(dataDir, { recursive: true }); } };
}

async function archive(body = '<p>Chapter one</p>', change: (manifest: any) => void = () => {}, extra = false) {
  const bytes = Buffer.from(body);
  const manifest = { packageVersion: 1, identity: { pluginId: 'example', novelPath: '/book/one', chapterPath: '/chapter/one' }, novel: { name: 'Example book', isLocal: false }, chapter: { name: 'First chapter', position: 1, contentType: 'html', page: '1' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  change(manifest);
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  zip.addBuffer(bytes, 'content.html');
  if (extra) zip.addBuffer(Buffer.from('extra'), 'undeclared.txt');
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('catalog changes reject old personal cursors, invalid cursors and unavailable future history', async () => {
  const s = await setup(false);
  try {
    const headers = await s.device();
    assert.equal((await s.app.inject('/api/v1/changes?waitSeconds=0')).statusCode, 401);
    for (const query of ['catalogAfter=-1', 'catalogAfter=9007199254740992', 'waitSeconds=21', 'stateAfter=0', 'unexpected=0']) {
      assert.equal((await s.app.inject({ url: `/api/v1/changes?${query}`, headers })).statusCode, 400, query);
    }
    assert.equal((await s.app.inject({ url: '/api/v1/changes?catalogAfter=1&waitSeconds=0', headers })).statusCode, 409);
    assert.deepEqual((await s.app.inject({ url: '/api/v1/changes?waitSeconds=0', headers })).json(), { catalogCursor: 0 });
    const schema = (await s.app.inject('/api/v1/openapi.json')).json();
    assert.deepEqual(schema.paths['/api/v1/changes'].get.parameters.map((parameter: { name: string }) => parameter.name).sort(), ['catalogAfter', 'waitSeconds', 'workAfter']);
    assert.ok(Object.keys(schema.paths).every(path => !/\/state|\/accounts|\/sessions/.test(path)));
  } finally { await s.close(); }
});

test('long polls recheck a blocked device even when anonymous reading is allowed', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const admin = await s.admin();
    const id = (await s.app.inject({ url: '/api/v1/admin/devices', headers: admin })).json().items[0].id;
    const pending = s.app.inject({ url: '/api/v1/changes?waitSeconds=1', headers }).then(response => response);
    await delay(30);
    await s.app.inject({ method: 'PATCH', url: `/api/v1/admin/devices/${id}`, headers: admin, payload: { blocked: true } });
    assert.equal((await pending).statusCode, 403);
    assert.equal((await s.app.inject({ url: '/api/v1/chapters', headers })).statusCode, 403);
    assert.equal((await s.app.inject({ url: '/api/v1/chapters', headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
    assert.equal((await s.app.inject('/api/v1/chapters')).statusCode, 200);
  } finally { await s.close(); }
});

test('long poll timeout reads catalog changes committed by another database connection', async () => {
  const s = await setup();
  const db = new DatabaseSync(join(s.dataDir, 'metadata.sqlite'));
  try {
    const pending = s.app.inject('/api/v1/changes?waitSeconds=1').then(response => response.json());
    await delay(30);
    db.prepare('INSERT INTO catalog_changes(chapter_id,entry) VALUES(?,?)').run('external', '{}');
    assert.deepEqual(await pending, { catalogCursor: 1 });
  } finally { db.close(); await s.close(); }
});

test('catalog publication and deletion wake anonymous long polls', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const pending = s.app.inject('/api/v1/changes?waitSeconds=20').then(response => response.json());
    await delay(20);
    const entry = (await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...headers, 'content-type': 'application/zip' }, payload: await archive() })).json();
    const first = await Promise.race([pending, delay(1000).then(() => { throw new Error('Catalog publish did not wake long poll'); })]);
    assert.deepEqual(first, { catalogCursor: entry.sequence });
    const next = s.app.inject(`/api/v1/changes?catalogAfter=${entry.sequence}&waitSeconds=20`).then(response => response.json());
    await delay(20);
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers });
    const deleted = await Promise.race([next, delay(1000).then(() => { throw new Error('Catalog deletion did not wake long poll'); })]);
    assert.ok(deleted.catalogCursor > first.catalogCursor);
  } finally { await s.close(); }
});

test('long poll timeout reads durable cursors and shutdown releases pending requests', async () => {
  const s = await setup();
  try {
    const start = performance.now();
    const response = await s.app.inject('/api/v1/changes?waitSeconds=1');
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(performance.now() - start >= 900);
    assert.deepEqual(response.json(), { catalogCursor: 0 });
    const pending = s.app.inject('/api/v1/changes?waitSeconds=20').then(response => response);
    await delay(20);
    const closing = s.app.close();
    await Promise.race([closing, delay(1000).then(() => { throw new Error('Shutdown did not release pending long poll'); })]);
    assert.equal((await pending).statusCode, 503);
  } finally { await s.close(); }
});

test('client disconnect cancels long polling and server shutdown does not wait for its timer', async () => {
  const s = await setup();
  try {
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
    let completed = false;
    const request = httpRequest(`${address}/api/v1/changes?waitSeconds=20`, response => { completed = true; response.resume(); });
    request.on('error', () => {});
    request.end();
    await delay(50);
    assert.equal(completed, false);
    request.destroy();
    await delay(30);
    await Promise.race([s.app.close(), delay(1000).then(() => { throw new Error('Disconnected poll blocked shutdown'); })]);
  } finally { await s.close(); }
});

test('complete ZIP publication is idempotent, readable, resumable, and persistent', async () => {
  const s = await setup();
  try {
    const zip = await archive();
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { 'content-type': 'application/zip' }, payload: zip })).statusCode, 401);
    const headers = { ...await s.device(), 'content-type': 'application/zip' };
    const upload = await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers, payload: zip });
    assert.equal(upload.statusCode, 200, upload.body);
    const entry = upload.json();
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers, payload: zip })).json().sequence, entry.sequence);
    const folders = await readdir(join(s.dataDir, 'contents', 'example'));
    assert.deepEqual(folders, ['Example-book-book-one']);
    assert.deepEqual(await readdir(join(s.dataDir, 'contents', 'example', folders[0])), ['1-First-chapter']);
    const download = await s.app.inject({ url: `/api/v1/chapters/${entry.id}/package`, headers: { range: 'bytes=10-29', 'if-range': `"${entry.zipSha256}"` } });
    assert.equal(download.statusCode, 206);
    assert.deepEqual(download.rawPayload, zip.subarray(10, 30));
    assert.equal((await s.app.inject({ url: `/api/v1/chapters/${entry.id}/package`, headers: { range: 'bytes=10-', 'if-range': '"old"' } })).statusCode, 200);
    await s.app.close();
    const reopened = await buildApp({ dataDir: s.dataDir });
    assert.equal((await reopened.inject('/api/v1/chapters')).json().items[0].id, entry.id);
    await reopened.close();
  } finally { await s.close(); }
});

test('invalid, incomplete, unlisted, and unsafe package data never publishes', async () => {
  const s = await setup();
  try {
    const headers = { ...await s.device(), 'content-type': 'application/zip' };
    const bad = [Buffer.from('torn zip'), await archive('body', m => { m.files[0].sha256 = '0'.repeat(64); }), await archive('body', m => { m.files.push({ path: 'media/missing.png', size: 3, sha256: '0'.repeat(64) }); }), await archive('body', () => {}, true), await archive('body', m => { m.bodyPath = '../escape.html'; })];
    for (const payload of bad) assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers, payload })).statusCode, 400);
    assert.deepEqual((await s.app.inject('/api/v1/chapters')).json().items, []);
  } finally { await s.close(); }
});

test('device deletion prevents stale reupload and retains tombstones after purge', async () => {
  const s = await setup();
  try {
    const member = await s.device(); const admin = await s.admin();
    const payload = await archive();
    const send = () => s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...member, 'content-type': 'application/zip' }, payload });
    const entry = (await send()).json();
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: member })).statusCode, 200);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/package`)).statusCode, 410);
    assert.equal((await send()).statusCode, 409);
    assert.equal((await s.app.inject('/api/v1/chapters')).json().items.at(-1).deleted, true);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/purge`, headers: member })).statusCode, 403);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/purge`, headers: admin })).statusCode, 200);
    assert.equal((await send()).statusCode, 409);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: member })).statusCode, 200);
    assert.equal((await send()).statusCode, 200);
  } finally { await s.close(); }
});

test('revisions retain first default until an administrator selects another', async () => {
  const s = await setup();
  try {
    const member = await s.device(); const admin = await s.admin();
    const upload = async (body: string) => (await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...member, 'content-type': 'application/zip' }, payload: await archive(body) })).json();
    const first = await upload('first'); const second = await upload('second');
    assert.notEqual(first.revision, second.revision);
    assert.equal((await s.app.inject('/api/v1/chapters')).json().items[0].revision, first.revision);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${first.id}/revision`, headers: member, payload: { revision: second.revision } })).statusCode, 403);
    const select = await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${first.id}/revision`, headers: admin, payload: { revision: second.revision } });
    assert.equal(select.statusCode, 200, select.body);
    assert.equal((await s.app.inject('/api/v1/chapters')).json().items.at(-1).revision, second.revision);
  } finally { await s.close(); }
});

test('strict package metadata rejects undeclared credential fields and invalid optional values', async () => {
  const s = await setup();
  try {
    const headers = { ...await s.device(), 'content-type': 'application/zip' };
    for (const change of [(m: any) => { m.sourceCookies = 'should not be stored'; }, (m: any) => { m.novel.author = 42; }, (m: any) => { m.identity.novelPath = '\ud800'; }]) {
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers, payload: await archive('body', change) });
      assert.equal(response.statusCode, 400, response.body);
    }
  } finally { await s.close(); }
});

test('ZIP byte, expansion, and file limits reject packages without publishing', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'limits-'));
  try {
    for (const limits of [{ zipBytes: 32 }, { expandedBytes: 32 }, { files: 0 }]) {
      const app = await buildApp({ dataDir, limits });
      try {
        const headers = await deviceHeaders(app);
        const response = await app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...headers, 'content-type': 'application/zip' }, payload: await archive() });
        assert.equal(response.statusCode, 413, response.body);
        assert.deepEqual((await app.inject('/api/v1/chapters')).json().items, []);
      } finally { await app.close(); }
    }
  } finally { await rm(dataDir, { recursive: true }); }
});

test('catalog cursor pages include deletions and schema rejects invalid inputs', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const entry = (await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...headers, 'content-type': 'application/zip' }, payload: await archive() })).json();
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers });
    const first = (await s.app.inject('/api/v1/chapters?limit=1')).json();
    assert.equal(first.hasMore, true); assert.equal(first.items[0].deleted, false);
    const second = (await s.app.inject(`/api/v1/chapters?after=${first.cursor}&limit=1`)).json();
    assert.equal(second.hasMore, false); assert.equal(second.items[0].deleted, true);
    assert.equal((await s.app.inject('/api/v1/chapters?limit=101')).statusCode, 400);
    const schema = (await s.app.inject('/api/v1/openapi.json')).json();
    assert.equal(schema.paths['/api/v1/state'], undefined);
    assert.ok(schema.paths['/api/v1/packages'].post.responses['200']);
  } finally { await s.close(); }
});

test('a disconnected streaming upload stays unpublished and its staging file is removed', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(`${address}/api/v1/packages`, { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' } });
    request.on('error', () => {});
    request.write((await archive()).subarray(0, 100));
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readdir(join(s.dataDir, 'staging')).catch(() => [])).length) break;
      await delay(10);
    }
    assert.equal((await readdir(join(s.dataDir, 'staging'))).length, 1);
    request.destroy();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await readdir(join(s.dataDir, 'staging'))).length) break;
      await delay(10);
    }
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    assert.deepEqual((await s.app.inject('/api/v1/chapters')).json().items, []);
  } finally { await s.close(); }
});

test('chapter HTML cannot claim completeness while referenced assets are missing', async () => {
  const s = await setup();
  try {
    const headers = { ...await s.device(), 'content-type': 'application/zip' };
    for (const body of ['<img src="media/missing.png">', '<img src="https://source.example/image.png">', '<img src="media&#47;missing.png">', '<video poster="media/missing.png"></video>', '<div style="background:url(media/missing.png)">chapter</div>']) {
      const result = await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers, payload: await archive(body) });
      assert.equal(result.statusCode, 400, result.body);
    }
    assert.deepEqual((await s.app.inject('/api/v1/chapters')).json().items, []);
  } finally { await s.close(); }
});

test('a complete HTML chapter with a packaged image publishes and restores from trash', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const body = Buffer.from('<p>Image</p><img src="media/pixel.png">');
    const asset = Buffer.from('owned-test-image-bytes');
    const manifest = { packageVersion: 1, identity: { pluginId: 'example', novelPath: '/images', chapterPath: '/one' }, novel: { name: 'Images', isLocal: true }, chapter: { name: 'One', position: 1, contentType: 'html', page: '1' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }, { path: 'media/pixel.png', size: asset.length, sha256: createHash('sha256').update(asset).digest('hex') }] };
    const zip = new ZipFile(); zip.addBuffer(body, 'content.html'); zip.addBuffer(asset, 'media/pixel.png'); zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json'); zip.end();
    const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const response = await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...headers, 'content-type': 'application/zip' }, payload: bytes });
    assert.equal(response.statusCode, 200, response.body);
    const entry = response.json();
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers });
    const restored = await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers });
    assert.equal(restored.json().deleted, false);
    assert.deepEqual((await s.app.inject(`/api/v1/chapters/${entry.id}/package`)).rawPayload, bytes);
  } finally { await s.close(); }
});
