import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import { problem, transaction } from './db.ts';

export const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex');

export function installationSecret(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'admin-password.hash');
  try { writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.size > 66) throw new Error('Invalid installation secret file');
  const secret = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Invalid installation secret file');
  return secret;
}

export function createConsoleSession(db: DatabaseSync, secret: string, password: string): { token: string } {
  if (!timingSafeEqual(Buffer.from(tokenDigest(secret), 'hex'), Buffer.from(tokenDigest(password), 'hex'))) throw problem(401, 'Invalid console password');
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO console_sessions(id,token_hash,expires_at) VALUES(?,?,?)').run(randomUUID(), tokenDigest(token), Date.now() + 86400000);
  return { token };
}

export function registerDevice(db: DatabaseSync, deviceKey: string, deviceName: string): { id: string; deviceName: string } {
  if (!/^[0-9a-f]{64}$/.test(deviceKey) || !deviceName.trim() || deviceName.length > 200) throw problem(400, 'A device key and device name are required');
  return transaction(db, () => {
    const hash = tokenDigest(deviceKey);
    const existing = db.prepare('SELECT id,blocked FROM devices WHERE key_hash=?').get(hash) as { id: string; blocked: number } | undefined;
    if (existing?.blocked) throw problem(403, 'Device is blocked');
    const id = existing?.id ?? randomUUID();
    const now = Date.now();
    db.prepare('INSERT INTO devices(id,key_hash,device_name,created_at,last_seen_at,blocked) VALUES(?,?,?,?,?,0) ON CONFLICT(key_hash) DO UPDATE SET device_name=excluded.device_name,last_seen_at=excluded.last_seen_at').run(id, hash, deviceName, now, now);
    return { id, deviceName };
  });
}

export function authenticate(db: DatabaseSync, request: FastifyRequest, admin = false): { id: string; kind: 'console' | 'device' } {
  const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!token) throw problem(401, 'Authentication required');
  const hash = tokenDigest(token);
  const session = db.prepare('SELECT id FROM console_sessions WHERE token_hash=? AND expires_at>?').get(hash, Date.now()) as { id: string } | undefined;
  if (session) return { id: session.id, kind: 'console' };
  const device = /^[0-9a-f]{64}$/.test(token) ? db.prepare('SELECT id,blocked FROM devices WHERE key_hash=?').get(hash) as { id: string; blocked: number } | undefined : undefined;
  if (!device) throw problem(401, 'Authentication required');
  if (device.blocked) throw problem(403, 'Device is blocked');
  if (admin) throw problem(403, 'Console session required');
  db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(Date.now(), device.id);
  return { id: device.id, kind: 'device' };
}

export function authenticateDevice(db: DatabaseSync, request: FastifyRequest): void {
  if (authenticate(db, request).kind !== 'device') throw problem(403, 'Device key required');
}
