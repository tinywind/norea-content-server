import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticate } from './auth.ts';
import { parseChapterComposition, type ChapterCompositionV1 } from './chapter-composition.ts';
import { problem, reclaimDatabaseSpace, transaction, type DatabaseReclaimResult } from './db.ts';
import {
  USER_STATE_MAX_BYTES,
  parseUserStateOperation as parseOperation, userStateEntityKey, userStateWorkKey,
  type UserStateEntity, type UserStateKind, type UserStateValue, type UserStateValueMap,
  type UserStateOperation, type UserStateRecord, type UserStateMergeResult,
  type UserStateRetentionState, type UserStateSnapshotResponse,
} from './user-state-protocol.ts';
import type { StoredWorkMigrationLineage } from './work-migration-lineage.ts';
export { USER_STATE_MAX_BYTES, userStateEntityKey, parseUserStateEntity, parseUserStateValue } from './user-state-protocol.ts';
export type {
  UserStateEntity, UserStateKind, UserStateValue, UserStateOperation,
  UserStateRecord, UserStateMergeResult, UserStateRetentionState, UserStateSnapshotResponse,
} from './user-state-protocol.ts';

export const DEFAULT_USER_STATE_SUPERSEDED_GRACE_MS = 7 * 86_400_000;
export const DEFAULT_USER_STATE_OP_BODY_RETENTION_MS = 86_400_000;
export const DEFAULT_USER_STATE_OP_FINGERPRINT_RETENTION_MS = 30 * 86_400_000;
export const DEFAULT_USER_STATE_COMPACTION_INTERVAL_MS = 6 * 3_600_000;
export const DEFAULT_USER_STATE_TOMBSTONE_GRACE_MS = 30 * 86_400_000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface UserStateRetentionConfig {
  pruneNonLibraryReading: { enabled: boolean; days: number };
  stripReadingTimestamps: { enabled: boolean; days: number };
  slidingWindow: { enabled: boolean; months: number };
  tombstoneGc: { graceDays: number };
}

export interface UserStateRetentionPatch {
  pruneNonLibraryReading?: { enabled?: boolean; days?: number };
  stripReadingTimestamps?: { enabled?: boolean; days?: number };
  slidingWindow?: { enabled?: boolean; months?: number };
  tombstoneGc?: { graceDays?: number };
}

export const DEFAULT_USER_STATE_RETENTION_CONFIG: UserStateRetentionConfig = {
  pruneNonLibraryReading: { enabled: false, days: 90 },
  stripReadingTimestamps: { enabled: false, days: 180 },
  slidingWindow: { enabled: false, months: 12 },
  tombstoneGc: { graceDays: 30 },
};

const RETENTION_SETTING_KEY = 'userStateRetention';
const RETENTION_WRITER = { id: 'server-retention', name: 'Server retention' };
const USER_STATE_TABLE_NAMES = [
  'user_state_meta',
  'user_state_records',
  'user_state_changes',
  'user_state_operations',
  'user_state_category_aliases',
] as const;
const USER_STATE_KINDS: readonly UserStateKind[] = [
  'reading',
  'bookmark',
  'library',
  'membership',
  'category',
  'resume',
  'composition',
];

const RESPONSE_RESERVE = 4096;
interface Namespace { workspaceId: string; epoch: string }
interface Actor { id: string; name: string }
interface RetentionMetadata {
  compactedThrough: number;
  seedBlocked: boolean;
  seedAllowed: boolean;
  seedCutoffAt: number | null;
  lastGcAt: number | null;
}
type JsonObject = Record<string, unknown>;
type CategoryValue = Extract<UserStateValue, { deleted: boolean }>;

function object(value: unknown, keys: readonly string[], required: readonly string[] = keys): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'User state: expected an object');
  const result = value as JsonObject;
  if (Object.keys(result).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(result, key))) {
    throw problem(400, 'User state: missing or unexpected fields');
  }
  return result;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw problem(400, 'User state: invalid identifier');
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw problem(400, 'User state: invalid integer');
  return value;
}

function namespace(db: DatabaseSync): Namespace {
  const value = db.prepare('SELECT workspace_id,epoch FROM user_state_meta WHERE singleton=1').get() as { workspace_id: string; epoch: string } | undefined;
  if (!value) throw problem(503, 'User state: namespace is unavailable');
  return { workspaceId: value.workspace_id, epoch: value.epoch };
}
export function headRevision(db: DatabaseSync): number {
  const row = db.prepare(`SELECT MAX(
    COALESCE((SELECT head_revision FROM user_state_meta WHERE singleton=1), 0),
    COALESCE((SELECT MAX(revision) FROM user_state_changes), 0)
  ) AS revision`).get() as { revision: number } | undefined;
  return Number(row?.revision ?? 0);
}
export function compactedThrough(db: DatabaseSync): number {
  const row = db.prepare('SELECT compacted_through FROM user_state_meta WHERE singleton=1').get() as { compacted_through?: number } | undefined;
  return Number(row?.compacted_through ?? 0);
}
export function readRetentionMetadata(db: DatabaseSync): RetentionMetadata {
  const row = db.prepare('SELECT compacted_through, seed_blocked, seed_cutoff_at, last_gc_at FROM user_state_meta WHERE singleton=1').get() as {
    compacted_through?: number;
    seed_blocked?: number;
    seed_cutoff_at?: number | null;
    last_gc_at?: number | null;
  } | undefined;
  const seedBlocked = Boolean(row?.seed_blocked);
  return {
    compactedThrough: Number(row?.compacted_through ?? 0),
    seedBlocked,
    seedAllowed: !seedBlocked,
    seedCutoffAt: row?.seed_cutoff_at === null || row?.seed_cutoff_at === undefined ? null : Number(row.seed_cutoff_at),
    lastGcAt: row?.last_gc_at === null || row?.last_gc_at === undefined ? null : Number(row.last_gc_at),
  };
}
export function toEpochMs(ts: number, referenceNowMs: number): number {
  return ts < 1e11 && referenceNowMs >= 1e11 ? ts * 1000 : ts;
}
export function computeSlidingWindowCutoffMs(nowMs: number, months: number): number {
  const date = new Date(nowMs);
  const target = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() - months,
    1,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
  const daysInMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), daysInMonth));
  return target.getTime();
}
function defaultRetentionConfig(): UserStateRetentionConfig {
  return {
    pruneNonLibraryReading: { ...DEFAULT_USER_STATE_RETENTION_CONFIG.pruneNonLibraryReading },
    stripReadingTimestamps: { ...DEFAULT_USER_STATE_RETENTION_CONFIG.stripReadingTimestamps },
    slidingWindow: { ...DEFAULT_USER_STATE_RETENTION_CONFIG.slidingWindow },
    tombstoneGc: { ...DEFAULT_USER_STATE_RETENTION_CONFIG.tombstoneGc },
  };
}
function validPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
export function readUserStateRetentionConfig(db: DatabaseSync): UserStateRetentionConfig {
  const defaults = defaultRetentionConfig();
  const row = db.prepare('SELECT value FROM admin_settings WHERE key=?').get(RETENTION_SETTING_KEY) as { value: string } | undefined;
  if (!row) return defaults;
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(row.value) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
    parsed = raw as Record<string, unknown>;
  } catch {
    return defaults;
  }
  const p2a = parsed.pruneNonLibraryReading as Record<string, unknown> | undefined;
  const p2b = parsed.stripReadingTimestamps as Record<string, unknown> | undefined;
  const p2c = parsed.slidingWindow as Record<string, unknown> | undefined;
  const gc = parsed.tombstoneGc as Record<string, unknown> | undefined;
  return {
    pruneNonLibraryReading: {
      enabled: typeof p2a?.enabled === 'boolean' ? p2a.enabled : defaults.pruneNonLibraryReading.enabled,
      days: validPositiveInt(p2a?.days, defaults.pruneNonLibraryReading.days, 1, 36500),
    },
    stripReadingTimestamps: {
      enabled: typeof p2b?.enabled === 'boolean' ? p2b.enabled : defaults.stripReadingTimestamps.enabled,
      days: validPositiveInt(p2b?.days, defaults.stripReadingTimestamps.days, 1, 36500),
    },
    slidingWindow: {
      enabled: typeof p2c?.enabled === 'boolean' ? p2c.enabled : defaults.slidingWindow.enabled,
      months: validPositiveInt(p2c?.months, defaults.slidingWindow.months, 1, 1200),
    },
    tombstoneGc: {
      graceDays: validPositiveInt(gc?.graceDays, defaults.tombstoneGc.graceDays, 0, 3650),
    },
  };
}
export function updateUserStateRetentionConfig(
  db: DatabaseSync,
  patch: UserStateRetentionPatch,
  now = Date.now(),
): UserStateRetentionConfig {
  return transaction(db, () => {
    const current = readUserStateRetentionConfig(db);
    const next: UserStateRetentionConfig = {
      pruneNonLibraryReading: {
        enabled: patch.pruneNonLibraryReading?.enabled ?? current.pruneNonLibraryReading.enabled,
        days: patch.pruneNonLibraryReading?.days ?? current.pruneNonLibraryReading.days,
      },
      stripReadingTimestamps: {
        enabled: patch.stripReadingTimestamps?.enabled ?? current.stripReadingTimestamps.enabled,
        days: patch.stripReadingTimestamps?.days ?? current.stripReadingTimestamps.days,
      },
      slidingWindow: {
        enabled: patch.slidingWindow?.enabled ?? current.slidingWindow.enabled,
        months: patch.slidingWindow?.months ?? current.slidingWindow.months,
      },
      tombstoneGc: {
        graceDays: patch.tombstoneGc?.graceDays ?? current.tombstoneGc.graceDays,
      },
    };
    db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(RETENTION_SETTING_KEY, JSON.stringify(next));
    const seedCutoffAt = next.slidingWindow.enabled
      ? computeSlidingWindowCutoffMs(now, next.slidingWindow.months)
      : null;
    db.prepare('UPDATE user_state_meta SET seed_cutoff_at=? WHERE singleton=1').run(seedCutoffAt);
    return next;
  });
}
function assertNamespace(db: DatabaseSync, raw: JsonObject): Namespace {
  const expected = namespace(db);
  if (identifier(raw.workspaceId) !== expected.workspaceId || identifier(raw.epoch) !== expected.epoch) {
    throw problem(409, 'User state: workspace or epoch changed; reconnect without discarding pending edits');
  }
  return expected;
}
function actor(db: DatabaseSync, request: FastifyRequest): Actor {
  const identity = authenticate(db, request);
  if (identity.kind !== 'device') throw problem(403, 'Device key required');
  const row = db.prepare('SELECT device_name FROM devices WHERE id=?').get(identity.id) as { device_name: string };
  return { id: identity.id, name: row.device_name.replace(/\u0000/g, '') };
}
function storedRecord(db: DatabaseSync, entity: UserStateEntity): UserStateRecord | null {
  const row = db.prepare('SELECT record FROM user_state_records WHERE entity_key=?').get(userStateEntityKey(entity)) as { record: string } | undefined;
  return row ? JSON.parse(row.record) as UserStateRecord : null;
}
/** The merged current document supplies shared manual choices for content metadata overlays. */
export function readUserStateComposition(db: DatabaseSync, identity: { pluginId: string; novelId: string; novelPath: string }): ChapterCompositionV1 | null {
  const entity: UserStateEntity = { kind: 'composition', work: { pluginId: identity.pluginId, sourceNovelId: identity.novelId, novelPath: identity.novelPath, name: '' } };
  const saved = storedRecord(db, entity);
  return saved ? parseChapterComposition((saved.value as { composition: ChapterCompositionV1 }).composition) : null;
}

function categoryId(db: DatabaseSync, id: string): string {
  // Aliases are permanently flattened at creation; no recursive user-defined links.
  return (db.prepare('SELECT canonical_id FROM user_state_category_aliases WHERE alias_id=?').get(id) as { canonical_id: string } | undefined)?.canonical_id ?? id;
}
function canonicalEntity(db: DatabaseSync, entity: UserStateEntity): { entity: UserStateEntity; categoryAlias?: { from: string; to: string } } {
  if (entity.kind !== 'category' && entity.kind !== 'membership') return { entity };
  const to = categoryId(db, entity.categoryId);
  return to === entity.categoryId ? { entity } : { entity: { ...entity, categoryId: to }, categoryAlias: { from: entity.categoryId, to } };
}
function categoryNamed(db: DatabaseSync, name: string): UserStateRecord | null {
  const row = db.prepare("SELECT record FROM user_state_records WHERE kind='category' AND category_name=? AND category_deleted=0").get(name) as { record: string } | undefined;
  return row ? JSON.parse(row.record) as UserStateRecord : null;
}
function publish(db: DatabaseSync, operation: UserStateOperation, entity: UserStateEntity, writer: Actor, now = Date.now()): UserStateRecord {
  const key = userStateEntityKey(entity);
  const previous = db.prepare('SELECT revision FROM user_state_records WHERE entity_key=?').get(key) as { revision: number } | undefined;
  const revision = headRevision(db) + 1;
  const record: UserStateRecord = { entity, value: operation.value, revision, operationId: operation.operationId, updatedAt: now, deviceId: writer.id, deviceName: writer.name };
  const serialized = JSON.stringify(record);
  if (previous) {
    db.prepare('UPDATE user_state_changes SET superseded_at=? WHERE revision=? AND superseded_at IS NULL').run(now, previous.revision);
  }
  db.prepare('INSERT INTO user_state_changes(revision,entity_key,record) VALUES(?,?,?)').run(revision, key, serialized);
  db.prepare('UPDATE user_state_meta SET head_revision=MAX(head_revision,?) WHERE singleton=1').run(revision);
  const category = entity.kind === 'category' ? operation.value as CategoryValue : null;
  const membership = entity.kind === 'membership' ? operation.value as { included: boolean } : null;
  db.prepare(`INSERT INTO user_state_records(
    entity_key,kind,category_name,category_deleted,membership_category_id,membership_included,revision,record,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_key) DO UPDATE SET
    kind=excluded.kind,category_name=excluded.category_name,category_deleted=excluded.category_deleted,
    membership_category_id=excluded.membership_category_id,membership_included=excluded.membership_included,
    revision=excluded.revision,record=excluded.record,updated_at=excluded.updated_at`)
    .run(key, entity.kind, category?.name ?? null, category ? Number(category.deleted) : null,
      entity.kind === 'membership' ? entity.categoryId : null, membership ? Number(membership.included) : null, revision, serialized, now);
  return record;
}
function ownershipConflict(current: UserStateRecord | null, entity: UserStateEntity): boolean {
  if (!current || (entity.kind !== 'reading' && entity.kind !== 'bookmark')) return false;
  const previous = current.entity;
  return (previous.kind === 'reading' || previous.kind === 'bookmark') && previous.chapter.compositionEntryId !== undefined &&
    entity.chapter.compositionEntryId !== undefined && previous.chapter.compositionEntryId !== entity.chapter.compositionEntryId;
}
function excludeDeletedCategoryMemberships(db: DatabaseSync, category: string, deletion: UserStateOperation, writer: Actor, now: number): void {
  // Advance each known membership's revision. Without this, restoring a category
  // could acknowledge an old true value as unchanged and resurrect stale intent.
  const keys = db.prepare("SELECT entity_key FROM user_state_records WHERE kind='membership' AND membership_category_id=? AND membership_included=1 ORDER BY entity_key")
    .all(category) as { entity_key: string }[];
  const lookup = db.prepare('SELECT record FROM user_state_records WHERE entity_key=?');
  for (const { entity_key: key } of keys) {
    const current = JSON.parse((lookup.get(key) as { record: string }).record) as UserStateRecord;
    const operationId = 'category-delete:' + createHash('sha256').update(JSON.stringify([writer.id, deletion.operationId, key])).digest('hex');
    const operation: UserStateOperation = { operationId, entity: current.entity, baseRevision: current.revision, value: { included: false } };
    publish(db, operation, current.entity, writer, now);
  }
}
function applyOperation(
  db: DatabaseSync,
  operation: UserStateOperation,
  writer: Actor,
  now: number,
  retention?: RetentionMetadata,
): UserStateMergeResult {
  const canonical = canonicalEntity(db, operation.entity), entity = canonical.entity;
  const current = storedRecord(db, entity);
  const result = (status: UserStateMergeResult['status'], record = current, reason?: string): UserStateMergeResult => ({
    operationId: operation.operationId, status, current: record,
    ...(reason === undefined ? {} : { reason }), ...(canonical.categoryAlias ? { categoryAlias: canonical.categoryAlias } : {}),
  });
  if (ownershipConflict(current, entity)) {
    return result('conflict', current, 'chapter-ownership-conflict');
  }
  if (operation.seed && current) return result('seed-skipped');
  if (operation.seed && !current) {
    const meta = retention ?? readRetentionMetadata(db);
    if (meta.seedBlocked) return result('seed-skipped', null);
    if (meta.seedCutoffAt !== null) {
      if (entity.kind === 'reading') {
        const value = operation.value as UserStateValueMap['reading'];
        if (value.readAt !== null && toEpochMs(value.readAt, now) < meta.seedCutoffAt) {
          return result('seed-skipped', null);
        }
      } else if (entity.kind === 'resume') {
        const value = operation.value as UserStateValueMap['resume'];
        const candidates: number[] = [];
        if (value.openedAt !== null) candidates.push(toEpochMs(value.openedAt, now));
        if (value.anchor?.savedAt !== undefined) candidates.push(toEpochMs(value.anchor.savedAt, now));
        if (candidates.length > 0 && Math.max(...candidates) < meta.seedCutoffAt) {
          return result('seed-skipped', null);
        }
      }
    }
  }
  if (entity.kind === 'category') {
    const value = operation.value as CategoryValue;
    const sameName = value.deleted ? null : categoryNamed(db, value.name);
    if (sameName && userStateEntityKey(sameName.entity) !== userStateEntityKey(entity)) {
      if (!current && operation.baseRevision === 0 && !canonical.categoryAlias && sameName.entity.kind === 'category') {
        const to = sameName.entity.categoryId;
        db.prepare('INSERT INTO user_state_category_aliases(alias_id,canonical_id) VALUES(?,?)').run(entity.categoryId, to);
        return { operationId: operation.operationId, status: 'aliased', current: sameName, categoryAlias: { from: entity.categoryId, to } };
      }
      return result('conflict', current, 'category-name-exists');
    }
  }
  if (entity.kind === 'membership' && (operation.value as { included: boolean }).included) {
    const categoryEntity: UserStateEntity = { kind: 'category', categoryId: entity.categoryId };
    const category = storedRecord(db, categoryEntity);
    if (!category) return result('conflict', current, 'category-missing');
    if ((category.value as CategoryValue).deleted) {
      const categoryValue = category.value as CategoryValue;
      const named = categoryNamed(db, categoryValue.name);
      if (named && userStateEntityKey(named.entity) !== userStateEntityKey(categoryEntity)) {
        return result('conflict', current, 'category-name-exists');
      }
      const restoreId = 'category-restore:' + createHash('sha256')
        .update(JSON.stringify([writer.id, operation.operationId, entity.categoryId])).digest('hex');
      const value = { ...categoryValue, deleted: false };
      publish(db, { operationId: restoreId, entity: categoryEntity, baseRevision: category.revision, value }, categoryEntity, writer, now);
    }
  }
  if (current && canonicalize(current.value) === canonicalize(operation.value)) return result('unchanged');
  // One workspace represents one person's state across devices. Explicit edits are
  // ordered by the server commit revision; a stale observed base never creates a
  // user-facing conflict. baseRevision remains diagnostic/idempotency metadata.
  // Keep an already known optional ownership proof when an older client lacks it.
  const publishedEntity = (entity.kind === 'reading' || entity.kind === 'bookmark') &&
    (current?.entity.kind === 'reading' || current?.entity.kind === 'bookmark') && !entity.chapter.compositionEntryId && current.entity.chapter.compositionEntryId
    ? { ...entity, chapter: { ...entity.chapter, compositionEntryId: current.entity.chapter.compositionEntryId } } : entity;
  const published = publish(db, operation, publishedEntity, writer, now);
  if (entity.kind === 'category' && (operation.value as CategoryValue).deleted) {
    excludeDeletedCategoryMemberships(db, entity.categoryId, operation, writer, now);
  }
  return result('applied', published);
}

export function compactUserStateChanges(
  db: DatabaseSync,
  now = Date.now(),
  graceMs = DEFAULT_USER_STATE_SUPERSEDED_GRACE_MS,
): number {
  const cutoff = now - Math.max(0, graceMs);
  const run = () => Number(
    db.prepare('DELETE FROM user_state_changes WHERE superseded_at IS NOT NULL AND superseded_at < ?').run(cutoff).changes,
  );
  return db.isTransaction ? run() : transaction(db, run);
}

export interface UserStateOperationCleanupResult {
  nulledBodies: number;
  deletedOperations: number;
}

export function cleanupUserStateOperations(
  db: DatabaseSync,
  now = Date.now(),
  bodyRetentionMs = DEFAULT_USER_STATE_OP_BODY_RETENTION_MS,
  fingerprintRetentionMs = DEFAULT_USER_STATE_OP_FINGERPRINT_RETENTION_MS,
): UserStateOperationCleanupResult {
  const clampedBodyMs = Math.max(0, bodyRetentionMs);
  const clampedFingerprintMs = Math.max(clampedBodyMs, Math.max(0, fingerprintRetentionMs));
  const bodyCutoff = now - clampedBodyMs;
  const fingerprintCutoff = now - clampedFingerprintMs;
  const run = () => {
    const nulledBodies = Number(
      db.prepare('UPDATE user_state_operations SET result = NULL WHERE result IS NOT NULL AND created_at < ?').run(bodyCutoff).changes,
    );
    const deletedOperations = Number(
      db.prepare('DELETE FROM user_state_operations WHERE created_at < ?').run(fingerprintCutoff).changes,
    );
    return { nulledBodies, deletedOperations };
  };
  return db.isTransaction ? run() : transaction(db, run);
}

export interface UserStateMaintenanceOptions {
  supersededGraceMs?: number;
  operationBodyRetentionMs?: number;
  operationFingerprintRetentionMs?: number;
  tombstoneGraceMs?: number;
  vacuumPagesPerPass?: number;
  checkpointMode?: 'PASSIVE' | 'TRUNCATE';
  now?: () => number;
}

export interface UserStateMaintenanceResult {
  prunedNonLibraryReading: number;
  prunedSlidingWindow: number;
  strippedReadingTimestamps: number;
  gcDeletedRecords: number;
  gcDeletedAliases: number;
  deletedChanges: number;
  nulledOperationBodies: number;
  deletedOperations: number;
  reclaimed: DatabaseReclaimResult | null;
}

export interface UserStateTableStat {
  name: string;
  rows: number;
  pages: number;
  bytes: number;
  tableBytes: number;
  indexBytes: number;
  payloadBytes: number;
}

export interface UserStateKindStat {
  total: number;
  active: number;
  tombstones: number;
}

export interface AdminUserStateStats {
  workspaceId: string;
  epoch: string;
  headRevision: number;
  compactedThrough: number;
  seedAllowed: boolean;
  seedCutoffAt: number | null;
  lastGcAt: number | null;
  retention: UserStateRetentionConfig;
  autoVacuum: number;
  freelistPages: number;
  pageSize: number;
  pageCount: number;
  dbBytes: number;
  walBytes: number;
  tables: UserStateTableStat[];
  records: {
    total: number;
    active: number;
    tombstones: number;
    tombstonesEligibleForGc: number;
    byKind: Record<UserStateKind, UserStateKindStat>;
  };
  changes: {
    total: number;
    active: number;
    superseded: number;
    compactable: number;
  };
  operations: {
    total: number;
    withResult: number;
    prunableBodies: number;
    prunableFingerprints: number;
  };
  categoryAliases: {
    total: number;
    dangling: number;
  };
}

function readTransaction<T>(db: DatabaseSync, action: () => T): T {
  if (db.isTransaction) return action();
  db.exec('BEGIN');
  try {
    const value = action();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function workKeyFromEntityKey(entityKey: string): string | null {
  try {
    const parsed = JSON.parse(entityKey) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed[0] === 'category') return null;
    return typeof parsed[1] === 'string' ? parsed[1] : null;
  } catch {
    return null;
  }
}

function workKeysForIdentity(identity: { pluginId: string; novelId?: string | null; novelPath: string }): string[] {
  const keys: string[] = [
    userStateWorkKey({ pluginId: identity.pluginId, sourceNovelId: null, novelPath: identity.novelPath, name: '' }),
  ];
  if (typeof identity.novelId === 'string' && identity.novelId.trim()) {
    keys.push(userStateWorkKey({ pluginId: identity.pluginId, sourceNovelId: identity.novelId, novelPath: identity.novelPath, name: '' }));
  }
  return keys;
}

function readingActivityMs(value: UserStateValueMap['reading'], updatedAt: number, now: number): number {
  return value.readAt !== null ? toEpochMs(value.readAt, now) : updatedAt;
}

function resumeActivityMs(value: UserStateValueMap['resume'], updatedAt: number, now: number): number {
  const candidates: number[] = [];
  if (value.openedAt !== null) candidates.push(toEpochMs(value.openedAt, now));
  if (value.anchor?.savedAt !== undefined) candidates.push(toEpochMs(value.anchor.savedAt, now));
  return candidates.length ? Math.max(...candidates) : updatedAt;
}

function isTombstoneValue(kind: UserStateKind, value: UserStateValue): boolean {
  switch (kind) {
    case 'reading': {
      const v = value as UserStateValueMap['reading'];
      return v.progress === 0 && v.readAt === null;
    }
    case 'bookmark':
      return (value as UserStateValueMap['bookmark']).bookmarked === false;
    case 'library':
      return (value as UserStateValueMap['library']).inLibrary === false;
    case 'membership':
      return (value as UserStateValueMap['membership']).included === false;
    case 'category':
      return (value as UserStateValueMap['category']).deleted === true;
    case 'resume': {
      const v = value as UserStateValueMap['resume'];
      return v.chapter === null && v.anchor === null && v.openedAt === null;
    }
    case 'composition':
      return false;
  }
}

function applyPruneNonLibraryReading(
  db: DatabaseSync,
  now: number,
  days: number,
): number {
  const activeLibraryWorks = new Set<string>();
  const libraryRows = db.prepare("SELECT entity_key, record FROM user_state_records WHERE kind='library'").all() as {
    entity_key: string;
    record: string;
  }[];
  for (const row of libraryRows) {
    const record = JSON.parse(row.record) as UserStateRecord;
    if ((record.value as UserStateValueMap['library']).inLibrary === true) {
      const workKey = workKeyFromEntityKey(row.entity_key);
      if (workKey !== null) activeLibraryWorks.add(workKey);
    }
  }
  const cutoff = now - Math.max(1, days) * 86_400_000;
  const candidates = db.prepare(
    "SELECT entity_key, kind, revision, record, updated_at FROM user_state_records WHERE kind IN ('reading', 'resume')",
  ).all() as { entity_key: string; kind: 'reading' | 'resume'; revision: number; record: string; updated_at: number | null }[];
  const deleteRecord = db.prepare('DELETE FROM user_state_records WHERE entity_key=?');
  const deleteChanges = db.prepare('DELETE FROM user_state_changes WHERE entity_key=?');
  let pruned = 0;
  let maxDeletedRev = 0;
  for (const row of candidates) {
    const workKey = workKeyFromEntityKey(row.entity_key);
    if (workKey === null || activeLibraryWorks.has(workKey)) continue;
    const record = JSON.parse(row.record) as UserStateRecord;
    const updatedAt = row.updated_at ?? record.updatedAt ?? 0;
    const activityMs = row.kind === 'reading'
      ? readingActivityMs(record.value as UserStateValueMap['reading'], updatedAt, now)
      : resumeActivityMs(record.value as UserStateValueMap['resume'], updatedAt, now);
    if (activityMs < cutoff) {
      deleteRecord.run(row.entity_key);
      deleteChanges.run(row.entity_key);
      pruned++;
      if (row.revision > maxDeletedRev) maxDeletedRev = row.revision;
    }
  }
  if (pruned > 0) {
    db.prepare(
      'UPDATE user_state_meta SET compacted_through = MIN(head_revision, MAX(compacted_through, ?)), seed_blocked = 1 WHERE singleton = 1',
    ).run(maxDeletedRev);
  }
  return pruned;
}

function applySlidingWindowRetention(
  db: DatabaseSync,
  now: number,
  months: number,
): number {
  const seedCutoffAt = computeSlidingWindowCutoffMs(now, months);
  db.prepare('UPDATE user_state_meta SET seed_cutoff_at = ? WHERE singleton = 1').run(seedCutoffAt);
  const candidates = db.prepare(
    "SELECT entity_key, kind, revision, record, updated_at FROM user_state_records WHERE kind IN ('reading', 'resume')",
  ).all() as { entity_key: string; kind: 'reading' | 'resume'; revision: number; record: string; updated_at: number | null }[];
  const deleteRecord = db.prepare('DELETE FROM user_state_records WHERE entity_key=?');
  const deleteChanges = db.prepare('DELETE FROM user_state_changes WHERE entity_key=?');
  let pruned = 0;
  let maxDeletedRev = 0;
  for (const row of candidates) {
    const record = JSON.parse(row.record) as UserStateRecord;
    const updatedAt = row.updated_at ?? record.updatedAt ?? 0;
    const activityMs = row.kind === 'reading'
      ? readingActivityMs(record.value as UserStateValueMap['reading'], updatedAt, now)
      : resumeActivityMs(record.value as UserStateValueMap['resume'], updatedAt, now);
    if (activityMs < seedCutoffAt) {
      deleteRecord.run(row.entity_key);
      deleteChanges.run(row.entity_key);
      pruned++;
      if (row.revision > maxDeletedRev) maxDeletedRev = row.revision;
    }
  }
  if (pruned > 0) {
    db.prepare(
      'UPDATE user_state_meta SET compacted_through = MIN(head_revision, MAX(compacted_through, ?)) WHERE singleton = 1',
    ).run(maxDeletedRev);
  }
  return pruned;
}

function applyStripReadingTimestamps(
  db: DatabaseSync,
  now: number,
  days: number,
): number {
  const cutoff = now - Math.max(1, days) * 86_400_000;
  const candidates = db.prepare(
    "SELECT entity_key, kind, revision, record, updated_at FROM user_state_records WHERE kind IN ('reading', 'resume') ORDER BY revision",
  ).all() as { entity_key: string; kind: 'reading' | 'resume'; revision: number; record: string; updated_at: number | null }[];
  let stripped = 0;
  for (const row of candidates) {
    const record = JSON.parse(row.record) as UserStateRecord;
    const updatedAt = row.updated_at ?? record.updatedAt ?? 0;
    const activityMs = row.kind === 'reading'
      ? readingActivityMs(record.value as UserStateValueMap['reading'], updatedAt, now)
      : resumeActivityMs(record.value as UserStateValueMap['resume'], updatedAt, now);
    if (activityMs >= cutoff) continue;
    if (row.kind === 'reading') {
      const value = record.value as UserStateValueMap['reading'];
      if (value.readAt === null) continue;
      const operationId = 'retention-strip:' + createHash('sha256').update(JSON.stringify([row.entity_key, record.revision])).digest('hex');
      publish(
        db,
        { operationId, entity: record.entity, baseRevision: record.revision, value: { progress: value.progress, readAt: null } },
        record.entity,
        RETENTION_WRITER,
        now,
      );
      stripped++;
    } else {
      const value = record.value as UserStateValueMap['resume'];
      if (value.chapter === null && value.anchor === null && value.openedAt === null) continue;
      const operationId = 'retention-strip:' + createHash('sha256').update(JSON.stringify([row.entity_key, record.revision])).digest('hex');
      publish(
        db,
        { operationId, entity: record.entity, baseRevision: record.revision, value: { chapter: null, anchor: null, openedAt: null } },
        record.entity,
        RETENTION_WRITER,
        now,
      );
      stripped++;
    }
  }
  return stripped;
}

export function gcPhysicalUserStateRecords(
  db: DatabaseSync,
  now = Date.now(),
  tombstoneGraceMs?: number,
): { deletedRecords: number; deletedAliases: number } {
  const run = () => {
    const config = readUserStateRetentionConfig(db);
    const effectiveGraceMs = tombstoneGraceMs ?? config.tombstoneGc.graceDays * 86_400_000;
    const cutoff = now - Math.max(0, effectiveGraceMs);

    const liveWorkIds = new Set<string>();
    const liveWorkKeys = new Set<string>();
    const liveWorkRows = db.prepare(`
      SELECT id, plugin_id AS pluginId, novel_id AS novelId, novel_path AS novelPath FROM work_summaries
      WHERE NOT EXISTS (SELECT 1 FROM work_tombstones t WHERE t.work_id = work_summaries.id AND t.deleted = 1)
    `).all() as { id: string; pluginId: string; novelId: string; novelPath: string }[];
    for (const row of liveWorkRows) {
      liveWorkIds.add(row.id);
      for (const workKey of workKeysForIdentity(row)) {
        liveWorkKeys.add(workKey);
      }
    }

    const retiredWorkKeys = new Set<string>();
    const retiredRows = db.prepare(`
      SELECT l.source_work_id, l.entry
      FROM work_migration_lineage l
      JOIN work_migration_events e ON e.operation_id = l.operation_id
      WHERE e.sequence = (SELECT MAX(sequence) FROM work_migration_events WHERE operation_id = l.operation_id)
        AND e.active = 1
        AND e.retired_at IS NOT NULL
        AND e.retired_at < ?
    `).all(cutoff) as { source_work_id: string; entry: string }[];
    for (const row of retiredRows) {
      if (liveWorkIds.has(row.source_work_id)) continue;
      const lineage = JSON.parse(row.entry) as StoredWorkMigrationLineage;
      for (const workKey of workKeysForIdentity(lineage.sourceWork.identity)) {
        if (!liveWorkKeys.has(workKey)) retiredWorkKeys.add(workKey);
      }
    }

    const records = db.prepare(`
      SELECT entity_key, kind, revision, record,
        COALESCE(updated_at, CAST(json_extract(record, '$.updatedAt') AS INTEGER), 0) AS effective_updated_at
      FROM user_state_records
    `).all() as { entity_key: string; kind: UserStateKind; revision: number; record: string; effective_updated_at: number }[];
    const deleteRecord = db.prepare('DELETE FROM user_state_records WHERE entity_key=?');
    const deleteChanges = db.prepare('DELETE FROM user_state_changes WHERE entity_key=?');
    const deleteAliasesByCanonical = db.prepare('DELETE FROM user_state_category_aliases WHERE canonical_id=?');
    let deletedRecords = 0;
    let deletedAliases = 0;
    let maxDeletedRev = 0;
    for (const row of records) {
      const parsed = JSON.parse(row.record) as UserStateRecord;
      const isTombstone = isTombstoneValue(row.kind, parsed.value);
      const expiredTombstone = isTombstone && row.effective_updated_at < cutoff;
      const workKey = row.kind === 'category' ? null : workKeyFromEntityKey(row.entity_key);
      const retiredOriginal = row.kind !== 'category' && workKey !== null && retiredWorkKeys.has(workKey) && !liveWorkKeys.has(workKey);
      if (!expiredTombstone && !retiredOriginal) continue;
      deleteRecord.run(row.entity_key);
      deleteChanges.run(row.entity_key);
      if (row.kind === 'category' && parsed.entity.kind === 'category') {
        deletedAliases += Number(deleteAliasesByCanonical.run(parsed.entity.categoryId).changes);
      }
      deletedRecords++;
      if (row.revision > maxDeletedRev) maxDeletedRev = row.revision;
    }

    const liveCategoryKeys = new Set(
      (db.prepare("SELECT entity_key FROM user_state_records WHERE kind='category'").all() as { entity_key: string }[]).map(
        row => row.entity_key,
      ),
    );
    const aliases = db.prepare('SELECT alias_id, canonical_id FROM user_state_category_aliases').all() as {
      alias_id: string;
      canonical_id: string;
    }[];
    const deleteAlias = db.prepare('DELETE FROM user_state_category_aliases WHERE alias_id=?');
    for (const alias of aliases) {
      const targetKey = userStateEntityKey({ kind: 'category', categoryId: alias.canonical_id });
      if (!liveCategoryKeys.has(targetKey)) {
        deletedAliases += Number(deleteAlias.run(alias.alias_id).changes);
      }
    }

    if (deletedRecords > 0) {
      db.prepare(
        'UPDATE user_state_meta SET compacted_through = MIN(head_revision, MAX(compacted_through, ?)), seed_blocked = 1 WHERE singleton = 1',
      ).run(maxDeletedRev);
    }
    db.prepare('UPDATE user_state_meta SET last_gc_at = ? WHERE singleton = 1').run(now);
    return { deletedRecords, deletedAliases };
  };
  return db.isTransaction ? run() : transaction(db, run);
}

export function maintainUserState(db: DatabaseSync, options?: UserStateMaintenanceOptions): UserStateMaintenanceResult {
  const now = options?.now?.() ?? Date.now();
  const counts = transaction(db, () => {
    const config = readUserStateRetentionConfig(db);
    const prunedNonLibraryReading = config.pruneNonLibraryReading.enabled
      ? applyPruneNonLibraryReading(db, now, config.pruneNonLibraryReading.days)
      : 0;
    let prunedSlidingWindow = 0;
    if (config.slidingWindow.enabled) {
      prunedSlidingWindow = applySlidingWindowRetention(db, now, config.slidingWindow.months);
    } else {
      db.prepare('UPDATE user_state_meta SET seed_cutoff_at = NULL WHERE singleton = 1 AND seed_cutoff_at IS NOT NULL').run();
    }
    const strippedReadingTimestamps = config.stripReadingTimestamps.enabled
      ? applyStripReadingTimestamps(db, now, config.stripReadingTimestamps.days)
      : 0;
    const { deletedRecords: gcDeletedRecords, deletedAliases: gcDeletedAliases } = gcPhysicalUserStateRecords(
      db,
      now,
      options?.tombstoneGraceMs,
    );
    const deletedChanges = compactUserStateChanges(db, now, options?.supersededGraceMs);
    const { nulledBodies: nulledOperationBodies, deletedOperations } = cleanupUserStateOperations(
      db,
      now,
      options?.operationBodyRetentionMs,
      options?.operationFingerprintRetentionMs,
    );
    return {
      prunedNonLibraryReading,
      prunedSlidingWindow,
      strippedReadingTimestamps,
      gcDeletedRecords,
      gcDeletedAliases,
      deletedChanges,
      nulledOperationBodies,
      deletedOperations,
    };
  });
  const freelistCount = Number(
    (db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0,
  );
  const mutated =
    counts.prunedNonLibraryReading > 0 ||
    counts.prunedSlidingWindow > 0 ||
    counts.strippedReadingTimestamps > 0 ||
    counts.gcDeletedRecords > 0 ||
    counts.gcDeletedAliases > 0 ||
    counts.deletedChanges > 0 ||
    counts.nulledOperationBodies > 0 ||
    counts.deletedOperations > 0;
  const reclaimed = mutated || freelistCount > 0
    ? reclaimDatabaseSpace(db, options?.vacuumPagesPerPass, options?.checkpointMode)
    : null;
  return { ...counts, reclaimed };
}

export function resetUserStateWorkspace(db: DatabaseSync): { previousEpoch: string; epoch: string; workspaceId: string } {
  return transaction(db, () => {
    const current = namespace(db);
    const nextEpoch = randomUUID();
    db.exec(`
      DELETE FROM user_state_records;
      DELETE FROM user_state_changes;
      DELETE FROM user_state_operations;
      DELETE FROM user_state_category_aliases;
    `);
    const hasSequence = Boolean(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get(),
    );
    if (hasSequence) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name='user_state_changes'").run();
    }
    db.prepare(
      'UPDATE user_state_meta SET epoch=?, head_revision=0, compacted_through=0, seed_blocked=0, seed_cutoff_at=NULL, last_gc_at=NULL WHERE singleton=1',
    ).run(nextEpoch);
    return { previousEpoch: current.epoch, epoch: nextEpoch, workspaceId: current.workspaceId };
  });
}

function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function getUserStateAdminStats(
  db: DatabaseSync,
  dataDir: string,
  options?: UserStateMaintenanceOptions,
): AdminUserStateStats {
  const now = options?.now?.() ?? Date.now();
  return readTransaction(db, () => {
    const scope = namespace(db);
    const head = headRevision(db);
    const meta = readRetentionMetadata(db);
    const retention = readUserStateRetentionConfig(db);

    const autoVacuum = Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined)?.auto_vacuum ?? 0);
    const freelistPages = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0);
    const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size ?? 0);
    const pageCount = Number((db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ?? 0);
    const dbBytes = fileSizeOrZero(join(dataDir, 'metadata.sqlite'));
    const walBytes = fileSizeOrZero(join(dataDir, 'metadata.sqlite-wal'));

    const rowCounts = new Map<string, number>();
    for (const table of USER_STATE_TABLE_NAMES) {
      rowCounts.set(table, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n));
    }

    const dbstatByTable = new Map<string, Omit<UserStateTableStat, 'name' | 'rows'>>();
    try {
      const statRows = db.prepare(`
        SELECT s.tbl_name AS name,
          COUNT(*) AS pages,
          COALESCE(SUM(d.pgsize), 0) AS bytes,
          COALESCE(SUM(CASE WHEN s.type = 'table' THEN d.pgsize ELSE 0 END), 0) AS tableBytes,
          COALESCE(SUM(CASE WHEN s.type = 'index' THEN d.pgsize ELSE 0 END), 0) AS indexBytes,
          COALESCE(SUM(d.payload), 0) AS payloadBytes
        FROM dbstat d
        JOIN sqlite_schema s ON s.name = d.name
        WHERE s.tbl_name IN ('user_state_meta','user_state_records','user_state_changes','user_state_operations','user_state_category_aliases')
        GROUP BY s.tbl_name
      `).all() as {
        name: string;
        pages: number;
        bytes: number;
        tableBytes: number;
        indexBytes: number;
        payloadBytes: number;
      }[];
      for (const row of statRows) {
        dbstatByTable.set(row.name, {
          pages: Number(row.pages),
          bytes: Number(row.bytes),
          tableBytes: Number(row.tableBytes),
          indexBytes: Number(row.indexBytes),
          payloadBytes: Number(row.payloadBytes),
        });
      }
    } catch {
      const fallbackSql: Record<typeof USER_STATE_TABLE_NAMES[number], string> = {
        user_state_meta: 'SELECT COALESCE(SUM(LENGTH(workspace_id) + LENGTH(epoch)), 0) AS n FROM user_state_meta',
        user_state_records: 'SELECT COALESCE(SUM(LENGTH(entity_key) + LENGTH(kind) + LENGTH(record)), 0) AS n FROM user_state_records',
        user_state_changes: 'SELECT COALESCE(SUM(LENGTH(entity_key) + LENGTH(record)), 0) AS n FROM user_state_changes',
        user_state_operations: 'SELECT COALESCE(SUM(LENGTH(device_id) + LENGTH(operation_id) + LENGTH(payload_hash) + COALESCE(LENGTH(result), 0)), 0) AS n FROM user_state_operations',
        user_state_category_aliases: 'SELECT COALESCE(SUM(LENGTH(alias_id) + LENGTH(canonical_id)), 0) AS n FROM user_state_category_aliases',
      };
      for (const table of USER_STATE_TABLE_NAMES) {
        const payloadBytes = Number((db.prepare(fallbackSql[table]).get() as { n: number }).n);
        dbstatByTable.set(table, {
          pages: 0,
          bytes: payloadBytes,
          tableBytes: payloadBytes,
          indexBytes: 0,
          payloadBytes,
        });
      }
    }

    const tables: UserStateTableStat[] = USER_STATE_TABLE_NAMES.map(name => {
      const stat = dbstatByTable.get(name);
      return {
        name,
        rows: rowCounts.get(name) ?? 0,
        pages: stat?.pages ?? 0,
        bytes: stat?.bytes ?? 0,
        tableBytes: stat?.tableBytes ?? 0,
        indexBytes: stat?.indexBytes ?? 0,
        payloadBytes: stat?.payloadBytes ?? 0,
      };
    });

    const byKind = Object.fromEntries(
      USER_STATE_KINDS.map(kind => [kind, { total: 0, active: 0, tombstones: 0 }]),
    ) as Record<UserStateKind, UserStateKindStat>;
    const tombstoneCutoff = now - Math.max(0, options?.tombstoneGraceMs ?? retention.tombstoneGc.graceDays * 86_400_000);
    const kindRows = db.prepare(`
      SELECT kind,
        COUNT(*) AS total,
        SUM(CASE WHEN
          (kind='reading' AND json_extract(record,'$.value.progress')=0 AND json_extract(record,'$.value.readAt') IS NULL) OR
          (kind='bookmark' AND json_extract(record,'$.value.bookmarked')=0) OR
          (kind='library' AND json_extract(record,'$.value.inLibrary')=0) OR
          (kind='membership' AND COALESCE(membership_included, CAST(json_extract(record,'$.value.included') AS INTEGER))=0) OR
          (kind='category' AND COALESCE(category_deleted, CAST(json_extract(record,'$.value.deleted') AS INTEGER))=1) OR
          (kind='resume' AND json_extract(record,'$.value.chapter') IS NULL AND json_extract(record,'$.value.anchor') IS NULL AND json_extract(record,'$.value.openedAt') IS NULL)
        THEN 1 ELSE 0 END) AS tombstones,
        SUM(CASE WHEN (
          (kind='reading' AND json_extract(record,'$.value.progress')=0 AND json_extract(record,'$.value.readAt') IS NULL) OR
          (kind='bookmark' AND json_extract(record,'$.value.bookmarked')=0) OR
          (kind='library' AND json_extract(record,'$.value.inLibrary')=0) OR
          (kind='membership' AND COALESCE(membership_included, CAST(json_extract(record,'$.value.included') AS INTEGER))=0) OR
          (kind='category' AND COALESCE(category_deleted, CAST(json_extract(record,'$.value.deleted') AS INTEGER))=1) OR
          (kind='resume' AND json_extract(record,'$.value.chapter') IS NULL AND json_extract(record,'$.value.anchor') IS NULL AND json_extract(record,'$.value.openedAt') IS NULL)
        ) AND COALESCE(updated_at, CAST(json_extract(record,'$.updatedAt') AS INTEGER), 0) < ? THEN 1 ELSE 0 END) AS eligible
      FROM user_state_records
      GROUP BY kind
    `).all(tombstoneCutoff) as { kind: UserStateKind; total: number; tombstones: number; eligible: number }[];

    let recordsTotal = 0;
    let recordsTombstones = 0;
    let tombstonesEligibleForGc = 0;
    for (const row of kindRows) {
      const total = Number(row.total);
      const tombstones = Number(row.tombstones);
      const active = Math.max(0, total - tombstones);
      if (row.kind in byKind) {
        byKind[row.kind] = { total, active, tombstones };
      }
      recordsTotal += total;
      recordsTombstones += tombstones;
      tombstonesEligibleForGc += Number(row.eligible);
    }

    const supersededCutoff = now - Math.max(0, options?.supersededGraceMs ?? DEFAULT_USER_STATE_SUPERSEDED_GRACE_MS);
    const changeRow = db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN superseded_at IS NULL THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN superseded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS superseded,
        COALESCE(SUM(CASE WHEN superseded_at IS NOT NULL AND superseded_at < ? THEN 1 ELSE 0 END), 0) AS compactable
      FROM user_state_changes
    `).get(supersededCutoff) as { total: number; active: number; superseded: number; compactable: number };

    const bodyMs = Math.max(0, options?.operationBodyRetentionMs ?? DEFAULT_USER_STATE_OP_BODY_RETENTION_MS);
    const fingerprintMs = Math.max(bodyMs, Math.max(0, options?.operationFingerprintRetentionMs ?? DEFAULT_USER_STATE_OP_FINGERPRINT_RETENTION_MS));
    const opRow = db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END), 0) AS withResult,
        COALESCE(SUM(CASE WHEN result IS NOT NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS prunableBodies,
        COALESCE(SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END), 0) AS prunableFingerprints
      FROM user_state_operations
    `).get(now - bodyMs, now - fingerprintMs) as {
      total: number;
      withResult: number;
      prunableBodies: number;
      prunableFingerprints: number;
    };

    const liveCategoryKeys = new Set(
      (db.prepare("SELECT entity_key FROM user_state_records WHERE kind='category'").all() as { entity_key: string }[]).map(
        row => row.entity_key,
      ),
    );
    const aliasRows = db.prepare('SELECT canonical_id FROM user_state_category_aliases').all() as { canonical_id: string }[];
    let danglingAliases = 0;
    for (const alias of aliasRows) {
      if (!liveCategoryKeys.has(userStateEntityKey({ kind: 'category', categoryId: alias.canonical_id }))) {
        danglingAliases++;
      }
    }

    return {
      workspaceId: scope.workspaceId,
      epoch: scope.epoch,
      headRevision: head,
      compactedThrough: meta.compactedThrough,
      seedAllowed: meta.seedAllowed,
      seedCutoffAt: meta.seedCutoffAt,
      lastGcAt: meta.lastGcAt,
      retention,
      autoVacuum,
      freelistPages,
      pageSize,
      pageCount,
      dbBytes,
      walBytes,
      tables,
      records: {
        total: recordsTotal,
        active: Math.max(0, recordsTotal - recordsTombstones),
        tombstones: recordsTombstones,
        tombstonesEligibleForGc,
        byKind,
      },
      changes: {
        total: Number(changeRow.total),
        active: Number(changeRow.active),
        superseded: Number(changeRow.superseded),
        compactable: Number(changeRow.compactable),
      },
      operations: {
        total: Number(opRow.total),
        withResult: Number(opRow.withResult),
        prunableBodies: Number(opRow.prunableBodies),
        prunableFingerprints: Number(opRow.prunableFingerprints),
      },
      categoryAliases: {
        total: aliasRows.length,
        dangling: danglingAliases,
      },
    };
  });
}

export function registerUserState(app: FastifyInstance, db: DatabaseSync, options?: { now?: () => number }): void {
  const currentNow = () => options?.now?.() ?? Date.now();
  const onRequest = async (request: FastifyRequest, reply: { header: (name: string, value: string) => unknown }) => {
    reply.header('Cache-Control', 'no-store'); actor(db, request);
  };
  app.get('/api/v1/user-state', { onRequest, schema: { security: [{ bearerAuth: [] }], description: 'Shared user-state namespace for admitted devices. Device names are labels, never storage keys.' } }, async () => ({ version: 1, ...namespace(db), headRevision: headRevision(db) }));
  app.get('/api/v1/user-state/retention', { onRequest, schema: { security: [{ bearerAuth: [] }], description: 'Inspect server compaction watermark and seed retention constraints.' } }, async (): Promise<UserStateRetentionState> => readTransaction(db, () => {
    const scope = namespace(db);
    const meta = readRetentionMetadata(db);
    return {
      version: 1,
      ...scope,
      headRevision: headRevision(db),
      compactedThrough: meta.compactedThrough,
      seedAllowed: meta.seedAllowed,
      seedCutoffAt: meta.seedCutoffAt,
    };
  }));
  app.post('/api/v1/user-state/read', { onRequest, bodyLimit: USER_STATE_MAX_BYTES, schema: { security: [{ bearerAuth: [] }], body: { type: 'object' }, description: 'Read bounded durable user-state changes through a frozen revision, including explicit negative values and tombstones.' } }, async (request, reply) => {
    const body = object(request.body, ['workspaceId', 'epoch', 'after', 'through', 'limit'], ['workspaceId', 'epoch', 'after']);
    actor(db, request);
    const result = readTransaction(db, () => {
      const scope = assertNamespace(db, body), head = headRevision(db);
      const after = integer(body.after), through = body.through === undefined ? head : integer(body.through);
      const limit = body.limit === undefined ? null : integer(body.limit, 1);
      if (after > through || through > head) throw problem(409, 'User state: cursor is ahead of the requested history');
      const compacted = compactedThrough(db);
      if (after < compacted) {
        return { compacted: true as const };
      }
      const records: UserStateRecord[] = [];
      let bytes = RESPONSE_RESERVE, cursor = after;
      const rows = limit === null
        ? db.prepare('SELECT revision,record FROM user_state_changes WHERE revision>? AND revision<=? ORDER BY revision').iterate(after, through)
        : db.prepare('SELECT revision,record FROM user_state_changes WHERE revision>? AND revision<=? ORDER BY revision LIMIT ?').iterate(after, through, limit);
      for (const row of rows) {
        const serialized = row.record as string, size = Buffer.byteLength(serialized) + 1;
        if (bytes + size > USER_STATE_MAX_BYTES) break;
        bytes += size; records.push(JSON.parse(serialized) as UserStateRecord); cursor = Number(row.revision);
      }
      const hasMore = !!db.prepare('SELECT 1 FROM user_state_changes WHERE revision>? AND revision<=? LIMIT 1').get(cursor, through);
      if (hasMore && records.length === 0) throw problem(413, 'User state: a stored record exceeds the response budget');
      return { compacted: false as const, response: { version: 1, ...scope, headRevision: head, through, nextCursor: hasMore ? cursor : through, hasMore, records } };
    });
    if (result.compacted) {
      return reply.code(410).send({
        code: 'cursor-compacted',
        message: 'User state cursor was compacted; perform snapshot reconciliation.',
      });
    }
    return result.response;
  });
  app.post('/api/v1/user-state/snapshot', { onRequest, bodyLimit: USER_STATE_MAX_BYTES, schema: { security: [{ bearerAuth: [] }], body: { type: 'object' }, description: 'Read a consistent paginated full-state snapshot of current user-state records.' } }, async (request): Promise<UserStateSnapshotResponse> => {
    const body = object(request.body, ['workspaceId', 'epoch', 'afterEntityKey', 'limit'], ['workspaceId', 'epoch']);
    actor(db, request);
    let afterEntityKey: string | null = null;
    if (body.afterEntityKey !== undefined && body.afterEntityKey !== null) {
      if (typeof body.afterEntityKey !== 'string' || Buffer.byteLength(body.afterEntityKey) > 131072 || body.afterEntityKey.includes('\u0000')) {
        throw problem(400, 'User state: invalid snapshot cursor');
      }
      afterEntityKey = body.afterEntityKey;
    }
    const limit = body.limit === undefined ? null : Math.min(integer(body.limit, 1), 1_000_000);
    return readTransaction(db, () => {
      const scope = assertNamespace(db, body);
      const snapshotRevision = headRevision(db);
      const meta = readRetentionMetadata(db);
      const records: UserStateRecord[] = [];
      let bytes = RESPONSE_RESERVE;
      let lastEntityKey: string | null = null;
      let hasMore = false;
      const rows = afterEntityKey === null
        ? (limit === null
            ? db.prepare('SELECT entity_key, record FROM user_state_records ORDER BY entity_key ASC').iterate()
            : db.prepare('SELECT entity_key, record FROM user_state_records ORDER BY entity_key ASC LIMIT ?').iterate(limit + 1))
        : (limit === null
            ? db.prepare('SELECT entity_key, record FROM user_state_records WHERE entity_key > ? ORDER BY entity_key ASC').iterate(afterEntityKey)
            : db.prepare('SELECT entity_key, record FROM user_state_records WHERE entity_key > ? ORDER BY entity_key ASC LIMIT ?').iterate(afterEntityKey, limit + 1));
      for (const row of rows) {
        if (limit !== null && records.length >= limit) {
          hasMore = true;
          break;
        }
        const serialized = row.record as string;
        const entityKey = row.entity_key as string;
        const size = Buffer.byteLength(serialized) + 1;
        const nextKeyReserve = Buffer.byteLength(JSON.stringify(entityKey));
        if (bytes + size + nextKeyReserve > USER_STATE_MAX_BYTES) {
          hasMore = true;
          break;
        }
        bytes += size;
        records.push(JSON.parse(serialized) as UserStateRecord);
        lastEntityKey = entityKey;
      }
      if (hasMore && records.length === 0) throw problem(413, 'User state: a stored record exceeds the response budget');
      const nextEntityKey = hasMore ? lastEntityKey : null;
      return {
        version: 1,
        ...scope,
        headRevision: snapshotRevision,
        snapshotRevision,
        nextEntityKey,
        hasMore,
        seedAllowed: meta.seedAllowed,
        seedCutoffAt: meta.seedCutoffAt,
        records,
      };
    });
  });
  app.post('/api/v1/user-state/merge', { onRequest, bodyLimit: USER_STATE_MAX_BYTES, schema: { security: [{ bearerAuth: [] }], body: { type: 'object' }, description: 'Apply immutable idempotent single-user edits. Explicit edits use server-revision last-write-wins; soft seeds never replace existing state.' } }, async request => {
    const body = object(request.body, ['workspaceId', 'epoch', 'operations']);
    const scope = assertNamespace(db, body);
    if (!Array.isArray(body.operations)) throw problem(400, 'User state: expected an operations array');
    // Parse every operation before entering the write transaction, including those after a valid edit.
    const operations = body.operations.map(parseOperation);
    for (const operation of operations) {
      if ('work' in operation.entity && operation.entity.work.pluginId === 'local') {
        throw problem(400, 'User state: local works cannot be synchronized');
      }
      if (operation.entity.kind === 'composition') {
        const composition = (operation.value as { composition: ChapterCompositionV1 }).composition;
        if (composition.entries.some(entry => entry.sources.some(source => source.pluginId === 'local'))) {
          throw problem(400, 'User state: local works cannot be synchronized');
        }
      }
    }
    const writer = actor(db, request); // Recheck blocking after the request body has arrived.
    const hashes = new Map<string, string>();
    for (const [index, operation] of operations.entries()) {
      // Identity normalization is not permission to reuse an ID with changed bytes/values.
      const hash = createHash('sha256').update(canonicalize(body.operations[index])).digest('hex');
      const previous = hashes.get(operation.operationId);
      if (previous !== undefined) throw problem(400, 'User state: an operation ID occurs more than once in this batch');
      hashes.set(operation.operationId, hash);
    }
    return transaction(db, () => {
      const lookup = db.prepare('SELECT payload_hash,result FROM user_state_operations WHERE operation_id=?');
      // Reject conflicting operation-ID reuse or expired receipts before any operation in this batch is applied.
      for (const [id, hash] of hashes) {
        const saved = lookup.get(id) as { payload_hash: string; result: string | null } | undefined;
        if (saved && saved.payload_hash !== hash) throw problem(409, 'User state: an operation ID was reused with a different payload');
        if (saved && saved.result === null) {
          throw problem(409, 'User state: operation receipt expired; sync and retry with a new operation ID');
        }
      }
      const save = db.prepare('INSERT INTO user_state_operations(device_id,operation_id,payload_hash,result,created_at) VALUES(?,?,?,?,?)');
      const results: UserStateMergeResult[] = [];
      let bytes = RESPONSE_RESERVE;
      const now = currentNow();
      const retention = readRetentionMetadata(db);
      for (const operation of operations) {
        const saved = lookup.get(operation.operationId) as { payload_hash: string; result: string | null } | undefined;
        const result = saved ? JSON.parse(saved.result!) as UserStateMergeResult : applyOperation(db, operation, writer, now, retention);
        const serialized = JSON.stringify(result);
        bytes += Buffer.byteLength(serialized) + 1;
        if (bytes > USER_STATE_MAX_BYTES) throw problem(413, 'User state: result exceeds 32 MiB; retry the same immutable operations in smaller batches');
        if (!saved) save.run(writer.id, operation.operationId, hashes.get(operation.operationId)!, serialized, now);
        results.push(result);
      }
      return { version: 1, ...scope, headRevision: headRevision(db), results };
    });
  });
}
