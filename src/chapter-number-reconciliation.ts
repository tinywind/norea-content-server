import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalize } from 'json-canonicalize';
import { authenticateDevice } from './auth.ts';
import { canonicalWorkChapters, chapterNumberAliases, type ChapterNumberAlias } from './chapter-number-mappings.ts';
import { problem, transaction } from './db.ts';
import { chapterStoragePath, digest, recordEntry, type CatalogEntry } from './packages.ts';
import { mergeReadingState, normalizeReadingState, readingStateKey, type ReadingStateEntry } from './reading-state.ts';
import { cacheWork, getWork, metadataByteLimit, parseNovelMetadata, type NovelMetadataV1, type WorkEntry } from './works.ts';

export interface ChapterNumberMapping { chapterPath: string; from: string; to: string }
export interface ReconcileChapterNumbersRequest {
  operationId: string;
  expectedWorkRevision: string;
  mappings: ChapterNumberMapping[];
}
export interface ChapterNumberMappingsResult {
  work: WorkEntry & { revision: string };
  mappings: ChapterNumberMapping[];
}
export interface ReconcileChapterNumbersResult {
  operationId: string;
  work: WorkEntry;
  updatedChapters: number;
  updatedReadingStates: number;
}
interface WorkRow { directory: string; entry: string; fingerprint: string }
interface ChapterRow { id: string; work_id: string; directory: string; path: string | null; deleted_at: number | null; entry: string }
interface FolderMove { from: string; to: string; dev: number; ino: number }
interface Journal {
  version: 1;
  workId: string;
  directory: string;
  metadata: { path: string; before: string; after: string; beforeHash: string; afterHash: string; mode: number };
  moves: FolderMove[];
}
interface Receipt { operation_id: string; work_id: string; request_hash: string; state: 'prepared' | 'committed'; journal: string | null; result: string | null }
interface PlannedMapping { mapping: ChapterNumberMapping; alias: ChapterNumberAlias; row?: ChapterRow; directory: string; path: string | null }
const conflict = (message: string): never => { throw problem(409, 'Chapter number reconciliation conflict: ' + message); };
const positiveNumber = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && String(Number(value)) === value;
const chapterHash = (identity: NovelMetadataV1['identity'], path: string) => digest(JSON.stringify([identity.pluginId, identity.novelPath, path]));

function validateRequest(request: ReconcileChapterNumbersRequest): void {
  if (!request || typeof request !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.operationId) ||
    !/^[0-9a-f]{64}$/.test(request.expectedWorkRevision) || !Array.isArray(request.mappings) || !request.mappings.length || request.mappings.length > 10000) {
    throw problem(400, 'Invalid chapter number reconciliation request');
  }
  const from = new Set<string>(); const to = new Set<string>(); const paths = new Set<string>();
  for (const mapping of request.mappings) {
    if (!mapping || !positiveNumber(mapping.from) || !positiveNumber(mapping.to) ||
      typeof mapping.chapterPath !== 'string' || !mapping.chapterPath.trim() || !mapping.chapterPath.isWellFormed() ||
      mapping.chapterPath.length > 4096 || /^(?:norea|local)-folder:/.test(mapping.chapterPath)) {
      throw problem(400, 'Reconciliation requires positive integer numbers and actual source chapter paths');
    }
    if (from.has(mapping.from) || to.has(mapping.to) || paths.has(mapping.chapterPath)) conflict('mappings must have unique source numbers, target numbers and paths');
    from.add(mapping.from); to.add(mapping.to); paths.add(mapping.chapterPath);
  }
  if ([...from].some(number => to.has(number))) conflict('source and target number sets must be disjoint');
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableWrite(path: string, bytes: Buffer, mode: number): void {
  const temporary = join(dirname(path), '.norea-renumber-' + randomUUID());
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path); fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
function present(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
function sameDirectory(path: string, move: FolderMove): boolean {
  const info = present(path);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.dev === move.dev && info.ino === move.ino;
}
function metadataBytes(dataDir: string, path: string): Buffer {
  const absolute = chapterStoragePath(dataDir, path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > metadataByteLimit) conflict('work metadata must be a regular bounded file');
  return readFileSync(absolute);
}
function checkedJournal(dataDir: string, receipt: Receipt): Journal {
  let journal: Journal;
  try { journal = JSON.parse(receipt.journal ?? 'null') as Journal; }
  catch { return conflict('recovery journal is unreadable'); }
  if (!journal || journal.version !== 1 || journal.workId !== receipt.work_id || !Array.isArray(journal.moves) ||
    journal.metadata.path !== join(journal.directory, 'novel.json') ||
    digest(Buffer.from(journal.metadata.before, 'base64')) !== journal.metadata.beforeHash ||
    digest(Buffer.from(journal.metadata.after, 'base64')) !== journal.metadata.afterHash) conflict('recovery journal is invalid');
  const directory = chapterStoragePath(dataDir, journal.directory);
  for (const move of journal.moves) {
    if (dirname(chapterStoragePath(dataDir, move.from)) !== directory || dirname(chapterStoragePath(dataDir, move.to)) !== directory ||
      move.from === move.to || !Number.isSafeInteger(move.dev) || !Number.isSafeInteger(move.ino)) conflict('recovery folder proof is invalid');
  }
  return journal;
}
function rollbackJournal(dataDir: string, journal: Journal): void {
  // Inspect every location before restoring anything. Never remove an unknown
  // destination or overwrite an independently edited metadata document.
  const file = chapterStoragePath(dataDir, journal.metadata.path);
  const metadataHash = digest(metadataBytes(dataDir, journal.metadata.path));
  if (![journal.metadata.beforeHash, journal.metadata.afterHash].includes(metadataHash)) conflict('metadata changed outside the prepared operation; recovery is retained');
  for (const move of journal.moves) {
    const from = chapterStoragePath(dataDir, move.from); const to = chapterStoragePath(dataDir, move.to);
    if (!((sameDirectory(from, move) && !present(to)) || (!present(from) && sameDirectory(to, move)))) {
      conflict('folder state is ambiguous; recovery is retained without overwriting files');
    }
  }
  if (metadataHash === journal.metadata.afterHash) durableWrite(file, Buffer.from(journal.metadata.before, 'base64'), journal.metadata.mode);
  for (const move of [...journal.moves].reverse()) {
    const from = chapterStoragePath(dataDir, move.from); const to = chapterStoragePath(dataDir, move.to);
    if (!present(from)) {
      if (!sameDirectory(to, move)) conflict('folder changed during recovery');
      renameSync(to, from); fsyncDirectory(dirname(from));
    }
  }
}

/** Run before rebuilding the work index, so a partial rename cannot look deleted. */
export function recoverChapterNumberReconciliations(db: DatabaseSync, dataDir: string, workId?: string): void {
  const receipts = (workId === undefined
    ? db.prepare("SELECT * FROM chapter_number_reconciliations WHERE state='prepared' ORDER BY operation_id").all()
    : db.prepare("SELECT * FROM chapter_number_reconciliations WHERE state='prepared' AND work_id=? ORDER BY operation_id").all(workId)) as unknown as Receipt[];
  for (const receipt of receipts) {
    const journal = checkedJournal(dataDir, receipt);
    transaction(db, () => {
      const current = db.prepare('SELECT * FROM chapter_number_reconciliations WHERE operation_id=?').get(receipt.operation_id) as unknown as Receipt | undefined;
      if (!current || current.state === 'committed') return;
      if (current.work_id !== receipt.work_id || current.request_hash !== receipt.request_hash || current.journal !== receipt.journal) conflict('prepared recovery record changed before locking');
      rollbackJournal(dataDir, journal);
      db.prepare("DELETE FROM chapter_number_reconciliations WHERE operation_id=? AND state='prepared'").run(receipt.operation_id);
    });
  }
}

function readingStates(db: DatabaseSync, identity: NovelMetadataV1['identity']): number {
  const rows = db.prepare("SELECT sequence,profile_hash,entry_key,entry FROM reading_state_entries WHERE json_extract(entry,'$.pluginId')=? AND json_extract(entry,'$.novelPath')=? ORDER BY sequence")
    .all(identity.pluginId, identity.novelPath) as unknown as { sequence: number; profile_hash: string; entry_key: string; entry: string }[];
  let updated = 0;
  for (const row of rows) {
    const raw = JSON.parse(row.entry) as ReadingStateEntry;
    if (raw.sourceNovelId !== null && raw.sourceNovelId.trim().toLowerCase() !== identity.novelId.toLowerCase()) continue;
    // An earlier row may have consolidated this row already.
    if (!db.prepare('SELECT 1 FROM reading_state_entries WHERE sequence=?').get(row.sequence)) continue;
    const incoming = normalizeReadingState(db, raw);
    const key = readingStateKey(incoming);
    if (row.entry_key === key && row.entry === JSON.stringify(incoming)) continue;
    const target = db.prepare('SELECT sequence,entry FROM reading_state_entries WHERE profile_hash=? AND entry_key=?').get(row.profile_hash, key) as { sequence: number; entry: string } | undefined;
    let merged = incoming; let sequence = row.sequence;
    if (target && target.sequence !== row.sequence) {
      const previous = normalizeReadingState(db, JSON.parse(target.entry) as ReadingStateEntry);
      if (previous.pluginId !== incoming.pluginId || previous.novelPath !== incoming.novelPath || previous.chapterPath !== incoming.chapterPath ||
        previous.sourceNovelId !== incoming.sourceNovelId || previous.page !== incoming.page) conflict('reading-state target belongs to a different chapter');
      merged = mergeReadingState(previous, incoming);
      sequence = Math.min(row.sequence, target.sequence);
      db.prepare('DELETE FROM reading_state_entries WHERE sequence IN (?,?)').run(row.sequence, target.sequence);
      db.prepare('INSERT INTO reading_state_entries(sequence,profile_hash,entry_key,entry) VALUES(?,?,?,?)').run(sequence, row.profile_hash, key, JSON.stringify(merged));
    } else {
      db.prepare('UPDATE reading_state_entries SET entry_key=?,entry=? WHERE sequence=?').run(key, JSON.stringify(merged), sequence);
    }
    updated++;
  }
  return updated;
}

function sameMapping(alias: ChapterNumberAlias, mapping: ChapterNumberMapping): boolean {
  return alias.from_number === mapping.from && alias.to_number === mapping.to && alias.chapter_path === mapping.chapterPath;
}
function assertApplied(db: DatabaseSync, dataDir: string, work: WorkEntry, workRow: WorkRow, mapping: ChapterNumberMapping, alias: ChapterNumberAlias): void {
  if (!sameMapping(alias, mapping) || Object.hasOwn(work.metadata.chapters, mapping.from) || !Object.hasOwn(work.metadata.chapters, mapping.to)) conflict('previously applied mapping no longer matches work metadata');
  const row = db.prepare('SELECT * FROM chapters WHERE id=?').get(alias.chapter_id) as unknown as ChapterRow | undefined;
  if (row) {
    const entry = JSON.parse(row.entry) as CatalogEntry;
    if (row.work_id !== work.id || row.directory !== join(workRow.directory, mapping.to) || entry.manifest.chapter.chapterNumber !== mapping.to ||
      entry.manifest.identity.chapterPath !== mapping.chapterPath) conflict('previously applied chapter identity changed');
  }
  if (present(chapterStoragePath(dataDir, join(workRow.directory, mapping.from)))) conflict('an old-number folder appeared after reconciliation; scan and resolve it before retrying');
}
/** A complete, revision-consistent read for clients importing already reconciled works. */
export function chapterNumberMappingsSnapshot(db: DatabaseSync, dataDir: string, workId: string): ChapterNumberMappingsResult {
  return transaction(db, () => {
    const work = getWork(db, dataDir, workId);
    const row = db.prepare('SELECT directory,entry,fingerprint FROM works WHERE id=?').get(workId) as unknown as WorkRow;
    const aliases = chapterNumberAliases(db, work.metadata.identity);
    const mappings: ChapterNumberMapping[] = [];
    const oldNumbers = new Set<string>(); const newNumbers = new Set<string>(); const paths = new Set<string>();
    if (aliases.length && (work.deleted || work.metadata.novel.isLocal || work.metadata.identity.pluginId === 'local' ||
      row.directory !== join('contents', work.metadata.identity.pluginId, work.metadata.identity.novelId))) conflict('registered mappings require their original remote work');
    for (const alias of aliases) {
      const mapping = { chapterPath: alias.chapter_path, from: alias.from_number, to: alias.to_number };
      if (!positiveNumber(mapping.from) || !positiveNumber(mapping.to) || typeof mapping.chapterPath !== 'string' ||
        !mapping.chapterPath.trim() || !mapping.chapterPath.isWellFormed() || mapping.chapterPath.length > 4096 ||
        /^(?:norea|local)-folder:/.test(mapping.chapterPath) || oldNumbers.has(mapping.from) || newNumbers.has(mapping.to) || paths.has(mapping.chapterPath)) {
        conflict('registered mapping has an invalid number or source path');
      }
      oldNumbers.add(mapping.from); newNumbers.add(mapping.to); paths.add(mapping.chapterPath);
      assertApplied(db, dataDir, work, row, mapping, alias);
      mappings.push(mapping);
    }
    if ([...oldNumbers].some(number => newNumbers.has(number))) conflict('registered mapping number sets overlap');
    mappings.sort((left, right) => Number(left.to) - Number(right.to));
    return { work: { ...work, revision: row.fingerprint }, mappings };
  });
}

function planMappings(db: DatabaseSync, dataDir: string, work: WorkEntry, workRow: WorkRow, mappings: ChapterNumberMapping[], operationId: string): { plans: PlannedMapping[]; moves: FolderMove[] } {
  const identity = work.metadata.identity;
  const rows = db.prepare('SELECT * FROM chapters WHERE work_id=?').all(work.id) as unknown as ChapterRow[];
  const parsed = rows.map(row => ({ row, entry: JSON.parse(row.entry) as CatalogEntry }));
  const plans: PlannedMapping[] = []; const moves: FolderMove[] = [];
  for (const mapping of mappings) {
    if (Object.hasOwn(work.metadata.chapters, mapping.to)) conflict('target chapter number is already in work metadata');
    if (parsed.some(({ entry }) => String(Number(entry.manifest.chapter.chapterNumber)) === mapping.to ||
      entry.manifest.identity.chapterPath === 'norea-folder:' + mapping.to)) conflict('target chapter number is already declared by another stored identity');
    const candidates = parsed.filter(({ entry }) => String(Number(entry.manifest.chapter.chapterNumber)) === mapping.from || entry.manifest.identity.chapterPath === mapping.chapterPath ||
      entry.manifest.identity.chapterPath === 'norea-folder:' + mapping.from);
    if (candidates.length > 1) conflict('source chapter number or path has multiple stored identities');
    const candidate = candidates[0]; const row = candidate?.row; const entry = candidate?.entry;
    if (!row && !Object.hasOwn(work.metadata.chapters, mapping.from)) conflict('source number has no stored chapter or metadata identity');
    const sourcePath = entry?.manifest.identity.chapterPath ?? mapping.chapterPath;
    if (entry && (entry.manifest.identity.pluginId !== identity.pluginId || entry.manifest.identity.novelId !== identity.novelId ||
      entry.manifest.identity.novelPath !== identity.novelPath || (sourcePath !== mapping.chapterPath && sourcePath !== 'norea-folder:' + mapping.from) ||
      entry.manifest.chapter.chapterNumber !== mapping.from || row!.id !== chapterHash(identity, sourcePath) || entry.id !== row!.id)) conflict('source chapter path does not prove the requested identity');
    const from = join(workRow.directory, mapping.from); const to = join(workRow.directory, mapping.to);
    if (row && row.directory !== from) conflict('source chapter folder does not match its old number');
    if (db.prepare('SELECT id FROM chapters WHERE lower(directory)=lower(?)').get(to)) conflict('target chapter folder is already registered');
    const oldFolder = chapterStoragePath(dataDir, from); const newFolder = chapterStoragePath(dataDir, to);
    if (present(newFolder)) conflict('target chapter folder already exists');
    const info = present(oldFolder);
    if (info && (!row || row.deleted_at !== null || entry!.deleted)) conflict('unindexed or deleted source folder must be resolved first');
    if (info && (!info.isDirectory() || info.isSymbolicLink())) conflict('source chapter folder is unsafe');
    if (row && row.deleted_at === null && !entry!.deleted && row.path !== null && row.path !== from) conflict('source payload is outside its canonical chapter folder');
    if (row && row.deleted_at !== null && row.path !== null && !row.path.startsWith('trash/')) conflict('deleted chapter has an unexpected payload path');
    if (row && row.deleted_at === null && !entry!.deleted && row.path !== null && !info) conflict('registered source chapter folder is missing');
    if (info) moves.push({ from, to, dev: Number(info.dev), ino: Number(info.ino) });
    plans.push({ mapping, row, directory: to, path: row?.deleted_at !== null && row?.deleted_at !== undefined ? row.path : row?.path === from ? to : null,
      alias: { work_id: work.id, from_number: mapping.from, to_number: mapping.to, chapter_path: mapping.chapterPath,
        source_chapter_path: sourcePath, chapter_id: row?.id ?? chapterHash(identity, sourcePath), operation_id: operationId } });
  }
  return { plans, moves };
}

export function reconcileChapterNumbers(db: DatabaseSync, dataDir: string, workId: string, request: ReconcileChapterNumbersRequest, authorizeCommit?: () => void): ReconcileChapterNumbersResult {
  validateRequest(request);
  recoverChapterNumberReconciliations(db, dataDir, workId);
  const requestHash = digest(canonicalize({ workId, request }));
  const previous = db.prepare('SELECT * FROM chapter_number_reconciliations WHERE operation_id=?').get(request.operationId) as unknown as Receipt | undefined;
  if (previous && (previous.work_id !== workId || previous.request_hash !== requestHash)) conflict('operation ID was already used for another request');
  const work = getWork(db, dataDir, workId);
  const workRow = db.prepare('SELECT directory,entry,fingerprint FROM works WHERE id=?').get(workId) as unknown as WorkRow;
  if (work.deleted || work.metadata.novel.isLocal || work.metadata.identity.pluginId === 'local' ||
    workRow.directory !== join('contents', work.metadata.identity.pluginId, work.metadata.identity.novelId)) conflict('work must be a registered remote source');
  const aliases = chapterNumberAliases(db, work.metadata.identity);
  const pending: ChapterNumberMapping[] = [];
  for (const mapping of request.mappings) {
    const matches = aliases.filter(alias => [alias.from_number, alias.to_number].includes(mapping.from) ||
      [alias.from_number, alias.to_number].includes(mapping.to) || alias.chapter_path === mapping.chapterPath || alias.source_chapter_path === mapping.chapterPath);
    if (!matches.length) { pending.push(mapping); continue; }
    if (matches.length !== 1 || !sameMapping(matches[0], mapping)) conflict('mapping conflicts with a registered number or path');
    assertApplied(db, dataDir, work, workRow, mapping, matches[0]);
  }
  if (previous) {
    if (previous.state !== 'committed' || !previous.result || pending.length) conflict('stored receipt is incomplete or no longer matches the chapter identities');
    return JSON.parse(previous.result!) as ReconcileChapterNumbersResult;
  }
  if (!pending.length) {
    const result = { operationId: request.operationId, work, updatedChapters: 0, updatedReadingStates: 0 };
    transaction(db, () => {
      authorizeCommit?.();
      db.prepare("INSERT INTO chapter_number_reconciliations(operation_id,work_id,request_hash,state,result) VALUES(?,?,?,'committed',?)").run(request.operationId, workId, requestHash, JSON.stringify(result));
    });
    return result;
  }
  if (workRow.fingerprint !== request.expectedWorkRevision) conflict('work revision changed; obtain a fresh migration snapshot');
  const { plans, moves } = planMappings(db, dataDir, work, workRow, pending, request.operationId);
  const metadataPath = join(workRow.directory, 'novel.json');
  const before = metadataBytes(dataDir, metadataPath);
  const raw = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
  const metadata = parseNovelMetadata(raw);
  if (canonicalize(metadata.identity) !== canonicalize(work.metadata.identity)) conflict('work metadata identity changed');
  if (canonicalize(metadata.novel) !== canonicalize(work.metadata.novel) ||
    canonicalize(canonicalWorkChapters(db, metadata.identity, metadata.chapters)) !== canonicalize(work.metadata.chapters)) conflict('work metadata changed after the snapshot');
  const chapters = { ...work.metadata.chapters };
  for (const plan of plans) {
    const { mapping, row } = plan;
    chapters[mapping.to] = chapters[mapping.from] ?? (JSON.parse(row!.entry) as CatalogEntry).manifest.chapter.name;
    delete chapters[mapping.from];
  }
  const updatedDocument = { ...raw, chapters };
  const updatedMetadata = parseNovelMetadata(updatedDocument);
  const after = Buffer.from(JSON.stringify(updatedDocument, null, 2) + '\n');
  const journal: Journal = { version: 1, workId, directory: workRow.directory,
    metadata: { path: metadataPath, before: before.toString('base64'), after: after.toString('base64'), beforeHash: digest(before), afterHash: digest(after),
      mode: lstatSync(chapterStoragePath(dataDir, metadataPath)).mode & 0o777 }, moves };
  // A committed prepared record is the recovery authority before any rename.
  transaction(db, () => {
    const occupied = db.prepare("SELECT 1 FROM chapter_number_reconciliations WHERE work_id=? AND state='prepared'").get(workId);
    if (occupied) conflict('another operation is awaiting recovery');
    db.prepare("INSERT INTO chapter_number_reconciliations(operation_id,work_id,request_hash,state,journal) VALUES(?,?,?,'prepared',?)").run(request.operationId, workId, requestHash, JSON.stringify(journal));
  });
  try {
    return transaction(db, () => {
      const prepared = db.prepare("SELECT request_hash,journal FROM chapter_number_reconciliations WHERE operation_id=? AND work_id=? AND state='prepared'").get(request.operationId, workId) as { request_hash: string; journal: string } | undefined;
      if (!prepared || prepared.request_hash !== requestHash || prepared.journal !== JSON.stringify(journal)) conflict('prepared operation changed before commit');
      const current = db.prepare('SELECT directory,entry,fingerprint FROM works WHERE id=?').get(workId) as unknown as WorkRow | undefined;
      if (!current || canonicalize(current) !== canonicalize(workRow)) conflict('work changed before commit');
      if (digest(metadataBytes(dataDir, metadataPath)) !== journal.metadata.beforeHash) conflict('work metadata changed before commit');
      for (const plan of plans) {
        if (plan.row) {
          const row = db.prepare('SELECT * FROM chapters WHERE id=?').get(plan.row.id);
          if (canonicalize(row) !== canonicalize(plan.row)) conflict('chapter changed before commit');
        }
      }
      for (const move of moves) {
        const from = chapterStoragePath(dataDir, move.from); const to = chapterStoragePath(dataDir, move.to);
        if (!sameDirectory(from, move) || present(to)) conflict('chapter folders changed before commit');
        renameSync(from, to); fsyncDirectory(dirname(from));
      }
      durableWrite(chapterStoragePath(dataDir, metadataPath), after, journal.metadata.mode);
      // This uncommitted state releases only this connection's ordinary guards.
      // Other connections still see prepared until all catalog changes commit.
      db.prepare("UPDATE chapter_number_reconciliations SET state='committed' WHERE operation_id=?").run(request.operationId);
      for (const plan of plans) {
        const a = plan.alias;
        db.prepare('INSERT INTO chapter_number_aliases(work_id,from_number,to_number,chapter_path,source_chapter_path,chapter_id,operation_id) VALUES(?,?,?,?,?,?,?)').run(a.work_id, a.from_number, a.to_number, a.chapter_path, a.source_chapter_path, a.chapter_id, a.operation_id);
        if (plan.row) {
          const entry = JSON.parse(plan.row.entry) as CatalogEntry;
          const manifest = { ...entry.manifest, identity: { ...entry.manifest.identity, chapterPath: plan.mapping.chapterPath },
            chapter: { ...entry.manifest.chapter, chapterNumber: plan.mapping.to, position: Number(plan.mapping.to) } };
          db.prepare('UPDATE chapters SET directory=?,path=? WHERE id=?').run(plan.directory, plan.path, plan.row.id);
          const updated = recordEntry(db, { ...entry, manifest, revision: digest(canonicalize(manifest)) });
          if (updated.deleted) db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(updated.id, updated.sequence);
        }
        db.prepare('DELETE FROM scan_checkpoints WHERE path IN (?,?)').run(chapterStoragePath(dataDir, join(workRow.directory, plan.mapping.from)), chapterStoragePath(dataDir, plan.directory));
      }
      db.prepare('DELETE FROM scan_checkpoints WHERE path=?').run(chapterStoragePath(dataDir, metadataPath));
      const updatedReadingStates = readingStates(db, work.metadata.identity);
      const updatedWork = cacheWork(db, dataDir, workRow.directory, updatedMetadata);
      const result = { operationId: request.operationId, work: updatedWork, updatedChapters: plans.length, updatedReadingStates };
      authorizeCommit?.();
      db.prepare("UPDATE chapter_number_reconciliations SET journal=NULL,result=? WHERE operation_id=? AND state='committed'").run(JSON.stringify(result), request.operationId);
      return result;
    });
  } catch (error) {
    // A failed rollback keeps prepared durable and makes this work read-only.
    try { recoverChapterNumberReconciliations(db, dataDir, workId); }
    catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Chapter number reconciliation conflict: storage recovery requires attention'); }
    throw error;
  }
}

export function registerChapterNumberReconciliation(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; requireRead: (request: FastifyRequest) => void; notify: () => void }): void {
  const { db, dataDir, requireRead, notify } = context;
  app.get<{ Params: { id: string } }>('/api/v1/works/:id/chapter-number-mappings', {
    schema: { security: [{ bearerAuth: [] }, {}],
      description: 'Read every proven chapter-number mapping for this work, including metadata-only chapters, with its current metadata and migration-snapshot revision. Clients reconcile local storage before importing the returned work. An unreconciled work returns an empty mapping list.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    },
  }, async (request, reply) => {
    requireRead(request); reply.header('Cache-Control', 'no-store');
    return chapterNumberMappingsSnapshot(db, dataDir, request.params.id);
  });
  const number = { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 16 };
  app.post<{ Params: { id: string }; Body: ReconcileChapterNumbersRequest }>('/api/v1/works/:id/reconcile-chapter-numbers', {
    bodyLimit: metadataByteLimit,
    onRequest: async request => { authenticateDevice(db, request); },
    schema: { security: [{ bearerAuth: [] }],
      description: 'Reconcile explicitly mapped same-work chapter numbers while preserving chapter IDs, original payload bytes, tombstones and reading progress. Obtain expectedWorkRevision from migration-snapshot. Disjoint positive integer mappings only; durable receipts make exact retries idempotent.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
      body: { type: 'object', additionalProperties: false, required: ['operationId', 'expectedWorkRevision', 'mappings'], properties: {
        operationId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
        expectedWorkRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        mappings: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'object', additionalProperties: false, required: ['chapterPath', 'from', 'to'],
          properties: { chapterPath: { type: 'string', minLength: 1, maxLength: 4096 }, from: number, to: number } } },
      } },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = reconcileChapterNumbers(db, dataDir, request.params.id, request.body, () => { authenticateDevice(db, request); });
    notify(); return result;
  });
}
