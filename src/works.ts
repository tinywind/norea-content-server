import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticate, authenticateDevice } from './auth.ts';
import { problem, transaction } from './db.ts';
import { digest, safeArchivePath } from './packages.ts';

export interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelPath: string };
  novel: { name: string; cover: string | null; author: string | null; artist: string | null; summary: string | null; status: string | null; genres: string | null; isLocal: boolean };
  chapters: { path: string; name: string; chapterNumber: string | null; position: number; page: string; contentType: 'html' | 'text' | 'markdown' | 'pdf' | 'epub'; releaseTime: string | null; directory: string }[];
  cover: { fileName: string; contentType: string | null; sourceUrl: string } | null;
  updatedAt: number;
}
export interface WorkEntry { id: string; sequence: number; metadata: NovelMetadataV1; hasCover: boolean }
interface WorkRow { id: string; directory: string; entry: string; fingerprint: string }
export const metadataByteLimit = 16 * 1024 ** 2;
export const coverByteLimit = 10 * 1024 ** 2;
export const metadataWorkId = (value: NovelMetadataV1) => digest(JSON.stringify([value.identity.pluginId, value.identity.novelPath]));
const validSegment = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 240 && value !== '.' && value !== '..' && !/[\x00-\x1f<>:"/\\|?*]/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);

export function validateNovelMetadata(value: unknown): asserts value is NovelMetadataV1 {
  const object = (input: unknown, keys: string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw problem(400, 'Invalid or unknown work metadata fields');
    return input as Record<string, unknown>;
  };
  const text = (input: unknown, required = false) => typeof input === 'string' && input.isWellFormed() && (!required || (input.trim().length > 0 && input.length <= 4096));
  const nullable = (input: unknown) => input === null || text(input);
  const m = object(value, ['schemaVersion', 'identity', 'novel', 'chapters', 'cover', 'updatedAt']);
  const identity = object(m.identity, ['pluginId', 'novelPath']);
  const novel = object(m.novel, ['name', 'cover', 'author', 'artist', 'summary', 'status', 'genres', 'isLocal']);
  if (m.schemaVersion !== 1 || !Number.isSafeInteger(m.updatedAt) || (m.updatedAt as number) < 0 || !text(identity.pluginId, true) || !text(identity.novelPath, true) || !text(novel.name, true) || typeof novel.isLocal !== 'boolean') throw problem(400, 'Invalid work identity or metadata');
  for (const key of ['cover', 'author', 'artist', 'summary', 'status', 'genres']) if (!nullable(novel[key])) throw problem(400, 'Invalid novel metadata');
  if (!Array.isArray(m.chapters) || m.chapters.length > 100000) throw problem(400, 'Invalid chapter list');
  const paths = new Set<string>(); const directories = new Set<string>();
  for (const value of m.chapters) {
    const chapter = object(value, ['path', 'name', 'chapterNumber', 'position', 'page', 'contentType', 'releaseTime', 'directory']);
    if (!text(chapter.path, true) || !text(chapter.name, true) || !nullable(chapter.chapterNumber) || typeof chapter.position !== 'number' || !Number.isSafeInteger(chapter.position) || chapter.position < 0 || !text(chapter.page, true) || !nullable(chapter.releaseTime) || !['html', 'text', 'markdown', 'pdf', 'epub'].includes(chapter.contentType as string) || !validSegment(chapter.directory) || /^(novel\.json|cover(?:\.|$))/i.test(chapter.directory)) throw problem(400, 'Invalid chapter metadata or directory');
    if (paths.has(chapter.path as string) || directories.has(chapter.directory.toLowerCase())) throw problem(400, 'Duplicate chapter path or directory');
    paths.add(chapter.path as string); directories.add(chapter.directory.toLowerCase());
  }
  if (m.cover !== null) {
    const cover = object(m.cover, ['fileName', 'contentType', 'sourceUrl']);
    if (!validSegment(cover.fileName) || !/^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(cover.fileName) || !nullable(cover.contentType) || !text(cover.sourceUrl, true) || (typeof cover.contentType === 'string' && !/^image\/[a-zA-Z0-9.+-]+$/.test(cover.contentType))) throw problem(400, 'Invalid work cover');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > metadataByteLimit) throw problem(413, 'Work metadata exceeds byte limit');
}

function noLinks(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw problem(400, 'Symbolic work paths are unsupported');
    if (dirname(current) === current) break;
  }
}
function readBytes(path: string, limit: number): Buffer {
  noLinks(path);
  const info = lstatSync(path);
  if (!info.isFile()) throw problem(400, 'Expected a regular work file');
  if (info.size > limit) throw problem(413, 'Work file exceeds byte limit');
  const bytes = readFileSync(path);
  if (bytes.length > limit) throw problem(413, 'Work file exceeds byte limit');
  return bytes;
}
export function readNovelMetadata(path: string): NovelMetadataV1 {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(path, metadataByteLimit))); }
  catch (error) { throw problem(400, `Cannot read novel.json: ${(error as Error).message}`); }
  validateNovelMetadata(value); return value;
}
function atomicWrite(path: string, bytes: string | Buffer): void {
  noLinks(path); mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx'); writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
  } finally { if (descriptor !== undefined) closeSync(descriptor); rmSync(temporary, { force: true }); }
}
const rowFor = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM works WHERE id=?').get(id) as WorkRow | undefined;
function coverBytes(directory: string, metadata: NovelMetadataV1): Buffer | undefined {
  if (!metadata.cover) return undefined;
  const path = join(directory, metadata.cover.fileName);
  try { return readBytes(path, coverByteLimit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function cacheWork(db: DatabaseSync, dataDir: string, directory: string, metadata: NovelMetadataV1): WorkEntry {
  const id = metadataWorkId(metadata); const existing = rowFor(db, id);
  if (existing && existing.directory !== directory) throw problem(409, 'Duplicate work identity in different folders');
  const cover = coverBytes(join(dataDir, directory), metadata);
  const fingerprint = digest(canonicalize(metadata) + '\n' + (cover ? digest(cover) : ''));
  if (existing?.fingerprint === fingerprint) return JSON.parse(existing.entry) as WorkEntry;
  return transaction(db, () => {
    const entry: WorkEntry = { id, sequence: 0, metadata, hasCover: cover !== undefined };
    const sequence = db.prepare('INSERT INTO work_changes(work_id,entry) VALUES(?,?)').run(id, '{}').lastInsertRowid;
    entry.sequence = Number(sequence); const json = JSON.stringify(entry);
    db.prepare('UPDATE work_changes SET entry=? WHERE sequence=?').run(json, sequence);
    db.prepare('INSERT INTO works(id,directory,entry,fingerprint) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry,fingerprint=excluded.fingerprint').run(id, directory, json, fingerprint);
    return entry;
  });
}

export function rebuildWorkIndex(db: DatabaseSync, dataDir: string): void {
  const root = join(dataDir, 'contents'); noLinks(root); if (!existsSync(root)) return;
  for (const source of readdirSync(root, { withFileTypes: true })) {
    if (!source.isDirectory() || source.isSymbolicLink()) continue;
    for (const work of readdirSync(join(root, source.name), { withFileTypes: true })) {
      if (!work.isDirectory() || work.isSymbolicLink()) continue;
      const directory = join('contents', source.name, work.name); const file = join(dataDir, directory, 'novel.json');
      if (existsSync(file)) cacheWork(db, dataDir, directory, readNovelMetadata(file));
    }
  }
}
function workDirectory(db: DatabaseSync, metadata: NovelMetadataV1): string {
  const id = metadataWorkId(metadata); const existing = rowFor(db, id); if (existing) return existing.directory;
  const chapter = db.prepare('SELECT directory FROM chapters WHERE work_id=? LIMIT 1').get(id) as { directory: string } | undefined;
  if (chapter) return dirname(chapter.directory);
  const segment = (value: string, fallback: string) => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || fallback;
  const source = segment(metadata.identity.pluginId, 'source'); const name = segment(metadata.novel.name, 'work');
  const directory = join('contents', safeArchivePath(source) ? source : 'source', `${name}-${id.slice(0, 16)}`);
  if (!safeArchivePath(directory.split('\\').join('/'))) throw problem(400, 'Invalid readable work directory');
  return directory;
}
export function saveWork(db: DatabaseSync, dataDir: string, value: unknown, expectedId?: string): WorkEntry {
  validateNovelMetadata(value); const id = metadataWorkId(value);
  if (expectedId !== undefined && expectedId !== id) throw problem(400, 'Work identity does not match requested ID');
  const directory = workDirectory(db, value);
  const collision = db.prepare('SELECT id FROM works WHERE lower(directory)=lower(?) AND id<>?').get(directory, id);
  if (collision) throw problem(409, 'Work directory is already assigned');
  atomicWrite(join(dataDir, directory, 'novel.json'), JSON.stringify(value, null, 2) + '\n');
  return cacheWork(db, dataDir, directory, value);
}
export function getWork(db: DatabaseSync, dataDir: string, id: string): WorkEntry {
  const row = rowFor(db, id); if (!row) throw problem(404, 'Work not found');
  const metadata = readNovelMetadata(join(dataDir, row.directory, 'novel.json'));
  if (metadataWorkId(metadata) !== id) throw problem(409, 'Stored work identity changed');
  return cacheWork(db, dataDir, row.directory, metadata);
}
export function saveWorkCover(db: DatabaseSync, dataDir: string, id: string, bytes: Buffer): WorkEntry {
  const entry = getWork(db, dataDir, id); if (!entry.metadata.cover) throw problem(409, 'Work metadata has no cover descriptor');
  if (!bytes.length || bytes.length > coverByteLimit) throw problem(413, 'Cover must contain at most 10 MiB');
  const directory = rowFor(db, id)!.directory;
  atomicWrite(join(dataDir, directory, entry.metadata.cover.fileName), bytes);
  atomicWrite(join(dataDir, directory, 'cover.json'), JSON.stringify({ ...entry.metadata.cover, version: 1, sourceId: entry.metadata.identity.pluginId, novelPath: entry.metadata.identity.novelPath, updatedAt: entry.metadata.updatedAt }, null, 2) + '\n');
  return cacheWork(db, dataDir, directory, entry.metadata);
}

export function registerWorks(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; requireRead: (request: FastifyRequest) => void; notify: () => void }): void {
  const { db, dataDir, requireRead, notify } = context;
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
  app.addContentTypeParser(/^image\/[a-zA-Z0-9.+-]+$/, { parseAs: 'buffer', bodyLimit: coverByteLimit }, (_request, body, done) => done(null, body));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: coverByteLimit }, (_request, body, done) => done(null, body));
  app.put<{ Params: { id: string } }>('/api/v1/works/:id', { bodyLimit: metadataByteLimit, onRequest: async request => { authenticateDevice(db, request); }, schema: { params, security: [{ bearerAuth: [] }] } }, async request => {
    const entry = saveWork(db, dataDir, request.body, request.params.id); notify(); return entry;
  });
  app.get<{ Querystring: { after: number; limit: number } }>('/api/v1/works', { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } } } }, async request => {
    requireRead(request); rebuildWorkIndex(db, dataDir);
    const { after, limit } = request.query;
    const rows = db.prepare('SELECT entry FROM work_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit + 1) as { entry: string }[];
    const items = rows.slice(0, limit).map(row => JSON.parse(row.entry) as WorkEntry);
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  });
  app.get<{ Params: { id: string } }>('/api/v1/works/:id', { schema: { params } }, async request => { requireRead(request); return getWork(db, dataDir, request.params.id); });
  app.put<{ Params: { id: string }; Body: Buffer }>('/api/v1/works/:id/cover', { bodyLimit: coverByteLimit, onRequest: async request => { authenticateDevice(db, request); }, schema: { params, security: [{ bearerAuth: [] }] } }, async request => {
    if (!Buffer.isBuffer(request.body)) throw problem(415, 'Raw image bytes are required');
    const entry = saveWorkCover(db, dataDir, request.params.id, request.body); notify(); return entry;
  });
  for (const prefix of ['/api/v1/works', '/api/v1/admin/works']) {
    app.get<{ Params: { id: string } }>(`${prefix}/:id/cover`, { schema: { params } }, async (request, reply) => {
      if (prefix.includes('/admin/')) authenticate(db, request, true); else requireRead(request);
      const entry = getWork(db, dataDir, request.params.id);
      const bytes = coverBytes(join(dataDir, rowFor(db, entry.id)!.directory), entry.metadata); if (!bytes) throw problem(404, 'Cover not found');
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").type(entry.metadata.cover!.contentType ?? 'application/octet-stream').send(bytes);
    });
  }
  app.get<{ Querystring: { search: string; offset: number; limit: number } }>('/api/v1/admin/works', { schema: { querystring: { type: 'object', properties: { search: { type: 'string', maxLength: 500, default: '' }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } } } }, async (request, reply) => {
    authenticate(db, request, true); reply.header('Cache-Control', 'no-store'); rebuildWorkIndex(db, dataDir);
    const where = "WHERE (?='' OR instr(lower(json_extract(w.entry,'$.metadata.novel.name') || ' ' || json_extract(w.entry,'$.metadata.identity.pluginId')),lower(?))>0)";
    const args = [request.query.search, request.query.search];
    const rows = db.prepare(`SELECT w.entry,(SELECT COUNT(*) FROM chapters c WHERE c.work_id=w.id AND c.deleted_at IS NULL) AS downloadedChapters FROM works w ${where} ORDER BY json_extract(w.entry,'$.metadata.novel.name'),w.id LIMIT ? OFFSET ?`).all(...args, request.query.limit, request.query.offset) as { entry: string; downloadedChapters: number }[];
    return { items: rows.map(row => { const entry = JSON.parse(row.entry) as WorkEntry; return { ...entry, chapterCount: entry.metadata.chapters.length, downloadedChapters: row.downloadedChapters }; }), total: (db.prepare(`SELECT COUNT(*) AS n FROM works w ${where}`).get(...args) as { n: number }).n };
  });
}
