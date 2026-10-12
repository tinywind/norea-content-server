import { randomUUID } from 'node:crypto';
import { lstatSync, watch, type FSWatcher } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { authenticate } from './auth.ts';
import { problem, transaction } from './db.ts';
import { chapterRow, type CatalogEntry, type Limits } from './packages.ts';
import { initializePluginRegistry, listPlugins, registerPlugin, removePlugin, setPluginEnabled } from './plugin-registry.ts';
import { scanFolder, type FolderIndexItem, type FolderIndexSummary } from './folder-indexer.ts';

interface ScanSettings {
  path: string;
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
const scanProperties = {
  mode: { type: 'string', enum: ['manual', 'periodic', 'changes'] },
  intervalMinutes: { type: 'integer', minimum: 1, maximum: 1440 }, enabled: { type: 'boolean' },
};

export function initializeAdministration(db: DatabaseSync): void {
  initializePluginRegistry(db);
  db.exec(`
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
  let pendingScan = false;
  let schedule: { timer: ReturnType<typeof setInterval>; debounce?: ReturnType<typeof setTimeout>; watcher?: FSWatcher } | undefined;
  const storageSettings = (): ScanSettings => {
    const saved = db.prepare("SELECT value FROM admin_settings WHERE key='scan'").get() as { value: string } | undefined;
    return { mode: 'manual', intervalMinutes: 15, enabled: true, ...saved && JSON.parse(saved.value), path: resolve(dataDir, 'contents') };
  };
  const saveSettings = (value: ScanSettings) => db.prepare("INSERT INTO admin_settings(key,value) VALUES('scan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
  const getJob = (id: string): ScanJob => {
    const row = db.prepare('SELECT entry FROM admin_jobs WHERE id=?').get(id) as { entry: string } | undefined;
    if (!row) throw problem(404, 'Scan job not found');
    return JSON.parse(row.entry);
  };
  const saveJob = (job: ScanJob) => db.prepare('INSERT INTO admin_jobs(id,entry) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry').run(job.id, JSON.stringify(job));
  for (const row of db.prepare('SELECT entry FROM admin_jobs').all() as { entry: string }[]) {
    const job = JSON.parse(row.entry) as ScanJob;
    if (job.status === 'running') saveJob({ ...job, status: 'interrupted', finishedAt: Date.now(), error: 'Server stopped before the scan completed. Run the folder scan again.' });
  }

  function startScan(root: ScanSettings): ScanJob {
    if (closing) throw problem(503, 'Server is stopping');
    if (active.size) throw problem(409, 'A folder scan is already running');
    const job: ScanJob = { id: randomUUID(), rootId: 'contents', rootName: 'Contents', status: 'running', startedAt: Date.now(),
      summary: { registered: 0, unchanged: 0, skipped: 0, failed: 0, scanned: 0, cancelled: false } };
    saveJob(job);
    const controller = new AbortController();
    const pendingItems: FolderIndexItem[] = [];
    let lastFlushAt = Date.now();
    const insertItem = db.prepare('INSERT INTO admin_job_items(job_id,entry) VALUES(?,?)');
    const flushItems = () => {
      if (!pendingItems.length) return;
      transaction(db, () => {
        for (const item of pendingItems) insertItem.run(job.id, JSON.stringify(item));
        saveJob(job);
      });
      pendingItems.length = 0;
      lastFlushAt = Date.now();
    };
    const promise = new Promise<void>(accept => setImmediate(accept)).then(async () => {
      try {
        job.summary = await scanFolder({ dataDir, db, limits, signal: controller.signal, onWorkChange: context.notify,
          onItem(item: FolderIndexItem) {
            pendingItems.push(item);
            job.summary.scanned++;
            job.summary[item.status]++;
            if (pendingItems.length >= 100 || Date.now() - lastFlushAt >= 200) flushItems();
            if (item.status === 'registered') context.notify();
          },
        });
        job.status = job.summary.cancelled || controller.signal.aborted ? 'cancelled' : 'completed';
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      } finally {
        flushItems();
        job.finishedAt = Date.now();
        saveJob(job);
        saveSettings({ ...storageSettings(), lastScanAt: job.finishedAt });
        active.delete(job.id);
        drainScheduledScans();
      }
    });
    active.set(job.id, { rootId: 'contents', controller, promise });
    return { ...job };
  }

  function stopSchedule(): void {
    pendingScan = false;
    if (schedule) { clearInterval(schedule.timer); clearTimeout(schedule.debounce); schedule.watcher?.close(); schedule = undefined; }
  }
  function drainScheduledScans(): void {
    if (closing || active.size || !pendingScan) return;
    pendingScan = false;
    const root = storageSettings();
    if (root.enabled && root.mode !== 'manual') startScan(root);
  }
  function scheduleScan(): void {
    stopSchedule();
    const root = storageSettings();
    if (closing || !root.enabled || root.mode === 'manual') return;
    const attempt = () => { if (!closing) { pendingScan = true; drainScheduledScans(); } };
    const timer = setInterval(attempt, root.intervalMinutes * 60_000);
    timer.unref();
    const current: NonNullable<typeof schedule> = { timer };
    schedule = current;
    if (root.mode === 'changes') {
      try {
        current.watcher = watch(root.path, { recursive: true }, (_event, filename) => {
          if (filename) {
            const path = filename.toString();
            if (path.split(/[\\/]/).some(part => part.startsWith('.'))) return;
            if (db.prepare('SELECT 1 FROM revisions WHERE path=?').get(join('contents', path))) return;
            if (_event === 'change') {
              try { if (lstatSync(join(root.path, path)).isDirectory()) return; }
              catch { /* Missing paths still schedule reconciliation. */ }
            }
          }
          clearTimeout(current.debounce);
          current.debounce = setTimeout(attempt, 2000);
          current.debounce.unref();
        });
        current.watcher.on('error', () => { current.watcher?.close(); current.watcher = undefined; });
        current.watcher.unref();
      } catch { /* Periodic reconciliation remains active when filesystem watching is unavailable. */ }
    }
    current.debounce = setTimeout(attempt, 50);
    current.debounce.unref();
  }
  app.addHook('preClose', async () => {
    closing = true;
    stopSchedule();
    for (const job of active.values()) job.controller.abort();
    await Promise.all([...active.values()].map(job => job.promise));
  });

  const assets: Record<string, { path: URL; type: string }> = {
    '/admin/': { path: new URL('../web/index.html', import.meta.url), type: 'text/html; charset=utf-8' },
    '/admin/admin.css': { path: new URL('../web/admin.css', import.meta.url), type: 'text/css; charset=utf-8' },
    '/admin/admin.js': { path: new URL('../webdist/admin.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
  };
  for (const page of ['overview', 'plugins', 'storage', 'content', 'jobs', 'devices', 'settings']) {
    assets[`/admin/${page}`] = assets['/admin/'];
    assets[`/admin/${page}/`] = assets['/admin/'];
  }
  app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
  for (const [url, asset] of Object.entries(assets)) app.get(url, { schema: { hide: true } }, async (_request, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
      const works = (db.prepare('SELECT COUNT(*) AS n FROM (SELECT id FROM works UNION SELECT work_id FROM chapters WHERE deleted_at IS NULL)').get() as { n: number }).n;
      const packages = db.prepare("SELECT COUNT(*) AS revisions,COALESCE(SUM(json_extract(entry,'$.zipBytes')),0) AS zipBytes FROM revisions WHERE path IS NOT NULL").get() as object;
      return { ...counts, works, ...packages, plugins: listPlugins(db).length, contentsPath: storageSettings().path, runningJobs: active.size };
    });
    api.get('/plugins', async () => ({ items: listPlugins(db) }));
    api.post<{ Body: { url: string; name?: string } }>('/plugins', { schema: { body: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1, maxLength: 4096 }, name: { type: 'string', maxLength: 200 } } } } }, async request => registerPlugin(db, request.body));
    api.patch<{ Params: { id: string }; Body: { enabled: boolean } }>('/plugins/:id', { schema: { params: identifier, body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } }, async request => setPluginEnabled(db, request.params.id, request.body.enabled));
    api.delete<{ Params: { id: string } }>('/plugins/:id', { schema: { params: identifier } }, async (request, reply) => { if (!removePlugin(db, request.params.id)) throw problem(404, 'Plugin registration not found'); return reply.code(204).send(); });
    api.get('/storage', async () => storageSettings());
    api.patch<{ Body: Partial<Pick<ScanSettings, 'mode' | 'intervalMinutes' | 'enabled'>> }>('/storage', { preValidation: async request => {
      if (request.body && typeof request.body === 'object' && Object.keys(request.body).some(key => !Object.hasOwn(scanProperties, key))) throw problem(400, 'Only scan mode, intervalMinutes, and enabled may be changed');
    }, schema: { body: { type: 'object', additionalProperties: false, properties: scanProperties } } }, async request => {
      const value = { ...storageSettings(), ...request.body };
      saveSettings(value); scheduleScan(); return value;
    });
    api.post('/storage/scan', async (_request, reply) => reply.code(202).send(startScan(storageSettings())));
    api.get('/jobs', async () => ({ items: (db.prepare('SELECT entry FROM admin_jobs ORDER BY rowid DESC LIMIT 100').all() as { entry: string }[]).map(row => JSON.parse(row.entry)) }));
    api.get<{ Params: { id: string }; Querystring: { offset: number; limit: number } }>('/jobs/:id', { schema: { params: identifier, querystring: { type: 'object', properties: pagination } } }, async request => ({
      job: getJob(request.params.id),
      items: (db.prepare('SELECT entry FROM admin_job_items WHERE job_id=? ORDER BY sequence LIMIT ? OFFSET ?').all(request.params.id, request.query.limit, request.query.offset) as { entry: string }[]).map(row => JSON.parse(row.entry)),
      total: (db.prepare('SELECT COUNT(*) AS count FROM admin_job_items WHERE job_id=?').get(request.params.id) as { count: number }).count,
    }));
    api.post<{ Params: { id: string } }>('/jobs/:id/cancel', { schema: { params: identifier } }, async request => { getJob(request.params.id); const job = active.get(request.params.id); job?.controller.abort(); if (job) await job.promise; return getJob(request.params.id); });
    api.get<{ Querystring: { search?: string; workId?: string; deleted?: boolean; offset: number; limit: number } }>('/chapters', { schema: { querystring: { type: 'object', properties: { ...pagination, workId: { type: 'string', pattern: '^[0-9a-f]{64}$' }, search: { type: 'string', maxLength: 500 }, deleted: { type: 'boolean', default: false } } } } }, async request => {
      const where = "WHERE (deleted_at IS NOT NULL)=? AND (?='' OR work_id=?) AND (?='' OR instr(lower(json_extract(entry,'$.manifest.novel.name') || ' ' || json_extract(entry,'$.manifest.chapter.name') || ' ' || json_extract(entry,'$.manifest.identity.pluginId')),lower(?))>0)";
      const args = [request.query.deleted ? 1 : 0, request.query.workId ?? '', request.query.workId ?? '', request.query.search ?? '', request.query.search ?? ''];
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
  app.addHook('onReady', async () => { scheduleScan(); });
}
