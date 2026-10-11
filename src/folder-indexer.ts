import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import yauzl from 'yauzl';
import { canonicalize } from 'json-canonicalize';
import { digest, publishPackage, safeArchivePath, validateManifest, type Limits, type PackageManifest } from './packages.ts';
import { coverByteLimit, getWork, metadataByteLimit, metadataWorkId, readNovelMetadata, saveWork, saveWorkCover, validateNovelMetadata, type NovelMetadataV1 } from './works.ts';

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
  rootPath: string;
  metadataDbPath?: string;
  dataDir: string;
  db: DatabaseSync;
  limits: Limits;
  signal?: AbortSignal;
  onItem?: (item: FolderIndexItem) => void | Promise<void>;
  onWorkChange?: () => void;
}
interface MetadataRow {
  novelId: number; chapterId: number; pluginId: string; novelPath: string; chapterPath: string;
  novelName: string; author: string | null; summary: string | null; isLocal: number;
  cover?: string | null; artist?: string | null; status?: string | null; genres?: string | null; releaseTime?: string | null;
  chapterName: string; chapterNumber: string | null; position: number; page: string;
  contentType: PackageManifest['chapter']['contentType']; downloaded: number; repair: number;
}
type LegacyNovel = Pick<MetadataRow, 'novelId' | 'pluginId' | 'novelPath' | 'novelName' | 'cover' | 'author' | 'artist' | 'summary' | 'status' | 'genres' | 'isLocal'>;
interface Snapshot { source: string; destination: string; size: number; sha256: string; signature: string }
interface PreparedPackage { path: string; manifest: PackageManifest; snapshots: Snapshot[]; verifyInventory?: () => Promise<void> }
const unfinished = (name: string) => name.startsWith('.') || /(?:\.tmp|\.bak|\.part|\.partial|\.norea-sync-backup)$/i.test(name);
const fail = (message: string): never => { throw new Error(message); };
const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
const segment = (value: string | null, fallback: string) => { const result = (value?.trim() || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96); return !result || result === '.' || result === '..' ? fallback : result; };
function label(value: string, fallback: string): string {
  const result = [...(value.trim() || fallback)].map(ch => {
    const code = ch.codePointAt(0)!;
    return /[\s/:*?"<>|\\]/.test(ch) || code === 0x180e || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff ? '-' : ch;
  }).join('').replace(/^[.-]+|[.-]+$/g, '').slice(0, 96);
  return !result || result === '.' || result === '..' ? fallback : result;
}
function storagePath(row: MetadataRow): string {
  return [segment(row.pluginId, 'source'), `${label(row.novelName, 'novel')}-${segment(row.novelPath, String(row.novelId))}`, `${segment(row.chapterNumber, row.position > 0 ? String(row.position) : String(row.chapterId))}-${label(row.chapterName, 'chapter')}`].join('/');
}
interface DirectoryMetadata { row?: MetadataRow; reason?: string }
async function resolveDirectoryMetadata(contents: string, source: string, rows: MetadataRow[], signal?: AbortSignal): Promise<Map<string, DirectoryMetadata>> {
  const result = new Map<string, DirectoryMetadata>();
  if (rows.length === 0) return result;
  const novels = new Map<number, MetadataRow[]>();
  for (const row of rows) novels.set(row.novelId, [...(novels.get(row.novelId) ?? []), row]);
  const directories = new Set<string>();
  const candidates = new Map<MetadataRow, string[]>();
  for (const work of await readdir(source, { withFileTypes: true })) {
    aborted(signal);
    if (!work.isDirectory() || work.isSymbolicLink() || unfinished(work.name)) continue;
    const workPath = join(source, work.name); await noLinks(workPath);
    const chapters = (await readdir(workPath, { withFileTypes: true })).filter(chapter => chapter.isDirectory() && !chapter.isSymbolicLink() && !unfinished(chapter.name));
    const paths = new Map(chapters.map(chapter => [chapter.name, relative(contents, join(workPath, chapter.name)).split(sep).join('/')]));
    for (const path of paths.values()) directories.add(path);
    for (const novel of novels.values()) {
      if (!work.name.endsWith(`-${segment(novel[0].novelPath, String(novel[0].novelId))}`)) continue;
      for (const row of novel) {
        const prefix = `${segment(row.chapterNumber, row.position > 0 ? String(row.position) : String(row.chapterId))}-`;
        const matches = chapters.filter(chapter => chapter.name.startsWith(prefix)).map(chapter => paths.get(chapter.name)!);
        if (matches.length) candidates.set(row, [...(candidates.get(row) ?? []), ...matches]);
      }
    }
  }
  const claims = new Map<string, MetadataRow[]>();
  const exactDirectories = new Set(rows.map(storagePath).filter(path => directories.has(path)));
  for (const row of rows) {
    const exact = storagePath(row); const matches = candidates.get(row) ?? [];
    if (exactDirectories.has(exact)) {
      claims.set(exact, [...(claims.get(exact) ?? []), row]);
      for (const path of matches) if (!exactDirectories.has(path)) result.set(path, { reason: 'An exact current folder already exists for this metadata identity; older duplicate skipped' });
    }
  }
  const duplicateDirectories = new Set(result.keys());
  for (const row of rows) {
    if (exactDirectories.has(storagePath(row))) continue;
    const matches = (candidates.get(row) ?? []).filter(path => !exactDirectories.has(path) && !duplicateDirectories.has(path));
    if (matches.length === 1) claims.set(matches[0], [...(claims.get(matches[0]) ?? []), row]);
    else if (matches.length > 1) for (const path of matches) result.set(path, { reason: 'Multiple stored chapter folders match this metadata identity; ambiguous renamed folders skipped' });
  }
  for (const [path, matches] of claims) {
    if (matches.length > 1) result.set(path, { reason: 'Multiple database identities map to the same readable folder' });
    else if (!result.has(path)) result.set(path, { row: matches[0] });
  }
  return result;
}
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
async function snapshotFile(source: string, destination: string, limit: number, signal?: AbortSignal): Promise<Snapshot> {
  await mkdir(dirname(destination), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    aborted(signal);
    const before = await signature(source);
    if ((await lstat(source)).size > limit) fail('Source file exceeds byte limit');
    let size = 0; const hash = createHash('sha256');
    await pipeline(createReadStream(source), new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > limit) return done(new Error('Source file exceeds byte limit'));
      hash.update(chunk); done(null, chunk);
    } }), createWriteStream(destination, { flags: 'wx' }), { signal });
    if (before === await signature(source)) return { source, destination, size, sha256: hash.digest('hex'), signature: before };
    // Reading a cloud-backed file can hydrate it and change provider metadata once.
    if (attempt === 0) await rm(destination, { force: true });
  }
  return fail('Source changed during snapshot; retry after download completes');
}
async function verifySnapshot(files: Snapshot[], signal?: AbortSignal): Promise<void> {
  for (const file of files) {
    aborted(signal);
    if (await signature(file.source) !== file.signature) fail('Source changed during indexing; retry after download completes');
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of createReadStream(file.source, { signal })) { size += chunk.length; if (size > file.size) fail('Source changed during indexing'); hash.update(chunk); }
    if (size !== file.size || hash.digest('hex') !== file.sha256 || await signature(file.source) !== file.signature) fail('Source changed during indexing');
  }
}
async function metadataSnapshot(options: FolderIndexOptions, stage: string): Promise<{ rows: MetadataRow[]; novels: LegacyNovel[] }> {
  if (!options.metadataDbPath) return { rows: [], novels: [] };
  const source = resolve(options.metadataDbPath);
  if (inside(resolve(options.dataDir), source)) fail('Metadata database overlaps server storage');
  const files = [await snapshotFile(source, join(stage, 'metadata.sqlite'), options.limits.expandedBytes, options.signal)];
  const wal = `${source}-wal`;
  let hasWal = false;
  try { await lstat(wal); hasWal = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (hasWal) files.push(await snapshotFile(wal, join(stage, 'metadata.sqlite-wal'), options.limits.expandedBytes, options.signal));
  await verifySnapshot(files, options.signal);
  let walNow = false;
  try { await lstat(wal); walNow = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (walNow !== hasWal) fail('Metadata changed during snapshot');
  const db = new DatabaseSync(join(stage, 'metadata.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const novelColumns = new Set((db.prepare('PRAGMA table_info(novel)').all() as { name: string }[]).map(row => row.name));
    const chapterColumns = new Set((db.prepare('PRAGMA table_info(chapter)').all() as { name: string }[]).map(row => row.name));
    const optionalNovel = ['cover', 'artist', 'status', 'genres'].map(name => novelColumns.has(name) ? `n.${name}` : `NULL AS ${name}`).join(',');
    const releaseTime = chapterColumns.has('release_time') ? 'c.release_time AS releaseTime' : 'NULL AS releaseTime';
    const rows = db.prepare(`SELECT n.id AS novelId,c.id AS chapterId,n.plugin_id AS pluginId,n.path AS novelPath,c.path AS chapterPath,
      n.name AS novelName,n.author,n.summary,n.is_local AS isLocal,c.name AS chapterName,c.chapter_number AS chapterNumber,
      c.position,c.page,coalesce(c.stored_content_type,c.content_type) AS contentType,c.is_downloaded AS downloaded,c.media_repair_needed AS repair,${optionalNovel},${releaseTime}
      FROM novel n JOIN chapter c ON c.novel_id=n.id`).all() as unknown as MetadataRow[];
    const novels = db.prepare(`SELECT n.id AS novelId,n.plugin_id AS pluginId,n.path AS novelPath,n.name AS novelName,n.author,n.summary,n.is_local AS isLocal,${optionalNovel} FROM novel n`).all() as unknown as LegacyNovel[];
    db.exec('COMMIT'); return { rows, novels };
  } finally { db.close(); }
}

async function visitZip(path: string, limits: Limits, signal: AbortSignal | undefined, visit: (entry: yauzl.Entry, stream: Readable) => Promise<void>): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((accept, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : accept(value!)));
  let count = 0; let expanded = 0; const names = new Set<string>();
  try {
    await new Promise<void>((accept, reject) => {
      zip.on('error', reject); zip.on('end', accept);
      zip.on('entry', entry => { void (async () => {
        aborted(signal); const name = entry.fileName; const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (!safeArchivePath(name) || names.has(name.toLowerCase()) || (type !== 0 && type !== 0x8000) || (entry.generalPurposeBitFlag & 1)) fail('Unsafe or duplicate archive entry');
        names.add(name.toLowerCase()); count++; expanded += entry.uncompressedSize;
        if (count > limits.files + 1 || expanded > limits.expandedBytes) fail('Archive exceeds package limits');
        const stream = await new Promise<Readable>((acceptStream, rejectStream) => zip.openReadStream(entry, (error, stream) => error ? rejectStream(error) : acceptStream(stream!)));
        await visit(entry, stream); zip.readEntry();
      })().catch(reject); }); zip.readEntry();
    });
  } finally { zip.close(); }
}
function convertReferences(body: string, names: Set<string>): string {
  const prefix = 'norea-media://reader-asset/';
  const convertAttribute = (value: string, attribute: string): string => {
    let copied = 0; let result = ''; let position = value.indexOf(prefix);
    while (position >= 0) {
      const before = value.slice(copied, position);
      const candidate = attribute.toLowerCase() === 'style' ? /url\($/i.test(before.replace(/[ '"\t\r\n]+$/, '')) : attribute.toLowerCase() === 'srcset' ? position === copied || /[\s,]$/.test(before) : position === copied || before.trim() === '';
      if (!candidate) { result += value.slice(copied, position + prefix.length); copied = position + prefix.length; }
      else {
        const name = value.slice(position + prefix.length).match(/^[A-Za-z0-9._/-]*/)?.[0] ?? '';
        if (!names.has(name)) fail(`Body references missing media: ${name}`);
        result += before + `media/${name}`; copied = position + prefix.length + name.length;
      }
      position = value.indexOf(prefix, copied);
    }
    return result + value.slice(copied);
  };
  let result = ''; let copied = 0; let index = 0;
  while (index < body.length) {
    if (body[index] !== '<') { index++; continue; }
    if (body.startsWith('<!--', index)) { const end = body.indexOf('-->', index + 4); index = end < 0 ? body.length : end + 3; continue; }
    index++;
    while (index < body.length && !/\s/.test(body[index]) && body[index] !== '>') index++;
    while (index < body.length && body[index] !== '>') {
      while (index < body.length && /\s/.test(body[index])) index++;
      const nameStart = index;
      while (index < body.length && !/[\s=>]/.test(body[index])) index++;
      const name = body.slice(nameStart, index).toLowerCase();
      while (index < body.length && /\s/.test(body[index])) index++;
      if (body[index] !== '=') continue;
      index++;
      while (index < body.length && /\s/.test(body[index])) index++;
      const quote = body[index] === '"' || body[index] === "'" ? body[index++] : undefined;
      const start = index;
      while (index < body.length && (quote ? body[index] !== quote : !/[\s>]/.test(body[index]))) index++;
      if (['src', 'srcset', 'poster', 'data-src', 'data-original', 'data-lazy-src', 'style'].includes(name)) {
        result += body.slice(copied, start) + convertAttribute(body.slice(start, index), name); copied = index;
      }
      if (quote && index < body.length) index++;
    }
    if (index < body.length) index++;
  }
  return result + body.slice(copied);
}
async function rawPackage(directory: string, row: MetadataRow | undefined, stage: string, options: FolderIndexOptions, metadataError?: string): Promise<PreparedPackage> {
  const inventory = await readdir(directory, { withFileTypes: true });
  const inventoryKey = async (path: string) => { await noLinks(path); const info = await lstat(path, { bigint: true }); return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${(await readdir(path)).sort().join('\0')}`; };
  const originalInventory = await inventoryKey(directory);
  if (inventory.some(entry => unfinished(entry.name))) fail('Unfinished chapter files are present');
  if (inventory.some(entry => entry.isSymbolicLink())) fail('Symbolic chapter files are unsupported');
  const bodyPath = row?.contentType === 'pdf' || (!row && inventory.some(entry => entry.name === 'content.pdf' && entry.isFile())) ? 'content.pdf' : 'content.html';
  if (!inventory.some(entry => entry.name === bodyPath && entry.isFile())) fail('Current chapter body is missing; legacy formats are unsupported');
  const snapshots: Snapshot[] = [];
  const portable = join(stage, 'portable'); await mkdir(portable, { recursive: true });
  const snapshot = async (name: string, max: number) => { const value = await snapshotFile(join(directory, name), join(stage, 'source', name), max, options.signal); snapshots.push(value); return value; };
  const records: PackageManifest['files'] = []; let expanded = 0;
  const record = async (name: string) => {
    const path = join(portable, name); const size = (await lstat(path)).size; expanded += size;
    if (expanded > options.limits.expandedBytes || records.length >= options.limits.files) fail('Package exceeds expanded or file limit');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(path, { signal: options.signal })) hash.update(chunk);
    records.push({ path: name, size, sha256: hash.digest('hex') });
  };
  const hasManifest = inventory.some(entry => entry.name === 'manifest.json');
  const hasArchive = inventory.some(entry => entry.name === 'media.zip');
  const hasMedia = inventory.some(entry => entry.name === 'media');
  const originalMediaInventory = hasMedia ? await inventoryKey(join(directory, 'media')) : undefined;
  if (!hasManifest && (hasArchive || hasMedia)) fail('Media manifest is missing; incomplete or legacy chapter');
  const media = new Map<string, number>();
  if (hasManifest) {
    const snapshotManifest = await snapshot('manifest.json', Math.min(16 * 1024 ** 2, options.limits.expandedBytes));
    const value = JSON.parse(await readFile(snapshotManifest.destination, 'utf8'));
    if (value.version !== 1 || value.complete !== true || !Array.isArray(value.media?.files)) fail('Media manifest is incomplete or unsupported');
    if (value.media.files.length > options.limits.files - 2) fail('Media file limit exceeded');
    const remoteFiles = value.media.files.filter((file: { status?: string } | null) => file?.status === 'remote').length;
    if (remoteFiles) fail(`Chapter media is not downloaded: ${remoteFiles} remote assets in the media manifest`);
    const portableNames = new Set<string>();
    for (const file of value.media.files) {
      const name = file.fileName;
      if (typeof name !== 'string' || !safeArchivePath(name) || !/^[A-Za-z0-9._-]+$/.test(name) || portableNames.has(name.toLowerCase()) || file.path !== `media/${name}` || file.status !== 'stored' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('Invalid or incomplete media manifest');
      portableNames.add(name.toLowerCase()); media.set(name, file.bytes); file.updatedAt = 0;
    }
    value.updatedAt = 0;
    await writeFile(join(portable, 'media-manifest.json'), canonicalize(value)); await record('media-manifest.json');
  }
  if (media.size && !hasArchive && !hasMedia) fail('Downloaded chapter media is missing: no media.zip or media directory');
  if (!row) return fail(metadataError ?? (options.metadataDbPath
    ? 'Norea database has no matching chapter identity; media manifest.json contains asset metadata, not source paths'
    : 'Norea database path is not configured; raw chapters need database identity metadata, not a media manifest'));
  if (!row.downloaded || row.repair) fail('Chapter download is incomplete or needs media repair');
  if (!['html', 'text', 'markdown', 'pdf'].includes(row.contentType)) fail('Unsupported chapter content type');
  if (hasArchive) {
    const archive = await snapshot('media.zip', options.limits.zipBytes); const found = new Set<string>();
    await visitZip(archive.destination, options.limits, options.signal, async (entry, stream) => {
      if (!media.has(entry.fileName) || media.get(entry.fileName) !== entry.uncompressedSize) { stream.destroy(); fail('Media archive inventory does not match its manifest'); }
      if (expanded + entry.uncompressedSize > options.limits.expandedBytes) { stream.destroy(); fail('Expanded package limit exceeded'); }
      await mkdir(join(portable, 'media'), { recursive: true });
      await pipeline(stream, createWriteStream(join(portable, 'media', entry.fileName), { flags: 'wx' }), { signal: options.signal });
      found.add(entry.fileName); await record(`media/${entry.fileName}`);
    });
    if (found.size !== media.size) fail('Media archive is incomplete');
  } else {
    const entries = hasMedia ? await readdir(join(directory, 'media'), { withFileTypes: true }) : [];
    if (entries.length !== media.size || entries.some(entry => !entry.isFile() || !media.has(entry.name))) fail('Media directory inventory does not match its manifest');
    for (const [name, size] of media) {
      if (expanded + size > options.limits.expandedBytes) fail('Expanded package limit exceeded');
      const file = await snapshotFile(join(directory, 'media', name), join(portable, 'media', name), size, options.signal); snapshots.push(file);
      if (file.size !== size) fail('Media file is incomplete'); await record(`media/${name}`);
    }
  }
  const body = await snapshot(bodyPath, Math.min(options.limits.expandedBytes - expanded, row.contentType === 'pdf' ? options.limits.expandedBytes : 64 * 1024 ** 2));
  if (row.contentType === 'pdf') {
    await pipeline(createReadStream(body.destination), createWriteStream(join(portable, bodyPath)), { signal: options.signal });
  } else {
    const bytes = await readFile(body.destination);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    await writeFile(join(portable, bodyPath), convertReferences(text, new Set(media.keys())));
  }
  await record(bodyPath);
  const manifest: PackageManifest = { packageVersion: 1, identity: { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath }, novel: { name: row.novelName, author: row.author, summary: row.summary, isLocal: !!row.isLocal }, chapter: { name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, contentType: row.contentType, page: row.page }, bodyPath, files: records.sort((a, b) => a.path < b.path ? -1 : 1) };
  validateManifest(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length + expanded > options.limits.expandedBytes) fail('Expanded package limit exceeded');
  const zip = new ZipFile();
  // Media is already encoded; recompressing it makes large library scans CPU-bound.
  for (const file of records) zip.addFile(join(portable, file.path), file.path, { compress: !file.path.startsWith('media/') });
  zip.addBuffer(manifestBytes, 'manifest.json'); zip.end();
  const path = join(stage, 'package.zip'); let bytes = 0;
  await pipeline(zip.outputStream, new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > options.limits.zipBytes ? new Error('ZIP package limit exceeded') : null, chunk); } }), createWriteStream(path, { flags: 'wx' }), { signal: options.signal });
  return { path, manifest, snapshots, verifyInventory: async () => {
    if (await inventoryKey(directory) !== originalInventory || (originalMediaInventory !== undefined && await inventoryKey(join(directory, 'media')) !== originalMediaInventory)) fail('Source directory changed during indexing');
  } };
}

export async function scanFolder(options: FolderIndexOptions): Promise<FolderIndexSummary> {
  const summary: FolderIndexSummary = { scanned: 0, registered: 0, unchanged: 0, skipped: 0, failed: 0, cancelled: false };
  if (options.signal?.aborted) return { ...summary, cancelled: true };
  const root = resolve(options.rootPath); const dataDir = resolve(options.dataDir);
  if (inside(root, dataDir) || inside(dataDir, root)) fail('Source and server storage overlap');
  await noLinks(root); await noLinks(dataDir);
  if (!(await lstat(root)).isDirectory()) fail('Source root must be a directory');
  const actual = await realpath(root);
  if (inside(actual, dataDir) || inside(dataDir, actual)) fail('Source and server storage overlap');
  await noLinks(join(dataDir, 'staging'));
  await mkdir(join(dataDir, 'staging'), { recursive: true });
  const stage = await mkdtemp(join(dataDir, 'staging', 'folder-'));
  const report = async (item: FolderIndexItem) => { summary.scanned++; summary[item.status]++; await options.onItem?.(item); };
  try {
    let metadata: Awaited<ReturnType<typeof metadataSnapshot>> = { rows: [], novels: [] }; let metadataError: string | undefined;
    try { metadata = await metadataSnapshot(options, stage); }
    catch (error) { aborted(options.signal); metadataError = `Metadata unavailable: ${(error as Error).message}`; }
    const directoryMetadata = new Map<string, DirectoryMetadata>();
    const contents = join(root, 'contents'); await noLinks(contents);
    const registerLegacyWork = async (known: LegacyNovel | undefined, directory: string, sourceId: string) => {
      let sidecar: { version?: number; sourceId?: string; novelPath?: string; fileName?: string; contentType?: string; sourceUrl?: string } | undefined;
      const coverPath = join(directory, 'cover.json');
      try {
        await noLinks(coverPath);
        if ((await lstat(coverPath)).size > 65536) fail('Cover sidecar exceeds limit');
        const coverStage = await mkdtemp(join(stage, 'cover-'));
        const file = await snapshotFile(coverPath, join(coverStage, 'cover.json'), 65536, options.signal);
        await verifySnapshot([file], options.signal);
        sidecar = JSON.parse(await readFile(file.destination, 'utf8'));
        if (!sidecar || sidecar.version !== 1) throw new Error('Invalid cover sidecar version');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          aborted(options.signal); await report({ path: coverPath, sourceId, status: 'skipped', reason: `Cover metadata: ${(error as Error).message}` });
        }
        sidecar = undefined;
      }
      if (sidecar) {
        if (sidecar.sourceId !== undefined && (typeof sidecar.sourceId !== 'string' || segment(sidecar.sourceId, 'source') !== sourceId)) fail('Cover sidecar source does not match its folder');
        if (sidecar.novelPath !== undefined && (typeof sidecar.novelPath !== 'string' || !sidecar.novelPath.trim())) fail('Invalid cover sidecar work identity');
        if (known && sidecar.novelPath !== undefined && sidecar.novelPath !== known.novelPath) fail('Cover sidecar and database work identities disagree');
      }
      if (!known && !sidecar?.novelPath) {
        const candidates = (options.db.prepare('SELECT entry FROM works').all() as { entry: string }[])
          .map(record => JSON.parse(record.entry).metadata as NovelMetadataV1)
          .filter(value => segment(value.identity.pluginId, 'source') === sourceId && basename(directory).endsWith(`-${segment(value.identity.novelPath, '')}`));
        if (candidates.length > 1) fail('Multiple server works match the same folder');
        if (candidates.length === 1) {
          const value = candidates[0];
          known = { novelId: 0, pluginId: value.identity.pluginId, novelPath: value.identity.novelPath, novelName: value.novel.name,
            ...value.novel, isLocal: value.novel.isLocal ? 1 : 0 };
        }
      }
      const novelPath = known?.novelPath ?? sidecar?.novelPath ?? `norea-folder:${basename(directory)}`;
      const suffix = `-${segment(novelPath, '')}`;
      const folderName = basename(directory);
      const row: LegacyNovel = known ?? { novelId: 0, pluginId: sidecar?.sourceId ?? sourceId, novelPath,
        novelName: sidecar?.novelPath && folderName.endsWith(suffix) ? folderName.slice(0, -suffix.length) : folderName,
        author: null, summary: null, isLocal: sourceId === 'local' ? 1 : 0 };
      const id = digest(JSON.stringify([row.pluginId, row.novelPath]));
      const existing = options.db.prepare('SELECT id FROM works WHERE id=?').get(id) ? getWork(options.db, dataDir, id) : undefined;
      const value: NovelMetadataV1 = existing ? structuredClone(existing.metadata) : { schemaVersion: 1, identity: { pluginId: row.pluginId, novelPath: row.novelPath },
        novel: { name: row.novelName, cover: row.cover ?? null, author: row.author, artist: row.artist ?? null, summary: row.summary, status: row.status ?? null, genres: row.genres ?? null, isLocal: !!row.isLocal },
        chapters: metadata.rows.filter(chapter => known && chapter.novelId === row.novelId).map(chapter => ({ path: chapter.chapterPath, name: chapter.chapterName, chapterNumber: chapter.chapterNumber, position: chapter.position, page: chapter.page, contentType: chapter.contentType, releaseTime: chapter.releaseTime ?? null,
          directory: [...directoryMetadata.entries()].find(([, match]) => match.row?.chapterId === chapter.chapterId)?.[0].split('/').at(-1) ?? storagePath(chapter).split('/').at(-1)! })),
        cover: null, updatedAt: 0 };
      const folders = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !unfinished(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      const numbers = new Map<string, number>();
      for (const folder of folders) {
        const number = folder.name.match(/^(\d+(?:\.\d+)?)-(.+)$/)?.[1];
        if (number) numbers.set(number, (numbers.get(number) ?? 0) + 1);
      }
      for (const [index, folder] of folders.entries()) {
        const path = join(directory, folder.name); const key = relative(contents, path).split(sep).join('/');
        const mapped = directoryMetadata.get(key);
        if (mapped) {
          if (mapped.row) mapped.row = { ...mapped.row, novelName: value.novel.name, author: value.novel.author, summary: value.novel.summary, isLocal: value.novel.isLocal ? 1 : 0 };
          const stored = value.chapters.find(chapter => chapter.directory === folder.name);
          if (mapped.row && stored && stored.contentType !== 'epub') {
            mapped.row = { ...mapped.row, chapterPath: stored.path, chapterName: stored.name, chapterNumber: stored.chapterNumber,
              position: stored.position, page: stored.page, contentType: stored.contentType };
          } else if (mapped.row && !value.chapters.some(chapter => chapter.path === mapped.row!.chapterPath)) {
            const chapter = mapped.row;
            value.chapters.push({ path: chapter.chapterPath, name: chapter.chapterName, chapterNumber: chapter.chapterNumber, position: chapter.position,
              page: chapter.page, contentType: chapter.contentType, releaseTime: chapter.releaseTime ?? null, directory: folder.name });
          }
          continue;
        }
        const parts = folder.name.match(/^(\d+(?:\.\d+)?)-(.+)$/);
        const stored = value.chapters.find(chapter => chapter.directory === folder.name);
        const byNumber = parts ? value.chapters.filter(chapter => chapter.chapterNumber === parts[1]) : [];
        if (!stored && (!parts || numbers.get(parts[1]) !== 1 || byNumber.length > 1)) {
          directoryMetadata.set(key, { reason: 'Chapter folder must have a unique number followed by a hyphen and title' }); continue;
        }
        const previous = stored ?? byNumber[0];
        const files = await readdir(path);
        const chapter: NovelMetadataV1['chapters'][number] = previous ?? {
          path: `norea-folder:${parts![1]}`, name: parts![2], chapterNumber: parts![1], position: index + 1, page: '1',
          contentType: files.includes('content.pdf') ? 'pdf' : 'html', releaseTime: null, directory: folder.name };
        if (chapter.contentType === 'epub') { directoryMetadata.set(key, { reason: 'EPUB chapter packages are unsupported' }); continue; }
        directoryMetadata.set(key, { row: { ...row, novelName: value.novel.name, author: value.novel.author, summary: value.novel.summary, isLocal: value.novel.isLocal ? 1 : 0, chapterId: 0, chapterPath: chapter.path, chapterName: chapter.name,
          chapterNumber: chapter.chapterNumber, position: chapter.position, page: chapter.page, contentType: chapter.contentType, downloaded: 1, repair: 0 } });
        if (!previous) value.chapters.push(chapter);
      }
      let cover: Buffer | undefined;
      try {
        const manifest = sidecar;
        if (!existing?.hasCover && manifest && typeof manifest.fileName === 'string' && /^cover\.(?:avif|bmp|gif|jpe?g|png|svg|webp|img)$/.test(manifest.fileName) && typeof manifest.sourceUrl === 'string') {
          const snapshot = await snapshotFile(join(directory, manifest.fileName), join(stage, `${id}-cover`), coverByteLimit, options.signal);
          await verifySnapshot([snapshot], options.signal);
          const bytes = await readFile(snapshot.destination);
          if (!bytes.length) fail('Cover image is empty');
          const descriptor = { fileName: manifest.fileName, contentType: typeof manifest.contentType === 'string' && /^image\/[a-zA-Z0-9.+-]+$/.test(manifest.contentType) ? manifest.contentType : null, sourceUrl: manifest.sourceUrl };
          validateNovelMetadata({ ...value, cover: descriptor });
          cover = bytes; value.cover = descriptor;
        }
      } catch (error) {
        aborted(options.signal);
        await report({ path: join(directory, sidecar!.fileName!), sourceId, status: 'skipped', reason: `Cover image: ${(error as Error).message}` });
      }
      let work = saveWork(options.db, dataDir, value);
      if (cover) work = saveWorkCover(options.db, dataDir, id, cover);
      await report({ path: directory, sourceId, workId: id, status: existing?.sequence === work.sequence ? 'unchanged' : 'registered' });
      if (existing?.sequence !== work.sequence) options.onWorkChange?.();
    };
    const process = async (path: string, sourceFolder: string, row?: MetadataRow) => {
      let sourceId = row?.pluginId ?? sourceFolder;
      aborted(options.signal); const itemStage = await mkdtemp(join(stage, 'chapter-'));
      try {
        let prepared: PreparedPackage;
        if (path.endsWith('.zip')) {
          const snapshot = await snapshotFile(path, join(itemStage, 'package.zip'), options.limits.zipBytes, options.signal);
          let manifest: PackageManifest | undefined;
          await visitZip(snapshot.destination, options.limits, options.signal, async (entry, stream) => {
            if (entry.fileName !== 'manifest.json') { for await (const _chunk of stream) aborted(options.signal); return; }
            if (entry.uncompressedSize > 4 * 1024 ** 2) { stream.destroy(); fail('Package manifest exceeds limit'); }
            const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk);
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); validateManifest(parsed); manifest = parsed;
          });
          if (!manifest || segment(manifest.identity.pluginId, 'source') !== sourceFolder) fail('Package manifest source does not match its folder');
          sourceId = manifest!.identity.pluginId;
          if (row && (manifest!.identity.pluginId !== row.pluginId || manifest!.identity.novelPath !== row.novelPath || manifest!.identity.chapterPath !== row.chapterPath)) fail('Package identity differs from novel.json chapter identity');
          prepared = { path: snapshot.destination, manifest: manifest!, snapshots: [snapshot] };
        } else {
          prepared = await rawPackage(path, row, itemStage, options, metadataError);
        }
        await verifySnapshot(prepared.snapshots, options.signal); await prepared.verifyInventory?.(); aborted(options.signal);
        const id = digest(JSON.stringify([prepared.manifest.identity.pluginId, prepared.manifest.identity.novelPath, prepared.manifest.identity.chapterPath]));
        const previous = options.db.prepare('SELECT revision FROM revisions WHERE chapter_id=? AND path IS NOT NULL').all(id) as { revision: string }[];
        // Open the abortable file only after the publisher has attached stream error handling.
        const input = Readable.from((async function* () { yield* createReadStream(prepared.path, { signal: options.signal }); })());
        const entry = await publishPackage(options.db, dataDir, input, options.limits);
        await report({ path, sourceId, status: previous.some(row => row.revision === entry.revision) ? 'unchanged' : 'registered', chapterId: entry.id, revision: entry.revision });
      } catch (error) {
        aborted(options.signal);
        const code = (error as NodeJS.ErrnoException).code;
        await report({ path, sourceId, status: code && ['EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(code) ? 'failed' : 'skipped', reason: (error as Error).message });
      } finally { await rm(itemStage, { recursive: true, force: true }); }
    };
    const walk = async (directory: string, sourceId: string, depth: number): Promise<void> => {
      aborted(options.signal); await noLinks(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      if (depth === 1 && entries.some(entry => entry.name === 'novel.json')) {
        const workStage = await mkdtemp(join(stage, 'work-'));
        let value: NovelMetadataV1;
        try {
          const file = await snapshotFile(join(directory, 'novel.json'), join(workStage, 'novel.json'), metadataByteLimit, options.signal);
          value = readNovelMetadata(file.destination);
          if (segment(value.identity.pluginId, 'source') !== sourceId) fail('Work metadata source does not match its folder');
          const snapshots = [file];
          if (value.cover && entries.some(entry => entry.name === value.cover!.fileName)) snapshots.push(await snapshotFile(join(directory, value.cover.fileName), join(workStage, value.cover.fileName), coverByteLimit, options.signal));
          await verifySnapshot(snapshots, options.signal); aborted(options.signal);
          const id = metadataWorkId(value);
          const previous = options.db.prepare('SELECT entry FROM works WHERE id=?').get(id) as { entry: string } | undefined;
          let work = saveWork(options.db, dataDir, value);
          if (snapshots.length > 1) work = saveWorkCover(options.db, dataDir, id, await readFile(snapshots[1].destination));
          await report({ path: join(directory, 'novel.json'), sourceId: value.identity.pluginId, workId: id, status: previous && JSON.parse(previous.entry).sequence === work.sequence ? 'unchanged' : 'registered' });
        } catch (error) {
          aborted(options.signal);
          await report({ path: join(directory, 'novel.json'), sourceId, status: 'skipped', reason: (error as Error).message });
          return;
        } finally { await rm(workStage, { recursive: true, force: true }); }
        for (const chapter of value.chapters) {
          const entry = entries.find(entry => entry.name === chapter.directory);
          if (!entry) continue;
          const path = join(directory, chapter.directory);
          if (!entry.isDirectory() || entry.isSymbolicLink()) { await report({ path, sourceId, status: 'skipped', reason: 'Chapter directory is not a regular directory' }); continue; }
          if (chapter.contentType === 'epub') { await report({ path, sourceId, status: 'skipped', reason: 'EPUB chapters are cataloged but chapter package v1 does not support EPUB' }); continue; }
          const row: MetadataRow = { novelId: 0, chapterId: 0, pluginId: value.identity.pluginId, novelPath: value.identity.novelPath, chapterPath: chapter.path, novelName: value.novel.name, author: value.novel.author, summary: value.novel.summary, isLocal: value.novel.isLocal ? 1 : 0, chapterName: chapter.name, chapterNumber: chapter.chapterNumber, position: chapter.position, page: chapter.page, contentType: chapter.contentType, downloaded: 1, repair: 0 };
          const files = await readdir(path, { withFileTypes: true });
          const packages = files.filter(file => file.isFile() && file.name.endsWith('.zip') && file.name !== 'media.zip' && !unfinished(file.name));
          if (files.some(file => /^content\./.test(file.name)) || packages.length === 0) await process(path, sourceId, row);
          for (const file of packages) await process(join(path, file.name), sourceId, row);
        }
        return;
      }
      if (depth === 2) {
        const key = relative(contents, directory).split(sep).join('/'); const match = directoryMetadata.get(key);
        const packages = entries.filter(entry => entry.isFile() && entry.name.endsWith('.zip') && entry.name !== 'media.zip' && !unfinished(entry.name));
        if (entries.some(entry => /^content\./.test(entry.name)) || packages.length === 0) {
          if (match?.reason) await report({ path: directory, sourceId, status: 'skipped', reason: match.reason });
          else await process(directory, sourceId, match?.row);
        }
        for (const entry of packages) await process(join(directory, entry.name), sourceId);
        return;
      }
      if (depth === 1) {
        const key = relative(contents, directory).split(sep).join('/');
        const mappedIds = new Set([...directoryMetadata.entries()].filter(([path, match]) => path.startsWith(`${key}/`) && match.row).map(([, match]) => match.row!.novelId));
        const sourceNovels = metadata.novels.filter(novel => segment(novel.pluginId, 'source') === sourceId);
        const exact = sourceNovels.filter(novel => mappedIds.has(novel.novelId) || key === `${sourceId}/${label(novel.novelName, 'novel')}-${segment(novel.novelPath, String(novel.novelId))}`);
        const matches = exact.length ? exact : sourceNovels.filter(novel => basename(directory).endsWith(`-${segment(novel.novelPath, String(novel.novelId))}`));
        try {
          if (matches.length > 1) fail('Multiple database works match the same folder');
          await registerLegacyWork(matches[0], directory, sourceId);
        } catch (error) { aborted(options.signal); await report({ path: directory, sourceId, status: 'skipped', reason: `Legacy work metadata: ${(error as Error).message}` }); return; }
      }
      const visitEntry = async (entry: (typeof entries)[number]) => {
        aborted(options.signal); const path = join(directory, entry.name);
        if (entry.isFile() && (entry.name === '.nomedia' || (depth === 1 && /^cover\.(?:json|avif|bmp|gif|jpg|jpeg|png|svg|webp|img)$/.test(entry.name)))) return;
        if (entry.isSymbolicLink() || unfinished(entry.name)) await report({ path, sourceId, status: 'skipped', reason: 'Symbolic or unfinished entry is unsupported' });
        else if (entry.isDirectory()) await walk(path, sourceId, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.zip') && entry.name !== 'media.zip') await process(path, sourceId);
        else await report({ path, sourceId, status: 'skipped', reason: 'Unsupported non-chapter file' });
      };
      const concurrency = depth === 1 ? 4 : 1;
      for (let index = 0; index < entries.length; index += concurrency) {
        const results = await Promise.allSettled(entries.slice(index, index + concurrency).map(visitEntry));
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
      }
    };
    for (const source of await readdir(contents, { withFileTypes: true })) {
      aborted(options.signal); const path = join(contents, source.name);
      if (source.isFile() && source.name === '.nomedia') continue;
      if (!source.isDirectory() || source.isSymbolicLink() || unfinished(source.name)) await report({ path, status: 'skipped', reason: 'Source entry is not a directory, is symbolic, or is unfinished' });
      else {
        const rows = metadata.rows.filter(row => typeof row.pluginId === 'string' && row.pluginId.trim() && segment(row.pluginId, 'source') === source.name);
        for (const [key, value] of await resolveDirectoryMetadata(contents, path, rows, options.signal)) directoryMetadata.set(key, value);
        await walk(path, source.name, 0);
      }
    }
  } catch (error) { if (options.signal?.aborted) summary.cancelled = true; else throw error; }
  finally { await rm(stage, { recursive: true, force: true }); }
  return summary;
}
