import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticateDevice } from './auth.ts';
import { problem, transaction } from './db.ts';
import { digest, validateStorageIdentity } from './packages.ts';
import { atomicWrite, coverByteLimit, coverContentType, isNovelStatus, isOverrideCoverFile, readBytes, type NovelMetadataV1 } from './works.ts';

type WorkIdentity = NovelMetadataV1['identity'];
export interface WorkOverrideField { value: string | number | boolean | null; updatedAt: number }
export interface WorkOverrideV1 { schemaVersion: 1; identity: WorkIdentity; fields: Record<string, WorkOverrideField> }
export interface StoredWorkOverride { revision: number; override: WorkOverrideV1 }
export interface WorkOverridePage { items: (StoredWorkOverride & { workId: string })[]; cursor: number; hasMore: boolean }
export interface CarriedWorkOverride { override: WorkOverrideV1; cover?: { fileName: string; bytes: Buffer } }
interface OverrideWork { id: string; directory: string; identity: WorkIdentity; isLocal: boolean }
interface OverrideState { revision?: number; stored?: WorkOverrideV1; disk?: WorkOverrideV1; merged: WorkOverrideV1 }

/** Applies to the compact canonical document; it is also the PUT body limit. */
export const overrideByteLimit = 256 * 1024;
/** A synchronized sibling file may be pretty-printed, so its raw bytes get more room than the document. */
const overrideFileByteLimit = 4 * overrideByteLimit;
const maxFields = 64;
const maxTextLength = 8192;
const maxSummaryLength = 65536;
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

function validWellFormedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && value.isWellFormed();
}

/** Unknown top-level keys are dropped; legacy `completed` upgrades to `status`; unknown validly shaped fields stay verbatim. */
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
  const rawFields: Record<string, WorkOverrideField> = {};
  let legacyCompleted: { value: string | null; updatedAt: number } | undefined;
  for (const [name, entry] of entries) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(name)) invalid('invalid field name');
    const field = record(entry);
    if (Object.keys(field).length !== 2 || !Object.hasOwn(field, 'value') || !Object.hasOwn(field, 'updatedAt')) invalid('invalid field entry');
    let content = field.value; const updatedAt = field.updatedAt;
    if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) <= 0) invalid('invalid field timestamp');
    if (name === 'completed') {
      if (content !== null && typeof content !== 'boolean') invalid('completed must be a boolean or null');
      legacyCompleted = { value: content === true ? 'Completed' : content === false ? 'Ongoing' : null, updatedAt: updatedAt as number };
      continue;
    }
    if (name === 'status') {
      if (content !== null && !isNovelStatus(content)) invalid('status must be a canonical NovelStatus or null');
    } else if (name === 'cover') {
      if (content !== null && (typeof content !== 'string' || !isOverrideCoverFile(content))) invalid('cover must be a valid override cover filename or null');
    } else if (name === 'name') {
      if (content !== null) {
        if (!validWellFormedText(content, maxTextLength) || !content.trim()) invalid('name must be non-empty text or null');
        content = (content as string).trim();
      }
    } else if (name === 'summary') {
      if (content !== null && !validWellFormedText(content, maxSummaryLength)) invalid('invalid field value');
    } else {
      if (content !== null && typeof content !== 'boolean' && !(typeof content === 'number' && Number.isFinite(content))
        && !validWellFormedText(content, maxTextLength)) invalid('invalid field value');
    }
    rawFields[name] = { value: content as WorkOverrideField['value'], updatedAt: updatedAt as number };
  }
  if (legacyCompleted && (!rawFields.status || legacyCompleted.updatedAt > rawFields.status.updatedAt)) {
    rawFields.status = legacyCompleted;
  }
  const fields: WorkOverrideV1['fields'] = {};
  for (const name of Object.keys(rawFields).sort()) fields[name] = rawFields[name]!;
  const document: WorkOverrideV1 = { schemaVersion: 1, identity: { pluginId, novelId: identity.novelId as string, novelPath }, fields };
  assertLimits(document);
  return document;
}

/** Projects user-set override fields over source novel metadata while leaving absent or null-valued fields untouched. */
export function applyWorkOverrideToNovel(novel: NovelMetadataV1['novel'], override?: WorkOverrideV1 | null): NovelMetadataV1['novel'] {
  const fields = override?.fields;
  if (!fields) return novel;
  const name = typeof fields.name?.value === 'string' && fields.name.value.trim() ? fields.name.value.trim() : novel.name;
  const textField = (entry: WorkOverrideField | undefined, fallback: string | null): string | null => {
    if (!entry || typeof entry.value !== 'string') return fallback;
    const trimmed = entry.value.trim();
    return trimmed ? trimmed : null;
  };
  const summaryField = (entry: WorkOverrideField | undefined, fallback: string | null): string | null => {
    if (!entry || typeof entry.value !== 'string') return fallback;
    return entry.value.trim() ? entry.value : null;
  };
  const statusField = fields.status;
  const status = statusField && isNovelStatus(statusField.value) ? statusField.value : novel.status;
  return {
    ...novel,
    name,
    author: textField(fields.author, novel.author),
    artist: textField(fields.artist, novel.artist),
    summary: summaryField(fields.summary, novel.summary),
    status,
    genres: textField(fields.genres, novel.genres),
  };
}

export function overrideCoverBytes(directory: string, override?: WorkOverrideV1 | null): { fileName: string; contentType: string | null; bytes: Buffer } | undefined {
  const fileName = override?.fields.cover?.value;
  if (typeof fileName !== 'string' || !isOverrideCoverFile(fileName)) return undefined;
  try {
    const bytes = readBytes(join(directory, fileName), coverByteLimit);
    return bytes.length ? { fileName, contentType: coverContentType(fileName), bytes } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function overrideCoverBytesForWork(db: DatabaseSync, dataDir: string, id: string): { fileName: string; contentType: string | null; bytes: Buffer } | undefined {
  const work = overrideWork(db, id);
  if (!work || work.isLocal) return undefined;
  const { merged } = overrideState(db, dataDir, work);
  return overrideCoverBytes(join(dataDir, work.directory), merged);
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
  const row = db.prepare('SELECT directory,plugin_id,novel_id,novel_path,is_local FROM work_summaries WHERE id=?').get(id) as
    { directory: string; plugin_id: string; novel_id: string; novel_path: string; is_local: number } | undefined;
  if (!row) return undefined;
  const identity = workIdentity({ pluginId: row.plugin_id, novelId: row.novel_id, novelPath: row.novel_path });
  return { id, directory: row.directory, identity, isLocal: identity.pluginId === 'local' || Boolean(row.is_local) };
}
function requireOverrideWork(db: DatabaseSync, id: string): OverrideWork {
  if (db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(id)) throw problem(410, 'Work was deleted from the server');
  const work = overrideWork(db, id);
  if (!work) throw problem(404, 'Work not found');
  return work;
}

function hasValidOverrideCoverFile(directory: string, fileName: string): boolean {
  if (!isOverrideCoverFile(fileName)) return false;
  try { return readBytes(join(directory, fileName), coverByteLimit).length > 0; }
  catch { return false; }
}

function removeOverrideCoverFiles(directory: string, keepFileName?: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!isOverrideCoverFile(entry.name) || entry.name === keepFileName) continue;
    const path = join(directory, entry.name);
    if (!lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
  }
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
  const storedRaw = row ? JSON.parse(row.document) : undefined;
  const storedParsed = storedRaw ? parseWorkOverride(storedRaw) : undefined;
  const disk = readOverrideFile(join(dataDir, work.directory, 'override.json'), work.identity);
  if (disk?.fields.cover?.value && !hasValidOverrideCoverFile(join(dataDir, work.directory), disk.fields.cover.value as string)) {
    delete disk.fields.cover;
  }
  let merged: WorkOverrideV1 = { schemaVersion: 1, identity: work.identity, fields: storedParsed?.fields ?? {} };
  if (disk) {
    const combined = mergeWorkOverride(merged, disk);
    if (withinLimits(combined)) merged = combined;
  }
  return { revision: row?.revision, stored: storedRaw as WorkOverrideV1 | undefined, disk, merged };
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

function syncOverrideCoverCleanup(dataDir: string, work: OverrideWork, override: WorkOverrideV1): void {
  const cover = override.fields.cover;
  if (!cover || cover.value !== null) return;
  removeOverrideCoverFiles(join(dataDir, work.directory));
}

function sanitizeIncomingMetadataCover(incoming: WorkOverrideV1, current: WorkOverrideV1): WorkOverrideV1 {
  const offeredCover = incoming.fields.cover;
  if (!offeredCover || offeredCover.value === null) return incoming;
  const keptCover = current.fields.cover;
  if (keptCover && keptCover.value === offeredCover.value && keptCover.updatedAt === offeredCover.updatedAt) {
    return incoming;
  }
  const fields = { ...incoming.fields };
  delete fields.cover;
  return { ...incoming, fields };
}

function reconcileOverride(db: DatabaseSync, dataDir: string, work: OverrideWork, incoming?: WorkOverrideV1): StoredWorkOverride | undefined {
  return transaction(db, () => {
    const state = overrideState(db, dataDir, work);
    if (incoming) {
      const sanitized = sanitizeIncomingMetadataCover(incoming, state.merged);
      state.merged = mergeWorkOverride(state.merged, sanitized);
      assertLimits(state.merged);
    }
    const result = persistOverride(db, work, state);
    // A rejected upload leaves no row behind; a read still succeeds on storage that cannot be written.
    try {
      syncOverrideCoverCleanup(dataDir, work, state.merged);
      writeOverrideFile(dataDir, work, state);
    } catch (error) { if (incoming) throw error; }
    return result;
  });
}

/** Upgrades any stored legacy `completed` override rows to canonical `status` and mirrors sibling files. */
export function upgradeWorkOverrides(db: DatabaseSync, dataDir: string): void {
  transaction(db, () => {
    const rows = db.prepare("SELECT work_id,document FROM work_overrides WHERE json_type(document,'$.fields.completed') IS NOT NULL")
      .all() as { work_id: string; document: string }[];
    for (const row of rows) {
      const parsed = parseWorkOverride(JSON.parse(row.document));
      const canonical = JSON.stringify(parsed);
      if (canonical === row.document) continue;
      const { revision } = db.prepare('INSERT INTO work_override_revision(singleton,revision) VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET revision=revision+1 RETURNING revision').get() as { revision: number };
      db.prepare('UPDATE work_overrides SET revision=?,document=? WHERE work_id=?').run(revision, canonical, row.work_id);
      const work = overrideWork(db, row.work_id);
      if (work && !work.isLocal && existsSync(join(dataDir, work.directory))) {
        try {
          atomicWrite(join(dataDir, work.directory, 'override.json'), JSON.stringify(parsed, null, 2) + '\n');
        } catch { /* Stored row stays authoritative when the content directory is read-only. */ }
      }
    }
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

export function saveWorkOverrideCover(
  db: DatabaseSync,
  dataDir: string,
  id: string,
  fileName: string,
  updatedAt: number,
  bytes: Buffer,
): StoredWorkOverride {
  if (!isOverrideCoverFile(fileName)) throw problem(400, 'work override: invalid override cover filename');
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw problem(400, 'work override: invalid cover timestamp');
  if (!bytes.length || bytes.length > coverByteLimit) throw problem(413, 'Cover must contain at most 10 MiB');
  const work = requireOverrideWork(db, id);
  if (work.isLocal) localWork();
  return transaction(db, () => {
    const state = overrideState(db, dataDir, work);
    const kept = state.merged.fields.cover;
    if (kept && updatedAt <= kept.updatedAt) {
      return persistOverride(db, work, state) ?? { revision: 0, override: state.merged };
    }
    const candidate = mergeWorkOverride(state.merged, {
      schemaVersion: 1,
      identity: work.identity,
      fields: { cover: { value: fileName, updatedAt } },
    });
    assertLimits(candidate);
    const directory = join(dataDir, work.directory);
    atomicWrite(join(directory, fileName), bytes);
    removeOverrideCoverFiles(directory, fileName);
    state.merged = candidate;
    const result = persistOverride(db, work, state)!;
    writeOverrideFile(dataDir, work, state);
    return result;
  });
}

export function readWorkOverrideCover(db: DatabaseSync, dataDir: string, id: string): { fileName: string; contentType: string | null; bytes: Buffer } {
  const work = requireOverrideWork(db, id);
  if (work.isLocal) throw problem(404, 'Work override cover not found');
  const reconciled = reconcileOverride(db, dataDir, work);
  const cover = overrideCoverBytes(join(dataDir, work.directory), reconciled?.override);
  if (!cover) throw problem(404, 'Work override cover not found');
  return cover;
}

export function readWorkOverrides(db: DatabaseSync, after: number, limit: number): WorkOverridePage {
  const rows = db.prepare('SELECT work_id,revision,document FROM work_overrides WHERE revision>? ORDER BY revision LIMIT ?').all(after, limit + 1) as { work_id: string; revision: number; document: string }[];
  const items = rows.slice(0, limit).map(row => ({ workId: row.work_id, revision: row.revision, override: parseWorkOverride(JSON.parse(row.document)) }));
  return { items, cursor: items.at(-1)?.revision ?? after, hasMore: rows.length > limit };
}

/** The override a work migration carries; neither the row nor the fenced source folder is written. */
export function currentWorkOverride(db: DatabaseSync, dataDir: string, id: string): CarriedWorkOverride | undefined {
  const work = overrideWork(db, id);
  if (!work || work.isLocal) return undefined;
  const { merged } = overrideState(db, dataDir, work);
  if (!hasFields(merged)) return undefined;
  const cover = overrideCoverBytes(join(dataDir, work.directory), merged);
  return { override: merged, ...(cover ? { cover: { fileName: cover.fileName, bytes: cover.bytes } } : {}) };
}

/**
 * Called inside the same transaction as source retirement and its receipt.
 * The target folder is fenced until that commit, so the sibling files are written
 * by the returned callback afterwards; a missed write is repaired by the next read.
 */
export function carryWorkOverride(db: DatabaseSync, dataDir: string, targetId: string, source: CarriedWorkOverride | undefined): () => void {
  if (!db.isTransaction) throw new Error('Work override carry-over must commit with source retirement');
  const work = source ? overrideWork(db, targetId) : undefined;
  if (!source || !work || work.isLocal) return () => {};
  const state = overrideState(db, dataDir, work);
  const merged = mergeWorkOverride(state.merged, source.override);
  const acceptable = withinLimits(merged);
  const carryCover = acceptable && source.cover && merged.fields.cover?.value === source.cover.fileName && merged.fields.cover?.updatedAt === source.override.fields.cover?.updatedAt
    ? source.cover
    : undefined;
  const clearCover = acceptable && merged.fields.cover?.value === null;
  if (acceptable) state.merged = merged;
  persistOverride(db, work, state);
  return () => {
    try {
      const directory = join(dataDir, work.directory);
      if (carryCover && existsSync(directory)) {
        atomicWrite(join(directory, carryCover.fileName), carryCover.bytes);
        removeOverrideCoverFiles(directory, carryCover.fileName);
      } else if (clearCover) {
        removeOverrideCoverFiles(directory);
      }
      writeOverrideFile(dataDir, work, state);
    } catch { /* The stored row stays authoritative. */ }
  };
}

export function registerWorkOverrides(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; requireRead: (request: FastifyRequest) => void; notify?: () => void }): void {
  const { db, dataDir, requireRead, notify } = context;
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
    const result = saveWorkOverride(db, dataDir, request.params.id, request.body);
    if (result.revision > 0) notify?.();
    return result;
  });
  app.get<{ Params: { id: string } }>('/api/v1/works/:id/override/cover', { schema: { params, security: [{ bearerAuth: [] }, {}],
    description: 'Read the active cover.override image bytes for a work when set.',
  } }, async (request, reply) => {
    requireRead(request);
    const cover = readWorkOverrideCover(db, dataDir, request.params.id);
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").type(cover.contentType ?? 'application/octet-stream').send(cover.bytes);
  });
  app.put<{ Params: { id: string }; Querystring: { fileName: string; updatedAt: number }; Body: Buffer }>('/api/v1/works/:id/override/cover', {
    bodyLimit: coverByteLimit,
    onRequest: async request => { authenticateDevice(db, request); },
    schema: {
      params,
      querystring: { type: 'object', additionalProperties: false, required: ['fileName', 'updatedAt'], properties: { fileName: { type: 'string', pattern: '^cover\\.override\\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$' }, updatedAt: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } },
      security: [{ bearerAuth: [] }],
      description: 'Store an override cover image under cover.override.<ext> without altering the original source cover file.',
    },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw problem(415, 'Raw image bytes are required');
    reply.header('Cache-Control', 'no-store');
    const result = saveWorkOverrideCover(db, dataDir, request.params.id, request.query.fileName, request.query.updatedAt, request.body);
    if (result.revision > 0) notify?.();
    return result;
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
