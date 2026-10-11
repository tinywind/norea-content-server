import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import yauzl from 'yauzl';
import { canonicalize } from 'json-canonicalize';
import { digest, publishPackage, safeArchivePath, validateManifest, type Limits, type PackageManifest } from './packages.ts';

export interface FolderIndexItem {
  path: string;
  sourceId?: string;
  status: 'registered' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
  chapterId?: string;
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
}
interface MetadataRow {
  novelId: number; chapterId: number; pluginId: string; novelPath: string; chapterPath: string;
  novelName: string; author: string | null; summary: string | null; isLocal: number;
  chapterName: string; chapterNumber: string | null; position: number; page: string;
  contentType: PackageManifest['chapter']['contentType']; downloaded: number; repair: number;
}
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
async function metadataSnapshot(options: FolderIndexOptions, stage: string): Promise<{ rows: MetadataRow[] }> {
  if (!options.metadataDbPath) return { rows: [] };
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
    const rows = db.prepare(`SELECT n.id AS novelId,c.id AS chapterId,n.plugin_id AS pluginId,n.path AS novelPath,c.path AS chapterPath,
      n.name AS novelName,n.author,n.summary,n.is_local AS isLocal,c.name AS chapterName,c.chapter_number AS chapterNumber,
      c.position,c.page,coalesce(c.stored_content_type,c.content_type) AS contentType,c.is_downloaded AS downloaded,c.media_repair_needed AS repair
      FROM novel n JOIN chapter c ON c.novel_id=n.id`).all() as unknown as MetadataRow[];
    db.exec('COMMIT'); return { rows };
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
async function rawPackage(directory: string, row: MetadataRow, stage: string, options: FolderIndexOptions): Promise<PreparedPackage> {
  if (!row.downloaded || row.repair) fail('Chapter download is incomplete or needs media repair');
  if (!['html', 'text', 'markdown', 'pdf'].includes(row.contentType)) fail('Unsupported chapter content type');
  const inventory = await readdir(directory, { withFileTypes: true });
  const inventoryKey = async (path: string) => { await noLinks(path); const info = await lstat(path, { bigint: true }); return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${(await readdir(path)).sort().join('\0')}`; };
  const originalInventory = await inventoryKey(directory);
  if (inventory.some(entry => unfinished(entry.name))) fail('Unfinished chapter files are present');
  if (inventory.some(entry => entry.isSymbolicLink())) fail('Symbolic chapter files are unsupported');
  const bodyPath = row.contentType === 'pdf' ? 'content.pdf' : 'content.html';
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
    const portableNames = new Set<string>();
    for (const file of value.media.files) {
      const name = file.fileName;
      if (typeof name !== 'string' || !safeArchivePath(name) || !/^[A-Za-z0-9._-]+$/.test(name) || portableNames.has(name.toLowerCase()) || file.path !== `media/${name}` || file.status !== 'stored' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('Invalid or incomplete media manifest');
      portableNames.add(name.toLowerCase()); media.set(name, file.bytes); file.updatedAt = 0;
    }
    value.updatedAt = 0;
    await writeFile(join(portable, 'media-manifest.json'), canonicalize(value)); await record('media-manifest.json');
  }
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
  const zip = new ZipFile(); for (const file of records) zip.addFile(join(portable, file.path), file.path); zip.addBuffer(manifestBytes, 'manifest.json'); zip.end();
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
    let metadata: Awaited<ReturnType<typeof metadataSnapshot>> = { rows: [] }; let metadataError: string | undefined;
    try { metadata = await metadataSnapshot(options, stage); }
    catch (error) { aborted(options.signal); metadataError = `Metadata unavailable: ${(error as Error).message}`; }
    const directoryMetadata = new Map<string, DirectoryMetadata>();
    const contents = join(root, 'contents'); await noLinks(contents);
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
          prepared = { path: snapshot.destination, manifest: manifest!, snapshots: [snapshot] };
        } else {
          if (!row) fail(metadataError ?? 'Exact chapter identity metadata is missing; folder names cannot recover source paths');
          prepared = await rawPackage(path, row!, itemStage, options);
        }
        await verifySnapshot(prepared.snapshots, options.signal); await prepared.verifyInventory?.(); aborted(options.signal);
        const id = digest(JSON.stringify([prepared.manifest.identity.pluginId, prepared.manifest.identity.novelPath, prepared.manifest.identity.chapterPath]));
        const previous = options.db.prepare('SELECT revision FROM revisions WHERE chapter_id=? AND path IS NOT NULL').all(id) as { revision: string }[];
        const entry = await publishPackage(options.db, dataDir, createReadStream(prepared.path, { signal: options.signal }), options.limits);
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
      for (const entry of entries) {
        aborted(options.signal); const path = join(directory, entry.name);
        if (entry.isSymbolicLink() || unfinished(entry.name)) await report({ path, sourceId, status: 'skipped', reason: 'Symbolic or unfinished entry is unsupported' });
        else if (entry.isDirectory()) await walk(path, sourceId, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.zip') && entry.name !== 'media.zip') await process(path, sourceId);
        else await report({ path, sourceId, status: 'skipped', reason: 'Unsupported non-chapter file' });
      }
    };
    for (const source of await readdir(contents, { withFileTypes: true })) {
      aborted(options.signal); const path = join(contents, source.name);
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
