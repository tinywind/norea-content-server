import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import type { DatabaseSync } from 'node:sqlite';
import { chapterFileStream } from './chapter-files.ts';
import { problem } from './db.ts';
import { chapterRow, safeArchivePath, type Limits } from './packages.ts';

interface DeclaredMediaFile {
  fileName: string;
  path: string;
  sourceUrl: string;
  bytes: number;
}

export async function readChapterMediaAsset(
  db: DatabaseSync, dataDir: string, id: string, revision: string,
  fileName: string, sourceUrl: string, limits: Limits,
): Promise<Buffer> {
  if (!safeArchivePath(fileName)) throw problem(400, 'Invalid chapter media asset name');
  const manifestFile = chapterFileStream(db, dataDir, id, revision, 'manifest.json');
  if (manifestFile.file.size > 16 * 1024 ** 2) throw problem(413, 'Media manifest exceeds the byte limit');
  let files: DeclaredMediaFile[];
  try {
    const manifest = JSON.parse(await readFile(manifestFile.path, 'utf8'));
    if (manifest?.version !== 1 || !Array.isArray(manifest.media?.files)) throw new Error('Invalid manifest');
    files = manifest.media.files;
  } catch { throw problem(410, 'Chapter media manifest is unavailable'); }
  if (files.length > limits.files) throw problem(413, 'Media file count limit exceeded');
  const names = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.fileName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(file.fileName)
      || !safeArchivePath(file.fileName) || names.has(file.fileName.toLowerCase())
      || file.path !== `media/${file.fileName}`) throw problem(410, 'Chapter media manifest is invalid');
    names.add(file.fileName.toLowerCase());
  }
  const declared = files.find(file => file.fileName === fileName && file.sourceUrl === sourceUrl);
  if (!declared) throw problem(404, 'Chapter media asset not found');
  if (!Number.isSafeInteger(declared.bytes) || declared.bytes < 0) throw problem(410, 'Chapter media asset size is invalid');
  const archiveFile = chapterFileStream(db, dataDir, id, revision, 'media.zip');
  if (archiveFile.file.size > limits.zipBytes) throw problem(413, 'Media archive exceeds the byte limit');
  const archive = await new Promise<yauzl.ZipFile>((accept, reject) => {
    yauzl.open(archiveFile.path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => error ? reject(problem(410, 'Chapter media archive is unavailable')) : accept(zip!));
  });
  try {
    const target = await new Promise<yauzl.Entry>((accept, reject) => {
      let selected: yauzl.Entry | undefined;
      let expanded = 0;
      const entries = new Set<string>();
      archive.on('error', () => reject(problem(410, 'Chapter media archive is invalid')));
      archive.once('end', () => selected ? accept(selected) : reject(problem(404, 'Chapter media asset not found')));
      archive.on('entry', (entry: yauzl.Entry) => {
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        const directory = entry.fileName.endsWith('/') || type === 0x4000 || (entry.externalFileAttributes & 0x10) !== 0;
        const name = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
        if (!safeArchivePath(name) || entries.has(name.toLowerCase())
          || (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) || (entry.generalPurposeBitFlag & 1)) {
          reject(problem(410, 'Chapter media archive contains an unsafe entry')); return;
        }
        entries.add(name.toLowerCase());
        expanded += entry.uncompressedSize;
        if (entries.size > limits.files || expanded > limits.expandedBytes) {
          reject(problem(413, 'Chapter media archive exceeds its limits')); return;
        }
        if (!directory && entry.fileName === fileName) selected = entry;
        archive.readEntry();
      });
      archive.readEntry();
    });
    if (target.uncompressedSize <= 0 || target.uncompressedSize > Math.min(limits.expandedBytes, 256 * 1024 ** 2)
      || (declared.bytes > 0 && declared.bytes !== target.uncompressedSize)) {
      throw problem(410, 'Chapter media asset size is invalid');
    }
    const stream = await new Promise<NodeJS.ReadableStream>((accept, reject) => {
      archive.openReadStream(target, (error, input) => error ? reject(problem(410, 'Chapter media asset is unreadable')) : accept(input!));
    });
    const body = Buffer.allocUnsafe(target.uncompressedSize);
    let bytes = 0;
    let checksum = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > body.length) throw new Error('Asset exceeds its declared size');
        buffer.copy(body, bytes - buffer.length);
        checksum = crc32(buffer, checksum);
      }
    } catch { throw problem(410, 'Chapter media asset is corrupt'); }
    if (bytes !== body.length || checksum !== target.crc32) throw problem(410, 'Chapter media asset is corrupt');
    if (chapterRow(db, id).catalog.revision !== revision) throw problem(404, 'Chapter copy changed during media retrieval');
    return body;
  } finally { archive.close(); }
}
