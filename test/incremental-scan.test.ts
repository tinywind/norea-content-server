import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db.ts';
import { scanFolder, type FolderIndexOptions } from '../src/folder-indexer.ts';
import { defaultLimits } from '../src/packages.ts';

async function fixture() {
  await fsp.mkdir('.tmp', { recursive: true });
  const dataDir = await fsp.mkdtemp(resolve('.tmp/incremental-scan-'));
  const db = openDatabase(dataDir);
  const addWork = async (name: string) => {
    const work = join(dataDir, 'contents/example', name);
    await fsp.mkdir(work, { recursive: true });
    await fsp.writeFile(join(work, 'novel.json'), JSON.stringify({ identity: { pluginId: 'example', novelPath: '/' + name }, novel: { name } }));
    return work;
  };
  const addChapter = async (work: string, name: string) => {
    const chapter = join(work, name); await fsp.mkdir(chapter, { recursive: true });
    await fsp.writeFile(join(chapter, 'content.html'), '<p>Complete chapter</p>'); return chapter;
  };
  const work = await addWork('Book'); const chapter = await addChapter(work, '1-First');
  const run = (options: Partial<FolderIndexOptions> = {}) => scanFolder({ dataDir, db, limits: defaultLimits, ...options });
  return { dataDir, db, work, chapter, addWork, addChapter, run, close: async () => { db.close(); await fsp.rm(dataDir, { recursive: true, force: true }); } };
}

test('incremental discovery never opens or stats known complete or unsupported chapter folders', async t => {
  const f = await fixture();
  try {
    const rejected = join(f.work, '2-Unsupported'); await fsp.mkdir(join(rejected, 'loose-media'), { recursive: true });
    const archive = join(f.work, '3-Archive'); await fsp.mkdir(archive); await fsp.writeFile(join(archive, 'outer.zip'), 'Unsupported archive');
    await f.run();
    const accesses: string[] = [];
    const record = (path: unknown) => { const value = String(path); if ([f.chapter, rejected, archive].some(root => value === root || value.startsWith(root + sep))) accesses.push(value); };
    for (const method of ['readdir', 'lstat'] as const) {
      const original = fsp[method];
      t.mock.method(fsp, method, (...args: Parameters<typeof original>) => { record(args[0]); return Reflect.apply(original, fsp, args); });
    }
    for (const method of ['readdirSync', 'lstatSync'] as const) {
      const original = fs[method];
      t.mock.method(fs, method, (...args: Parameters<typeof original>) => { record(args[0]); return Reflect.apply(original, fs, args); });
    }
    syncBuiltinESMExports();
    const unchanged = await f.run();
    assert.equal(unchanged.unchanged, 2); assert.equal(unchanged.skipped, 2);
    assert.deepEqual(accesses, [], 'Previously classified chapter folders must not be visited');
    const next = await f.addChapter(f.work, '4-Fourth'); const other = await f.addWork('Other'); await f.addChapter(other, '1-One');
    const added = await f.run();
    assert.equal(added.registered, 3); assert.equal(added.failed, 0);
    assert.deepEqual(accesses, []); assert.ok(fs.existsSync(join(next, 'content.html')));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('a full inspection detects in-place edits that normal discovery deliberately leaves alone', async () => {
  const f = await fixture();
  try {
    await f.run(); const before = f.db.prepare('SELECT entry FROM chapters').get()!.entry;
    await fsp.writeFile(join(f.chapter, 'content.html'), '<p>Changed body</p>');
    assert.equal((await f.run()).registered, 0);
    assert.equal(f.db.prepare('SELECT entry FROM chapters').get()!.entry, before);
    assert.equal((await f.run({ full: true })).registered, 1);
    assert.notEqual(f.db.prepare('SELECT entry FROM chapters').get()!.entry, before);
  } finally { await f.close(); }
});

test('discovery reuses validated database chapters without scanner checkpoints', async t => {
  const f = await fixture();
  try {
    await f.run(); f.db.prepare('DELETE FROM scan_checkpoints WHERE path=?').run(f.chapter);
    const original = fsp.readdir;
    t.mock.method(fsp, 'readdir', (...args: Parameters<typeof original>) => {
      assert.notEqual(String(args[0]), f.chapter, 'An already validated chapter needs no scanner checkpoint');
      return Reflect.apply(original, fsp, args);
    }); syncBuiltinESMExports();
    assert.equal((await f.run()).unchanged, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('persisted scan results survive restart and reject paths outside contents', async t => {
  const f = await fixture();
  try {
    const rejected = join(f.work, '2-Unsupported'); await fsp.mkdir(join(rejected, 'loose-media'), { recursive: true });
    await f.run();
    const restarted = openDatabase(f.dataDir);
    try {
      const original = fsp.readdir;
      t.mock.method(fsp, 'readdir', (...args: Parameters<typeof original>) => {
        assert.ok(![f.chapter, rejected].includes(String(args[0])));
        return Reflect.apply(original, fsp, args);
      }); syncBuiltinESMExports();
      const result = await f.run({ db: restarted });
      assert.equal(result.unchanged, 2); assert.equal(result.skipped, 1);
      await assert.rejects(f.run({ changedPaths: ['../outside'] }), /outside the content directory/);
    } finally { restarted.close(); }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('changed-path scans inspect the affected chapter without visiting another work', async t => {
  const f = await fixture();
  try {
    const other = await f.addWork('Other'); await f.addChapter(other, '1-One'); await f.run();
    await fsp.writeFile(join(f.chapter, 'content.html'), '<p>Edited after indexing</p>');
    const original = fsp.readdir; const visited: string[] = [];
    t.mock.method(fsp, 'readdir', (...args: Parameters<typeof original>) => { visited.push(String(args[0])); return Reflect.apply(original, fsp, args); }); syncBuiltinESMExports();
    const result = await f.run({ changedPaths: ['example/Book/1-First/content.html'] });
    assert.equal(result.registered, 1); assert.equal(result.failed, 0);
    assert.equal(visited.some(path => path === other || path.startsWith(other + sep)), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('incomplete copies are retried and cached rejections are reconsidered on explicit changes', async () => {
  const f = await fixture();
  try {
    const pending = join(f.work, '2-Copying'); await fsp.mkdir(pending);
    const rejected = join(f.work, '3-Unsupported'); await fsp.mkdir(join(rejected, 'loose-media'), { recursive: true });
    assert.equal((await f.run()).skipped, 2);
    await fsp.writeFile(join(pending, 'content.html'), '<p>Copy finished</p>');
    assert.equal((await f.run()).registered, 1);
    await fsp.rm(join(rejected, 'loose-media'), { recursive: true });
    await fsp.writeFile(join(rejected, 'content.html'), '<p>Repaired</p>');
    assert.equal((await f.run()).registered, 0);
    assert.equal((await f.run({ changedPaths: ['example/Book/3-Unsupported/content.html'] })).registered, 1);
  } finally { await f.close(); }
});

test('external chapter and work removal updates the index without preventing rediscovery', async () => {
  const f = await fixture();
  try {
    await f.run(); await fsp.rm(f.chapter, { recursive: true });
    const removed = await f.run(); assert.equal(removed.removed, 1);
    assert.equal(f.db.prepare('SELECT path FROM chapters').get()!.path, null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM chapter_tombstones').get()!.n, 0);
    await f.addChapter(f.work, '1-First'); assert.equal((await f.run()).registered, 1);
    await fsp.rm(f.work, { recursive: true });
    assert.ok((await f.run()).removed > 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM works').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_tombstones').get()!.n, 0);
    await f.addWork('Book'); await f.addChapter(f.work, '1-First'); assert.equal((await f.run()).registered, 2);
  } finally { await f.close(); }
});

test('a failed directory listing never removes cached work or chapter availability', async t => {
  const f = await fixture();
  try {
    await f.run(); const original = fsp.readdir;
    t.mock.method(fsp, 'readdir', (...args: Parameters<typeof original>) => {
      if (String(args[0]) === f.work) return Promise.reject(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
      return Reflect.apply(original, fsp, args);
    }); syncBuiltinESMExports();
    await assert.rejects(f.run(), /Access denied/);
    assert.ok(f.db.prepare('SELECT path FROM chapters').get()!.path);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM works').get()!.n, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});
