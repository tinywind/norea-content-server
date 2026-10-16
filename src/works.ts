import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticate, authenticateDevice } from './auth.ts';
import { problem, transaction } from './db.ts';
import { digest, recordEntry, safeArchivePath, type CatalogEntry } from './packages.ts';

export interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelPath: string };
  novel: {
    name: string;
    author: string | null;
    artist: string | null;
    summary: string | null;
    status: string | null;
    genres: string | null;
    rating: number | null;
    isLocal: boolean;
  };
  cover: { fileName: string; contentType: string | null } | null;
  chapters: Record<string, string>;
}

export interface WorkEntry { id: string; sequence: number; metadata: NovelMetadataV1; hasCover: boolean; deleted?: boolean }
interface WorkRow { id: string; directory: string; entry: string; fingerprint: string }
export const metadataByteLimit = 16 * 1024 ** 2;
export const coverByteLimit = 10 * 1024 ** 2;
export const metadataWorkId = (value: NovelMetadataV1) => digest(JSON.stringify([value.identity.pluginId, value.identity.novelPath]));
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'work metadata: expected object');
  return value as Record<string, unknown>;
}

function text(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > (nullable ? metadataByteLimit : 4096) || (!nullable && !value.trim()) ||
    Array.from(value).some((character) => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) {
    throw problem(400, 'work metadata: invalid text');
  }
}

export function parseNovelMetadata(raw: unknown): NovelMetadataV1 {
  const value = record(raw);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw problem(400, 'work metadata: invalid version');
  }
  const identity = record(value.identity);
  text(identity.pluginId); text(identity.novelPath);
  if ((identity.novelPath as string).startsWith('norea-folder:')) throw problem(400, 'work metadata: source work identity required');
  if (/^(?:https?:)?\/\//i.test(identity.novelPath as string)) throw problem(400, 'work metadata: work identity must exclude the base URL');
  const novel = record(value.novel);
  text(novel.name);
  for (const key of ['author', 'artist', 'summary', 'status', 'genres']) text(novel[key] ?? null, true);
  if (novel.rating != null && (typeof novel.rating !== 'number' || !Number.isFinite(novel.rating) || novel.rating < 0 || novel.rating > 5)) throw problem(400, 'work metadata: invalid rating');
  if (novel.isLocal != null && typeof novel.isLocal !== 'boolean') throw problem(400, 'work metadata: invalid local flag');
  const chapters: NovelMetadataV1['chapters'] = {};
  if (value.chapters !== undefined) {
    for (const [number, name] of Object.entries(record(value.chapters))) {
      if (!Number.isFinite(Number(number)) || String(Number(number)) !== number) throw problem(400, 'work metadata: invalid chapter number');
      text(name);
      chapters[number] = name as string;
    }
  }
  let cover: NovelMetadataV1['cover'] = null;
  if (value.cover != null) {
    const input = record(value.cover);
    text(input.fileName); text(input.contentType ?? null, true);
    if (input.contentType != null && !/^image\/[a-zA-Z0-9.+-]+$/.test(input.contentType as string)) throw problem(400, 'work metadata: invalid cover content type');
    if (!/^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(input.fileName as string)) throw problem(400, 'work metadata: unsafe cover filename');
    cover = { fileName: input.fileName as string, contentType: input.contentType as string | undefined ?? coverContentType(input.fileName as string) };
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > metadataByteLimit) throw problem(413, 'work metadata: document exceeds size limit');
  const parsed = value as unknown as NovelMetadataV1;
  return {
    schemaVersion: 1,
    identity: { pluginId: parsed.identity.pluginId, novelPath: parsed.identity.novelPath },
    novel: {
      name: parsed.novel.name, author: parsed.novel.author ?? null,
      artist: parsed.novel.artist ?? null, summary: parsed.novel.summary ?? null, status: parsed.novel.status ?? null,
      genres: parsed.novel.genres ?? null, rating: parsed.novel.rating ?? null, isLocal: parsed.novel.isLocal ?? false,
    },
    cover,
    chapters,
  };
}

export function coverContentType(fileName: string): string | null {
  const extension = fileName.split('.').at(-1);
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'svg') return 'image/svg+xml';
  return extension && ['avif', 'bmp', 'gif', 'png', 'webp'].includes(extension) ? `image/${extension}` : null;
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
  return parseNovelMetadata(value);
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
  try { const bytes = readBytes(path, coverByteLimit); return bytes.length ? bytes : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export const isCoverFile = (name: string) => /^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(name);
function discoverCover(directory: string, preferred: NovelMetadataV1['cover']): NovelMetadataV1['cover'] {
  noLinks(directory);
  if (!existsSync(directory)) return preferred;
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter(file => isCoverFile(file.name) && file.isFile() && !file.isSymbolicLink() && lstatSync(join(directory, file.name)).size > 0)
    .map(file => file.name).sort();
  const fileName = candidates.includes(preferred?.fileName ?? '') ? preferred!.fileName : candidates[0];
  return fileName ? { fileName, contentType: fileName === preferred?.fileName ? preferred.contentType : coverContentType(fileName) } : preferred;
}
export function cacheWork(db: DatabaseSync, dataDir: string, directory: string, metadata: NovelMetadataV1, restore = false): WorkEntry {
  metadata = { ...metadata, cover: discoverCover(join(dataDir, directory), metadata.cover) };
  const id = metadataWorkId(metadata); const existing = rowFor(db, id);
  if (!restore && db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(id)) throw problem(409, 'Work was deleted from the server');
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
    if (restore) db.prepare('UPDATE work_tombstones SET deleted=0 WHERE work_id=?').run(id);
    return entry;
  });
}

export function rebuildWorkIndex(db: DatabaseSync, dataDir: string): void {
  const valid = new Set<string>();
  const root = join(dataDir, 'contents'); noLinks(root); mkdirSync(root, { recursive: true });
  for (const source of readdirSync(root, { withFileTypes: true })) {
    if (!source.isDirectory() || source.isSymbolicLink()) continue;
    for (const work of readdirSync(join(root, source.name), { withFileTypes: true })) {
      if (!work.isDirectory() || work.isSymbolicLink()) continue;
      const directory = join('contents', source.name, work.name); const file = join(dataDir, directory, 'novel.json');
      if (!existsSync(file)) continue;
      let metadata: NovelMetadataV1;
      try { metadata = readNovelMetadata(file); } catch { continue; }
      if (db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(metadataWorkId(metadata))) continue;
      valid.add(cacheWork(db, dataDir, directory, metadata).id);
    }
  }
  transaction(db, () => {
    for (const row of db.prepare('SELECT sequence,entry FROM work_changes').all() as { sequence: number; entry: string }[]) {
      try { parseNovelMetadata(JSON.parse(row.entry).metadata); }
      catch { db.prepare('DELETE FROM work_changes WHERE sequence=?').run(row.sequence); }
    }
    for (const row of db.prepare('SELECT id FROM works').all() as { id: string }[]) {
      if (valid.has(row.id)) continue;
      db.prepare('DELETE FROM work_changes WHERE work_id=?').run(row.id);
      db.prepare('DELETE FROM works WHERE id=?').run(row.id);
    }
    db.exec('DELETE FROM catalog_changes WHERE chapter_id IN (SELECT id FROM chapters WHERE work_id NOT IN (SELECT id FROM works) AND work_id NOT IN (SELECT work_id FROM work_tombstones)); DELETE FROM chapters WHERE work_id NOT IN (SELECT id FROM works)');
  });
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
export function saveWork(db: DatabaseSync, dataDir: string, value: unknown, expectedId?: string, restore = false): WorkEntry {
  const metadata = parseNovelMetadata(value); const id = metadataWorkId(metadata);
  if (!restore && db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(id)) throw problem(410, 'Work was deleted from the server');
  if (expectedId !== undefined && expectedId !== id) throw problem(400, 'Work identity does not match requested ID');
  const directory = workDirectory(db, metadata);
  const collision = db.prepare('SELECT id FROM works WHERE lower(directory)=lower(?) AND id<>?').get(directory, id);
  if (collision) throw problem(409, 'Work directory is already assigned');
  const file = join(dataDir, directory, 'novel.json');
  let current: unknown;
  if (existsSync(file)) {
    const bytes = readBytes(file, metadataByteLimit);
    try { current = JSON.parse(bytes.toString('utf8')); } catch { current = undefined; }
  }
  if (current !== undefined) metadata.chapters = { ...parseNovelMetadata(current).chapters, ...metadata.chapters };
  parseNovelMetadata(metadata);
  if (current === undefined || canonicalize(current) !== canonicalize(metadata)) atomicWrite(file, JSON.stringify(metadata, null, 2) + '\n');
  return cacheWork(db, dataDir, directory, metadata, restore);
}

export function deleteWork(db: DatabaseSync, dataDir: string, id: string): WorkEntry {
  const row = rowFor(db, id);
  if (!row) throw problem(404, 'Work not found');
  const folder = resolve(dataDir, row.directory);
  const inside = relative(resolve(dataDir, 'contents'), folder).split(sep);
  if (inside.length !== 2 || inside.some(part => !part || part === '.' || part === '..') || !folder.startsWith(resolve(dataDir, 'contents') + sep)) throw problem(500, 'Unexpected work storage path');
  noLinks(folder);
  const retired = join(dirname(folder), `.norea-delete-${randomUUID()}`);
  const moved = existsSync(folder);
  if (moved) renameSync(folder, retired);
  const external = db.prepare('SELECT path FROM chapters WHERE work_id=? AND path IS NOT NULL').all(id) as { path: string }[];
  let entry: WorkEntry;
  try {
    entry = transaction(db, () => {
      for (const chapter of db.prepare('SELECT entry FROM chapters WHERE work_id=?').all(id) as { entry: string }[]) {
        const deleted = recordEntry(db, { ...JSON.parse(chapter.entry) as CatalogEntry, deleted: true });
        db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(deleted.id, deleted.sequence);
      }
      db.prepare('DELETE FROM work_changes WHERE work_id=?').run(id);
      const sequence = Number(db.prepare('INSERT INTO work_changes(work_id,entry) VALUES(?,?)').run(id, '{}').lastInsertRowid);
      db.prepare('INSERT INTO work_tombstones VALUES(?,1,?) ON CONFLICT(work_id) DO UPDATE SET deleted=1,sequence=excluded.sequence').run(id, sequence);
      const deleted = { ...JSON.parse(row.entry) as WorkEntry, deleted: true, hasCover: false, sequence };
      db.prepare('UPDATE work_changes SET entry=? WHERE sequence=?').run(JSON.stringify(deleted), sequence);
      db.prepare('DELETE FROM chapters WHERE work_id=?').run(id);
      db.prepare('DELETE FROM works WHERE id=?').run(id);
      db.prepare("DELETE FROM scan_checkpoints WHERE path=? OR substr(path,1,?)=?").run(folder, folder.length + 1, folder + sep);
      return deleted;
    });
  } catch (error) { if (moved) renameSync(retired, folder); throw error; }
  if (moved) rmSync(retired, { recursive: true, force: true });
  for (const copy of external) {
    const path = resolve(dataDir, copy.path);
    if (path.startsWith(resolve(dataDir, 'trash') + sep)) rmSync(path, { recursive: true, force: true });
  }
  return entry;
}
export function getWork(db: DatabaseSync, dataDir: string, id: string): WorkEntry {
  const row = rowFor(db, id); if (!row) throw problem(404, 'Work not found');
  const metadata = readNovelMetadata(join(dataDir, row.directory, 'novel.json'));
  if (metadataWorkId(metadata) !== id) throw problem(409, 'Stored work identity changed');
  return cacheWork(db, dataDir, row.directory, metadata);
}
export function saveWorkCover(db: DatabaseSync, dataDir: string, id: string, bytes: Buffer): WorkEntry {
  const row = rowFor(db, id); if (!row) throw problem(404, 'Work not found');
  const metadata = readNovelMetadata(join(dataDir, row.directory, 'novel.json'));
  if (metadataWorkId(metadata) !== id) throw problem(409, 'Stored work identity changed');
  if (!metadata.cover) throw problem(409, 'Work metadata has no cover descriptor');
  if (!bytes.length || bytes.length > coverByteLimit) throw problem(413, 'Cover must contain at most 10 MiB');
  atomicWrite(join(dataDir, row.directory, metadata.cover.fileName), bytes);
  return cacheWork(db, dataDir, row.directory, metadata);
}

export function registerWorks(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; requireRead: (request: FastifyRequest) => void; notify: () => void }): void {
  const { db, dataDir, requireRead, notify } = context;
  const uploadCursors = new WeakMap<FastifyRequest, number>();
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
  app.addContentTypeParser(/^image\/[a-zA-Z0-9.+-]+$/, { parseAs: 'buffer', bodyLimit: coverByteLimit }, (_request, body, done) => done(null, body));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: coverByteLimit }, (_request, body, done) => done(null, body));
  app.delete<{ Params: { id: string } }>('/api/v1/admin/works/:id', { schema: { params, security: [{ bearerAuth: [] }] } }, async request => {
    authenticate(db, request, true);
    const entry = deleteWork(db, dataDir, request.params.id); notify(); return entry;
  });
  app.delete<{ Params: { id: string } }>('/api/v1/works/:id', { schema: { params, security: [{ bearerAuth: [] }] } }, async request => {
    authenticateDevice(db, request);
    const entry = deleteWork(db, dataDir, request.params.id); notify(); return entry;
  });
  app.put<{ Params: { id: string }; Querystring: { restore?: boolean } }>('/api/v1/works/:id', { bodyLimit: metadataByteLimit, onRequest: async request => {
    authenticateDevice(db, request);
    uploadCursors.set(request, (db.prepare('SELECT coalesce(max(sequence),0) AS n FROM work_changes').get() as { n: number }).n);
  }, schema: { params, querystring: { type: 'object', properties: { restore: { type: 'boolean', default: false } } }, security: [{ bearerAuth: [] }] } }, async request => {
    const deletion = db.prepare('SELECT sequence FROM work_tombstones WHERE work_id=?').get(request.params.id) as { sequence: number } | undefined;
    if ((deletion?.sequence ?? 0) > uploadCursors.get(request)!) throw problem(410, 'Work was deleted during upload');
    const entry = saveWork(db, dataDir, request.body, request.params.id, request.query.restore); notify(); return entry;
  });
  app.get<{ Querystring: { after: number; limit: number } }>('/api/v1/works', { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } } } }, async request => {
    requireRead(request);
    const { after, limit } = request.query;
    const rows = db.prepare('SELECT entry FROM work_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit + 1) as { entry: string }[];
    const items = rows.slice(0, limit).map(row => {
      const entry = JSON.parse(row.entry) as WorkEntry;
      return { ...entry, metadata: parseNovelMetadata(entry.metadata) };
    });
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  });
  app.get<{ Params: { id: string } }>('/api/v1/works/:id', { schema: { params } }, async request => { requireRead(request); return getWork(db, dataDir, request.params.id); });
  app.put<{ Params: { id: string }; Body: Buffer }>('/api/v1/works/:id/cover', { bodyLimit: coverByteLimit, onRequest: async request => {
    authenticateDevice(db, request);
    uploadCursors.set(request, (db.prepare('SELECT coalesce(max(sequence),0) AS n FROM work_changes').get() as { n: number }).n);
  }, schema: { params, security: [{ bearerAuth: [] }] } }, async request => {
    if (!Buffer.isBuffer(request.body)) throw problem(415, 'Raw image bytes are required');
    const deletion = db.prepare('SELECT sequence FROM work_tombstones WHERE work_id=?').get(request.params.id) as { sequence: number } | undefined;
    if ((deletion?.sequence ?? 0) > uploadCursors.get(request)!) throw problem(410, 'Work was deleted during upload');
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
    authenticate(db, request, true); reply.header('Cache-Control', 'no-store');
    const where = "WHERE (?='' OR instr(lower(json_extract(w.entry,'$.metadata.novel.name') || ' ' || json_extract(w.entry,'$.metadata.identity.pluginId')),lower(?))>0)";
    const args = [request.query.search, request.query.search];
    const rows = db.prepare(`SELECT w.entry,(SELECT COUNT(*) FROM chapters c WHERE c.work_id=w.id AND c.deleted_at IS NULL AND c.path IS NOT NULL) AS downloadedChapters FROM works w ${where} ORDER BY json_extract(w.entry,'$.metadata.novel.name'),w.id LIMIT ? OFFSET ?`).all(...args, request.query.limit, request.query.offset) as { entry: string; downloadedChapters: number }[];
    return { items: rows.map(row => {
      const entry = JSON.parse(row.entry) as WorkEntry;
      const { chapters, ...metadata } = entry.metadata;
      return { ...entry, metadata, chapterCount: Object.keys(chapters).length, downloadedChapters: row.downloadedChapters };
    }), total: (db.prepare(`SELECT COUNT(*) AS n FROM works w ${where}`).get(...args) as { n: number }).n };
  });
}
