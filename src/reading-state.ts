import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { authenticateDevice, tokenDigest } from './auth.ts';
import { transaction } from './db.ts';

export interface ReadingStateEntry {
  pluginId: string;
  sourceNovelId: string | null;
  novelPath: string;
  chapterPath: string;
  chapterNumber: string | null;
  page: string;
  unread: boolean;
  progress: number;
  bookmark: boolean;
  /** Unix seconds, matching the app's read_at column. */
  readAt: number | null;
}

const syncKeySchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const offsetSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const entrySchema = {
  type: 'object', additionalProperties: false,
  required: ['pluginId', 'sourceNovelId', 'novelPath', 'chapterPath', 'chapterNumber', 'page', 'unread', 'progress', 'bookmark', 'readAt'],
  properties: {
    pluginId: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    sourceNovelId: { type: ['string', 'null'], minLength: 1, maxLength: 2048, pattern: '\\S' },
    novelPath: { type: 'string', minLength: 1, maxLength: 16384, pattern: '\\S' },
    chapterPath: { type: 'string', minLength: 1, maxLength: 16384, pattern: '\\S' },
    chapterNumber: { type: ['string', 'null'], minLength: 1, maxLength: 200, pattern: '\\S' },
    page: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    unread: { type: 'boolean' },
    progress: { type: 'number', minimum: 0, maximum: 100 },
    bookmark: { type: 'boolean' },
    readAt: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
};

function normalizeEntry(entry: ReadingStateEntry): ReadingStateEntry {
  return {
    pluginId: entry.pluginId,
    sourceNovelId: entry.sourceNovelId?.trim().toLowerCase() ?? null,
    novelPath: entry.novelPath,
    chapterPath: entry.chapterPath,
    chapterNumber: entry.chapterNumber?.trim() ?? null,
    page: entry.page,
    unread: entry.progress >= 100 ? false : entry.unread,
    progress: entry.progress,
    bookmark: entry.bookmark,
    readAt: entry.readAt,
  };
}

/** Tagged identity parts prevent source IDs/numbers colliding with paths. */
function entryKey(entry: ReadingStateEntry): string {
  const identity = [
    entry.pluginId,
    entry.sourceNovelId === null ? ['path', entry.novelPath] : ['source', entry.sourceNovelId],
    entry.chapterNumber === null ? ['path', entry.chapterPath] : ['number', entry.chapterNumber, entry.page],
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function mergeEntry(previous: ReadingStateEntry, incoming: ReadingStateEntry): ReadingStateEntry {
  // Keep the identity descriptors from the newest reading event. State itself
  // is monotonic, so an older or repeatedly sent device cannot erase reading.
  const identity = (incoming.readAt ?? -1) >= (previous.readAt ?? -1) ? incoming : previous;
  const readAt = previous.readAt === null ? incoming.readAt : incoming.readAt === null ? previous.readAt : Math.max(previous.readAt, incoming.readAt);
  return {
    ...identity,
    unread: previous.unread && incoming.unread,
    progress: Math.max(previous.progress, incoming.progress),
    bookmark: previous.bookmark || incoming.bookmark,
    readAt,
  };
}

function countEntries(db: DatabaseSync, profileHash: string): number {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM reading_state_entries WHERE profile_hash=?').get(profileHash)?.count ?? 0);
}

export function registerReadingState(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Body: { syncKey: string; offset: number; limit: number } }>('/api/v1/reading-state/read', {
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      authenticateDevice(db, request);
    },
    schema: {
      security: [{ bearerAuth: [] }],
      description: 'Read private reading progress for the supplied sync key. The key is never placed in a URL; only its SHA-256 digest is stored. Requires an admitted device, even when catalog reading is anonymous.',
      body: { type: 'object', additionalProperties: false, required: ['syncKey'], properties: { syncKey: syncKeySchema, offset: { ...offsetSchema, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 500 } } },
      response: { 200: { type: 'object', required: ['entries', 'total', 'nextOffset'], properties: { entries: { type: 'array', items: entrySchema }, total: offsetSchema, nextOffset: { type: ['integer', 'null'], minimum: 0 } } } },
    },
  }, async request => {
    const profileHash = tokenDigest(request.body.syncKey);
    const { offset, limit } = request.body;
    // Rows only append; updates retain their sequence and do not reorder pages.
    const rows = db.prepare('SELECT entry FROM reading_state_entries WHERE profile_hash=? ORDER BY sequence LIMIT ? OFFSET ?').all(profileHash, limit, offset) as { entry: string }[];
    const total = countEntries(db, profileHash);
    const nextOffset = offset + rows.length;
    return { entries: rows.map(row => JSON.parse(row.entry) as ReadingStateEntry), total, nextOffset: nextOffset < total ? nextOffset : null };
  });

  app.post<{ Body: { syncKey: string; entries: ReadingStateEntry[] } }>('/api/v1/reading-state/merge', {
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      authenticateDevice(db, request);
    },
    schema: {
      security: [{ bearerAuth: [] }],
      description: 'Merge at most 200 chapter reading records without regressing progress, unread status, bookmarks or the latest reading time. The operation is idempotent. It does not publish content or other library settings.',
      body: { type: 'object', additionalProperties: false, required: ['syncKey', 'entries'], properties: { syncKey: syncKeySchema, entries: { type: 'array', maxItems: 200, items: entrySchema } } },
      response: { 200: { type: 'object', required: ['received', 'updated', 'total'], properties: { received: offsetSchema, updated: offsetSchema, total: offsetSchema } } },
    },
  }, async request => {
    const profileHash = tokenDigest(request.body.syncKey);
    return transaction(db, () => {
      const lookup = db.prepare('SELECT entry FROM reading_state_entries WHERE profile_hash=? AND entry_key=?');
      const save = db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?) ON CONFLICT(profile_hash,entry_key) DO UPDATE SET entry=excluded.entry');
      let updated = 0;
      for (const raw of request.body.entries) {
        const incoming = normalizeEntry(raw);
        const key = entryKey(incoming);
        const previous = lookup.get(profileHash, key) as { entry: string } | undefined;
        const merged = previous ? mergeEntry(JSON.parse(previous.entry) as ReadingStateEntry, incoming) : incoming;
        const serialized = JSON.stringify(merged);
        if (previous?.entry === serialized) continue;
        save.run(profileHash, key, serialized);
        updated += 1;
      }
      return { received: request.body.entries.length, updated, total: countEntries(db, profileHash) };
    });
  });
}
