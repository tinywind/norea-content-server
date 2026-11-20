import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { chapterFileStream } from './chapter-files.ts';
import { chapterRow, type Limits } from './packages.ts';
import { problem } from './db.ts';
import { fingerprint, type InventoryInput, type InventoryResult } from './chapter-inventory-worker.ts';

interface InventorySlot {
  worker: Worker;
  task?: { resolve: (result: InventoryResult) => void; reject: (error: Error) => void };
}
const slots = new Set<InventorySlot>();
const unavailable = () => problem(410, 'Chapter storage inventory is unavailable');

function addWorker(): InventorySlot {
  const worker = new Worker(new URL('./chapter-inventory-worker.ts', import.meta.url), { workerData: { chapterInventory: true } });
  const slot: InventorySlot = { worker };
  slots.add(slot);
  const discard = () => {
    slots.delete(slot);
    slot.task?.reject(unavailable());
    slot.task = undefined;
  };
  worker.on('error', discard);
  worker.on('exit', discard);
  worker.on('message', (message: { result?: InventoryResult }) => {
    const task = slot.task;
    slot.task = undefined;
    worker.unref();
    if (message.result) task?.resolve(message.result);
    else task?.reject(unavailable());
  });
  return slot;
}

function runInventory(input: InventoryInput): Promise<InventoryResult> {
  const idle = [...slots].find(slot => !slot.task);
  if (!idle && slots.size >= 4) throw problem(503, 'Chapter inventory is busy');
  const slot = idle ?? addWorker();
  return new Promise((resolve, reject) => {
    slot.task = { resolve, reject };
    slot.worker.ref();
    try { slot.worker.postMessage(input); }
    catch (error) {
      slot.task = undefined;
      slot.worker.unref();
      reject(error);
    }
  });
}

export async function inspectChapterInventory(db: DatabaseSync, dataDir: string, id: string, revision: string, limits: Limits, presenceOnly = false) {
  const row = chapterRow(db, id);
  if (row.catalog.deleted) throw problem(410, 'Chapter was deleted');
  if (row.catalog.revision !== revision) throw problem(404, 'Chapter copy not found');
  const body = chapterFileStream(db, dataDir, id, revision, row.catalog.manifest.bodyPath).path;
  const has = (path: string) => row.catalog.manifest.files.some(file => file.path === path);
  const input: InventoryInput = { body, limits, ...(!presenceOnly && has('manifest.json') && { manifest: chapterFileStream(db, dataDir, id, revision, 'manifest.json').path }), ...(!presenceOnly && has('media.zip') && { archive: chapterFileStream(db, dataDir, id, revision, 'media.zip').path }) };
  const result = await runInventory(input);
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
}
