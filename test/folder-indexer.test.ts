import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, statSync, utimesSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { ZipFile } from 'yazl';
import yauzl from 'yauzl';
import { openDatabase } from '../src/db.ts';
import { defaultLimits, deleteChapter, digest, packageStream } from '../src/packages.ts';
import { scanFolder, type FolderIndexItem } from '../src/folder-indexer.ts';
import { getWork } from '../src/works.ts';

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
  await writeFile(join(directory, '..', 'novel.json'), JSON.stringify(workMetadata()));
  await writeFile(join(directory, 'content.html'), '<p>norea-media://reader-asset/prose</p><img src="norea-media://reader-asset/a.png">');
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, updatedAt: 12, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 5, status: 'stored', updatedAt: 12 }] } }));
  await writeFile(join(directory, 'media.zip'), await zip({ 'a.png': 'image' }));
  const db = openDatabase(dataDir);
  const items: FolderIndexItem[] = [];
  const run = (overrides = {}) => scanFolder({ rootPath, dataDir, db, limits: defaultLimits, onItem: item => { items.push(item); }, ...overrides });
  const close = async () => { db.close(); await rm(temp, { recursive: true, force: true }); };
  return { temp, rootPath, dataDir, directory, db, items, run, close };
}

function workMetadata() {
  return { schemaVersion: 1, identity: { pluginId: 'example', novelPath: '/real/book?lang=ko' },
    novel: { name: 'Portable Book', cover: 'https://example/cover.png', author: 'Writer', artist: null, summary: 'Summary', status: null, rating: null, genres: null, isLocal: false },
    cover: { fileName: 'cover.png', contentType: 'image/png', sourceUrl: 'https://example/cover.png' } };
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
    assert.equal((await f.run()).registered, 2);
    const id = f.items.find(item => item.status === 'registered' && item.chapterId)!.chapterId!;
    const chunks: Buffer[] = []; for await (const chunk of packageStream(f.db, f.dataDir, id).open()) chunks.push(chunk);
    const files = await extractPackage(Buffer.concat(chunks));
    assert.equal(files['media/a.png'], 'image');
    assert.match(files['content.html'], /src="media\/a.png"/);
    assert.match(files['content.html'], /<p>norea-media:\/\/reader-asset\/prose<\/p>/);
    assert.equal(JSON.parse(files['media-manifest.json']).updatedAt, 0);
    assert.equal((await f.run()).unchanged, 2);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM catalog_changes').get() as { n: number }).n, 1);
    assert.deepEqual(await snapshot(f.rootPath), before);
  } finally { await f.close(); }
});

test('rejects extra media entries, preserves tombstones, and stops on cancellation', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'media.zip'), await zip({ 'a.png': 'image', 'unexpected.png': 'extra' }));
    assert.equal((await f.run()).registered, 1);
    await writeFile(join(f.directory, 'media.zip'), await zip({ 'a.png': 'image' }));
    await f.run();
    const id = f.items.find(item => item.status === 'registered' && item.chapterId)!.chapterId!;
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
    assert.equal((await f.run()).registered, 1);
  } finally { await f.close(); }
});

test('converts only asset attributes and preserves quoted greater-than characters and prose', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'content.html'), '<img title="1 > 0" src="norea-media://reader-asset/a.png"><div style="background:url(\'norea-media://reader-asset/a.png\')">body</div><!-- <img src="norea-media://reader-asset/comment"> -->');
    assert.equal((await f.run()).registered, 2, JSON.stringify(f.items));
    const id = f.items.find(item => item.status === 'registered' && item.chapterId)!.chapterId!;
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
      assert.equal(result.registered, keepChanging ? 1 : 2, JSON.stringify(f.items));
      if (keepChanging) assert.match(f.items.at(-1)!.reason!, /changed during snapshot/i);
      assert.deepEqual(await readdir(join(f.dataDir, 'staging')), []);
    } finally { watcher?.close(); await f.close(); }
  }
});

test('media manifest key order does not create another revision for the same content', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).registered, 2);
    const original = f.items.find(item => item.status === 'registered' && item.chapterId)!;
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ media: { files: [{ updatedAt: 99, status: 'stored', bytes: 5, path: 'media/a.png', fileName: 'a.png' }] }, updatedAt: 99, complete: true, version: 1 }));
    const result = await f.run();
    assert.equal(result.unchanged, 2, JSON.stringify(f.items));
    assert.equal(f.items.at(-1)!.revision, original.revision);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM revisions').get() as { n: number }).n, 1);
    const chunks: Buffer[] = []; for await (const chunk of packageStream(f.db, f.dataDir, original.chapterId!).open()) chunks.push(chunk);
    const files = await extractPackage(Buffer.concat(chunks));
    assert.equal(files['media-manifest.json'], '{"complete":true,"media":{"files":[{"bytes":5,"fileName":"a.png","path":"media/a.png","status":"stored","updatedAt":0}]},"updatedAt":0,"version":1}');
  } finally { await f.close(); }
});


test('requires metadata-only novel.json and discovers chapters without guessed work identities', async () => {
  const f = await fixture();
  try {
    await rm(join(f.directory, '..', 'novel.json'));
    const noMetadata = await f.run();
    assert.equal(noMetadata.registered, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM works').get() as { n: number }).n, 0);
    const value = workMetadata();
    const portable = value;
    await writeFile(join(f.directory, '..', 'novel.json'), JSON.stringify(portable));
    const before = await snapshot(f.rootPath);
    const result = await f.run();
    assert.equal(result.registered, 2, JSON.stringify(f.items));
    const work = getWork(f.db, f.dataDir, digest(JSON.stringify(['example', portable.identity.novelPath])));
    assert.deepEqual(work.metadata, portable);
    const chapter = JSON.parse((f.db.prepare('SELECT entry FROM chapters').get() as { entry: string }).entry);
    assert.equal(chapter.manifest.identity.chapterPath, 'norea-folder:1');
    assert.equal(chapter.manifest.identity.novelPath, portable.identity.novelPath);
    assert.deepEqual(await snapshot(f.rootPath), before);
  } finally { await f.close(); }
});


test('metadata-only works and covers import without source requests or chapter files', async t => {
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected source request'); });
  const f = await fixture();
  try {
    await rm(f.directory, { recursive: true });
    await writeFile(join(f.directory, '..', 'cover.png'), 'cover bytes');
    const before = await snapshot(f.rootPath);
    assert.equal((await f.run()).registered, 1);
    const work = getWork(f.db, f.dataDir, digest(JSON.stringify(['example', workMetadata().identity.novelPath])));
    assert.equal(work.hasCover, true); assert.deepEqual(work.metadata, workMetadata());
    assert.equal((await f.run()).unchanged, 1);
    assert.equal(network.mock.callCount(), 0); assert.deepEqual(await snapshot(f.rootPath), before);
  } finally { await f.close(); }
});

test('missing or invalid work metadata never falls back to covers, databases, or folder names', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, '..', 'cover.json'), JSON.stringify({ version: 1, sourceId: 'example', novelPath: '/book', fileName: 'cover.png' }));
    await writeFile(join(f.rootPath, 'norea.sqlite'), 'Old database is not read');
    for (const value of [null, '{broken', { ...workMetadata(), identity: { pluginId: 'example', novelPath: 'norea-folder:Book' } }, { ...workMetadata(), chapters: [] }]) {
      const file = join(f.directory, '..', 'novel.json');
      if (value === null) await rm(file); else await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
      const result = await f.run(); assert.equal(result.registered, 0);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM works').get() as { n: number }).n, 0);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    }
  } finally { await f.close(); }
});

test('duplicate numbers and unfinished bodies remain unavailable within an exact work', async () => {
  const f = await fixture();
  try {
    await cp(f.directory, join(f.directory, '..', '1-Duplicate'), { recursive: true });
    const incomplete = join(f.directory, '..', '2-Incomplete'); await mkdir(incomplete);
    await writeFile(join(incomplete, 'content.html'), 'partial'); await writeFile(join(incomplete, 'content.html.part'), 'partial');
    const result = await f.run(); assert.equal(result.registered, 1); assert.equal(result.skipped, 3);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('remote media and ambiguous body formats are skipped without losing work metadata', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, media: { files: [{ status: 'remote' }] } }));
    assert.equal((await f.run()).skipped, 1); assert.match(f.items.at(-1)!.reason!, /not downloaded/);
    await writeFile(join(f.directory, 'content.pdf'), '%PDF-1.4');
    assert.equal((await f.run()).skipped, 1); assert.match(f.items.at(-1)!.reason!, /exactly one/);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM works').get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test('text-only and PDF folders need no media manifest and preserve title hyphens', async () => {
  const f = await fixture();
  try {
    await rm(f.directory, { recursive: true });
    for (const [name, body] of [['2-Title-with-hyphens', 'content.html'], ['10-Tenth', 'content.pdf']]) {
      const directory = join(f.directory, '..', name); await mkdir(directory); await writeFile(join(directory, body), body === 'content.pdf' ? '%PDF-1.4\n%%EOF' : '<p>Text</p>');
    }
    const result = await f.run(); assert.equal(result.registered, 3, JSON.stringify(f.items));
    const chapters = (f.db.prepare("SELECT entry FROM chapters ORDER BY json_extract(entry,'$.manifest.chapter.position')").all() as { entry: string }[]).map(row => JSON.parse(row.entry).manifest);
    assert.deepEqual(chapters.map(value => [value.chapter.name, value.chapter.chapterNumber, value.chapter.contentType]), [['Title-with-hyphens', '2', 'html'], ['Tenth', '10', 'pdf']]);
  } finally { await f.close(); }
});

test('package manifests retain exact chapter paths only when their work matches novel.json', async () => {
  for (const novelPath of [workMetadata().identity.novelPath, '/wrong']) {
    const f = await fixture();
    try {
      await rm(f.directory, { recursive: true }); await mkdir(f.directory);
      const body = '<p>Saved package</p>';
      const manifest = { packageVersion: 1, identity: { pluginId: 'example', novelPath, chapterPath: '/original/chapter?number=1' }, novel: { name: 'Portable Book', isLocal: false }, chapter: { name: 'Original title', chapterNumber: '1', position: 1, page: '3', contentType: 'html' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: Buffer.byteLength(body), sha256: digest(body) }] };
      await writeFile(join(f.directory, 'package.zip'), await zip({ 'manifest.json': JSON.stringify(manifest), 'content.html': body }));
      const result = await f.run();
      assert.equal(result.registered, novelPath === workMetadata().identity.novelPath ? 2 : 1);
      const row = f.db.prepare('SELECT entry FROM chapters').get() as { entry: string } | undefined;
      if (row) assert.deepEqual(JSON.parse(row.entry).manifest.identity, manifest.identity);
      else assert.match(f.items.at(-1)!.reason!, /work identity differs/);
    } finally { await f.close(); }
  }
});
