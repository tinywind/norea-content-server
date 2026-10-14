import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import multipart from '@fastify/multipart';
import type { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { openDatabase, problem } from './db.ts';
import { authenticate, authenticateDevice, createConsoleSession, installationSecret, registerDevice, tokenDigest } from './auth.ts';
import { defaultLimits, deleteChapter, discardChapterHistory, packageStream, publishPackage, purgeChapter, restoreChapter } from './packages.ts';
import type { CatalogEntry, Limits } from './packages.ts';
import { createChangeNotifications, readChangeCursors } from './changes.ts';
import { initializeAdministration, registerAdministration, savedAnonymousRead } from './administration.ts';
import { rebuildWorkIndex, registerWorks } from './works.ts';
import { registerCatalog } from './catalog.ts';
import { chapterFileStream, publishChapterFiles } from './chapter-files.ts';

const string = { type: 'string' };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
const manifestSchema = { type: 'object', required: ['packageVersion','identity','novel','chapter','bodyPath','files'], properties: {
  layout: { type: 'string', enum: ['chapter-files'] },
  packageVersion: { const: 1, type: 'integer' }, identity: { type: 'object', required: ['pluginId','novelPath','chapterPath'], properties: { pluginId: string, novelPath: string, chapterPath: string } },
  novel: { type: 'object', required: ['name','isLocal'], properties: { name: string, author: { type: ['string','null'] }, summary: { type: ['string','null'] }, isLocal: { type: 'boolean' } } },
  chapter: { type: 'object', required: ['name','position','contentType','page'], properties: { name: string, position: { type: 'number' }, chapterNumber: { type: ['string','null'] }, contentType: { type: 'string', enum: ['html','text','markdown','pdf'] }, page: string } },
  bodyPath: string, files: { type: 'array', items: { type: 'object', required: ['path','size'], anyOf: [{ type: 'object', required: ['sha256'] }, { type: 'object', required: ['modifiedAt'] }], properties: { path: string, size: { type: 'integer' }, sha256: string, modifiedAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } },
} };
const catalogSchema = { type: 'object', required: ['id','revision','manifest','deleted','sequence'], properties: { id: string, revision: string, zipSha256: string, zipBytes: { type: 'integer' }, fileBytes: { type: 'integer' }, manifest: manifestSchema, deleted: { type: 'boolean' }, sequence: { type: 'integer' } } };
const cursorSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 };

export async function buildApp(options: { dataDir: string; anonymousRead?: boolean; limits?: Partial<Limits>; trashDays?: number }) {
  const dataDir = resolve(options.dataDir);
  const secret = installationSecret(dataDir);
  const db = openDatabase(dataDir);
  initializeAdministration(db);
  try { discardChapterHistory(db, dataDir); rebuildWorkIndex(db, dataDir); } catch (error) { db.close(); throw error; }
  const limits = { ...defaultLimits, ...options.limits };
  const app = Fastify({ bodyLimit: 1024 * 1024, requestTimeout: 120000, logger: false });
  let anonymousRead = savedAnonymousRead(db, options.anonymousRead ?? true);
  const changes = createChangeNotifications(db);
  await app.register(swagger, { openapi: { info: { title: 'Norea Content Server', version: '1.0.0' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } } });
  app.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload));
  await app.register(multipart, { limits: { fields: 1, fieldSize: 64 * 1024, files: 3, parts: 4, fileSize: limits.expandedBytes } });
  app.addHook('preClose', async () => { changes.close(); });
  app.addHook('onClose', async () => { db.close(); });
  const requireRead = (request: Parameters<typeof authenticate>[1]) => { if (!anonymousRead || request.headers.authorization !== undefined) authenticate(db, request); };
  registerWorks(app, { db, dataDir, requireRead, notify: () => changes.notify() });
  registerCatalog(app, { db, dataDir, requireRead, catalogSchema });
  app.get('/api/v1/capabilities', { schema: { response: { 200: { type: 'object', properties: { apiVersion: { type: 'integer' }, packageVersion: { type: 'integer' }, authentication: string, personalStateSync: { type: 'boolean' }, anonymousRead: { type: 'boolean' } } } } } }, async () => ({ apiVersion: 1, packageVersion: 1, authentication: 'device-key', personalStateSync: false, anonymousRead }));
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.post<{ Body: { password: string } }>('/api/v1/console-sessions', { schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } } }, response: { 200: { type: 'object', properties: { token: string } } } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return createConsoleSession(db, secret, request.body.password);
  });
  app.delete('/api/v1/console-sessions/current', { schema: { security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    authenticate(db, request, true);
    db.prepare('DELETE FROM console_sessions WHERE token_hash=?').run(tokenDigest(request.headers.authorization!.slice(7)));
    return reply.code(204).send();
  });
  app.post<{ Body: { deviceKey: string; deviceName: string } }>('/api/v1/devices/register', { schema: { body: { type: 'object', additionalProperties: false, required: ['deviceKey','deviceName'], properties: { deviceKey: { type: 'string', pattern: '^[0-9a-f]{64}$' }, deviceName: { type: 'string', minLength: 1, maxLength: 200 } } }, response: { 200: { type: 'object', properties: { id: string, deviceName: string } } } } }, async request => registerDevice(db, request.body.deviceKey, request.body.deviceName));
  app.get<{ Querystring: { after?: number; limit?: number } }>('/api/v1/chapters', { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } }, response: { 200: { type: 'object', properties: { items: { type: 'array', items: catalogSchema }, cursor: { type: 'integer' }, hasMore: { type: 'boolean' } } } } } }, async request => {
    requireRead(request);
    const after = request.query.after ?? 0; const limit = request.query.limit ?? 100;
    const rows = db.prepare('SELECT entry FROM catalog_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit + 1) as { entry: string }[];
    const items = rows.slice(0, limit).map(row => JSON.parse(row.entry) as CatalogEntry);
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  });
  app.get<{ Querystring: { catalogAfter?: number; workAfter?: number; waitSeconds?: number } }>('/api/v1/changes', { preValidation: async request => {
    if (Object.keys(request.query).some(key => !['catalogAfter', 'workAfter', 'waitSeconds'].includes(key))) throw problem(400, 'Only catalogAfter, workAfter and waitSeconds are accepted');
  }, schema: {
    security: [{ bearerAuth: [] }, {}],
    description: 'Wait up to 20 seconds for a newer durable catalog cursor. A cursor ahead of the log returns 409.',
    querystring: { type: 'object', additionalProperties: false, properties: { catalogAfter: cursorSchema, workAfter: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, waitSeconds: { type: 'integer', minimum: 0, maximum: 20, default: 20 } } },
    response: { 200: { type: 'object', required: ['catalogCursor'], properties: { catalogCursor: { type: 'integer' }, workCursor: { type: 'integer' } } } },
  } }, async (request, reply) => {
    const authenticated = request.headers.authorization !== undefined || !anonymousRead;
    if (authenticated) authenticate(db, request);
    const after = { catalogCursor: request.query.catalogAfter ?? 0, workCursor: request.query.workAfter };
    const current = readChangeCursors(db);
    if (after.catalogCursor > current.catalogCursor) throw problem(409, 'Change cursor is ahead of the server log');
    if (after.workCursor !== undefined && after.workCursor > current.workCursor) throw problem(409, 'Work cursor is ahead of the server log');
    const waitSeconds = request.query.waitSeconds ?? 20;
    if (waitSeconds && current.catalogCursor === after.catalogCursor && (after.workCursor === undefined || current.workCursor === after.workCursor)) await changes.wait(after, waitSeconds, reply.raw);
    if (authenticated || !anonymousRead) authenticate(db, request);
    const result = readChangeCursors(db);
    return after.workCursor === undefined ? { catalogCursor: result.catalogCursor } : result;
  });
  app.post('/api/v1/packages', { onRequest: async request => { authenticateDevice(db, request); }, schema: { security: [{ bearerAuth: [] }], consumes: ['application/zip'], response: { 200: catalogSchema } } }, async request => {
    if (request.headers['content-type']?.split(';')[0] !== 'application/zip') throw problem(415, 'application/zip is required');
    const entry = await publishPackage(db, dataDir, request.body as Readable, limits);
    changes.notify();
    return entry;
  });
  app.get<{ Params: { id: string } }>('/api/v1/chapters/:id/package', { schema: { params: idParams, produces: ['application/zip'], description: 'Download an immutable ZIP. Use ETag with If-Range when resuming.' } }, async (request, reply) => {
    requireRead(request);
    const { catalog, open } = packageStream(db, dataDir, request.params.id);
    const etag = `"${catalog.zipSha256}"`;
    reply.header('ETag', etag).header('Accept-Ranges', 'bytes').type('application/zip');
    const range = request.headers.range;
    if (range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const length = catalog.zipBytes;
      let start = match?.[1] ? Number(match[1]) : Math.max(0, length - Number(match?.[2]));
      const end = match?.[1] ? (match[2] ? Math.min(Number(match[2]), length - 1) : length - 1) : length - 1;
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || start > end || (!match[1] && Number(match[2]) === 0)) return reply.code(416).header('Content-Range', `bytes */${length}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${length}`).header('Content-Length', end - start + 1);
      return reply.send(open(start, end));
    }
    reply.header('Content-Length', catalog.zipBytes);
    return reply.send(open());
  });
  app.delete<{ Params: { id: string } }>('/api/v1/chapters/:id', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: catalogSchema } } }, async request => { authenticate(db, request); const entry = deleteChapter(db, dataDir, request.params.id); changes.notify(); return entry; });
  app.post<{ Params: { id: string } }>('/api/v1/chapters/:id/restore', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: catalogSchema } } }, async request => { authenticate(db, request); const entry = restoreChapter(db, dataDir, request.params.id); changes.notify(); return entry; });
  app.post<{ Params: { id: string } }>('/api/v1/chapters/:id/purge', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { purged: { type: 'boolean' } } } } } }, async request => { authenticate(db, request, true); purgeChapter(db, dataDir, request.params.id); return { purged: true }; });
  app.post('/api/v1/chapter-files', { onRequest: async request => { authenticateDevice(db, request); }, schema: { security: [{ bearerAuth: [] }], consumes: ['multipart/form-data'], response: { 200: catalogSchema }, description: 'Upload original completed chapter files. Send metadata JSON first, then files named by their original paths. No compression or body rewriting.' } }, async request => {
    if (!request.isMultipart()) throw problem(415, 'multipart/form-data is required');
    const entry = await publishChapterFiles(db, dataDir, request.parts(), limits);
    changes.notify();
    return entry;
  });
  app.get<{ Params: { id: string }; Querystring: { revision: string; path: string } }>('/api/v1/chapters/:id/files', { schema: { params: idParams, querystring: { type: 'object', required: ['revision', 'path'], properties: { revision: { type: 'string', pattern: '^[0-9a-f]{64}$' }, path: { type: 'string', enum: ['content.html', 'content.pdf', 'manifest.json', 'media.zip'] } } } } }, async (request, reply) => {
    requireRead(request);
    const { file, open } = chapterFileStream(db, dataDir, request.params.id, request.query.revision, request.query.path);
    return reply.header('Content-Length', file.size).header('ETag', `"${request.query.revision}:${file.path}"`).header('X-Content-Type-Options', 'nosniff').type('application/octet-stream').send(open());
  });
  const cutoff = Date.now() - (options.trashDays ?? 30) * 86400000;
  for (const row of db.prepare('SELECT id FROM chapters WHERE deleted_at<?').all(cutoff) as { id: string }[]) purgeChapter(db, dataDir, row.id);
  await registerAdministration(app, { db, dataDir, limits, notify: () => changes.notify(), getAnonymousRead: () => anonymousRead, setAnonymousRead: value => { anonymousRead = value; } });
  return app;
}
