import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import yauzl from 'yauzl';
import { canonicalize } from 'json-canonicalize';
import { digest, publishPackage, safeArchivePath, validateManifest, type Limits, type PackageManifest } from './packages.ts';
import { cacheWork, coverByteLimit, metadataByteLimit, metadataWorkId, readNovelMetadata, type NovelMetadataV1, type WorkEntry } from './works.ts';

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
interface MetadataRow {
  pluginId: string; novelPath: string; chapterPath: string;
  novelName: string; author: string | null; summary: string | null; isLocal: number;
  chapterName: string; chapterNumber: string | null; position: number; page: string;
  contentType: PackageManifest['chapter']['contentType'];
}
interface Snapshot { source: string; destination: string; size: number; sha256: string; signature: string }
interface PreparedPackage { path: string; manifest: PackageManifest; snapshots: Snapshot[]; verifyInventory?: () => Promise<void> }
const unfinished = (name: string) => name.startsWith('.') || /(?:\.tmp|\.bak|\.part|\.partial|\.norea-sync-backup)$/i.test(name);
const fail = (message: string): never => { throw new Error(message); };
const segment = (value: string | null, fallback: string) => { const result = (value?.trim() || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96); return !result || result === '.' || result === '..' ? fallback : result; };
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
  const inventory = await readdir(directory, { withFileTypes: true });
  const inventoryKey = async (path: string) => { await noLinks(path); const info = await lstat(path, { bigint: true }); return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${(await readdir(path)).sort().join('\0')}`; };
  const originalInventory = await inventoryKey(directory);
  if (inventory.some(entry => unfinished(entry.name))) fail('Unfinished chapter files are present');
  if (inventory.some(entry => entry.isSymbolicLink())) fail('Symbolic chapter files are unsupported');
  const bodies = inventory.filter(entry => entry.isFile() && ['content.html', 'content.pdf'].includes(entry.name));
  if (bodies.length !== 1) fail('Chapter must contain exactly one supported body file');
  const bodyPath = bodies[0].name;
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
  const dataDir = resolve(options.dataDir);
  await noLinks(dataDir);
  if (!(await lstat(dataDir)).isDirectory()) fail('Server storage must be a directory');
  await noLinks(join(dataDir, 'staging'));
  await mkdir(join(dataDir, 'staging'), { recursive: true });
  const stage = await mkdtemp(join(dataDir, 'staging', 'folder-'));
  const report = async (item: FolderIndexItem) => { summary.scanned++; summary[item.status]++; await options.onItem?.(item); };
  try {
    const contents = join(dataDir, 'contents'); await noLinks(contents); await mkdir(contents, { recursive: true });
    const publishedPath = options.db.prepare('SELECT chapter_id,revision FROM revisions WHERE path=?');
    const checkpoint = (path: string) => options.db.prepare('SELECT signature,entry FROM scan_checkpoints WHERE path=?').get(path) as { signature: string; entry: string } | undefined;
    const remember = (path: string, key: string, item: FolderIndexItem) => options.db.prepare('INSERT INTO scan_checkpoints(path,signature,entry) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET signature=excluded.signature,entry=excluded.entry').run(path, key, JSON.stringify(item));
    const inventorySignature = async (path: string): Promise<string> => {
      await noLinks(path);
      const info = await lstat(path, { bigint: true });
      if (info.isFile()) return signature(path);
      if (!info.isDirectory()) fail('Expected a regular source file or directory');
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const parts: string[] = [];
      for (const entry of entries) {
        aborted(options.signal);
        const child = join(path, entry.name);
        if (publishedPath.get(relative(dataDir, child))) continue;
        if (entry.isSymbolicLink()) fail('Symbolic chapter files are unsupported');
        parts.push(entry.name, await inventorySignature(child));
      }
      return JSON.stringify(parts);
    };
    const process = async (path: string, sourceFolder: string, row: MetadataRow) => {
      let sourceId = row.pluginId;
      aborted(options.signal); const itemStage = await mkdtemp(join(stage, 'chapter-'));
      try {
        const chapterMetadata = { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath, chapterName: row.chapterName, chapterNumber: row.chapterNumber, position: row.position, page: row.page, contentType: row.contentType };
        const before = canonicalize([chapterMetadata, await inventorySignature(path)]);
        const saved = checkpoint(path);
        if (saved?.signature === before) {
          const item = JSON.parse(saved.entry) as FolderIndexItem;
          const revision = options.db.prepare('SELECT r.path,c.deleted_at,r.deleted FROM revisions r JOIN chapters c ON c.id=r.chapter_id WHERE r.chapter_id=? AND r.revision=?').get(item.chapterId!, item.revision!) as { path: string | null; deleted_at: number | null; deleted: number } | undefined;
          if (revision?.deleted_at != null || revision?.deleted) fail('Content was deleted; an administrator must restore it');
          if (revision?.path) {
            try {
              if ((await lstat(join(dataDir, revision.path))).isFile()) { await report({ ...item, status: 'unchanged' }); return; }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
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
          if (manifest!.identity.pluginId !== row.pluginId || manifest!.identity.novelPath !== row.novelPath) fail('Package work identity differs from novel.json');
          prepared = { path: snapshot.destination, manifest: manifest!, snapshots: [snapshot] };
        } else {
          prepared = await rawPackage(path, row, itemStage, options);
        }
        await verifySnapshot(prepared.snapshots, options.signal); await prepared.verifyInventory?.(); aborted(options.signal);
        const id = digest(JSON.stringify([prepared.manifest.identity.pluginId, prepared.manifest.identity.novelPath, prepared.manifest.identity.chapterPath]));
        const previous = options.db.prepare("SELECT json_extract(entry,'$.revision') AS revision FROM chapters WHERE id=?").get(id) as { revision: string } | undefined;
        // Open the abortable file only after the publisher has attached stream error handling.
        const input = Readable.from((async function* () { yield* createReadStream(prepared.path, { signal: options.signal }); })());
        const entry = await publishPackage(options.db, dataDir, input, options.limits, true);
        const item: FolderIndexItem = { path, sourceId, status: previous?.revision === entry.revision ? 'unchanged' : 'registered', chapterId: entry.id, revision: entry.revision };
        if (before === canonicalize([chapterMetadata, await inventorySignature(path)])) remember(path, before, item);
        await report(item);
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
          const metadataPath = join(directory, 'novel.json');
          const workSignature = async (metadata: NovelMetadataV1) => {
            let cover: string | null = null;
            if (metadata.cover) {
              try { cover = await signature(join(directory, metadata.cover.fileName)); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            return canonicalize([await signature(metadataPath), metadata.cover?.fileName ?? null, cover]);
          };
          const saved = checkpoint(metadataPath);
          const cached = options.db.prepare('SELECT entry FROM works WHERE directory=?').get(relative(dataDir, directory)) as { entry: string } | undefined;
          const stored = cached ? JSON.parse(cached.entry) as WorkEntry : undefined;
          if (saved && stored && saved.signature === await workSignature(stored.metadata)) {
            value = stored.metadata;
            await report({ ...JSON.parse(saved.entry) as FolderIndexItem, status: 'unchanged' });
          } else {
            const file = await snapshotFile(metadataPath, join(workStage, 'novel.json'), metadataByteLimit, options.signal);
            value = readNovelMetadata(file.destination);
            if (segment(value.identity.pluginId, 'source') !== sourceId) fail('Work metadata source does not match its folder');
            const before = await workSignature(value);
            const snapshots = [file];
            if (value.cover && entries.some(entry => entry.name === value.cover!.fileName)) snapshots.push(await snapshotFile(join(directory, value.cover.fileName), join(workStage, value.cover.fileName), coverByteLimit, options.signal));
            await verifySnapshot(snapshots, options.signal); aborted(options.signal);
            const id = metadataWorkId(value);
            const previous = options.db.prepare('SELECT entry FROM works WHERE id=?').get(id) as { entry: string } | undefined;
            const work = cacheWork(options.db, dataDir, relative(dataDir, directory), value);
            if (!previous || JSON.parse(previous.entry).sequence !== work.sequence) options.onWorkChange?.();
            const item: FolderIndexItem = { path: metadataPath, sourceId: value.identity.pluginId, workId: id, status: previous && JSON.parse(previous.entry).sequence === work.sequence ? 'unchanged' : 'registered' };
            if (before === await workSignature(value)) remember(metadataPath, before, item);
            await report(item);
          }
        } catch (error) {
          aborted(options.signal);
          await report({ path: join(directory, 'novel.json'), sourceId, status: 'skipped', reason: (error as Error).message });
          return;
        } finally { await rm(workStage, { recursive: true, force: true }); }
        const folders = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || unfinished(entry.name)) continue;
          const path = join(directory, entry.name);
          const files = await readdir(path, { withFileTypes: true });
          const onlyPublished = files.length > 0 && files.every(file => (file.isFile() || file.isDirectory()) && publishedPath.get(relative(dataDir, join(path, file.name))));
          if (onlyPublished) {
            for (const file of files) {
              const row = publishedPath.get(relative(dataDir, join(path, file.name))) as { chapter_id: string; revision: string };
              await report({ path: join(path, file.name), sourceId, status: 'unchanged', chapterId: row.chapter_id, revision: row.revision });
            }
          } else folders.push(entry);
        }
        folders.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
        const numbers = new Map<string, number>();
        for (const folder of folders) {
          const number = folder.name.match(/^(\d+(?:\.\d+)?)-(.+)$/)?.[1];
          if (number) numbers.set(number, (numbers.get(number) ?? 0) + 1);
        }
        for (const folder of folders) {
          const path = join(directory, folder.name); const parts = folder.name.match(/^(\d+(?:\.\d+)?)-(.+)$/);
          if (!parts || numbers.get(parts[1]) !== 1) { await report({ path, sourceId, status: 'skipped', reason: 'Chapter folder must have a unique number followed by a hyphen and title' }); continue; }
          const files = await readdir(path, { withFileTypes: true });
          const row: MetadataRow = { ...value.identity, chapterPath: `norea-folder:${parts[1]}`, novelName: value.novel.name, author: value.novel.author, summary: value.novel.summary, isLocal: value.novel.isLocal ? 1 : 0, chapterName: parts[2], chapterNumber: parts[1], position: Number(parts[1]), page: '1', contentType: files.some(file => file.name === 'content.pdf') ? 'pdf' : 'html' };
          const packages = files.filter(file => file.isFile() && file.name.endsWith('.zip') && file.name !== 'media.zip' && !unfinished(file.name));
          if (files.some(file => /^content\./.test(file.name)) || packages.length === 0) await process(path, sourceId, row);
          else if (packages.length === 1) await process(join(path, packages[0].name), sourceId, row);
          else await report({ path, sourceId, status: 'skipped', reason: 'Multiple chapter packages are ambiguous' });
        }
        return;
      }
      if (depth === 1) { await report({ path: directory, sourceId, status: 'skipped', reason: 'Valid novel.json is required; work identity cannot be inferred' }); return; }
      const visitEntry = async (entry: (typeof entries)[number]) => {
        aborted(options.signal); const path = join(directory, entry.name);
        if (entry.isFile() && (entry.name === '.nomedia' || (depth === 1 && /^cover\.(?:json|avif|bmp|gif|jpg|jpeg|png|svg|webp|img)$/.test(entry.name)))) return;
        if (entry.isSymbolicLink() || unfinished(entry.name)) await report({ path, sourceId, status: 'skipped', reason: 'Symbolic or unfinished entry is unsupported' });
        else if (entry.isDirectory()) await walk(path, sourceId, depth + 1);
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
        await walk(path, source.name, 0);
      }
    }
  } catch (error) { if (options.signal?.aborted) summary.cancelled = true; else throw error; }
  finally { await rm(stage, { recursive: true, force: true }); }
  return summary;
}
