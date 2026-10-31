import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { resolve } from 'node:path';
import { openDatabase, problem } from './db.ts';
import { authenticate, authenticateDevice, createConsoleSession, installationSecret, registerDevice, tokenDigest } from './auth.ts';
import { defaultLimits, deleteChapter, purgeChapter, restoreChapter } from './packages.ts';
import type { ChapterConflictPolicy, Limits } from './packages.ts';
import { createChangeNotifications, readChangeCursors } from './changes.ts';
import { registerAdministration, savedAnonymousRead } from './administration.ts';
import { rebuildWorkIndex, registerWorks } from './works.ts';
import { registerCatalog } from './catalog.ts';
import { chapterFileStream, publishChapterFiles } from './chapter-files.ts';
import { readChapterMediaAsset } from './chapter-media.ts';
import { registerReadingState } from './reading-state.ts';
import { registerDeviceBackups } from './device-backups.ts';

const string = { type: 'string' };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
const manifestSchema = { type: 'object', required: ['packageVersion','layout','identity','novel','chapter','bodyPath','files'], properties: {
  layout: { type: 'string', enum: ['chapter-files'] },
  packageVersion: { const: 1, type: 'integer' }, identity: { type: 'object', required: ['pluginId','novelId','novelPath','chapterPath'], properties: { pluginId: string, novelId: string, novelPath: string, chapterPath: string } },
  novel: { type: 'object', required: ['name','isLocal'], properties: { name: string, author: { type: ['string','null'] }, summary: { type: ['string','null'] }, isLocal: { type: 'boolean' } } },
  chapter: { type: 'object', required: ['name','position','contentType','page'], properties: { name: string, position: { type: 'number' }, chapterNumber: { type: ['string','null'] }, contentType: { type: 'string', enum: ['html','text','markdown','pdf'] }, page: string } },
  bodyPath: string, files: { type: 'array', items: { type: 'object', required: ['path','size','modifiedAt'], properties: { path: string, size: { type: 'integer' }, modifiedAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } },
} };
const catalogSchema = { type: 'object', required: ['id','revision','fileBytes','manifest','complete','deleted','sequence'], properties: { id: string, revision: string, fileBytes: { type: 'integer' }, manifest: manifestSchema, complete: { type: 'boolean' }, deleted: { type: 'boolean' }, sequence: { type: 'integer' } } };
const cursorSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

export async function buildApp(options: { dataDir: string; anonymousRead?: boolean; limits?: Partial<Limits>; trashDays?: number }) {
  const dataDir = resolve(options.dataDir);
  const secret = installationSecret(dataDir);
  const db = openDatabase(dataDir);
  try { rebuildWorkIndex(db, dataDir); } catch (error) { db.close(); throw error; }
  const limits = { ...defaultLimits, ...options.limits };
  const app = Fastify({ bodyLimit: 1024 * 1024, requestTimeout: 120000, logger: false, trustProxy: false });
  await app.register(rateLimit, { global: true, max: 6000, timeWindow: '1 minute' });
  let anonymousRead = savedAnonymousRead(db, options.anonymousRead ?? true);
  const changes = createChangeNotifications(db);
  await app.register(swagger, { openapi: { info: { title: 'Norea Content Server', version: '1.0.0' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } } });
  await app.register(multipart, { limits: { fields: 1, fieldSize: 64 * 1024, files: 3, parts: 4, fileSize: limits.expandedBytes } });
  app.addHook('preClose', async () => { changes.close(); });
  app.addHook('onClose', async () => { db.close(); });
  const requireRead = (request: Parameters<typeof authenticate>[1]) => { if (!anonymousRead || request.headers.authorization !== undefined) authenticate(db, request); };
  registerWorks(app, { db, dataDir, requireRead, notify: () => changes.notify() });
  registerCatalog(app, { db, dataDir, requireRead, catalogSchema });
  registerReadingState(app, db);
  await registerDeviceBackups(app, db, dataDir);
  app.get('/api/v1/capabilities', { schema: { response: { 200: { type: 'object', properties: { apiVersion: { type: 'integer' }, packageVersion: { type: 'integer' }, authentication: string, personalStateSync: { type: 'boolean' }, readingStateVersion: { type: 'integer' }, deviceBackupVersion: { type: 'integer' }, anonymousRead: { type: 'boolean' } } } } } }, async () => ({ apiVersion: 1, packageVersion: 1, authentication: 'device-key', personalStateSync: true, readingStateVersion: 1, deviceBackupVersion: 1, anonymousRead }));
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.post<{ Body: { password: string } }>('/api/v1/console-sessions', { config: { rateLimit: { max: 10 } }, schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } } }, response: { 200: { type: 'object', properties: { token: string } } } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return createConsoleSession(db, secret, request.body.password);
  });
  app.delete('/api/v1/console-sessions/current', { schema: { security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    authenticate(db, request, true);
    db.prepare('DELETE FROM console_sessions WHERE token_hash=?').run(tokenDigest(request.headers.authorization!.slice(7)));
    return reply.code(204).send();
  });
  app.post<{ Body: { deviceKey: string; deviceName: string } }>('/api/v1/devices/register', { config: { rateLimit: { max: 60 } }, schema: { body: { type: 'object', additionalProperties: false, required: ['deviceKey','deviceName'], properties: { deviceKey: { type: 'string', pattern: '^[0-9a-f]{64}$' }, deviceName: { type: 'string', minLength: 1, maxLength: 200 } } }, response: { 200: { type: 'object', properties: { id: string, deviceName: string } } } } }, async request => registerDevice(db, request.body.deviceKey, request.body.deviceName));
  app.get<{ Querystring: { catalogAfter: number; workAfter: number; waitSeconds?: number } }>('/api/v1/changes', { preValidation: async request => {
    if (Object.keys(request.query).some(key => !['catalogAfter', 'workAfter', 'waitSeconds'].includes(key))) throw problem(400, 'Only catalogAfter, workAfter and waitSeconds are accepted');
  }, schema: {
    security: [{ bearerAuth: [] }, {}],
    description: 'Wait up to 20 seconds for a newer durable catalog or work cursor. A cursor ahead of either log returns 409.',
    querystring: { type: 'object', additionalProperties: false, required: ['catalogAfter', 'workAfter'], properties: { catalogAfter: cursorSchema, workAfter: cursorSchema, waitSeconds: { type: 'integer', minimum: 0, maximum: 20, default: 20 } } },
    response: { 200: { type: 'object', required: ['catalogCursor', 'workCursor'], properties: { catalogCursor: { type: 'integer' }, workCursor: { type: 'integer' } } } },
  } }, async (request, reply) => {
    const authenticated = request.headers.authorization !== undefined || !anonymousRead;
    if (authenticated) authenticate(db, request);
    const after = { catalogCursor: request.query.catalogAfter, workCursor: request.query.workAfter };
    const current = readChangeCursors(db);
    if (after.catalogCursor > current.catalogCursor) throw problem(409, 'Change cursor is ahead of the server log');
    if (after.workCursor > current.workCursor) throw problem(409, 'Work cursor is ahead of the server log');
    const waitSeconds = request.query.waitSeconds ?? 20;
    if (waitSeconds && current.catalogCursor === after.catalogCursor && current.workCursor === after.workCursor) await changes.wait(after, waitSeconds, reply.raw);
    if (authenticated || !anonymousRead) authenticate(db, request);
    return readChangeCursors(db);
  });
  app.delete<{ Params: { id: string } }>('/api/v1/chapters/:id', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: catalogSchema } } }, async request => { authenticate(db, request); const entry = deleteChapter(db, dataDir, request.params.id); changes.notify(); return entry; });
  app.post<{ Params: { id: string } }>('/api/v1/chapters/:id/restore', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: catalogSchema } } }, async request => { authenticate(db, request); const entry = await restoreChapter(db, dataDir, request.params.id, limits); changes.notify(); return entry; });
  app.post<{ Params: { id: string } }>('/api/v1/chapters/:id/purge', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { purged: { type: 'boolean' } } } } } }, async request => { authenticate(db, request, true); purgeChapter(db, dataDir, request.params.id); return { purged: true }; });
  app.post<{ Querystring: { conflictPolicy: ChapterConflictPolicy } }>('/api/v1/chapter-files', { onRequest: async request => { authenticateDevice(db, request); }, schema: { security: [{ bearerAuth: [] }], consumes: ['multipart/form-data'], querystring: { type: 'object', additionalProperties: false, properties: { conflictPolicy: { type: 'string', enum: ['prefer-complete', 'keep-server', 'replace-server'], default: 'prefer-complete' } } }, response: { 200: catalogSchema }, description: 'Upload original chapter files and record their inspected media completeness. Send metadata JSON first, then files named by their original paths. No compression or body rewriting.' } }, async request => {
    if (!request.isMultipart()) throw problem(415, 'multipart/form-data is required');
    const entry = await publishChapterFiles(db, dataDir, request.parts(), limits, request.query.conflictPolicy);
    changes.notify();
    return entry;
  });
  app.get<{ Params: { id: string }; Querystring: { revision: string; path: string } }>('/api/v1/chapters/:id/files', { schema: { params: idParams, querystring: { type: 'object', required: ['revision', 'path'], properties: { revision: { type: 'string', pattern: '^[0-9a-f]{64}$' }, path: { type: 'string', enum: ['content.html', 'content.pdf', 'manifest.json', 'media.zip'] } } } } }, async (request, reply) => {
    requireRead(request);
    const { file, open } = chapterFileStream(db, dataDir, request.params.id, request.query.revision, request.query.path);
    return reply.header('Content-Length', file.size).header('ETag', `"${request.query.revision}:${file.path}"`).header('X-Content-Type-Options', 'nosniff').type('application/octet-stream').send(open());
  });
  app.get<{ Params: { id: string }; Querystring: { revision: string; fileName: string; sourceUrl: string } }>('/api/v1/chapters/:id/media', { schema: {
    params: idParams,
    querystring: { type: 'object', additionalProperties: false, required: ['revision', 'fileName', 'sourceUrl'], properties: {
      revision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9._-]+$' },
      sourceUrl: { type: 'string', minLength: 1, maxLength: 16384 },
    } },
  } }, async (request, reply) => {
    requireRead(request);
    const { revision, fileName, sourceUrl } = request.query;
    const body = await readChapterMediaAsset(db, dataDir, request.params.id, revision, fileName, sourceUrl, limits);
    return reply.header('Content-Length', body.length).header('ETag', `"${revision}:media/${fileName}"`)
      .header('X-Content-Type-Options', 'nosniff').type('application/octet-stream').send(body);
  });
  const cutoff = Date.now() - (options.trashDays ?? 30) * 86400000;
  for (const row of db.prepare('SELECT id FROM chapters WHERE deleted_at<?').all(cutoff) as { id: string }[]) purgeChapter(db, dataDir, row.id);
  await registerAdministration(app, { db, dataDir, limits, notify: () => changes.notify(), getAnonymousRead: () => anonymousRead, setAnonymousRead: value => { anonymousRead = value; } });
  return app;
}
