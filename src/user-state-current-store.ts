import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalUserStateJson, userStateEntityKey, type UserStateEntity, type UserStateRecord, type UserStateValue, type UserStateValueMap,
} from './user-state-protocol.ts';
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
  CREATE INDEX IF NOT EXISTS user_state_current_membership_categories
    ON user_state_current_records(json_extract(item,'$.entity.categoryId')) WHERE kind='membership';
`;
const deltaBridgeSchema = `
  CREATE TABLE IF NOT EXISTS user_state_delta_bridge_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), imported_current_v2 INTEGER NOT NULL CHECK(imported_current_v2=1)
  );
  CREATE TABLE IF NOT EXISTS user_state_delta_current_categories (
    delta_category_id TEXT PRIMARY KEY, current_category_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_state_delta_current_category_aliases (
    current_category_id TEXT PRIMARY KEY, delta_category_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_state_delta_current_category_alias_targets
    ON user_state_delta_current_category_aliases(delta_category_id);
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
    case 'reading': return Number(value.progress) > 0 || value.unread === false || value.readAt !== null;
    case 'resume': return value.chapter !== null;
    default: return true;
  }
}

function deltaRecord(db: DatabaseSync, entity: UserStateEntity): UserStateRecord | null {
  const row = db.prepare('SELECT record FROM user_state_records WHERE entity_key=?').get(userStateEntityKey(entity)) as { record: string } | undefined;
  return row ? JSON.parse(row.record) as UserStateRecord : null;
}
function deltaCategoryRecord(db: DatabaseSync, categoryId: string): UserStateRecord | null {
  const alias = db.prepare('SELECT canonical_id FROM user_state_category_aliases WHERE alias_id=?').get(categoryId) as { canonical_id: string } | undefined;
  return deltaRecord(db, { kind: 'category', categoryId: alias?.canonical_id ?? categoryId });
}
function deltaCategoryByName(db: DatabaseSync, name: string): UserStateRecord | null {
  const row = db.prepare("SELECT record FROM user_state_records WHERE kind='category' AND category_name=? ORDER BY category_deleted ASC,revision DESC LIMIT 1")
    .get(name) as { record: string } | undefined;
  return row ? JSON.parse(row.record) as UserStateRecord : null;
}
function currentCategoryForDelta(db: DatabaseSync, categoryId: string): string | null {
  const row = db.prepare('SELECT current_category_id FROM user_state_delta_current_categories WHERE delta_category_id=?')
    .get(categoryId) as { current_category_id: string } | undefined;
  return row?.current_category_id ?? null;
}
function deltaCategoryForCurrent(db: DatabaseSync, categoryId: string): string | null {
  const row = db.prepare('SELECT delta_category_id FROM user_state_delta_current_category_aliases WHERE current_category_id=?')
    .get(categoryId) as { delta_category_id: string } | undefined;
  return row?.delta_category_id ?? null;
}
function rememberCurrentCategory(db: DatabaseSync, deltaCategoryId: string, currentCategoryId: string): void {
  db.prepare(`INSERT INTO user_state_delta_current_categories(delta_category_id,current_category_id) VALUES(?,?)
    ON CONFLICT(delta_category_id) DO UPDATE SET current_category_id=excluded.current_category_id`)
    .run(deltaCategoryId, currentCategoryId);
  // Keep every old current name as an alias so a stale full-snapshot client cannot rename the delta category back.
  db.prepare(`INSERT INTO user_state_delta_current_category_aliases(current_category_id,delta_category_id) VALUES(?,?)
    ON CONFLICT(current_category_id) DO UPDATE SET delta_category_id=excluded.delta_category_id`)
    .run(currentCategoryId, deltaCategoryId);
}
function deleteCurrentCategoryRows(db: DatabaseSync, categoryId: string): void {
  db.prepare('DELETE FROM user_state_current_records WHERE entity_key=?')
    .run(userStateEntityKey({ kind: 'category', categoryId }));
  db.prepare("DELETE FROM user_state_current_records WHERE kind='membership' AND json_extract(item,'$.entity.categoryId')=?")
    .run(categoryId);
}
function moveCurrentMemberships(db: DatabaseSync, fromCategoryId: string, toCategoryId: string): void {
  if (fromCategoryId === toCategoryId) return;
  const rows = db.prepare("SELECT entity_key,item FROM user_state_current_records WHERE kind='membership' AND json_extract(item,'$.entity.categoryId')=?")
    .all(fromCategoryId) as { entity_key: string; item: string }[];
  const write = db.prepare(`INSERT INTO user_state_current_records(entity_key,kind,item) VALUES(?,'membership',?)
    ON CONFLICT(entity_key) DO UPDATE SET item=excluded.item`);
  const remove = db.prepare('DELETE FROM user_state_current_records WHERE entity_key=?');
  for (const row of rows) {
    const item = parseUserStateCurrentItem(JSON.parse(row.item));
    if (item.entity.kind !== 'membership') continue;
    const moved = parseUserStateCurrentItem({ ...item, entity: { ...item.entity, categoryId: toCategoryId } });
    write.run(userStateEntityKey(moved.entity), canonicalUserStateJson(moved));
    remove.run(row.entity_key);
  }
}
function sameDeltaItem(record: UserStateRecord, item: UserStateCurrentItem): boolean {
  return canonicalUserStateJson(record.entity) === canonicalUserStateJson(item.entity) &&
    canonicalUserStateJson(record.value) === canonicalUserStateJson(item.value);
}
function publishCurrentItemToDelta(db: DatabaseSync, item: UserStateCurrentItem): UserStateRecord {
  const key = userStateEntityKey(item.entity);
  const current = deltaRecord(db, item.entity);
  if (current && sameDeltaItem(current, item)) return current;
  const revision = Number(db.prepare("INSERT INTO user_state_changes(entity_key,record) VALUES(?,'{}')").run(key).lastInsertRowid);
  const digest = createHash('sha256').update(canonicalUserStateJson(item)).digest('hex').slice(0, 40);
  const record: UserStateRecord = {
    entity: item.entity, value: item.value, revision, operationId: `current-v2-${revision}-${digest}`,
    updatedAt: Date.now(), deviceId: 'server-current-v2', deviceName: 'Current-state compatibility bridge',
  };
  const serialized = JSON.stringify(record);
  const category = item.entity.kind === 'category' ? item.value as UserStateValueMap['category'] : null;
  const membership = item.entity.kind === 'membership' ? item.value as UserStateValueMap['membership'] : null;
  db.prepare(`INSERT INTO user_state_records(
    entity_key,kind,category_name,category_deleted,membership_category_id,membership_included,revision,record
  ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(entity_key) DO UPDATE SET
    kind=excluded.kind,category_name=excluded.category_name,category_deleted=excluded.category_deleted,
    membership_category_id=excluded.membership_category_id,membership_included=excluded.membership_included,
    revision=excluded.revision,record=excluded.record`)
    .run(key, item.entity.kind, category?.name ?? null, category ? Number(category.deleted) : null,
      item.entity.kind === 'membership' ? item.entity.categoryId : null,
      membership ? Number(membership.included) : null, revision, serialized);
  db.prepare('UPDATE user_state_changes SET record=? WHERE revision=?').run(serialized, revision);
  return record;
}
function mappedCurrentItems(db: DatabaseSync, incoming: readonly UserStateCurrentItem[]): UserStateCurrentItem[] {
  const categoryIds = new Map<string, string>();
  const staleCategories = new Set<string>();
  for (const item of incoming) {
    if (item.entity.kind !== 'category') continue;
    const currentId = item.entity.categoryId;
    const name = (item.value as UserStateValueMap['category']).name;
    const aliasedId = deltaCategoryForCurrent(db, currentId);
    const aliased = aliasedId ? deltaCategoryRecord(db, aliasedId) : null;
    const existing = aliased ?? deltaCategoryByName(db, name);
    const deltaId = existing?.entity.kind === 'category' ? existing.entity.categoryId : currentId;
    categoryIds.set(currentId, deltaId);
    const latestCurrentId = currentCategoryForDelta(db, deltaId);
    if (aliasedId && latestCurrentId && latestCurrentId !== currentId) {
      staleCategories.add(currentId);
      // mergeCurrentUserState already persisted this positive stale row. Remove it before returning the canonical snapshot.
      deleteCurrentCategoryRows(db, currentId);
    }
  }
  const mapped = new Map<string, UserStateCurrentItem>();
  for (const item of incoming) {
    let entity = item.entity;
    if (entity.kind === 'category') {
      if (staleCategories.has(entity.categoryId)) continue;
      entity = { ...entity, categoryId: categoryIds.get(entity.categoryId) ?? entity.categoryId };
    } else if (entity.kind === 'membership') {
      entity = { ...entity, categoryId: categoryIds.get(entity.categoryId) ??
        deltaCategoryForCurrent(db, entity.categoryId) ?? entity.categoryId };
    }
    const next = { entity, value: item.value } as UserStateCurrentItem;
    mapped.set(userStateEntityKey(entity), next);
  }
  return [...mapped.values()].sort((a, b) => Number(a.entity.kind !== 'category') - Number(b.entity.kind !== 'category'));
}
function deleteCurrentRecord(db: DatabaseSync, entity: UserStateEntity): void {
  db.prepare('DELETE FROM user_state_current_records WHERE entity_key=?').run(userStateEntityKey(entity));
}

/** Keep the temporary v2 full-snapshot endpoint coherent while devices upgrade to the delta protocol. */
export function mirrorDeltaRecordToCurrent(db: DatabaseSync, entity: UserStateEntity, value: UserStateValue): void {
  let currentEntity = entity;
  if (entity.kind === 'category') {
    const category = value as UserStateValueMap['category'];
    const previousId = currentCategoryForDelta(db, entity.categoryId);
    const categoryId = category.deleted ? previousId ?? currentCategoryId(category.name) : currentCategoryId(category.name);
    rememberCurrentCategory(db, entity.categoryId, categoryId);
    currentEntity = { kind: 'category', categoryId };
    if (category.deleted) {
      deleteCurrentCategoryRows(db, categoryId);
      return;
    }
    if (previousId && previousId !== categoryId) {
      moveCurrentMemberships(db, previousId, categoryId);
      deleteCurrentRecord(db, { kind: 'category', categoryId: previousId });
    }
  } else if (entity.kind === 'membership') {
    const category = deltaCategoryRecord(db, entity.categoryId);
    if (!category || category.entity.kind !== 'category') return;
    const categoryValue = category.value as UserStateValueMap['category'];
    if (!categoryValue.deleted) mirrorDeltaRecordToCurrent(db, category.entity, category.value);
    const categoryId = currentCategoryForDelta(db, category.entity.categoryId) ?? currentCategoryId(categoryValue.name);
    currentEntity = { ...entity, categoryId };
  }
  const present = positiveLegacy({ entity, value });
  if (!present) { deleteCurrentRecord(db, currentEntity); return; }
  const item = parseUserStateCurrentItem({ entity: currentEntity, value });
  const key = userStateEntityKey(item.entity);
  db.prepare(`INSERT INTO user_state_current_records(entity_key,kind,item) VALUES(?,?,?)
    ON CONFLICT(entity_key) DO UPDATE SET kind=excluded.kind,item=excluded.item WHERE item<>excluded.item`)
    .run(key, item.entity.kind, canonicalUserStateJson(item));
}

function mirrorMappedCurrentItemsToDelta(
  db: DatabaseSync, incoming: readonly UserStateCurrentItem[], authoritative: boolean,
): void {
  for (const item of incoming) {
    const current = deltaRecord(db, item.entity);
    if (!authoritative && current && !positiveLegacy(current)) {
      mirrorDeltaRecordToCurrent(db, current.entity, current.value);
      continue;
    }
    const record = publishCurrentItemToDelta(db, item);
    mirrorDeltaRecordToCurrent(db, record.entity, record.value);
  }
}

/** Import or bridge positive v2 rows while preserving explicit delta tombstones. */
export function mirrorCurrentItemsToDelta(
  db: DatabaseSync, incoming: readonly UserStateCurrentItem[], authoritative = false,
): void {
  mirrorMappedCurrentItemsToDelta(db, mappedCurrentItems(db, incoming), authoritative);
}

function authoritativeAbsenceValue(record: UserStateRecord): UserStateValue | null {
  switch (record.entity.kind) {
    case 'library': return { inLibrary: false, addedAt: null };
    case 'category': {
      const category = record.value as UserStateValueMap['category'];
      return { ...category, deleted: true };
    }
    case 'membership': return { included: false };
    case 'reading': return { progress: 0, unread: true, readAt: null };
    case 'bookmark': return { bookmarked: false };
    case 'resume': return { chapter: null, anchor: null, openedAt: null };
    // Version 1 has no composition-deletion value. Current v2 never removed a
    // stored composition, so retain a legacy composition rather than inventing one.
    case 'composition': return null;
  }
}

/** Import the deployed server's v2 rows once and close stale v1 positives with explicit revisions. */
export function initializeUserStateDeltaBridge(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('Current-to-delta user-state migration requires the schema transaction');
  db.exec(deltaBridgeSchema);
  if (db.prepare('SELECT 1 FROM user_state_delta_bridge_meta WHERE singleton=1').get()) return;
  const items: UserStateCurrentItem[] = [];
  for (const row of db.prepare('SELECT item FROM user_state_current_records ORDER BY kind,entity_key').iterate())
    items.push(parseUserStateCurrentItem(JSON.parse(row.item as string)));
  const mapped = mappedCurrentItems(db, items);
  mirrorMappedCurrentItemsToDelta(db, mapped, true);
  const retained = new Set(mapped.map(item => userStateEntityKey(item.entity)));
  const stale: UserStateRecord[] = [];
  for (const row of db.prepare('SELECT record FROM user_state_records ORDER BY kind,entity_key').iterate())
    stale.push(JSON.parse(row.record as string) as UserStateRecord);
  for (const record of stale) {
    if (retained.has(userStateEntityKey(record.entity)) || !positiveLegacy(record)) continue;
    const value = authoritativeAbsenceValue(record);
    if (value) publishCurrentItemToDelta(db, { entity: record.entity, value });
  }
  db.prepare('INSERT INTO user_state_delta_bridge_meta(singleton,imported_current_v2) VALUES(1,1)').run();
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
  mirrorCurrentItemsToDelta(db, response.items);
  return currentUserStateSnapshot(db);
}
