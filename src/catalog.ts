import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { problem } from './db.ts';
import { completeChapter, digest } from './packages.ts';
import type { CatalogEntry } from './packages.ts';
import type { NovelMetadataV1 } from './works.ts';

interface WorkSummary {
  id: string;
  sequence: number;
  identity: NovelMetadataV1['identity'];
  novel: NovelMetadataV1['novel'];
  hasCover: boolean;
  chapterCount: number;
}
const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const identityText = { type: 'string', minLength: 1, maxLength: 4096 };
const count = { type: 'integer', minimum: 0 };
const chapterSummarySchema = { type: 'object', required: ['id', 'chapterPath', 'position', 'name', 'chapterNumber', 'page', 'contentType'], properties: {
  id: text, chapterPath: text, position: { type: 'number' }, name: text, chapterNumber: nullableText, page: text, contentType: { type: 'string', enum: ['html', 'text', 'markdown', 'pdf'] },
} };
const chapterChangeSchema = { type: 'object', required: ['identity', 'deleted', 'sequence'], properties: {
  identity: { type: 'object', required: ['pluginId', 'novelPath', 'chapterPath'], properties: { pluginId: text, novelPath: text, chapterPath: text } },
  deleted: { type: 'boolean' }, sequence: count,
} };
const workSummarySchema = { type: 'object', required: ['id', 'sequence', 'identity', 'novel', 'hasCover', 'chapterCount'], properties: {
  id: text, sequence: count,
  identity: { type: 'object', required: ['pluginId', 'novelPath'], properties: { pluginId: text, novelPath: text } },
  novel: { type: 'object', required: ['name', 'cover', 'author', 'artist', 'summary', 'status', 'rating', 'genres', 'isLocal'], properties: { name: text, cover: nullableText, author: nullableText, artist: nullableText, summary: nullableText, status: nullableText, rating: { type: ['number', 'null'], minimum: 0, maximum: 5 }, genres: nullableText, isLocal: { type: 'boolean' } } },
  hasCover: { type: 'boolean' }, chapterCount: count,
} };
const pagination = (limit: number) => ({ offset: { ...count, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: limit } });
const pageSchema = (item: object) => ({ type: 'object', required: ['items', 'total', 'hasMore'], properties: { items: { type: 'array', items: item }, total: count, hasMore: { type: 'boolean' } } });
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, {}];

export function registerCatalog(app: FastifyInstance, context: { db: DatabaseSync; dataDir: string; requireRead: (request: FastifyRequest) => void; catalogSchema: object }): void {
  const { db, dataDir, requireRead, catalogSchema } = context;
  app.get<{ Querystring: { after: number; limit: number } }>('/api/v1/catalog/changes', { schema: {
    security,
    description: 'Read ordered chapter availability changes without package manifests. Apply repeated identities in order, including deletion and restoration entries. The cursor advances to the last returned sequence and remains unchanged on an empty page.',
    querystring: { type: 'object', additionalProperties: false, properties: { after: { ...count, maximum: Number.MAX_SAFE_INTEGER, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } },
    response: { 200: { type: 'object', required: ['items', 'cursor', 'hasMore'], properties: { items: { type: 'array', items: chapterChangeSchema }, cursor: count, hasMore: { type: 'boolean' } } } },
  } }, async request => {
    requireRead(request);
    const { after, limit } = request.query;
    const rows = db.prepare(`SELECT sequence,json_extract(entry,'$.manifest.identity') AS identity,
      json_extract(entry,'$.deleted') AS deleted FROM catalog_changes WHERE sequence>? ORDER BY sequence LIMIT ?`).all(after, limit + 1) as { sequence: number; identity: string; deleted: number }[];
    const items = rows.slice(0, limit).map(row => ({ identity: JSON.parse(row.identity), deleted: Boolean(row.deleted), sequence: row.sequence }));
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  });
  app.get<{ Querystring: { q?: string; source?: string; offset: number; limit: number } }>('/api/v1/catalog/works', { schema: {
    security,
    description: 'Browse current indexed work summaries without synchronizing change history. Search matches a literal substring of the title (ASCII case-insensitive); source matches an exact plugin ID. chapterCount counts available nondeleted chapter packages. Ordered by title, then ID. Concurrent changes can shift offset pages.',
    querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 500 }, source: identityText, ...pagination(40) } },
    response: { 200: pageSchema(workSummarySchema) },
  } }, async request => {
    requireRead(request);
    const { q, source, offset, limit } = request.query;
    const clauses: string[] = []; const args: string[] = [];
    if (source) { clauses.push("json_extract(w.entry,'$.metadata.identity.pluginId')=?"); args.push(source); }
    if (q) { clauses.push("instr(lower(json_extract(w.entry,'$.metadata.novel.name')),lower(?))>0"); args.push(q); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM works w ${where}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT w.id,json_extract(w.entry,'$.sequence') AS sequence,
      json_extract(w.entry,'$.metadata.identity') AS identity,json_extract(w.entry,'$.metadata.novel') AS novel,
      json_extract(w.entry,'$.hasCover') AS hasCover,
      (SELECT COUNT(*) FROM chapters c WHERE c.work_id=w.id AND c.deleted_at IS NULL) AS chapterCount
      FROM works w ${where} ORDER BY json_extract(w.entry,'$.metadata.novel.name'),w.id LIMIT ? OFFSET ?`).all(...args, limit, offset) as { id: string; sequence: number; identity: string; novel: string; hasCover: number; chapterCount: number }[];
    const items: WorkSummary[] = rows.map(row => ({ ...row, identity: JSON.parse(row.identity), novel: JSON.parse(row.novel), hasCover: Boolean(row.hasCover) }));
    return { items, total, hasMore: offset + items.length < total };
  });
  app.get('/api/v1/catalog/sources', { schema: {
    security,
    description: 'List source IDs represented by indexed works, including works with no available chapter packages.',
    response: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id', 'workCount'], properties: { id: text, workCount: count } } } } } },
  } }, async request => {
    requireRead(request);
    return { items: db.prepare("SELECT json_extract(entry,'$.metadata.identity.pluginId') AS id,COUNT(*) AS workCount FROM works GROUP BY json_extract(entry,'$.metadata.identity.pluginId') ORDER BY json_extract(entry,'$.metadata.identity.pluginId')").all() };
  });
  app.get<{ Params: { id: string }; Querystring: { offset: number; limit: number } }>('/api/v1/catalog/works/:id/chapters', { schema: {
    security,
    description: 'Page current nondeleted chapter summaries ordered by position, then ID. Summaries exclude package file manifests. An unknown work returns 404; a known work without packages returns an empty page.',
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    querystring: { type: 'object', additionalProperties: false, properties: pagination(100) },
    response: { 200: pageSchema(chapterSummarySchema) },
  } }, async request => {
    requireRead(request);
    const { id } = request.params; const { offset, limit } = request.query;
    if (!db.prepare('SELECT 1 FROM works WHERE id=?').get(id) && !db.prepare('SELECT 1 FROM chapters WHERE work_id=? LIMIT 1').get(id)) throw problem(404, 'Work not found');
    const total = (db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE work_id=? AND deleted_at IS NULL').get(id) as { n: number }).n;
    const items = db.prepare(`SELECT id,json_extract(entry,'$.manifest.identity.chapterPath') AS chapterPath,
      json_extract(entry,'$.manifest.chapter.position') AS position,json_extract(entry,'$.manifest.chapter.name') AS name,
      json_extract(entry,'$.manifest.chapter.chapterNumber') AS chapterNumber,json_extract(entry,'$.manifest.chapter.page') AS page,json_extract(entry,'$.manifest.chapter.contentType') AS contentType
      FROM chapters WHERE work_id=? AND deleted_at IS NULL ORDER BY json_extract(entry,'$.manifest.chapter.position'),id LIMIT ? OFFSET ?`).all(id, limit, offset);
    return { items, total, hasMore: offset + items.length < total };
  });
  app.get<{ Querystring: { pluginId: string; novelPath: string; chapterPath: string; chapterNumber?: string; includeUnavailable?: boolean } }>('/api/v1/catalog/chapter', { schema: {
    security,
    description: 'Resolve a package by exact source identity, then optional chapter number within the same exact work. Missing or deleted chapters return 404; ambiguous folder matches return 409.',
    querystring: { type: 'object', additionalProperties: false, required: ['pluginId', 'novelPath', 'chapterPath'], properties: { pluginId: identityText, novelPath: identityText, chapterPath: identityText, includeUnavailable: { type: 'boolean', default: false }, chapterNumber: { type: 'string', maxLength: 100, pattern: '^\\d+(?:\\.\\d+)?$' } } },
    response: { 200: catalogSchema },
  } }, async request => {
    requireRead(request);
    const { pluginId, novelPath, chapterPath, chapterNumber } = request.query;
    const id = digest(JSON.stringify([pluginId, novelPath, chapterPath]));
    const row = db.prepare('SELECT entry,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; deleted_at: number | null } | undefined;
    if (row) {
      if (row.deleted_at !== null) throw problem(404, 'Chapter not found');
      if (request.query.includeUnavailable) return JSON.parse(row.entry) as CatalogEntry;
      const entry = completeChapter(db, dataDir, id);
      if (!entry) throw problem(404, 'Chapter files are unavailable');
      return entry;
    }
    if (!chapterNumber) throw problem(404, 'Chapter not found');
    const work = digest(JSON.stringify([pluginId, novelPath]));
    const matches = db.prepare("SELECT entry FROM chapters WHERE work_id=? AND json_extract(entry,'$.manifest.chapter.chapterNumber')=? AND deleted_at IS NULL").all(work, chapterNumber) as { entry: string }[];
    if (!matches.length) throw problem(404, 'Chapter not found');
    if (matches.length > 1) throw problem(409, 'Multiple folder chapters match the source identity');
    if (request.query.includeUnavailable) return JSON.parse(matches[0].entry) as CatalogEntry;
    const entry = completeChapter(db, dataDir, (JSON.parse(matches[0].entry) as CatalogEntry).id);
    if (!entry) throw problem(404, 'Chapter files are unavailable');
    return entry;
  });
}
