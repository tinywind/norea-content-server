import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalUserStateJson, userStateEntityKey, type UserStateEntity, type UserStateValueMap } from './user-state-protocol.ts';
import { mergeUserStateComposition } from './user-state-composition.ts';
import { currentStateMigrationProjection } from './user-state-current-projection.ts';
import {
  parseUserStateCurrentItem, mergeUserStateCurrentReading, mergeUserStateCurrentResume,
  USER_STATE_CURRENT_MAX_BYTES, USER_STATE_CURRENT_MAX_ITEMS,
  type UserStateCurrentItem, type UserStateCurrentSnapshot,
} from './user-state-current-protocol.ts';

const schema = `
  CREATE TABLE IF NOT EXISTS user_state_current_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), imported_v1 INTEGER NOT NULL CHECK(imported_v1=1)
  );
  CREATE TABLE IF NOT EXISTS user_state_current_records (
    entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, item TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_state_current_kinds ON user_state_current_records(kind);
`;
function issue(statusCode: number, message: string): never {
  throw Object.assign(new Error('Current user state: ' + message), { statusCode });
}
export const currentCategoryId = (name: string): string => 'name-' + createHash('sha256').update(name.trim(), 'utf8').digest('hex');
const minNullable = (left: number | null, right: number | null): number | null =>
  left === null ? right : right === null ? left : Math.min(left, right);

function assertOwnership(left: UserStateEntity, right: UserStateEntity): void {
  if ((left.kind === 'reading' || left.kind === 'bookmark') && (right.kind === 'reading' || right.kind === 'bookmark')) {
    if (/^norea-(?:composed|source):/.test(left.chapter.chapterPath) && left.chapter.compositionEntryId !== right.chapter.compositionEntryId)
      issue(409, 'synthetic chapter ownership differs; retain local state until its metadata is reconciled');
  }
}
function mergeItem(left: UserStateCurrentItem, right: UserStateCurrentItem): UserStateCurrentItem {
  assertOwnership(left.entity, right.entity);
  let value = right.value;
  switch (left.entity.kind) {
    case 'library': value = { inLibrary: true, addedAt: minNullable((left.value as UserStateValueMap['library']).addedAt, (right.value as UserStateValueMap['library']).addedAt) }; break;
    case 'category': {
      const a = left.value as UserStateValueMap['category'], b = right.value as UserStateValueMap['category'];
      if (a.name !== b.name) issue(409, 'a canonical category belongs to another name');
      value = { name: a.name, deleted: false, sort: Math.min(a.sort, b.sort) }; break;
    }
    case 'reading': value = mergeUserStateCurrentReading(left.value as UserStateValueMap['reading'], right.value as UserStateValueMap['reading']); break;
    case 'resume': value = mergeUserStateCurrentResume(left.value as UserStateValueMap['resume'], right.value as UserStateValueMap['resume']); break;
    case 'composition': {
      const a = (left.value as UserStateValueMap['composition']).composition, b = (right.value as UserStateValueMap['composition']).composition;
      const newer = a.updatedAt !== b.updatedAt ? (a.updatedAt > b.updatedAt ? a : b)
        : canonicalUserStateJson(a) <= canonicalUserStateJson(b) ? a : b;
      const older = newer === a ? b : a;
      if (left.entity.work.sourceNovelId === null) issue(400, 'composition requires a known source novel ID');
      try { value = { composition: mergeUserStateComposition(newer, older, { pluginId: left.entity.work.pluginId, sourceNovelId: left.entity.work.sourceNovelId }) }; }
      catch { issue(409, 'composition source storage is ambiguous; keep both local documents until resolved'); }
      break;
    }
  }
  // Informational names and source paths cannot change the portable entity key.
  const entity = canonicalUserStateJson(left.entity) <= canonicalUserStateJson(right.entity) ? left.entity : right.entity;
  return parseUserStateCurrentItem({ entity, value });
}
function load(db: DatabaseSync): Map<string, UserStateCurrentItem> {
  const records = new Map<string, UserStateCurrentItem>();
  for (const row of db.prepare('SELECT entity_key,item FROM user_state_current_records').iterate())
    records.set(row.entity_key as string, parseUserStateCurrentItem(JSON.parse(row.item as string)));
  return records;
}

/** Full positive snapshots are joined by current identity, never replayed as edit events. */
function joinItems(records: Map<string, UserStateCurrentItem>, incoming: UserStateCurrentItem[], importing = false): void {
  const categoryMap = new Map<string, string>();
  const merge = (item: UserStateCurrentItem) => {
    const key = userStateEntityKey(item.entity), current = records.get(key);
    records.set(key, current ? mergeItem(current, item) : item);
  };
  for (const item of incoming) {
    if (item.entity.kind !== 'category') continue;
    const name = (item.value as UserStateValueMap['category']).name;
    const canonicalId = currentCategoryId(name), known = categoryMap.get(item.entity.categoryId);
    if (known && known !== canonicalId) issue(400, 'one input category ID names two categories');
    categoryMap.set(item.entity.categoryId, canonicalId);
    merge({ entity: { kind: 'category', categoryId: canonicalId }, value: item.value });
  }
  for (const original of incoming) {
    if (original.entity.kind === 'category') continue;
    let item = original;
    if (item.entity.kind === 'membership') {
      const canonicalId = categoryMap.get(item.entity.categoryId) ?? item.entity.categoryId;
      if (!records.has(userStateEntityKey({ kind: 'category', categoryId: canonicalId }))) {
        if (importing) continue; // A legacy deleted category is not a positive current category.
        issue(400, 'membership requires its current named category in this snapshot');
      }
      item = { ...item, entity: { ...item.entity, categoryId: canonicalId } };
    }
    merge(item);
  }
}
function persist(db: DatabaseSync, records: Map<string, UserStateCurrentItem>): void {
  const write = db.prepare('INSERT INTO user_state_current_records(entity_key,kind,item) VALUES(?,?,?) ON CONFLICT(entity_key) DO UPDATE SET kind=excluded.kind,item=excluded.item WHERE item<>excluded.item');
  for (const [key, item] of records) write.run(key, item.entity.kind, canonicalUserStateJson(item));
}
function projected(db: DatabaseSync, records: Map<string, UserStateCurrentItem>) {
  const project = currentStateMigrationProjection(db), visible = new Map<string, UserStateCurrentItem>(), held = new Map<string, UserStateCurrentItem>();
  for (const [oldKey, original] of records) {
    const item = project(original);
    if (!item) { held.set(oldKey, original); continue; }
    const key = userStateEntityKey(item.entity), current = visible.get(key);
    visible.set(key, current ? mergeItem(current, item) : item);
  }
  return { visible, retained: new Map([...held, ...visible]) };
}
function positiveLegacy(record: { entity: UserStateEntity; value: unknown }): boolean {
  const value = record.value as Record<string, unknown>;
  switch (record.entity.kind) {
    case 'library': return value.inLibrary === true;
    case 'bookmark': return value.bookmarked === true;
    case 'category': return value.deleted === false;
    case 'membership': return value.included === true;
    case 'resume': return value.chapter !== null;
    default: return true;
  }
}

/** Runs inside openDatabase's additive migration transaction. Original rows stay untouched. */
export function initializeUserStateCurrent(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('Current user-state initialization requires the schema transaction');
  db.exec(schema);
  if (db.prepare('SELECT 1 FROM user_state_current_meta WHERE singleton=1').get()) return;
  const legacy: UserStateCurrentItem[] = [];
  for (const row of db.prepare('SELECT record FROM user_state_records ORDER BY entity_key').iterate()) {
    const record = JSON.parse(row.record as string);
    if (positiveLegacy(record)) legacy.push(parseUserStateCurrentItem({ entity: record.entity, value: record.value }));
  }
  const records = load(db); joinItems(records, legacy, true); persist(db, records);
  db.prepare('INSERT INTO user_state_current_meta(singleton,imported_v1) VALUES(1,1)').run();
}
function snapshot(db: DatabaseSync, records: Map<string, UserStateCurrentItem>): UserStateCurrentSnapshot {
  const scope = db.prepare('SELECT workspace_id AS workspaceId,epoch FROM user_state_meta WHERE singleton=1').get() as { workspaceId: string; epoch: string } | undefined;
  if (!scope) issue(503, 'workspace is unavailable');
  if (records.size > USER_STATE_CURRENT_MAX_ITEMS) issue(413, 'current snapshot exceeds the item limit');
  const value: UserStateCurrentSnapshot = { version: 2, ...scope, items: [...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, item]) => item) };
  if (Buffer.byteLength(JSON.stringify(value)) > USER_STATE_CURRENT_MAX_BYTES) issue(413, 'current snapshot exceeds the byte limit');
  return value;
}
export function currentUserStateSnapshot(db: DatabaseSync): UserStateCurrentSnapshot { return snapshot(db, projected(db, load(db)).visible); }
export function mergeCurrentUserState(db: DatabaseSync, incoming: UserStateCurrentSnapshot): UserStateCurrentSnapshot {
  if (!db.isTransaction) throw new Error('Current user-state merge requires a write transaction');
  const scope = db.prepare('SELECT workspace_id,epoch FROM user_state_meta WHERE singleton=1').get();
  if (!scope || scope.workspace_id !== incoming.workspaceId || scope.epoch !== incoming.epoch) issue(409, 'workspace changed; reconnect without discarding local current state');
  const records = load(db); joinItems(records, incoming.items);
  const canonical = projected(db, records);
  const response = snapshot(db, canonical.visible); // Check the complete response before any current-state write.
  persist(db, canonical.retained);
  // A proven key move is not an absent-row deletion. Unmapped chapters and old
  // source compositions remain held in current storage and never overwrite B.
  const remove = db.prepare('DELETE FROM user_state_current_records WHERE entity_key=?');
  for (const key of records.keys()) if (!canonical.retained.has(key)) remove.run(key);
  return response;
}
