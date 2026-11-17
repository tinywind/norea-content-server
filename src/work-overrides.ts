import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticateDevice } from './auth.ts';
import { problem, transaction } from './db.ts';
import { digest, validateStorageIdentity } from './packages.ts';
import { atomicWrite, readBytes, type NovelMetadataV1, type WorkEntry } from './works.ts';

type WorkIdentity = NovelMetadataV1['identity'];
export interface WorkOverrideField { value: string | number | boolean | null; updatedAt: number }
export interface WorkOverrideV1 { schemaVersion: 1; identity: WorkIdentity; fields: Record<string, WorkOverrideField> }
export interface StoredWorkOverride { revision: number; override: WorkOverrideV1 }
export interface WorkOverridePage { items: (StoredWorkOverride & { workId: string })[]; cursor: number; hasMore: boolean }
interface OverrideWork { id: string; directory: string; identity: WorkIdentity; isLocal: boolean }
interface OverrideState { revision?: number; stored?: WorkOverrideV1; disk?: WorkOverrideV1; merged: WorkOverrideV1 }

/** Applies to the compact canonical document; it is also the PUT body limit. */
export const overrideByteLimit = 256 * 1024;
/** A synchronized sibling file may be pretty-printed, so its raw bytes get more room than the document. */
const overrideFileByteLimit = 4 * overrideByteLimit;
const maxFields = 64;
const invalid = (message: string): never => { throw problem(400, 'work override: ' + message); };
const localWork = (): never => { throw problem(400, 'Local works cannot have a content server override'); };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected object');
  return value as Record<string, unknown>;
}
function identityText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || !value.isWellFormed()) invalid('invalid identity');
  return value as string;
}
function assertLimits(value: WorkOverrideV1): void {
  if (Object.keys(value.fields).length > maxFields) invalid('too many fields');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > overrideByteLimit) throw problem(413, 'work override: document exceeds size limit');
}
function withinLimits(value: WorkOverrideV1): boolean {
  try { assertLimits(value); return true; } catch { return false; }
}
const workIdentity = (identity: WorkIdentity): WorkIdentity => ({ pluginId: identity.pluginId, novelId: identity.novelId, novelPath: identity.novelPath });
const sameIdentity = (left: WorkIdentity, right: WorkIdentity) => left.pluginId === right.pluginId && left.novelId === right.novelId && left.novelPath === right.novelPath;
/** Every document is built with sorted keys, so its JSON text is the canonical comparison form. */
const sameDocument = (left: WorkOverrideV1, right: WorkOverrideV1) => JSON.stringify(left) === JSON.stringify(right);
const hasFields = (value: WorkOverrideV1) => Object.keys(value.fields).length > 0;
export const overrideWorkId = (identity: WorkIdentity) => digest(JSON.stringify([identity.pluginId, identity.novelPath]));

/** Unknown top-level keys are dropped; every validly shaped field, known or not, is kept verbatim. */
export function parseWorkOverride(raw: unknown): WorkOverrideV1 {
  const value = record(raw);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) invalid('invalid version');
  const identity = record(value.identity);
  const pluginId = identityText(identity.pluginId); const novelPath = identityText(identity.novelPath);
  validateStorageIdentity({ pluginId, novelId: identity.novelId });
  if (novelPath.startsWith('norea-folder:')) invalid('source work identity required');
  if (/^(?:https?:)?\/\//i.test(novelPath)) invalid('work identity must exclude the base URL');
  const entries = Object.entries(record(value.fields));
  if (entries.length > maxFields) invalid('too many fields');
  const fields: WorkOverrideV1['fields'] = {};
  for (const [name, entry] of entries.sort(([left], [right]) => left < right ? -1 : 1)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(name)) invalid('invalid field name');
    const field = record(entry);
    if (Object.keys(field).length !== 2 || !Object.hasOwn(field, 'value') || !Object.hasOwn(field, 'updatedAt')) invalid('invalid field entry');
    const content = field.value; const updatedAt = field.updatedAt;
    if (content !== null && typeof content !== 'boolean' && !(typeof content === 'number' && Number.isFinite(content))
      && !(typeof content === 'string' && content.length <= 8192)) invalid('invalid field value');
    if (name === 'completed' && content !== null && typeof content !== 'boolean') invalid('completed must be a boolean or null');
    if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) <= 0) invalid('invalid field timestamp');
    fields[name] = { value: content as WorkOverrideField['value'], updatedAt: updatedAt as number };
  }
  const document: WorkOverrideV1 = { schemaVersion: 1, identity: { pluginId, novelId: identity.novelId as string, novelPath }, fields };
  assertLimits(document);
  return document;
}

/** Per field the strictly newer entry wins and a tie keeps `base`; the identity is always that of `base`. */
export function mergeWorkOverride(base: WorkOverrideV1, incoming: WorkOverrideV1): WorkOverrideV1 {
  const fields: WorkOverrideV1['fields'] = {};
  for (const name of [...new Set([...Object.keys(base.fields), ...Object.keys(incoming.fields)])].sort()) {
    const kept = Object.hasOwn(base.fields, name) ? base.fields[name] : undefined;
    const offered = Object.hasOwn(incoming.fields, name) ? incoming.fields[name] : undefined;
    fields[name] = kept && (!offered || offered.updatedAt <= kept.updatedAt) ? kept : offered!;
  }
  return { schemaVersion: 1, identity: workIdentity(base.identity), fields };
}

function overrideWork(db: DatabaseSync, id: string): OverrideWork | undefined {
  const row = db.prepare('SELECT directory,entry FROM works WHERE id=?').get(id) as { directory: string; entry: string } | undefined;
  if (!row) return undefined;
  const { metadata } = JSON.parse(row.entry) as WorkEntry;
  return { id, directory: row.directory, identity: workIdentity(metadata.identity), isLocal: metadata.identity.pluginId === 'local' || metadata.novel.isLocal };
}
function requireOverrideWork(db: DatabaseSync, id: string): OverrideWork {
  if (db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(id)) throw problem(410, 'Work was deleted from the server');
  const work = overrideWork(db, id);
  if (!work) throw problem(404, 'Work not found');
  return work;
}

/** An unreadable, invalid, or foreign-identity sibling file is ignored rather than fatal. */
function readOverrideFile(path: string, identity: WorkIdentity): WorkOverrideV1 | undefined {
  try {
    const value = parseWorkOverride(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(path, overrideFileByteLimit))));
    return sameIdentity(value.identity, identity) ? value : undefined;
  } catch { return undefined; }
}

/** Reads only: the stored document with an externally synchronized sibling file merged in first. */
function overrideState(db: DatabaseSync, dataDir: string, work: OverrideWork): OverrideState {
  const row = db.prepare('SELECT revision,document FROM work_overrides WHERE work_id=?').get(work.id) as { revision: number; document: string } | undefined;
  const stored = row ? JSON.parse(row.document) as WorkOverrideV1 : undefined;
  const disk = readOverrideFile(join(dataDir, work.directory, 'override.json'), work.identity);
  let merged: WorkOverrideV1 = { schemaVersion: 1, identity: work.identity, fields: stored?.fields ?? {} };
  if (disk) {
    const combined = mergeWorkOverride(merged, disk);
    if (withinLimits(combined)) merged = combined;
  }
  return { revision: row?.revision, stored, disk, merged };
}

/** A new server-wide revision is assigned only when the stored document changes. */
function persistOverride(db: DatabaseSync, work: OverrideWork, state: OverrideState): StoredWorkOverride | undefined {
  if (!db.isTransaction) throw new Error('Work override revisions must be assigned inside a transaction');
  if (!hasFields(state.merged)) return undefined;
  if (state.stored && sameDocument(state.stored, state.merged)) return { revision: state.revision!, override: state.merged };
  const { revision } = db.prepare('INSERT INTO work_override_revision(singleton,revision) VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1 RETURNING revision').get() as { revision: number };
  db.prepare('INSERT INTO work_overrides(work_id,revision,document) VALUES(?,?,?) ON CONFLICT(work_id) DO UPDATE SET revision=excluded.revision,document=excluded.document')
    .run(work.id, revision, JSON.stringify(state.merged));
  return { revision, override: state.merged };
}

function writeOverrideFile(dataDir: string, work: OverrideWork, state: OverrideState): void {
  if (!hasFields(state.merged) || (state.disk && sameDocument(state.disk, state.merged))) return;
  if (!existsSync(join(dataDir, work.directory))) return;
  atomicWrite(join(dataDir, work.directory, 'override.json'), JSON.stringify(state.merged, null, 2) + '\n');
}

function reconcileOverride(db: DatabaseSync, dataDir: string, work: OverrideWork, incoming?: WorkOverrideV1): StoredWorkOverride | undefined {
  return transaction(db, () => {
    const state = overrideState(db, dataDir, work);
    if (incoming) { state.merged = mergeWorkOverride(state.merged, incoming); assertLimits(state.merged); }
    const result = persistOverride(db, work, state);
    // A rejected upload leaves no row behind; a read still succeeds on storage that cannot be written.
    try { writeOverrideFile(dataDir, work, state); } catch (error) { if (incoming) throw error; }
    return result;
  });
}

export function readWorkOverride(db: DatabaseSync, dataDir: string, id: string): StoredWorkOverride {
  const work = requireOverrideWork(db, id);
  const result = work.isLocal ? undefined : reconcileOverride(db, dataDir, work);
  if (!result) throw problem(404, 'Work override not found');
  return result;
}

export function saveWorkOverride(db: DatabaseSync, dataDir: string, id: string, value: unknown): StoredWorkOverride {
  const incoming = parseWorkOverride(value);
  if (overrideWorkId(incoming.identity) !== id) throw problem(400, 'Work override identity does not match requested ID');
  if (incoming.identity.pluginId === 'local') localWork();
  const work = requireOverrideWork(db, id);
  if (work.isLocal) localWork();
  if (!sameIdentity(work.identity, incoming.identity)) throw problem(400, 'Work override identity does not match the stored work');
  // Revisions start at 1; an override without fields is never stored and reports revision 0.
  return reconcileOverride(db, dataDir, work, incoming) ?? { revision: 0, override: { schemaVersion: 1, identity: work.identity, fields: {} } };
}

export function readWorkOverrides(db: DatabaseSync, after: number, limit: number): WorkOverridePage {
  const rows = db.prepare('SELECT work_id,revision,document FROM work_overrides WHERE revision>? ORDER BY revision LIMIT ?').all(after, limit + 1) as { work_id: string; revision: number; document: string }[];
  const items = rows.slice(0, limit).map(row => ({ workId: row.work_id, revision: row.revision, override: JSON.parse(row.document) as WorkOverrideV1 }));
  return { items, cursor: items.at(-1)?.revision ?? after, hasMore: rows.length > limit };
}

/** The override a work migration carries; neither the row nor the fenced source folder is written. */
export function currentWorkOverride(db: DatabaseSync, dataDir: string, id: string): WorkOverrideV1 | undefined {
  const work = overrideWork(db, id);
  if (!work || work.isLocal) return undefined;
  const { merged } = overrideState(db, dataDir, work);
  return hasFields(merged) ? merged : undefined;
}

/**
 * Called inside the same transaction as source retirement and its receipt.
 * The target folder is fenced until that commit, so the sibling file is written
 * by the returned callback afterwards; a missed write is repaired by the next read.
 */
export function carryWorkOverride(db: DatabaseSync, dataDir: string, targetId: string, source: WorkOverrideV1 | undefined): () => void {
  if (!db.isTransaction) throw new Error('Work override carry-over must commit with source retirement');
  const work = source ? overrideWork(db, targetId) : undefined;
  if (!source || !work || work.isLocal) return () => {};
  const state = overrideState(db, dataDir, work);
  const merged = mergeWorkOverride(state.merged, source);
  // A combination beyond the document limits keeps the target's own settings.
  if (withinLimits(merged)) state.merged = merged;
  persistOverride(db, work, state);
  return () => { try { writeOverrideFile(dataDir, work, state); } catch { /* The stored row stays authoritative. */ } };
}

export function registerWorkOverrides(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; requireRead: (request: FastifyRequest) => void }): void {
  const { db, dataDir, requireRead } = context;
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
  app.get<{ Params: { id: string } }>('/api/v1/works/:id/override', { schema: { params, security: [{ bearerAuth: [] }, {}],
    description: 'Read the user-set metadata override of a work and its change-feed revision. A valid sibling override.json synchronized into the work folder is merged first.',
  } }, async (request, reply) => {
    requireRead(request); reply.header('Cache-Control', 'no-store');
    return readWorkOverride(db, dataDir, request.params.id);
  });
  app.put<{ Params: { id: string } }>('/api/v1/works/:id/override', { bodyLimit: overrideByteLimit, onRequest: async request => { authenticateDevice(db, request); }, schema: { params, security: [{ bearerAuth: [] }],
    description: 'Merge a WorkOverrideV1 document into the stored override: per field the strictly newer updatedAt wins and a tie keeps the stored entry. The revision advances only when the stored document changes.',
  } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return saveWorkOverride(db, dataDir, request.params.id, request.body);
  });
  app.get<{ Querystring: { after: number; limit: number } }>('/api/v1/work-overrides', { schema: {
    querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } },
    security: [{ bearerAuth: [] }, {}],
    description: 'Read stored work overrides in ascending revision order. Each work appears once, at the revision of its latest change.',
  } }, async (request, reply) => {
    requireRead(request); reply.header('Cache-Control', 'no-store');
    return readWorkOverrides(db, request.query.after, request.query.limit);
  });
}
