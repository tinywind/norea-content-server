import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';
import yauzl from 'yauzl';
import { safeArchivePath } from './archive-path.ts';
import type { Limits } from './packages.ts';
import { openVerifiedRegularFileSync, readVerifiedRegularFile } from './secure-files.ts';

type Asset = { key: string; sha256: string; bytes: number };
type Inventory = { body: { sha256: string; bytes: number } | null; expectedAssetKeys: string[] | null; storedAssets: Asset[] };
export type InventoryInput = { body: string; manifest?: string; archive?: string; limits: Limits };
export type InventoryResult = { inventory: Inventory; fingerprints: string[] };

export async function fingerprint(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unavailable file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

async function inspect(input: InventoryInput): Promise<InventoryResult> {
  const paths = [input.body, input.manifest, input.archive].filter((value): value is string => !!value);
  const before = await Promise.all(paths.map(fingerprint));
  const bodyHash = createHash('sha256');
  let bodyBytes = 0;
  const bodyFile = openVerifiedRegularFileSync(input.body, input.limits.expandedBytes);
  try {
    for await (const chunk of createReadStream('', { fd: bodyFile.descriptor, autoClose: false })) {
      const bytes = Buffer.from(chunk); bodyBytes += bytes.length;
      if (bodyBytes > input.limits.expandedBytes) throw new Error('Body exceeds limit');
      bodyHash.update(bytes);
    }
    bodyFile.verify();
  } finally { bodyFile.close(); }
  let expectedAssetKeys: string[] | null = null;
  if (input.manifest) {
    const text = (await readVerifiedRegularFile(input.manifest, 16 * 1024 ** 2)).bytes.toString('utf8');
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
    const archiveFile = openVerifiedRegularFileSync(input.archive, input.limits.zipBytes);
    let zip: yauzl.ZipFile | undefined;
    try {
      const openedZip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromFd(archiveFile.descriptor, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value!)));
      zip = openedZip;
      await new Promise<void>((resolve, reject) => {
        const names = new Set<string>(); let expanded = 0;
        openedZip.on('error', reject);
        openedZip.on('end', resolve);
        openedZip.on('entry', (entry: yauzl.Entry) => {
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          const directory = entry.fileName.endsWith('/') || type === 0x4000 || (entry.externalFileAttributes & 0x10) !== 0;
          const name = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
          if (!safeArchivePath(name) || names.has(name.toLowerCase()) || (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) || (entry.generalPurposeBitFlag & 1)) { reject(new Error('Unsafe archive')); return; }
          names.add(name.toLowerCase()); expanded += entry.uncompressedSize;
          if (names.size > input.limits.files || expanded + bodyBytes > input.limits.expandedBytes) { reject(new Error('Archive exceeds limits')); return; }
          if (directory || !/^[A-Za-z0-9._-]+$/.test(name) || entry.uncompressedSize <= 0 || entry.uncompressedSize > 256 * 1024 ** 2) { openedZip.readEntry(); return; }
          openedZip.openReadStream(entry, (error, stream) => {
            if (error || !stream) { openedZip.readEntry(); return; }
            const hash = createHash('sha256'); let size = 0; let checksum = 0; let failed = false;
            stream.on('data', (chunk: Buffer) => { size += chunk.length; hash.update(chunk); checksum = crc32(chunk, checksum); });
            stream.on('error', () => { failed = true; openedZip.readEntry(); });
            stream.on('end', () => {
              if (!failed && size === entry.uncompressedSize && checksum === entry.crc32) storedAssets.push({ key: `media/${name}`, sha256: hash.digest('hex'), bytes: size });
              openedZip.readEntry();
            });
          });
        });
        openedZip.readEntry();
      });
      archiveFile.verify();
    } finally {
      if (zip) zip.close();
      else archiveFile.close();
    }
  }
  const after = await Promise.all(paths.map(fingerprint));
  if (before.some((value, index) => value !== after[index])) throw new Error('Files changed during inspection');
  storedAssets.sort((a, b) => a.key.localeCompare(b.key));
  return { inventory: { body: { sha256: bodyHash.digest('hex'), bytes: bodyBytes }, expectedAssetKeys, storedAssets }, fingerprints: after };
}

if (workerData?.chapterInventory) parentPort?.on('message', (input: InventoryInput) => {
  void inspect(input).then(
    result => parentPort!.postMessage({ result }),
    () => parentPort!.postMessage({ error: true }),
  );
});
