import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { provisionAccount } from '../src/auth.ts';

async function setup(anonymousRead = true) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'test-'));
  const app = await buildApp({ dataDir, anonymousRead });
  await provisionAccount(dataDir, 'admin', 'test-password-admin', 'admin');
  await provisionAccount(dataDir, 'alice', 'test-password-alice', 'member');
  await provisionAccount(dataDir, 'bob', 'test-password-bob', 'member');
  const login = async (username: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username, password: `test-password-${username}`, deviceName: 'test device' } });
    assert.equal(response.statusCode, 200, response.body);
    return { authorization: `Bearer ${response.json().token}` };
  };
  return { app, dataDir, login, close: async () => { await app.close(); await rm(dataDir, { recursive: true }); } };
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

test('anonymous catalog, password login, revocation, and private reading policy', async () => {
  const s = await setup(false);
  try {
    assert.equal((await s.app.inject('/api/v1/capabilities')).json().anonymousRead, false);
    assert.equal((await s.app.inject('/api/v1/chapters')).statusCode, 401);
    const headers = await s.login('alice');
    assert.deepEqual((await s.app.inject({ url: '/api/v1/chapters', headers })).json().items, []);
    assert.equal((await s.app.inject({ method: 'DELETE', url: '/api/v1/sessions/current', headers })).statusCode, 204);
    assert.equal((await s.app.inject({ url: '/api/v1/state', headers })).statusCode, 401);
  } finally { await s.close(); }
});

test('complete ZIP publication is idempotent, readable, resumable, and persistent', async () => {
  const s = await setup();
  try {
    const zip = await archive();
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { 'content-type': 'application/zip' }, payload: zip })).statusCode, 401);
    const headers = { ...await s.login('alice'), 'content-type': 'application/zip' };
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
    const headers = { ...await s.login('alice'), 'content-type': 'application/zip' };
    const bad = [Buffer.from('torn zip'), await archive('body', m => { m.files[0].sha256 = '0'.repeat(64); }), await archive('body', m => { m.files.push({ path: 'media/missing.png', size: 3, sha256: '0'.repeat(64) }); }), await archive('body', () => {}, true), await archive('body', m => { m.bodyPath = '../escape.html'; })];
    for (const payload of bad) assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers, payload })).statusCode, 400);
    assert.deepEqual((await s.app.inject('/api/v1/chapters')).json().items, []);
  } finally { await s.close(); }
});

test('admin deletion prevents stale reupload and retains tombstones after purge', async () => {
  const s = await setup();
  try {
    const member = await s.login('alice'); const admin = await s.login('admin');
    const payload = await archive();
    const send = () => s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...member, 'content-type': 'application/zip' }, payload });
    const entry = (await send()).json();
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: member })).statusCode, 403);
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: admin })).statusCode, 200);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/package`)).statusCode, 410);
    assert.equal((await send()).statusCode, 409);
    assert.equal((await s.app.inject('/api/v1/chapters')).json().items.at(-1).deleted, true);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/purge`, headers: admin })).statusCode, 200);
    assert.equal((await send()).statusCode, 409);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: admin })).statusCode, 200);
    assert.equal((await send()).statusCode, 200);
  } finally { await s.close(); }
});

test('revisions retain first default until an administrator selects another', async () => {
  const s = await setup();
  try {
    const member = await s.login('alice'); const admin = await s.login('admin');
    const upload = async (body: string) => (await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...member, 'content-type': 'application/zip' }, payload: await archive(body) })).json();
    const first = await upload('first'); const second = await upload('second');
    assert.notEqual(first.revision, second.revision);
    assert.equal((await s.app.inject('/api/v1/chapters')).json().items[0].revision, first.revision);
    const select = await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${first.id}/revision`, headers: admin, payload: { revision: second.revision } });
    assert.equal(select.statusCode, 200, select.body);
    assert.equal((await s.app.inject('/api/v1/chapters')).json().items.at(-1).revision, second.revision);
  } finally { await s.close(); }
});

test('state preserves concurrent positions, resolves explicitly, and isolates accounts and retries', async () => {
  const s = await setup();
  try {
    const headers = await s.login('alice'); const bob = await s.login('bob');
    const key = 'position:["example","/book/one",""]';
    const put = (baseVersion: number, operationId: string, value: object) => s.app.inject({ method: 'PUT', url: '/api/v1/state', headers, payload: { key, baseVersion, operationId, deviceName: operationId, value: { chapterPath: '/chapter/one', readAt: null, ...value } } });
    assert.equal((await put(0, 'one', { progress: 0.9 })).statusCode, 200);
    const conflict = await put(0, 'two', { progress: 0.1 });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().conflicts.length, 2);
    assert.equal((await put(0, 'two', { progress: 0.1 })).json().version, conflict.json().version);
    const resolved = await put(conflict.json().version, 'three', { progress: 0.1 });
    assert.equal(resolved.statusCode, 200); assert.deepEqual(resolved.json().conflicts, []);
    assert.deepEqual((await s.app.inject({ url: '/api/v1/state', headers: bob })).json().items, []);
  } finally { await s.close(); }
});

test('concurrent membership removals win but subsequent additions succeed', async () => {
  const s = await setup();
  try {
    const headers = await s.login('alice');
    const put = (baseVersion: number, operationId: string, deleted: boolean) => s.app.inject({ method: 'PUT', url: '/api/v1/state', headers, payload: { key: 'library:["example","/book/one",""]', baseVersion, operationId, deviceName: 'phone', value: { deleted } } });
    await put(0, 'add', false);
    const removed = await put(0, 'remove', true);
    assert.equal(removed.json().value.deleted, true);
    const stale = await put(0, 'stale-add', false);
    assert.equal(stale.json().value.deleted, true);
    assert.equal((await put(stale.json().version, 'explicit-add', false)).json().value.deleted, false);
  } finally { await s.close(); }
});

test('strict package metadata rejects undeclared credential fields and invalid optional values', async () => {
  const s = await setup();
  try {
    const headers = { ...await s.login('alice'), 'content-type': 'application/zip' };
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
    await provisionAccount(dataDir, 'alice', 'test-password-alice', 'member');
    for (const limits of [{ zipBytes: 32 }, { expandedBytes: 32 }, { files: 0 }]) {
      const app = await buildApp({ dataDir, limits });
      try {
        const session = await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { username: 'alice', password: 'test-password-alice', deviceName: 'limits test' } });
        const response = await app.inject({ method: 'POST', url: '/api/v1/packages', headers: { authorization: `Bearer ${session.json().token}`, 'content-type': 'application/zip' }, payload: await archive() });
        assert.equal(response.statusCode, 413, response.body);
        assert.deepEqual((await app.inject('/api/v1/chapters')).json().items, []);
      } finally { await app.close(); }
    }
  } finally { await rm(dataDir, { recursive: true }); }
});

test('catalog cursor pages include deletions and schema rejects invalid inputs', async () => {
  const s = await setup();
  try {
    const headers = await s.login('admin');
    const entry = (await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...headers, 'content-type': 'application/zip' }, payload: await archive() })).json();
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers });
    const first = (await s.app.inject('/api/v1/chapters?limit=1')).json();
    assert.equal(first.hasMore, true); assert.equal(first.items[0].deleted, false);
    const second = (await s.app.inject(`/api/v1/chapters?after=${first.cursor}&limit=1`)).json();
    assert.equal(second.hasMore, false); assert.equal(second.items[0].deleted, true);
    assert.equal((await s.app.inject('/api/v1/chapters?limit=101')).statusCode, 400);
    const schema = (await s.app.inject('/api/v1/openapi.json')).json();
    assert.ok(schema.paths['/api/v1/state'].put.requestBody);
    assert.ok(schema.paths['/api/v1/packages'].post.responses['200']);
  } finally { await s.close(); }
});

test('password reset revokes sessions and members cannot provision accounts', async () => {
  const s = await setup();
  try {
    const member = await s.login('alice'); const admin = await s.login('admin');
    const payload = { username: 'alice', password: 'changed-test-password', role: 'member' };
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/accounts', headers: member, payload })).statusCode, 403);
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/v1/accounts', headers: admin, payload })).statusCode, 200);
    assert.equal((await s.app.inject({ url: '/api/v1/state', headers: member })).statusCode, 401);
    assert.equal((await s.app.inject({ url: '/api/v1/state', headers: admin })).statusCode, 200);
  } finally { await s.close(); }
});

test('stale automatic read updates preserve unread candidate and changed retry payload is rejected', async () => {
  const s = await setup();
  try {
    const headers = await s.login('alice');
    const payload = { key: 'read:["example","/book/one","/chapter/one"]', baseVersion: 0, operationId: 'unread', deviceName: 'phone', value: { unread: true, progress: 0 } };
    assert.equal((await s.app.inject({ method: 'PUT', url: '/api/v1/state', headers, payload })).statusCode, 200);
    const conflict = await s.app.inject({ method: 'PUT', url: '/api/v1/state', headers, payload: { ...payload, operationId: 'automatic-read', value: { unread: false, progress: 1 } } });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().value.unread, true);
    assert.equal(conflict.json().conflicts.length, 2);
    assert.equal((await s.app.inject({ method: 'PUT', url: '/api/v1/state', headers, payload: { ...payload, value: { unread: false, progress: 0 } } })).statusCode, 409);
  } finally { await s.close(); }
});

test('invalid state identities and values return 400 without changing state or consuming operation IDs', async () => {
  const s = await setup();
  try {
    const headers = await s.login('alice');
    const valid = { key: 'position:["example","/book",""]', value: { chapterPath: '/one', progress: 50, readAt: null }, baseVersion: 0, operationId: 'validation', deviceName: 'phone' };
    const invalid = [
      { key: 'position:not-json' }, { key: 'position:["example","/book"]' }, { key: 'position:["example","/book","/one"]' },
      { key: 'position:["example",1,""]' }, { key: 'position:["","/book",""]' }, { key: 'position:["example", "/book", ""]' },
      { value: {} }, { value: { ...valid.value, chapterPath: 1 } }, { value: { ...valid.value, chapterPath: '' } },
      { value: { ...valid.value, progress: -1 } }, { value: { ...valid.value, progress: 101 } }, { value: { ...valid.value, progress: '50' } },
      { value: { ...valid.value, readAt: -1 } }, { value: { ...valid.value, readAt: 'today' } }, { value: { ...valid.value, locator: {} } },
      { value: { ...valid.value, secret: 'extra' } },
      { key: 'read:["example","/book",""]', value: { unread: true, progress: 0 } },
      { key: 'read:["example","/book","/one"]', value: { unread: 'false', progress: 0 } },
      { key: 'read:["example","/book","/one"]', value: { unread: true } },
      { key: 'read:["example","/book","/one"]', value: { unread: true, progress: null } },
      { key: 'library:["example","/book",""]', value: { deleted: 'false' } },
      { key: 'library:["example","/book",""]', value: { deleted: false, progress: 0 } },
      { key: 'bookmark:["example","/book",""]', value: { deleted: false } },
    ];
    for (const changes of invalid) {
      const result = await s.app.inject({ method: 'PUT', url: '/api/v1/state', headers, payload: { ...valid, ...changes } });
      assert.equal(result.statusCode, 400, JSON.stringify(changes) + ': ' + result.body);
      assert.deepEqual((await s.app.inject({ url: '/api/v1/state', headers })).json().items, []);
    }
    const accepted = await s.app.inject({ method: 'PUT', url: '/api/v1/state', headers, payload: valid });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const schema = (await s.app.inject('/api/v1/openapi.json')).json().paths['/api/v1/state'].put.requestBody.content['application/json'].schema;
    assert.equal(schema.oneOf.length, 4);
  } finally { await s.close(); }
});

test('a disconnected streaming upload stays unpublished and its staging file is removed', async () => {
  const s = await setup();
  try {
    const headers = await s.login('alice');
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
    const headers = { ...await s.login('alice'), 'content-type': 'application/zip' };
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
    const headers = await s.login('admin');
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
