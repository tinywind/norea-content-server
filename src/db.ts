import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const schema = `
    PRAGMA user_version = 1;
    CREATE TABLE schema_state (checksum TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS console_sessions (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, device_name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)));
    CREATE TABLE IF NOT EXISTS catalog_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, chapter_id TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, entry TEXT NOT NULL, directory TEXT UNIQUE NOT NULL, path TEXT, deleted_at INTEGER);
    CREATE TABLE IF NOT EXISTS work_tombstones (work_id TEXT PRIMARY KEY, deleted INTEGER NOT NULL, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chapter_tombstones (chapter_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scan_checkpoints (path TEXT PRIMARY KEY, signature TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, directory TEXT UNIQUE NOT NULL, entry TEXT NOT NULL, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS chapters_path ON chapters(path);
    CREATE INDEX IF NOT EXISTS works_catalog_name ON works(json_extract(entry,'$.metadata.novel.name'),id);
    CREATE INDEX IF NOT EXISTS works_catalog_source ON works(json_extract(entry,'$.metadata.identity.pluginId'),json_extract(entry,'$.metadata.novel.name'),id);
    CREATE INDEX IF NOT EXISTS chapters_catalog_work ON chapters(work_id,deleted_at,json_extract(entry,'$.manifest.chapter.position'),id);
    CREATE TABLE IF NOT EXISTS admin_jobs (id TEXT PRIMARY KEY, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_job_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_job_items_job ON admin_job_items(job_id,sequence);
    CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_registrations (
      id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), sources TEXT NOT NULL, updated_at TEXT NOT NULL
    );
`;

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(resolve(dataDir), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'));
  try {
    const checksum = createHash('sha256').update(schema).digest('hex');
    const existing = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (existing.length) {
      if (!existing.some(table => table.name === 'schema_state') || db.prepare('SELECT checksum FROM schema_state').get()?.checksum !== checksum) {
        throw new Error('Database does not use the current schema. Stop the server, remove metadata.sqlite and its sidecar files, then create a fresh database and scan current chapter folders.');
      }
    } else {
      transaction(db, () => { db.exec(schema); db.prepare('INSERT INTO schema_state VALUES(?)').run(checksum); });
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function problem(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
