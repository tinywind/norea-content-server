import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';
import { DatabaseSync } from 'node:sqlite';
import { saveWork } from '../src/works.ts';
import { openDatabase } from '../src/db.ts';

async function setup(anonymousRead = true) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'test-'));
  const db = openDatabase(dataDir);
  saveWork(db, dataDir, { schemaVersion: 1, identity: { pluginId: 'example', novelId: 'one', novelPath: '/book/one' }, novel: { name: 'Example book', cover: null, author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false }, cover: null }); db.close();
  const app = await buildApp({ dataDir, anonymousRead });
  return { app, dataDir, device: () => deviceHeaders(app), admin: () => consoleHeaders(app, dataDir), close: async () => { await app.close(); await rm(dataDir, { recursive: true }); } };
}

const multipartType = 'multipart/form-data; boundary=norea-test';
async function chapterFiles(body = '<p>Chapter one</p>', change: (manifest: any) => void = () => {}) {
  const bytes = Buffer.from(body);
  const manifest = { packageVersion: 1, layout: 'chapter-files', identity: { pluginId: 'example', novelId: 'one', novelPath: '/book/one', chapterPath: '/chapter/one' }, novel: { name: 'Example book', isLocal: false }, chapter: { name: 'First chapter', position: 1, contentType: 'html', page: '1' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: bytes.length, modifiedAt: 1 }] };
  change(manifest);
  return Buffer.concat([
    Buffer.from('--norea-test\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n' + JSON.stringify(manifest) + '\r\n'),
    Buffer.from('--norea-test\r\nContent-Disposition: form-data; name="content.html"; filename="content.html"\r\nContent-Type: application/octet-stream\r\n\r\n'),
    bytes, Buffer.from('\r\n--norea-test--\r\n'),
  ]);
}

test('rejects chapters without exact registered work metadata', async () => {
  const s = await setup();
  try {
    for (const novelPath of ['norea-folder:guessed', '/unregistered']) {
      const payload = await chapterFiles(undefined, manifest => { manifest.identity.novelPath = novelPath; });
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...await s.device(), 'content-type': multipartType }, payload });
      assert.equal(response.statusCode, 409, response.body);
    }
  } finally { await s.close(); }
});

test('change polling requires both current cursors and rejects invalid or future cursors', async () => {
  const s = await setup(false);
  try {
    const headers = await s.device();
    assert.equal((await s.app.inject('/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=0')).statusCode, 401);
    for (const query of ['waitSeconds=0', 'catalogAfter=0&waitSeconds=0', 'workAfter=1&waitSeconds=0', 'catalogAfter=-1&workAfter=1', 'catalogAfter=9007199254740992&workAfter=1', 'catalogAfter=0&workAfter=-1', 'catalogAfter=0&workAfter=9007199254740992', 'catalogAfter=0&workAfter=1&waitSeconds=21', 'catalogAfter=0&workAfter=1&stateAfter=0', 'catalogAfter=0&workAfter=1&unexpected=0']) {
      assert.equal((await s.app.inject({ url: `/api/v1/changes?${query}`, headers })).statusCode, 400, query);
    }
    assert.equal((await s.app.inject({ url: '/api/v1/changes?catalogAfter=1&workAfter=1&waitSeconds=0', headers })).statusCode, 409);
    assert.equal((await s.app.inject({ url: '/api/v1/changes?catalogAfter=0&workAfter=2&waitSeconds=0', headers })).statusCode, 409);
    assert.deepEqual((await s.app.inject({ url: '/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=0', headers })).json(), { catalogCursor: 0, workCursor: 1 });
    const schema = (await s.app.inject('/api/v1/openapi.json')).json();
    assert.deepEqual(schema.paths['/api/v1/changes'].get.parameters.map((parameter: { name: string }) => parameter.name).sort(), ['catalogAfter', 'waitSeconds', 'workAfter']);
    assert.deepEqual(schema.paths['/api/v1/changes'].get.parameters.filter((parameter: { required: boolean }) => parameter.required).map((parameter: { name: string }) => parameter.name).sort(), ['catalogAfter', 'workAfter']);
    assert.ok(Object.keys(schema.paths).every(path => !/\/state|\/accounts|\/sessions/.test(path)));
  } finally { await s.close(); }
});

test('long polls recheck a blocked device even when anonymous reading is allowed', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const admin = await s.admin();
    const id = (await s.app.inject({ url: '/api/v1/admin/devices', headers: admin })).json().items[0].id;
    const pending = s.app.inject({ url: '/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=1', headers }).then(response => response);
    await delay(30);
    await s.app.inject({ method: 'PATCH', url: `/api/v1/admin/devices/${id}`, headers: admin, payload: { blocked: true } });
    assert.equal((await pending).statusCode, 403);
    assert.equal((await s.app.inject({ url: '/api/v1/catalog/changes', headers })).statusCode, 403);
    assert.equal((await s.app.inject({ url: '/api/v1/catalog/changes', headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
    assert.equal((await s.app.inject('/api/v1/catalog/changes')).statusCode, 200);
  } finally { await s.close(); }
});

test('long poll timeout reads catalog changes committed by another database connection', async () => {
  const s = await setup();
  const db = new DatabaseSync(join(s.dataDir, 'metadata.sqlite'));
  try {
    const pending = s.app.inject('/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=1').then(response => response.json());
    await delay(30);
    db.prepare('INSERT INTO catalog_changes(chapter_id,entry) VALUES(?,?)').run('external', '{}');
    assert.deepEqual(await pending, { catalogCursor: 1, workCursor: 1 });
  } finally { db.close(); await s.close(); }
});

test('catalog publication and deletion wake anonymous long polls', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const pending = s.app.inject('/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=20').then(response => response.json());
    await delay(20);
    const entry = (await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...headers, 'content-type': multipartType }, payload: await chapterFiles() })).json();
    const first = await Promise.race([pending, delay(1000).then(() => { throw new Error('Catalog publish did not wake long poll'); })]);
    assert.deepEqual(first, { catalogCursor: entry.sequence, workCursor: 1 });
    const next = s.app.inject(`/api/v1/changes?catalogAfter=${entry.sequence}&workAfter=1&waitSeconds=20`).then(response => response.json());
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
    const response = await s.app.inject('/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=1');
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(performance.now() - start >= 900);
    assert.deepEqual(response.json(), { catalogCursor: 0, workCursor: 1 });
    const pending = s.app.inject('/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=20').then(response => response);
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
    const request = httpRequest(`${address}/api/v1/changes?catalogAfter=0&workAfter=1&waitSeconds=20`, response => { completed = true; response.resume(); });
    request.on('error', () => {});
    request.end();
    await delay(50);
    assert.equal(completed, false);
    request.destroy();
    await delay(30);
    await Promise.race([s.app.close(), delay(1000).then(() => { throw new Error('Disconnected poll blocked shutdown'); })]);
  } finally { await s.close(); }
});

test('device deletion permits a new upload and retains deletion history after purge', async () => {
  const s = await setup();
  try {
    const member = await s.device(); const admin = await s.admin();
    const payload = await chapterFiles();
    const send = () => s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...member, 'content-type': multipartType }, payload });
    const entry = (await send()).json();
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: member })).statusCode, 200);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.html`)).statusCode, 410);
    assert.equal((await s.app.inject('/api/v1/catalog/changes')).json().items.at(-1).deleted, true);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/purge`, headers: member })).statusCode, 403);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/purge`, headers: admin })).statusCode, 200);
    assert.equal((await send()).statusCode, 200);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: member })).statusCode, 200);
    assert.equal((await send()).statusCode, 200);
  } finally { await s.close(); }
});

test('strict chapter metadata rejects undeclared credential fields and invalid optional values', async () => {
  const s = await setup();
  try {
    const headers = { ...await s.device(), 'content-type': multipartType };
    for (const change of [(m: any) => { m.sourceCookies = 'should not be stored'; }, (m: any) => { m.novel.author = 42; }, (m: any) => { m.identity.novelPath = '\ud800'; }]) {
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers, payload: await chapterFiles('body', change) });
      assert.equal(response.statusCode, 400, response.body);
    }
  } finally { await s.close(); }
});

test('catalog cursor pages include deletions and schema rejects invalid inputs', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const entry = (await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...headers, 'content-type': multipartType }, payload: await chapterFiles() })).json();
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers });
    const first = (await s.app.inject('/api/v1/catalog/changes?limit=1')).json();
    assert.equal(first.hasMore, true); assert.equal(first.items[0].deleted, false);
    const second = (await s.app.inject(`/api/v1/catalog/changes?after=${first.cursor}&limit=1`)).json();
    assert.equal(second.hasMore, false); assert.equal(second.items[0].deleted, true);
    assert.equal((await s.app.inject('/api/v1/catalog/changes?limit=101')).statusCode, 400);
    const schema = (await s.app.inject('/api/v1/openapi.json')).json();
    assert.equal(schema.paths['/api/v1/state'], undefined);
    assert.ok(schema.paths['/api/v1/chapter-files'].post.responses['200']);
  } finally { await s.close(); }
});

test('a disconnected streaming upload stays unpublished and its staging file is removed', async () => {
  const s = await setup();
  try {
    const headers = await s.device();
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(`${address}/api/v1/chapter-files`, { method: 'POST', headers: { ...headers, 'content-type': multipartType } });
    request.on('error', () => {});
    request.write((await chapterFiles()).subarray(0, 100));
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
    assert.deepEqual((await s.app.inject('/api/v1/catalog/changes')).json().items, []);
  } finally { await s.close(); }
});

test('current chapter publication is idempotent and survives restart without file conversion', async () => {
  const s = await setup();
  try {
    const payload = await chapterFiles();
    const headers = { ...await s.device(), 'content-type': multipartType };
    const first = await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers, payload });
    assert.equal(first.statusCode, 200, first.body);
    const entry = first.json();
    assert.deepEqual((await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers, payload: await chapterFiles('New body') })).json(), entry);
    const url = '/api/v1/chapters/' + entry.id + '/files?revision=' + entry.revision + '&path=content.html';
    assert.equal((await s.app.inject(url)).body, '<p>Chapter one</p>');
    await s.app.close();
    const reopened = await buildApp({ dataDir: s.dataDir });
    try { assert.equal((await reopened.inject(url)).body, '<p>Chapter one</p>'); }
    finally { await reopened.close(); }
  } finally { await s.close(); }
});

test('chapter size and file count limits reject uploads without publication', async () => {
  const s = await setup();
  try {
    await s.app.close();
    for (const limits of [{ expandedBytes: 3 }, { files: 0 }]) {
      const app = await buildApp({ dataDir: s.dataDir, limits });
      try {
        const response = await app.inject({ method:'POST', url:'/api/v1/chapter-files', headers:{...await deviceHeaders(app),'content-type':multipartType}, payload:await chapterFiles() });
        assert.equal(response.statusCode,413,response.body);
        assert.deepEqual((await app.inject('/api/v1/catalog/changes')).json().items,[]);
      } finally { await app.close(); }
    }
  } finally { await s.close(); }
});
