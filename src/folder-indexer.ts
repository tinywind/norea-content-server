import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalize } from 'json-canonicalize';
import { validateFiles, validateMedia } from './chapter-files.ts';
import { completeChapter, digest, publishChapter, uploadCursor, type CatalogEntry, type Limits, type PackageManifest } from './packages.ts';
import { isCoverFile, cacheWork, metadataWorkId, readNovelMetadata, type NovelMetadataV1, type WorkEntry } from './works.ts';

export interface FolderIndexItem {
  path: string;
  sourceId?: string;
  status: 'registered' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
  chapterId?: string;
  workId?: string;
  revision?: string;
}
export interface FolderIndexSummary { scanned: number; registered: number; unchanged: number; skipped: number; failed: number; cancelled: boolean }
export interface FolderIndexOptions {
  dataDir: string;
  db: DatabaseSync;
  limits: Limits;
  signal?: AbortSignal;
  onItem?: (item: FolderIndexItem) => void | Promise<void>;
  onWorkChange?: () => void;
}
type ChapterMetadata = Pick<PackageManifest, 'identity' | 'novel' | 'chapter'>;
const unfinished = (name: string) => name.startsWith('.') || /(?:\.tmp|\.bak|\.part|\.partial|\.norea-sync-backup)$/i.test(name);
const fail = (message: string): never => { throw new Error(message); };
const segment = (value: string) => { const result = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96); return !result || result === '.' || result === '..' ? 'source' : result; };
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
  await noLinks(path);
  const value = await lstat(path, { bigint: true });
  if (!value.isFile()) fail('Expected a regular source file');
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}
async function inventorySignature(directory: string, signal?: AbortSignal): Promise<string> {
  await noLinks(directory);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1);
  if (entries.some(entry => unfinished(entry.name))) fail('Unfinished chapter files are present');
  if (entries.some(entry => entry.isSymbolicLink())) fail('Symbolic chapter files are unsupported');
  if (entries.some(entry => !entry.isFile() || !['content.html', 'content.pdf', 'manifest.json', 'media.zip'].includes(entry.name))) fail('Unsupported chapter file; only current chapter files can be indexed');
  if (entries.filter(entry => ['content.html', 'content.pdf'].includes(entry.name)).length !== 1) fail('Chapter must contain exactly one supported body file');
  const parts: string[] = [];
  for (const entry of entries) { aborted(signal); parts.push(entry.name, await signature(join(directory, entry.name))); }
  return JSON.stringify(parts);
}
async function chapterManifest(directory: string, metadata: ChapterMetadata, options: FolderIndexOptions): Promise<PackageManifest> {
  const files: PackageManifest['files'] = [];
  for (const name of (await readdir(directory)).sort()) {
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
  const summary: FolderIndexSummary = { scanned: 0, registered: 0, unchanged: 0, skipped: 0, failed: 0, cancelled: false };
  if (options.signal?.aborted) return { ...summary, cancelled: true };
  const dataDir = resolve(options.dataDir);
  await noLinks(dataDir);
  if (!(await lstat(dataDir)).isDirectory()) fail('Server storage must be a directory');
  const report = async (item: FolderIndexItem) => { summary.scanned++; summary[item.status]++; await options.onItem?.(item); };
  const checkpoint = (path: string) => options.db.prepare('SELECT signature,entry FROM scan_checkpoints WHERE path=?').get(path) as { signature: string; entry: string } | undefined;
  const remember = (path: string, key: string, item: FolderIndexItem) => options.db.prepare('INSERT INTO scan_checkpoints(path,signature,entry) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET signature=excluded.signature,entry=excluded.entry').run(path, key, JSON.stringify(item));
  const process = async (path: string, metadata: ChapterMetadata) => {
    const sourceId = metadata.identity.pluginId;
    const startedAt = uploadCursor(options.db);
    try {
      aborted(options.signal);
      const chapterMetadata = [metadata.identity, metadata.chapter];
      let before = canonicalize([chapterMetadata, await inventorySignature(path, options.signal)]);
      const saved = checkpoint(path);
      if (saved?.signature === before) {
        const item = JSON.parse(saved.entry) as FolderIndexItem;
        const current = completeChapter(options.db, dataDir, item.chapterId!);
        if (current?.revision === item.revision) {
          await report({ ...item, status: 'unchanged' }); return;
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
      options.db.prepare('UPDATE chapters SET path=NULL WHERE directory=? AND path=directory AND deleted_at IS NULL').run(relative(dataDir, path));
      const code = (error as NodeJS.ErrnoException).code;
      await report({ path, sourceId, status: code && ['EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(code) ? 'failed' : 'skipped', reason: (error as Error).message });
    }
  };
  const indexWork = async (directory: string, sourceId: string) => {
    aborted(options.signal); await noLinks(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const metadataPath = join(directory, 'novel.json');
    if (!entries.some(entry => entry.name === 'novel.json')) { await report({ path: directory, sourceId, status: 'skipped', reason: 'Valid novel.json is required; work identity cannot be inferred' }); return; }
    let value: NovelMetadataV1;
    try {
      const workSignature = async () => {
        const covers = (await readdir(directory)).filter(isCoverFile).sort();
        return canonicalize([await signature(metadataPath), await Promise.all(covers.map(async name => [name, await signature(join(directory, name))]))]);
      };
      const saved = checkpoint(metadataPath);
      const cached = options.db.prepare('SELECT entry FROM works WHERE directory=?').get(relative(dataDir, directory)) as { entry: string } | undefined;
      const stored = cached ? JSON.parse(cached.entry) as WorkEntry : undefined;
      if (stored && options.db.prepare('SELECT 1 FROM work_tombstones WHERE work_id=? AND deleted=1').get(stored.id)) fail('Work was deleted from the server');
      if (saved && stored && saved.signature === await workSignature()) {
        value = stored.metadata;
        await report({ ...JSON.parse(saved.entry) as FolderIndexItem, status: 'unchanged' });
      } else {
        let before: string;
        for (let attempt = 0; ; attempt++) {
          aborted(options.signal);
          const original = await signature(metadataPath);
          value = readNovelMetadata(metadataPath);
          if (segment(value.identity.pluginId) !== sourceId) fail('Work metadata source does not match its folder');
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
    const numbers = new Map<string, number>();
    for (const folder of folders) {
      const number = folder.name.match(/^(\d+(?:\.\d+)?)-(.+)$/)?.[1];
      if (number) numbers.set(number, (numbers.get(number) ?? 0) + 1);
    }
    for (const folder of folders) {
      aborted(options.signal);
      const path = join(directory, folder.name);
      const published = options.db.prepare('SELECT entry FROM chapters WHERE directory=?').get(relative(dataDir, path)) as { entry: string } | undefined;
      const entry = published ? JSON.parse(published.entry) as CatalogEntry : undefined;
      if (entry && !entry.manifest.identity.chapterPath.startsWith('norea-folder:')) { await process(path, entry.manifest); continue; }
      const parts = folder.name.match(/^(\d+(?:\.\d+)?)-(.+)$/);
      if (!parts || numbers.get(parts[1]) !== 1) {
        options.db.prepare('UPDATE chapters SET path=NULL WHERE directory=? AND path=directory AND deleted_at IS NULL').run(relative(dataDir, path));
        await report({ path, sourceId, status: 'skipped', reason: 'Chapter folder must have a unique number followed by a hyphen and title' }); continue;
      }
      const files = await readdir(path);
      await process(path, {
        identity: { ...value.identity, chapterPath: `norea-folder:${parts[1]}` },
        novel: { name: value.novel.name, author: value.novel.author, summary: value.novel.summary, isLocal: value.novel.isLocal },
        chapter: { name: parts[2], chapterNumber: parts[1], position: Number(parts[1]), page: '1', contentType: files.includes('content.pdf') ? 'pdf' : 'html' },
      });
    }
  };
  try {
    const contents = join(dataDir, 'contents'); await noLinks(contents); await mkdir(contents, { recursive: true });
    for (const source of await readdir(contents, { withFileTypes: true })) {
      aborted(options.signal); const path = join(contents, source.name);
      if (source.isFile() && source.name === '.nomedia') continue;
      if (!source.isDirectory() || source.isSymbolicLink() || unfinished(source.name)) { await report({ path, status: 'skipped', reason: 'Source entry is not a directory, is symbolic, or is unfinished' }); continue; }
      for (const work of await readdir(path, { withFileTypes: true })) {
        aborted(options.signal); const directory = join(path, work.name);
        if (work.isFile() && work.name === '.nomedia') continue;
        if (!work.isDirectory() || work.isSymbolicLink() || unfinished(work.name)) await report({ path: directory, sourceId: source.name, status: 'skipped', reason: 'Work entry is not a directory, is symbolic, or is unfinished' });
        else await indexWork(directory, source.name);
      }
    }
  } catch (error) { if (options.signal?.aborted) summary.cancelled = true; else throw error; }
  return summary;
}
