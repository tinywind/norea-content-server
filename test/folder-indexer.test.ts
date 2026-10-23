import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, statSync, utimesSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ZipFile } from 'yazl';
import yauzl from 'yauzl';
import { openDatabase } from '../src/db.ts';
import { chapterFileStream } from '../src/chapter-files.ts';
import { completeChapter, defaultLimits, deleteChapter, digest, workId, type CatalogEntry } from '../src/packages.ts';
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
  const dataDir = join(temp, 'server');
  const directory = join(dataDir, 'contents/example/book/1');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '..', 'novel.json'), JSON.stringify(workMetadata()));
  await writeFile(join(directory, 'content.html'), '\ufeff<p>norea-media://reader-asset/prose</p>\r\n<img src="norea-media://reader-asset/a.png">');
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, updatedAt: 12, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 5, status: 'stored', updatedAt: 12 }] } }));
  await writeFile(join(directory, 'media.zip'), await zip({ 'a.png': 'image' }));
  const db = openDatabase(dataDir);
  const items: FolderIndexItem[] = [];
  const run = (overrides = {}) => scanFolder({ dataDir, db, limits: defaultLimits, full: true, onItem: item => { items.push(item); }, ...overrides });
  const close = async () => { db.close(); await rm(temp, { recursive: true, force: true }); };
  return { temp, dataDir, directory, db, items, run, close };
}

function workMetadata() {
  return { schemaVersion: 1, identity: { pluginId: 'example', novelId: 'book', novelPath: '/real/book?lang=ko' },
    novel: { name: 'Portable Book', author: 'Writer', artist: null, summary: 'Summary', status: null, rating: null, genres: null, isLocal: false },
    cover: { fileName: 'cover.png', contentType: 'image/png' }, chapters: {} };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(path));
    else { const info = await stat(path); result[path] = `${info.size}/${info.mtimeMs}/${(await readFile(path)).toString('base64')}`; }
  }
  return result;
}

function stored(f: Awaited<ReturnType<typeof fixture>>): CatalogEntry {
  return JSON.parse((f.db.prepare('SELECT entry FROM chapters').get() as { entry: string }).entry);
}

test('folder collision checks use an index as the recovered catalog grows', async () => {
  const f = await fixture();
  try {
    await f.run();
    const plan = f.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM chapters WHERE lower(directory)=lower(?) AND id<>?')
      .all('contents/EXAMPLE/BOOK/1', 'another-identity') as { detail: string }[];
    assert.ok(plan.some(row => row.detail.startsWith('SEARCH chapters USING INDEX')), JSON.stringify(plan));
    assert.equal(f.db.prepare('SELECT id FROM chapters WHERE lower(directory)=lower(?) AND id<>?')
      .get('contents/EXAMPLE/BOOK/1', 'another-identity')?.id, stored(f).id);
  } finally { await f.close(); }
});

async function download(f: Awaited<ReturnType<typeof fixture>>, entry: CatalogEntry, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of chapterFileStream(f.db, f.dataDir, entry.id, entry.revision, path).open()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('indexes original chapter files in place without rewriting, copying or archiving their bytes', async t => {
  const f = await fixture();
  try {
    const chapters = { '1': 'Opening: exact title?', '2': 'Not backed up' };
    await writeFile(join(f.directory, '..', 'novel.json'), JSON.stringify({ ...workMetadata(), chapters }));
    const before = await snapshot(join(f.dataDir, 'contents'));
    const reads = t.mock.method(fs, 'createReadStream', () => { throw new Error('Scanner must not read chapter payload streams'); });
    const writes = t.mock.method(fs, 'createWriteStream', () => { throw new Error('Scanner must not copy chapter files'); });
    const archives = t.mock.method(ZipFile.prototype, 'addFile', () => { throw new Error('Scanner must not archive chapter files'); });
    syncBuiltinESMExports();
    try {
      assert.equal((await f.run()).registered, 2, JSON.stringify(f.items));
      assert.equal(reads.mock.callCount(), 0); assert.equal(writes.mock.callCount(), 0); assert.equal(archives.mock.callCount(), 0);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    const entry = stored(f);
    const row = f.db.prepare('SELECT path,directory FROM chapters').get() as { path: string; directory: string };
    assert.equal(row.path, relative(f.dataDir, f.directory)); assert.equal(row.directory, row.path);
    assert.equal(entry.manifest.layout, 'chapter-files');
    assert.equal(entry.manifest.identity.chapterPath, 'norea-folder:1');
    assert.equal(entry.manifest.identity.novelPath, workMetadata().identity.novelPath);
    assert.equal(entry.manifest.chapter.name, chapters['1']);
    assert.deepEqual(getWork(f.db, f.dataDir, workId(entry.manifest.identity)).metadata.chapters, chapters);
    for (const file of entry.manifest.files) {
      assert.deepEqual(await download(f, entry, file.path), await readFile(join(f.directory, file.path)));
      assert.deepEqual(Object.keys(file).sort(), ['modifiedAt', 'path', 'size']);
    }
    assert.equal((await f.run()).unchanged, 2);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM catalog_changes').get() as { n: number }).n, 1);
    assert.equal(existsSync(join(f.dataDir, 'staging')), false);
    assert.deepEqual(await snapshot(join(f.dataDir, 'contents')), before);
  } finally { await f.close(); }
});

test('full folder scans reassess completeness even when the saved inventory signature matches', async () => {
  const f = await fixture();
  try {
    await f.run();
    const first = stored(f);
    f.db.prepare('UPDATE chapters SET entry=? WHERE id=?').run(JSON.stringify({ ...first, complete: false }), first.id);
    await f.run();
    assert.equal(stored(f).complete, true);
    assert.ok(stored(f).sequence > first.sequence);
    assert.equal(completeChapter(f.db, f.dataDir, first.id)?.id, first.id);
  } finally { await f.close(); }
});

test('folder rescans persist completeness transitions and retain incomplete files', async () => {
  const f = await fixture();
  try {
    await f.run();
    const first = stored(f);
    assert.equal(first.complete, true);
    await writeFile(join(f.directory, 'media.zip'), await zip({ 'other.png': 'image' }));
    assert.equal((await f.run()).registered, 1);
    const incomplete = stored(f);
    assert.equal(incomplete.id, first.id);
    assert.equal(incomplete.complete, false);
    assert.equal(completeChapter(f.db, f.dataDir, first.id), undefined);
    assert.equal((f.db.prepare('SELECT path FROM chapters WHERE id=?').get(first.id) as { path: string }).path, relative(f.dataDir, f.directory));
    assert.equal((await f.run()).unchanged, 2);
    assert.equal(stored(f).sequence, incomplete.sequence);
    await rm(join(f.directory, 'media.zip'));
    assert.equal((await f.run()).registered, 1);
    assert.equal(stored(f).complete, false);
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ version: 1, complete: false, media: { files: [{ fileName: 'a.png', path: '', status: 'remote' }] } }));
    await writeFile(join(f.directory, 'media.zip'), await zip({ 'a.png': 'image', 'extra.png': 'extra' }));
    assert.equal((await f.run({ full: false })).registered, 1);
    assert.equal(stored(f).complete, true);
    assert.equal(completeChapter(f.db, f.dataDir, first.id)?.id, first.id);
  } finally { await f.close(); }
});

test('rejects malformed media archives and retries repair without a success checkpoint', async () => {
  const f = await fixture();
  try {
    for (const bytes of [Buffer.from('incomplete zip')]) {
      await writeFile(join(f.directory, 'media.zip'), bytes);
      assert.equal((await f.run()).skipped, 1);
      assert.equal(f.db.prepare('SELECT 1 FROM scan_checkpoints WHERE path=?').get(f.directory), undefined);
    }
    await writeFile(join(f.directory, 'media.zip'), await zip({ 'a.png': 'image' }));
    assert.equal((await f.run()).registered, 1);
    assert.ok(f.db.prepare('SELECT 1 FROM scan_checkpoints WHERE path=?').get(f.directory));
    await rm(join(f.directory, 'content.html'));
    assert.equal((await f.run()).skipped, 1);
    assert.equal(existsSync(join(f.directory, 'content.html')), false);
    await writeFile(join(f.directory, 'content.html'), '<p>Repaired body</p>');
    assert.equal((await f.run()).registered, 1);
    assert.equal((await download(f, stored(f), 'content.html')).toString(), '<p>Repaired body</p>');
  } finally { await f.close(); }
});

test('deleted chapters cannot be reimported by putting their directory back', async () => {
  const f = await fixture();
  try {
    await f.run();
    const original = await readFile(join(f.directory, 'content.html'));
    const entry = stored(f); deleteChapter(f.db, f.dataDir, entry.id);
    await mkdir(f.directory); await writeFile(join(f.directory, 'content.html'), original);
    assert.equal((await f.run()).registered, 0);
    assert.match(f.items.at(-1)!.reason!, /deleted/i);
    assert.equal(stored(f).deleted, true);
  } finally { await f.close(); }
});

test('invalid current files become unavailable and recover without deletion tombstones', async () => {
  const f = await fixture();
  try {
    await f.run(); const first = stored(f);
    const manifestPath = join(f.directory, 'manifest.json'); const original = await readFile(manifestPath);
    for (const invalid of ['unfinished', 'manifest']) {
      if (invalid === 'unfinished') await writeFile(join(f.directory, 'content.html.part'), 'partial');
      else await writeFile(manifestPath, Buffer.alloc(original.length, 33));
      assert.equal((await f.run()).skipped, 1);
      assert.equal(completeChapter(f.db, f.dataDir, first.id), undefined);
      assert.equal((f.db.prepare('SELECT path FROM chapters WHERE id=?').get(first.id) as { path: string | null }).path, null);
      assert.throws(() => chapterFileStream(f.db, f.dataDir, first.id, stored(f).revision, 'content.html'), /unavailable/);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapter_tombstones').get() as { n: number }).n, 0);
      assert.equal(stored(f).deleted, false);
      if (invalid === 'unfinished') await rm(join(f.directory, 'content.html.part'));
      else await writeFile(manifestPath, original);
      assert.equal((await f.run()).registered, 1);
      assert.equal(completeChapter(f.db, f.dataDir, first.id)?.id, first.id);
      assert.deepEqual(await download(f, stored(f), 'manifest.json'), original);
    }
  } finally { await f.close(); }
});

test('rejects symlink storage roots and media traversal names', async () => {
  const f = await fixture();
  try {
    const alias = join(f.temp, 'alias'); await symlink(f.dataDir, alias, 'junction');
    await assert.rejects(f.run({ dataDir: alias }), /symbolic|symlink/i);
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, media: { files: [{ fileName: '../a.png', path: 'media/../a.png', bytes: 5, status: 'stored' }] } }));
    assert.equal((await f.run()).skipped, 1);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('cancels between items without creating staging files or changing source files', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(join(f.dataDir, 'contents'));
    const controller = new AbortController();
    const result = await f.run({ signal: controller.signal, onItem: () => { controller.abort(); } });
    assert.equal(result.cancelled, true); assert.equal(result.registered, 1); assert.equal(result.scanned, 1);
    assert.equal(existsSync(join(f.dataDir, 'staging')), false);
    assert.deepEqual(await snapshot(join(f.dataDir, 'contents')), before);
    assert.equal((await f.run({ signal: controller.signal })).scanned, 0);
  } finally { await f.close(); }
});

test('a one-time source stat change during media validation is indexed on the first scan', async t => {
  const f = await fixture();
  try {
    const originalOpen = yauzl.open; const body = join(f.directory, 'content.html'); let changed = false;
    t.mock.method(yauzl, 'open', (...args: Parameters<typeof yauzl.open>) => {
      if (!changed) {
        changed = true; const info = statSync(body); utimesSync(body, info.atime, new Date(info.mtimeMs + 1000));
      }
      return originalOpen(...args);
    });
    const result = await f.run(); assert.equal(result.registered, 2, JSON.stringify(f.items)); assert.equal(result.skipped, 0);
    assert.equal(stored(f).manifest.files.find(file => file.path === 'content.html')!.modifiedAt, Math.floor(statSync(body).mtimeMs));
    assert.ok(f.db.prepare('SELECT 1 FROM scan_checkpoints WHERE path=?').get(f.directory));
    assert.equal((await f.run()).unchanged, 2);
  } finally { await f.close(); }
});

test('source changes during both media validations are skipped and retried on the next scan', async t => {
  const f = await fixture();
  try {
    const originalOpen = yauzl.open;
    const body = join(f.directory, 'content.html');
    const archives = t.mock.method(yauzl, 'open', (...args: Parameters<typeof yauzl.open>) => {
      const info = statSync(body); utimesSync(body, info.atime, new Date(info.mtimeMs + 1000));
      return originalOpen(...args);
    });
    assert.equal((await f.run()).skipped, 1);
    assert.equal(archives.mock.callCount(), 2);
    assert.match(f.items.at(-1)!.reason!, /changed during indexing/);
    assert.equal(f.db.prepare('SELECT 1 FROM scan_checkpoints WHERE path=?').get(f.directory), undefined);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    t.mock.restoreAll();
    assert.equal((await f.run()).registered, 1);
  } finally { await f.close(); }
});

test('work metadata is indexed on the first scan after a one-time stat change during reading', async t => {
  const f = await fixture();
  try {
    const path = join(f.directory, '..', 'novel.json'); const originalRead = fs.readFileSync; let changed = false;
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      const bytes = originalRead(...args);
      if (args[0] === path && !changed) {
        changed = true; const info = statSync(path); utimesSync(path, info.atime, new Date(info.mtimeMs + 1000));
      }
      return bytes;
    });
    syncBuiltinESMExports();
    const result = await f.run(); assert.equal(result.registered, 2, JSON.stringify(f.items)); assert.equal(result.skipped, 0);
    assert.ok(f.db.prepare('SELECT 1 FROM scan_checkpoints WHERE path=?').get(path));
    assert.equal((await f.run()).unchanged, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('work metadata retry publishes only the contents read after the change', async t => {
  const f = await fixture();
  try {
    const path = join(f.directory, '..', 'novel.json'); const originalRead = fs.readFileSync; let changed = false;
    const metadata = workMetadata(); metadata.novel.name = 'Changed while reading';
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      const bytes = originalRead(...args);
      if (args[0] === path && !changed) {
        changed = true; const info = statSync(path); fs.writeFileSync(path, JSON.stringify(metadata)); utimesSync(path, info.atime, new Date(info.mtimeMs + 1000));
      }
      return bytes;
    });
    syncBuiltinESMExports();
    assert.equal((await f.run()).registered, 2, JSON.stringify(f.items));
    const work = getWork(f.db, f.dataDir, digest(JSON.stringify(['example', metadata.identity.novelPath])));
    assert.equal(work.metadata.novel.name, 'Changed while reading'); assert.equal(stored(f).manifest.novel.name, 'Changed while reading');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_changes').get() as { n: number }).n, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('work metadata that changes on both reads is skipped without publishing or checkpointing', async t => {
  const f = await fixture();
  try {
    const path = join(f.directory, '..', 'novel.json'); const originalRead = fs.readFileSync; let reads = 0;
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      const bytes = originalRead(...args);
      if (args[0] === path) {
        reads++; const info = statSync(path); utimesSync(path, info.atime, new Date(info.mtimeMs + 1000));
      }
      return bytes;
    });
    syncBuiltinESMExports();
    const result = await f.run(); assert.equal(result.registered, 0); assert.equal(result.skipped, 1); assert.equal(reads, 2);
    assert.match(f.items.at(-1)!.reason!, /Work metadata changed during indexing/);
    for (const table of ['works', 'work_changes', 'chapters', 'scan_checkpoints']) assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal((await f.run()).registered, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('metadata-only works and covers import without source requests or chapter files', async t => {
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected source request'); });
  const f = await fixture();
  try {
    await rm(f.directory, { recursive: true }); await writeFile(join(f.directory, '..', 'cover.png'), 'cover bytes');
    const before = await snapshot(join(f.dataDir, 'contents'));
    assert.equal((await f.run()).registered, 1);
    const work = getWork(f.db, f.dataDir, digest(JSON.stringify(['example', workMetadata().identity.novelPath])));
    assert.equal(work.hasCover, true); assert.deepEqual(work.metadata, workMetadata());
    assert.equal((await f.run()).unchanged, 1); assert.equal(network.mock.callCount(), 0);
    assert.deepEqual(await snapshot(join(f.dataDir, 'contents')), before);
  } finally { await f.close(); }
});

test('missing or invalid work metadata never infers identities from folders or old files', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, '..', 'cover.json'), JSON.stringify({ version: 1, sourceId: 'example', novelPath: '/book', fileName: 'cover.png' }));
    await writeFile(join(f.dataDir, 'norea.sqlite'), 'Old database is not read');
    for (const value of [null, '{broken', { ...workMetadata(), identity: { pluginId: 'example', novelPath: 'norea-folder:Book' } }, { identity: { pluginId: "example" }, novel: { name: "No identity" } }]) {
      const file = join(f.directory, '..', 'novel.json');
      if (value === null) await rm(file); else await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
      assert.equal((await f.run()).registered, 0);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM works').get() as { n: number }).n, 0);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    }
  } finally { await f.close(); }
});

test('noncanonical chapter numbers and unfinished bodies are skipped within an exact work', async () => {
  const f = await fixture();
  try {
    await cp(f.directory, join(f.directory, '..', '1.0'), { recursive: true });
    const incomplete = join(f.directory, '..', '2'); await mkdir(incomplete);
    await writeFile(join(incomplete, 'content.html'), 'partial'); await writeFile(join(incomplete, 'content.html.part'), 'partial');
    const result = await f.run(); assert.equal(result.registered, 2); assert.equal(result.skipped, 2);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test('recovers distinct local chapter sequences without rewriting their files', async () => {
  const f = await fixture();
  try {
    const directory = join(f.dataDir, 'contents/local/local');
    const metadata = workMetadata();
    metadata.identity = { pluginId: 'local', novelId: 'local', novelPath: 'local' };
    metadata.novel.isLocal = true;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'novel.json'), JSON.stringify(metadata));
    for (const name of ['1', '2']) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, 'content.html'), `<p>${name}</p>`);
    }
    const before = await snapshot(directory);
    await f.run();
    const entries = (f.db.prepare("SELECT entry FROM chapters WHERE json_extract(entry,'$.manifest.identity.pluginId')='local' ORDER BY directory").all() as { entry: string }[])
      .map(row => JSON.parse(row.entry) as CatalogEntry);
    assert.deepEqual(entries.map(entry => entry.manifest.identity.chapterPath), ['local-folder:1', 'local-folder:2']);
    assert.equal((await f.run()).registered, 0);
    assert.deepEqual(await snapshot(directory), before);
  } finally { await f.close(); }
});

test('malformed media and ambiguous body formats are skipped without losing work metadata', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, media: { files: [{ status: 'remote' }] } }));
    assert.equal((await f.run()).skipped, 1); assert.match(f.items.at(-1)!.reason!, /Invalid media manifest/);
    await writeFile(join(f.directory, 'content.pdf'), '%PDF-1.4');
    assert.equal((await f.run()).skipped, 1); assert.match(f.items.at(-1)!.reason!, /exactly one/);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM works').get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test('a noncanonical number cannot displace an indexed canonical chapter folder', async () => {
  const f = await fixture();
  try {
    await f.run();
    const first = stored(f);
    const duplicate = join(f.directory, '..', '1.0');
    await cp(f.directory, duplicate, { recursive: true });
    assert.equal((await f.run()).skipped, 1);
    assert.equal(completeChapter(f.db, f.dataDir, first.id)?.id, first.id);
    await rm(duplicate, { recursive: true });
    assert.equal((await f.run()).registered, 0);
    assert.equal(completeChapter(f.db, f.dataDir, first.id)?.id, first.id);
  } finally { await f.close(); }
});

test('text-only and PDF folders need no media manifest and preserve title hyphens', async () => {
  const f = await fixture();
  try {
    await rm(f.directory, { recursive: true });
    await writeFile(join(f.directory, '..', 'novel.json'), JSON.stringify({ ...workMetadata(), chapters: { '2': 'Title-with-hyphens', '10': 'Tenth' } }));
    for (const [name, body] of [['2', 'content.html'], ['10', 'content.pdf']]) {
      const directory = join(f.directory, '..', name); await mkdir(directory); await writeFile(join(directory, body), body === 'content.pdf' ? '%PDF-1.4\n%%EOF' : '<p>Text</p>');
    }
    assert.equal((await f.run()).registered, 3, JSON.stringify(f.items));
    const chapters = (f.db.prepare("SELECT entry FROM chapters ORDER BY json_extract(entry,'$.manifest.chapter.position')").all() as { entry: string }[]).map(row => JSON.parse(row.entry).manifest);
    assert.deepEqual(chapters.map(value => [value.chapter.name, value.chapter.chapterNumber, value.chapter.contentType]), [['Title-with-hyphens', '2', 'html'], ['Tenth', '10', 'pdf']]);
  } finally { await f.close(); }
});

test('outer chapter ZIPs and extracted media directories are unsupported', async () => {
  for (const input of ['package.zip', 'media-directory', 'chapter.html']) {
    const f = await fixture();
    try {
      if (input === 'media-directory') { await rm(join(f.directory, 'media.zip')); await mkdir(join(f.directory, 'media')); await writeFile(join(f.directory, 'media', 'a.png'), 'image'); }
      else { await rm(f.directory, { recursive: true }); await mkdir(f.directory); await writeFile(join(f.directory, input), input.endsWith('.zip') ? await zip({ 'content.html': '<p>Archived</p>' }) : '<p>Old body</p>'); }
      const result = await f.run(); assert.equal(result.registered, 1); assert.equal(result.skipped, 1);
      assert.match(f.items.at(-1)!.reason!, /Unsupported chapter file|Outer chapter ZIP files are unsupported|exactly one supported body file/);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    } finally { await f.close(); }
  }
});

test('persistent checkpoints avoid reading unchanged payloads and archives after restart', async t => {
  const f = await fixture();
  try {
    await f.run(); f.db.close(); const db = openDatabase(f.dataDir);
    try {
      const reads = t.mock.method(fs, 'createReadStream', () => { throw new Error('Unchanged payloads must not be read'); });
      const archives = t.mock.method(yauzl, 'open', () => { throw new Error('Unchanged archives must not be opened'); });
      syncBuiltinESMExports();
      try {
        const result = await scanFolder({ dataDir: f.dataDir, db, limits: defaultLimits });
        assert.equal(result.unchanged, 2); assert.equal(result.skipped, 0); assert.equal(result.failed, 0);
        assert.equal(reads.mock.callCount(), 0); assert.equal(archives.mock.callCount(), 0);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    } finally { db.close(); }
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('incremental scans discover new entries and refresh only the changed current chapter', async t => {
  const f = await fixture();
  try {
    await f.run(); const first = stored(f);
    const second = join(f.directory, '..', '0'); await mkdir(second); await writeFile(join(second, 'content.html'), '<p>New</p>');
    const newWork = join(f.dataDir, 'contents/example/Another'); await mkdir(newWork);
    await writeFile(join(newWork, 'novel.json'), JSON.stringify({ ...workMetadata(), identity: { pluginId: 'example', novelId: 'Another', novelPath: '/another' } }));
    const originalOpen = yauzl.open;
    const archives = t.mock.method(yauzl, 'open', (...args: Parameters<typeof yauzl.open>) => originalOpen(...args));
    const result = await f.run({ full: false }); assert.equal(result.registered, 2); assert.equal(result.unchanged, 2); assert.equal(archives.mock.callCount(), 0);
    await writeFile(join(f.directory, 'content.html'), '<p>Changed body</p>');
    const changed = await f.run(); assert.equal(changed.registered, 1); assert.equal(changed.unchanged, 3); assert.equal(archives.mock.callCount(), 1);
    const current = JSON.parse((f.db.prepare('SELECT entry FROM chapters WHERE id=?').get(first.id) as { entry: string }).entry) as CatalogEntry;
    assert.notEqual(current.revision, first.revision);
    assert.equal((await download(f, current, 'content.html')).toString(), '<p>Changed body</p>');
    assert.throws(() => chapterFileStream(f.db, f.dataDir, first.id, first.revision, 'content.html'), /copy not found/);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters WHERE id=?').get(first.id) as { n: number }).n, 1);
  } finally { await f.close(); }
});

test('work metadata and cover changes leave unchanged chapter payloads unopened', async t => {
  const f = await fixture();
  try {
    await f.run(); const metadata = workMetadata(); metadata.novel.name = 'Updated title';
    await writeFile(join(f.directory, '..', 'novel.json'), JSON.stringify(metadata)); await writeFile(join(f.directory, '..', 'cover.png'), 'updated cover');
    const archives = t.mock.method(yauzl, 'open', () => { throw new Error('Unchanged archive must not be opened'); });
    const result = await f.run({ full: false }); assert.equal(result.registered, 1); assert.equal(result.unchanged, 1); assert.equal(archives.mock.callCount(), 0);
    const work = getWork(f.db, f.dataDir, digest(JSON.stringify(['example', metadata.identity.novelPath])));
    assert.equal(work.metadata.novel.name, 'Updated title'); assert.equal(work.hasCover, true);
  } finally { await f.close(); }
});

test('same-size source changes refresh the current token even when the modification millisecond is preserved', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'content.html'); utimesSync(path, 1700000000, 1700000000);
    await f.run(); const first = stored(f); const info = await stat(path);
    await writeFile(path, Buffer.alloc(info.size, 65)); utimesSync(path, 1700000000, 1700000000);
    assert.equal((await f.run()).registered, 1);
    const current = stored(f);
    assert.deepEqual(current.manifest.files, first.manifest.files);
    assert.notEqual(current.revision, first.revision);
    assert.deepEqual(await download(f, current, 'content.html'), Buffer.alloc(info.size, 65));
  } finally { await f.close(); }
});

test('current chapter directory lookups use an index for large filesystem inventories', async () => {
  const f = await fixture();
  try {
    const plan = f.db.prepare('EXPLAIN QUERY PLAN SELECT entry FROM chapters WHERE directory=?').all('contents/example/work/1') as { detail: string }[];
    assert.ok(plan.some(row => /USING INDEX sqlite_autoindex_chapters_/.test(row.detail)), JSON.stringify(plan));
    assert.ok(plan.every(row => !/SCAN chapters/.test(row.detail)));
  } finally { await f.close(); }
});


test('incremental scans discover an added cover without a metadata descriptor and rebuild minimal works', async () => {
  const f = await fixture();
  try {
    const directory = join(f.directory, '..');
    const value = { identity: workMetadata().identity, novel: { name: 'Minimal work' }, custom: true };
    const original = JSON.stringify(value);
    await writeFile(join(directory, 'novel.json'), original);
    assert.equal((await f.run()).failed, 0);
    const read = () => JSON.parse((f.db.prepare('SELECT entry FROM works').get() as { entry: string }).entry);
    assert.equal(read().hasCover, false);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    const first = read().sequence;
    await writeFile(join(directory, 'cover.webp'), 'local image');
    await f.run();
    assert.equal(read().hasCover, true);
    assert.deepEqual(read().metadata.cover, { fileName: 'cover.webp', contentType: 'image/webp' });
    assert.ok(read().sequence > first);
    const second = read().sequence;
    const unchanged = await f.run();
    assert.equal(unchanged.registered, 0);
    assert.equal(read().sequence, second);
    assert.equal(await readFile(join(directory, 'novel.json'), 'utf8'), original);
    assert.equal((await readdir(directory)).includes('cover.json'), false);
  } finally { await f.close(); }
});
