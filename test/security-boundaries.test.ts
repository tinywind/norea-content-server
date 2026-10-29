import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { installationSecret } from '../src/auth.ts';
import { readNovelMetadata } from '../src/works.ts';

async function temporary() {
  await mkdir('.tmp', { recursive: true });
  return mkdtemp(resolve('.tmp/security-boundaries-'));
}

test('login and registration limit repeated requests by real client IP', async () => {
  const dataDir = await temporary();
  const app = await buildApp({ dataDir });
  try {
    const address = '192.0.2.1';
    for (let count = 0; count < 10; count++) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/console-sessions', remoteAddress: address, payload: { password: 'wrong' } })).statusCode, 401);
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/console-sessions', remoteAddress: address, headers: { 'x-forwarded-for': '198.51.100.9' }, payload: { password: 'wrong' } });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/console-sessions', remoteAddress: '192.0.2.2', payload: { password: 'wrong' } })).statusCode, 401);
    for (let count = 0; count < 60; count++) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/devices/register', remoteAddress: address, payload: { deviceKey: 'a'.repeat(64), deviceName: 'Fixture' } })).statusCode, 200);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/devices/register', remoteAddress: address, payload: { deviceKey: 'b'.repeat(64), deviceName: 'Blocked' } })).statusCode, 429);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/devices/register', remoteAddress: '192.0.2.2', payload: { deviceKey: 'b'.repeat(64), deviceName: 'Other client' } })).statusCode, 200);
  } finally { await app.close(); await rm(dataDir, { recursive: true }); }
});

test('general API requests have a bounded per-client rate', async () => {
  const dataDir = await temporary();
  const app = await buildApp({ dataDir });
  try {
    for (let count = 0; count < 6000; count++) assert.equal((await app.inject('/api/v1/capabilities')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/capabilities')).statusCode, 429);
    assert.equal((await app.inject({ url: '/api/v1/capabilities', remoteAddress: '192.0.2.2' })).statusCode, 200);
  } finally { await app.close(); await rm(dataDir, { recursive: true }); }
});

for (const kind of ['secret', 'work'] as const) test(`${kind} reads reject a pathname replaced after validation`, { skip: process.platform === 'win32' }, async () => {
  const directory = await temporary();
  const target = join(directory, kind === 'secret' ? 'admin-password.hash' : 'novel.json');
  const outside = join(directory, 'outside');
  const original = kind === 'secret' ? 'a'.repeat(64) : JSON.stringify({ identity: { pluginId: 'example', novelId: 'Book', novelPath: '/book' }, novel: { name: 'Original' } });
  const replacement = kind === 'secret' ? 'b'.repeat(64) : JSON.stringify({ identity: { pluginId: 'example', novelId: 'Book', novelPath: '/book' }, novel: { name: 'Outside' } });
  await writeFile(target, original, { mode: 0o600 }); await writeFile(outside, replacement);
  const lstat = fs.lstatSync, fstat = fs.fstatSync;
  let swapped = false, inspections = 0;
  const swap = () => {
    if (swapped) return;
    swapped = true; fs.renameSync(target, target + '.saved'); fs.symlinkSync(outside, target);
  };
  fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => {
    const info = Reflect.apply(lstat, fs, [path, ...args]);
    if (String(path) === target && ++inspections === (kind === 'secret' ? 1 : 2)) swap();
    return info;
  }) as typeof fs.lstatSync;
  fs.fstatSync = ((descriptor: number, ...args: unknown[]) => {
    const info = Reflect.apply(fstat, fs, [descriptor, ...args]); swap(); return info;
  }) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  try {
    let value: string | undefined;
    try { value = kind === 'secret' ? installationSecret(directory) : readNovelMetadata(target).novel.name; }
    catch (error) {
      assert.ok((error as NodeJS.ErrnoException).code === 'ELOOP' || /installation secret|work file changed|symbolic/i.test((error as Error).message), String(error));
    }
    if (value !== undefined) assert.equal(value, kind === 'secret' ? original : 'Original');
    assert.equal(swapped, true, 'replacement must occur between validation and reading');
  } finally {
    fs.lstatSync = lstat; fs.fstatSync = fstat; syncBuiltinESMExports();
    await rm(directory, { recursive: true });
  }
});
