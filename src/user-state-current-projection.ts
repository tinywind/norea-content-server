import type { DatabaseSync } from 'node:sqlite';
import { userStateWorkKey, type UserStateChapterReference, type UserStateValueMap } from './user-state-protocol.ts';
import type { UserStateCurrentItem } from './user-state-current-protocol.ts';
import type { StoredWorkMigrationLineage } from './work-migration-lineage.ts';

type Migration = StoredWorkMigrationLineage;
const reference = (work: Migration['sourceWork']) => ({ pluginId: work.identity.pluginId, sourceNovelId: work.identity.novelId, novelPath: work.identity.novelPath, name: work.metadata.novel.name });

/** Resolve only active exact lineage; no title, display number or local row-ID guesses. */
export function currentStateMigrationProjection(db: DatabaseSync): (item: UserStateCurrentItem) => UserStateCurrentItem | null {
  const edges = new Map<string, Migration | null>();
  for (const row of db.prepare('SELECT l.entry FROM work_migration_lineage l JOIN work_migration_events e ON e.operation_id=l.operation_id WHERE e.active=1 AND e.sequence=(SELECT max(sequence) FROM work_migration_events WHERE operation_id=l.operation_id) ORDER BY e.sequence').iterate()) {
    const lineage = JSON.parse(row.entry as string) as Migration;
    const key = userStateWorkKey(reference(lineage.sourceWork));
    // More than one active edge for a work is ambiguous, even if labels agree.
    edges.set(key, edges.has(key) ? null : lineage);
  }
  const chapterTarget = (chapter: UserStateChapterReference, edge: Migration): UserStateChapterReference | null => {
    if (/^norea-(?:composed|source):/.test(chapter.chapterPath)) {
      const original = edge.sourceWork.metadata.chapterComposition?.entries.find(entry => entry.path === chapter.chapterPath);
      if (!original || original.id !== chapter.compositionEntryId) return null;
    }
    const decisions = edge.chapterDecisions.filter(decision => decision.sourceChapterPath === chapter.chapterPath);
    if (decisions.length !== 1 || decisions[0].targetChapterPath === null) return null;
    const path = decisions[0].targetChapterPath;
    if (/^norea-(?:composed|source):/.test(path)) {
      const target = edge.targetWork.metadata.chapterComposition?.entries.find(entry => entry.path === path);
      return target ? { chapterPath: path, compositionEntryId: target.id } : null;
    }
    return { chapterPath: path };
  };
  return original => {
    let item = original;
    const seen = new Set<string>();
    for (let depth = 0; depth < 64; depth++) {
      if (item.entity.kind === 'category') return item;
      const key = userStateWorkKey(item.entity.work);
      if (!edges.has(key)) return item;
      const edge = edges.get(key);
      if (!edge || seen.has(key) || item.entity.kind === 'composition') return null;
      seen.add(key);
      const work = reference(edge.targetWork);
      if (item.entity.kind === 'reading' || item.entity.kind === 'bookmark') {
        const chapter = chapterTarget(item.entity.chapter, edge);
        if (!chapter) return null;
        item = { ...item, entity: { ...item.entity, work, chapter } };
      } else if (item.entity.kind === 'resume') {
        const value = item.value as UserStateValueMap['resume'];
        if (!value.chapter) return null;
        const chapter = chapterTarget(value.chapter, edge);
        if (!chapter) return null;
        const copied = edge.mappings.some(mapping => mapping.decision === 'copy-source' && mapping.source.chapterPath === value.chapter!.chapterPath && mapping.target.chapterPath === chapter.chapterPath);
        item = { entity: { ...item.entity, work }, value: { ...value, chapter, anchor: copied ? value.anchor : null } };
      } else item = { ...item, entity: { ...item.entity, work } };
    }
    return null;
  };
}
