import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticateDevice } from './auth.ts';
import { inspectChapterInventory } from './chapter-inventory.ts';
import { chapterFileStream } from './chapter-files.ts';
import { problem } from './db.ts';
import { isMigrationTextBody } from './migration-text-body.ts';
import { availableChapter, chapterRow, chapterStoragePath, digest, type CatalogEntry, type Limits } from './packages.ts';
import { deleteWork, getWork, metadataByteLimit, type NovelMetadataV1, type WorkEntry } from './works.ts';

type Digest = { sha256: string; bytes: number };
export type MigrationInventory = { body: Digest | null; expectedAssetKeys: string[] | null; storedAssets: (Digest & { key: string })[] };
type Reference = { id: string; revision: string };
export interface MigrationSnapshot {
  work: Reference & { identity: NovelMetadataV1['identity'] };
  chapters: (Reference & { chapterPath: string; chapterNumber: string | null; position: number; name: string; complete: boolean; available: boolean })[];
}
export interface FinalizeMigrationRequest {
  operationId: string;
  source: { revision: string; chapters: Reference[] };
  target: Reference;
  mappings: { sourceChapterId: string; targetChapterId: string; targetRevision: string; decision: 'copy-source' | 'keep-target'; expectedTargetInventory?: MigrationInventory }[];
}
export interface FinalizeMigrationResult { operationId: string; deletedWork: WorkEntry }
interface ChapterRecord { id: string; entry: string; directory: string; path: string | null; deleted_at: number | null }
interface WorkRecord { entry: string; directory: string; fingerprint: string }
interface FileFence { path: string; signature: string }
interface ChapterFence { id: string; entry: string; path: string | null; files: FileFence[]; names: string }
const MAX_CHAPTERS = 10000;
const conflict = (message: string): never => { throw problem(409, 'Work migration: ' + message); };
const liveRows = (db: DatabaseSync, id: string) => db.prepare('SELECT id,entry,directory,path,deleted_at FROM chapters WHERE work_id=? AND deleted_at IS NULL ORDER BY id').all(id) as unknown as ChapterRecord[];

function refreshWork(db: DatabaseSync, dataDir: string, id: string): { row: WorkRecord; entry: WorkEntry } {
  const entry = getWork(db, dataDir, id);
  const row = db.prepare('SELECT entry,directory,fingerprint FROM works WHERE id=?').get(id) as unknown as WorkRecord;
  return { row, entry };
}

export function migrationSnapshot(db: DatabaseSync, dataDir: string, id: string): MigrationSnapshot {
  const { row, entry } = refreshWork(db, dataDir, id);
  const chapters = liveRows(db, id);
  if (chapters.length > MAX_CHAPTERS) conflict('work exceeds the migration chapter limit');
  return {
    work: { id, revision: row.fingerprint, identity: entry.metadata.identity },
    chapters: chapters.map(row => {
      const chapter = JSON.parse(row.entry) as CatalogEntry;
      return { id: row.id, revision: chapter.revision, chapterPath: chapter.manifest.identity.chapterPath,
        chapterNumber: chapter.manifest.chapter.chapterNumber ?? null, position: chapter.manifest.chapter.position,
        name: chapter.manifest.chapter.name, complete: chapter.complete, available: !!availableChapter(db, dataDir, row.id) };
    }),
  };
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
function chapterFence(db: DatabaseSync, dataDir: string, id: string): ChapterFence {
  const row = chapterRow(db, id);
  if (row.deleted_at !== null || row.catalog.deleted || !row.path || !availableChapter(db, dataDir, id)) conflict('chapter files are unavailable');
  const directory = chapterStoragePath(dataDir, row.path!);
  const names = readdirSync(directory).sort();
  const listed = new Set(row.catalog.manifest.files.map(file => file.path));
  if (names.some(name => !listed.has(name))) conflict('chapter contains unindexed files');
  const files = [fileFence(directory), ...row.catalog.manifest.files.map(file => fileFence(chapterFileStream(db, dataDir, id, row.catalog.revision, file.path).path))];
  return { id, entry: row.entry, path: row.path, files, names: JSON.stringify(names) };
}
function assertChapterFence(db: DatabaseSync, fence: ChapterFence, sourceRoot: string, retiredRoot: string): void {
  const current = chapterRow(db, fence.id);
  if (current.entry !== fence.entry || current.path !== fence.path || current.deleted_at !== null) conflict('chapter changed during verification');
  for (const file of fence.files) assertFileFence(file, relocatedPath(file.path, sourceRoot, retiredRoot));
  if (JSON.stringify(readdirSync(relocatedPath(fence.files[0].path, sourceRoot, retiredRoot)).sort()) !== fence.names) conflict('chapter files changed during verification');
}

function sourceFolderFence(dataDir: string, work: WorkRecord, rows: ChapterRecord[]): { root: FileFence; names: string } {
  const folder = chapterStoragePath(dataDir, work.directory);
  const metadata = (JSON.parse(work.entry) as WorkEntry).metadata;
  const allowed = new Set(['novel.json', ...(metadata.cover ? [metadata.cover.fileName] : [])]);
  for (const row of rows) {
    const prefix = work.directory + '/';
    const directory = row.directory.replaceAll('\\', '/');
    if (!directory.startsWith(prefix) || directory.slice(prefix.length).includes('/') || row.path !== row.directory) conflict('source chapter is outside its work folder');
    allowed.add(directory.slice(prefix.length));
  }
  const names = readdirSync(folder).sort();
  if (names.some(name => !allowed.has(name))) conflict('source work contains unindexed files or chapters');
  return { root: fileFence(folder), names: JSON.stringify(names) };
}

function checkedWork(db: DatabaseSync, dataDir: string, id: string, revision: string) {
  const work = refreshWork(db, dataDir, id);
  if (work.row.fingerprint !== revision || work.entry.deleted || work.entry.metadata.novel.isLocal || work.entry.metadata.identity.pluginId === 'local') conflict('work metadata changed or is not a remote source');
  return work;
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
    if (!sources.delete(mapping.sourceChapterId) || targets.has(mapping.targetChapterId)) conflict('chapter mappings are missing, repeated, or ambiguous');
    targets.add(mapping.targetChapterId);
    if ((mapping.decision === 'keep-target') !== (mapping.expectedTargetInventory !== undefined)) conflict('keep-target requires its explicitly selected inventory');
  }
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
    const folder = sourceFolderFence(dataDir, source.row, rows);
    const workFiles = [...workFileFences(dataDir, source), ...workFileFences(dataDir, target)];
    const fences: ChapterFence[] = [];
    for (const mapping of request.mappings) {
      const sourceEntry = chapterRow(db, mapping.sourceChapterId).catalog;
      const targetEntry = chapterRow(db, mapping.targetChapterId).catalog;
      const targetWork = db.prepare('SELECT work_id FROM chapters WHERE id=?').get(mapping.targetChapterId) as { work_id: string };
      if (targetWork.work_id !== request.target.id || targetEntry.revision !== mapping.targetRevision || targetEntry.deleted) conflict('target chapter identity or revision changed');
      for (const [entry, expected] of [[sourceEntry, source.entry.metadata.identity], [targetEntry, target.entry.metadata.identity]] as const) {
        const identity = entry.manifest.identity;
        if (identity.pluginId !== expected.pluginId || identity.novelId !== expected.novelId || identity.novelPath !== expected.novelPath
          || entry.id !== digest(JSON.stringify([identity.pluginId, identity.novelPath, identity.chapterPath]))) conflict('chapter does not belong to the expected work');
      }
      const sourceFence = chapterFence(db, dataDir, mapping.sourceChapterId);
      const targetFence = chapterFence(db, dataDir, mapping.targetChapterId);
      fences.push(sourceFence, targetFence);
      const inspectedTarget = await inspectChapterInventory(db, dataDir, mapping.targetChapterId, mapping.targetRevision, limits);
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
        operationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
        source: { type: 'object', additionalProperties: false, required: ['revision', 'chapters'], properties: { revision: hash, chapters: { type: 'array', maxItems: MAX_CHAPTERS, items: reference } } },
        target: reference,
        mappings: { type: 'array', maxItems: MAX_CHAPTERS, items: { type: 'object', additionalProperties: false,
          required: ['sourceChapterId', 'targetChapterId', 'targetRevision', 'decision'],
          properties: { sourceChapterId: hash, targetChapterId: hash, targetRevision: hash,
            decision: { type: 'string', enum: ['copy-source', 'keep-target'] }, expectedTargetInventory: inventory } } },
      } },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    request.raw.setTimeout?.(300000);
    const result = await finalizeMigration(db, dataDir, request.params.id, request.body, limits, () => { authenticateDevice(db, request); });
    notify(); return result;
  });
}
