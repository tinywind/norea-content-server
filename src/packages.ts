import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalize } from 'json-canonicalize';
import { safeArchivePath } from './archive-path.ts';
import { workChangeCursor } from './changes.ts';
import { problem, transaction } from './db.ts';
export { safeArchivePath } from './archive-path.ts';
import { assertChapterNumberReconciliationReady, canonicalChapterManifest, canonicalChapterNumber, chapterIdentityId } from './chapter-number-mappings.ts';

export interface PackageManifest {
  packageVersion: 1;
  layout: 'chapter-files';
  identity: { pluginId: string; novelId: string; novelPath: string; chapterPath: string };
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: 'html' | 'text' | 'markdown' | 'pdf' | 'epub'; page: string };
  bodyPath: string;
  files: { path: string; size: number; modifiedAt: number }[];
}
export interface CatalogEntry { id: string; revision: string; fileBytes: number; manifest: PackageManifest; complete: boolean; deleted: boolean; sequence: number }
export type ChapterConflictPolicy = 'prefer-complete' | 'keep-server' | 'replace-server';
export interface Limits { zipBytes: number; expandedBytes: number; files: number }
export const defaultLimits: Limits = { zipBytes: 512 * 1024 ** 2, expandedBytes: 2 * 1024 ** 3, files: 10000 };
export const chapterFileNames = ['content.html', 'content.pdf', 'manifest.json', 'media.zip'];
export const isUnfinishedContentName = (name: string) => name.startsWith('.') || /(?:\.tmp|\.bak|\.part|\.partial|\.norea-sync-backup)$/i.test(name);
export const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const workId = (identity: PackageManifest['identity']) => digest(JSON.stringify([identity.pluginId, identity.novelPath]));
export function validateStorageIdentity(identity: { pluginId: unknown; novelId: unknown }): void {
  for (const value of [identity.pluginId, identity.novelId]) {
    if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 240 ||
      /^[. ]|[. ]$/.test(value) || /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) || isUnfinishedContentName(value)) {
      throw problem(400, 'Storage IDs must be portable directory names');
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.pluginId as string)) throw problem(400, 'Plugin ID must use lowercase kebab-case');
}

function chapterDirectory(manifest: PackageManifest): string {
  validateStorageIdentity(manifest.identity);
  const chapter = manifest.chapter.chapterNumber == null
    ? (manifest.chapter.position > 0 ? normalizedChapterNumber(String(manifest.chapter.position)) : undefined)
    : normalizedChapterNumber(manifest.chapter.chapterNumber);
  if (chapter === undefined) throw problem(400, 'A chapter number or positive position is required for storage');
  return join('contents', manifest.identity.pluginId, manifest.identity.novelId, chapter);
}

export function validateManifest(value: unknown): asserts value is PackageManifest {
  const m = value as PackageManifest;
  if (!m || typeof m !== 'object' || m.packageVersion !== 1 || !m.identity || !m.novel || !m.chapter || !Array.isArray(m.files)) throw problem(400, 'Unsupported or incomplete package manifest');
  const allowed = (object: object, names: string[]) => { if (Object.keys(object).some(key => !names.includes(key))) throw problem(400, 'Unknown package manifest field'); };
  allowed(m, ['packageVersion','layout','identity','novel','chapter','bodyPath','files']);
  if (m.layout !== 'chapter-files') throw problem(400, 'Unsupported chapter file layout');
  allowed(m.identity, ['pluginId','novelId','novelPath','chapterPath']);
  validateStorageIdentity(m.identity);
  allowed(m.novel, ['name','author','summary','isLocal']);
  allowed(m.chapter, ['name','position','chapterNumber','contentType','page']);
  for (const value of [m.novel.author, m.novel.summary, m.chapter.chapterNumber]) if (value !== undefined && value !== null && typeof value !== 'string') throw problem(400, 'Invalid optional package metadata');
  const validUnicode = (value: unknown): void => {
    if (typeof value === 'string' && !value.isWellFormed()) throw problem(400, 'Invalid Unicode in package manifest');
    if (value && typeof value === 'object') for (const item of Object.values(value)) validUnicode(item);
  };
  validUnicode(m);
  for (const v of [m.identity.pluginId, m.identity.novelPath, m.identity.chapterPath, m.novel.name, m.chapter.name]) if (typeof v !== 'string' || !v || v.length > 4096) throw problem(400, 'Invalid package identity or title');
  if (typeof m.novel.isLocal !== 'boolean' || !Number.isFinite(m.chapter.position) || typeof m.chapter.page !== 'string' || !['html','text','markdown','pdf','epub'].includes(m.chapter.contentType)) throw problem(400, 'Invalid package metadata');
  chapterDirectory(m);
  if (typeof m.bodyPath !== 'string' || !safeArchivePath(m.bodyPath)) throw problem(400, 'Invalid body path');
  for (let index = 0; index < m.files.length; index++) {
    const file = m.files[index];
    if (!file || typeof file.path !== 'string' || !safeArchivePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) throw problem(400, 'Invalid file manifest');
    if (!Number.isSafeInteger(file.modifiedAt) || file.modifiedAt < 0) throw problem(400, 'Invalid file modification time');
    allowed(file, ['path','size','modifiedAt']);
    if (index && m.files[index - 1].path >= file.path) throw problem(400, 'Manifest files must be sorted and unique');
  }
  const bodyFile = m.files.find(file => file.path === m.bodyPath);
  if (!bodyFile) throw problem(400, 'Body is absent from file manifest');
  if (bodyFile.size <= 0) throw problem(400, 'Chapter body must not be empty');
}

export function recordEntry(db: DatabaseSync, entry: CatalogEntry): CatalogEntry {
  const next = { ...entry };
  const result = db.prepare('INSERT INTO catalog_changes(chapter_id,entry) VALUES(?,?)').run(entry.id, '{}');
  next.sequence = Number(result.lastInsertRowid);
  const json = JSON.stringify(next);
  const { id, sequence, manifest: { identity }, complete, deleted } = next;
  db.prepare('UPDATE catalog_changes SET entry=? WHERE sequence=?').run(JSON.stringify({ id, sequence, manifest: { identity }, complete, deleted }), sequence);
  db.prepare('UPDATE chapters SET entry=? WHERE id=?').run(json, next.id);
  return next;
}

function removeRetired(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true }).catch(error => console.warn('Failed to remove retired chapter storage:', path, error));
}

function storageSignature(directory: string): string {
  return [directory, ...readdirSync(directory).sort().map(name => join(directory, name))].map(path => {
    const info = lstatSync(path, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  }).join('|');
}

async function moveChapterStorage<T>(db: DatabaseSync, source: string, destination: string, verify: () => void, save: () => T): Promise<T> {
  const commit = (staged?: string, retired?: string, signature?: string) => {
    let sourceRenamed = false;
    let published = false;
    try {
      return transaction(db, () => {
        verify();
        if (existsSync(destination)) throw problem(409, 'Chapter destination already exists');
        if (staged && retired) {
          if (storageSignature(source) !== signature) throw problem(409, 'Chapter files changed during the storage move; retry');
          renameSync(source, retired);
          sourceRenamed = true;
        }
        renameSync(staged ?? source, destination);
        published = true;
        return save();
      });
    } catch (error) {
      if (published) renameSync(destination, staged ?? source);
      if (sourceRenamed) renameSync(retired!, source);
      throw error;
    }
  };
  try { return commit(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  const staged = join(dirname(destination), '.norea-move-' + randomUUID());
  const retired = join(dirname(source), '.norea-move-' + randomUUID());
  const signature = storageSignature(source);
  try {
    await cp(source, staged, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    const result = commit(staged, retired, signature);
    await removeRetired(retired);
    return result;
  } finally { await removeRetired(staged); }
}

function storedFilesExist(dataDir: string, path: string, entry: CatalogEntry): boolean {
  const bodyFile = entry.manifest.files.find(file => file.path === entry.manifest.bodyPath);
  if (!bodyFile || bodyFile.size <= 0) return false;
  try {
    const target = chapterStoragePath(dataDir, path);
    const directory = lstatSync(target);
    return directory.isDirectory() && !directory.isSymbolicLink()
      && readdirSync(target).every(name => !isUnfinishedContentName(name) && (!chapterFileNames.includes(name.toLowerCase()) || entry.manifest.files.some(file => file.path === name))) && entry.manifest.files.every(file => {
      const info = lstatSync(join(target, file.path));
      return info.isFile() && !info.isSymbolicLink() && info.size === file.size;
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function chapterStoragePath(dataDir: string, path: string): string {
  const root = resolve(dataDir);
  const target = resolve(root, path);
  if (![resolve(root, 'contents'), resolve(root, 'trash')].some(directory => target.startsWith(directory + sep))) throw problem(400, 'Chapter path is outside server storage');
  for (let current = target; ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw problem(400, 'Symbolic chapter paths are unsupported');
    if (current === root) break;
  }
  return target;
}

export function chapterStagePath(dataDir: string, name: string): string {
  return chapterStoragePath(dataDir, join('contents', '.norea-staging', name));
}

export function availableChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry | undefined {
  const row = db.prepare('SELECT entry,path FROM chapters WHERE id=? AND deleted_at IS NULL').get(id) as { entry: string; path: string | null } | undefined;
  if (!row?.path) return;
  const entry = JSON.parse(row.entry) as CatalogEntry;
  return storedFilesExist(dataDir, row.path, entry) ? entry : undefined;
}

function normalizedChapterNumber(value: string | null | undefined): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value ?? '');
  if (!match) return;
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  const normalized = String(number);
  return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : undefined;
}

function folderChapterNumber(path: string): string | undefined {
  return path.startsWith('norea-folder:') ? normalizedChapterNumber(path.slice('norea-folder:'.length)) : undefined;
}

export function findChapterUploadIdentity(db: DatabaseSync, manifest: PackageManifest): CatalogEntry | undefined {
  manifest = canonicalChapterManifest(db, manifest);
  const storedWork = db.prepare('SELECT novel_id FROM work_summaries WHERE id=?').get(workId(manifest.identity)) as { novel_id: string } | undefined;
  if (storedWork && storedWork.novel_id !== manifest.identity.novelId) throw problem(409, 'Chapter source novel ID does not match its registered work');
  const recovered = folderChapterNumber(manifest.identity.chapterPath);
  const declared = normalizedChapterNumber(manifest.chapter.chapterNumber);
  if (recovered !== undefined && manifest.chapter.chapterNumber != null && recovered !== declared) throw problem(400, 'Folder chapter identity does not match its chapter number');
  const id = chapterIdentityId(db, manifest.identity);
  const exact = db.prepare('SELECT entry FROM chapters WHERE id=?').get(id) as { entry: string } | undefined;
  if (exact) return JSON.parse(exact.entry) as CatalogEntry;
  // Only recovered folder identities can adopt an existing source identity.
  // A real source path must never claim an unbound folder identity by number.
  if (manifest.identity.pluginId === 'local' || manifest.novel.isLocal || recovered === undefined) return;
  const number = recovered;
  const rows = db.prepare(`SELECT entry FROM chapters WHERE work_id=? AND (
    CAST(json_extract(entry,'$.manifest.chapter.chapterNumber') AS REAL)=CAST(? AS REAL)
    OR json_extract(entry,'$.manifest.identity.chapterPath')=?)`).all(workId(manifest.identity), number, `norea-folder:${number}`) as { entry: string }[];
  const matches = rows.map(row => JSON.parse(row.entry) as CatalogEntry).filter(entry => {
    const knownFolder = folderChapterNumber(entry.manifest.identity.chapterPath);
    const knownNumber = normalizedChapterNumber(entry.manifest.chapter.chapterNumber);
    return (knownFolder ?? knownNumber) === number && (knownFolder === undefined || knownNumber === undefined || knownFolder === knownNumber);
  });
  if (matches.length > 1) throw problem(409, 'Multiple chapters match the recovered folder identity');
  return matches[0];
}

export function uploadCursor(db: DatabaseSync): { catalog: number; works: number } {
  const catalog = Number(db.prepare('SELECT coalesce(max(sequence),0) AS cursor FROM catalog_changes').get()!.cursor);
  return { catalog, works: workChangeCursor(db) };
}

export function publishChapter(db: DatabaseSync, dataDir: string, source: string, entry: CatalogEntry, startedAt: ReturnType<typeof uploadCursor>, imported = false, conflictPolicy: ChapterConflictPolicy = 'prefer-complete', verifyCommit?: () => void): CatalogEntry {
  if (!imported && (entry.manifest.identity.pluginId === 'local' || entry.manifest.novel.isLocal)) {
    throw problem(400, 'Local chapters cannot be uploaded to the content server');
  }
  let manifest = canonicalChapterManifest(db, entry.manifest);
  let id = chapterIdentityId(db, manifest.identity);
  if (id !== entry.id || canonicalize(manifest) !== canonicalize(entry.manifest)) {
    entry = { ...entry, id, manifest, revision: digest(canonicalize(manifest)) };
  }
  if (imported && canonicalChapterNumber(db, manifest.identity, basename(source)) !== basename(source)) {
    throw problem(409, 'Chapter number reconciliation conflict: old chapter folders must not be reimported');
  }
  let backup: { from: string; to: string } | undefined;
  let publishedPath: string | undefined;
  const addedFiles: string[] = [];
  const retainedFiles: { from: string; to: string }[] = [];
  let committed = false;
  try {
    const result = transaction(db, () => {
      verifyCommit?.();
      const known = imported ? undefined : findChapterUploadIdentity(db, manifest);
      if (known && known.id !== id) {
        manifest = { ...manifest, identity: known.manifest.identity,
          chapter: { ...manifest.chapter, chapterNumber: known.manifest.chapter.chapterNumber ?? folderChapterNumber(known.manifest.identity.chapterPath) } };
        id = known.id;
        entry = { ...entry, id, manifest, revision: digest(canonicalize(manifest)) };
      }
      const existing = db.prepare('SELECT entry,directory,path,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; path: string | null; deleted_at: number | null } | undefined;
      const work = workId(manifest.identity);
      const workDeletion = db.prepare('SELECT deleted,sequence FROM work_tombstones WHERE work_id=?').get(work) as { deleted: number; sequence: number } | undefined;
      const deletion = db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(id) as { sequence: number } | undefined;
      if ((imported && existing?.deleted_at != null) || workDeletion?.deleted || (deletion?.sequence ?? 0) > startedAt.catalog || (workDeletion?.sequence ?? 0) > startedAt.works) throw problem(409, 'Content was deleted; start a new upload to replace it');
      const saved = existing ? JSON.parse(existing.entry) as CatalogEntry : undefined;
      const current = saved && existing?.deleted_at === null && existing.path && storedFilesExist(dataDir, existing.path, saved) ? saved : undefined;
      if (current && (imported ? current.revision === entry.revision && current.complete === entry.complete
        : conflictPolicy === 'keep-server' || (conflictPolicy === 'prefer-complete' && (current.complete || !entry.complete)))) return current;
      if ((saved?.sequence ?? 0) > startedAt.catalog) throw problem(409, 'Chapter changed during upload; retry the request');
      if (!imported && existing) entry = { ...entry, revision: digest(canonicalize([manifest, randomUUID()])) };
      const storedWork = db.prepare('SELECT directory FROM works WHERE id=?').get(work) as { directory: string } | undefined;
      if (!storedWork) throw problem(409, 'Register exact work metadata before uploading chapter files');
      const directory = imported ? relative(resolve(dataDir), resolve(source)) : existing?.directory ?? join(storedWork.directory, basename(chapterDirectory(manifest)));
      const destination = chapterStoragePath(dataDir, directory);
      if (dirname(destination) !== resolve(dataDir, storedWork.directory) || !destination.startsWith(resolve(dataDir, 'contents') + sep)) throw problem(400, 'Chapter directory must belong to its registered work');
      if (existing && existing.directory !== directory) throw problem(409, 'Chapter identity already belongs to another directory');
      if (db.prepare('SELECT id FROM chapters WHERE lower(directory)=lower(?) AND id<>?').get(directory, id)) throw problem(409, 'Chapter directory already belongs to another identity');
      if (!imported) {
        const storedPath = existing?.path ?? (existing?.deleted_at === null ? existing.directory : null);
        if (storedPath && existsSync(chapterStoragePath(dataDir, storedPath))) {
          const from = chapterStoragePath(dataDir, storedPath); const to = join(dirname(from), '.norea-replaced-' + randomUUID());
          renameSync(from, to); backup = { from, to };
        }
        if (existsSync(destination)) {
          if (!lstatSync(destination).isDirectory() || readdirSync(destination, { withFileTypes: true }).some(file => !file.isFile() || isUnfinishedContentName(file.name) || chapterFileNames.includes(file.name.toLowerCase()))) throw problem(409, 'Unindexed chapter files already occupy the directory; scan the content directory first');
          // Preserve unrelated files without interpreting or serving them.
          for (const file of manifest.files) {
            const path = join(destination, file.path);
            if (existsSync(path)) throw problem(409, 'Unindexed chapter files already occupy the directory');
            renameSync(join(source, file.path), path);
            addedFiles.push(path);
          }
        } else {
          mkdirSync(dirname(destination), { recursive: true });
          renameSync(source, destination); publishedPath = destination;
        }
        if (backup) {
          for (const file of readdirSync(backup.to, { withFileTypes: true })) {
            if (!file.isFile() || chapterFileNames.includes(file.name.toLowerCase()) || isUnfinishedContentName(file.name)) continue;
            const retained = { from: join(backup.to, file.name), to: join(destination, file.name) };
            if (existsSync(retained.to)) throw problem(409, 'Unindexed chapter files conflict with a previous copy');
            renameSync(retained.from, retained.to); retainedFiles.push(retained);
          }
        }
      }
      db.prepare('INSERT INTO chapters(id,work_id,entry,directory,path) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry,path=excluded.path,deleted_at=NULL').run(id, work, JSON.stringify(entry), directory, directory);
      return recordEntry(db, entry);
    });
    committed = true;
    return result;
  } finally {
    if (committed) { if (backup) void removeRetired(backup.to); }
    else {
      for (const file of retainedFiles) renameSync(file.to, file.from);
      for (const path of addedFiles) renameSync(path, join(source, basename(path)));
      if (publishedPath) renameSync(publishedPath, source);
      if (backup) renameSync(backup.to, backup.from);
    }
  }
}

export function chapterRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT entry,directory,path,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; path: string | null; deleted_at: number | null } | undefined;
  if (!row) throw problem(404, 'Chapter not found');
  const catalog = JSON.parse(row.entry) as CatalogEntry;
  assertChapterNumberReconciliationReady(db, workId(catalog.manifest.identity));
  return { ...row, catalog };
}

export async function deleteChapter(db: DatabaseSync, dataDir: string, id: string): Promise<CatalogEntry> {
  const row = chapterRow(db, id);
  if (row.deleted_at !== null) return row.catalog;
  const trash = join('trash', id + '-' + randomUUID());
  const from = chapterStoragePath(dataDir, row.path ?? row.directory);
  const moved = existsSync(from);
  const verify = () => {
    const current = chapterRow(db, id);
    if (current.entry !== row.entry || current.path !== row.path || current.deleted_at !== null ||
        chapterStoragePath(dataDir, row.path ?? row.directory) !== from || existsSync(from) !== moved) {
      throw problem(409, 'Chapter changed during deletion; retry');
    }
  };
  const save = () => {
    db.prepare('UPDATE chapters SET path=?,deleted_at=? WHERE id=?').run(moved ? trash : null, Date.now(), id);
    const entry = recordEntry(db, { ...row.catalog, deleted: true });
    db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(id, entry.sequence);
    return entry;
  };
  if (!moved) return transaction(db, () => { verify(); return save(); });
  const trashPath = chapterStoragePath(dataDir, trash);
  mkdirSync(dirname(trashPath), { recursive: true });
  return moveChapterStorage(db, from, trashPath, verify, save);
}

export async function restoreChapter(db: DatabaseSync, dataDir: string, id: string, limits: Limits): Promise<CatalogEntry> {
  const row = chapterRow(db, id);
  if (db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(workId(row.catalog.manifest.identity))) throw problem(409, 'Restore the work before restoring its chapters');
  if (!row.catalog.deleted) return row.catalog;
  if (!row.path || !storedFilesExist(dataDir, row.path, row.catalog)) throw problem(410, 'Chapter files are unavailable');
  const { validateMedia } = await import('./chapter-files.ts');
  const source = chapterStoragePath(dataDir, row.path);
  const destination = chapterStoragePath(dataDir, row.directory);
  const signature = storageSignature(source);
  const complete = await validateMedia(source, row.catalog.manifest, limits);
  mkdirSync(dirname(destination), { recursive: true });
  return moveChapterStorage(db, source, destination, () => {
    const current = chapterRow(db, id);
    if (current.entry !== row.entry || current.path !== row.path || !storedFilesExist(dataDir, row.path!, row.catalog) ||
        chapterStoragePath(dataDir, row.directory) !== destination || storageSignature(source) !== signature) {
      throw problem(409, 'Chapter changed during restoration; retry');
    }
  }, () => {
    db.prepare('UPDATE chapters SET path=directory,deleted_at=NULL WHERE id=?').run(id);
    return recordEntry(db, { ...row.catalog, complete, deleted: false });
  });
}

export function purgeChapter(db: DatabaseSync, dataDir: string, id: string): void {
  const row = chapterRow(db, id);
  if (row.deleted_at === null) throw problem(409, 'Only deleted chapters can be purged');
  if (row.path) {
    const path = chapterStoragePath(dataDir, row.path);
    if (!path.startsWith(resolve(dataDir, 'trash') + sep)) throw problem(500, 'Unexpected chapter trash path');
    rmSync(path, { recursive: true, force: true });
  }
  db.prepare('UPDATE chapters SET path=NULL WHERE id=?').run(id);
}
