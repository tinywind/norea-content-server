import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import yauzl from 'yauzl';
import { problem } from './db.ts';
import { chapterFileStream } from './chapter-files.ts';
import { chapterRow, safeArchivePath, type Limits } from './packages.ts';
import type { DatabaseSync } from 'node:sqlite';

type Asset = { key: string; sha256: string; bytes: number };
type Inventory = { body: { sha256: string; bytes: number } | null; expectedAssetKeys: string[] | null; storedAssets: Asset[] };
type Input = { body: string; manifest?: string; archive?: string; limits: Limits };
let activeWorkers = 0;

async function fingerprint(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unavailable file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

async function inspect(input: Input): Promise<{ inventory: Inventory; fingerprints: string[] }> {
  const paths = [input.body, input.manifest, input.archive].filter((value): value is string => !!value);
  const before = await Promise.all(paths.map(fingerprint));
  const bodyHash = createHash('sha256');
  let bodyBytes = 0;
  for await (const chunk of createReadStream(input.body)) {
    const bytes = Buffer.from(chunk); bodyBytes += bytes.length;
    if (bodyBytes > input.limits.expandedBytes) throw new Error('Body exceeds limit');
    bodyHash.update(bytes);
  }
  let expectedAssetKeys: string[] | null = null;
  if (input.manifest) {
    const stat = await lstat(input.manifest);
    if (stat.size > 16 * 1024 ** 2) throw new Error('Manifest exceeds limit');
    const text = await readFile(input.manifest, 'utf8');
    try {
      const manifest = JSON.parse(text);
      if (manifest?.version !== 1 || typeof manifest.complete !== 'boolean' || !Number.isSafeInteger(manifest.updatedAt) || manifest.updatedAt < 0 || !Array.isArray(manifest.media?.files) || manifest.media.files.length > input.limits.files) throw new Error('Invalid manifest');
      const names = new Set<string>(); const urls = new Set<string>();
      for (const file of manifest.media.files) {
        const name = file?.fileName;
        if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.') || name.toLowerCase().endsWith('.part') || !safeArchivePath(name) || names.has(name.toLowerCase()) || (file.path !== '' && file.path !== `media/${name}`) || typeof file.sourceUrl !== 'string' || urls.has(file.sourceUrl) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isSafeInteger(file.updatedAt) || file.updatedAt < 0 || (file.status !== 'stored' && file.status !== 'remote')) throw new Error('Invalid manifest');
        names.add(name.toLowerCase()); urls.add(file.sourceUrl);
      }
      expectedAssetKeys = manifest.media.files.map((file: { fileName: string }) => `media/${file.fileName}`).sort();
    } catch { expectedAssetKeys = null; }
  }
  const storedAssets: Asset[] = [];
  if (input.archive) {
    if ((await lstat(input.archive)).size > input.limits.zipBytes) throw new Error('Archive exceeds limit');
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(input.archive!, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value!)));
    try {
      await new Promise<void>((resolve, reject) => {
        const names = new Set<string>(); let expanded = 0;
        zip.on('error', reject);
        zip.on('end', resolve);
        zip.on('entry', (entry: yauzl.Entry) => {
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          const directory = entry.fileName.endsWith('/') || type === 0x4000 || (entry.externalFileAttributes & 0x10) !== 0;
          const name = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
          if (!safeArchivePath(name) || names.has(name.toLowerCase()) || (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) || (entry.generalPurposeBitFlag & 1)) { reject(new Error('Unsafe archive')); return; }
          names.add(name.toLowerCase()); expanded += entry.uncompressedSize;
          if (names.size > input.limits.files || expanded + bodyBytes > input.limits.expandedBytes) { reject(new Error('Archive exceeds limits')); return; }
          if (directory || !/^[A-Za-z0-9._-]+$/.test(name) || entry.uncompressedSize <= 0 || entry.uncompressedSize > 256 * 1024 ** 2) { zip.readEntry(); return; }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) { zip.readEntry(); return; }
            const hash = createHash('sha256'); let size = 0; let checksum = 0; let failed = false;
            stream.on('data', (chunk: Buffer) => { size += chunk.length; hash.update(chunk); checksum = crc32(chunk, checksum); });
            stream.on('error', () => { failed = true; zip.readEntry(); });
            stream.on('end', () => {
              if (!failed && size === entry.uncompressedSize && checksum === entry.crc32) storedAssets.push({ key: `media/${name}`, sha256: hash.digest('hex'), bytes: size });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      });
    } finally { zip.close(); }
  }
  const after = await Promise.all(paths.map(fingerprint));
  if (before.some((value, index) => value !== after[index])) throw new Error('Files changed during inspection');
  storedAssets.sort((a, b) => a.key.localeCompare(b.key));
  return { inventory: { body: { sha256: bodyHash.digest('hex'), bytes: bodyBytes }, expectedAssetKeys, storedAssets }, fingerprints: after };
}

if (!isMainThread && workerData?.chapterInventory) {
  inspect(workerData.input).then(result => parentPort!.postMessage({ result }), () => parentPort!.postMessage({ error: true }));
}

export async function inspectChapterInventory(db: DatabaseSync, dataDir: string, id: string, revision: string, limits: Limits, presenceOnly = false) {
  const row = chapterRow(db, id);
  if (row.catalog.deleted) throw problem(410, 'Chapter was deleted');
  if (row.catalog.revision !== revision) throw problem(404, 'Chapter copy not found');
  const body = chapterFileStream(db, dataDir, id, revision, row.catalog.manifest.bodyPath).path;
  const has = (path: string) => row.catalog.manifest.files.some(file => file.path === path);
  const input: Input = { body, limits, ...(!presenceOnly && has('manifest.json') && { manifest: chapterFileStream(db, dataDir, id, revision, 'manifest.json').path }), ...(!presenceOnly && has('media.zip') && { archive: chapterFileStream(db, dataDir, id, revision, 'media.zip').path }) };
  if (activeWorkers >= 4) throw problem(503, 'Chapter inventory is busy');
  activeWorkers++;
  try {
    const result = await new Promise<{ inventory: Inventory; fingerprints: string[] }>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { chapterInventory: true, input } });
      worker.once('message', result => result.error ? reject(problem(410, 'Chapter storage inventory is unavailable')) : resolve(result.result));
      worker.once('error', () => reject(problem(410, 'Chapter storage inventory is unavailable')));
      worker.once('exit', code => { if (code !== 0) reject(problem(410, 'Chapter storage inventory is unavailable')); });
    });
    const current = chapterRow(db, id);
    if (current.catalog.deleted) throw problem(410, 'Chapter was deleted');
    if (current.catalog.revision !== revision || current.path !== row.path || current.entry !== row.entry) throw problem(404, 'Chapter copy changed during inspection');
    for (const file of row.catalog.manifest.files) {
      if (!presenceOnly || file.path === row.catalog.manifest.bodyPath) chapterFileStream(db, dataDir, id, revision, file.path);
    }
    try {
      const paths = [input.body, input.manifest, input.archive].filter((value): value is string => !!value);
      const fingerprints = await Promise.all(paths.map(fingerprint));
      if (fingerprints.some((value, index) => value !== result.fingerprints[index])) throw new Error('Files changed');
    } catch { throw problem(410, 'Chapter storage inventory changed during inspection'); }
    const finalRow = chapterRow(db, id);
    if (finalRow.catalog.deleted) throw problem(410, 'Chapter was deleted');
    if (finalRow.entry !== row.entry || finalRow.path !== row.path) throw problem(404, 'Chapter copy changed during inspection');
    return { identity: row.catalog.manifest.identity, revision, inventory: result.inventory };
  } finally { activeWorkers--; }
}
