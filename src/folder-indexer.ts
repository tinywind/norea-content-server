import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalize } from 'json-canonicalize';
import { validateFiles, validateMedia } from './chapter-files.ts';
import { chapterFileNames, digest, isUnfinishedContentName as unfinished, publishChapter, recordEntry, uploadCursor, type CatalogEntry, type Limits, type PackageManifest } from './packages.ts';
import { isCoverFile, cacheWork, metadataWorkId, readNovelMetadata, type NovelMetadataV1, type WorkEntry } from './works.ts';
import { transaction } from './db.ts';

export interface FolderIndexItem {
  path: string;
  sourceId?: string;
  status: 'registered' | 'unchanged' | 'skipped' | 'failed' | 'removed';
  reason?: string;
  chapterId?: string;
  workId?: string;
  revision?: string;
}
export interface FolderIndexSummary { scanned: number; registered: number; unchanged: number; skipped: number; failed: number; removed: number; cancelled: boolean }
export interface FolderIndexOptions {
  dataDir: string;
  db: DatabaseSync;
  limits: Limits;
  signal?: AbortSignal;
  full?: boolean;
  changedPaths?: readonly string[];
  onItem?: (item: FolderIndexItem, reused?: boolean) => void | Promise<void>;
  onWorkChange?: () => void;
}
type ChapterMetadata = Pick<PackageManifest, 'identity' | 'novel' | 'chapter'>;
interface IndexedChapter { id: string; work_id: string; directory: string; path: string | null; deleted_at: number | null; entry: string }
interface IndexedWork { id: string; directory: string; entry: string }
class UnsupportedChapterError extends Error {}
const fail = (message: string): never => { throw new Error(message); };
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
async function noLinks(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) fail('Symbolic links are not supported'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function signature(path: string): Promise<string> {
  const value = await lstat(path, { bigint: true });
  if (!value.isFile()) fail('Expected a regular source file');
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}
async function inventorySignature(directory: string, signal?: AbortSignal): Promise<string> {
  await noLinks(directory);
  const allEntries = await readdir(directory, { withFileTypes: true });
  const entries = allEntries.filter(entry => chapterFileNames.includes(entry.name)).sort((a, b) => a.name < b.name ? -1 : 1);
  if (allEntries.some(entry => unfinished(entry.name))) fail('Unfinished chapter files are present');
  if (allEntries.some(entry => entry.isSymbolicLink())) throw new UnsupportedChapterError('Symbolic chapter files are unsupported');
  if (allEntries.some(entry => !entry.isFile())) throw new UnsupportedChapterError('Unsupported chapter file; only current chapter files can be indexed');
  if (!entries.some(entry => ['content.html', 'content.pdf'].includes(entry.name)) && allEntries.some(entry => /\.zip$/i.test(entry.name) && entry.name !== 'media.zip')) {
    throw new UnsupportedChapterError('Outer chapter ZIP files are unsupported; current chapter files are required');
  }
  if (entries.filter(entry => ['content.html', 'content.pdf'].includes(entry.name)).length !== 1) fail('Chapter must contain exactly one supported body file');
  const parts: string[] = [];
  for (const entry of entries) { aborted(signal); parts.push(entry.name, await signature(join(directory, entry.name))); }
  return JSON.stringify(parts);
}
async function chapterManifest(directory: string, metadata: ChapterMetadata, options: FolderIndexOptions): Promise<PackageManifest> {
  const files: PackageManifest['files'] = [];
  for (const name of (await readdir(directory)).filter(name => chapterFileNames.includes(name)).sort()) {
    aborted(options.signal);
    const info = await lstat(join(directory, name));
    files.push({ path: name, size: info.size, modifiedAt: Math.floor(info.mtimeMs) });
  }
  const manifest: PackageManifest = { packageVersion: 1, layout: 'chapter-files', ...metadata, bodyPath: metadata.chapter.contentType === 'pdf' ? 'content.pdf' : 'content.html', files };
  validateFiles(manifest, options.limits);
  await validateMedia(directory, manifest, options.limits, options.signal);
  return manifest;
}

export async function scanFolder(options: FolderIndexOptions): Promise<FolderIndexSummary> {
  const summary: FolderIndexSummary = { scanned: 0, registered: 0, unchanged: 0, skipped: 0, failed: 0, removed: 0, cancelled: false };
  if (options.signal?.aborted) return { ...summary, cancelled: true };
  const dataDir = resolve(options.dataDir);
  const contents = join(dataDir, 'contents');
  const changes = options.changedPaths?.map(path => {
    const target = resolve(contents, path);
    if (target !== contents && !target.startsWith(contents + sep)) fail('Changed path is outside the content directory');
    return target;
  });
  const related = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  const selected = (path: string) => !changes || changes.some(change => related(path, change));
  const inspect = (path: string) => options.full || changes?.some(change => related(path, change));
  await noLinks(dataDir);
  if (!(await lstat(dataDir)).isDirectory()) fail('Server storage must be a directory');
  const report = async (item: FolderIndexItem, reused = false) => { summary.scanned++; summary[item.status]++; await options.onItem?.(item, reused); };
  const checkpoints = new Map((options.db.prepare('SELECT path,signature,entry FROM scan_checkpoints').all() as { path: string; signature: string; entry: string }[]).map(row => [row.path, row]));
  const checkpoint = (path: string) => checkpoints.get(path);
  const chapters = new Map((options.db.prepare('SELECT id,work_id,directory,path,deleted_at,entry FROM chapters').all() as unknown as IndexedChapter[]).map(row => [row.directory, row]));
  const works = options.db.prepare('SELECT id,directory,entry FROM works').all() as unknown as IndexedWork[];
  const seen = new Set<string>();
  const remember = (path: string, key: string, item: FolderIndexItem) => options.db.prepare('INSERT INTO scan_checkpoints(path,signature,entry) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET signature=excluded.signature,entry=excluded.entry').run(path, key, JSON.stringify(item));
  const unavailable = (row: IndexedChapter, removed = false) => transaction(options.db, () => {
    const pathCondition = removed ? "(path=directory OR path IS NULL) AND json_extract(entry,'$.deleted')=0" : 'path=directory';
    const result = options.db.prepare(`UPDATE chapters SET path=NULL WHERE id=? AND ${pathCondition} AND deleted_at IS NULL AND entry=?`).run(row.id, row.entry);
    if (!result.changes) return false;
    if (removed) {
      const entry = recordEntry(options.db, { ...JSON.parse(row.entry) as CatalogEntry, deleted: true });
      options.db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(row.id, entry.sequence);
    }
    options.onWorkChange?.(); return true;
  });
  const process = async (path: string, metadata: ChapterMetadata, rejectionKey: string) => {
    const sourceId = metadata.identity.pluginId;
    const startedAt = uploadCursor(options.db);
    try {
      aborted(options.signal);
      const chapterMetadata = [metadata.identity, metadata.chapter];
      let before = canonicalize([chapterMetadata, await inventorySignature(path, options.signal)]);
      const saved = checkpoint(path);
      if (saved?.signature === before) {
        const item = JSON.parse(saved.entry) as FolderIndexItem;
        const current = chapters.get(relative(dataDir, path));
        if (current?.path === current?.directory && current?.deleted_at === null && JSON.parse(current.entry).revision === item.revision) {
          await report({ ...item, status: 'unchanged' }, true); return;
        }
      }
      let manifest: PackageManifest;
      for (let attempt = 0; ; attempt++) {
        aborted(options.signal);
        manifest = await chapterManifest(path, metadata, options);
        const after = canonicalize([chapterMetadata, await inventorySignature(path, options.signal)]);
        if (before === after) break;
        if (attempt === 1) fail('Source changed during indexing; retry after download completes');
        before = after;
      }
      aborted(options.signal);
      const id = digest(JSON.stringify([manifest.identity.pluginId, manifest.identity.novelPath, manifest.identity.chapterPath]));
      const previous = options.db.prepare("SELECT path,json_extract(entry,'$.revision') AS revision FROM chapters WHERE id=?").get(id) as { path: string | null; revision: string } | undefined;
      const entry: CatalogEntry = { id, revision: digest(canonicalize([manifest, before])), manifest, fileBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), deleted: false, sequence: 0 };
      const current = publishChapter(options.db, dataDir, path, entry, startedAt, true);
      const item: FolderIndexItem = { path, sourceId, status: previous?.path && previous.revision === current.revision ? 'unchanged' : 'registered', chapterId: current.id, revision: current.revision };
      if (before === canonicalize([chapterMetadata, await inventorySignature(path, options.signal)])) remember(path, before, item);
      await report(item);
    } catch (error) {
      aborted(options.signal);
      const row = chapters.get(relative(dataDir, path)); if (row) unavailable(row);
      const code = (error as NodeJS.ErrnoException).code;
      const item: FolderIndexItem = { path, sourceId, status: code && ['EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(code) ? 'failed' : 'skipped', reason: (error as Error).message };
      if (error instanceof UnsupportedChapterError) remember(path, rejectionKey, item);
      else options.db.prepare('DELETE FROM scan_checkpoints WHERE path=?').run(path);
      await report(item);
    }
  };
  const indexWork = async (directory: string, sourceId: string) => {
    aborted(options.signal); await noLinks(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    seen.add(directory);
    for (const entry of entries) seen.add(join(directory, entry.name));
    const metadataPath = join(directory, 'novel.json');
    if (!entries.some(entry => entry.name === 'novel.json')) { await report({ path: directory, sourceId, status: 'skipped', reason: 'Valid novel.json is required; work identity cannot be inferred' }); return; }
    let value: NovelMetadataV1;
    try {
      const workSignature = async () => {
        const covers = entries.map(entry => entry.name).filter(isCoverFile).sort();
        return canonicalize([await signature(metadataPath), await Promise.all(covers.map(async name => [name, await signature(join(directory, name))]))]);
      };
      const saved = checkpoint(metadataPath);
      const cached = options.db.prepare('SELECT entry FROM works WHERE directory=?').get(relative(dataDir, directory)) as { entry: string } | undefined;
      const stored = cached ? JSON.parse(cached.entry) as WorkEntry : undefined;
      if (stored && options.db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(stored.id)) fail('Work was deleted from the server');
      if (saved && stored && saved.signature === await workSignature()) {
        value = stored.metadata;
        await report({ ...JSON.parse(saved.entry) as FolderIndexItem, status: 'unchanged' }, true);
      } else {
        let before: string;
        for (let attempt = 0; ; attempt++) {
          aborted(options.signal);
          const original = await signature(metadataPath);
          value = readNovelMetadata(metadataPath);
          if (value.identity.pluginId !== sourceId || value.identity.novelId !== directory.split(sep).at(-1)) fail('Work metadata IDs do not match its folder');
          before = await workSignature();
          if (original === await signature(metadataPath)) break;
          if (attempt === 1) fail('Work metadata changed during indexing');
        }
        aborted(options.signal);
        const id = metadataWorkId(value);
        const previous = options.db.prepare('SELECT entry FROM works WHERE id=?').get(id) as { entry: string } | undefined;
        const work = cacheWork(options.db, dataDir, relative(dataDir, directory), value);
        if (!previous || JSON.parse(previous.entry).sequence !== work.sequence) options.onWorkChange?.();
        const item: FolderIndexItem = { path: metadataPath, sourceId: value.identity.pluginId, workId: id, status: previous && JSON.parse(previous.entry).sequence === work.sequence ? 'unchanged' : 'registered' };
        if (before === await workSignature()) remember(metadataPath, before, item);
        await report(item);
      }
    } catch (error) {
      aborted(options.signal);
      await report({ path: metadataPath, sourceId, status: 'skipped', reason: (error as Error).message }); return;
    }
    const folders = [];
    for (const entry of entries) {
      if (entry.name === 'novel.json' || isCoverFile(entry.name) || entry.name === '.nomedia') continue;
      if (!entry.isDirectory() || entry.isSymbolicLink() || unfinished(entry.name)) {
        await report({ path: join(directory, entry.name), sourceId, status: 'skipped', reason: 'Chapter entry is not a directory, is symbolic, or is unfinished' }); continue;
      }
      folders.push(entry);
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    const isLocal = value.identity.pluginId === 'local';
    for (const folder of folders) {
      aborted(options.signal);
      const path = join(directory, folder.name);
      const key = canonicalize([value.identity, folder.name]);
      const saved = checkpoint(path);
      const published = chapters.get(relative(dataDir, path));
      if (!published?.path && !inspect(path) && saved?.signature === key) { await report(JSON.parse(saved.entry) as FolderIndexItem, true); continue; }
      const entry = published ? JSON.parse(published.entry) as CatalogEntry : undefined;
      const number = /^\d+(?:\.\d+)?$/.test(folder.name) && Number.isFinite(Number(folder.name)) && String(Number(folder.name)) === folder.name ? folder.name : undefined;
      if (number === undefined) {
        if (published) unavailable(published);
        await report({ path, sourceId, status: 'skipped', reason: 'Chapter folder must be a canonical nonnegative number' }); continue;
      }
      const exactIdentity = entry && (isLocal || !entry.manifest.identity.chapterPath.startsWith('norea-folder:'));
      if (entry && published?.path === published?.directory && published?.deleted_at === null && !inspect(path)) {
        await report({ path, sourceId, status: 'unchanged', chapterId: entry.id, revision: entry.revision }, true); continue;
      }
      if (exactIdentity) { await process(path, entry!.manifest, key); continue; }
      const files = await readdir(path);
      await process(path, {
        identity: { ...value.identity, chapterPath: isLocal ? `local-folder:${number}` : `norea-folder:${number}` },
        novel: { name: value.novel.name, author: value.novel.author, summary: value.novel.summary, isLocal: value.novel.isLocal },
        chapter: { name: value.chapters[number] ?? number, chapterNumber: number, position: Number(number), page: '1', contentType: files.includes('content.pdf') ? 'pdf' : 'html' },
      }, key);
    }
  };
  try {
    await noLinks(contents); await mkdir(contents, { recursive: true });
    for (const source of await readdir(contents, { withFileTypes: true })) {
      aborted(options.signal); const path = join(contents, source.name);
      if (!selected(path)) continue;
      if (source.isFile() && source.name === '.nomedia') continue;
      if (!source.isDirectory() || source.isSymbolicLink() || unfinished(source.name)) { await report({ path, status: 'skipped', reason: 'Source entry is not a directory, is symbolic, or is unfinished' }); continue; }
      for (const work of await readdir(path, { withFileTypes: true })) {
        aborted(options.signal); const directory = join(path, work.name);
        if (!selected(directory)) continue;
        if (work.isFile() && work.name === '.nomedia') continue;
        if (!work.isDirectory() || work.isSymbolicLink() || unfinished(work.name)) await report({ path: directory, sourceId: source.name, status: 'skipped', reason: 'Work entry is not a directory, is symbolic, or is unfinished' });
        else await indexWork(directory, source.name);
      }
    }
    const missing = async (path: string) => {
      if (seen.has(path)) return false;
      try { await lstat(path); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    };
    for (const row of chapters.values()) {
      aborted(options.signal);
      if (row.deleted_at !== null || JSON.parse(row.entry).deleted || (row.path !== row.directory && row.path !== null) || !selected(join(dataDir, row.directory)) || !await missing(join(dataDir, row.directory))) continue;
      if (unavailable(row, true)) await report({ path: join(dataDir, row.directory), chapterId: row.id, status: 'removed', reason: 'Chapter folder no longer exists' });
    }
    for (const row of works) {
      aborted(options.signal);
      const path = join(dataDir, row.directory);
      if (!selected(path) || !await missing(path)) continue;
      const removed = transaction(options.db, () => {
        if (!options.db.prepare('DELETE FROM works WHERE id=? AND entry=?').run(row.id, row.entry).changes) return false;
        options.db.prepare('DELETE FROM chapters WHERE work_id=?').run(row.id);
        const sequence = Number(options.db.prepare('INSERT INTO work_changes(work_id,entry) VALUES(?,?)').run(row.id, '{}').lastInsertRowid);
        options.db.prepare('UPDATE work_changes SET entry=? WHERE sequence=?').run(JSON.stringify({ ...JSON.parse(row.entry), deleted: true, hasCover: false, sequence }), sequence);
        return true;
      });
      if (removed) { options.onWorkChange?.(); await report({ path, workId: row.id, status: 'removed', reason: 'Work folder no longer exists' }); }
    }
    for (const path of checkpoints.keys()) {
      aborted(options.signal);
      if (!selected(path) || seen.has(path)) continue;
      if (await missing(path)) options.db.prepare('DELETE FROM scan_checkpoints WHERE path=?').run(path);
    }
  } catch (error) { if (options.signal?.aborted) summary.cancelled = true; else throw error; }
  return summary;
}
