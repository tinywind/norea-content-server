import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(resolve(dataDir), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS console_sessions (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, device_name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)));
    CREATE TABLE IF NOT EXISTS catalog_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, chapter_id TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, entry TEXT NOT NULL, directory TEXT NOT NULL, deleted_at INTEGER, generation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS revisions (chapter_id TEXT NOT NULL REFERENCES chapters(id), revision TEXT NOT NULL, entry TEXT NOT NULL, path TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chapter_id,revision));
    CREATE TABLE IF NOT EXISTS work_tombstones (work_id TEXT PRIMARY KEY, deleted INTEGER NOT NULL, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chapter_tombstones (chapter_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, directory TEXT UNIQUE NOT NULL, entry TEXT NOT NULL, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL, entry TEXT NOT NULL);
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function problem(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
