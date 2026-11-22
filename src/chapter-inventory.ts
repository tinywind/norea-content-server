import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { chapterFileStream } from './chapter-files.ts';
import { chapterRow, type Limits, type PackageManifest } from './packages.ts';
import { problem } from './db.ts';
import {
  chapterPayloadHash,
  fingerprint,
  type Inventory,
  type InventoryInput,
  type InventoryResult,
} from './chapter-inventory-worker.ts';

export { chapterInventorySignature, chapterPayloadHash, type Inventory, type InventoryResult } from './chapter-inventory-worker.ts';

interface InventorySlot {
  worker: Worker;
  task?: { resolve: (result: InventoryResult) => void; reject: (error: Error) => void };
}
interface QueuedInventoryTask {
  input: InventoryInput;
  resolve: (result: InventoryResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}
const MAX_WORKERS = 4;
const MAX_WAITERS = 64;
const slots = new Set<InventorySlot>();
const waiters: QueuedInventoryTask[] = [];
const unavailable = () => problem(410, 'Chapter storage inventory is unavailable');

function dispatchNextWaiter(slot: InventorySlot): void {
  while (waiters.length > 0 && !slot.task) {
    const next = waiters.shift()!;
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    if (next.signal?.aborted) continue;
    startOnSlot(slot, next.input, next.resolve, next.reject);
  }
}

function startOnSlot(
  slot: InventorySlot,
  input: InventoryInput,
  resolve: (result: InventoryResult) => void,
  reject: (error: Error) => void,
): void {
  slot.task = { resolve, reject };
  slot.worker.ref();
  try {
    slot.worker.postMessage(input);
  } catch (error) {
    slot.task = undefined;
    slot.worker.unref();
    reject(error instanceof Error ? error : new Error(String(error)));
    dispatchNextWaiter(slot);
  }
}

function addWorker(): InventorySlot {
  const worker = new Worker(new URL('./chapter-inventory-worker.ts', import.meta.url), { workerData: { chapterInventory: true } });
  const slot: InventorySlot = { worker };
  slots.add(slot);
  const discard = () => {
    slots.delete(slot);
    slot.task?.reject(unavailable());
    slot.task = undefined;
    if (waiters.length > 0 && slots.size < MAX_WORKERS) {
      dispatchNextWaiter(addWorker());
    }
  };
  worker.on('error', discard);
  worker.on('exit', discard);
  worker.on('message', (message: { result?: InventoryResult }) => {
    const task = slot.task;
    slot.task = undefined;
    worker.unref();
    if (message.result) task?.resolve(message.result);
    else task?.reject(unavailable());
    dispatchNextWaiter(slot);
  });
  return slot;
}

function runInventory(input: InventoryInput, options?: { signal?: AbortSignal; queue?: boolean }): Promise<InventoryResult> {
  options?.signal?.throwIfAborted();
  const idle = [...slots].find(slot => !slot.task);
  if (idle || slots.size < MAX_WORKERS) {
    const slot = idle ?? addWorker();
    return new Promise((resolve, reject) => startOnSlot(slot, input, resolve, reject));
  }
  if (!options?.queue && waiters.length >= MAX_WAITERS) {
    throw problem(503, 'Chapter inventory is busy');
  }
  return new Promise((resolve, reject) => {
    const entry: QueuedInventoryTask = { input, resolve, reject, signal: options?.signal };
    if (options?.signal) {
      entry.onAbort = () => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        reject(options.signal!.reason instanceof Error ? options.signal!.reason : new Error('Aborted'));
      };
      options.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    waiters.push(entry);
  });
}

function fingerprintSync(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unavailable file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

export function chapterStorageSignatureSync(directory: string, manifest: PackageManifest): string {
  const has = (path: string) => manifest.files.some(file => file.path === path);
  const paths = [
    join(directory, manifest.bodyPath),
    ...(has('manifest.json') ? [join(directory, 'manifest.json')] : []),
    ...(has('media.zip') ? [join(directory, 'media.zip')] : []),
  ];
  return paths.map(fingerprintSync).join('|');
}

export function saveChapterInventoryDigest(
  db: DatabaseSync,
  params: { chapterId: string; revision: string; storageSignature: string; inventory: Inventory },
): void {
  if (!params.inventory.body) return;
  const payloadHash = chapterPayloadHash(params.inventory);
  db.prepare(`INSERT INTO chapter_inventory_digests(
    chapter_id, revision, storage_signature, body_sha256, body_bytes, payload_hash, inventory_json, updated_at
  ) VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(chapter_id) DO UPDATE SET
    revision=excluded.revision,
    storage_signature=excluded.storage_signature,
    body_sha256=excluded.body_sha256,
    body_bytes=excluded.body_bytes,
    payload_hash=excluded.payload_hash,
    inventory_json=excluded.inventory_json,
    updated_at=excluded.updated_at`).run(
    params.chapterId,
    params.revision,
    params.storageSignature,
    params.inventory.body.sha256,
    params.inventory.body.bytes,
    payloadHash,
    JSON.stringify(params.inventory),
    Date.now(),
  );
}

export function deleteChapterInventoryDigest(db: DatabaseSync, chapterId: string): void {
  db.prepare('DELETE FROM chapter_inventory_digests WHERE chapter_id=?').run(chapterId);
}

export function hasChapterInventoryDigest(db: DatabaseSync, chapterId: string, revision: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM chapter_inventory_digests WHERE chapter_id=? AND revision=?').get(chapterId, revision),
  );
}

export async function inspectStagedChapterInventory(
  directory: string,
  manifest: PackageManifest,
  limits: Limits,
  signal?: AbortSignal,
): Promise<Inventory | undefined> {
  signal?.throwIfAborted();
  const has = (path: string) => manifest.files.some(file => file.path === path);
  const input: InventoryInput = {
    body: join(directory, manifest.bodyPath),
    limits,
    ...(has('manifest.json') && { manifest: join(directory, 'manifest.json') }),
    ...(has('media.zip') && { archive: join(directory, 'media.zip') }),
  };
  try {
    const result = await runInventory(input, { signal, queue: true });
    return result.inventory.body ? result.inventory : undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

export async function inspectChapterInventory(
  db: DatabaseSync,
  dataDir: string,
  id: string,
  revision: string,
  limits: Limits,
  presenceOnly = false,
  options?: { signal?: AbortSignal; queue?: boolean },
) {
  options?.signal?.throwIfAborted();
  const row = chapterRow(db, id);
  if (row.catalog.deleted) throw problem(410, 'Chapter was deleted');
  if (row.catalog.revision !== revision) throw problem(404, 'Chapter copy not found');
  const body = chapterFileStream(db, dataDir, id, revision, row.catalog.manifest.bodyPath).path;
  const has = (path: string) => row.catalog.manifest.files.some(file => file.path === path);
  const input: InventoryInput = {
    body,
    limits,
    ...(!presenceOnly && has('manifest.json') && { manifest: chapterFileStream(db, dataDir, id, revision, 'manifest.json').path }),
    ...(!presenceOnly && has('media.zip') && { archive: chapterFileStream(db, dataDir, id, revision, 'media.zip').path }),
  };
  const paths = [input.body, input.manifest, input.archive].filter((value): value is string => !!value);
  const result = await runInventory(input, options);
  const current = chapterRow(db, id);
  if (current.catalog.deleted) throw problem(410, 'Chapter was deleted');
  if (current.catalog.revision !== revision || current.path !== row.path || current.entry !== row.entry) throw problem(404, 'Chapter copy changed during inspection');
  for (const file of row.catalog.manifest.files) {
    if (!presenceOnly || file.path === row.catalog.manifest.bodyPath) chapterFileStream(db, dataDir, id, revision, file.path);
  }
  let storageSignature = '';
  try {
    const fingerprints = await Promise.all(paths.map(fingerprint));
    if (fingerprints.some((value, index) => value !== result.fingerprints[index])) throw new Error('Files changed');
    storageSignature = fingerprints.join('|');
  } catch { throw problem(410, 'Chapter storage inventory changed during inspection'); }
  const finalRow = chapterRow(db, id);
  if (finalRow.catalog.deleted) throw problem(410, 'Chapter was deleted');
  if (finalRow.entry !== row.entry || finalRow.path !== row.path) throw problem(404, 'Chapter copy changed during inspection');
  if (!presenceOnly && result.inventory.body) {
    try {
      saveChapterInventoryDigest(db, { chapterId: id, revision, storageSignature, inventory: result.inventory });
    } catch { /* Ignore transient cache persistence races; inspection result remains valid. */ }
  }
  return { identity: row.catalog.manifest.identity, revision, inventory: result.inventory };
}

export interface ChapterDigestBackfillHandle {
  stop: () => Promise<void>;
}

/**
 * Lazily backfills precomputed digests for existing chapters that predate
 * `chapter_inventory_digests`, yielding between chapters and stopping cleanly
 * before database shutdown.
 */
export function startChapterDigestBackfill(
  db: DatabaseSync,
  dataDir: string,
  limits: Limits,
  delayMs = 500,
): ChapterDigestBackfillHandle {
  const controller = new AbortController();
  const attempted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;

  const run = async () => {
    try {
      while (!controller.signal.aborted) {
        const rows = db.prepare(`
          SELECT c.id, json_extract(c.entry, '$.revision') AS revision
          FROM chapters c
          LEFT JOIN chapter_inventory_digests d
            ON d.chapter_id = c.id AND d.revision = json_extract(c.entry, '$.revision')
          WHERE c.deleted_at IS NULL AND c.path IS NOT NULL AND d.chapter_id IS NULL
          LIMIT 50
        `).all() as { id: string; revision: string }[];
        const pending = rows.filter(row => row.revision && !attempted.has(`${row.id}:${row.revision}`));
        if (pending.length === 0) break;
        for (const row of pending) {
          if (controller.signal.aborted) return;
          attempted.add(`${row.id}:${row.revision}`);
          try {
            await inspectChapterInventory(db, dataDir, row.id, row.revision, limits, false, {
              signal: controller.signal,
              queue: true,
            });
          } catch {
            // Skip unreadable or concurrently updated chapters; subsequent scans/requests will revisit them.
          }
          if (controller.signal.aborted) return;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    } finally {
      running = null;
    }
  };

  timer = setTimeout(() => {
    timer = undefined;
    if (controller.signal.aborted) return;
    running = run();
  }, delayMs);
  timer.unref();

  return {
    async stop() {
      controller.abort();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (running) await running;
    },
  };
}
