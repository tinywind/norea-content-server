import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticate } from './auth.ts';
import { parseChapterComposition, type ChapterCompositionV1 } from './chapter-composition.ts';
import { problem, transaction } from './db.ts';
import {
  USER_STATE_MAX_BYTES, USER_STATE_MAX_BATCH,
  parseUserStateOperation as parseOperation, userStateEntityKey,
  type UserStateEntity, type UserStateValue, type UserStateOperation,
  type UserStateRecord, type UserStateMergeResult,
} from './user-state-protocol.ts';
export { USER_STATE_MAX_BYTES, userStateEntityKey, parseUserStateEntity, parseUserStateValue } from './user-state-protocol.ts';
export type { UserStateEntity, UserStateValue, UserStateOperation, UserStateRecord, UserStateMergeResult } from './user-state-protocol.ts';

export const USER_STATE_MAX_ITEMS = USER_STATE_MAX_BATCH;
const RESPONSE_RESERVE = 4096;
interface Namespace { workspaceId: string; epoch: string }
interface Actor { id: string; name: string }
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
function headRevision(db: DatabaseSync): number {
  return Number(db.prepare('SELECT coalesce(max(revision),0) AS revision FROM user_state_changes').get()?.revision ?? 0);
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
/** User-state CAS is the authority for manual composition choices, not a device clock. */
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
function publish(db: DatabaseSync, operation: UserStateOperation, entity: UserStateEntity, writer: Actor): UserStateRecord {
  const key = userStateEntityKey(entity);
  const revision = Number(db.prepare("INSERT INTO user_state_changes(entity_key,record) VALUES(?,'{}')").run(key).lastInsertRowid);
  const record: UserStateRecord = { entity, value: operation.value, revision, operationId: operation.operationId, updatedAt: Date.now(), deviceId: writer.id, deviceName: writer.name };
  const serialized = JSON.stringify(record);
  const category = entity.kind === 'category' ? operation.value as CategoryValue : null;
  db.prepare('INSERT INTO user_state_records(entity_key,kind,category_name,category_deleted,revision,record) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_key) DO UPDATE SET kind=excluded.kind,category_name=excluded.category_name,category_deleted=excluded.category_deleted,revision=excluded.revision,record=excluded.record')
    .run(key, entity.kind, category?.name ?? null, category ? Number(category.deleted) : null, revision, serialized);
  db.prepare('UPDATE user_state_changes SET record=? WHERE revision=?').run(serialized, revision);
  return record;
}
function ownershipConflict(current: UserStateRecord | null, entity: UserStateEntity): boolean {
  if (!current || (entity.kind !== 'reading' && entity.kind !== 'bookmark')) return false;
  const previous = current.entity;
  return (previous.kind === 'reading' || previous.kind === 'bookmark') && previous.chapter.compositionEntryId !== undefined &&
    entity.chapter.compositionEntryId !== undefined && previous.chapter.compositionEntryId !== entity.chapter.compositionEntryId;
}
function excludeDeletedCategoryMemberships(db: DatabaseSync, category: string, deletion: UserStateOperation, writer: Actor): void {
  // Advance each known membership's revision. Without this, restoring a category
  // could acknowledge an old true value as unchanged and resurrect stale intent.
  const keys = db.prepare("SELECT entity_key FROM user_state_records WHERE kind='membership' AND json_extract(record,'$.entity.categoryId')=? AND json_extract(record,'$.value.included')=1 ORDER BY entity_key")
    .all(category) as { entity_key: string }[];
  const lookup = db.prepare('SELECT record FROM user_state_records WHERE entity_key=?');
  for (const { entity_key: key } of keys) {
    const current = JSON.parse((lookup.get(key) as { record: string }).record) as UserStateRecord;
    const operationId = 'category-delete:' + createHash('sha256').update(JSON.stringify([writer.id, deletion.operationId, key])).digest('hex');
    const operation: UserStateOperation = { operationId, entity: current.entity, baseRevision: current.revision, value: { included: false } };
    publish(db, operation, current.entity, writer);
  }
}
function applyOperation(db: DatabaseSync, operation: UserStateOperation, writer: Actor): UserStateMergeResult {
  const canonical = canonicalEntity(db, operation.entity), entity = canonical.entity;
  const current = storedRecord(db, entity);
  const result = (status: UserStateMergeResult['status'], record = current, reason?: string): UserStateMergeResult => ({
    operationId: operation.operationId, status, current: record,
    ...(reason === undefined ? {} : { reason }), ...(canonical.categoryAlias ? { categoryAlias: canonical.categoryAlias } : {}),
  });
  if (ownershipConflict(current, entity)) return result('conflict', current, 'chapter-identity-mismatch');
  if (operation.seed && current) return result('seed-skipped');
  if (entity.kind === 'category') {
    const value = operation.value as CategoryValue;
    const sameName = value.deleted ? null : categoryNamed(db, value.name);
    if (sameName && userStateEntityKey(sameName.entity) !== userStateEntityKey(entity)) {
      if (!current && operation.baseRevision === 0 && !canonical.categoryAlias && sameName.entity.kind === 'category') {
        const to = sameName.entity.categoryId;
        db.prepare('INSERT INTO user_state_category_aliases(alias_id,canonical_id) VALUES(?,?)').run(entity.categoryId, to);
        return { operationId: operation.operationId, status: 'aliased', current: sameName, categoryAlias: { from: entity.categoryId, to } };
      }
      return result('conflict', current, 'category-name-conflict');
    }
  }
  if (entity.kind === 'membership' && (operation.value as { included: boolean }).included) {
    const category = storedRecord(db, { kind: 'category', categoryId: entity.categoryId });
    if (!category) return result('conflict', current, 'category-missing');
    if ((category.value as CategoryValue).deleted) return result('conflict', current, 'category-deleted');
  }
  if (current && canonicalize(current.value) === canonicalize(operation.value)) return result('unchanged');
  if ((current?.revision ?? 0) !== operation.baseRevision) return result('conflict', current, 'revision-mismatch');
  // Keep an already known optional ownership proof when an older client lacks it.
  const publishedEntity = (entity.kind === 'reading' || entity.kind === 'bookmark') &&
    (current?.entity.kind === 'reading' || current?.entity.kind === 'bookmark') && !entity.chapter.compositionEntryId && current.entity.chapter.compositionEntryId
    ? { ...entity, chapter: { ...entity.chapter, compositionEntryId: current.entity.chapter.compositionEntryId } } : entity;
  const published = publish(db, operation, publishedEntity, writer);
  if (entity.kind === 'category' && (operation.value as CategoryValue).deleted) {
    excludeDeletedCategoryMemberships(db, entity.categoryId, operation, writer);
  }
  return result('applied', published);
}

export function registerUserState(app: FastifyInstance, db: DatabaseSync): void {
  const onRequest = async (request: FastifyRequest, reply: { header: (name: string, value: string) => unknown }) => {
    reply.header('Cache-Control', 'no-store'); actor(db, request);
  };
  app.get('/api/v1/user-state', { onRequest, schema: { security: [{ bearerAuth: [] }], description: 'Shared user-state namespace for admitted devices. Device names are labels, never storage keys.' } }, async () => ({ version: 1, ...namespace(db), headRevision: headRevision(db) }));
  app.post('/api/v1/user-state/read', { onRequest, bodyLimit: USER_STATE_MAX_BYTES, schema: { security: [{ bearerAuth: [] }], body: { type: 'object' }, description: 'Read bounded durable user-state changes through a frozen revision, including explicit negative values and tombstones.' } }, async request => {
    const body = object(request.body, ['workspaceId', 'epoch', 'after', 'through', 'limit'], ['workspaceId', 'epoch', 'after']);
    actor(db, request);
    const scope = assertNamespace(db, body), head = headRevision(db);
    const after = integer(body.after), through = body.through === undefined ? head : integer(body.through);
    const limit = body.limit === undefined ? USER_STATE_MAX_ITEMS : integer(body.limit, 1);
    if (limit > USER_STATE_MAX_ITEMS) throw problem(400, 'User state: page limit exceeds 200');
    if (after > through || through > head) throw problem(409, 'User state: cursor is ahead of the requested history');
    const records: UserStateRecord[] = [];
    let bytes = RESPONSE_RESERVE, cursor = after;
    const rows = db.prepare('SELECT revision,record FROM user_state_changes WHERE revision>? AND revision<=? ORDER BY revision LIMIT ?').iterate(after, through, limit);
    for (const row of rows) {
      const serialized = row.record as string, size = Buffer.byteLength(serialized) + 1;
      if (bytes + size > USER_STATE_MAX_BYTES) break;
      bytes += size; records.push(JSON.parse(serialized) as UserStateRecord); cursor = Number(row.revision);
    }
    const hasMore = !!db.prepare('SELECT 1 FROM user_state_changes WHERE revision>? AND revision<=? LIMIT 1').get(cursor, through);
    if (hasMore && records.length === 0) throw problem(413, 'User state: a stored record exceeds the response budget');
    return { version: 1, ...scope, headRevision: head, through, nextCursor: hasMore ? cursor : through, hasMore, records };
  });
  app.post('/api/v1/user-state/merge', { onRequest, bodyLimit: USER_STATE_MAX_BYTES, schema: { security: [{ bearerAuth: [] }], body: { type: 'object' }, description: 'Apply immutable idempotent user edits with per-entity revisions. A soft seed never replaces existing state; conflicting edits remain explicit.' } }, async request => {
    const body = object(request.body, ['workspaceId', 'epoch', 'operations']);
    const scope = assertNamespace(db, body);
    if (!Array.isArray(body.operations) || body.operations.length > USER_STATE_MAX_ITEMS) throw problem(400, 'User state: expected at most 200 operations');
    // Parse every operation before entering the write transaction, including those after a valid edit.
    const operations = body.operations.map(parseOperation);
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
      // Reject conflicting operation-ID reuse before any other operation in this batch is applied.
      for (const [id, hash] of hashes) {
        const saved = lookup.get(id) as { payload_hash: string; result: string } | undefined;
        if (saved && saved.payload_hash !== hash) throw problem(409, 'User state: an operation ID was reused with a different payload');
      }
      const save = db.prepare('INSERT INTO user_state_operations(device_id,operation_id,payload_hash,result) VALUES(?,?,?,?)');
      const results: UserStateMergeResult[] = [];
      let bytes = RESPONSE_RESERVE;
      for (const operation of operations) {
        const saved = lookup.get(operation.operationId) as { payload_hash: string; result: string } | undefined;
        const result = saved ? JSON.parse(saved.result) as UserStateMergeResult : applyOperation(db, operation, writer);
        const serialized = JSON.stringify(result);
        bytes += Buffer.byteLength(serialized) + 1;
        if (bytes > USER_STATE_MAX_BYTES) throw problem(413, 'User state: result exceeds 32 MiB; retry the same immutable operations in smaller batches');
        if (!saved) save.run(writer.id, operation.operationId, hashes.get(operation.operationId)!, serialized);
        results.push(result);
      }
      return { version: 1, ...scope, headRevision: headRevision(db), results };
    });
  });
}
