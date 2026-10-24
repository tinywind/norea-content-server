import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Multipart } from '@fastify/multipart';
import { canonicalize } from 'json-canonicalize';
import yauzl from 'yauzl';
import { problem } from './db.ts';
import { chapterRow, chapterStoragePath, digest, publishChapter, safeArchivePath, uploadCursor, validateManifest, type CatalogEntry, type ChapterConflictPolicy, type Limits, type PackageManifest } from './packages.ts';

export function validateFiles(value: unknown, limits: Limits): asserts value is PackageManifest {
  validateManifest(value);
  const body = value.chapter.contentType === 'pdf' ? 'content.pdf' : 'content.html';
  if (value.layout !== 'chapter-files' || value.bodyPath !== body || value.files.length > 3) throw problem(400, 'Unsupported chapter file layout');
  if (value.files.length > limits.files) throw problem(413, 'Chapter file count limit exceeded');
  let bytes = 0;
  for (const file of value.files) {
    if (![body, 'manifest.json', 'media.zip'].includes(file.path)) throw problem(400, 'Unexpected chapter file');
    const limit = file.path === 'media.zip' ? limits.zipBytes : file.path === 'manifest.json' ? 16 * 1024 ** 2 : limits.expandedBytes;
    bytes += file.size;
    if (file.size > limit || bytes > limits.expandedBytes) throw problem(413, 'Chapter file size limit exceeded');
  }
  if (value.files.some(file => file.path === 'media.zip') && !value.files.some(file => file.path === 'manifest.json')) throw problem(400, 'Media manifest is missing');
}

export async function validateMedia(directory: string, manifest: PackageManifest, limits: Limits, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!manifest.files.some(file => file.path === 'manifest.json')) return true;
  let media: { version?: number; media?: { files?: { fileName: string; path: string }[] } };
  try { media = JSON.parse(await readFile(join(directory, 'manifest.json'), { encoding: 'utf8', signal })); }
  catch { signal?.throwIfAborted(); throw problem(400, 'Invalid media manifest JSON'); }
  if (media?.version !== 1 || !Array.isArray(media.media?.files)) throw problem(400, 'Invalid chapter media manifest');
  if (media.media.files.length > limits.files) throw problem(413, 'Media file count limit exceeded');
  const expected = new Set<string>();
  const names = new Set<string>();
  let expanded = manifest.files.filter(file => file.path !== 'media.zip').reduce((sum, file) => sum + file.size, 0);
  for (const file of media.media.files) {
    signal?.throwIfAborted();
    const name = file?.fileName;
    if (typeof name !== 'string' || !safeArchivePath(name) || !/^[A-Za-z0-9._-]+$/.test(name) || names.has(name.toLowerCase()) || (file.path !== '' && file.path !== `media/${name}`)) throw problem(400, 'Invalid media manifest');
    names.add(name.toLowerCase()); expected.add(name);
  }
  if (!manifest.files.some(file => file.path === 'media.zip')) return expected.size === 0;
  const zip = await new Promise<yauzl.ZipFile>((accept, reject) => yauzl.open(join(directory, 'media.zip'), { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(problem(400, 'Invalid chapter media archive')) : accept(value!)));
  const found = new Set<string>();
  const entries = new Set<string>();
  try {
    await new Promise<void>((accept, reject) => {
      zip.on('error', () => reject(problem(400, 'Invalid chapter media archive')));
      zip.on('end', accept);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        const directory = entry.fileName.endsWith('/') || type === 0x4000 || (entry.externalFileAttributes & 0x10) !== 0;
        const name = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
        if (!safeArchivePath(name) || entries.has(name.toLowerCase()) || (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) || (entry.generalPurposeBitFlag & 1)) {
          reject(problem(400, 'Unsafe or duplicate media archive entry')); return;
        }
        entries.add(name.toLowerCase());
        if (entries.size > limits.files) { reject(problem(413, 'Media file count limit exceeded')); return; }
        expanded += entry.uncompressedSize;
        if (expanded > limits.expandedBytes) { reject(problem(413, 'Expanded media limit exceeded')); return; }
        if (!directory) found.add(entry.fileName);
        zip.readEntry();
      });
      zip.readEntry();
    });
    return [...expected].every(name => found.has(name));
  } finally { zip.close(); }
}

export async function publishChapterFiles(db: DatabaseSync, dataDir: string, parts: AsyncIterableIterator<Multipart>, limits: Limits, conflictPolicy: ChapterConflictPolicy = 'prefer-complete'): Promise<CatalogEntry> {
  const startedAt = uploadCursor(db);
  const stage = join(dataDir, 'staging', `files-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  let manifest: PackageManifest | undefined;
  const received = new Set<string>();
  try {
    for await (const part of parts) {
      if (part.type === 'field') {
        if (manifest || part.fieldname !== 'metadata' || part.valueTruncated || typeof part.value !== 'string') throw problem(400, 'One metadata field must precede chapter files');
        let parsed: unknown;
        try { parsed = JSON.parse(part.value); } catch { throw problem(400, 'Invalid chapter metadata JSON'); }
        validateFiles(parsed, limits);
        manifest = parsed;
        continue;
      }
      const declared = manifest?.files.find(file => file.path === part.fieldname);
      if (!declared || received.has(part.fieldname) || part.filename !== declared.path) {
        part.file.resume();
        throw problem(400, 'Unexpected or duplicate chapter file');
      }
      if (part.file.destroyed) throw problem(400, 'Chapter upload was interrupted');
      let bytes = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > declared.size) return done(problem(400, 'Chapter file exceeds its declared size'));
        done(null, chunk);
      } });
      await pipeline(part.file, meter, createWriteStream(join(stage, declared.path), { flags: 'wx' }));
      if (part.file.truncated || bytes !== declared.size) throw problem(400, 'Chapter file size mismatch');
      received.add(declared.path);
    }
    if (!manifest || received.size !== manifest.files.length) throw problem(400, 'Chapter files are incomplete');
    const complete = await validateMedia(stage, manifest, limits);
    const id = digest(JSON.stringify([manifest.identity.pluginId, manifest.identity.novelPath, manifest.identity.chapterPath]));
    const entry: CatalogEntry = { id, revision: digest(canonicalize(manifest)), manifest, complete, fileBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), deleted: false, sequence: 0 };
    return publishChapter(db, dataDir, stage, entry, startedAt, false, conflictPolicy);
  } catch (error) {
    if (error instanceof Error && /unexpected end|premature close/i.test(error.message)) throw problem(400, 'Chapter upload was interrupted');
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export function chapterFileStream(db: DatabaseSync, dataDir: string, id: string, revisionId: string, path: string) {
  const chapter = chapterRow(db, id);
  const entry = chapter.catalog;
  if (entry.deleted) throw problem(410, 'Chapter was deleted');
  if (entry.revision !== revisionId) throw problem(404, 'Chapter copy not found');
  const file = entry.manifest.files.find(file => file.path === path);
  if (!file) throw problem(404, 'Chapter file not found');
  if (!chapter.path) throw problem(410, 'Chapter file is unavailable');
  const target = chapterStoragePath(dataDir, join(chapter.path, file.path));
  if (!existsSync(target)) throw problem(410, 'Chapter file is unavailable');
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw problem(410, 'Chapter file is unavailable');
  return { file, path: target, open: () => createReadStream(target) };
}
