import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { problem, transaction } from './db.ts';

export interface PackageManifest {
  packageVersion: 1;
  layout: 'chapter-files';
  identity: { pluginId: string; novelPath: string; chapterPath: string };
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: 'html' | 'text' | 'markdown' | 'pdf'; page: string };
  bodyPath: string;
  files: { path: string; size: number; modifiedAt: number }[];
}
export interface CatalogEntry { id: string; revision: string; fileBytes: number; manifest: PackageManifest; deleted: boolean; sequence: number }
export interface Limits { zipBytes: number; expandedBytes: number; files: number }
export const defaultLimits: Limits = { zipBytes: 512 * 1024 ** 2, expandedBytes: 2 * 1024 ** 3, files: 10000 };
export const chapterFileNames = ['content.html', 'content.pdf', 'manifest.json', 'media.zip'];
export const isUnfinishedContentName = (name: string) => name.startsWith('.') || /(?:\.tmp|\.bak|\.part|\.partial|\.norea-sync-backup)$/i.test(name);
export const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const workId = (identity: PackageManifest['identity']) => digest(JSON.stringify([identity.pluginId, identity.novelPath]));
function safeSegment(value: string | null | undefined, fallback: string): string {
  const sanitized = (value?.trim() || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return !sanitized || sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

function safeLabel(value: string, fallback: string): string {
  const sanitized = [...(value.trim() || fallback)].map(ch => {
    const code = ch.codePointAt(0)!;
    const unsafeFormat = code === 0x180e || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
    return /[\s/:*?"<>|\\]/.test(ch) || unsafeFormat ? '-' : ch;
  }).join('').replace(/^[.-]+|[.-]+$/g, '').slice(0, 96);
  return !sanitized || sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

function chapterDirectory(manifest: PackageManifest): string {
  const plugin = safeSegment(manifest.identity.pluginId, 'source');
  const novel = `${safeLabel(manifest.novel.name, 'novel')}-${safeSegment(manifest.identity.novelPath, 'novel')}`;
  const chapter = `${safeSegment(manifest.chapter.chapterNumber, manifest.chapter.position > 0 ? String(manifest.chapter.position) : 'chapter')}-${safeLabel(manifest.chapter.name, 'chapter')}`;
  const path = join('contents', plugin, novel, chapter);
  if (!safeArchivePath(path.split('\\').join('/'))) throw problem(400, 'Content identity cannot be stored in a portable readable directory');
  return path;
}

export function safeArchivePath(path: string): boolean {
  return !!path && path.length <= 1024 && !path.includes('\\') && !path.includes(':') && !/[\x00-\x1f]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export function validateManifest(value: unknown): asserts value is PackageManifest {
  const m = value as PackageManifest;
  if (!m || typeof m !== 'object' || m.packageVersion !== 1 || !m.identity || !m.novel || !m.chapter || !Array.isArray(m.files)) throw problem(400, 'Unsupported or incomplete package manifest');
  const allowed = (object: object, names: string[]) => { if (Object.keys(object).some(key => !names.includes(key))) throw problem(400, 'Unknown package manifest field'); };
  allowed(m, ['packageVersion','layout','identity','novel','chapter','bodyPath','files']);
  if (m.layout !== 'chapter-files') throw problem(400, 'Unsupported chapter file layout');
  allowed(m.identity, ['pluginId','novelPath','chapterPath']);
  allowed(m.novel, ['name','author','summary','isLocal']);
  allowed(m.chapter, ['name','position','chapterNumber','contentType','page']);
  for (const value of [m.novel.author, m.novel.summary, m.chapter.chapterNumber]) if (value !== undefined && value !== null && typeof value !== 'string') throw problem(400, 'Invalid optional package metadata');
  const validUnicode = (value: unknown): void => {
    if (typeof value === 'string' && !value.isWellFormed()) throw problem(400, 'Invalid Unicode in package manifest');
    if (value && typeof value === 'object') for (const item of Object.values(value)) validUnicode(item);
  };
  validUnicode(m);
  for (const v of [m.identity.pluginId, m.identity.novelPath, m.identity.chapterPath, m.novel.name, m.chapter.name]) if (typeof v !== 'string' || !v || v.length > 4096) throw problem(400, 'Invalid package identity or title');
  if (typeof m.novel.isLocal !== 'boolean' || !Number.isFinite(m.chapter.position) || typeof m.chapter.page !== 'string' || !['html','text','markdown','pdf'].includes(m.chapter.contentType)) throw problem(400, 'Invalid package metadata');
  if (typeof m.bodyPath !== 'string' || !safeArchivePath(m.bodyPath)) throw problem(400, 'Invalid body path');
  for (let index = 0; index < m.files.length; index++) {
    const file = m.files[index];
    if (!file || typeof file.path !== 'string' || !safeArchivePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) throw problem(400, 'Invalid file manifest');
    if (!Number.isSafeInteger(file.modifiedAt) || file.modifiedAt < 0) throw problem(400, 'Invalid file modification time');
    allowed(file, ['path','size','modifiedAt']);
    if (index && m.files[index - 1].path >= file.path) throw problem(400, 'Manifest files must be sorted and unique');
  }
  if (!m.files.some(file => file.path === m.bodyPath)) throw problem(400, 'Body is absent from file manifest');
}

export function recordEntry(db: DatabaseSync, entry: CatalogEntry): CatalogEntry {
  const next = { ...entry };
  const result = db.prepare('INSERT INTO catalog_changes(chapter_id,entry) VALUES(?,?)').run(entry.id, '{}');
  next.sequence = Number(result.lastInsertRowid);
  const json = JSON.stringify(next);
  db.prepare('UPDATE catalog_changes SET entry=? WHERE sequence=?').run(json, next.sequence);
  db.prepare('UPDATE chapters SET entry=? WHERE id=?').run(json, next.id);
  return next;
}

function moveChapterFiles(source: string, destination: string): void {
  try { renameSync(source, destination); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  // Content bind mounts can be on a different filesystem from server state.
  const temporary = join(dirname(destination), `.norea-move-${randomUUID()}`);
  try {
    cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const retired = join(dirname(source), `.norea-move-${randomUUID()}`);
  try { renameSync(source, retired); }
  catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
  // A locked cleanup file must not invalidate the completed copy or its DB path.
  try { rmSync(retired, { recursive: true }); }
  catch { console.warn('Deferred removal of a retired chapter storage copy'); }
}

function storedFilesExist(dataDir: string, path: string, entry: CatalogEntry): boolean {
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

export function completeChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry | undefined {
  const row = db.prepare('SELECT entry,path FROM chapters WHERE id=? AND deleted_at IS NULL').get(id) as { entry: string; path: string | null } | undefined;
  if (!row?.path) return;
  const entry = JSON.parse(row.entry) as CatalogEntry;
  return storedFilesExist(dataDir, row.path, entry) ? entry : undefined;
}

export function uploadCursor(db: DatabaseSync): { catalog: number; works: number } {
  return db.prepare('SELECT (SELECT coalesce(max(sequence),0) FROM catalog_changes) AS catalog,(SELECT coalesce(max(sequence),0) FROM work_changes) AS works').get() as { catalog: number; works: number };
}

export function publishChapter(db: DatabaseSync, dataDir: string, source: string, entry: CatalogEntry, startedAt: ReturnType<typeof uploadCursor>, imported = false): CatalogEntry {
  const { id, manifest } = entry;
  let backup: { from: string; to: string } | undefined;
  let publishedPath: string | undefined;
  const addedFiles: string[] = [];
  const retainedFiles: { from: string; to: string }[] = [];
  let committed = false;
  try {
    const result = transaction(db, () => {
      const existing = db.prepare('SELECT entry,directory,path,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; path: string | null; deleted_at: number | null } | undefined;
      const work = workId(manifest.identity);
      const workDeletion = db.prepare('SELECT deleted,sequence FROM work_tombstones WHERE work_id=?').get(work) as { deleted: number; sequence: number } | undefined;
      const deletion = db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(id) as { sequence: number } | undefined;
      if ((imported && existing?.deleted_at != null) || workDeletion?.deleted || (deletion?.sequence ?? 0) > startedAt.catalog || (workDeletion?.sequence ?? 0) > startedAt.works) throw problem(409, 'Content was deleted; start a new upload to replace it');
      const current = completeChapter(db, dataDir, id);
      if (current && (!imported || current.revision === entry.revision)) return current;
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
            copyFileSync(join(source, file.path), path, constants.COPYFILE_EXCL);
            addedFiles.push(path);
          }
        } else {
          mkdirSync(dirname(destination), { recursive: true });
          moveChapterFiles(source, destination); publishedPath = destination;
        }
        if (backup) {
          for (const file of readdirSync(backup.to, { withFileTypes: true })) {
            if (!file.isFile() || chapterFileNames.includes(file.name.toLowerCase()) || isUnfinishedContentName(file.name)) continue;
            const retained = { from: join(backup.to, file.name), to: join(destination, file.name) };
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
    if (committed) { if (backup) rmSync(backup.to, { recursive: true, force: true }); }
    else {
      for (const file of retainedFiles) renameSync(file.to, file.from);
      for (const path of addedFiles) rmSync(path, { force: true });
      if (publishedPath) rmSync(publishedPath, { recursive: true, force: true });
      if (backup) renameSync(backup.to, backup.from);
    }
  }
}

export function chapterRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT entry,directory,path,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; path: string | null; deleted_at: number | null } | undefined;
  if (!row) throw problem(404, 'Chapter not found');
  return { ...row, catalog: JSON.parse(row.entry) as CatalogEntry };
}

export function deleteChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry {
  const row = chapterRow(db, id);
  if (row.catalog.deleted) return row.catalog;
  const trash = join('trash', id + '-' + randomUUID());
  const from = chapterStoragePath(dataDir, row.path ?? row.directory);
  const moved = existsSync(from);
  const trashPath = chapterStoragePath(dataDir, trash);
  if (moved) { mkdirSync(join(dataDir, 'trash'), { recursive: true }); moveChapterFiles(from, trashPath); }
  try {
    return transaction(db, () => {
      db.prepare('UPDATE chapters SET path=?,deleted_at=? WHERE id=?').run(moved ? trash : null, Date.now(), id);
      const entry = recordEntry(db, { ...row.catalog, deleted: true });
      db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(id, entry.sequence);
      return entry;
    });
  } catch (error) { if (moved) moveChapterFiles(trashPath, from); throw error; }
}

export async function restoreChapter(db: DatabaseSync, dataDir: string, id: string, limits: Limits): Promise<CatalogEntry> {
  const row = chapterRow(db, id);
  if (db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(workId(row.catalog.manifest.identity))) throw problem(409, 'Restore the work before restoring its chapters');
  if (!row.catalog.deleted) return row.catalog;
  if (!row.path || !storedFilesExist(dataDir, row.path, row.catalog)) throw problem(410, 'Chapter files are unavailable');
  const { validateMedia } = await import('./chapter-files.ts');
  const source = chapterStoragePath(dataDir, row.path);
  await validateMedia(source, row.catalog.manifest, limits);
  const current = chapterRow(db, id);
  if (!current.catalog.deleted || current.path !== row.path || current.catalog.revision !== row.catalog.revision || !storedFilesExist(dataDir, row.path, row.catalog)) throw problem(409, 'Chapter changed during restoration; retry');
  const destination = chapterStoragePath(dataDir, row.directory);
  if (existsSync(destination)) throw problem(409, 'Chapter directory already exists');
  mkdirSync(dirname(destination), { recursive: true });
  moveChapterFiles(source, destination);
  try {
    return transaction(db, () => {
      db.prepare('UPDATE chapters SET path=directory,deleted_at=NULL WHERE id=?').run(id);
      return recordEntry(db, { ...row.catalog, deleted: false });
    });
  } catch (error) { moveChapterFiles(destination, source); throw error; }
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
