import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
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
    CREATE INDEX IF NOT EXISTS chapters_directory_casefold ON chapters(lower(directory));
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

// Additive extensions stay outside the original schema checksum so existing
// installations retain their catalog, credentials, settings and chapter files.
const readingStateSchema = `
    CREATE TABLE IF NOT EXISTS reading_state_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_hash TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      entry TEXT NOT NULL,
      UNIQUE(profile_hash, entry_key)
    );
    CREATE INDEX IF NOT EXISTS reading_state_profile_sequence ON reading_state_entries(profile_hash, sequence);
`;

const workMigrationSchema = `
    CREATE TABLE IF NOT EXISTS work_migrations (
      operation_id TEXT PRIMARY KEY,
      source_work_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_migration_lineage (
      operation_id TEXT PRIMARY KEY,
      source_work_id TEXT NOT NULL,
      target_work_id TEXT NOT NULL,
      entry TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_migration_lineage_source ON work_migration_lineage(source_work_id);
    CREATE INDEX IF NOT EXISTS work_migration_lineage_target ON work_migration_lineage(target_work_id);
    CREATE TABLE IF NOT EXISTS work_migration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL REFERENCES work_migration_lineage(operation_id),
      active INTEGER NOT NULL CHECK(active IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS work_migration_events_operation ON work_migration_events(operation_id,sequence);
`;

const chapterNumberSchema = `
    CREATE TABLE IF NOT EXISTS chapter_number_reconciliations (
      operation_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','committed')),
      journal TEXT,
      result TEXT
    );
    CREATE TABLE IF NOT EXISTS chapter_number_aliases (
      work_id TEXT NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      chapter_path TEXT NOT NULL,
      source_chapter_path TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      PRIMARY KEY(work_id, from_number),
      UNIQUE(work_id, to_number),
      UNIQUE(work_id, chapter_path),
      UNIQUE(work_id, chapter_id)
    );
`;


const userStateSchema = `
    CREATE TABLE IF NOT EXISTS user_state_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL, epoch TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_state_records (
      entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, category_name TEXT, category_deleted INTEGER,
      revision INTEGER NOT NULL, record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_state_record_kinds ON user_state_records(kind);
    CREATE UNIQUE INDEX IF NOT EXISTS user_state_active_category_names
      ON user_state_records(category_name) WHERE kind='category' AND category_deleted=0;
    CREATE TABLE IF NOT EXISTS user_state_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT, entity_key TEXT NOT NULL, record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_state_operations (
      device_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(operation_id)
    );
    CREATE TABLE IF NOT EXISTS user_state_category_aliases (
      alias_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL
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
    transaction(db, () => {
      db.exec(readingStateSchema); db.exec(workMigrationSchema); db.exec(chapterNumberSchema); db.exec(userStateSchema);
      db.prepare('INSERT OR IGNORE INTO user_state_meta(singleton,workspace_id,epoch) VALUES(1,?,?)').run(randomUUID(), randomUUID());
    });
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
