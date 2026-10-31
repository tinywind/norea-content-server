import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

test('installation secret, console sessions and automatically admitted devices survive restarts', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'device-access-'));
  let app = await buildApp({ dataDir, anonymousRead: false });
  try {
    const secretPath = join(dataDir, 'admin-password.hash');
    const secret = (await readFile(secretPath, 'utf8')).trim();
    assert.match(secret, /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.deepEqual((await app.inject('/api/v1/capabilities')).json(), { apiVersion: 1, packageVersion: 1, authentication: 'device-key', personalStateSync: true, readingStateVersion: 1, deviceBackupVersion: 1, anonymousRead: false });
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/console-sessions', payload: { password: 'wrong' } })).statusCode, 401);
    const session = await app.inject({ method: 'POST', url: '/api/v1/console-sessions', payload: { password: secret } });
    assert.equal(session.statusCode, 200, session.body);
    const admin = { authorization: `Bearer ${session.json().token}` };
    const deviceKey = randomBytes(32).toString('hex');
    const device = { authorization: `Bearer ${deviceKey}` };
    const register = () => app.inject({ method: 'POST', url: '/api/v1/devices/register', payload: { deviceKey, deviceName: 'Phone' } });
    const registered = await register();
    assert.equal(registered.statusCode, 200, registered.body);
    const identity = registered.json();
    assert.deepEqual(Object.keys(identity).sort(), ['deviceName', 'id']);
    assert.deepEqual((await register()).json(), identity);
    assert.equal((await app.inject({ url: '/api/v1/catalog/changes', headers: device })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/admin/settings', headers: device })).statusCode, 403);
    const listed = (await app.inject({ url: '/api/v1/admin/devices', headers: admin })).json().items;
    assert.equal(listed.length, 1);
    assert.deepEqual(Object.keys(listed[0]).sort(), ['blocked', 'createdAt', 'deviceName', 'id', 'lastSeenAt']);
    assert.equal(listed[0].blocked, false);
    const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'));
    try {
      const row = db.prepare('SELECT key_hash FROM devices').get();
      assert.equal(row?.key_hash, createHash('sha256').update(deviceKey).digest('hex'));
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('accounts','sessions','state','state_changes','operations')").get()?.count, 0);
    } finally { db.close(); }
    await app.close();
    app = await buildApp({ dataDir, anonymousRead: false });
    assert.equal((await readFile(secretPath, 'utf8')).trim(), secret);
    assert.deepEqual((await register()).json(), identity);
    assert.equal((await app.inject({ url: '/api/v1/admin/devices', headers: admin })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/admin/devices/${identity.id}`, headers: admin, payload: { blocked: true } })).statusCode, 200);
    assert.equal((await register()).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/catalog/changes', headers: device })).statusCode, 403);
    await app.close();
    app = await buildApp({ dataDir, anonymousRead: false });
    assert.equal((await register()).statusCode, 403);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/admin/devices/${identity.id}`, headers: admin, payload: { blocked: false } })).statusCode, 200);
    assert.deepEqual((await register()).json(), identity);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/console-sessions/current', headers: admin })).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/v1/admin/devices', headers: admin })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/catalog/changes', headers: device })).statusCode, 200);
  } finally { await app.close(); await rm(dataDir, { recursive: true }); }
});

test('legacy account sessions and legacy personal-state routes remain unavailable', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'removed-access-'));
  const app = await buildApp({ dataDir, anonymousRead: false });
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/devices', headers: { authorization: `Bearer ${randomBytes(32).toString('hex')}` } })).statusCode, 401);
    for (const [method, url] of [['GET', '/api/v1/state'], ['PUT', '/api/v1/state'], ['GET', '/api/v1/state/changes'], ['POST', '/api/v1/sessions'], ['GET', '/api/v1/sessions'], ['DELETE', '/api/v1/sessions/current'], ['POST', '/api/v1/accounts'], ['GET', '/api/v1/admin/accounts']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 404, url);
    }
    const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'));
    try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('accounts','sessions','state','state_changes','operations')").get()?.count, 0); }
    finally { db.close(); }
  } finally { await app.close(); await rm(dataDir, { recursive: true }); }
});

test('malformed installation secret fails startup without replacement', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'invalid-secret-'));
  try {
    const path = join(dataDir, 'admin-password.hash');
    await writeFile(path, 'invalid');
    await assert.rejects(buildApp({ dataDir }), /installation secret/i);
    assert.equal(await readFile(path, 'utf8'), 'invalid');
  } finally { await rm(dataDir, { recursive: true }); }
});

test('console expiry, credential separation and registration input validation are enforced', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'access-boundaries-'));
  const app = await buildApp({ dataDir });
  try {
    const admin = await consoleHeaders(app, dataDir);
    const device = await deviceHeaders(app);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...admin, 'content-type': 'multipart/form-data; boundary=unused' }, payload: Buffer.from('unused') })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/console-sessions/current', headers: device })).statusCode, 403);
    for (const payload of [{ deviceKey: 'short', deviceName: 'Phone' }, { deviceKey: 'A'.repeat(64), deviceName: 'Phone' }, { deviceKey: 'a'.repeat(64), deviceName: '   ' }, { deviceKey: 'a'.repeat(64), deviceName: '' }, { deviceKey: 'a'.repeat(64), deviceName: 'x'.repeat(201) }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/devices/register', payload })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/admin/devices/missing', headers: admin, payload: { blocked: true } })).statusCode, 404);
    const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'));
    try {
      const session = db.prepare('SELECT expires_at FROM console_sessions').get() as { expires_at: number };
      assert.ok(session.expires_at > Date.now() + 86300000 && session.expires_at <= Date.now() + 86400000);
      db.prepare('UPDATE console_sessions SET expires_at=?').run(Date.now() - 1);
    } finally { db.close(); }
    assert.equal((await app.inject({ url: '/api/v1/admin/devices', headers: admin })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/changes?catalogAfter=0&workAfter=0&waitSeconds=0', headers: device })).statusCode, 200);
    assert.equal((await app.inject('/admin-password.hash')).statusCode, 404);
  } finally { await app.close(); await rm(dataDir, { recursive: true }); }
});
