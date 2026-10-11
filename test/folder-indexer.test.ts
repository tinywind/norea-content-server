import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, statSync, utimesSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ZipFile } from 'yazl';
import yauzl from 'yauzl';
import { openDatabase } from '../src/db.ts';
import { defaultLimits, deleteChapter, digest, packageStream } from '../src/packages.ts';
import { scanFolder, type FolderIndexItem } from '../src/folder-indexer.ts';

async function zip(entries: Record<string, string | Buffer>) {
  const archive = new ZipFile();
  for (const [name, content] of Object.entries(entries)) archive.addBuffer(Buffer.from(content), name);
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const temp = await mkdtemp(resolve('.tmp/folder-index-'));
  const rootPath = join(temp, 'original');
  const dataDir = join(temp, 'server');
  const directory = join(rootPath, 'contents/example/Book-book/1-First');
  await mkdir(directory, { recursive: true });
  const metadataDbPath = join(rootPath, 'norea.sqlite');
  const metadata = new DatabaseSync(metadataDbPath);
  metadata.exec(`CREATE TABLE novel(id INTEGER PRIMARY KEY,plugin_id TEXT,path TEXT,name TEXT,author TEXT,summary TEXT,is_local INTEGER);
    CREATE TABLE chapter(id INTEGER PRIMARY KEY,novel_id INTEGER,path TEXT,name TEXT,chapter_number TEXT,position INTEGER,page TEXT,content_type TEXT,stored_content_type TEXT,is_downloaded INTEGER,media_repair_needed INTEGER);
    CREATE TABLE installed_plugin(id TEXT PRIMARY KEY);
    INSERT INTO novel VALUES(1,'example','/book','Book','Writer','Summary',0);
    INSERT INTO chapter VALUES(1,1,'/first','First','1',1,'1','html','html',1,0);`);
  metadata.close();
  await writeFile(join(directory, 'content.html'), '<p>norea-media://reader-asset/prose</p><img src="norea-media://reader-asset/a.png">');
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, updatedAt: 12, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 5, status: 'stored', updatedAt: 12 }] } }));
  await writeFile(join(directory, 'media.zip'), await zip({ 'a.png': 'image' }));
  const db = openDatabase(dataDir);
  const items: FolderIndexItem[] = [];
  const run = (overrides = {}) => scanFolder({ rootPath, dataDir, metadataDbPath, db, limits: defaultLimits, onItem: item => { items.push(item); }, ...overrides });
  const close = async () => { db.close(); await rm(temp, { recursive: true, force: true }); };
  return { temp, rootPath, dataDir, metadataDbPath, directory, db, items, run, close };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(path));
    else { const info = await stat(path); result[path] = `${info.size}/${info.mtimeMs}/${digest(await readFile(path))}`; }
  }
  return result;
}

async function extractPackage(buffer: Buffer): Promise<Record<string, string>> {
  const archive = await new Promise<yauzl.ZipFile>((accept, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, value) => error ? reject(error) : accept(value!)));
  const files: Record<string, string> = {};
  await new Promise<void>((accept, reject) => {
    archive.on('error', reject); archive.on('end', accept);
    archive.on('entry', entry => { archive.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      void (async () => { const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk); files[entry.fileName] = Buffer.concat(chunks).toString(); archive.readEntry(); })().catch(reject);
    }); }); archive.readEntry();
  });
  return files;
}

test('indexes a complete chapter, verifies downloadable portable media, and rescans without changes or original writes', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.rootPath);
    assert.equal((await f.run()).registered, 1);
    const id = f.items.find(item => item.status === 'registered')!.chapterId!;
    const chunks: Buffer[] = []; for await (const chunk of packageStream(f.db, f.dataDir, id).open()) chunks.push(chunk);
    const files = await extractPackage(Buffer.concat(chunks));
    assert.equal(files['media/a.png'], 'image');
    assert.match(files['content.html'], /src="media\/a.png"/);
    assert.match(files['content.html'], /<p>norea-media:\/\/reader-asset\/prose<\/p>/);
    assert.equal(JSON.parse(files['media-manifest.json']).updatedAt, 0);
    assert.equal((await f.run()).unchanged, 1);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM catalog_changes').get() as { n: number }).n, 1);
    assert.deepEqual(await snapshot(f.rootPath), before);
  } finally { await f.close(); }
});

test('indexes archived local chapters without installed or registered plugins and never checks the source site', async t => {
  const f = await fixture();
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Source site is unavailable'); });
  try {
    const metadata = new DatabaseSync(f.metadataDbPath);
    metadata.exec('DROP TABLE installed_plugin'); metadata.close();
    const before = await snapshot(f.rootPath);
    assert.equal((await f.run()).registered, 1);
    const id = f.items.find(item => item.status === 'registered')!.chapterId!;
    assert.equal((await f.run()).unchanged, 1);
    await rename(join(f.rootPath, 'contents/example'), join(f.temp, 'disconnected-original'));
    assert.equal((await f.run()).registered, 0);
    assert.equal(packageStream(f.db, f.dataDir, id).catalog.deleted, false);
    await rename(join(f.temp, 'disconnected-original'), join(f.rootPath, 'contents/example'));
    assert.deepEqual(await snapshot(f.rootPath), before);
    assert.equal(network.mock.callCount(), 0);
  } finally { await f.close(); }
});

test('registers a complete archived ZIP using only its manifest and validates its source folder', async t => {
  const f = await fixture();
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Source site is unavailable'); });
  try {
    const source = join(f.rootPath, 'contents/retired-site'); await mkdir(source);
    const body = '<p>Archived chapter</p>';
    const manifest = { packageVersion: 1, identity: { pluginId: 'retired:site', novelPath: '/removed', chapterPath: '/first' },
      novel: { name: 'Removed work', isLocal: false }, chapter: { name: 'First', position: 1, chapterNumber: '1', contentType: 'html', page: '1' },
      bodyPath: 'content.html', files: [{ path: 'content.html', size: Buffer.byteLength(body), sha256: digest(body) }] };
    const archive = await zip({ 'manifest.json': JSON.stringify(manifest), 'content.html': body });
    await writeFile(join(source, 'archived.zip'), archive);
    assert.equal((await f.run({ metadataDbPath: undefined })).registered, 1);
    const imported = f.items.find(item => item.status === 'registered')!;
    assert.equal(imported.sourceId, 'retired:site');
    assert.equal(packageStream(f.db, f.dataDir, imported.chapterId!).catalog.manifest.identity.novelPath, '/removed');
    const wrong = join(f.rootPath, 'contents/unrelated'); await mkdir(wrong);
    await writeFile(join(wrong, 'mismatched.zip'), archive);
    await f.run({ metadataDbPath: undefined });
    assert.ok(f.items.some(item => item.path.endsWith('mismatched.zip') && item.status === 'skipped' && /source.*folder/i.test(item.reason ?? '')));
    assert.equal(network.mock.callCount(), 0);
  } finally { await f.close(); }
});

test('skips missing metadata, incomplete media, and unfinished directories', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run({ metadataDbPath: undefined })).registered, 0);
    assert.match(f.items.at(-1)!.reason!, /metadata/i);
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ version: 1, complete: false, media: { files: [] } }));
    assert.equal((await f.run()).registered, 0);
    assert.match(f.items.at(-1)!.reason!, /incomplete/i);
    await mkdir(join(f.rootPath, 'contents/example/.unfinished.tmp'), { recursive: true });
    await f.run();
    assert.ok(f.items.some(item => /unfinished/i.test(item.reason ?? '')));
  } finally { await f.close(); }
});

test('rejects extra media entries, preserves tombstones, and stops on cancellation', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'media.zip'), await zip({ 'a.png': 'image', 'unexpected.png': 'extra' }));
    assert.equal((await f.run()).registered, 0);
    await writeFile(join(f.directory, 'media.zip'), await zip({ 'a.png': 'image' }));
    await f.run();
    const id = f.items.find(item => item.status === 'registered')!.chapterId!;
    deleteChapter(f.db, f.dataDir, id);
    assert.equal((await f.run()).registered, 0);
    assert.ok(f.items.some(item => /deleted/i.test(item.reason ?? '')));
    const controller = new AbortController(); controller.abort();
    assert.equal((await f.run({ signal: controller.signal })).cancelled, true);
  } finally { await f.close(); }
});

test('rejects overlapping roots, symlink roots, and media traversal names', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ dataDir: join(f.rootPath, 'server') }), /overlap/i);
    const alias = join(f.temp, 'alias'); await symlink(f.rootPath, alias, 'junction');
    await assert.rejects(f.run({ rootPath: alias }), /symbolic|symlink/i);
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, media: { files: [{ fileName: '../a.png', path: 'media/../a.png', bytes: 5, status: 'stored' }] } }));
    assert.equal((await f.run()).registered, 0);
  } finally { await f.close(); }
});

test('accepts a multi-source identity from content metadata after its plugin is uninstalled', async () => {
  const f = await fixture();
  try {
    const metadata = new DatabaseSync(f.metadataDbPath);
    metadata.exec("UPDATE novel SET plugin_id='example:site'; DROP TABLE installed_plugin;"); metadata.close();
    const { rename } = await import('node:fs/promises');
    await rename(join(f.rootPath, 'contents/example'), join(f.rootPath, 'contents/example-site'));
    assert.equal((await f.run()).registered, 1);
  } finally { await f.close(); }
});

test('reads a live WAL snapshot without creating or changing files in the original root', async () => {
  const f = await fixture();
  const live = new DatabaseSync(f.metadataDbPath);
  try {
    live.exec("PRAGMA journal_mode=WAL; UPDATE novel SET author='WAL author';");
    const before = await snapshot(f.rootPath);
    assert.equal((await f.run()).registered, 1);
    const row = f.db.prepare('SELECT entry FROM chapters').get() as { entry: string };
    assert.equal(JSON.parse(row.entry).manifest.novel.author, 'WAL author');
    assert.deepEqual(await snapshot(f.rootPath), before);
  } finally { live.close(); await f.close(); }
});

test('imports a current package without metadata and rejects configured expansion limits', async () => {
  const f = await fixture();
  try {
    await f.run();
    const id = f.items.find(item => item.status === 'registered')!.chapterId!;
    const chunks: Buffer[] = []; for await (const chunk of packageStream(f.db, f.dataDir, id).open()) chunks.push(chunk);
    await writeFile(join(f.rootPath, 'contents/example/export.zip'), Buffer.concat(chunks));
    const scan = await f.run({ metadataDbPath: undefined });
    assert.equal(scan.unchanged, 1);
    assert.ok(f.items.some(item => item.path.endsWith('export.zip') && item.status === 'unchanged'));
    const bounded = await f.run({ limits: { zipBytes: 100, expandedBytes: 100, files: 2 } });
    assert.equal(bounded.registered, 0);
    assert.equal(bounded.unchanged, 0);
    assert.equal((await readdir(join(f.dataDir, 'staging'))).length, 0);
  } finally { await f.close(); }
});

test('converts only asset attributes and preserves quoted greater-than characters and prose', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'content.html'), '<img title="1 > 0" src="norea-media://reader-asset/a.png"><div style="background:url(\'norea-media://reader-asset/a.png\')">body</div><!-- <img src="norea-media://reader-asset/comment"> -->');
    assert.equal((await f.run()).registered, 1, JSON.stringify(f.items));
    const id = f.items.find(item => item.status === 'registered')!.chapterId!;
    const chunks: Buffer[] = []; for await (const chunk of packageStream(f.db, f.dataDir, id).open()) chunks.push(chunk);
    const files = await extractPackage(Buffer.concat(chunks));
    assert.match(files['content.html'], /title="1 > 0" src="media\/a.png"/);
    assert.match(files['content.html'], /url\('media\/a.png'\)/);
    assert.match(files['content.html'], /reader-asset\/comment/);
  } finally { await f.close(); }
});

test('cancels between chapter operations and removes only owned server staging files', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.rootPath, 'contents/example/Book-book/2-Second'));
    const before = await snapshot(f.rootPath);
    const controller = new AbortController();
    const result = await f.run({ signal: controller.signal, onItem: (item: FolderIndexItem) => { f.items.push(item); controller.abort(); } });
    assert.equal(result.cancelled, true);
    assert.equal(result.registered, 1);
    assert.equal(result.scanned, 1);
    assert.deepEqual(await readdir(join(f.dataDir, 'staging')), []);
    assert.deepEqual(await snapshot(f.rootPath), before);
  } finally { await f.close(); }
});

test('rejects a staging symlink before any writes can reach the original root', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.rootPath);
    await symlink(f.rootPath, join(f.dataDir, 'staging'), 'junction');
    await assert.rejects(f.run(), /symbolic|symlink/i);
    assert.deepEqual(await snapshot(f.rootPath), before);
  } finally { await f.close(); }
});

test('recovers renamed work and chapter folders only from unique database identities', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.rootPath);
    const renamedWork = join(f.rootPath, 'contents/example/Previous-title-book');
    await rename(join(f.rootPath, 'contents/example/Book-book'), renamedWork);
    await rename(join(renamedWork, '1-First'), join(renamedWork, '1-Previous-chapter-title'));
    const renamedSnapshot = await snapshot(f.rootPath);
    const result = await f.run();
    assert.equal(result.registered, 1, JSON.stringify(f.items));
    const row = f.db.prepare('SELECT entry FROM chapters').get() as { entry: string };
    assert.deepEqual(JSON.parse(row.entry).manifest.identity, { pluginId: 'example', novelPath: '/book', chapterPath: '/first' });
    assert.equal(Object.keys(before).length, Object.keys(renamedSnapshot).length);
    assert.deepEqual(await snapshot(f.rootPath), renamedSnapshot);
  } finally { await f.close(); }
});

test('skips ambiguous renamed copies and prefers the exact current folder over an older copy', async () => {
  const f = await fixture();
  try {
    const other = join(f.rootPath, 'contents/example/Older-title-book/1-Older-chapter');
    await cp(f.directory, other, { recursive: true });
    const exact = await f.run();
    assert.equal(exact.registered, 1);
    assert.equal(exact.skipped, 1);
    assert.ok(f.items.some(item => item.path === other && item.status === 'skipped'));
    await rename(f.directory, join(f.rootPath, 'contents/example/Book-book/1-Renamed'));
    const ambiguous = await f.run();
    assert.equal(ambiguous.registered, 0);
    assert.equal(ambiguous.unchanged, 0);
    assert.equal(ambiguous.skipped, 2);
    assert.ok(f.items.slice(-2).every(item => /ambiguous|multiple/i.test(item.reason ?? '')));
  } finally { await f.close(); }
});

test('does not assign one renamed directory to two database chapter identities', async () => {
  const f = await fixture();
  try {
    const metadata = new DatabaseSync(f.metadataDbPath);
    metadata.exec("INSERT INTO chapter VALUES(2,1,'/another','Another','1',2,'1','html','html',1,0);"); metadata.close();
    await rename(f.directory, join(f.rootPath, 'contents/example/Book-book/1-Renamed'));
    const result = await f.run();
    assert.equal(result.registered, 0);
    assert.equal(result.skipped, 1);
    assert.match(f.items.at(-1)!.reason!, /multiple.*identit|ambiguous/i);
  } finally { await f.close(); }
});

test('keeps distinct exact metadata paths when chapter-number prefixes happen to coincide', async () => {
  const f = await fixture();
  try {
    const metadata = new DatabaseSync(f.metadataDbPath);
    metadata.exec("INSERT INTO chapter VALUES(2,1,'/another','Another','1',2,'1','html','html',1,0);"); metadata.close();
    await cp(f.directory, join(f.rootPath, 'contents/example/Book-book/1-Another'), { recursive: true });
    const result = await f.run();
    assert.equal(result.registered, 2, JSON.stringify(f.items));
  } finally { await f.close(); }
});

test('retries one changed snapshot and still rejects a source that changes on both attempts', async () => {
  for (const keepChanging of [false, true]) {
    const f = await fixture();
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      const body = join(f.directory, 'content.html');
      await writeFile(body, `<p>${'chapter '.repeat(1024 * 1024)}</p>`);
      let changes = 0;
      watcher = watch(f.dataDir, { recursive: true }, (event, name) => {
        if (event !== 'rename' || !name || !name.toString().replaceAll('\\', '/').endsWith('/source/content.html') || !existsSync(join(f.dataDir, name.toString())) || (!keepChanging && changes > 0)) return;
        const info = statSync(body); utimesSync(body, info.atime, new Date(info.mtimeMs + 1000)); changes++;
      });
      const result = await f.run();
      assert.ok(changes >= (keepChanging ? 2 : 1), `Observed source changes: ${changes}`);
      assert.equal(result.registered, keepChanging ? 0 : 1, JSON.stringify(f.items));
      if (keepChanging) assert.match(f.items.at(-1)!.reason!, /changed during snapshot/i);
      assert.deepEqual(await readdir(join(f.dataDir, 'staging')), []);
    } finally { watcher?.close(); await f.close(); }
  }
});

test('media manifest key order does not create another revision for the same content', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).registered, 1);
    const original = f.items.find(item => item.status === 'registered')!;
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ media: { files: [{ updatedAt: 99, status: 'stored', bytes: 5, path: 'media/a.png', fileName: 'a.png' }] }, updatedAt: 99, complete: true, version: 1 }));
    const result = await f.run();
    assert.equal(result.unchanged, 1, JSON.stringify(f.items));
    assert.equal(f.items.at(-1)!.revision, original.revision);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM revisions').get() as { n: number }).n, 1);
    const chunks: Buffer[] = []; for await (const chunk of packageStream(f.db, f.dataDir, original.chapterId!).open()) chunks.push(chunk);
    const files = await extractPackage(Buffer.concat(chunks));
    assert.equal(files['media-manifest.json'], '{"complete":true,"media":{"files":[{"bytes":5,"fileName":"a.png","path":"media/a.png","status":"stored","updatedAt":0}]},"updatedAt":0,"version":1}');
  } finally { await f.close(); }
});
