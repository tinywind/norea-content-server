import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { authenticate } from './auth.ts';
import { problem } from './db.ts';
import { chapterRow, type CatalogEntry, type Limits } from './packages.ts';
import { initializePluginRegistry, listPlugins, registerPlugin, removePlugin, setPluginEnabled } from './plugin-registry.ts';
import { scanFolder, type FolderIndexItem, type FolderIndexSummary } from './folder-indexer.ts';

interface FolderRoot {
  id: string; name: string; path: string; metadataDbPath: string;
  mode: 'manual' | 'periodic' | 'changes'; intervalMinutes: number;
  enabled: boolean; lastScanAt?: number;
}
interface ScanJob {
  id: string; rootId: string; rootName: string;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  startedAt: number; finishedAt?: number; error?: string; summary: FolderIndexSummary;
}
const text = { type: 'string' };
const identifier = { type: 'object', required: ['id'], properties: { id: text } };
const pagination = { offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } };
const rootProperties = {
  name: { type: 'string', minLength: 1, maxLength: 200 }, path: { type: 'string', minLength: 1, maxLength: 4096 },
  metadataDbPath: { type: 'string', maxLength: 4096 }, mode: { type: 'string', enum: ['manual', 'periodic', 'changes'] },
  intervalMinutes: { type: 'integer', minimum: 1, maximum: 1440 }, enabled: { type: 'boolean' },
};

export function initializeAdministration(db: DatabaseSync): void {
  initializePluginRegistry(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_roots (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_jobs (id TEXT PRIMARY KEY, entry TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_job_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_job_items_job ON admin_job_items(job_id,sequence);
    CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

export function savedAnonymousRead(db: DatabaseSync, fallback: boolean): boolean {
  const row = db.prepare("SELECT value FROM admin_settings WHERE key='anonymousRead'").get() as { value: string } | undefined;
  return row ? row.value === 'true' : fallback;
}

export async function registerAdministration(app: FastifyInstance, context: {
  db: DatabaseSync; dataDir: string; limits: Limits; notify: () => void;
  getAnonymousRead: () => boolean; setAnonymousRead: (enabled: boolean) => void;
}): Promise<void> {
  const { db, dataDir, limits } = context;
  const staging = resolve(dataDir, 'staging');
  try {
    if ((await lstat(staging)).isSymbolicLink()) throw problem(400, 'Server staging must not be a symbolic link');
    if (relative(await realpath(dataDir), await realpath(staging)) !== 'staging') throw problem(400, 'Server staging must remain inside server storage');
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && /^folder-[A-Za-z0-9]{6}$/.test(entry.name)) {
        await rm(join(staging, entry.name), { recursive: true, force: true });
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let closing = false;
  const active = new Map<string, { rootId: string; controller: AbortController; promise: Promise<void> }>();
  const pendingRoots = new Set<string>();
  const schedules = new Map<string, { timer: ReturnType<typeof setInterval>; debounce?: ReturnType<typeof setTimeout>; watcher?: FSWatcher }>();
  const roots = () => (db.prepare('SELECT entry FROM admin_roots ORDER BY rowid').all() as { entry: string }[]).map(row => JSON.parse(row.entry) as FolderRoot);
  const getRoot = (id: string): FolderRoot => {
    const row = db.prepare('SELECT entry FROM admin_roots WHERE id=?').get(id) as { entry: string } | undefined;
    if (!row) throw problem(404, 'Connected folder not found');
    return JSON.parse(row.entry);
  };
  const getJob = (id: string): ScanJob => {
    const row = db.prepare('SELECT entry FROM admin_jobs WHERE id=?').get(id) as { entry: string } | undefined;
    if (!row) throw problem(404, 'Scan job not found');
    return JSON.parse(row.entry);
  };
  const saveJob = (job: ScanJob) => db.prepare('INSERT INTO admin_jobs(id,entry) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry').run(job.id, JSON.stringify(job));
  const saveRoot = (root: FolderRoot) => db.prepare('INSERT INTO admin_roots(id,path,entry) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,entry=excluded.entry').run(root.id, root.path, JSON.stringify(root));
  for (const row of db.prepare('SELECT entry FROM admin_jobs').all() as { entry: string }[]) {
    const job = JSON.parse(row.entry) as ScanJob;
    if (job.status === 'running') saveJob({ ...job, status: 'interrupted', finishedAt: Date.now(), error: 'Server stopped before the scan completed. Run the folder scan again.' });
  }

  async function validateRoot(root: FolderRoot): Promise<void> {
    if (!isAbsolute(root.path) || (root.metadataDbPath && !isAbsolute(root.metadataDbPath))) throw problem(400, 'Server filesystem paths must be absolute');
    try {
      root.path = await realpath(root.path);
      if (!(await stat(root.path)).isDirectory()) throw new Error('Not a directory');
      const server = await realpath(dataDir);
      const contains = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
      if (contains(root.path, server) || contains(server, root.path)) throw problem(400, 'Source folder and server storage must not overlap');
      if (root.metadataDbPath) {
        root.metadataDbPath = await realpath(root.metadataDbPath);
        if (!(await stat(root.metadataDbPath)).isFile() || contains(server, root.metadataDbPath)) throw problem(400, 'Metadata must be an existing Norea database outside server storage');
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      throw problem(400, 'Source folder or metadata database is unavailable');
    }
    if (roots().some(other => other.id !== root.id && other.path.toLowerCase() === root.path.toLowerCase())) throw problem(409, 'This folder is already connected');
  }

  function startScan(root: FolderRoot): ScanJob {
    if (closing) throw problem(503, 'Server is stopping');
    if (active.size) throw problem(409, 'A folder scan is already running');
    if (!root.enabled) throw problem(409, 'Enable the folder before scanning');
    const job: ScanJob = { id: randomUUID(), rootId: root.id, rootName: root.name, status: 'running', startedAt: Date.now(),
      summary: { registered: 0, unchanged: 0, skipped: 0, failed: 0, scanned: 0, cancelled: false } };
    saveJob(job);
    const controller = new AbortController();
    const promise = new Promise<void>(accept => setImmediate(accept)).then(async () => {
      try {
        job.summary = await scanFolder({ rootPath: root.path, metadataDbPath: root.metadataDbPath || undefined, dataDir, db, limits, signal: controller.signal,
          onItem(item: FolderIndexItem) {
            db.prepare('INSERT INTO admin_job_items(job_id,entry) VALUES(?,?)').run(job.id, JSON.stringify(item));
            job.summary.scanned++;
            job.summary[item.status]++;
            saveJob(job);
            if (item.status === 'registered') context.notify();
          },
        });
        job.status = job.summary.cancelled || controller.signal.aborted ? 'cancelled' : 'completed';
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      } finally {
        job.finishedAt = Date.now();
        saveJob(job);
        const exists = db.prepare('SELECT id FROM admin_roots WHERE id=?').get(root.id);
        if (exists) saveRoot({ ...getRoot(root.id), lastScanAt: job.finishedAt });
        active.delete(job.id);
        drainScheduledScans();
      }
    });
    active.set(job.id, { rootId: root.id, controller, promise });
    return { ...job };
  }

  function stopSchedule(id: string): void {
    pendingRoots.delete(id);
    const schedule = schedules.get(id);
    if (schedule) { clearInterval(schedule.timer); clearTimeout(schedule.debounce); schedule.watcher?.close(); schedules.delete(id); }
  }
  function drainScheduledScans(): void {
    if (closing || active.size) return;
    for (const id of pendingRoots) {
      pendingRoots.delete(id);
      const root = roots().find(item => item.id === id);
      if (root?.enabled && root.mode !== 'manual') { startScan(root); return; }
    }
  }
  function scheduleRoot(root: FolderRoot): void {
    stopSchedule(root.id);
    if (closing || !root.enabled || root.mode === 'manual') return;
    const attempt = () => { if (!closing) { pendingRoots.add(root.id); drainScheduledScans(); } };
    const timer = setInterval(attempt, root.intervalMinutes * 60_000);
    timer.unref();
    const schedule: { timer: typeof timer; debounce?: ReturnType<typeof setTimeout>; watcher?: FSWatcher } = { timer };
    schedules.set(root.id, schedule);
    if (root.mode === 'changes') {
      try {
        schedule.watcher = watch(root.path, { recursive: true }, () => {
          clearTimeout(schedule.debounce);
          schedule.debounce = setTimeout(attempt, 2000);
          schedule.debounce.unref();
        });
        schedule.watcher.on('error', () => { schedule.watcher?.close(); schedule.watcher = undefined; });
        schedule.watcher.unref();
      } catch { /* Periodic reconciliation remains active when filesystem watching is unavailable. */ }
    }
    schedule.debounce = setTimeout(attempt, 50);
    schedule.debounce.unref();
  }
  app.addHook('preClose', async () => {
    closing = true;
    for (const id of schedules.keys()) stopSchedule(id);
    for (const job of active.values()) job.controller.abort();
    await Promise.all([...active.values()].map(job => job.promise));
  });

  const assets: Record<string, { path: URL; type: string }> = {
    '/admin/': { path: new URL('../web/index.html', import.meta.url), type: 'text/html; charset=utf-8' },
    '/admin/admin.css': { path: new URL('../web/admin.css', import.meta.url), type: 'text/css; charset=utf-8' },
    '/admin/admin.js': { path: new URL('../webdist/admin.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
  };
  app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
  for (const [url, asset] of Object.entries(assets)) app.get(url, { schema: { hide: true } }, async (_request, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    try { return reply.type(asset.type).send(await readFile(asset.path)); }
    catch { return reply.code(503).type('text/plain').send('Console assets unavailable. Run pnpm build before starting the server.'); }
  });

  await app.register(async api => {
    api.addHook('onRequest', async request => { authenticate(db, request, true); });
    api.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    api.addHook('onRoute', route => { route.schema = { ...route.schema, security: [{ bearerAuth: [] }], tags: ['Administration'] }; });
    api.get('/overview', async () => {
      const counts = db.prepare(`SELECT COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END),0) AS chapters,COUNT(DISTINCT CASE WHEN deleted_at IS NULL THEN work_id END) AS works,COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END),0) AS deletedChapters FROM chapters`).get() as object;
      const packages = db.prepare("SELECT COUNT(*) AS revisions,COALESCE(SUM(json_extract(entry,'$.zipBytes')),0) AS zipBytes FROM revisions WHERE path IS NOT NULL").get() as object;
      return { ...counts, ...packages, plugins: listPlugins(db).length, roots: roots().length, runningJobs: active.size };
    });
    api.get('/plugins', async () => ({ items: listPlugins(db) }));
    api.post<{ Body: { url: string; name?: string } }>('/plugins', { schema: { body: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1, maxLength: 4096 }, name: { type: 'string', maxLength: 200 } } } } }, async request => registerPlugin(db, request.body));
    api.patch<{ Params: { id: string }; Body: { enabled: boolean } }>('/plugins/:id', { schema: { params: identifier, body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } }, async request => setPluginEnabled(db, request.params.id, request.body.enabled));
    api.delete<{ Params: { id: string } }>('/plugins/:id', { schema: { params: identifier } }, async (request, reply) => { if (!removePlugin(db, request.params.id)) throw problem(404, 'Plugin registration not found'); return reply.code(204).send(); });
    api.get('/roots', async () => ({ items: roots() }));
    api.post<{ Body: Omit<FolderRoot, 'id'> }>('/roots', { schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'path', 'mode', 'intervalMinutes'], properties: rootProperties } } }, async request => {
      const root: FolderRoot = { ...request.body, id: randomUUID(), enabled: request.body.enabled ?? true, metadataDbPath: request.body.metadataDbPath ?? '' };
      await validateRoot(root); saveRoot(root); scheduleRoot(root); return root;
    });
    api.patch<{ Params: { id: string }; Body: Partial<Omit<FolderRoot, 'id' | 'lastScanAt'>> }>('/roots/:id', { schema: { params: identifier, body: { type: 'object', additionalProperties: false, properties: rootProperties } } }, async request => {
      if ([...active.values()].some(job => job.rootId === request.params.id)) throw problem(409, 'Wait for this folder scan to finish before editing');
      const root = { ...getRoot(request.params.id), ...request.body };
      await validateRoot(root);
      getRoot(request.params.id);
      if ([...active.values()].some(job => job.rootId === root.id)) throw problem(409, 'Wait for this folder scan to finish before editing');
      saveRoot(root); scheduleRoot(root); return root;
    });
    api.delete<{ Params: { id: string } }>('/roots/:id', { schema: { params: identifier } }, async (request, reply) => {
      getRoot(request.params.id); stopSchedule(request.params.id);
      const jobs = [...active.values()].filter(job => job.rootId === request.params.id);
      for (const job of jobs) job.controller.abort();
      await Promise.all(jobs.map(job => job.promise));
      db.prepare('DELETE FROM admin_roots WHERE id=?').run(request.params.id);
      return reply.code(204).send();
    });
    api.post<{ Params: { id: string } }>('/roots/:id/scan', { schema: { params: identifier } }, async (request, reply) => reply.code(202).send(startScan(getRoot(request.params.id))));
    api.get('/jobs', async () => ({ items: (db.prepare('SELECT entry FROM admin_jobs ORDER BY rowid DESC LIMIT 100').all() as { entry: string }[]).map(row => JSON.parse(row.entry)) }));
    api.get<{ Params: { id: string }; Querystring: { offset: number; limit: number } }>('/jobs/:id', { schema: { params: identifier, querystring: { type: 'object', properties: pagination } } }, async request => ({
      job: getJob(request.params.id),
      items: (db.prepare('SELECT entry FROM admin_job_items WHERE job_id=? ORDER BY sequence LIMIT ? OFFSET ?').all(request.params.id, request.query.limit, request.query.offset) as { entry: string }[]).map(row => JSON.parse(row.entry)),
      total: (db.prepare('SELECT COUNT(*) AS count FROM admin_job_items WHERE job_id=?').get(request.params.id) as { count: number }).count,
    }));
    api.post<{ Params: { id: string } }>('/jobs/:id/cancel', { schema: { params: identifier } }, async request => { getJob(request.params.id); const job = active.get(request.params.id); job?.controller.abort(); if (job) await job.promise; return getJob(request.params.id); });
    api.get<{ Querystring: { search?: string; deleted?: boolean; offset: number; limit: number } }>('/chapters', { schema: { querystring: { type: 'object', properties: { ...pagination, search: { type: 'string', maxLength: 500 }, deleted: { type: 'boolean', default: false } } } } }, async request => {
      const where = "WHERE (deleted_at IS NOT NULL)=? AND (?='' OR instr(lower(json_extract(entry,'$.manifest.novel.name') || ' ' || json_extract(entry,'$.manifest.chapter.name') || ' ' || json_extract(entry,'$.manifest.identity.pluginId')),lower(?))>0)";
      const args = [request.query.deleted ? 1 : 0, request.query.search ?? '', request.query.search ?? ''];
      const rows = db.prepare(`SELECT entry FROM chapters ${where} ORDER BY json_extract(entry,'$.manifest.novel.name'),work_id,json_extract(entry,'$.manifest.chapter.position'),id LIMIT ? OFFSET ?`).all(...args, request.query.limit, request.query.offset) as { entry: string }[];
      return { items: rows.map(row => JSON.parse(row.entry) as CatalogEntry), total: (db.prepare(`SELECT COUNT(*) AS count FROM chapters ${where}`).get(...args) as { count: number }).count };
    });
    api.get<{ Params: { id: string } }>('/chapters/:id', { schema: { params: identifier } }, async request => ({ entry: chapterRow(db, request.params.id).catalog, revisions: (db.prepare('SELECT entry FROM revisions WHERE chapter_id=? ORDER BY rowid DESC').all(request.params.id) as { entry: string }[]).map(row => JSON.parse(row.entry)) }));
    const devices = () => (db.prepare('SELECT id,device_name AS deviceName,created_at AS createdAt,last_seen_at AS lastSeenAt,blocked FROM devices ORDER BY created_at,id').all() as { id: string; deviceName: string; createdAt: number; lastSeenAt: number; blocked: number }[]).map(device => ({ ...device, blocked: Boolean(device.blocked) }));
    api.get('/devices', async () => ({ items: devices() }));
    api.patch<{ Params: { id: string }; Body: { blocked: boolean } }>('/devices/:id', { schema: { params: identifier, body: { type: 'object', additionalProperties: false, required: ['blocked'], properties: { blocked: { type: 'boolean' } } } } }, async request => {
      const result = db.prepare('UPDATE devices SET blocked=? WHERE id=?').run(request.body.blocked ? 1 : 0, request.params.id);
      if (!result.changes) throw problem(404, 'Device not found');
      return devices().find(device => device.id === request.params.id)!;
    });
    const settings = () => ({ anonymousRead: context.getAnonymousRead(), limits, dataDir });
    api.get('/settings', async () => settings());
    api.patch<{ Body: { anonymousRead: boolean } }>('/settings', { schema: { body: { type: 'object', additionalProperties: false, required: ['anonymousRead'], properties: { anonymousRead: { type: 'boolean' } } } } }, async request => {
      db.prepare("INSERT INTO admin_settings(key,value) VALUES('anonymousRead',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(request.body.anonymousRead));
      context.setAnonymousRead(request.body.anonymousRead); context.notify(); return settings();
    });
  }, { prefix: '/api/v1/admin' });
  app.addHook('onReady', async () => { for (const root of roots()) scheduleRoot(root); });
}
