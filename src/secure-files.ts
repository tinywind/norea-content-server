import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

export interface RegularFileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

function snapshot(stat: Stats): RegularFileSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    mode: stat.mode,
  };
}

export function regularFileSignature(value: RegularFileSnapshot): string {
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode].join(':');
}

function sameSnapshot(left: RegularFileSnapshot, right: RegularFileSnapshot): boolean {
  return regularFileSignature(left) === regularFileSignature(right);
}

function validateRegularFile(stat: Stats, limit: number): RegularFileSnapshot {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a non-symbolic regular file');
  if (stat.size > limit) throw new Error('Regular file exceeds byte limit');
  return snapshot(stat);
}

function openFlags(): number {
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

export interface VerifiedRegularFile {
  handle: FileHandle;
  snapshot: RegularFileSnapshot;
  verify(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Acquire the inode first, verify that the pathname still resolves to it, and
 * retain that descriptor for all I/O. A pathname replacement can therefore only
 * make the operation fail; it cannot redirect the read to the replacement.
 */
export async function openVerifiedRegularFile(path: string, limit = Number.MAX_SAFE_INTEGER): Promise<VerifiedRegularFile> {
  const handle = await open(path, openFlags());
  try {
    const opened = validateRegularFile(await handle.stat(), limit);
    const linked = validateRegularFile(await lstat(path), limit);
    if (!sameSnapshot(opened, linked)) throw new Error('Regular file changed while opening');
    let closed = false;
    return {
      handle,
      snapshot: opened,
      async verify() {
        if (closed) throw new Error('Regular file descriptor was closed during reading');
        const after = validateRegularFile(await handle.stat(), limit);
        const pathAfter = validateRegularFile(await lstat(path), limit);
        if (!sameSnapshot(opened, after) || !sameSnapshot(opened, pathAfter))
          throw new Error('Regular file changed while reading');
      },
      async close() {
        if (closed) return;
        closed = true;
        try { await handle.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readVerifiedRegularFile(path: string, limit: number): Promise<{ bytes: Buffer; snapshot: RegularFileSnapshot }> {
  const opened = await openVerifiedRegularFile(path, limit);
  try {
    const bytes = await opened.handle.readFile();
    if (bytes.length > limit) throw new Error('Regular file exceeds byte limit');
    await opened.verify();
    return { bytes, snapshot: opened.snapshot };
  } finally {
    await opened.close();
  }
}

export interface VerifiedRegularFileSync {
  descriptor: number;
  snapshot: RegularFileSnapshot;
  verify(): void;
  close(): void;
}

export function openVerifiedRegularFileSync(path: string, limit = Number.MAX_SAFE_INTEGER): VerifiedRegularFileSync {
  const descriptor = openSync(path, openFlags());
  try {
    const opened = validateRegularFile(fstatSync(descriptor), limit);
    const linked = validateRegularFile(lstatSync(path), limit);
    if (!sameSnapshot(opened, linked)) throw new Error('Regular file changed while opening');
    let closed = false;
    return {
      descriptor,
      snapshot: opened,
      verify() {
        if (closed) throw new Error('Regular file descriptor was closed during reading');
        const after = validateRegularFile(fstatSync(descriptor), limit);
        const pathAfter = validateRegularFile(lstatSync(path), limit);
        if (!sameSnapshot(opened, after) || !sameSnapshot(opened, pathAfter))
          throw new Error('Regular file changed while reading');
      },
      close() {
        if (closed) return;
        closed = true;
        try { closeSync(descriptor); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
      },
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function readVerifiedRegularFileSync(path: string, limit: number): { bytes: Buffer; snapshot: RegularFileSnapshot } {
  const opened = openVerifiedRegularFileSync(path, limit);
  try {
    const bytes = readFileSync(opened.descriptor);
    if (bytes.length > limit) throw new Error('Regular file exceeds byte limit');
    opened.verify();
    return { bytes, snapshot: opened.snapshot };
  } finally { opened.close(); }
}
