import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize } from 'json-canonicalize';
import { canonicalChapterManifest, chapterIdentityId } from './chapter-number-mappings.ts';
import { inspectChapterInventory } from './chapter-inventory.ts';
import { chapterFileStream, validateFiles, validateMedia } from './chapter-files.ts';
import { openDatabase, problem } from './db.ts';
import { availableChapter, defaultLimits, digest, publishChapter, uploadCursor, type CatalogEntry, type Limits, type PackageManifest } from './packages.ts';
import { readVerifiedRegularFile } from './secure-files.ts';
import { readWorkMigration, type MigrationLineageChapterDecision } from './work-migration-lineage.ts';
import type { MigrationInventory } from './work-migrations.ts';
import { getWork } from './works.ts';

export interface RecoveredMigrationChapterRecord {
  chapterNumber: string;
  position: number;
  sourceChapterId: string;
  sourceChapterPath: string;
  targetChapterId: string;
  targetChapterPath: string;
  targetRevision: string;
  sequence: number;
  sha256: string;
  bytes: number;
  status: 'published' | 'already-recovered';
}

export interface WorkMigrationRecoveryReport {
  operationId: string;
  sourceWorkId: string;
  targetWorkId: string;
  recoveredAt: string;
  totalCandidates: number;
  publishedCount: number;
  alreadyRecoveredCount: number;
  chapters: RecoveredMigrationChapterRecord[];
}

export interface RecoverDiscardedMigrationOptions {
  db: DatabaseSync;
  dataDir: string;
  backupDbPath: string;
  backupSourceDir: string;
  stagingRoot: string;
  operationId: string;
  expectedChapterCount?: number;
  limits?: Limits;
}

function normalizedNumber(value: string | null | undefined): string | null {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : null;
}

function inventoryKey(value: MigrationInventory): string {
  return canonicalize({
    body: value.body,
    expectedAssetKeys: value.expectedAssetKeys === null ? null : [...value.expectedAssetKeys].sort(),
    storedAssets: [...value.storedAssets].sort((left, right) => left.key.localeCompare(right.key)),
  });
}

function packageMetadataKey(manifest: PackageManifest): string {
  return canonicalize({
    identity: manifest.identity,
    novel: manifest.novel,
    chapter: manifest.chapter,
    bodyPath: manifest.bodyPath,
  });
}

function matchDecision(
  decisions: readonly MigrationLineageChapterDecision[],
  sourceChapterPath: string,
  sourceChapterNumber: string | null,
): MigrationLineageChapterDecision {
  const exact = decisions.filter(decision => decision.sourceChapterPath === sourceChapterPath);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw problem(409, 'Recovery aborted: duplicate source chapter path in lineage decisions');
  const key = normalizedNumber(sourceChapterNumber);
  if (key === null || !sourceChapterPath.startsWith('norea-folder:')) {
    throw problem(409, `Recovery aborted: no lineage decision found for source chapter ${sourceChapterPath}`);
  }
  const byNumber = decisions.filter(decision => normalizedNumber(decision.sourceChapterNumber) === key);
  if (byNumber.length !== 1) throw problem(409, `Recovery aborted: ambiguous lineage decision for source chapter number ${key}`);
  return byNumber[0];
}

async function streamDigest(open: () => NodeJS.ReadableStream): Promise<{ sha256: string; bytes: number }> {
  const chunks: Buffer[] = [];
  for await (const chunk of open()) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const combined = Buffer.concat(chunks);
  return { sha256: digest(combined), bytes: combined.length };
}

function dbTableChecksum(db: DatabaseSync, sql: string, ...params: (string | number)[]): string {
  return digest(JSON.stringify(db.prepare(sql).all(...params)));
}

function userStateChecksum(db: DatabaseSync): string {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_state_current_records'").get();
  if (!exists) return 'none';
  return dbTableChecksum(db, 'SELECT entity_key,kind,item FROM user_state_current_records ORDER BY entity_key');
}

/**
 * Auditably restores server-stored source chapters that were discarded during a
 * completed migration into their already-mapped target chapters via publishChapter.
 * Never revives the tombstoned source work or mutates immutable migration receipts.
 */
export async function recoverDiscardedMigrationChapters(
  options: RecoverDiscardedMigrationOptions,
): Promise<WorkMigrationRecoveryReport> {
  const limits = options.limits ?? defaultLimits;
  const { db, dataDir, operationId } = options;
  const lineage = readWorkMigration(db, operationId);
  if (!lineage.active || !lineage.fullDecisionCoverage) {
    throw problem(409, 'Recovery requires an active migration with full chapter decision coverage');
  }
  const sourceWorkId = lineage.sourceWork.id;
  const targetWorkId = lineage.targetWork.id;
  const sourceTombstoneBefore = db.prepare('SELECT deleted,sequence FROM work_tombstones WHERE work_id=?').get(sourceWorkId) as { deleted: number; sequence: number } | undefined;
  if (!sourceTombstoneBefore?.deleted || db.prepare('SELECT 1 FROM works WHERE id=?').get(sourceWorkId)) {
    throw problem(409, 'Recovery requires the migrated source work to remain tombstoned and absent from active works');
  }

  const receiptBefore = dbTableChecksum(db, 'SELECT operation_id,source_work_id,request_hash,result FROM work_migrations WHERE operation_id=?', operationId);
  const lineageBefore = dbTableChecksum(db, 'SELECT operation_id,source_work_id,target_work_id,entry FROM work_migration_lineage WHERE operation_id=?', operationId);
  const eventsBefore = dbTableChecksum(db, 'SELECT sequence,operation_id,active FROM work_migration_events WHERE operation_id=? ORDER BY sequence', operationId);
  const targetWorkRowBefore = dbTableChecksum(db, 'SELECT id,entry,directory,fingerprint FROM works WHERE id=?', targetWorkId);
  const userStateBefore = userStateChecksum(db);

  const targetWork = getWork(db, dataDir, targetWorkId);
  if (targetWork.deleted) throw problem(409, 'Target work is deleted');

  const discardedMappings = lineage.mappings.filter(mapping => mapping.decision === 'delete-source');
  if (options.expectedChapterCount !== undefined && discardedMappings.length !== options.expectedChapterCount) {
    throw problem(409, `Expected ${options.expectedChapterCount} discarded source mappings, found ${discardedMappings.length}`);
  }

  const composition = (targetWork.metadata as {
    chapterComposition?: {
      entries?: {
        path: string;
        storageChapterNumber: string;
        primarySource: number;
        sources: { page?: string }[];
        user: { included: boolean; order: number };
      }[];
    };
  }).chapterComposition;
  const includedCompositionByPath = new Map(
    (composition?.entries ?? []).filter(entry => entry.user.included).map(entry => [entry.path, entry]),
  );
  const sortedNumbers = Object.keys(targetWork.metadata.chapters).sort((left, right) => Number(left) - Number(right));
  const defaultPositionByNumber = new Map(sortedNumbers.map((num, index) => [String(Number(num)), index + 1]));

  const backupDb = new DatabaseSync(resolve(options.backupDbPath), { readOnly: true });
  await mkdir(options.stagingRoot, { recursive: true });
  const runStageRoot = join(options.stagingRoot, `recovery-${operationId}-${randomUUID()}`);
  await mkdir(runStageRoot, { recursive: true });

  try {
    const backupRows = backupDb.prepare('SELECT id,entry,directory,path FROM chapters WHERE work_id=? AND deleted_at IS NULL').all(sourceWorkId) as {
      id: string;
      entry: string;
      directory: string;
      path: string | null;
    }[];
    const backupById = new Map(backupRows.map(row => [row.id, { ...row, catalog: JSON.parse(row.entry) as CatalogEntry }]));
    if (options.expectedChapterCount !== undefined && backupById.size !== options.expectedChapterCount) {
      throw problem(409, `Expected ${options.expectedChapterCount} live chapters in backup DB, found ${backupById.size}`);
    }

    interface PlannedChapter {
      sourceId: string;
      sourcePath: string;
      backupCatalog: CatalogEntry;
      backupFolderName: string;
      targetNumber: string;
      targetPath: string;
      targetPosition: number;
      targetManifest: PackageManifest;
      targetChapterId: string;
    }
    const planned: PlannedChapter[] = [];
    const seenTargetIds = new Set<string>();
    const seenTargetNumbers = new Set<string>();

    for (const mapping of discardedMappings) {
      const backup = backupById.get(mapping.source.id);
      if (!backup || backup.catalog.deleted || !backup.catalog.complete || backup.catalog.revision !== mapping.source.revision) {
        throw problem(409, `Backup chapter ${mapping.source.id} is missing, incomplete, or does not match the lineage source revision`);
      }
      const decision = matchDecision(lineage.chapterDecisions, mapping.source.chapterPath, mapping.source.chapterNumber);
      if (!decision.discardSourceContent || decision.targetChapterPath === null || decision.targetChapterNumber === null) {
        throw problem(409, `Source chapter ${mapping.source.chapterPath} was not a mapped discardSourceContent chapter`);
      }
      const targetNumber = normalizedNumber(decision.targetChapterNumber);
      if (!targetNumber) throw problem(409, `Invalid target chapter number for ${decision.targetChapterPath}`);
      const targetTitle = targetWork.metadata.chapters[targetNumber];
      if (!targetTitle) throw problem(409, `Target work metadata is missing chapter number ${targetNumber}`);
      const composed = includedCompositionByPath.get(decision.targetChapterPath);
      if (composition && (!composed || normalizedNumber(composed.storageChapterNumber) !== targetNumber)) {
        throw problem(409, `Target chapterComposition does not match ${decision.targetChapterPath} (#${targetNumber})`);
      }
      const targetPosition = composed ? composed.user.order : defaultPositionByNumber.get(targetNumber) ?? backup.catalog.manifest.chapter.position;
      const targetPage = composed?.sources[composed.primarySource]?.page ?? backup.catalog.manifest.chapter.page;
      const targetManifest = canonicalChapterManifest(db, {
        ...backup.catalog.manifest,
        identity: { ...targetWork.metadata.identity, chapterPath: decision.targetChapterPath },
        novel: {
          name: targetWork.metadata.novel.name,
          author: targetWork.metadata.novel.author,
          summary: targetWork.metadata.novel.summary,
          isLocal: false,
        },
        chapter: {
          ...backup.catalog.manifest.chapter,
          name: targetTitle,
          position: targetPosition,
          chapterNumber: targetNumber,
          page: targetPage,
        },
      });
      validateFiles(targetManifest, limits);
      const targetChapterId = chapterIdentityId(db, targetManifest.identity);
      if (seenTargetIds.has(targetChapterId) || seenTargetNumbers.has(targetNumber)) {
        throw problem(409, `Duplicate recovery target detected for chapter #${targetNumber}`);
      }
      seenTargetIds.add(targetChapterId);
      seenTargetNumbers.add(targetNumber);
      const backupFolderName = basename((backup.path ?? backup.directory).replaceAll('\\', '/'));
      planned.push({
        sourceId: mapping.source.id,
        sourcePath: mapping.source.chapterPath,
        backupCatalog: backup.catalog,
        backupFolderName,
        targetNumber,
        targetPath: decision.targetChapterPath,
        targetPosition,
        targetManifest,
        targetChapterId,
      });
    }

    planned.sort((left, right) => Number(left.targetNumber) - Number(right.targetNumber));

    // Pre-flight check all backup files and existing target chapters before publishing any row.
    const stagedPlans: (PlannedChapter & {
      stageDir: string;
      backupBodySha256: string;
      backupBodyBytes: number;
      alreadyRecovered?: CatalogEntry;
    })[] = [];

    for (const item of planned) {
      const sourceChapterDir = join(resolve(options.backupSourceDir), item.backupFolderName);
      const stageDir = join(runStageRoot, `chapter-${item.targetNumber}-${randomUUID()}`);
      await mkdir(stageDir, { recursive: true });
      for (const file of item.targetManifest.files) {
        const backupFilePath = join(sourceChapterDir, file.path);
        const backupRead = await readVerifiedRegularFile(backupFilePath, limits.expandedBytes);
        if (backupRead.bytes.length !== file.size) {
          throw problem(409, `Backup file size mismatch at ${backupFilePath}: expected ${file.size}, got ${backupRead.bytes.length}`);
        }
        await copyFile(backupFilePath, join(stageDir, file.path));
      }
      const complete = await validateMedia(stageDir, item.targetManifest, limits);
      if (!complete) throw problem(409, `Backup media validation failed for chapter #${item.targetNumber}`);
      const stagedBodyBytes = (await readVerifiedRegularFile(join(stageDir, item.targetManifest.bodyPath), limits.expandedBytes)).bytes;
      const backupBodyBytes = (await readVerifiedRegularFile(join(sourceChapterDir, item.targetManifest.bodyPath), limits.expandedBytes)).bytes;
      const backupBodySha256 = digest(backupBodyBytes);
      if (stagedBodyBytes.length !== backupBodyBytes.length || digest(stagedBodyBytes) !== backupBodySha256) {
        throw problem(409, `Staged copy SHA-256 mismatch for chapter #${item.targetNumber}`);
      }

      const existingByNumber = db.prepare(
        "SELECT id,entry,deleted_at FROM chapters WHERE work_id=? AND CAST(json_extract(entry,'$.manifest.chapter.chapterNumber') AS REAL)=CAST(? AS REAL)",
      ).all(targetWorkId, item.targetNumber) as { id: string; entry: string; deleted_at: number | null }[];
      if (existingByNumber.length > 1) {
        throw problem(409, `Target work already has ambiguous chapter rows for #${item.targetNumber}`);
      }
      const existingById = db.prepare('SELECT id,entry,deleted_at FROM chapters WHERE id=?').get(item.targetChapterId) as { id: string; entry: string; deleted_at: number | null } | undefined;
      const existing = existingById ?? existingByNumber[0];
      let alreadyRecovered: CatalogEntry | undefined;
      if (existing) {
        if (existing.deleted_at !== null || existing.id !== item.targetChapterId) {
          throw problem(409, `Target chapter #${item.targetNumber} has a conflicting or tombstoned row (${existing.id})`);
        }
        const available = availableChapter(db, dataDir, existing.id);
        if (!available || !available.complete) {
          throw problem(409, `Target chapter #${item.targetNumber} exists in DB without complete verified files`);
        }
        const inspectedExisting = await inspectChapterInventory(db, dataDir, available.id, available.revision, limits);
        if (
          !inspectedExisting.inventory.body ||
          inspectedExisting.inventory.body.sha256 !== backupBodySha256 ||
          inspectedExisting.inventory.body.bytes !== backupBodyBytes.length ||
          packageMetadataKey(available.manifest) !== packageMetadataKey(item.targetManifest)
        ) {
          throw problem(409, `Target chapter #${item.targetNumber} already contains different content; refusing to overwrite`);
        }
        alreadyRecovered = available;
      }

      stagedPlans.push({
        ...item,
        stageDir,
        backupBodySha256,
        backupBodyBytes: backupBodyBytes.length,
        ...(alreadyRecovered ? { alreadyRecovered } : {}),
      });
    }

    const chapters: RecoveredMigrationChapterRecord[] = [];
    let publishedCount = 0;
    let alreadyRecoveredCount = 0;

    for (const item of stagedPlans) {
      let resultEntry: CatalogEntry;
      let status: 'published' | 'already-recovered';
      if (item.alreadyRecovered) {
        resultEntry = item.alreadyRecovered;
        status = 'already-recovered';
        alreadyRecoveredCount += 1;
      } else {
        const entry: CatalogEntry = {
          id: item.targetChapterId,
          revision: digest(canonicalize(item.targetManifest)),
          manifest: item.targetManifest,
          complete: true,
          deleted: false,
          fileBytes: item.targetManifest.files.reduce((sum, file) => sum + file.size, 0),
          sequence: 0,
        };
        resultEntry = publishChapter(db, dataDir, item.stageDir, entry, uploadCursor(db), false, 'prefer-complete');
        status = 'published';
        publishedCount += 1;
      }

      const available = availableChapter(db, dataDir, resultEntry.id);
      if (!available || !available.complete || available.deleted) {
        throw problem(500, `Recovered chapter #${item.targetNumber} is not available after publication`);
      }
      const inspected = await inspectChapterInventory(db, dataDir, available.id, available.revision, limits);
      if (!inspected.inventory.body || inspected.inventory.body.sha256 !== item.backupBodySha256 || inspected.inventory.body.bytes !== item.backupBodyBytes) {
        throw problem(500, `Recovered chapter #${item.targetNumber} inventory SHA-256 mismatch`);
      }
      const streamed = await streamDigest(chapterFileStream(db, dataDir, available.id, available.revision, available.manifest.bodyPath).open);
      if (streamed.sha256 !== item.backupBodySha256 || streamed.bytes !== item.backupBodyBytes) {
        throw problem(500, `Recovered chapter #${item.targetNumber} download stream SHA-256 mismatch`);
      }
      if (inventoryKey(inspected.inventory) !== inventoryKey({
        body: { sha256: item.backupBodySha256, bytes: item.backupBodyBytes },
        expectedAssetKeys: item.targetManifest.files.some(file => file.path === 'manifest.json') ? inspected.inventory.expectedAssetKeys : null,
        storedAssets: inspected.inventory.storedAssets,
      })) {
        throw problem(500, `Recovered chapter #${item.targetNumber} asset inventory verification failed`);
      }

      chapters.push({
        chapterNumber: item.targetNumber,
        position: item.targetPosition,
        sourceChapterId: item.sourceId,
        sourceChapterPath: item.sourcePath,
        targetChapterId: available.id,
        targetChapterPath: item.targetPath,
        targetRevision: available.revision,
        sequence: available.sequence,
        sha256: item.backupBodySha256,
        bytes: item.backupBodyBytes,
        status,
      });
    }

    const sourceTombstoneAfter = db.prepare('SELECT deleted,sequence FROM work_tombstones WHERE work_id=?').get(sourceWorkId) as { deleted: number; sequence: number } | undefined;
    if (
      !sourceTombstoneAfter ||
      sourceTombstoneAfter.deleted !== 1 ||
      sourceTombstoneAfter.sequence !== sourceTombstoneBefore.sequence ||
      db.prepare('SELECT 1 FROM works WHERE id=?').get(sourceWorkId)
    ) {
      throw problem(500, 'Post-recovery check failed: source work tombstone or absence invariant violated');
    }
    if (
      dbTableChecksum(db, 'SELECT operation_id,source_work_id,request_hash,result FROM work_migrations WHERE operation_id=?', operationId) !== receiptBefore ||
      dbTableChecksum(db, 'SELECT operation_id,source_work_id,target_work_id,entry FROM work_migration_lineage WHERE operation_id=?', operationId) !== lineageBefore ||
      dbTableChecksum(db, 'SELECT sequence,operation_id,active FROM work_migration_events WHERE operation_id=? ORDER BY sequence', operationId) !== eventsBefore ||
      dbTableChecksum(db, 'SELECT id,entry,directory,fingerprint FROM works WHERE id=?', targetWorkId) !== targetWorkRowBefore ||
      userStateChecksum(db) !== userStateBefore
    ) {
      throw problem(500, 'Post-recovery check failed: immutable receipts, target work metadata, or user-state records changed unexpectedly');
    }

    return {
      operationId,
      sourceWorkId,
      targetWorkId,
      recoveredAt: new Date().toISOString(),
      totalCandidates: stagedPlans.length,
      publishedCount,
      alreadyRecoveredCount,
      chapters,
    };
  } finally {
    backupDb.close();
    await rm(runStageRoot, { recursive: true, force: true });
  }
}

function parseArg(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dataDir = parseArg(args, '--data-dir') ?? process.env.NOREA_DATA_DIR;
  const backupDbPath = parseArg(args, '--backup-db');
  const backupSourceDir = parseArg(args, '--backup-source-dir');
  const stagingRoot = parseArg(args, '--staging-root') ?? (dataDir ? join(dataDir, 'staging') : undefined);
  const operationId = parseArg(args, '--operation-id');
  const expectedStr = parseArg(args, '--expected-count');
  const reportOut = parseArg(args, '--report-out');
  if (!dataDir || !backupDbPath || !backupSourceDir || !stagingRoot || !operationId) {
    console.error('Usage: node src/work-migration-recovery.ts --data-dir <dir> --backup-db <sqlite> --backup-source-dir <dir> --operation-id <uuid> [--staging-root <dir>] [--expected-count <n>] [--report-out <json>]');
    process.exit(2);
  }
  const db = openDatabase(resolve(dataDir));
  try {
    const report = await recoverDiscardedMigrationChapters({
      db,
      dataDir: resolve(dataDir),
      backupDbPath: resolve(backupDbPath),
      backupSourceDir: resolve(backupSourceDir),
      stagingRoot: resolve(stagingRoot),
      operationId,
      ...(expectedStr !== undefined ? { expectedChapterCount: Number(expectedStr) } : {}),
    });
    const serialized = JSON.stringify(report, null, 2);
    if (reportOut) await writeFile(resolve(reportOut), serialized + '\n', 'utf8');
    console.log(JSON.stringify({
      operationId: report.operationId,
      sourceWorkId: report.sourceWorkId,
      targetWorkId: report.targetWorkId,
      recoveredAt: report.recoveredAt,
      totalCandidates: report.totalCandidates,
      publishedCount: report.publishedCount,
      alreadyRecoveredCount: report.alreadyRecoveredCount,
    }, null, 2));
  } finally {
    db.close();
  }
}
