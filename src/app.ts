import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import type { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { openDatabase, problem, transaction } from './db.ts';
import { authenticate, createSession, setAccount, tokenDigest } from './auth.ts';
import { mutateState, stateMutationSchema, validateStateMutation } from './state.ts';
import type { StateMutation } from './state.ts';
import { chapterRow, defaultLimits, deleteChapter, packageStream, publishPackage, purgeChapter, recordEntry, restoreChapter } from './packages.ts';
import type { CatalogEntry, Limits } from './packages.ts';

const string = { type: 'string' };
const object = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
const stateSchema = { type: 'object', required: ['key','version','value','conflicts'], properties: { key: string, version: { type: 'integer' }, value: object, conflicts: { type: 'array', items: { type: 'object', required: ['operationId','deviceName','value'], properties: { operationId: string, deviceName: string, value: object } } } } };
const manifestSchema = { type: 'object', required: ['packageVersion','identity','novel','chapter','bodyPath','files'], properties: {
  packageVersion: { const: 1, type: 'integer' }, identity: { type: 'object', required: ['pluginId','novelPath','chapterPath'], properties: { pluginId: string, novelPath: string, chapterPath: string } },
  novel: { type: 'object', required: ['name','isLocal'], properties: { name: string, author: { type: ['string','null'] }, summary: { type: ['string','null'] }, isLocal: { type: 'boolean' } } },
  chapter: { type: 'object', required: ['name','position','contentType','page'], properties: { name: string, position: { type: 'number' }, chapterNumber: { type: ['string','null'] }, contentType: { type: 'string', enum: ['html','text','markdown','pdf'] }, page: string } },
  bodyPath: string, files: { type: 'array', items: { type: 'object', required: ['path','size','sha256'], properties: { path: string, size: { type: 'integer' }, sha256: string } } },
} };
const catalogSchema = { type: 'object', required: ['id','revision','zipSha256','zipBytes','manifest','deleted','sequence'], properties: { id: string, revision: string, zipSha256: string, zipBytes: { type: 'integer' }, manifest: manifestSchema, deleted: { type: 'boolean' }, sequence: { type: 'integer' } } };
const credentials = { type: 'object', additionalProperties: false, required: ['username','password','deviceName'], properties: { username: { type: 'string', minLength: 1, maxLength: 100 }, password: { type: 'string', minLength: 1, maxLength: 1024 }, deviceName: { type: 'string', minLength: 1, maxLength: 200 } } };
const userSchema = { type: 'object', properties: { id: string, username: string, role: { type: 'string', enum: ['member','admin'] } } };

export async function buildApp(options: { dataDir: string; anonymousRead?: boolean; limits?: Partial<Limits>; trashDays?: number }) {
  const dataDir = resolve(options.dataDir);
  const db = openDatabase(dataDir);
  const limits = { ...defaultLimits, ...options.limits };
  const app = Fastify({ bodyLimit: 1024 * 1024, requestTimeout: 120000, logger: false });
  const anonymousRead = options.anonymousRead ?? true;
  await app.register(swagger, { openapi: { info: { title: 'Norea Content Server', version: '1.0.0' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } } });
  app.addContentTypeParser('application/zip', (_request, payload, done) => done(null, payload));
  app.addHook('onClose', async () => { db.close(); });
  const requireRead = (request: Parameters<typeof authenticate>[1]) => { if (!anonymousRead) authenticate(db, request); };
  app.get('/api/v1/capabilities', { schema: { response: { 200: { type: 'object', properties: { apiVersion: { type: 'integer' }, packageVersion: { type: 'integer' }, anonymousRead: { type: 'boolean' } } } } } }, async () => ({ apiVersion: 1, packageVersion: 1, anonymousRead }));
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.post<{ Body: { username: string; password: string; deviceName: string } }>('/api/v1/sessions', { schema: { body: credentials, response: { 200: { type: 'object', properties: { token: string, user: userSchema } } } } }, async request => createSession(db, request.body.username, request.body.password, request.body.deviceName));
  app.delete('/api/v1/sessions/current', { schema: { security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    authenticate(db, request);
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenDigest(request.headers.authorization!.slice(7)));
    return reply.code(204).send();
  });
  app.get('/api/v1/sessions', { schema: { security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: string, deviceName: string, expiresAt: { type: 'integer' } } } } } } } } }, async request => {
    const user = authenticate(db, request);
    return { items: db.prepare('SELECT id,device_name AS deviceName,expires_at AS expiresAt FROM sessions WHERE account_id=? AND expires_at>?').all(user.id, Date.now()) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/sessions/:id', { schema: { security: [{ bearerAuth: [] }], params: { type: 'object', properties: { id: string }, required: ['id'] } } }, async (request, reply) => {
    const user = authenticate(db, request);
    db.prepare('DELETE FROM sessions WHERE id=? AND account_id=?').run(request.params.id, user.id);
    return reply.code(204).send();
  });
  app.post<{ Body: { username: string; password: string; role: 'admin' | 'member' } }>('/api/v1/accounts', { schema: { security: [{ bearerAuth: [] }], body: { type: 'object', additionalProperties: false, required: ['username','password','role'], properties: { username: { type: 'string', minLength: 1, maxLength: 100 }, password: { type: 'string', minLength: 12, maxLength: 1024 }, role: { type: 'string', enum: ['admin','member'] } } }, response: { 200: userSchema } } }, async request => {
    authenticate(db, request, true);
    return setAccount(db, request.body.username, request.body.password, request.body.role);
  });
  app.get<{ Querystring: { after?: number; limit?: number } }>('/api/v1/chapters', { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 } } }, response: { 200: { type: 'object', properties: { items: { type: 'array', items: catalogSchema }, cursor: { type: 'integer' }, hasMore: { type: 'boolean' } } } } } }, async request => {
    requireRead(request);
    const after = request.query.after ?? 0; const limit = request.query.limit ?? 100;
    const rows = db.prepare('SELECT entry FROM catalog_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit + 1) as { entry: string }[];
    const items = rows.slice(0, limit).map(row => JSON.parse(row.entry) as CatalogEntry);
    return { items, cursor: items.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  });
  app.post('/api/v1/packages', { onRequest: async request => { authenticate(db, request); }, schema: { security: [{ bearerAuth: [] }], consumes: ['application/zip'], response: { 200: catalogSchema } } }, async request => {
    if (request.headers['content-type']?.split(';')[0] !== 'application/zip') throw problem(415, 'application/zip is required');
    return publishPackage(db, dataDir, request.body as Readable, limits);
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
  app.delete<{ Params: { id: string } }>('/api/v1/chapters/:id', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: catalogSchema } } }, async request => { authenticate(db, request, true); return deleteChapter(db, dataDir, request.params.id); });
  app.post<{ Params: { id: string } }>('/api/v1/chapters/:id/restore', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: catalogSchema } } }, async request => { authenticate(db, request, true); return restoreChapter(db, dataDir, request.params.id); });
  app.post<{ Params: { id: string } }>('/api/v1/chapters/:id/purge', { schema: { params: idParams, security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { purged: { type: 'boolean' } } } } } }, async request => { authenticate(db, request, true); purgeChapter(db, dataDir, request.params.id); return { purged: true }; });
  app.post<{ Params: { id: string }; Body: { revision: string } }>('/api/v1/chapters/:id/revision', { schema: { params: idParams, security: [{ bearerAuth: [] }], body: { type: 'object', required: ['revision'], properties: { revision: { type: 'string', pattern: '^[0-9a-f]{64}$' } } }, response: { 200: catalogSchema } } }, async request => {
    authenticate(db, request, true);
    const row = chapterRow(db, request.params.id);
    if (row.catalog.deleted) throw problem(409, 'Restore the chapter before selecting a revision');
    const revision = db.prepare('SELECT entry,path FROM revisions WHERE chapter_id=? AND revision=? AND deleted=0').get(request.params.id, request.body.revision) as { entry: string; path: string | null } | undefined;
    if (!revision?.path) throw problem(404, 'Revision not found');
    return transaction(db, () => recordEntry(db, JSON.parse(revision.entry)));
  });
  app.get('/api/v1/state', { schema: { security: [{ bearerAuth: [] }], response: { 200: { type: 'object', properties: { items: { type: 'array', items: stateSchema } } } } } }, async request => {
    const user = authenticate(db, request);
    const rows = db.prepare('SELECT entry FROM state WHERE account_id=? ORDER BY key').all(user.id) as { entry: string }[];
    return { items: rows.map(row => JSON.parse(row.entry)) };
  });
  app.put<{ Body: StateMutation }>('/api/v1/state', {
    validatorCompiler: () => data => {
      try { validateStateMutation(data); return { value: data }; }
      catch (error) { return { error: error as Error }; }
    },
    schema: { security: [{ bearerAuth: [] }], body: stateMutationSchema, response: { 200: stateSchema, 409: { anyOf: [stateSchema, object] } } },
  }, async (request, reply) => {
    const user = authenticate(db, request);
    const result = mutateState(db, user.id, request.body);
    return reply.code(result.status).send(result.entry);
  });
  const cutoff = Date.now() - (options.trashDays ?? 30) * 86400000;
  for (const row of db.prepare('SELECT id FROM chapters WHERE deleted_at<?').all(cutoff) as { id: string }[]) purgeChapter(db, dataDir, row.id);
  return app;
}
