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
const workSummaryFields = `
  json_extract(entry,'$.sequence'), directory,
  json_extract(entry,'$.metadata.identity.pluginId'),
  json_extract(entry,'$.metadata.identity.novelId'),
  json_extract(entry,'$.metadata.identity.novelPath'),
  coalesce(json_extract(entry,'$.metadata.novel.isLocal'),0),
  coalesce(json_extract(entry,'$.hasCover'),0),
  json_extract(entry,'$.metadata.novel'),
  json_extract(entry,'$.metadata.cover'),
  (SELECT count(*) FROM json_each(entry,'$.metadata.chapters'))
`;
const indexedWorkEntry = `json_type(entry,'$.metadata.novel')='object' AND json_type(entry,'$.sequence')='integer'`;
const workSummarySchema = `
  CREATE TABLE IF NOT EXISTS work_summaries (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    directory TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    novel_id TEXT NOT NULL,
    novel_path TEXT NOT NULL,
    is_local INTEGER NOT NULL,
    has_cover INTEGER NOT NULL,
    novel_json TEXT NOT NULL,
    cover_json TEXT,
    chapter_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS work_summaries_plugin ON work_summaries(plugin_id);
  CREATE TRIGGER IF NOT EXISTS works_summary_insert AFTER INSERT ON works BEGIN
    INSERT INTO work_summaries SELECT id,${workSummaryFields} FROM works WHERE id=NEW.id AND ${indexedWorkEntry};
  END;
  CREATE TRIGGER IF NOT EXISTS works_summary_update AFTER UPDATE ON works BEGIN
    DELETE FROM work_summaries WHERE id=OLD.id;
    INSERT INTO work_summaries SELECT id,${workSummaryFields} FROM works WHERE id=NEW.id AND ${indexedWorkEntry};
  END;
  CREATE TRIGGER IF NOT EXISTS works_summary_delete AFTER DELETE ON works BEGIN
    DELETE FROM work_summaries WHERE id=OLD.id;
  END;
  INSERT INTO work_summaries SELECT id,${workSummaryFields} FROM works
    WHERE NOT EXISTS (SELECT 1 FROM work_summaries WHERE work_summaries.id=works.id) AND ${indexedWorkEntry};
`;
const changeIndexSchema = `
  CREATE INDEX IF NOT EXISTS work_changes_work_id ON work_changes(work_id);
  CREATE INDEX IF NOT EXISTS catalog_changes_chapter_id ON catalog_changes(chapter_id);
  CREATE INDEX IF NOT EXISTS user_state_changes_entity_key ON user_state_changes(entity_key);
`;

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
    CREATE TABLE IF NOT EXISTS work_migration_restorations (
      operation_id TEXT PRIMARY KEY,
      source_work_id TEXT NOT NULL
    );
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
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      retired_at INTEGER
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

// The counter outlives deleted rows so a change-feed revision is never reused.
const workOverrideSchema = `
    CREATE TABLE IF NOT EXISTS work_overrides (work_id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_override_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
`;

const userStateSchema = `
    CREATE TABLE IF NOT EXISTS user_state_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL, epoch TEXT NOT NULL,
      head_revision INTEGER NOT NULL DEFAULT 0,
      compacted_through INTEGER NOT NULL DEFAULT 0,
      seed_blocked INTEGER NOT NULL DEFAULT 0,
      seed_cutoff_at INTEGER,
      last_gc_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_state_records (
      entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, category_name TEXT, category_deleted INTEGER,
      membership_category_id TEXT, membership_included INTEGER,
      revision INTEGER NOT NULL, record TEXT NOT NULL,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS user_state_record_kinds ON user_state_records(kind);
    CREATE UNIQUE INDEX IF NOT EXISTS user_state_active_category_names
      ON user_state_records(category_name) WHERE kind='category' AND category_deleted=0;
    CREATE TABLE IF NOT EXISTS user_state_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT, entity_key TEXT NOT NULL, record TEXT NOT NULL,
      superseded_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_state_operations (
      device_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(operation_id)
    );
    CREATE TABLE IF NOT EXISTS user_state_category_aliases (
      alias_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL
    );
`;

const retiredUserStateTables = [
  'user_state_delta_current_category_aliases',
  'user_state_delta_current_categories',
  'user_state_delta_bridge_meta',
  'user_state_current_records',
  'user_state_current_meta',
] as const;

function ensureUserStateSchema(db: DatabaseSync, now = Date.now()): void {
  for (const table of retiredUserStateTables) db.exec(`DROP TABLE IF EXISTS ${table}`);

  const recordColumns = new Set((db.prepare('PRAGMA table_info(user_state_records)').all() as { name: string }[]).map(column => column.name));
  const needsMembershipBackfill = !recordColumns.has('membership_category_id') || !recordColumns.has('membership_included');
  if (!recordColumns.has('membership_category_id')) db.exec('ALTER TABLE user_state_records ADD COLUMN membership_category_id TEXT');
  if (!recordColumns.has('membership_included')) db.exec('ALTER TABLE user_state_records ADD COLUMN membership_included INTEGER');
  const needsUpdatedAtBackfill = !recordColumns.has('updated_at');
  if (!recordColumns.has('updated_at')) db.exec('ALTER TABLE user_state_records ADD COLUMN updated_at INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS user_state_membership_categories
    ON user_state_records(membership_category_id,membership_included) WHERE kind='membership'`);
  db.exec('CREATE INDEX IF NOT EXISTS user_state_records_updated_at ON user_state_records(kind,updated_at)');
  if (needsMembershipBackfill) db.exec(`UPDATE user_state_records SET
    membership_category_id=json_extract(record,'$.entity.categoryId'),
    membership_included=CAST(json_extract(record,'$.value.included') AS INTEGER)
    WHERE kind='membership'`);
  if (needsUpdatedAtBackfill) db.exec(`UPDATE user_state_records SET
    updated_at=COALESCE(CAST(json_extract(record,'$.updatedAt') AS INTEGER), 0)
    WHERE updated_at IS NULL`);

  const metaColumns = new Set((db.prepare('PRAGMA table_info(user_state_meta)').all() as { name: string }[]).map(column => column.name));
  if (!metaColumns.has('head_revision')) db.exec('ALTER TABLE user_state_meta ADD COLUMN head_revision INTEGER NOT NULL DEFAULT 0');
  if (!metaColumns.has('compacted_through')) db.exec('ALTER TABLE user_state_meta ADD COLUMN compacted_through INTEGER NOT NULL DEFAULT 0');
  if (!metaColumns.has('seed_blocked')) db.exec('ALTER TABLE user_state_meta ADD COLUMN seed_blocked INTEGER NOT NULL DEFAULT 0');
  if (!metaColumns.has('seed_cutoff_at')) db.exec('ALTER TABLE user_state_meta ADD COLUMN seed_cutoff_at INTEGER');
  if (!metaColumns.has('last_gc_at')) db.exec('ALTER TABLE user_state_meta ADD COLUMN last_gc_at INTEGER');
  const hasSequenceTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get(),
  );
  const sequenceSubquery = hasSequenceTable
    ? "COALESCE((SELECT seq FROM sqlite_sequence WHERE name='user_state_changes'), 0)"
    : '0';
  db.exec(`UPDATE user_state_meta SET head_revision = MAX(
    head_revision,
    COALESCE((SELECT MAX(revision) FROM user_state_changes), 0),
    COALESCE((SELECT MAX(revision) FROM user_state_records), 0),
    ${sequenceSubquery}
  ) WHERE singleton = 1`);
  db.exec(`UPDATE user_state_meta SET
    compacted_through = MIN(MAX(0, compacted_through), head_revision),
    seed_blocked = CASE WHEN seed_blocked <> 0 THEN 1 ELSE 0 END
    WHERE singleton = 1`);

  const migrationEventColumns = new Set((db.prepare('PRAGMA table_info(work_migration_events)').all() as { name: string }[]).map(column => column.name));
  if (!migrationEventColumns.has('retired_at')) db.exec('ALTER TABLE work_migration_events ADD COLUMN retired_at INTEGER');
  db.prepare('UPDATE work_migration_events SET retired_at = ? WHERE active = 1 AND retired_at IS NULL').run(now);

  const changeColumns = new Set((db.prepare('PRAGMA table_info(user_state_changes)').all() as { name: string }[]).map(column => column.name));
  if (!changeColumns.has('superseded_at')) {
    db.exec('ALTER TABLE user_state_changes ADD COLUMN superseded_at INTEGER');
    db.prepare(`UPDATE user_state_changes SET superseded_at = ?
      WHERE superseded_at IS NULL AND EXISTS (
        SELECT 1 FROM user_state_records r
        WHERE r.entity_key = user_state_changes.entity_key AND r.revision > user_state_changes.revision
      )`).run(now);
  }
  db.exec('CREATE INDEX IF NOT EXISTS user_state_changes_superseded ON user_state_changes(superseded_at) WHERE superseded_at IS NOT NULL');

  const operationColumns = db.prepare('PRAGMA table_info(user_state_operations)').all() as { name: string; notnull: number }[];
  const resultColumn = operationColumns.find(column => column.name === 'result');
  const hasCreatedAt = operationColumns.some(column => column.name === 'created_at');
  if (resultColumn?.notnull === 1) {
    db.exec(`CREATE TABLE user_state_operations_v2 (
      device_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(operation_id)
    )`);
    if (hasCreatedAt) {
      db.prepare(`INSERT INTO user_state_operations_v2(device_id,operation_id,payload_hash,result,created_at)
        SELECT device_id,operation_id,payload_hash,result,CASE WHEN created_at>0 THEN created_at ELSE ? END FROM user_state_operations`).run(now);
    } else {
      db.prepare(`INSERT INTO user_state_operations_v2(device_id,operation_id,payload_hash,result,created_at)
        SELECT device_id,operation_id,payload_hash,result,? FROM user_state_operations`).run(now);
    }
    db.exec('DROP TABLE user_state_operations; ALTER TABLE user_state_operations_v2 RENAME TO user_state_operations;');
  } else if (!hasCreatedAt) {
    db.exec('ALTER TABLE user_state_operations ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
    db.prepare('UPDATE user_state_operations SET created_at = ? WHERE created_at = 0').run(now);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS user_state_operations_created_at ON user_state_operations(created_at);
    CREATE INDEX IF NOT EXISTS user_state_operations_prunable_body ON user_state_operations(created_at) WHERE result IS NOT NULL;`);

  const normalizedReadingKey = 'migration:normalize-reading-progress-v1';
  if (db.prepare('SELECT 1 FROM admin_settings WHERE key=?').get(normalizedReadingKey)) return;
  // Normalize legacy reading tuples from { progress, unread, readAt } to { progress, readAt }.
  db.exec(`UPDATE user_state_records
    SET record = json_remove(
      CASE
        WHEN json_type(record, '$.value.unread') = 'false'
          AND COALESCE(CAST(json_extract(record, '$.value.progress') AS REAL), 0) < 100
          THEN json_set(record, '$.value.progress', 100)
        ELSE record
      END,
      '$.value.unread'
    )
    WHERE kind = 'reading' AND json_type(record, '$.value.unread') IS NOT NULL`);
  db.exec(`UPDATE user_state_changes
    SET record = json_remove(
      CASE
        WHEN json_type(record, '$.value.unread') = 'false'
          AND COALESCE(CAST(json_extract(record, '$.value.progress') AS REAL), 0) < 100
          THEN json_set(record, '$.value.progress', 100)
        ELSE record
      END,
      '$.value.unread'
    )
    WHERE json_extract(record, '$.entity.kind') = 'reading'
      AND json_type(record, '$.value.unread') IS NOT NULL`);
  db.exec(`UPDATE user_state_operations
    SET result = json_remove(
      CASE
        WHEN json_type(result, '$.current.value.unread') = 'false'
          AND COALESCE(CAST(json_extract(result, '$.current.value.progress') AS REAL), 0) < 100
          THEN json_set(result, '$.current.value.progress', 100)
        ELSE result
      END,
      '$.current.value.unread'
    )
    WHERE result IS NOT NULL
      AND json_extract(result, '$.current.entity.kind') = 'reading'
      AND json_type(result, '$.current.value.unread') IS NOT NULL`);
  db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run(normalizedReadingKey, '1');
}

export interface DatabaseReclaimResult {
  autoVacuum: number;
  freelistBefore: number;
  freelistAfter: number;
  reclaimedPages: number;
  checkpoint: { busy: number; log: number; checkpointed: number };
}

export function reclaimDatabaseSpace(db: DatabaseSync, pages?: number, checkpointMode: 'PASSIVE' | 'TRUNCATE' = 'TRUNCATE'): DatabaseReclaimResult {
  if (pages !== undefined && (!Number.isSafeInteger(pages) || pages < 1)) {
    throw new RangeError('incremental_vacuum page count must be a positive safe integer');
  }
  const autoVacuum = Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined)?.auto_vacuum ?? 0);
  const freelistBefore = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0);
  if (autoVacuum === 2 && freelistBefore > 0) {
    if (pages !== undefined) {
      db.exec(`PRAGMA incremental_vacuum(${pages})`);
    } else {
      db.exec('PRAGMA incremental_vacuum');
    }
  }
  const freelistAfter = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0);
  const checkpointRow = db.prepare(checkpointMode === 'PASSIVE' ? 'PRAGMA wal_checkpoint(PASSIVE)' : 'PRAGMA wal_checkpoint(TRUNCATE)').get() as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;
  return {
    autoVacuum,
    freelistBefore,
    freelistAfter,
    reclaimedPages: Math.max(0, freelistBefore - freelistAfter),
    checkpoint: {
      busy: Number(checkpointRow?.busy ?? 0),
      log: Number(checkpointRow?.log ?? 0),
      checkpointed: Number(checkpointRow?.checkpointed ?? 0),
    },
  };
}

function compactCatalogLog(db: DatabaseSync): void {
  const key = 'migration:compact-catalog-log-v1';
  if (db.prepare('SELECT 1 FROM admin_settings WHERE key=?').get(key)) return;
  db.exec(`UPDATE catalog_changes SET entry=json_object(
    'id', chapter_id, 'sequence', sequence, 'manifest', json_object('identity', json(entry -> '$.manifest.identity')),
    'complete', json(entry -> '$.complete'), 'deleted', json(entry -> '$.deleted')
  ) WHERE CASE WHEN json_valid(entry) THEN json_type(entry,'$.revision') IS NOT NULL END`);
  db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run(key, '1');
}

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
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      transaction(db, () => { db.exec(schema); db.prepare('INSERT INTO schema_state VALUES(?)').run(checksum); });
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    transaction(db, () => {
      db.exec(readingStateSchema); db.exec(workMigrationSchema); db.exec(chapterNumberSchema); db.exec(workOverrideSchema); db.exec(userStateSchema);
      db.prepare('INSERT OR IGNORE INTO user_state_meta(singleton,workspace_id,epoch) VALUES(1,?,?)').run(randomUUID(), randomUUID());
      ensureUserStateSchema(db);
      db.exec(workSummarySchema); db.exec(changeIndexSchema);
      compactCatalogLog(db);
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
