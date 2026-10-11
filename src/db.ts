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
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT UNIQUE NOT NULL, device_name TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, chapter_id TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, entry TEXT NOT NULL, directory TEXT NOT NULL, deleted_at INTEGER, generation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS revisions (chapter_id TEXT NOT NULL REFERENCES chapters(id), revision TEXT NOT NULL, entry TEXT NOT NULL, path TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chapter_id,revision));
    CREATE TABLE IF NOT EXISTS work_tombstones (work_id TEXT PRIMARY KEY, deleted INTEGER NOT NULL, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chapter_tombstones (chapter_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state (account_id TEXT NOT NULL REFERENCES accounts(id), key TEXT NOT NULL, entry TEXT NOT NULL, candidate TEXT NOT NULL, PRIMARY KEY(account_id,key));
    CREATE TABLE IF NOT EXISTS operations (account_id TEXT NOT NULL REFERENCES accounts(id), operation_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, status INTEGER NOT NULL, PRIMARY KEY(account_id,operation_id));
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
