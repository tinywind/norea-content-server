import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticateDevice } from './auth.ts';
import { chapterIdentityId, canonicalChapterManifest } from './chapter-number-mappings.ts';
import { inspectChapterInventory } from './chapter-inventory.ts';
import { validateFiles, validateMedia } from './chapter-files.ts';
import { problem } from './db.ts';
import { availableChapter, chapterRow, chapterStoragePath, digest, publishChapter, uploadCursor, type CatalogEntry, type Limits, type PackageManifest } from './packages.ts';
import { readVerifiedRegularFile } from './secure-files.ts';
import { migrationCopyFence, type MigrationInventory } from './work-migrations.ts';

interface Reference { id: string; revision: string }
export interface MigrationCopyRequest {
  decision: 'copy-source';
  source: { revision: string; chapter: Reference };
  target: Reference & {
    chapter: { chapterPath: string; chapterNumber: string; position: number; name: string; page: string };
    expectedChapter: Reference | null;
  };
}
interface TargetRow { id: string; entry: string; path: string | null; directory: string; deleted_at: number | null }
const conflict = (message: string): never => { throw problem(409, 'Work migration copy: ' + message); };
function inventoryKey(value: MigrationInventory): string {
  return canonicalize({ ...value, expectedAssetKeys: value.expectedAssetKeys === null ? null : [...value.expectedAssetKeys].sort(),
    storedAssets: [...value.storedAssets].sort((left, right) => left.key.localeCompare(right.key)) });
}
function packageMetadata(manifest: PackageManifest): string {
  return canonicalize({ identity: manifest.identity, novel: manifest.novel, chapter: manifest.chapter, bodyPath: manifest.bodyPath });
}

async function performMigrationCopy(db: DatabaseSync, dataDir: string, sourceId: string, request: MigrationCopyRequest, limits: Limits, authorizeCommit?: () => void, beforePublishStage?: (stage: string) => Promise<void> | void): Promise<{ entry: CatalogEntry }> {
  if (request.decision !== 'copy-source' || sourceId === request.target.id) conflict('an explicit copy to a different work is required');
  const sourceRow = chapterRow(db, request.source.chapter.id);
  const source = sourceRow.catalog;
  if (source.deleted || source.revision !== request.source.chapter.revision || !sourceRow.path || !availableChapter(db, dataDir, source.id)) conflict('source chapter changed or is unavailable');
  const sourceWork = db.prepare('SELECT work_id FROM chapters WHERE id=?').get(source.id) as { work_id: string };
  if (sourceWork.work_id !== sourceId) conflict('source chapter belongs to another work');
  const requestedNumber = String(Number(request.target.chapter.chapterNumber));
  const targetRows = () => db.prepare("SELECT id,entry,path,directory,deleted_at FROM chapters WHERE work_id=? AND CAST(json_extract(entry,'$.manifest.chapter.chapterNumber') AS REAL)=CAST(? AS REAL) ORDER BY id")
    .all(request.target.id, requestedNumber) as unknown as TargetRow[];
  const initialTargets = targetRows();
  if (initialTargets.length > 1) conflict('target chapter number is ambiguous');
  const existing = initialTargets[0];
  if (existing?.deleted_at != null) conflict('the target chapter was explicitly deleted');
  const current = existing ? JSON.parse(existing.entry) as CatalogEntry : undefined;
  const fence = migrationCopyFence(db, dataDir, sourceId, request.source.revision, source.id, request.target.id, request.target.revision, existing?.id);
  const sourceIdentity = source.manifest.identity;
  if (sourceIdentity.pluginId !== fence.source.metadata.identity.pluginId || sourceIdentity.novelId !== fence.source.metadata.identity.novelId || sourceIdentity.novelPath !== fence.source.metadata.identity.novelPath || source.id !== chapterIdentityId(db, sourceIdentity)) conflict('source chapter identity differs from its work');
  const title = fence.target.metadata.chapters[requestedNumber];
  if (!title || title !== request.target.chapter.name) conflict('target chapter must match the current target catalog title and number');
  let chapterPath = request.target.chapter.chapterPath;
  if (current && current.manifest.identity.chapterPath !== chapterPath) {
    if (!current.manifest.identity.chapterPath.startsWith('norea-folder:')) conflict('target chapter has a different source path');
    // Retain an already indexed recovered folder alias; the normal exact-work
    // number lookup resolves the freshly parsed source path to this copy.
    chapterPath = current.manifest.identity.chapterPath;
  }
  const manifest = canonicalChapterManifest(db, {
    ...source.manifest, identity: { ...fence.target.metadata.identity, chapterPath },
    novel: { name: fence.target.metadata.novel.name, author: fence.target.metadata.novel.author, summary: fence.target.metadata.novel.summary, isLocal: false },
    chapter: { ...source.manifest.chapter, name: title, position: request.target.chapter.position, chapterNumber: requestedNumber, page: request.target.chapter.page },
  });
  validateFiles(manifest, limits);
  const targetId = chapterIdentityId(db, manifest.identity);
  if (existing && existing.id !== targetId) conflict('target identity differs from the current catalog');
  const exact = db.prepare('SELECT id,entry FROM chapters WHERE id=?').get(targetId) as { id: string; entry: string } | undefined;
  if (exact && (!existing || exact.entry !== existing.entry)) conflict('target path is already assigned to another chapter number');
  const expected = request.target.expectedChapter;
  if (expected && expected.id !== targetId) conflict('expected target belongs to another chapter');
  const initialState = JSON.stringify(initialTargets);
  const verify = () => {
    fence.verify();
    if (JSON.stringify(targetRows()) !== initialState) conflict('target chapter changed during the copy');
    authorizeCommit?.();
  };
  const startedAt = uploadCursor(db);
  const inspected = await inspectChapterInventory(db, dataDir, source.id, source.revision, limits);
  const inspectedBody = inspected.inventory.body;
  if (!inspectedBody || inspectedBody.bytes === 0) conflict('source body is not a verified nonempty copy');
  if (source.manifest.files.some(file => file.path === 'manifest.json' || file.path === 'media.zip') && inspected.inventory.expectedAssetKeys === null) conflict('source media declarations cannot be verified');
  if (current && availableChapter(db, dataDir, current.id)) {
    const targetInventory = await inspectChapterInventory(db, dataDir, current.id, current.revision, limits);
    if (packageMetadata(current.manifest) === packageMetadata(manifest) && inventoryKey(targetInventory.inventory) === inventoryKey(inspected.inventory)) {
      verify();
      return { entry: current };
    }
  }
  if (expected ? !current || current.id !== expected.id || current.revision !== expected.revision : !!current) conflict('target changed; an exact existing-copy revision is required before replacement');
  verify();
  const stage = join(dataDir, 'staging', 'migration-copy-' + randomUUID());
  try {
    await mkdir(stage, { recursive: true });
    for (const file of manifest.files) await copyFile(chapterStoragePath(dataDir, join(sourceRow.path!, file.path)), join(stage, file.path));
    await beforePublishStage?.(stage);
    const complete = await validateMedia(stage, manifest, limits);
    if (complete !== source.complete) conflict('copied stage completeness differs from the verified source chapter');
    const stagedBody = (await readVerifiedRegularFile(join(stage, manifest.bodyPath), limits.expandedBytes)).bytes;
    if (stagedBody.length !== inspectedBody!.bytes || digest(stagedBody) !== inspectedBody!.sha256) {
      conflict('copied stage body digest differs from the verified source inventory');
    }
    const entry: CatalogEntry = { id: targetId, revision: digest(canonicalize(manifest)), manifest, complete, deleted: false,
      fileBytes: manifest.files.reduce((total, file) => total + file.size, 0), sequence: 0 };
    // publishChapter performs the final guard under its existing write lock.
    // It handles atomic replacement and restoration; source files are untouched.
    const published = publishChapter(db, dataDir, stage, entry, startedAt, false, 'replace-server', verify);
    const verifiedPublished = await inspectChapterInventory(db, dataDir, published.id, published.revision, limits);
    if (inventoryKey(verifiedPublished.inventory) !== inventoryKey(inspected.inventory)) {
      throw problem(500, 'Published migration copy failed post-commit inventory verification');
    }
    return { entry: published };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function copyMigrationChapter(db: DatabaseSync, dataDir: string, sourceId: string, request: MigrationCopyRequest, limits: Limits, authorizeCommit?: () => void, beforePublishStage?: (stage: string) => Promise<void> | void): Promise<{ entry: CatalogEntry }> {
  try { return await performMigrationCopy(db, dataDir, sourceId, request, limits, authorizeCommit, beforePublishStage); }
  catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 404 || status === 410 || (error as NodeJS.ErrnoException).code === 'ENOENT') conflict('source or target changed or became unavailable');
    throw error;
  }
}

export function registerWorkMigrationCopy(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; limits: Limits; notify: () => void }): void {
  const { db, dataDir, limits, notify } = context;
  const hash = { type: 'string', pattern: '^[0-9a-f]{64}$' };
  const reference = { type: 'object', additionalProperties: false, required: ['id', 'revision'], properties: { id: hash, revision: hash } };
  app.post<{ Params: { id: string }; Body: MigrationCopyRequest }>('/api/v1/works/:id/migration-copy', {
    onRequest: async request => { authenticateDevice(db, request); },
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: hash } }, security: [{ bearerAuth: [] }],
      description: 'Stage one explicitly selected source chapter under the target identity without deleting the source. Requires current work and chapter revisions; replaces a different target only with its exact expected revision.',
      body: { type: 'object', additionalProperties: false, required: ['decision', 'source', 'target'], properties: {
        decision: { type: 'string', const: 'copy-source' },
        source: { type: 'object', additionalProperties: false, required: ['revision', 'chapter'], properties: { revision: hash, chapter: reference } },
        target: { type: 'object', additionalProperties: false, required: ['id', 'revision', 'chapter', 'expectedChapter'], properties: {
          id: hash, revision: hash, expectedChapter: { anyOf: [reference, { type: 'null' }] },
          chapter: { type: 'object', additionalProperties: false, required: ['chapterPath', 'chapterNumber', 'position', 'name', 'page'], properties: {
            chapterPath: { type: 'string', minLength: 1, maxLength: 4096 }, chapterNumber: { type: 'string', maxLength: 100, pattern: '^\\d+(?:\\.\\d+)?$' },
            position: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, name: { type: 'string', minLength: 1, maxLength: 4096 }, page: { type: 'string', maxLength: 4096 },
          } },
        } },
      } },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    request.raw.setTimeout?.(300000);
    const result = await copyMigrationChapter(db, dataDir, request.params.id, request.body, limits, () => { authenticateDevice(db, request); });
    notify(); return result;
  });
}
