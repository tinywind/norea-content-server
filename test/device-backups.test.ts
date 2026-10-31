import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.ts';
import { DEVICE_BACKUP_MAX_BYTES, DeviceBackupStore } from '../src/device-backups.ts';
import { problem } from '../src/db.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const route = (name = '내 기기 / S25') => `/api/v1/device-backups/${encodeURIComponent(name)}`;
const body = Buffer.from('PK\u0003\u0004 opaque device database, plugin sources and private settings');
async function contents(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-device-backup-'));
  const app = await buildApp({ dataDir });
  const headers = await deviceHeaders(app);
  const upload = (payload = body, name?: string, digest = hash(payload)) => app.inject({
    method: 'PUT', url: route(name), payload, headers: { ...headers, 'content-type': 'application/octet-stream', 'x-backup-sha256': digest },
  });
  return { dataDir, app, headers, upload, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('device backups require an admitted unblocked device for listing, upload and restore', async () => {
  const f = await fixture();
  try {
    const admin = await consoleHeaders(f.app, f.dataDir);
    for (const [method, url] of [['GET', '/api/v1/device-backups'], ['GET', route()], ['PUT', route()]] as const) {
      for (const [headers, status] of [[{}, 401], [{ authorization: 'Bearer invalid' }, 401], [admin, 403]] as const) {
        const response = await f.app.inject({ method, url, headers });
        assert.equal(response.statusCode, status, response.body);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    }
    assert.equal((await f.upload()).statusCode, 200);
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try { db.exec('UPDATE devices SET blocked=1'); } finally { db.close(); }
    assert.equal((await f.app.inject({ url: '/api/v1/device-backups', headers: f.headers })).statusCode, 403);
    assert.equal((await f.app.inject({ url: route(), headers: f.headers })).statusCode, 403);
    assert.equal((await f.upload()).statusCode, 403);
  } finally { await f.close(); }
});

test('opaque archives above the normal JSON body limit round trip, list by name, and survive restart', async () => {
  const f = await fixture();
  try {
    const payload = Buffer.concat([body, Buffer.alloc(1024 * 1024 + 17, 43)]);
    const response = await f.upload(payload);
    assert.equal(response.statusCode, 200, response.body);
    const saved = response.json();
    assert.deepEqual(Object.keys(saved).sort(), ['deviceName', 'sha256', 'size', 'updatedAt']);
    assert.equal(saved.deviceName, '내 기기 / S25');
    assert.equal(saved.size, payload.length);
    assert.equal(saved.sha256, hash(payload));
    assert.ok(Number.isSafeInteger(saved.updatedAt));
    assert.equal((await f.app.inject('/api/v1/capabilities')).json().deviceBackupVersion, 1);
    const second = await deviceHeaders(f.app, 'Tablet');
    const listed = await f.app.inject({ url: '/api/v1/device-backups', headers: second });
    assert.deepEqual(listed.json(), { items: [saved] });
    const restored = await f.app.inject({ url: `${route()}?sha256=${saved.sha256}`, headers: second });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.rawPayload, payload);
    assert.equal(restored.headers['x-backup-sha256'], saved.sha256);
    assert.equal(restored.headers['cache-control'], 'no-store');
    assert.equal(restored.headers['content-length'], String(payload.length));
    await f.app.close();
    const restarted = await buildApp({ dataDir: f.dataDir });
    try {
      assert.deepEqual((await restarted.inject({ url: '/api/v1/device-backups', headers: f.headers })).json(), { items: [saved] });
      assert.deepEqual((await restarted.inject({ url: route(), headers: f.headers })).rawPayload, payload);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('same-name uploads replace the latest backup atomically and stale downloads fail with 409', async () => {
  const f = await fixture();
  try {
    const old = (await f.upload()).json();
    const replacement = Buffer.from('PK new database bytes');
    const current = await f.upload(replacement);
    assert.equal(current.statusCode, 200, current.body);
    const secondName = await f.upload(body, 'Y700');
    assert.equal(secondName.statusCode, 200, secondName.body);
    const items = (await f.app.inject({ url: '/api/v1/device-backups', headers: f.headers })).json().items;
    assert.equal(items.length, 2);
    assert.equal(items.find((item: { deviceName: string }) => item.deviceName === old.deviceName).sha256, hash(replacement));
    assert.equal((await f.app.inject({ url: `${route()}?sha256=${old.sha256}`, headers: f.headers })).statusCode, 409);
    assert.equal((await f.app.inject({ url: route('missing'), headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ url: `${route()}?sha256=invalid`, headers: f.headers })).statusCode, 400);
    assert.deepEqual((await f.app.inject({ url: route(), headers: f.headers })).rawPayload, replacement);
    assert.equal((await readdir(join(f.dataDir, 'device-backups', 'blobs'))).length, 2);
    assert.deepEqual(await readdir(join(f.dataDir, 'device-backups', 'staging')), []);
  } finally { await f.close(); }
});

test('invalid headers, size, hash, empty payloads and device names cannot replace a saved backup', async () => {
  const f = await fixture();
  try {
    const saved = (await f.upload()).json();
    assert.equal((await f.upload(body, undefined, 'f'.repeat(64))).statusCode, 400);
    assert.equal((await f.upload(Buffer.alloc(0))).statusCode, 400);
    assert.equal((await f.upload(body, '   ')).statusCode, 400);
    assert.equal((await f.upload(body, 'line\nbreak')).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'PUT', url: route(), headers: { ...f.headers, 'content-type': 'application/octet-stream' }, payload: body })).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'PUT', url: route(), headers: { ...f.headers, 'content-type': 'application/json', 'x-backup-sha256': hash(body) }, payload: '{}' })).statusCode, 415);
    const oversized = await f.app.inject({ method: 'PUT', url: route(), headers: { ...f.headers, 'content-type': 'application/octet-stream', 'content-length': String(DEVICE_BACKUP_MAX_BYTES + 1), 'x-backup-sha256': hash(body) }, payload: body });
    assert.equal(oversized.statusCode, 413, oversized.body);
    assert.deepEqual((await f.app.inject({ url: '/api/v1/device-backups', headers: f.headers })).json(), { items: [saved] });
    assert.deepEqual((await f.app.inject({ url: route(), headers: f.headers })).rawPayload, body);
    assert.deepEqual(await readdir(join(f.dataDir, 'device-backups', 'staging')), []);
  } finally { await f.close(); }
});

test('interrupted, oversized, timed-out or authorization-revoked streams preserve the previous pointer and clean staging', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-backup-stream-'));
  try {
    const store = new DeviceBackupStore(dataDir, { maxBytes: 32, timeoutMs: 30 });
    const original = Buffer.from('old db');
    const saved = await store.put('Phone', Readable.from([original]), hash(original));
    const oversized = Buffer.alloc(33);
    await assert.rejects(store.put('Phone', Readable.from([oversized]), hash(oversized)), { statusCode: 413 });
    await assert.rejects(store.put('Phone', Readable.from((async function* () { yield Buffer.from('part'); throw new Error('connection interrupted'); })()), hash(body)), /connection interrupted/);
    await assert.rejects(store.put('Phone', Readable.from([original]), hash(original), { contentLength: original.length + 1 }), { statusCode: 400 });
    await assert.rejects(store.put('Phone', Readable.from([original]), hash(original), { beforePublish: () => { throw problem(403, 'Device blocked during upload'); } }), { statusCode: 403 });
    const stalled = new PassThrough();
    stalled.write('part');
    const keepAlive = setTimeout(() => {}, 1000);
    try { await assert.rejects(store.put('Phone', stalled, hash(body)), { statusCode: 408 }); }
    finally { clearTimeout(keepAlive); stalled.destroy(); }
    assert.deepEqual(await store.list(), [saved]);
    assert.deepEqual(await contents((await store.get('Phone')).body), original);
    assert.deepEqual(await readdir(join(dataDir, 'device-backups', 'staging')), []);
    assert.equal((await readdir(join(dataDir, 'device-backups', 'blobs'))).length, 1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('in-progress uploads stay invisible and an opened download remains consistent during replacement', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-backup-atomic-'));
  try {
    const store = new DeviceBackupStore(dataDir);
    const saved = await store.put('Phone', Readable.from([body]), hash(body));
    const oldDownload = await store.get('Phone');
    const slow = new PassThrough();
    const replacement = Buffer.from('replacement db');
    const pending = store.put('Phone', slow, hash(replacement));
    slow.write(replacement.subarray(0, 5));
    assert.deepEqual(await store.list(), [saved]);
    const interleaved = Buffer.from('another completed db');
    await store.put('Phone', Readable.from([interleaved]), hash(interleaved));
    slow.end(replacement.subarray(5));
    await pending;
    assert.deepEqual(await contents(oldDownload.body), body);
    assert.deepEqual(await contents((await store.get('Phone')).body), replacement);
    assert.equal((await store.list()).length, 1);
    assert.equal((await readdir(join(dataDir, 'device-backups', 'blobs'))).length, 1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('blocking a device while its HTTP body streams prevents publication', async () => {
  const f = await fixture();
  let db: DatabaseSync | undefined;
  try {
    const saved = (await f.upload()).json();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const replacement = Buffer.from('a replacement that must never publish');
    let uploadRequest!: ReturnType<typeof httpRequest>;
    const completed = new Promise<number>((resolve, reject) => {
      uploadRequest = httpRequest(`${address}${route()}`, { method: 'PUT', headers: { ...f.headers, 'content-type': 'application/octet-stream', 'content-length': replacement.length, 'x-backup-sha256': hash(replacement) } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!));
      });
      uploadRequest.on('error', reject);
      uploadRequest.write(replacement.subarray(0, 3));
    });
    for (let attempt = 0; attempt < 100 && !(await readdir(join(f.dataDir, 'device-backups', 'staging'))).length; attempt += 1) await delay(5);
    assert.equal((await readdir(join(f.dataDir, 'device-backups', 'staging'))).length, 1);
    db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    db.exec('UPDATE devices SET blocked=1');
    uploadRequest.end(replacement.subarray(3));
    assert.equal(await completed, 403);
    const second = await deviceHeaders(f.app, 'Another device');
    assert.deepEqual((await f.app.inject({ url: '/api/v1/device-backups', headers: second })).json(), { items: [saved] });
    assert.deepEqual(await readdir(join(f.dataDir, 'device-backups', 'staging')), []);
  } finally { db?.close(); await f.close(); }
});

test('backup writes leave server database, catalog settings, password and original files intact', async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
  try {
    const secret = await readFile(join(f.dataDir, 'admin-password.hash'));
    const schema = db.prepare('SELECT checksum FROM schema_state').get();
    db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run('backup-witness', 'preserve');
    db.prepare('INSERT INTO catalog_changes(chapter_id,entry) VALUES(?,?)').run('existing-catalog-witness', '{"preserve":true}');
    const original = join(f.dataDir, 'original-content-witness');
    await writeFile(original, body);
    assert.equal((await f.upload()).statusCode, 200);
    assert.deepEqual(db.prepare('SELECT checksum FROM schema_state').get(), schema);
    assert.equal(db.prepare('SELECT value FROM admin_settings WHERE key=?').get('backup-witness')?.value, 'preserve');
    assert.equal(db.prepare('SELECT entry FROM catalog_changes WHERE chapter_id=?').get('existing-catalog-witness')?.entry, '{"preserve":true}');
    assert.deepEqual(await readFile(original), body);
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), secret);
  } finally { db.close(); await f.close(); }
});

test('backup downloads reject replaced symbolic files without reading outside the backup store', { skip: process.platform === 'win32' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-backup-symlink-'));
  try {
    const store = new DeviceBackupStore(dataDir);
    await store.put('Phone', Readable.from([body]), hash(body));
    const blob = join(dataDir, 'device-backups', 'blobs', (await readdir(join(dataDir, 'device-backups', 'blobs')))[0]!);
    const outside = join(dataDir, 'private-unrelated-file');
    await writeFile(outside, body);
    await rm(blob);
    await symlink(outside, blob);
    await assert.rejects(store.get('Phone'), { statusCode: 410 });
    assert.deepEqual(await readFile(outside), body);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
