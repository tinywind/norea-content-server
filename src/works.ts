import { chapterCompositionCatalog, parseChapterComposition, type ChapterCompositionV1, type ChapterCompositionEntry, type ChapterSourceSnapshot } from './chapter-composition.ts';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticate, authenticateDevice } from './auth.ts';
import { assertChapterNumberReconciliationReady, canonicalWorkChapters } from './chapter-number-mappings.ts';
import { problem, transaction } from './db.ts';
import { workChangeCursor } from './changes.ts';
import { assertExplicitMigrationRestore, deactivateWorkMigrationsForSource } from './work-migration-lineage.ts';
import { readUserStateComposition } from './user-state.ts';
import { mergeUserStateComposition } from './user-state-composition.ts';
import { digest, recordEntry, validateStorageIdentity, type CatalogEntry } from './packages.ts';
import { readVerifiedRegularFileSync } from './secure-files.ts';

import { applyWorkOverrideToNovel, overrideCoverBytes, overrideCoverBytesForWork, parseWorkOverride, type WorkOverrideV1 } from './work-overrides.ts';

export const NOVEL_STATUS_VALUES = [
  'Ongoing',
  'Completed',
  'Cancelled',
  'On Hiatus',
] as const;

export type NovelStatusValue = (typeof NOVEL_STATUS_VALUES)[number];

const NOVEL_STATUS_SET: ReadonlySet<string> = new Set(NOVEL_STATUS_VALUES);

export function isNovelStatus(value: unknown): value is NovelStatusValue {
  return typeof value === 'string' && NOVEL_STATUS_SET.has(value);
}

export interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelId: string; novelPath: string };
  novel: {
    name: string;
    author: string | null;
    artist: string | null;
    summary: string | null;
    status: NovelStatusValue | null;
    genres: string | null;
    rating: number | null;
    isLocal: boolean;
  };
  cover: { fileName: string; contentType: string | null } | null;
  chapters: Record<string, string>;
  chapterComposition?: ChapterCompositionV1;
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
    !value.isWellFormed()) {
    throw problem(400, 'work metadata: invalid text');
  }
}

export function parseNovelMetadata(raw: unknown, checkByteLimit = true): NovelMetadataV1 {
  const value = record(raw);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw problem(400, 'work metadata: invalid version');
  }
  const identity = record(value.identity);
  text(identity.pluginId); text(identity.novelPath);
  validateStorageIdentity({ pluginId: identity.pluginId, novelId: identity.novelId });
  if ((identity.novelPath as string).startsWith('norea-folder:')) throw problem(400, 'work metadata: source work identity required');
  if (/^(?:https?:)?\/\//i.test(identity.novelPath as string)) throw problem(400, 'work metadata: work identity must exclude the base URL');
  const novel = record(value.novel);
  text(novel.name);
  for (const key of ['author', 'artist', 'summary', 'status', 'genres']) text(novel[key] ?? null, true);
  if (novel.status != null && !isNovelStatus(novel.status)) throw problem(400, 'work metadata: invalid novel status');
  if (novel.rating != null && (typeof novel.rating !== 'number' || !Number.isFinite(novel.rating) || novel.rating < 0 || novel.rating > 5)) throw problem(400, 'work metadata: invalid rating');
  if (novel.isLocal != null && typeof novel.isLocal !== 'boolean') throw problem(400, 'work metadata: invalid local flag');
  const chapters: NovelMetadataV1['chapters'] = {};
  if (value.chapters !== undefined) {
    for (const [number, name] of Object.entries(record(value.chapters))) {
      if (!/^\d+(?:\.\d+)?$/.test(number) || !Number.isFinite(Number(number)) || String(Number(number)) !== number) throw problem(400, 'work metadata: invalid chapter number');
      text(name);
      chapters[number] = name as string;
    }
  }
  const chapterComposition = value.chapterComposition === undefined ? undefined : parseChapterComposition(value.chapterComposition);
  if (chapterComposition) {
    const expected = chapterCompositionCatalog(chapterComposition);
    if (Object.keys(chapters).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([number, name]) => chapters[number] !== name)) {
      throw problem(400, 'work metadata: chapter catalog does not match the user composition');
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
  if (checkByteLimit && Buffer.byteLength(JSON.stringify(value)) > metadataByteLimit) throw problem(413, 'work metadata: document exceeds size limit');
  const parsed = value as unknown as NovelMetadataV1;
  return {
    schemaVersion: 1,
    identity: { pluginId: parsed.identity.pluginId, novelId: parsed.identity.novelId, novelPath: parsed.identity.novelPath },
    novel: {
      name: parsed.novel.name, author: parsed.novel.author ?? null,
      artist: parsed.novel.artist ?? null, summary: parsed.novel.summary ?? null, status: parsed.novel.status ?? null,
      genres: parsed.novel.genres ?? null, rating: parsed.novel.rating ?? null, isLocal: parsed.novel.isLocal ?? false,
    },
    cover,
    chapters,
    ...(chapterComposition ? { chapterComposition } : {}),
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
export function readBytes(path: string, limit: number): Buffer {
  noLinks(path);
  try { return readVerifiedRegularFileSync(path, limit).bytes; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw error;
    if (/byte limit/i.test((error as Error).message)) throw problem(413, 'Work file exceeds byte limit');
    if (/changed|descriptor was closed/i.test((error as Error).message)) throw problem(400, 'Work file changed while reading');
    throw problem(400, 'Expected a non-symbolic regular work file');
  }
}
export function readNovelMetadata(path: string): NovelMetadataV1 {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(path, metadataByteLimit))); }
  catch (error) { throw problem(400, `Cannot read novel.json: ${(error as Error).message}`); }
  return parseNovelMetadata(value, false);
}
export function atomicWrite(path: string, bytes: string | Buffer): void {
  noLinks(path); mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx'); writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
  } finally { if (descriptor !== undefined) closeSync(descriptor); rmSync(temporary, { force: true }); }
}
const rowFor = (db: DatabaseSync, id: string) => {
  assertChapterNumberReconciliationReady(db, id);
  return db.prepare('SELECT * FROM works WHERE id=?').get(id) as WorkRow | undefined;
};
export function coverBytes(directory: string, metadata: Pick<NovelMetadataV1, 'cover'>): Buffer | undefined {
  if (!metadata.cover) return undefined;
  const path = join(directory, metadata.cover.fileName);
  try { const bytes = readBytes(path, coverByteLimit); return bytes.length ? bytes : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export const isCoverFile = (name: string) => /^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(name);
export const isOverrideCoverFile = (name: string) => /^cover\.override\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(name);
function discoverCover(directory: string, preferred: NovelMetadataV1['cover']): NovelMetadataV1['cover'] {
  noLinks(directory);
  if (!existsSync(directory)) return preferred;
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter(file => isCoverFile(file.name) && file.isFile() && !file.isSymbolicLink() && lstatSync(join(directory, file.name)).size > 0)
    .map(file => file.name).sort();
  const fileName = candidates.includes(preferred?.fileName ?? '') ? preferred!.fileName : candidates[0];
  return fileName ? { fileName, contentType: fileName === preferred?.fileName ? preferred.contentType : coverContentType(fileName) } : preferred;
}
export function cacheWork(db: DatabaseSync, dataDir: string, directory: string, metadata: NovelMetadataV1, restore = false, restoreMigrationOperationId?: string, onCover?: (bytes: Buffer | undefined) => void): WorkEntry {
  if (directory !== workDirectory(db, metadata)) throw problem(409, 'Work folder does not match its source IDs');
  const collision = db.prepare('SELECT id FROM works WHERE lower(directory)=lower(?) AND id<>?').get(directory, metadataWorkId(metadata));
  if (collision) throw problem(409, 'Work directory is already assigned');
  metadata = { ...metadata, cover: discoverCover(join(dataDir, directory), metadata.cover), chapters: metadata.chapterComposition ? chapterCompositionCatalog(metadata.chapterComposition) : canonicalWorkChapters(db, metadata.identity, metadata.chapters) };
  const id = metadataWorkId(metadata); const existing = rowFor(db, id);
  if (restore) assertExplicitMigrationRestore(db, id, restoreMigrationOperationId);
  if (!restore && db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(id)) throw problem(409, 'Work was deleted from the server');
  if (existing && existing.directory !== directory) throw problem(409, 'Duplicate work identity in different folders');
  const cover = coverBytes(join(dataDir, directory), metadata);
  onCover?.(cover);
  const fingerprint = digest(canonicalize(metadata) + '\n' + (cover ? digest(cover) : ''));
  if (existing?.fingerprint === fingerprint) return JSON.parse(existing.entry) as WorkEntry;
  const persist = () => {
    const entry: WorkEntry = { id, sequence: 0, metadata, hasCover: cover !== undefined };
    db.prepare('DELETE FROM work_changes WHERE work_id=?').run(id);
    const sequence = db.prepare('INSERT INTO work_changes(work_id,entry) VALUES(?,?)').run(id, '{}').lastInsertRowid;
    entry.sequence = Number(sequence); const json = JSON.stringify(entry);
    db.prepare('UPDATE work_changes SET entry=? WHERE sequence=?').run(json, sequence);
    db.prepare('INSERT INTO works(id,directory,entry,fingerprint) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry,fingerprint=excluded.fingerprint').run(id, directory, json, fingerprint);
    if (restore) {
      db.prepare('UPDATE work_tombstones SET deleted=0 WHERE work_id=?').run(id);
      deactivateWorkMigrationsForSource(db, id, restoreMigrationOperationId);
    }
    return entry;
  };
  return db.isTransaction ? persist() : transaction(db, persist);
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
      try {
        const metadata = readNovelMetadata(file);
        if (db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(metadataWorkId(metadata))) continue;
        valid.add(cacheWork(db, dataDir, directory, metadata).id);
      } catch { continue; }
    }
  }
  transaction(db, () => {
    const key = 'migration:compact-work-log-v1';
    if (!db.prepare('SELECT 1 FROM admin_settings WHERE key=?').get(key)) {
      db.exec('DELETE FROM work_changes WHERE sequence NOT IN (SELECT MAX(sequence) FROM work_changes GROUP BY work_id)');
      const update = db.prepare('UPDATE work_changes SET entry=? WHERE sequence=?');
      const remove = db.prepare('DELETE FROM work_changes WHERE sequence=?');
      const read = db.prepare('SELECT entry FROM work_changes WHERE sequence=?');
      for (const { sequence } of db.prepare('SELECT sequence FROM work_changes').all() as { sequence: number }[]) {
        try {
          const stored = JSON.parse(read.get(sequence)!.entry as string) as WorkEntry;
          const entry = { ...stored, metadata: parseNovelMetadata(stored.metadata) };
          if (entry.deleted) update.run(JSON.stringify(slimDeletedWorkEntry(entry, sequence)), sequence);
          else update.run(JSON.stringify(entry), sequence);
        } catch { remove.run(sequence); }
      }
      db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run(key, '1');
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
  const id = metadataWorkId(metadata);
  const directory = join('contents', metadata.identity.pluginId, metadata.identity.novelId);
  const existing = rowFor(db, id);
  if (existing && existing.directory !== directory) throw problem(409, 'Stored work source novel ID changed');
  const chapter = db.prepare('SELECT directory FROM chapters WHERE work_id=? LIMIT 1').get(id) as { directory: string } | undefined;
  if (chapter && dirname(chapter.directory) !== directory) throw problem(409, 'Stored chapters belong to another work directory');
  return directory;
}
const foldSourceId = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
function sameCompositionPrimary(left: ChapterSourceSnapshot, right: ChapterSourceSnapshot): boolean {
  return left.pluginId === right.pluginId && foldSourceId(left.novelId) === foldSourceId(right.novelId) &&
    (left.sourceChapterId !== undefined && right.sourceChapterId !== undefined
      ? left.sourceChapterId === right.sourceChapterId : left.chapterPath === right.chapterPath);
}
function ordinaryProviderPath(path: string): boolean {
  return !/^(?:norea-(?:composed|source|folder)|local-folder):/.test(path);
}
/** Metadata must not relabel a body's physical folder as another source or synthetic entry. */
function assertSharedCompositionStorage(
  db: DatabaseSync, dataDir: string, directory: string, identity: NovelMetadataV1['identity'],
  previous: ChapterCompositionV1 | undefined, next: ChapterCompositionV1,
): void {
  const byId = new Map(previous?.entries.map(entry => [entry.id, entry]) ?? []);
  const byPath = new Map(previous?.entries.map(entry => [entry.path, entry]) ?? []);
  const byStorage = new Map(previous?.entries.map(entry => [entry.storageChapterNumber, entry]) ?? []);
  const presence = new Map<string, boolean>();
  const hasData = (number: string) => {
    let found = presence.get(number);
    if (found === undefined) {
      const folder = join(dataDir, directory, number);
      noLinks(folder);
      found = existsSync(folder) && (!lstatSync(folder).isDirectory() || readdirSync(folder).length > 0);
      presence.set(number, found);
    }
    return found;
  };
  const conflict = () => { throw problem(409, 'Shared composition conflicts with stored chapter ownership; retain local data and resolve the pending composition'); };
  const primary = (entry: ChapterCompositionEntry) => entry.sources[entry.primarySource];
  const ownedProvider = (source: ChapterSourceSnapshot) => source.pluginId === identity.pluginId && foldSourceId(source.novelId) === foldSourceId(identity.novelId);
  for (const entry of next.entries) {
    const old = byId.get(entry.id) ?? byPath.get(entry.path) ?? byStorage.get(entry.storageChapterNumber);
    if (!hasData(entry.storageChapterNumber) && (!old || !hasData(old.storageChapterNumber))) continue;
    if (old) {
      if (old.path !== entry.path || old.storageChapterNumber !== entry.storageChapterNumber || !sameCompositionPrimary(primary(old), primary(entry))) conflict();
      if (old.id === entry.id) continue;
      // Independently imported provider rows may have different UUIDs. Synthetic
      // paths and foreign-source copies still require the exact retained ID.
      if (ordinaryProviderPath(entry.path) && ownedProvider(primary(old)) && ownedProvider(primary(entry))) continue;
      conflict();
    }
    // Before the first composition, only an exact indexed target-provider path
    // can prove ownership. A matching directory number alone proves nothing.
    const row = db.prepare('SELECT entry FROM chapters WHERE work_id=? AND directory=?')
      .get(digest(JSON.stringify([identity.pluginId, identity.novelPath])), join(directory, entry.storageChapterNumber)) as { entry: string } | undefined;
    if (!row || !ordinaryProviderPath(entry.path) || !ownedProvider(primary(entry))) conflict();
    const existing = (JSON.parse(row!.entry) as CatalogEntry).manifest.identity;
    if (existing.pluginId !== identity.pluginId || foldSourceId(existing.novelId) !== foldSourceId(identity.novelId) ||
        existing.chapterPath !== entry.path || primary(entry).chapterPath !== existing.chapterPath) conflict();
  }
}

export function saveWork(db: DatabaseSync, dataDir: string, value: unknown, expectedId?: string, restore = false, restoreMigrationOperationId?: string): WorkEntry {
  const metadata = parseNovelMetadata(value); const id = metadataWorkId(metadata);
  if (metadata.identity.pluginId === 'local' || metadata.novel.isLocal ||
      metadata.chapterComposition?.entries.some(entry => entry.sources.some(source => source.pluginId === 'local'))) {
    throw problem(400, 'Local works cannot be uploaded to the content server');
  }
  const incomingComposition = metadata.chapterComposition;
  const sharedComposition = readUserStateComposition(db, metadata.identity);
  let storedMetadata: NovelMetadataV1 | undefined;
  if (restore) assertExplicitMigrationRestore(db, id, restoreMigrationOperationId);
  if (!restore && db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(id)) throw problem(410, 'Work was deleted from the server');
  if (expectedId !== undefined && expectedId !== id) throw problem(400, 'Work identity does not match requested ID');
  const directory = workDirectory(db, metadata);
  const collision = db.prepare('SELECT id FROM works WHERE lower(directory)=lower(?) AND id<>?').get(directory, id);
  if (collision) throw problem(409, 'Work directory is already assigned');
  const file = join(dataDir, directory, 'novel.json');
  let current: unknown;
  if (existsSync(file)) {
    let stored: NovelMetadataV1;
    try {
      current = JSON.parse(readBytes(file, metadataByteLimit).toString('utf8'));
      stored = parseNovelMetadata(current);
      storedMetadata = stored;
    } catch { throw problem(409, 'Existing work metadata must be valid before it can be replaced'); }
    if (metadataWorkId(stored) !== id || stored.identity.novelId !== metadata.identity.novelId) throw problem(409, 'Work directory belongs to another source identity');
    if (stored.chapterComposition && (!metadata.chapterComposition ||
        stored.chapterComposition.updatedAt >= metadata.chapterComposition.updatedAt)) {
      metadata.chapterComposition = stored.chapterComposition;
    }
    metadata.chapters = metadata.chapterComposition ? chapterCompositionCatalog(metadata.chapterComposition) : { ...stored.chapters, ...metadata.chapters };
  }
  if (sharedComposition) {
    try {
      let combined = sharedComposition;
      const snapshots = [storedMetadata?.chapterComposition, incomingComposition]
        .filter((document): document is ChapterCompositionV1 => document !== undefined)
        .sort((left, right) => left.updatedAt - right.updatedAt);
      for (const snapshot of snapshots) {
        combined = mergeUserStateComposition(combined, snapshot, { pluginId: metadata.identity.pluginId, sourceNovelId: metadata.identity.novelId });
      }
      assertSharedCompositionStorage(db, dataDir, directory, metadata.identity, storedMetadata?.chapterComposition, combined);
      metadata.chapterComposition = combined;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      throw problem(409, 'Shared composition cannot safely overlay this metadata: ' + (error as Error).message);
    }
  }
  metadata.chapters = metadata.chapterComposition ? chapterCompositionCatalog(metadata.chapterComposition) : canonicalWorkChapters(db, metadata.identity, metadata.chapters);
  parseNovelMetadata(metadata);
  if (current === undefined || canonicalize(current) !== canonicalize(metadata)) atomicWrite(file, JSON.stringify(metadata, null, 2) + '\n');
  return cacheWork(db, dataDir, directory, metadata, restore, restoreMigrationOperationId);
}

export function slimDeletedWorkEntry(existing: WorkEntry, sequence: number): WorkEntry {
  const { identity, novel } = existing.metadata;
  return { id: existing.id, sequence, hasCover: false, deleted: true, metadata: {
    schemaVersion: 1, identity, chapters: {}, cover: null,
    novel: { name: novel.name, isLocal: novel.isLocal, author: null, artist: null, summary: null, status: null, genres: null, rating: null },
  } };
}

type DeleteIdentity = Omit<NovelMetadataV1['identity'], 'novelId'> & { novelId?: string };
const cleanupRetired = (path: string) => {
  void rm(path, { recursive: true, force: true }).catch(error => console.warn('Failed to remove retired storage:', path, error));
};

export function deleteWork(db: DatabaseSync, dataDir: string, id: string, recordDeletion?: (entry: WorkEntry) => void, verifyDeletion?: (retiredDirectory: string) => void, expected?: DeleteIdentity): WorkEntry {
  const row = rowFor(db, id);
  if (!row) throw problem(404, 'Work not found');
  const existing = JSON.parse(row.entry) as WorkEntry;
  const { identity } = existing.metadata;
  if (expected && (identity.pluginId !== expected.pluginId || identity.novelPath !== expected.novelPath ||
    (expected.novelId !== undefined && identity.novelId !== expected.novelId))) {
    throw Object.assign(problem(409, 'Server work identity does not match the requested work'), { code: 'work-identity-mismatch' });
  }
  const folder = resolve(dataDir, row.directory);
  const inside = relative(resolve(dataDir, 'contents'), folder).split(sep);
  if (inside.length !== 2 || inside.some(part => !part || part === '.' || part === '..') || !folder.startsWith(resolve(dataDir, 'contents') + sep)) throw problem(500, 'Unexpected work storage path');
  noLinks(folder);
  const retired = join(dirname(folder), `.norea-delete-${randomUUID()}`);
  let moved = false;
  let external: { path: string }[] = [];
  let entry: WorkEntry;
  try {
    entry = transaction(db, () => {
      const current = rowFor(db, id);
      if (!current) throw problem(404, 'Work not found');
      if (current.entry !== row.entry || current.directory !== row.directory || current.fingerprint !== row.fingerprint) {
        throw problem(409, 'Work changed during deletion');
      }
      if (existsSync(folder)) { renameSync(folder, retired); moved = true; }
      verifyDeletion?.(moved ? retired : folder);
      external = db.prepare('SELECT path FROM chapters WHERE work_id=? AND deleted_at IS NOT NULL AND path IS NOT NULL').all(id) as { path: string }[];
      for (const chapter of db.prepare('SELECT entry FROM chapters WHERE work_id=?').all(id) as { entry: string }[]) {
        const deleted = recordEntry(db, { ...JSON.parse(chapter.entry) as CatalogEntry, deleted: true });
        db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(deleted.id, deleted.sequence);
      }
      db.prepare('DELETE FROM work_changes WHERE work_id=?').run(id);
      const sequence = Number(db.prepare('INSERT INTO work_changes(work_id,entry) VALUES(?,?)').run(id, '{}').lastInsertRowid);
      db.prepare('INSERT INTO work_tombstones VALUES(?,1,?) ON CONFLICT(work_id) DO UPDATE SET deleted=1,sequence=excluded.sequence').run(id, sequence);
      const deleted = slimDeletedWorkEntry(existing, sequence);
      db.prepare('UPDATE work_changes SET entry=? WHERE sequence=?').run(JSON.stringify(deleted), sequence);
      db.prepare('DELETE FROM chapters WHERE work_id=?').run(id);
      db.prepare('DELETE FROM works WHERE id=?').run(id);
      db.prepare('DELETE FROM work_overrides WHERE work_id=?').run(id);
      db.prepare("DELETE FROM scan_checkpoints WHERE path=? OR substr(path,1,?)=?").run(folder, folder.length + 1, folder + sep);
      recordDeletion?.(deleted);
      return deleted;
    });
  } catch (error) { if (moved) renameSync(retired, folder); throw error; }
  workStatCaches.get(db)?.delete(id);
  if (moved) cleanupRetired(retired);
  for (const copy of external) {
    const path = resolve(dataDir, copy.path);
    if (path.startsWith(resolve(dataDir, 'trash') + sep)) cleanupRetired(path);
  }
  return entry;
}
const workStatCaches = new WeakMap<DatabaseSync, Map<string, { fingerprint: string; signature: string }>>();
const coverExtensions = ['avif', 'bmp', 'gif', 'img', 'jpeg', 'jpg', 'png', 'svg', 'webp'];

function workStorageSignature(directory: string): string {
  noLinks(directory);
  return ['novel.json', ...coverExtensions.map(extension => 'cover.' + extension)].map(name => {
    const file = lstatSync(join(directory, name), { bigint: true, throwIfNoEntry: false });
    return file ? [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':') : '';
  }).join('|');
}

function refreshWork(db: DatabaseSync, dataDir: string, id: string, onCover?: (bytes: Buffer | undefined) => void) {
  assertChapterNumberReconciliationReady(db, id);
  const head = db.prepare('SELECT directory,fingerprint FROM works WHERE id=?').get(id) as Pick<WorkRow, 'directory' | 'fingerprint'> | undefined;
  if (!head) throw problem(404, 'Work not found');
  let cache = workStatCaches.get(db);
  if (!cache) workStatCaches.set(db, cache = new Map());
  const directory = join(dataDir, head.directory);
  const signature = workStorageSignature(directory);
  const cached = cache.get(id);
  if (cached?.fingerprint === head.fingerprint && cached.signature === signature) return { ...head, entry: undefined };
  const metadata = readNovelMetadata(join(directory, 'novel.json'));
  if (metadataWorkId(metadata) !== id) throw problem(409, 'Stored work identity changed');
  const entry = cacheWork(db, dataDir, head.directory, metadata, false, undefined, onCover);
  const updated = db.prepare('SELECT fingerprint FROM works WHERE id=?').get(id) as Pick<WorkRow, 'fingerprint'>;
  cache.set(id, { ...updated, signature });
  return { directory: head.directory, ...updated, entry };
}

export function getWork(db: DatabaseSync, dataDir: string, id: string): WorkEntry {
  return refreshWork(db, dataDir, id).entry ?? JSON.parse(rowFor(db, id)!.entry) as WorkEntry;
}

export function readWorkCover(db: DatabaseSync, dataDir: string, id: string): { bytes: Buffer; contentType: string | null } | undefined {
  let bytes: Buffer | undefined;
  const current = refreshWork(db, dataDir, id, cover => { bytes = cover; });
  const cover = current.entry?.metadata.cover ?? (JSON.parse((db.prepare('SELECT cover_json FROM work_summaries WHERE id=?').get(id)?.cover_json as string | null) ?? 'null') as NovelMetadataV1['cover']);
  if (!cover) return undefined;
  if (!current.entry) bytes = coverBytes(join(dataDir, current.directory), { cover });
  return bytes && { bytes, contentType: cover.contentType };
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

/** Explicitly clear a freshly observed absent cover without treating ordinary metadata omissions as deletion. */
export function deleteWorkCover(db: DatabaseSync, dataDir: string, id: string, revision: string): WorkEntry {
  let retired: string | undefined;
  const moved: { from: string; to: string }[] = [];
  let entry: WorkEntry;
  try {
    entry = transaction(db, () => {
      const current = getWork(db, dataDir, id);
      const row = rowFor(db, id)!;
      if (row.fingerprint !== revision) throw problem(409, 'Work changed before cover removal');
      const folder = join(dataDir, row.directory);
      const file = join(folder, 'novel.json');
      const metadata = readNovelMetadata(file);
      const covers = readdirSync(folder, { withFileTypes: true }).filter(item => isCoverFile(item.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (covers.some(item => !item.isFile() || item.isSymbolicLink())) throw problem(400, 'Cover removal requires regular work files');
      if (!covers.length && metadata.cover === null) return current;
      // Keep every original until both metadata and its index commit. A sibling
      // stays on the content mount and cannot be rediscovered as this work's cover.
      retired = join(dirname(folder), '.norea-cover-delete-' + randomUUID());
      mkdirSync(retired);
      for (const name of covers.map(item => item.name)) {
        const from = join(folder, name); const to = join(retired, name);
        renameSync(from, to); moved.push({ from, to });
      }
      const backup = join(retired, 'novel.json');
      copyFileSync(file, backup, constants.COPYFILE_EXCL); moved.push({ from: file, to: backup });
      // Keep novel.json continuously present; a process interruption cannot
      // orphan the work's chapter index while its cover files are staged.
      metadata.cover = null;
      atomicWrite(file, JSON.stringify(metadata, null, 2) + '\n');
      return cacheWork(db, dataDir, row.directory, metadata);
    });
  } catch (error) {
    const failures: unknown[] = [];
    for (const file of moved.reverse()) {
      try { renameSync(file.to, file.from); } catch (restoreError) { failures.push(restoreError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Cover removal failed and staged originals could not be fully restored');
    if (retired) rmSync(retired, { recursive: true, force: true });
    throw error;
  }
  if (retired) {
    try { rmSync(retired, { recursive: true, force: true }); }
    catch { console.warn('Deferred removal of a retired work cover copy'); }
  }
  return entry;
}

export function registerWorks(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; requireRead: (request: FastifyRequest) => void; notify: () => void }): void {
  const { db, dataDir, requireRead, notify } = context;
  const uploadCursors = new WeakMap<FastifyRequest, number>();
  const coverUploadRevisions = new WeakMap<FastifyRequest, string>();
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
  app.addContentTypeParser(/^image\/[a-zA-Z0-9.+-]+$/, { parseAs: 'buffer', bodyLimit: coverByteLimit }, (_request, body, done) => done(null, body));
  app.addContentTypeParser('application/vnd.norea.work-identity-delete+json', { parseAs: 'string', bodyLimit: 16 }, (_request, _body, done) => done(null, {}));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: coverByteLimit }, (_request, body, done) => done(null, body));
  app.delete<{ Params: { id: string } }>('/api/v1/admin/works/:id', { schema: { params, security: [{ bearerAuth: [] }] } }, async request => {
    authenticate(db, request, true);
    const entry = deleteWork(db, dataDir, request.params.id); notify(); return entry;
  });
  app.delete<{ Params: { id: string }; Querystring: Partial<DeleteIdentity> }>('/api/v1/works/:id', { schema: {
    params, security: [{ bearerAuth: [] }],
    querystring: { type: 'object', properties: {
      pluginId: { type: 'string', minLength: 1, maxLength: 4096 },
      novelPath: { type: 'string', minLength: 1, maxLength: 4096 },
      novelId: { type: 'string', minLength: 1, maxLength: 4096 },
    } },
  } }, async request => {
    authenticateDevice(db, request);
    const { pluginId, novelPath, novelId } = request.query;
    if (request.headers['content-type'] === 'application/vnd.norea.work-identity-delete+json' && !(pluginId && novelPath)) {
      throw problem(400, 'Identity-checked deletion requires pluginId and novelPath');
    }
    if (!(pluginId && novelPath) && (pluginId || novelPath || novelId)) throw problem(400, 'pluginId and novelPath must be provided together');
    const expected = pluginId && novelPath ? { pluginId, novelPath, novelId } : undefined;
    const entry = deleteWork(db, dataDir, request.params.id, undefined, undefined, expected); notify(); return entry;
  });
  app.put<{ Params: { id: string }; Querystring: { restore?: boolean; restoreMigrationOperationId?: string } }>('/api/v1/works/:id', { bodyLimit: metadataByteLimit, onRequest: async request => {
    authenticateDevice(db, request);
    uploadCursors.set(request, workChangeCursor(db));
  }, schema: { params, querystring: { type: 'object', properties: { restore: { type: 'boolean', default: false }, restoreMigrationOperationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } } }, security: [{ bearerAuth: [] }] } }, async request => {
    const deletion = db.prepare('SELECT sequence FROM work_tombstones WHERE work_id=?').get(request.params.id) as { sequence: number } | undefined;
    if ((deletion?.sequence ?? 0) > uploadCursors.get(request)!) throw problem(410, 'Work was deleted during upload');
    const entry = saveWork(db, dataDir, request.body, request.params.id, request.query.restore, request.query.restoreMigrationOperationId); notify(); return entry;
  });
  app.get<{ Querystring: { after: number; limit: number } }>('/api/v1/works', { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } } } }, async (request, reply) => {
    requireRead(request);
    const { after, limit } = request.query;
    let cursor = after;
    let hasMore = false;
    let bytes = 128;
    const items: string[] = [];
    const rows = db.prepare('SELECT sequence,entry FROM work_changes WHERE sequence>? ORDER BY sequence LIMIT ?').iterate(after, limit + 1);
    for (const row of rows) {
      const entry = row.entry as string;
      const size = Buffer.byteLength(entry) + 1;
      if (items.length && (items.length === limit || bytes + size > 8 * 1024 ** 2)) { hasMore = true; break; }
      items.push(entry); bytes += size; cursor = Number(row.sequence);
    }
    if (!hasMore) cursor = Math.max(cursor, workChangeCursor(db));
    return reply.type('application/json').send(`{"items":[${items.join(',')}],"cursor":${cursor},"hasMore":${hasMore}}`);
  });
  app.get<{ Params: { id: string } }>('/api/v1/works/:id', { schema: { params } }, async (request, reply) => {
    requireRead(request);
    const current = refreshWork(db, dataDir, request.params.id);
    const etag = '"' + current.fingerprint + '"';
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (request.headers['if-none-match']?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)) {
      return reply.code(304).send();
    }
    return reply.type('application/json').send(current.entry ? JSON.stringify(current.entry) : rowFor(db, request.params.id)!.entry);
  });
  app.put<{ Params: { id: string }; Body: Buffer }>('/api/v1/works/:id/cover', { bodyLimit: coverByteLimit, onRequest: async request => {
    authenticateDevice(db, request);
    uploadCursors.set(request, workChangeCursor(db));
    getWork(db, dataDir, request.params.id);
    coverUploadRevisions.set(request, rowFor(db, request.params.id)!.fingerprint);
  }, schema: { params, security: [{ bearerAuth: [] }] } }, async request => {
    if (!Buffer.isBuffer(request.body)) throw problem(415, 'Raw image bytes are required');
    const deletion = db.prepare('SELECT sequence FROM work_tombstones WHERE work_id=?').get(request.params.id) as { sequence: number } | undefined;
    if ((deletion?.sequence ?? 0) > uploadCursors.get(request)!) throw problem(410, 'Work was deleted during upload');
    getWork(db, dataDir, request.params.id);
    if (rowFor(db, request.params.id)!.fingerprint !== coverUploadRevisions.get(request)) throw problem(409, 'Work changed during cover upload');
    const entry = saveWorkCover(db, dataDir, request.params.id, request.body); notify(); return entry;
  });
  app.delete<{ Params: { id: string }; Body: { revision: string } }>('/api/v1/works/:id/cover', { schema: {
    params, security: [{ bearerAuth: [] }],
    body: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    description: 'Conditionally remove every local cover image when fresh source metadata explicitly has no cover. Requires the current work migration-snapshot revision and preserves all chapters and other metadata.',
  } }, async request => {
    authenticateDevice(db, request);
    const entry = deleteWorkCover(db, dataDir, request.params.id, request.body.revision); notify(); return entry;
  });
  for (const prefix of ['/api/v1/works', '/api/v1/admin/works']) {
    app.get<{ Params: { id: string } }>(`${prefix}/:id/cover`, { schema: { params } }, async (request, reply) => {
      const isAdmin = prefix.includes('/admin/');
      if (isAdmin) authenticate(db, request, true); else requireRead(request);
      const overrideCover = isAdmin ? overrideCoverBytesForWork(db, dataDir, request.params.id) : undefined;
      if (overrideCover) {
        return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").type(overrideCover.contentType ?? 'application/octet-stream').send(overrideCover.bytes);
      }
      const cover = readWorkCover(db, dataDir, request.params.id); if (!cover) throw problem(404, 'Cover not found');
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").type(cover.contentType ?? 'application/octet-stream').send(cover.bytes);
    });
  }
  app.get<{ Querystring: { search: string; offset: number; limit: number } }>('/api/v1/admin/works', { schema: { querystring: { type: 'object', properties: { search: { type: 'string', maxLength: 500, default: '' }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } } } }, async (request, reply) => {
    authenticate(db, request, true); reply.header('Cache-Control', 'no-store');
    const effectiveName = "CASE WHEN json_type(o.document,'$.fields.name.value')='text' AND trim(json_extract(o.document,'$.fields.name.value'))<>'' THEN trim(json_extract(o.document,'$.fields.name.value')) ELSE json_extract(w.novel_json,'$.name') END";
    const where = `WHERE (?='' OR instr(lower(${effectiveName} || ' ' || w.plugin_id),lower(?))>0)`;
    const args = [request.query.search, request.query.search];
    const rows = db.prepare(`SELECT w.*,o.document AS overrideDocument,(SELECT COUNT(*) FROM chapters c WHERE c.work_id=w.id AND c.deleted_at IS NULL AND c.path IS NOT NULL) AS downloadedChapters FROM work_summaries w LEFT JOIN work_overrides o ON o.work_id=w.id ${where} ORDER BY ${effectiveName},w.id LIMIT ? OFFSET ?`).all(...args, request.query.limit, request.query.offset) as unknown as {
      id: string; directory: string; sequence: number; plugin_id: string; novel_id: string; novel_path: string;
      has_cover: number; novel_json: string; cover_json: string | null; chapter_count: number; overrideDocument: string | null; downloadedChapters: number;
    }[];
    return { items: rows.map(row => {
      let override: WorkOverrideV1 | undefined;
      if (row.overrideDocument) {
        try { override = parseWorkOverride(JSON.parse(row.overrideDocument)); } catch { override = undefined; }
      }
      const novel = applyWorkOverrideToNovel(JSON.parse(row.novel_json) as NovelMetadataV1['novel'], override);
      const overrideCover = override ? overrideCoverBytes(join(dataDir, row.directory), override) : undefined;
      return {
        id: row.id, sequence: row.sequence,
        hasCover: Boolean(row.has_cover) || overrideCover !== undefined,
        metadata: {
          schemaVersion: 1,
          identity: { pluginId: row.plugin_id, novelId: row.novel_id, novelPath: row.novel_path },
          novel,
          cover: JSON.parse(row.cover_json ?? 'null'),
        },
        chapterCount: row.chapter_count,
        downloadedChapters: row.downloadedChapters,
      };
    }), total: (db.prepare(`SELECT COUNT(*) AS n FROM work_summaries w LEFT JOIN work_overrides o ON o.work_id=w.id ${where}`).get(...args) as { n: number }).n };
  });
}
