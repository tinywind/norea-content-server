import type { DatabaseSync } from 'node:sqlite';
import { problem } from './db.ts';
import type { MigrationInventory, MigrationSnapshot } from './work-migrations.ts';

export interface MigrationChapterDecision {
  discardSourceContent?: true;
  sourceChapterPath: string;
  sourceChapterNumber: string | null;
  targetChapterPath: string | null;
  targetChapterNumber: string | null;
}
export type MigrationLineageChapterDecision = MigrationChapterDecision & {
  sourceMetadataVerified: boolean;
  targetMetadataVerified: boolean;
};
export type MigrationLineageMapping = {
  source: MigrationSnapshot['chapters'][number];
} & ({
  decision: 'copy-source' | 'keep-target';
  target: MigrationSnapshot['chapters'][number];
  targetInventory: MigrationInventory;
} | {
  decision: 'delete-source';
  target: null;
  targetInventory: null;
});
export interface WorkMigrationLineage {
  sequence: number;
  operationId: string;
  sourceWork: MigrationSnapshot['work'];
  targetWork: MigrationSnapshot['work'];
  deletedSource: { revision: string; sequence: number };
  mappings: MigrationLineageMapping[];
  chapterDecisions: MigrationLineageChapterDecision[];
  fullDecisionCoverage: boolean;
  active: boolean;
}
export type StoredWorkMigrationLineage = Omit<WorkMigrationLineage, 'sequence' | 'active'>;
export interface WorkMigrationPage { items: WorkMigrationLineage[]; cursor: number; hasMore: boolean }

/** Called inside the same transaction as source retirement and its receipt. */
export function recordWorkMigrationLineage(db: DatabaseSync, entry: StoredWorkMigrationLineage): void {
  if (!db.isTransaction) throw new Error('Migration lineage must commit with source retirement');
  db.prepare('INSERT INTO work_migration_lineage(operation_id,source_work_id,target_work_id,entry) VALUES(?,?,?,?)')
    .run(entry.operationId, entry.sourceWork.id, entry.targetWork.id, JSON.stringify(entry));
  db.prepare('INSERT INTO work_migration_events(operation_id,active) VALUES(?,1)').run(entry.operationId);
}

/** Explicit restoration revokes migration exclusions without reversing migrated user data. */
export function deactivateWorkMigrationsForSource(db: DatabaseSync, sourceId: string): void {
  if (!db.isTransaction) throw new Error('Migration revocation must commit with source restoration');
  const rows = db.prepare('SELECT l.operation_id FROM work_migration_lineage l JOIN work_migration_events e ON e.operation_id=l.operation_id WHERE l.source_work_id=? AND e.active=1 AND e.sequence=(SELECT max(sequence) FROM work_migration_events WHERE operation_id=l.operation_id)')
    .all(sourceId) as { operation_id: string }[];
  for (const row of rows) db.prepare('INSERT INTO work_migration_events(operation_id,active) VALUES(?,0)').run(row.operation_id);
}

/**
 * Coalesce superseded events before pagination: a new device must never replay
 * an earlier active event for an operation that has already been revoked.
 * The immutable lineage and append-only events remain available after source
 * deletion, target migration, database reopen, and ordinary metadata uploads.
 */
export function readWorkMigrations(db: DatabaseSync, after: number, limit: number, workId?: string): WorkMigrationPage {
  const head = (db.prepare('SELECT coalesce(max(sequence),0) AS n FROM work_migration_events').get() as { n: number }).n;
  if (after > head) throw problem(409, 'Migration cursor is ahead of the server');
  const related = workId ? 'WITH RECURSIVE related(work_id) AS (SELECT ? UNION SELECT CASE WHEN l.source_work_id=r.work_id THEN l.target_work_id ELSE l.source_work_id END FROM work_migration_lineage l JOIN related r ON l.source_work_id=r.work_id OR l.target_work_id=r.work_id) ' : '';
  const filter = workId ? ' AND (l.source_work_id IN (SELECT work_id FROM related) OR l.target_work_id IN (SELECT work_id FROM related))' : '';
  const rows = db.prepare(related + 'SELECT l.entry,e.sequence,e.active FROM work_migration_events e JOIN work_migration_lineage l ON l.operation_id=e.operation_id WHERE e.sequence>? AND e.sequence=(SELECT max(sequence) FROM work_migration_events WHERE operation_id=e.operation_id)' + filter + ' ORDER BY e.sequence LIMIT ?')
    .all(...(workId ? [workId] : []), after, limit + 1) as { entry: string; sequence: number; active: number }[];
  const items = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.entry) as StoredWorkMigrationLineage, sequence: row.sequence, active: Boolean(row.active) }));
  return { items, cursor: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
}

/** Current state for resumable clients to recheck immediately before applying. */
export function readWorkMigration(db: DatabaseSync, operationId: string): WorkMigrationLineage {
  const row = db.prepare('SELECT l.entry,e.sequence,e.active FROM work_migration_lineage l JOIN work_migration_events e ON e.operation_id=l.operation_id WHERE l.operation_id=? ORDER BY e.sequence DESC LIMIT 1')
    .get(operationId) as { entry: string; sequence: number; active: number } | undefined;
  if (!row) throw problem(404, 'Work migration not found');
  return { ...JSON.parse(row.entry) as StoredWorkMigrationLineage, sequence: row.sequence, active: Boolean(row.active) };
}
