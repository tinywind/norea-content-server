import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync } from 'node:fs';
import { open, readdir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { authenticateDevice } from './auth.ts';
import { problem } from './db.ts';

export const DEVICE_BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120000;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f-]{36}$/;

export interface DeviceBackupMetadata {
  deviceName: string;
  updatedAt: number;
  size: number;
  sha256: string;
}
interface StoredBackup extends DeviceBackupMetadata { revision: string }

function deviceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) throw problem(400, 'A device name of 1–200 characters is required');
  return name;
}
const slotKey = (name: string) => createHash('sha256').update(name).digest('hex');
const metadata = ({ deviceName, updatedAt, size, sha256 }: StoredBackup): DeviceBackupMetadata => ({ deviceName, updatedAt, size, sha256 });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Invalid device backup storage directory');
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function openRegular(path: string): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw problem(500, 'Invalid device backup file');
    return file;
  } catch (error) { await file.close(); throw error; }
}

/** One latest pointer per device name. The opaque archive and pointer are never edited in place. */
export class DeviceBackupStore {
  private readonly slots: string;
  private readonly blobs: string;
  private readonly staging: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(dataDir: string, options: { maxBytes?: number; timeoutMs?: number } = {}) {
    const root = join(dataDir, 'device-backups');
    this.slots = join(root, 'slots');
    this.blobs = join(root, 'blobs');
    this.staging = join(root, 'staging');
    this.maxBytes = options.maxBytes ?? DEVICE_BACKUP_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
    for (const path of [root, this.slots, this.blobs, this.staging]) privateDirectory(path);
  }

  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(key) === queued) this.locks.delete(key); }
  }

  private blobPath(key: string, stored: StoredBackup): string {
    return join(this.blobs, `${key}.${stored.revision}.zip`);
  }

  private async readSlot(key: string): Promise<StoredBackup | null> {
    let file: FileHandle;
    try { file = await openRegular(join(this.slots, `${key}.json`)); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      if ((await file.stat()).size > 4096) throw problem(500, 'Invalid device backup metadata');
      const value = JSON.parse(await file.readFile('utf8')) as StoredBackup;
      if (typeof value.deviceName !== 'string' || value.deviceName !== deviceName(value.deviceName) || slotKey(value.deviceName) !== key
        || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > this.maxBytes
        || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256) || typeof value.revision !== 'string' || !REVISION.test(value.revision)) {
        throw problem(500, 'Invalid device backup metadata');
      }
      return value;
    } catch { throw problem(500, 'Invalid device backup metadata'); }
    finally { await file.close(); }
  }

  async list(): Promise<DeviceBackupMetadata[]> {
    const items: DeviceBackupMetadata[] = [];
    for (const file of await readdir(this.slots)) {
      if (!/^[0-9a-f]{64}\.json$/.test(file)) continue;
      const item = await this.locked(file.slice(0, 64), () => this.readSlot(file.slice(0, 64)));
      if (item) items.push(metadata(item));
    }
    return items.sort((left, right) => left.deviceName.localeCompare(right.deviceName));
  }

  async get(name: string, expectedSha256?: string): Promise<{ metadata: DeviceBackupMetadata; body: Readable }> {
    const key = slotKey(deviceName(name));
    return this.locked(key, async () => {
      const stored = await this.readSlot(key);
      if (!stored) throw problem(404, 'No backup exists for this device');
      if (expectedSha256 !== undefined && stored.sha256 !== expectedSha256) throw problem(409, 'The device backup changed; refresh the backup list');
      let file: FileHandle;
      try { file = await openRegular(this.blobPath(key, stored)); }
      catch { throw problem(410, 'The device backup file is unavailable'); }
      if ((await file.stat()).size !== stored.size) { await file.close(); throw problem(410, 'The device backup file is incomplete'); }
      // The opened descriptor stays valid if a later upload unlinks the old revision.
      return { metadata: metadata(stored), body: file.createReadStream() };
    });
  }

  async put(name: string, source: Readable, expectedSha256: string, options: { contentLength?: number; beforePublish?: () => void } = {}): Promise<DeviceBackupMetadata> {
    name = deviceName(name);
    if (!SHA256.test(expectedSha256)) throw problem(400, 'X-Backup-Sha256 must contain the archive SHA-256');
    if (options.contentLength !== undefined && (!Number.isSafeInteger(options.contentLength) || options.contentLength < 1)) throw problem(400, 'A nonempty backup archive is required');
    if (options.contentLength !== undefined && options.contentLength > this.maxBytes) throw problem(413, 'Device backup exceeds the 512 MiB limit');
    if (!(source instanceof Readable)) throw problem(400, 'A nonempty backup archive is required');
    const key = slotKey(name);
    const revision = randomUUID();
    const stage = join(this.staging, `${revision}.tmp`);
    const pointerStage = join(this.staging, `${revision}.json`);
    const blob = join(this.blobs, `${key}.${revision}.zip`);
    let file: FileHandle | undefined;
    let published = false;
    let size = 0;
    const hash = createHash('sha256');
    const timer = setTimeout(() => source.destroy(problem(408, 'Device backup upload timed out')), this.timeoutMs);
    timer.unref();
    try {
      file = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > this.maxBytes) throw problem(413, 'Device backup exceeds the 512 MiB limit');
        hash.update(bytes);
        for (let offset = 0; offset < bytes.length;) {
          const written = await file.write(bytes, offset, bytes.length - offset);
          if (!written.bytesWritten) throw problem(500, 'Could not write the device backup');
          offset += written.bytesWritten;
        }
      }
      clearTimeout(timer);
      if (!size) throw problem(400, 'A nonempty backup archive is required');
      if (options.contentLength !== undefined && size !== options.contentLength) throw problem(400, 'Device backup length does not match Content-Length');
      const sha256 = hash.digest('hex');
      if (sha256 !== expectedSha256) throw problem(400, 'Device backup SHA-256 does not match');
      await file.sync();
      await file.close();
      file = undefined;
      return await this.locked(key, async () => {
        const previous = await this.readSlot(key);
        const stored: StoredBackup = { deviceName: name, updatedAt: Date.now(), size, sha256, revision };
        await rename(stage, blob);
        await syncDirectory(this.blobs);
        const pointer = await open(pointerStage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await pointer.writeFile(JSON.stringify(stored)); await pointer.sync(); } finally { await pointer.close(); }
        options.beforePublish?.();
        await rename(pointerStage, join(this.slots, `${key}.json`));
        published = true;
        await syncDirectory(this.slots);
        if (previous) await rm(this.blobPath(key, previous), { force: true }).catch(() => {});
        return metadata(stored);
      });
    } finally {
      clearTimeout(timer);
      await file?.close();
      await rm(stage, { force: true });
      await rm(pointerStage, { force: true });
      if (!published) await rm(blob, { force: true });
    }
  }
}

const metadataSchema = {
  type: 'object', required: ['deviceName', 'updatedAt', 'size', 'sha256'], additionalProperties: false,
  properties: { deviceName: { type: 'string' }, updatedAt: { type: 'integer' }, size: { type: 'integer' }, sha256: { type: 'string' } },
};
const paramsSchema = { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 } } };

export async function registerDeviceBackups(app: FastifyInstance, db: DatabaseSync, dataDir: string): Promise<void> {
  const store = new DeviceBackupStore(dataDir);
  await app.register(async scoped => {
    // Other APIs may inherit a buffered parser; override it only in this child
    // context so backup streams bypass the normal JSON-sized body buffer.
    if (scoped.hasContentTypeParser('application/octet-stream')) scoped.removeContentTypeParser('application/octet-stream');
    scoped.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    scoped.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      authenticateDevice(db, request);
    });
    scoped.get('/api/v1/device-backups', { schema: {
      security: [{ bearerAuth: [] }], response: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: metadataSchema } } } },
    } }, async () => ({ items: await store.list() }));
    scoped.put<{ Params: { name: string }; Body: Readable }>('/api/v1/device-backups/:name', {
      bodyLimit: DEVICE_BACKUP_MAX_BYTES,
      onRequest: async request => {
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream') throw problem(415, 'application/octet-stream is required');
        if (Number(request.headers['content-length']) > DEVICE_BACKUP_MAX_BYTES) throw problem(413, 'Device backup exceeds the 512 MiB limit');
      },
      schema: {
        security: [{ bearerAuth: [] }], consumes: ['application/octet-stream'], params: paramsSchema,
        headers: { type: 'object', required: ['x-backup-sha256'], properties: { 'x-backup-sha256': { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
        response: { 200: metadataSchema },
        description: 'Store an opaque full-device backup archive under the device name. The latest completed upload atomically replaces that name; body maximum is 512 MiB. All registered, unblocked devices can list and restore these backups.',
      },
    }, async request => store.put(request.params.name, request.body, request.headers['x-backup-sha256'] as string, {
      contentLength: request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']),
      beforePublish: () => authenticateDevice(db, request),
    }));
    scoped.get<{ Params: { name: string }; Querystring: { sha256?: string } }>('/api/v1/device-backups/:name', { schema: {
      security: [{ bearerAuth: [] }], params: paramsSchema,
      querystring: { type: 'object', additionalProperties: false, properties: { sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    } }, async (request, reply) => {
      const saved = await store.get(request.params.name, request.query.sha256);
      return reply.header('Content-Length', saved.metadata.size).header('X-Backup-Sha256', saved.metadata.sha256)
        .header('ETag', `"${saved.metadata.sha256}"`).header('X-Content-Type-Options', 'nosniff')
        .type('application/octet-stream').send(saved.body);
    });
  });
}
