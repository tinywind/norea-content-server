import { chapterIdentityId } from './chapter-number-mappings.ts';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticateDevice } from './auth.ts';
import { inspectChapterInventory } from './chapter-inventory.ts';
import { chapterFileStream } from './chapter-files.ts';
import { problem } from './db.ts';
import { readWorkMigrations, readWorkMigration, recordWorkMigrationLineage, type MigrationChapterDecision, type MigrationLineageChapterDecision, type MigrationLineageMapping } from './work-migration-lineage.ts';
import { isMigrationTextBody } from './migration-text-body.ts';
import { availableChapter, chapterRow, chapterStoragePath, digest, type CatalogEntry, type Limits } from './packages.ts';
import { coverBytes, deleteWork, getWork, isCoverFile, metadataByteLimit, type NovelMetadataV1, type WorkEntry } from './works.ts';

type Digest = { sha256: string; bytes: number };
export type MigrationInventory = { body: Digest | null; expectedAssetKeys: string[] | null; storedAssets: (Digest & { key: string })[] };
type Reference = { id: string; revision: string };
export interface MigrationSnapshot {
  work: Reference & { identity: NovelMetadataV1['identity']; metadata: NovelMetadataV1; coverSha256: string | null };
  chapters: (Reference & { chapterPath: string; chapterNumber: string | null; position: number; name: string; complete: boolean; available: boolean })[];
}
export interface FinalizeMigrationRequest {
  operationId: string;
  source: { revision: string; chapters: Reference[] };
  target: Reference;
  mappings: { sourceChapterId: string; targetChapterId?: string; targetRevision?: string; decision: 'copy-source' | 'keep-target' | 'delete-source'; expectedTargetInventory?: MigrationInventory }[];
  chapterDecisions?: MigrationChapterDecision[];
}
export interface FinalizeMigrationResult { operationId: string; deletedWork: WorkEntry }
interface ChapterRecord { id: string; entry: string; directory: string; path: string | null; deleted_at: number | null }
interface WorkRecord { entry: string; directory: string; fingerprint: string }
interface FileFence { path: string; signature: string }
interface ChapterFence { id: string; entry: string; path: string | null; directory: string; files: FileFence[]; names: string | null }
const MAX_CHAPTERS = 10000;
const conflict = (message: string): never => { throw problem(409, 'Work migration: ' + message); };
const liveRows = (db: DatabaseSync, id: string) => db.prepare('SELECT id,entry,directory,path,deleted_at FROM chapters WHERE work_id=? AND deleted_at IS NULL ORDER BY id').all(id) as unknown as ChapterRecord[];

function refreshWork(db: DatabaseSync, dataDir: string, id: string): { row: WorkRecord; entry: WorkEntry } {
  const entry = getWork(db, dataDir, id);
  const row = db.prepare('SELECT entry,directory,fingerprint FROM works WHERE id=?').get(id) as unknown as WorkRecord;
  return { row, entry };
}

function workSnapshot(dataDir: string, id: string, work: { row: WorkRecord; entry: WorkEntry }): MigrationSnapshot['work'] {
  const { row, entry } = work;
  const bytes = coverBytes(join(dataDir, row.directory), entry.metadata);
  const coverSha256 = bytes ? digest(bytes) : null;
  if (digest(canonicalize(entry.metadata) + '\n' + (coverSha256 ?? '')) !== row.fingerprint) conflict('cover changed during snapshot');
  return { id, revision: row.fingerprint, identity: entry.metadata.identity, metadata: entry.metadata, coverSha256 };
}
function chapterSnapshot(chapter: CatalogEntry, available: boolean): MigrationSnapshot['chapters'][number] {
  return { id: chapter.id, revision: chapter.revision, chapterPath: chapter.manifest.identity.chapterPath,
    chapterNumber: chapter.manifest.chapter.chapterNumber ?? null, position: chapter.manifest.chapter.position,
    name: chapter.manifest.chapter.name, complete: chapter.complete, available };
}
export function migrationSnapshot(db: DatabaseSync, dataDir: string, id: string): MigrationSnapshot {
  const work = workSnapshot(dataDir, id, refreshWork(db, dataDir, id));
  const chapters = liveRows(db, id);
  if (chapters.length > MAX_CHAPTERS) conflict('work exceeds the migration chapter limit');
  return { work, chapters: chapters.map(row => chapterSnapshot(JSON.parse(row.entry) as CatalogEntry, !!availableChapter(db, dataDir, row.id))) };
}

function signature(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) conflict('storage contains an unsafe file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
}
function fileFence(path: string): FileFence { return { path, signature: signature(path) }; }
function assertFileFence(fence: FileFence, path = fence.path, renamedRoot = false): void {
  const comparable = (value: string) => renamedRoot ? value.split(':').filter((_part, index) => index !== 4).join(':') : value;
  if (comparable(signature(path)) !== comparable(fence.signature)) conflict('files changed during verification');
}
function relocatedPath(path: string, sourceRoot: string, retiredRoot: string): string {
  return path === sourceRoot || path.startsWith(sourceRoot + sep) ? retiredRoot + path.slice(sourceRoot.length) : path;
}
function workFileFences(dataDir: string, work: { row: WorkRecord; entry: WorkEntry }): FileFence[] {
  const folder = chapterStoragePath(dataDir, work.row.directory);
  return [fileFence(folder), fileFence(join(folder, 'novel.json')),
    ...(work.entry.hasCover && work.entry.metadata.cover ? [fileFence(join(folder, work.entry.metadata.cover.fileName))] : [])];
}
function assertWorkRecord(db: DatabaseSync, id: string, expected: WorkRecord): void {
  const row = db.prepare('SELECT entry,directory,fingerprint FROM works WHERE id=?').get(id) as unknown as WorkRecord | undefined;
  if (!row || row.entry !== expected.entry || row.fingerprint !== expected.fingerprint || row.directory !== expected.directory) conflict('work changed before commit');
}
function chapterFence(db: DatabaseSync, dataDir: string, id: string, allowUnavailable = false): ChapterFence {
  const row = chapterRow(db, id);
  if (row.deleted_at !== null || row.catalog.deleted) conflict('chapter was deleted');
  if (!allowUnavailable && (!row.path || !availableChapter(db, dataDir, id))) conflict('chapter files are unavailable');
  const directory = chapterStoragePath(dataDir, row.path ?? row.directory);
  if (allowUnavailable && !existsSync(directory)) return { id, entry: row.entry, path: row.path, directory, files: [], names: null };
  const names = readdirSync(directory).sort();
  const listed = new Set(row.catalog.manifest.files.map(file => file.path));
  if (names.some(name => !listed.has(name))) conflict('chapter contains unindexed files');
  const files = [fileFence(directory), ...(allowUnavailable ? names : row.catalog.manifest.files.map(file => file.path)).map(name => {
    const path = allowUnavailable ? join(directory, name) : chapterFileStream(db, dataDir, id, row.catalog.revision, name).path;
    if (!lstatSync(path).isFile()) conflict('chapter contains a nonregular file');
    return fileFence(path);
  })];
  return { id, entry: row.entry, path: row.path, directory, files, names: JSON.stringify(names) };
}
function assertChapterFence(db: DatabaseSync, fence: ChapterFence, sourceRoot: string, retiredRoot: string): void {
  const current = chapterRow(db, fence.id);
  if (current.entry !== fence.entry || current.path !== fence.path || current.deleted_at !== null) conflict('chapter changed during verification');
  for (const file of fence.files) assertFileFence(file, relocatedPath(file.path, sourceRoot, retiredRoot));
  const directory = relocatedPath(fence.directory, sourceRoot, retiredRoot);
  if (fence.names === null ? existsSync(directory) : JSON.stringify(readdirSync(directory).sort()) !== fence.names) conflict('chapter files changed during verification');
}

function sourceFolderFence(dataDir: string, work: WorkRecord, rows: ChapterRecord[], deletions: Set<string>): { root: FileFence; names: string; metadataFiles: FileFence[] } {
  const folder = chapterStoragePath(dataDir, work.directory);
  const metadata = (JSON.parse(work.entry) as WorkEntry).metadata;
  const allowed = new Set(['novel.json', ...(metadata.cover ? [metadata.cover.fileName] : [])]);
  for (const row of rows) {
    const prefix = work.directory + '/';
    const directory = row.directory.replaceAll('\\', '/');
    if (!directory.startsWith(prefix) || directory.slice(prefix.length).includes('/') || (row.path !== row.directory && !(deletions.has(row.id) && row.path === null))) conflict('source chapter is outside its work folder');
    allowed.add(directory.slice(prefix.length));
  }
  const names = readdirSync(folder).sort();
  const metadataFiles: FileFence[] = [];
  for (const name of names.filter(isCoverFile)) {
    const path = join(folder, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) conflict('source cover is not a regular file');
    allowed.add(name); metadataFiles.push(fileFence(path));
  }
  const extras = names.filter(name => !allowed.has(name));
  if (extras.length) {
    if (extras.some(name => !/^novel-[A-Za-z0-9][A-Za-z0-9._-]*-safeBackup-\d{4}\.json$/.test(name))) conflict('source work contains unindexed files or chapters');
    const originalPath = join(folder, 'novel.json');
    const originalFence = fileFence(originalPath);
    const originalStat = lstatSync(originalPath);
    if (!originalStat.isFile() || originalStat.size > metadataByteLimit) conflict('source metadata cannot be verified');
    const originalBytes = readFileSync(originalPath);
    assertFileFence(originalFence);
    metadataFiles.push(originalFence);
    for (const name of extras) {
      const path = join(folder, name);
      const fence = fileFence(path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size !== originalBytes.length) conflict('source metadata backup is not an identical regular copy');
      if (!readFileSync(path).equals(originalBytes)) conflict('source metadata backup is not an identical regular copy');
      assertFileFence(fence);
      metadataFiles.push(fence);
    }
    // Keep the comparison's original fences through the final locked guard.
    assertFileFence(originalFence);
  }
  return { root: fileFence(folder), names: JSON.stringify(names), metadataFiles };
}

function checkedWork(db: DatabaseSync, dataDir: string, id: string, revision: string) {
  const work = refreshWork(db, dataDir, id);
  if (work.row.fingerprint !== revision || work.entry.deleted || work.entry.metadata.novel.isLocal || work.entry.metadata.identity.pluginId === 'local') conflict('work metadata changed or is not a remote source');
  return work;
}
/** Pin both work records and every involved file while a server copy stages bytes. */
export function migrationCopyFence(db: DatabaseSync, dataDir: string, sourceId: string, sourceRevision: string, sourceChapterId: string, targetId: string, targetRevision: string, targetChapterId?: string) {
  const source = checkedWork(db, dataDir, sourceId, sourceRevision);
  const target = checkedWork(db, dataDir, targetId, targetRevision);
  const files = [...workFileFences(dataDir, source), ...workFileFences(dataDir, target)];
  const chapters = [chapterFence(db, dataDir, sourceChapterId), ...(targetChapterId ? [chapterFence(db, dataDir, targetChapterId, true)] : [])];
  return { source: source.entry, target: target.entry, verify: () => {
    assertWorkRecord(db, sourceId, source.row);
    assertWorkRecord(db, targetId, target.row);
    for (const file of files) assertFileFence(file);
    for (const chapter of chapters) assertChapterFence(db, chapter, '', '');
  } };
}
function checkedSourceRows(db: DatabaseSync, id: string, expected: Reference[]): ChapterRecord[] {
  const rows = liveRows(db, id);
  const byId = new Map(expected.map(row => [row.id, row.revision]));
  if (byId.size !== expected.length || rows.length !== expected.length) conflict('source chapter snapshot is incomplete or changed');
  for (const row of rows) {
    const entry = JSON.parse(row.entry) as CatalogEntry;
    if (byId.get(row.id) !== entry.revision || entry.deleted) conflict('source chapter snapshot changed');
  }
  return rows;
}
function validateMappings(rows: ChapterRecord[], request: FinalizeMigrationRequest): void {
  const sources = new Set(rows.map(row => row.id));
  const targets = new Set<string>();
  if (request.mappings.length !== sources.size) conflict('every source chapter needs a mapping');
  for (const mapping of request.mappings) {
    if (!sources.delete(mapping.sourceChapterId)) conflict('chapter mappings are missing, repeated, or ambiguous');
    if (mapping.decision === 'delete-source') {
      if (request.chapterDecisions === undefined || mapping.targetChapterId !== undefined || mapping.targetRevision !== undefined || mapping.expectedTargetInventory !== undefined) conflict('deletion requires an explicit chapter decision without a target');
      continue;
    }
    if (!mapping.targetChapterId || !mapping.targetRevision || targets.has(mapping.targetChapterId)) conflict('chapter targets are missing, repeated, or ambiguous');
    targets.add(mapping.targetChapterId!);
    if ((mapping.decision === 'keep-target') !== (mapping.expectedTargetInventory !== undefined)) conflict('keep-target requires its explicitly selected inventory');
  }
}
const chapterNumber = (value: string | null | undefined): string | null => value == null ? null : String(Number(value));
function decisionChapter(chapters: CatalogEntry[], path: string, number: string | null): CatalogEntry | undefined {
  const exact = chapters.find(entry => entry.manifest.identity.chapterPath === path);
  if (exact) {
    if (number !== null && chapterNumber(exact.manifest.chapter.chapterNumber) !== chapterNumber(number)) conflict('chapter decision number differs from its exact source path');
    return exact;
  }
  if (number === null) return undefined;
  const matches = chapters.filter(entry => chapterNumber(entry.manifest.chapter.chapterNumber) === chapterNumber(number));
  if (matches.length > 1) conflict('chapter decision number is ambiguous');
  return matches[0];
}
function validateChapterDecisions(db: DatabaseSync, source: WorkEntry, target: WorkEntry, rows: ChapterRecord[], request: FinalizeMigrationRequest): MigrationLineageChapterDecision[] {
  if (request.chapterDecisions === undefined) return [];
  const sourceChapters = rows.map(row => JSON.parse(row.entry) as CatalogEntry);
  const targetChapters = liveRows(db, target.id).map(row => JSON.parse(row.entry) as CatalogEntry);
  const sources = new Map<string, MigrationChapterDecision>();
  const sourceNumbers = new Set<string>();
  const targetPaths = new Set<string>();
  const sourceMetadata = new Set(Object.keys(source.metadata.chapters).map(chapterNumber));
  const targetMetadata = new Set(Object.keys(target.metadata.chapters).map(chapterNumber));
  const paths = new Set<string>();
  const validated = request.chapterDecisions.map(decision => {
    if (paths.has(decision.sourceChapterPath)) conflict('chapter decisions repeat a source path');
    paths.add(decision.sourceChapterPath);
    if (decision.targetChapterPath === null && decision.targetChapterNumber !== null) conflict('deleted chapter decision must not have a target number');
    if (decision.discardSourceContent !== undefined && (decision.discardSourceContent !== true || decision.targetChapterPath === null)) conflict('invalid source-content discard decision');
    const sourceChapter = decisionChapter(sourceChapters, decision.sourceChapterPath, decision.sourceChapterNumber);
    const sourceNumber = chapterNumber(decision.sourceChapterNumber ?? sourceChapter?.manifest.chapter.chapterNumber);
    if (sourceNumber !== null) {
      if (sourceNumbers.has(sourceNumber)) conflict('chapter decisions repeat a source number');
      sourceNumbers.add(sourceNumber);
    }
    if (sourceChapter) {
      if (sources.has(sourceChapter.id)) conflict('chapter decisions repeat a source package');
      sources.set(sourceChapter.id, decision);
    }
    let targetNumber: string | null = null;
    if (decision.targetChapterPath !== null) {
      if (targetPaths.has(decision.targetChapterPath)) conflict('chapter decisions repeat a target path');
      targetPaths.add(decision.targetChapterPath);
      const targetChapter = decisionChapter(targetChapters, decision.targetChapterPath, decision.targetChapterNumber);
      targetNumber = chapterNumber(decision.targetChapterNumber ?? targetChapter?.manifest.chapter.chapterNumber);
      if (!targetChapter && (targetNumber === null || !targetMetadata.has(targetNumber))) conflict('chapter decision target is not in the target metadata or catalog');
    }
    return { ...decision, sourceMetadataVerified: sourceNumber !== null && sourceMetadata.has(sourceNumber),
      targetMetadataVerified: targetNumber !== null && targetMetadata.has(targetNumber) };
  });
  if ([...sourceMetadata].some(number => number === null || !sourceNumbers.has(number))) conflict('chapter decisions do not cover the full source metadata');
  for (const mapping of request.mappings) {
    const decision = sources.get(mapping.sourceChapterId);
    if (!decision) conflict('source package has no explicit chapter decision');
    if (mapping.decision === 'delete-source') {
      if (decision!.targetChapterPath !== null && !decision!.discardSourceContent) conflict('delete-source contradicts the selected chapter target');
      if (decision!.discardSourceContent && (decision!.targetChapterNumber === null || !targetMetadata.has(chapterNumber(decision!.targetChapterNumber)))) conflict('discard target must remain in the final chapter metadata');
    } else {
      if (decision!.discardSourceContent) conflict('source-content discard contradicts preservation');
      if (decision!.targetChapterPath === null) conflict('chapter preservation contradicts an explicit deletion');
      const selected = decisionChapter(targetChapters, decision!.targetChapterPath!, decision!.targetChapterNumber);
      if (selected?.id !== mapping.targetChapterId) conflict('chapter mapping differs from the selected target');
    }
  }
  return validated;
}

function sameDigest(left: Digest | null, right: Digest | null): boolean {
  return !!left && !!right && left.sha256 === right.sha256 && left.bytes === right.bytes;
}
function completeInventory(entry: CatalogEntry, inventory: MigrationInventory): boolean {
  if (!entry.complete || !inventory.body || inventory.body.bytes <= 0) return false;
  const hasMediaFiles = entry.manifest.files.some(file => file.path === 'manifest.json' || file.path === 'media.zip');
  if (!hasMediaFiles) return inventory.expectedAssetKeys === null && inventory.storedAssets.length === 0;
  if (inventory.expectedAssetKeys === null) return false;
  const stored = new Map(inventory.storedAssets.map(asset => [asset.key, asset]));
  return inventory.expectedAssetKeys.every(key => stored.has(key));
}
function verifyBodyOnlyTarget(db: DatabaseSync, dataDir: string, entry: CatalogEntry, inventory: MigrationInventory): void {
  if (entry.manifest.chapter.contentType === 'pdf') return;
  if (inventory.expectedAssetKeys !== null && inventory.expectedAssetKeys.length > 0) return;
  const path = chapterFileStream(db, dataDir, entry.id, entry.revision, entry.manifest.bodyPath).path;
  if (lstatSync(path).size > 16 * 1024 ** 2) conflict('body-only text exceeds the verification limit');
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024 ** 2 || !sameDigest(inventory.body, { sha256: digest(bytes), bytes: bytes.length })
    || !isMigrationTextBody(bytes, entry.manifest.chapter.contentType)) conflict('body-only target contains media or unsupported resource references');
}
function containsSource(source: MigrationInventory, target: MigrationInventory): boolean {
  if (!sameDigest(source.body, target.body)) return false;
  if (source.expectedAssetKeys !== null && (target.expectedAssetKeys === null
    || canonicalize([...source.expectedAssetKeys].sort()) !== canonicalize([...target.expectedAssetKeys].sort()))) return false;
  const assets = new Map(target.storedAssets.map(asset => [asset.key, asset]));
  return source.storedAssets.every(asset => sameDigest(asset, assets.get(asset.key) ?? null));
}
function normalizedInventory(value: MigrationInventory) {
  return { body: value.body, expectedAssetKeys: value.expectedAssetKeys === null ? null : [...value.expectedAssetKeys].sort(),
    storedAssets: [...value.storedAssets].sort((a, b) => a.key.localeCompare(b.key)) };
}
function validateInventory(value: MigrationInventory): void {
  const keys = value.expectedAssetKeys;
  const declared = keys === null ? null : new Set(keys.map(key => key.toLowerCase()));
  const stored = new Set(value.storedAssets.map(asset => asset.key.toLowerCase()));
  if ((declared !== null && declared.size !== keys!.length) || stored.size !== value.storedAssets.length) conflict('selected inventory contains ambiguous asset names');
}
function receipt(db: DatabaseSync, sourceId: string, request: FinalizeMigrationRequest, requestHash: string): FinalizeMigrationResult | null {
  const row = db.prepare('SELECT source_work_id,request_hash,result FROM work_migrations WHERE operation_id=?').get(request.operationId) as { source_work_id: string; request_hash: string; result: string } | undefined;
  if (!row) return null;
  if (row.source_work_id !== sourceId || row.request_hash !== requestHash) conflict('operation ID was already used for another request');
  const result = JSON.parse(row.result) as FinalizeMigrationResult;
  const tombstone = db.prepare('SELECT deleted,sequence FROM work_tombstones WHERE work_id=?').get(sourceId) as { deleted: number; sequence: number } | undefined;
  if (!tombstone?.deleted || tombstone.sequence !== result.deletedWork.sequence || db.prepare('SELECT 1 FROM works WHERE id=?').get(sourceId)) conflict('source was restored or changed after this migration');
  return result;
}

export async function finalizeMigration(db: DatabaseSync, dataDir: string, sourceId: string, request: FinalizeMigrationRequest, limits: Limits, authorizeCommit?: () => void): Promise<FinalizeMigrationResult> {
  const requestHash = digest(canonicalize({ sourceId, request }));
  const previous = receipt(db, sourceId, request, requestHash);
  if (previous) return previous;
  try {
    if (sourceId === request.target.id) conflict('source and target must be different works');
    const source = checkedWork(db, dataDir, sourceId, request.source.revision);
    const target = checkedWork(db, dataDir, request.target.id, request.target.revision);
    if (source.entry.metadata.identity.pluginId === target.entry.metadata.identity.pluginId) conflict('source and target must use different plugins');
    const rows = checkedSourceRows(db, sourceId, request.source.chapters);
    validateMappings(rows, request);
    const chapterDecisions = validateChapterDecisions(db, source.entry, target.entry, rows, request);
    const sourceWork = workSnapshot(dataDir, sourceId, source);
    const targetWork = workSnapshot(dataDir, request.target.id, target);
    const mappings: MigrationLineageMapping[] = [];
    const deletions = new Set(request.mappings.filter(mapping => mapping.decision === 'delete-source').map(mapping => mapping.sourceChapterId));
    const folder = sourceFolderFence(dataDir, source.row, rows, deletions);
    const workFiles = [...workFileFences(dataDir, source), ...workFileFences(dataDir, target), ...folder.metadataFiles];
    const fences: ChapterFence[] = [];
    for (const mapping of request.mappings) {
      const sourceEntry = chapterRow(db, mapping.sourceChapterId).catalog;
      if (mapping.decision === 'delete-source') {
        const sourceIdentity = sourceEntry.manifest.identity;
        if (sourceIdentity.pluginId !== sourceWork.identity.pluginId || sourceIdentity.novelId !== sourceWork.identity.novelId || sourceIdentity.novelPath !== sourceWork.identity.novelPath || sourceEntry.id !== chapterIdentityId(db, sourceIdentity)) conflict('deleted chapter does not belong to the source work');
        fences.push(chapterFence(db, dataDir, mapping.sourceChapterId, true));
        mappings.push({ source: chapterSnapshot(sourceEntry, !!availableChapter(db, dataDir, sourceEntry.id)), decision: 'delete-source', target: null, targetInventory: null });
        continue;
      }
      const targetEntry = chapterRow(db, mapping.targetChapterId!).catalog;
      const targetRecord = db.prepare('SELECT work_id FROM chapters WHERE id=?').get(mapping.targetChapterId!) as { work_id: string };
      if (targetRecord.work_id !== request.target.id || targetEntry.revision !== mapping.targetRevision || targetEntry.deleted) conflict('target chapter identity or revision changed');
      for (const [entry, expected] of [[sourceEntry, source.entry.metadata.identity], [targetEntry, target.entry.metadata.identity]] as const) {
        const identity = entry.manifest.identity;
        if (identity.pluginId !== expected.pluginId || identity.novelId !== expected.novelId || identity.novelPath !== expected.novelPath
          || entry.id !== chapterIdentityId(db, identity)) conflict('chapter does not belong to the expected work');
      }
      const sourceFence = chapterFence(db, dataDir, mapping.sourceChapterId);
      const targetFence = chapterFence(db, dataDir, mapping.targetChapterId!);
      fences.push(sourceFence, targetFence);
      const inspectedTarget = await inspectChapterInventory(db, dataDir, mapping.targetChapterId!, mapping.targetRevision!, limits);
      if (!completeInventory(targetEntry, inspectedTarget.inventory)) conflict('target chapter is not a verified complete copy');
      verifyBodyOnlyTarget(db, dataDir, targetEntry, inspectedTarget.inventory);
      if (mapping.decision === 'copy-source') {
        const inspectedSource = await inspectChapterInventory(db, dataDir, mapping.sourceChapterId, sourceEntry.revision, limits);
        const hasSourceMedia = sourceEntry.manifest.files.some(file => file.path === 'manifest.json' || file.path === 'media.zip');
        if ((hasSourceMedia && inspectedSource.inventory.expectedAssetKeys === null) || !containsSource(inspectedSource.inventory, inspectedTarget.inventory)) conflict('target does not preserve the source body and stored assets');
      } else {
        validateInventory(mapping.expectedTargetInventory!);
        if (canonicalize(normalizedInventory(mapping.expectedTargetInventory!)) !== canonicalize(normalizedInventory(inspectedTarget.inventory))) conflict('target differs from the explicitly selected copy');
      }
      mappings.push({ source: chapterSnapshot(sourceEntry, true), target: chapterSnapshot(targetEntry, true), decision: mapping.decision, targetInventory: inspectedTarget.inventory });
    }
    // No await is permitted between these final optimistic guards and deleteWork.
    // HTTP uploads/scans cannot publish on the JS thread during this section.
    const completed = receipt(db, sourceId, request, requestHash);
    if (completed) return completed;
    checkedWork(db, dataDir, sourceId, request.source.revision);
    checkedWork(db, dataDir, request.target.id, request.target.revision);
    let result: FinalizeMigrationResult;
    deleteWork(db, dataDir, sourceId, deletedWork => {
      result = { operationId: request.operationId, deletedWork };
      recordWorkMigrationLineage(db, { operationId: request.operationId, sourceWork, targetWork, deletedSource: { revision: request.source.revision, sequence: deletedWork.sequence }, mappings, chapterDecisions, fullDecisionCoverage: request.chapterDecisions !== undefined });
      db.prepare('INSERT INTO work_migrations(operation_id,source_work_id,request_hash,result) VALUES(?,?,?,?)')
        .run(request.operationId, sourceId, requestHash, JSON.stringify(result));
    }, retiredRoot => {
      // These guards run under deleteWork's BEGIN IMMEDIATE, before any row is removed.
      // Only the retired root's ctime may change because of the preceding directory rename.
      assertWorkRecord(db, sourceId, source.row);
      assertWorkRecord(db, request.target.id, target.row);
      checkedSourceRows(db, sourceId, request.source.chapters);
      assertFileFence(folder.root, retiredRoot, true);
      if (JSON.stringify(readdirSync(retiredRoot).sort()) !== folder.names) conflict('source work files changed during verification');
      for (const file of workFiles) assertFileFence(file, relocatedPath(file.path, folder.root.path, retiredRoot), file.path === folder.root.path);
      for (const fence of fences) assertChapterFence(db, fence, folder.root.path, retiredRoot);
      authorizeCommit?.();
    });
    return result!;
  } catch (error) {
    const completed = receipt(db, sourceId, request, requestHash);
    if (completed) return completed;
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 404 || status === 410 || (error as NodeJS.ErrnoException).code === 'ENOENT') conflict('source or target changed or became unavailable');
    throw error;
  }
}

const hash = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const reference = { type: 'object', additionalProperties: false, required: ['id', 'revision'], properties: { id: hash, revision: hash } };
const bodyDigest = { type: 'object', additionalProperties: false, required: ['sha256', 'bytes'], properties: { sha256: hash, bytes: count } };
const key = { type: 'string', maxLength: 261, pattern: '^media/[A-Za-z0-9_-][A-Za-z0-9._-]*$' };
const inventory = { type: 'object', additionalProperties: false, required: ['body', 'expectedAssetKeys', 'storedAssets'], properties: {
  body: { anyOf: [bodyDigest, { type: 'null' }] },
  expectedAssetKeys: { anyOf: [{ type: 'array', maxItems: 10000, items: key }, { type: 'null' }] },
  storedAssets: { type: 'array', maxItems: 10000, items: { type: 'object', additionalProperties: false, required: ['key', 'sha256', 'bytes'], properties: { key, sha256: hash, bytes: count } } },
} };
export function registerWorkMigrations(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; limits: Limits; requireRead: (request: FastifyRequest) => void; notify: () => void }): void {
  const { db, dataDir, limits, requireRead, notify } = context;
  const params = { type: 'object', required: ['id'], properties: { id: hash } };
  const operationId = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
  const pageQuery = { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } };
  app.get<{ Querystring: { after: number; limit: number } }>('/api/v1/work-migrations', { schema: { querystring: pageQuery,
    description: 'Read durable migration decisions in current event order. Returns only the latest active or revoked event for each operation, with full captured source and target metadata.',
    security: [{ bearerAuth: [] }, {}],
  } }, async (request, reply) => {
    requireRead(request); reply.header('Cache-Control', 'no-store');
    return readWorkMigrations(db, request.query.after, request.query.limit);
  });
  app.get<{ Params: { operationId: string } }>('/api/v1/work-migrations/:operationId', { schema: {
    params: { type: 'object', required: ['operationId'], properties: { operationId } }, security: [{ bearerAuth: [] }, {}],
    description: 'Recheck the current migration event immediately before applying or resuming it on another device.',
  } }, async (request, reply) => {
    requireRead(request); reply.header('Cache-Control', 'no-store');
    return readWorkMigration(db, request.params.operationId);
  });
  app.get<{ Params: { id: string }; Querystring: { after: number; limit: number } }>('/api/v1/works/:id/migration-history', { schema: { params, querystring: pageQuery,
    description: 'Read the complete connected work-migration chain, including deleted intermediate works, using the latest event per operation.',
    security: [{ bearerAuth: [] }, {}],
  } }, async (request, reply) => {
    requireRead(request); reply.header('Cache-Control', 'no-store');
    return readWorkMigrations(db, request.query.after, request.query.limit, request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/v1/works/:id/migration-snapshot', { schema: { params,
    description: 'Return the current work metadata/cover revision and every nondeleted chapter, including unavailable copies. No chapter body or media bytes are returned.',
    security: [{ bearerAuth: [] }, {}],
  } }, async (request, reply) => {
    requireRead(request); reply.header('Cache-Control', 'no-store');
    return migrationSnapshot(db, dataDir, request.params.id);
  });
  app.post<{ Params: { id: string }; Body: FinalizeMigrationRequest }>('/api/v1/works/:id/finalize-migration', {
    bodyLimit: metadataByteLimit,
    onRequest: async request => { authenticateDevice(db, request); },
    schema: { params, security: [{ bearerAuth: [] }],
      description: 'Retire a source work only after an exact full snapshot, unambiguous mappings, and complete target payloads pass fresh integrity checks. Persists an idempotent receipt with the deletion tombstones. A conflict preserves the source.',
      body: { type: 'object', additionalProperties: false, required: ['operationId', 'source', 'target', 'mappings'], properties: {
        operationId,
        source: { type: 'object', additionalProperties: false, required: ['revision', 'chapters'], properties: { revision: hash, chapters: { type: 'array', maxItems: MAX_CHAPTERS, items: reference } } },
        target: reference,
        mappings: { type: 'array', maxItems: MAX_CHAPTERS, items: { type: 'object', additionalProperties: false,
          required: ['sourceChapterId', 'decision'], properties: { sourceChapterId: hash, targetChapterId: hash, targetRevision: hash,
            decision: { type: 'string', enum: ['copy-source', 'keep-target', 'delete-source'] }, expectedTargetInventory: inventory } } },
        chapterDecisions: { type: 'array', maxItems: MAX_CHAPTERS, items: { type: 'object', additionalProperties: false,
          required: ['sourceChapterPath', 'sourceChapterNumber', 'targetChapterPath', 'targetChapterNumber'], properties: {
            discardSourceContent: { type: 'boolean', const: true },
            sourceChapterPath: { type: 'string', minLength: 1, maxLength: 4096 },
            sourceChapterNumber: { anyOf: [{ type: 'string', maxLength: 100, pattern: '^\\d+(?:\\.\\d+)?$' }, { type: 'null' }] },
            targetChapterPath: { anyOf: [{ type: 'string', minLength: 1, maxLength: 4096 }, { type: 'null' }] },
            targetChapterNumber: { anyOf: [{ type: 'string', maxLength: 100, pattern: '^\\d+(?:\\.\\d+)?$' }, { type: 'null' }] },
          } } },
      } },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    request.raw.setTimeout?.(300000);
    const result = await finalizeMigration(db, dataDir, request.params.id, request.body, limits, () => { authenticateDevice(db, request); });
    notify(); return result;
  });
}
