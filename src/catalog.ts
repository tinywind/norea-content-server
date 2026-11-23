import { canonicalChapterNumber, chapterIdentityId } from './chapter-number-mappings.ts';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { problem } from './db.ts';
import { authenticate } from './auth.ts';
import { chapterPayloadHash, inspectChapterInventory } from './chapter-inventory.ts';
import { availableChapter, digest } from './packages.ts';
import type { CatalogEntry, Limits } from './packages.ts';
import { userStateWorkKey } from './user-state-protocol.ts';
import { applyWorkOverrideToNovel, overrideCoverBytes, overrideCoverBytesForWork, parseWorkOverride, type WorkOverrideV1 } from './work-overrides.ts';
import { readWorkCover, NOVEL_STATUS_VALUES, type NovelMetadataV1, type NovelStatusValue, type WorkEntry } from './works.ts';

interface WorkSummary {
  id: string;
  sequence: number;
  overrideRevision?: number;
  identity: NovelMetadataV1['identity'];
  novel: NovelMetadataV1['novel'];
  hasCover: boolean;
  chapterCount: number;
}
const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const identityText = { type: 'string', minLength: 1, maxLength: 4096 };
const count = { type: 'integer', minimum: 0 };
const chapterSummarySchema = { type: 'object', required: ['id', 'chapterPath', 'position', 'name', 'chapterNumber', 'page', 'contentType', 'complete'], properties: {
  id: text, chapterPath: text, position: { type: 'number' }, name: text, chapterNumber: nullableText, page: text, contentType: { type: 'string', enum: ['html', 'text', 'markdown', 'pdf', 'epub'] }, complete: { type: 'boolean' },
} };
const chapterDigestSchema = { type: 'object', required: ['id', 'revision', 'chapterPath', 'chapterNumber', 'position', 'complete', 'payloadHash', 'bodySha256', 'bodyBytes'], properties: {
  id: text, revision: text, chapterPath: text, chapterNumber: nullableText, position: { type: 'number' }, complete: { type: 'boolean' },
  payloadHash: nullableText, bodySha256: nullableText, bodyBytes: { type: ['integer', 'null'], minimum: 0 }, error: text,
} };
const chapterChangeSchema = { type: 'object', required: ['identity', 'complete', 'deleted', 'sequence'], properties: {
  identity: { type: 'object', required: ['pluginId', 'novelId', 'novelPath', 'chapterPath'], properties: { pluginId: text, novelId: text, novelPath: text, chapterPath: text } },
  complete: { type: 'boolean' }, deleted: { type: 'boolean' }, sequence: count,
} };
const workSummarySchema = { type: 'object', required: ['id', 'sequence', 'identity', 'novel', 'hasCover', 'chapterCount'], properties: {
  id: text, sequence: count, overrideRevision: count,
  identity: { type: 'object', required: ['pluginId', 'novelId', 'novelPath'], properties: { pluginId: text, novelId: text, novelPath: text } },
  novel: { type: 'object', required: ['name', 'author', 'artist', 'summary', 'status', 'rating', 'genres', 'isLocal'], properties: { name: text, author: nullableText, artist: nullableText, summary: nullableText, status: { type: ['string', 'null'], enum: [...NOVEL_STATUS_VALUES, null] }, rating: { type: ['number', 'null'], minimum: 0, maximum: 5 }, genres: nullableText, isLocal: { type: 'boolean' } } },
  hasCover: { type: 'boolean' }, chapterCount: count,
} };
const pagination = (limit: number) => ({ offset: { ...count, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: limit } });
const pageSchema = (item: object) => ({ type: 'object', required: ['items', 'total', 'hasMore'], properties: { items: { type: 'array', items: item }, total: count, hasMore: { type: 'boolean' } } });
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, {}];
const workParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
const effectiveWorkName = `CASE
  WHEN json_type(o.document,'$.fields.name.value')='text' AND trim(json_extract(o.document,'$.fields.name.value'))<>''
    THEN trim(json_extract(o.document,'$.fields.name.value'))
  ELSE json_extract(w.novel_json,'$.name')
END`;
const rawEffectiveWorkStatus = `CASE
  WHEN json_type(o.document,'$.fields.status.value')='text' THEN json_extract(o.document,'$.fields.status.value')
  WHEN json_type(o.document,'$.fields.completed.value')='true' THEN 'Completed'
  WHEN json_type(o.document,'$.fields.completed.value')='false' THEN 'Ongoing'
  ELSE COALESCE(json_extract(w.novel_json,'$.status'),'')
END`;
/** Canonical 0.2 publication status for a work; missing or legacy values fall back to `Ongoing`. */
const effectiveWorkStatus = `CASE
  WHEN trim(${rawEffectiveWorkStatus}) IN ('Ongoing','Completed','Cancelled','On Hiatus')
    THEN trim(${rawEffectiveWorkStatus})
  ELSE 'Ongoing'
END`;
const effectiveWorkGenres = `CASE
  WHEN json_type(o.document,'$.fields.genres.value')='text'
    THEN NULLIF(trim(json_extract(o.document,'$.fields.genres.value')),'')
  ELSE NULLIF(trim(COALESCE(json_extract(w.novel_json,'$.genres'),'')),'')
END`;

const categoryIdSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' };
const statusFilterSchema = {
  anyOf: [
    { type: 'string', enum: [...NOVEL_STATUS_VALUES] },
    { type: 'array', items: { type: 'string', enum: [...NOVEL_STATUS_VALUES] }, maxItems: NOVEL_STATUS_VALUES.length },
  ],
};
const categoryFilterSchema = {
  anyOf: [
    categoryIdSchema,
    { type: 'array', items: categoryIdSchema, maxItems: 64 },
  ],
};
const tagFilterSchema = {
  anyOf: [
    { type: 'string', minLength: 1, maxLength: 500 },
    { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, maxItems: 64 },
  ],
};
const catalogFilterQuerystringProperties = {
  q: { type: 'string', maxLength: 500 },
  source: identityText,
  status: statusFilterSchema,
  category: categoryFilterSchema,
  uncategorized: { type: 'boolean' },
  tag: tagFilterSchema,
};

interface CatalogFilterQuery {
  q?: string;
  source?: string;
  status?: NovelStatusValue | NovelStatusValue[];
  category?: string | string[];
  uncategorized?: boolean;
  tag?: string | string[];
}

function toStringList<T extends string>(value?: T | T[]): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim();
}

function splitNovelTags(raw: string | null): string[] {
  if (!raw) return [];
  const normalized = raw.replace(/[\r\n\t]/g, ' ').replaceAll(' #', ',');
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of normalized.split(/[,|]/)) {
    const cleaned = normalizeTag(part);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(cleaned);
    }
  }
  return tags;
}

interface ActiveCategory {
  id: string;
  name: string;
  sort: number;
}

interface WorkCategoryState {
  categories: ActiveCategory[];
  resolveCategoryId: (id: string) => string;
  categoriesOf: (work: { pluginId: string; novelId: string; novelPath: string }) => ReadonlySet<string>;
}

function loadWorkCategoryState(db: DatabaseSync): WorkCategoryState {
  const categories = db.prepare(`SELECT json_extract(record,'$.entity.categoryId') AS id, category_name AS name,
    CAST(json_extract(record,'$.value.sort') AS INTEGER) AS sort
    FROM user_state_records WHERE kind='category' AND category_deleted=0
    ORDER BY sort ASC, name ASC`).all() as unknown as ActiveCategory[];
  const activeIds = new Set(categories.map(category => category.id));
  const aliases = new Map(
    (db.prepare('SELECT alias_id, canonical_id FROM user_state_category_aliases').all() as { alias_id: string; canonical_id: string }[])
      .map(row => [row.alias_id, row.canonical_id]),
  );
  const resolveCategoryId = (id: string) => aliases.get(id) ?? id;
  const memberships = db.prepare(`SELECT membership_category_id AS categoryId,
    json_extract(record,'$.entity.work.pluginId') AS pluginId,
    json_extract(record,'$.entity.work.sourceNovelId') AS sourceNovelId,
    json_extract(record,'$.entity.work.novelPath') AS novelPath
    FROM user_state_records WHERE kind='membership' AND membership_included=1`).all() as {
      categoryId: string | null; pluginId: string | null; sourceNovelId: string | null; novelPath: string | null;
    }[];
  const byWorkKey = new Map<string, Set<string>>();
  for (const row of memberships) {
    if (!row.categoryId || !row.pluginId || !row.novelPath) continue;
    const canonical = resolveCategoryId(row.categoryId);
    if (!activeIds.has(canonical)) continue;
    const key = userStateWorkKey({
      pluginId: row.pluginId,
      sourceNovelId: row.sourceNovelId,
      novelPath: row.novelPath,
      name: '',
    });
    let set = byWorkKey.get(key);
    if (!set) {
      set = new Set<string>();
      byWorkKey.set(key, set);
    }
    set.add(canonical);
  }
  const empty = new Set<string>();
  return {
    categories,
    resolveCategoryId,
    categoriesOf: work => {
      if (work.pluginId === 'local') return empty;
      const byPath = byWorkKey.get(userStateWorkKey({
        pluginId: work.pluginId,
        sourceNovelId: null,
        novelPath: work.novelPath,
        name: '',
      }));
      const byId = work.novelId
        ? byWorkKey.get(userStateWorkKey({
          pluginId: work.pluginId,
          sourceNovelId: work.novelId,
          novelPath: work.novelPath,
          name: '',
        }))
        : undefined;
      if (!byId && !byPath) return empty;
      if (!byId) return byPath!;
      if (!byPath) return byId;
      return new Set([...byId, ...byPath]);
    },
  };
}

function parseCatalogFilters(query: CatalogFilterQuery) {
  const statuses = [...new Set(toStringList(query.status))];
  const categories = [...new Set(toStringList(query.category))];
  const uncategorized = Boolean(query.uncategorized);
  const tagKeys: string[] = [];
  const seenTags = new Set<string>();
  for (const raw of toStringList(query.tag)) {
    const cleaned = normalizeTag(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (!seenTags.has(key)) {
      seenTags.add(key);
      tagKeys.push(key);
    }
  }
  return {
    q: query.q,
    source: query.source,
    statuses,
    categories,
    uncategorized,
    tagKeys,
  };
}

function matchesCategoryFilter(
  workCategories: ReadonlySet<string>,
  selectedCategories: ReadonlySet<string>,
  uncategorized: boolean,
): boolean {
  if (selectedCategories.size === 0 && !uncategorized) return true;
  if (uncategorized && workCategories.size === 0) return true;
  for (const categoryId of workCategories) {
    if (selectedCategories.has(categoryId)) return true;
  }
  return false;
}

function matchesTagFilter(workTagKeys: ReadonlySet<string>, requiredTagKeys: readonly string[]): boolean {
  for (const tagKey of requiredTagKeys) {
    if (!workTagKeys.has(tagKey)) return false;
  }
  return true;
}

interface SummaryRow {
  id: string; directory: string; sequence: number; pluginId: string; novelId: string; novelPath: string;
  novel: string; hasCover: number; overrideRevision: number | null; overrideDocument: string | null; chapterCount: number;
}
const summaryRows = `SELECT w.id,w.directory,w.sequence,w.plugin_id AS pluginId,w.novel_id AS novelId,w.novel_path AS novelPath,
  w.novel_json AS novel,w.has_cover AS hasCover,o.revision AS overrideRevision,o.document AS overrideDocument,
  (SELECT COUNT(*) FROM chapters c WHERE c.work_id=w.id AND c.deleted_at IS NULL AND c.path IS NOT NULL) AS chapterCount
  FROM work_summaries w LEFT JOIN work_overrides o ON o.work_id=w.id`;

function summarizeWork(dataDir: string, row: SummaryRow): WorkSummary {
  let override: WorkOverrideV1 | undefined;
  if (row.overrideDocument) {
    try { override = parseWorkOverride(JSON.parse(row.overrideDocument)); } catch { override = undefined; }
  }
  const novel = applyWorkOverrideToNovel(JSON.parse(row.novel) as NovelMetadataV1['novel'], override);
  return {
    id: row.id,
    sequence: row.sequence,
    ...(row.overrideRevision !== null ? { overrideRevision: row.overrideRevision } : {}),
    identity: { pluginId: row.pluginId, novelId: row.novelId, novelPath: row.novelPath },
    novel,
    hasCover: Boolean(row.hasCover) || (override !== undefined && overrideCoverBytes(join(dataDir, row.directory), override) !== undefined),
    chapterCount: row.chapterCount,
  };
}

export function registerCatalog(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; limits: Limits; requireRead: (request: FastifyRequest) => void; catalogSchema: object }): void {
  const { db, dataDir, limits, requireRead, catalogSchema } = context;
  app.get<{ Params: { id: string }; Querystring: { search: string; offset: number; limit: number } }>('/api/v1/admin/works/:id/chapters', { schema: {
    security: [{ bearerAuth: [] }],
    description: 'List the saved work chapter catalog with an available server copy when present. Missing or deleted bodies retain their catalog titles and have a null entry. Available files absent from the catalog remain visible.',
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    querystring: { type: 'object', additionalProperties: false, properties: { search: { type: 'string', maxLength: 500, default: '' }, ...pagination(50) } },
  } }, async (request, reply) => {
    authenticate(db, request, true); reply.header('Cache-Control', 'no-store');
    const row = db.prepare('SELECT entry FROM works WHERE id=?').get(request.params.id) as { entry: string } | undefined;
    if (!row) throw problem(404, 'Work not found');
    const work = JSON.parse(row.entry) as WorkEntry;
    const entries = db.prepare(`SELECT id,json_extract(entry,'$.fileBytes') AS fileBytes,json_extract(entry,'$.complete') AS complete,
      json_extract(entry,'$.manifest.chapter.chapterNumber') AS chapterNumber,json_extract(entry,'$.manifest.chapter.name') AS name,
      json_extract(entry,'$.manifest.chapter.position') AS position
      FROM chapters WHERE work_id=? AND deleted_at IS NULL AND path IS NOT NULL`).all(request.params.id) as {
        id: string; fileBytes: number; complete: number; chapterNumber: string | null; name: string; position: number;
      }[];
    const byNumber = new Map<string, typeof entries>();
    for (const entry of entries) {
      const number = entry.chapterNumber;
      if (number == null) continue;
      const key = String(Number(number));
      byNumber.set(key, [...(byNumber.get(key) ?? []), entry]);
    }
    const used = new Set<string>();
    const items: { chapterNumber: string | null; name: string; position: number; entry: { id: string; fileBytes: number; complete: boolean } | null }[] = [];
    for (const [number, name] of Object.entries(work.metadata.chapters)) {
      const matches = byNumber.get(number) ?? [];
      for (const entry of matches) used.add(entry.id);
      for (const entry of matches.length ? matches : [null]) items.push({ chapterNumber: number, name, position: Number(number), entry: entry ? { id: entry.id, fileBytes: entry.fileBytes, complete: Boolean(entry.complete) } : null });
    }
    for (const entry of entries) {
      if (used.has(entry.id)) continue;
      items.push({ chapterNumber: entry.chapterNumber, name: entry.name, position: Number(entry.chapterNumber ?? entry.position), entry: { id: entry.id, fileBytes: entry.fileBytes, complete: Boolean(entry.complete) } });
    }
    items.sort((a, b) => a.position - b.position || (a.entry?.id ?? '').localeCompare(b.entry?.id ?? ''));
    const { search, offset, limit } = request.query;
    const matching = search ? items.filter(item => `${item.chapterNumber ?? ''} ${item.name}`.toLowerCase().includes(search.toLowerCase())) : items;
    return { items: matching.slice(offset, offset + limit), total: matching.length, hasMore: offset + limit < matching.length };
  });
  app.get<{ Querystring: { after: number; limit: number } }>('/api/v1/catalog/changes', { schema: {
    security,
    description: 'Read ordered chapter availability changes without package manifests. Apply repeated identities in order, including deletion and restoration entries. The cursor advances to the last returned sequence and remains unchanged on an empty page.',
    querystring: { type: 'object', additionalProperties: false, properties: { after: { ...count, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } },
    response: { 200: { type: 'object', required: ['items', 'cursor', 'hasMore'], properties: { items: { type: 'array', items: chapterChangeSchema }, cursor: count, hasMore: { type: 'boolean' } } } },
  } }, async request => {
    requireRead(request);
    const { after, limit } = request.query;
    const rows = db.prepare(`SELECT sequence,json_extract(entry,'$.manifest.identity') AS identity,
      json_extract(entry,'$.complete') AS complete,json_extract(entry,'$.deleted') AS deleted FROM catalog_changes WHERE sequence>? ORDER BY sequence LIMIT ?`).all(after, limit + 1) as { sequence: number; identity: string; complete: number; deleted: number }[];
    const items = rows.slice(0, limit).map(row => ({ identity: JSON.parse(row.identity), complete: Boolean(row.complete), deleted: Boolean(row.deleted), sequence: row.sequence }));
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  });
  const allowedWorkQueryKeys = new Set(['q', 'source', 'status', 'category', 'uncategorized', 'tag', 'offset', 'limit']);
  const allowedFilterQueryKeys = new Set(['q', 'source', 'status', 'category', 'uncategorized', 'tag']);
  app.get<{ Querystring: CatalogFilterQuery & { offset: number; limit: number } }>('/api/v1/catalog/works', { preValidation: async request => {
    if (Object.keys(request.query as object).some(key => !allowedWorkQueryKeys.has(key))) {
      throw problem(400, 'Unexpected catalog query parameter');
    }
  }, schema: {
    security,
    description: 'Browse current indexed work summaries without synchronizing change history. Search matches a literal substring of the title (ASCII case-insensitive); source matches an exact plugin ID; status matches any selected canonical NovelStatus (effective override first, missing/legacy fallback to Ongoing); category and uncategorized match authenticated user-state category memberships (OR across selected categories and uncategorized); tag matches works containing every selected tag (AND, case-insensitive). chapterCount counts available nondeleted chapter packages regardless of media completeness. Ordered by title, then ID. Concurrent changes can shift offset pages.',
    querystring: { type: 'object', additionalProperties: false, properties: { ...catalogFilterQuerystringProperties, ...pagination(40) } },
    response: { 200: pageSchema(workSummarySchema) },
  } }, async request => {
    requireRead(request);
    const filters = parseCatalogFilters(request.query);
    const usesCategoryFilter = filters.categories.length > 0 || filters.uncategorized;
    if (usesCategoryFilter) authenticate(db, request);
    const { offset, limit } = request.query;
    const clauses: string[] = []; const args: string[] = [];
    if (filters.source) { clauses.push('w.plugin_id=?'); args.push(filters.source); }
    if (filters.q) { clauses.push(`instr(lower(${effectiveWorkName}),lower(?))>0`); args.push(filters.q); }
    if (filters.statuses.length > 0) {
      clauses.push(`${effectiveWorkStatus} IN (${filters.statuses.map(() => '?').join(',')})`);
      args.push(...filters.statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    if (!usesCategoryFilter && filters.tagKeys.length === 0) {
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM work_summaries w LEFT JOIN work_overrides o ON o.work_id=w.id ${where}`).get(...args) as { n: number }).n;
      const rows = db.prepare(`${summaryRows} ${where} ORDER BY ${effectiveWorkName},w.id LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as SummaryRow[];
      const items = rows.map(row => summarizeWork(dataDir, row));
      return { items, total, hasMore: offset + items.length < total };
    }
    const categoryState = usesCategoryFilter ? loadWorkCategoryState(db) : null;
    const selectedCategories = new Set(categoryState ? filters.categories.map(categoryState.resolveCategoryId) : []);
    const candidates = db.prepare(`SELECT w.id,w.plugin_id AS pluginId,w.novel_id AS novelId,w.novel_path AS novelPath,
      ${effectiveWorkGenres} AS genres
      FROM work_summaries w LEFT JOIN work_overrides o ON o.work_id=w.id ${where} ORDER BY ${effectiveWorkName},w.id`)
      .all(...args) as { id: string; pluginId: string; novelId: string; novelPath: string; genres: string | null }[];
    const matchedIds: string[] = [];
    for (const candidate of candidates) {
      if (categoryState && !matchesCategoryFilter(categoryState.categoriesOf(candidate), selectedCategories, filters.uncategorized)) continue;
      if (filters.tagKeys.length > 0) {
        const tagKeys = new Set(splitNovelTags(candidate.genres).map(tag => tag.toLowerCase()));
        if (!matchesTagFilter(tagKeys, filters.tagKeys)) continue;
      }
      matchedIds.push(candidate.id);
    }
    const total = matchedIds.length;
    const pageIds = matchedIds.slice(offset, offset + limit);
    if (pageIds.length === 0) return { items: [], total, hasMore: false };
    const pageRows = db.prepare(`${summaryRows} WHERE w.id IN (${pageIds.map(() => '?').join(',')})`).all(...pageIds) as unknown as SummaryRow[];
    const byId = new Map(pageRows.map(row => [row.id, row]));
    const items = pageIds.map(id => byId.get(id)).filter((row): row is SummaryRow => row !== undefined).map(row => summarizeWork(dataDir, row));
    return { items, total, hasMore: offset + items.length < total };
  });
  app.get<{ Querystring: CatalogFilterQuery }>('/api/v1/catalog/filters', { preValidation: async request => {
    if (Object.keys(request.query as object).some(key => !allowedFilterQueryKeys.has(key))) {
      throw problem(400, 'Unexpected catalog filter parameter');
    }
  }, schema: {
    security,
    description: 'List cross-filtered browse facets (sources, canonical publication statuses, authenticated user categories plus uncategorized count, and tags) for current indexed works.',
    querystring: { type: 'object', additionalProperties: false, properties: catalogFilterQuerystringProperties },
    response: { 200: {
      type: 'object',
      required: ['sources', 'statuses', 'categories', 'uncategorizedCount', 'tags'],
      properties: {
        sources: { type: 'array', items: { type: 'object', required: ['id', 'workCount'], properties: { id: text, workCount: count } } },
        statuses: { type: 'array', items: { type: 'object', required: ['status', 'workCount'], properties: { status: { type: 'string', enum: [...NOVEL_STATUS_VALUES] }, workCount: count } } },
        categories: { type: 'array', items: { type: 'object', required: ['id', 'name', 'workCount'], properties: { id: text, name: text, workCount: count } } },
        uncategorizedCount: count,
        tags: { type: 'array', items: { type: 'object', required: ['tag', 'workCount'], properties: { tag: text, workCount: count } } },
      },
    } },
  } }, async request => {
    requireRead(request);
    const filters = parseCatalogFilters(request.query);
    const usesCategoryFilter = filters.categories.length > 0 || filters.uncategorized;
    if (usesCategoryFilter) authenticate(db, request);
    const includeCategories = request.headers.authorization !== undefined;
    const categoryState = includeCategories ? loadWorkCategoryState(db) : null;
    const selectedCategories = new Set(categoryState ? filters.categories.map(categoryState.resolveCategoryId) : []);
    const selectedStatuses = new Set<NovelStatusValue>(filters.statuses);
    const qWhere = filters.q ? `WHERE instr(lower(${effectiveWorkName}),lower(?))>0` : '';
    const qArgs = filters.q ? [filters.q] : [];
    const rows = db.prepare(`SELECT w.plugin_id AS pluginId,w.novel_id AS novelId,w.novel_path AS novelPath,
      ${effectiveWorkStatus} AS status,${effectiveWorkGenres} AS genres
      FROM work_summaries w LEFT JOIN work_overrides o ON o.work_id=w.id ${qWhere}`).all(...qArgs) as {
        pluginId: string; novelId: string; novelPath: string; status: NovelStatusValue; genres: string | null;
      }[];
    const sourceCounts = new Map<string, number>();
    const statusCounts = new Map<NovelStatusValue, number>();
    const categoryCounts = new Map<string, number>();
    const tagCounts = new Map<string, { tag: string; workCount: number }>();
    let uncategorizedCount = 0;
    const emptyCategories = new Set<string>();
    for (const row of rows) {
      const workTags = splitNovelTags(row.genres);
      const workTagKeys = new Set(workTags.map(tag => tag.toLowerCase()));
      const workCategories = categoryState ? categoryState.categoriesOf(row) : emptyCategories;
      const matchSource = !filters.source || row.pluginId === filters.source;
      const matchStatus = selectedStatuses.size === 0 || selectedStatuses.has(row.status);
      const matchCategory = !includeCategories || matchesCategoryFilter(workCategories, selectedCategories, filters.uncategorized);
      const matchTags = matchesTagFilter(workTagKeys, filters.tagKeys);
      if (matchStatus && matchCategory && matchTags) {
        sourceCounts.set(row.pluginId, (sourceCounts.get(row.pluginId) ?? 0) + 1);
      }
      if (matchSource && matchCategory && matchTags) {
        statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
      }
      if (includeCategories && matchSource && matchStatus && matchTags) {
        if (workCategories.size === 0) uncategorizedCount += 1;
        else for (const categoryId of workCategories) categoryCounts.set(categoryId, (categoryCounts.get(categoryId) ?? 0) + 1);
      }
      if (matchSource && matchStatus && matchCategory && matchTags) {
        for (const tag of workTags) {
          const key = tag.toLowerCase();
          const current = tagCounts.get(key);
          if (current) current.workCount += 1;
          else tagCounts.set(key, { tag, workCount: 1 });
        }
      }
    }
    const sources = [...sourceCounts.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, workCount]) => ({ id, workCount }));
    const statuses = NOVEL_STATUS_VALUES
      .map(status => ({ status, workCount: statusCounts.get(status) ?? 0 }))
      .filter(entry => entry.workCount > 0);
    const categories = categoryState
      ? categoryState.categories.map(category => ({ id: category.id, name: category.name, workCount: categoryCounts.get(category.id) ?? 0 }))
      : [];
    const tags = [...tagCounts.values()].sort((left, right) =>
      right.workCount - left.workCount
      || left.tag.toLowerCase().localeCompare(right.tag.toLowerCase())
      || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0));
    return { sources, statuses, categories, uncategorizedCount, tags };
  });
  app.get<{ Params: { id: string } }>('/api/v1/catalog/works/:id', { schema: {
    security, params: workParams, response: { 200: workSummarySchema },
  } }, async request => {
    requireRead(request);
    const row = db.prepare(`${summaryRows} WHERE w.id=?`).get(request.params.id) as SummaryRow | undefined;
    if (!row) throw problem(404, 'Work not found');
    return summarizeWork(dataDir, row);
  });
  app.get<{ Params: { id: string } }>('/api/v1/catalog/works/:id/cover', { schema: {
    security,
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    description: 'Read the effective cover image of a work (active cover.override image first, otherwise the source cover).',
  } }, async (request, reply) => {
    requireRead(request);
    const overrideCover = overrideCoverBytesForWork(db, dataDir, request.params.id);
    if (overrideCover) {
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").type(overrideCover.contentType ?? 'application/octet-stream').send(overrideCover.bytes);
    }
    const cover = readWorkCover(db, dataDir, request.params.id);
    if (!cover) throw problem(404, 'Cover not found');
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").type(cover.contentType ?? 'application/octet-stream').send(cover.bytes);
  });
  app.get('/api/v1/catalog/sources', { schema: {
    security,
    description: 'List source IDs represented by indexed works, including works with no available chapter packages.',
    response: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id', 'workCount'], properties: { id: text, workCount: count } } } } } },
  } }, async request => {
    requireRead(request);
    return { items: db.prepare("SELECT plugin_id AS id,COUNT(*) AS workCount FROM work_summaries GROUP BY plugin_id ORDER BY plugin_id").all() };
  });
  app.get<{ Params: { id: string }; Querystring: { offset: number; limit: number } }>('/api/v1/catalog/works/:id/chapters', { schema: {
    security,
    description: 'Page current nondeleted chapter summaries ordered by position, then ID. Summaries include media completeness as status and exclude package file manifests. An unknown work returns 404; a known work without packages returns an empty page.',
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    querystring: { type: 'object', additionalProperties: false, properties: pagination(100) },
    response: { 200: pageSchema(chapterSummarySchema) },
  } }, async request => {
    requireRead(request);
    const { id } = request.params; const { offset, limit } = request.query;
    const work = db.prepare('SELECT entry FROM works WHERE id=?').get(id) as { entry: string } | undefined;
    if (!work && !db.prepare('SELECT 1 FROM chapters WHERE work_id=? LIMIT 1').get(id)) throw problem(404, 'Work not found');
    const titles = work ? (JSON.parse(work.entry) as WorkEntry).metadata.chapters : {};
    const total = (db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE work_id=? AND deleted_at IS NULL AND path IS NOT NULL").get(id) as { n: number }).n;
    const items = db.prepare(`SELECT id,json_extract(entry,'$.manifest.identity.chapterPath') AS chapterPath,
      json_extract(entry,'$.manifest.chapter.position') AS position,json_extract(entry,'$.manifest.chapter.name') AS name,
      json_extract(entry,'$.manifest.chapter.chapterNumber') AS chapterNumber,json_extract(entry,'$.manifest.chapter.page') AS page,json_extract(entry,'$.manifest.chapter.contentType') AS contentType,json_extract(entry,'$.complete') AS complete
      FROM chapters WHERE work_id=? AND deleted_at IS NULL AND path IS NOT NULL ORDER BY json_extract(entry,'$.manifest.chapter.position'),id LIMIT ? OFFSET ?`).all(id, limit, offset);
    return { items: items.map(item => ({ ...item, complete: Boolean(item.complete), name: titles[String(Number(item.chapterNumber))] ?? item.name })), total, hasMore: offset + items.length < total };
  });
  app.get<{ Params: { id: string }; Querystring: { offset: number; limit: number } }>('/api/v1/catalog/works/:id/chapter-digests', { schema: {
    security,
    description: 'Page precomputed chapter payload digests for a work ordered by position, then ID. Missing digests are inspected on demand and persisted.',
    params: workParams,
    querystring: { type: 'object', additionalProperties: false, properties: { offset: { ...count, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 5000, default: 2000 } } },
    response: { 200: pageSchema(chapterDigestSchema) },
  } }, async (request, reply) => {
    requireRead(request);
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params;
    const { offset, limit } = request.query;
    const work = db.prepare('SELECT 1 FROM works WHERE id=?').get(id);
    if (!work && !db.prepare('SELECT 1 FROM chapters WHERE work_id=? LIMIT 1').get(id)) throw problem(404, 'Work not found');
    const total = (db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE work_id=? AND deleted_at IS NULL AND path IS NOT NULL').get(id) as { n: number }).n;
    const rows = db.prepare(`SELECT c.id,
      json_extract(c.entry, '$.revision') AS revision,
      json_extract(c.entry, '$.manifest.identity.chapterPath') AS chapterPath,
      json_extract(c.entry, '$.manifest.chapter.chapterNumber') AS chapterNumber,
      json_extract(c.entry, '$.manifest.chapter.position') AS position,
      json_extract(c.entry, '$.complete') AS complete,
      d.payload_hash AS payloadHash,
      d.body_sha256 AS bodySha256,
      d.body_bytes AS bodyBytes
      FROM chapters c
      LEFT JOIN chapter_inventory_digests d
        ON d.chapter_id = c.id AND d.revision = json_extract(c.entry, '$.revision')
      WHERE c.work_id = ? AND c.deleted_at IS NULL AND c.path IS NOT NULL
      ORDER BY json_extract(c.entry, '$.manifest.chapter.position'), c.id
      LIMIT ? OFFSET ?`).all(id, limit, offset) as {
        id: string;
        revision: string;
        chapterPath: string;
        chapterNumber: string | null;
        position: number;
        complete: number;
        payloadHash: string | null;
        bodySha256: string | null;
        bodyBytes: number | null;
      }[];
    const items = rows.map(row => ({
      id: row.id,
      revision: row.revision,
      chapterPath: row.chapterPath,
      chapterNumber: row.chapterNumber,
      position: row.position,
      complete: Boolean(row.complete),
      payloadHash: row.payloadHash,
      bodySha256: row.bodySha256,
      bodyBytes: row.bodyBytes,
      error: undefined as string | undefined,
    }));
    const missing = items.filter(item => item.payloadHash === null);
    if (missing.length > 0) {
      const controller = new AbortController();
      const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once('close', onClose);
      try {
        let cursor = 0;
        const worker = async () => {
          while (cursor < missing.length && !controller.signal.aborted) {
            const item = missing[cursor++];
            try {
              const inspected = await inspectChapterInventory(db, dataDir, item.id, item.revision, limits, false, {
                signal: controller.signal,
                queue: true,
              });
              if (inspected.inventory.body) {
                item.payloadHash = chapterPayloadHash(inspected.inventory);
                item.bodySha256 = inspected.inventory.body.sha256;
                item.bodyBytes = inspected.inventory.body.bytes;
              }
            } catch (error) {
              if (controller.signal.aborted) return;
              item.error = error instanceof Error ? error.message : String(error);
            }
          }
        };
        const concurrency = Math.min(2, missing.length);
        await Promise.all(Array.from({ length: concurrency }, worker));
      } finally {
        reply.raw.off('close', onClose);
      }
    }
    return {
      items: items.map(({ error, ...rest }) => error === undefined ? rest : { ...rest, error }),
      total,
      hasMore: offset + items.length < total,
    };
  });
  app.get<{ Querystring: { pluginId: string; novelPath: string; chapterPath: string; chapterNumber?: string; includeUnavailable?: boolean } }>('/api/v1/catalog/chapter', { schema: {
    security,
    description: 'Resolve a package by exact source identity, then optional chapter number within the same exact work. Media completeness does not restrict downloads. Missing files or deleted chapters return 404; ambiguous folder matches return 409.',
    querystring: { type: 'object', additionalProperties: false, required: ['pluginId', 'novelPath', 'chapterPath'], properties: { pluginId: identityText, novelPath: identityText, chapterPath: identityText, includeUnavailable: { type: 'boolean', default: false }, chapterNumber: { type: 'string', maxLength: 100, pattern: '^\\d+(?:\\.\\d+)?$' } } },
    response: { 200: catalogSchema },
  } }, async request => {
    requireRead(request);
    const { pluginId, novelPath, chapterPath, chapterNumber } = request.query;
    const id = chapterIdentityId(db, { pluginId, novelPath, chapterPath });
    const row = db.prepare('SELECT entry,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; deleted_at: number | null } | undefined;
    if (row) {
      if (row.deleted_at !== null) throw problem(404, 'Chapter not found');
      if (request.query.includeUnavailable) return JSON.parse(row.entry) as CatalogEntry;
      const entry = availableChapter(db, dataDir, id);
      if (!entry) throw problem(404, 'Chapter files are unavailable');
      return entry;
    }
    if (!chapterNumber || pluginId === 'local') throw problem(404, 'Chapter not found');
    const normalized = String(Number(chapterNumber));
    const targetNumber = canonicalChapterNumber(db, { pluginId, novelPath }, normalized);
    const work = digest(JSON.stringify([pluginId, novelPath]));
    const rows = db.prepare(`SELECT entry FROM chapters WHERE work_id=? AND (
      CAST(json_extract(entry,'$.manifest.chapter.chapterNumber') AS REAL)=CAST(? AS REAL)
      OR json_extract(entry,'$.manifest.identity.chapterPath')=?
    ) AND deleted_at IS NULL AND (? OR (path IS NOT NULL))`).all(work, targetNumber, `norea-folder:${targetNumber}`, request.query.includeUnavailable ? 1 : 0) as { entry: string }[];
    const matches = rows.map(row => JSON.parse(row.entry) as CatalogEntry).filter(entry => {
      const folderNumber = /^norea-folder:(\d+(?:\.\d+)?)$/.exec(entry.manifest.identity.chapterPath)?.[1];
      const rawNumber = entry.manifest.chapter.chapterNumber;
      const entryNumber = rawNumber != null && /^\d+(?:\.\d+)?$/.test(rawNumber) && Number.isFinite(Number(rawNumber))
        ? String(Number(rawNumber))
        : undefined;
      return (folderNumber ?? entryNumber) === targetNumber && (folderNumber === undefined || entryNumber === undefined || folderNumber === entryNumber);
    });
    if (!matches.length) throw problem(404, 'Chapter not found');
    if (matches.length > 1) throw problem(409, 'Multiple folder chapters match the source identity');
    if (request.query.includeUnavailable) return matches[0];
    const entry = availableChapter(db, dataDir, matches[0].id);
    if (!entry) throw problem(404, 'Chapter files are unavailable');
    return entry;
  });
}
