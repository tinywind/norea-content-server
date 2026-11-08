import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { problem } from './db.ts';
import type { PackageManifest } from './packages.ts';

export interface ChapterNumberAlias {
  work_id: string;
  from_number: string;
  to_number: string;
  chapter_path: string;
  source_chapter_path: string;
  chapter_id: string;
  operation_id: string;
}
type WorkIdentity = { pluginId: string; novelPath: string; novelId?: string };
type ChapterIdentity = WorkIdentity & { chapterPath: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const numberMappingWorkId = (identity: WorkIdentity) => hash([identity.pluginId, identity.novelPath]);
const sourceChapterId = (identity: ChapterIdentity) => hash([identity.pluginId, identity.novelPath, identity.chapterPath]);

export function assertChapterNumberReconciliationReady(db: DatabaseSync, workId: string): void {
  if (db.prepare("SELECT 1 FROM chapter_number_reconciliations WHERE work_id=? AND state='prepared'").get(workId)) {
    throw problem(409, 'Chapter number reconciliation conflict: unfinished storage recovery must complete first');
  }
}

function verifyAlias(db: DatabaseSync, identity: WorkIdentity, alias: ChapterNumberAlias): ChapterNumberAlias {
  const operation = db.prepare("SELECT work_id FROM chapter_number_reconciliations WHERE operation_id=? AND state='committed'").get(alias.operation_id) as { work_id: string } | undefined;
  if (operation?.work_id !== alias.work_id) throw problem(409, 'Chapter number reconciliation conflict: registered alias has no committed same-work operation');
  if (alias.work_id !== numberMappingWorkId(identity) ||
    alias.chapter_id !== sourceChapterId({ ...identity, chapterPath: alias.source_chapter_path }) ||
    (alias.source_chapter_path !== alias.chapter_path && alias.source_chapter_path !== 'norea-folder:' + alias.from_number)) {
    throw problem(409, 'Chapter number reconciliation conflict: registered chapter-number alias has an invalid identity proof');
  }
  const row = db.prepare('SELECT work_id,entry FROM chapters WHERE id=?').get(alias.chapter_id) as { work_id: string; entry: string } | undefined;
  if (row) {
    const stored = JSON.parse(row.entry).manifest.identity as ChapterIdentity;
    if (row.work_id !== alias.work_id || stored.pluginId !== identity.pluginId || stored.novelPath !== identity.novelPath ||
      (identity.novelId !== undefined && stored.novelId !== identity.novelId) ||
      ![alias.chapter_path, alias.source_chapter_path].includes(stored.chapterPath)) {
      throw problem(409, 'Chapter number reconciliation conflict: registered chapter-number alias belongs to another source identity');
    }
  }
  return alias;
}

export function chapterNumberAliases(db: DatabaseSync, identity: WorkIdentity): ChapterNumberAlias[] {
  assertChapterNumberReconciliationReady(db, numberMappingWorkId(identity));
  return (db.prepare('SELECT * FROM chapter_number_aliases WHERE work_id=?').all(numberMappingWorkId(identity)) as unknown as ChapterNumberAlias[])
    .map(alias => verifyAlias(db, identity, alias));
}

function aliasForPath(db: DatabaseSync, identity: ChapterIdentity): ChapterNumberAlias | undefined {
  assertChapterNumberReconciliationReady(db, numberMappingWorkId(identity));
  const folderNumber = identity.chapterPath.startsWith('norea-folder:') ? identity.chapterPath.slice('norea-folder:'.length) : null;
  const matches = (db.prepare(`SELECT * FROM chapter_number_aliases WHERE work_id=? AND
    (chapter_path=? OR source_chapter_path=? OR from_number=? OR to_number=?)`)
    .all(numberMappingWorkId(identity), identity.chapterPath, identity.chapterPath, folderNumber, folderNumber) as unknown as ChapterNumberAlias[])
    .map(alias => verifyAlias(db, identity, alias));
  if (matches.length > 1) throw problem(409, 'Chapter number reconciliation conflict: multiple registered aliases match the chapter identity');
  return matches[0];
}

function aliasForNumber(db: DatabaseSync, identity: WorkIdentity, number: string): ChapterNumberAlias | undefined {
  assertChapterNumberReconciliationReady(db, numberMappingWorkId(identity));
  const matches = (db.prepare('SELECT * FROM chapter_number_aliases WHERE work_id=? AND (from_number=? OR to_number=?)')
    .all(numberMappingWorkId(identity), number, number) as unknown as ChapterNumberAlias[]).map(alias => verifyAlias(db, identity, alias));
  if (matches.length > 1) throw problem(409, 'Chapter number reconciliation conflict: multiple registered aliases match the chapter number');
  return matches[0];
}

/** Only a persisted same-work reconciliation may preserve an older folder ID. */
export function chapterIdentityId(db: DatabaseSync, identity: ChapterIdentity): string {
  return aliasForPath(db, identity)?.chapter_id ?? sourceChapterId(identity);
}

export function canonicalChapterNumber(db: DatabaseSync, identity: WorkIdentity, number: string): string {
  return aliasForNumber(db, identity, number)?.to_number ?? number;
}

export function canonicalChapterManifest(db: DatabaseSync, manifest: PackageManifest): PackageManifest {
  const alias = aliasForPath(db, manifest.identity);
  const number = manifest.chapter.chapterNumber ?? String(manifest.chapter.position);
  if (!alias) {
    if (aliasForNumber(db, manifest.identity, String(Number(number)))) {
      throw problem(409, 'Chapter number reconciliation conflict: chapter number belongs to a different registered path');
    }
    return manifest;
  }
  if (number != null && ![alias.from_number, alias.to_number].includes(String(Number(number)))) {
    throw problem(409, 'Chapter number reconciliation conflict: chapter number conflicts with its registered mapping');
  }
  return {
    ...manifest,
    identity: { ...manifest.identity, chapterPath: alias.chapter_path },
    chapter: { ...manifest.chapter, chapterNumber: alias.to_number, position: Number(alias.to_number) },
  };
}

export function canonicalWorkChapters(db: DatabaseSync, identity: WorkIdentity, chapters: Record<string, string>): Record<string, string> {
  const canonical = { ...chapters };
  for (const alias of chapterNumberAliases(db, identity)) {
    if (!Object.hasOwn(chapters, alias.from_number)) continue;
    if (!Object.hasOwn(chapters, alias.to_number)) canonical[alias.to_number] = chapters[alias.from_number];
    delete canonical[alias.from_number];
  }
  return canonical;
}

export function canonicalReadingIdentity(
  db: DatabaseSync,
  entry: { pluginId: string; sourceNovelId: string | null; novelPath: string; chapterPath: string; chapterNumber: string | null },
): { chapterPath: string; chapterNumber: string | null } {
  const identity = { pluginId: entry.pluginId, novelPath: entry.novelPath };
  const work = db.prepare('SELECT entry FROM works WHERE id=?').get(numberMappingWorkId(identity)) as { entry: string } | undefined;
  if (work && entry.sourceNovelId !== null &&
    JSON.parse(work.entry).metadata.identity.novelId.toLowerCase() !== entry.sourceNovelId.toLowerCase()) {
    return { chapterPath: entry.chapterPath, chapterNumber: entry.chapterNumber };
  }
  const alias = aliasForPath(db, { ...identity, chapterPath: entry.chapterPath });
  if (!alias) {
    if (entry.chapterNumber !== null && aliasForNumber(db, identity, entry.chapterNumber)) {
      throw problem(409, 'Chapter number reconciliation conflict: reading number belongs to a different registered path');
    }
    return { chapterPath: entry.chapterPath, chapterNumber: entry.chapterNumber };
  }
  if (entry.chapterNumber !== null && ![alias.from_number, alias.to_number].includes(entry.chapterNumber)) {
    throw problem(409, 'Chapter number reconciliation conflict: reading state disagrees with its registered chapter identity');
  }
  return { chapterPath: alias.chapter_path, chapterNumber: alias.to_number };
}
