import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import { openDatabase, problem, transaction } from './db.ts';

const derive = promisify(scrypt);
export type User = { id: string; username: string; role: 'admin' | 'member' };
export const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function setAccount(db: DatabaseSync, username: string, password: string, role: User['role']): Promise<User> {
  if (!username.trim() || username.length > 100 || password.length < 12 || password.length > 1024) throw problem(400, 'Username and a password of 12 to 1024 characters are required');
  const salt = randomBytes(32).toString('hex');
  const digest = (await derive(password, salt, 64) as Buffer).toString('hex');
  return transaction(db, () => {
    const existing = db.prepare('SELECT id FROM accounts WHERE username=?').get(username) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    db.prepare('INSERT INTO accounts(id,username,password,role) VALUES(?,?,?,?) ON CONFLICT(username) DO UPDATE SET password=excluded.password,role=excluded.role').run(id, username, `${salt}:${digest}`, role);
    db.prepare('DELETE FROM sessions WHERE account_id=?').run(id);
    return { id, username, role };
  });
}

export async function provisionAccount(dataDir: string, username: string, password: string, role: User['role']): Promise<User> {
  const db = openDatabase(dataDir);
  try { return await setAccount(db, username, password, role); } finally { db.close(); }
}

export async function createSession(db: DatabaseSync, username: string, password: string, deviceName: string) {
  const account = db.prepare('SELECT * FROM accounts WHERE username=?').get(username) as (User & { password: string }) | undefined;
  const [salt, expected] = account?.password.split(':') ?? ['0'.repeat(64), '0'.repeat(128)];
  const actual = await derive(password, salt, 64) as Buffer;
  if (!account || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw problem(401, 'Invalid username or password');
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(randomUUID(), account.id, tokenDigest(token), deviceName, Date.now() + 30 * 86400000);
  return { token, user: { id: account.id, username: account.username, role: account.role } };
}

export function authenticate(db: DatabaseSync, request: FastifyRequest, admin = false): User {
  const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  const user = token && db.prepare('SELECT a.id,a.username,a.role FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenDigest(token), Date.now()) as User | undefined;
  if (!user) throw problem(401, 'Authentication required');
  if (admin && user.role !== 'admin') throw problem(403, 'Administrator permission required');
  return user;
}
