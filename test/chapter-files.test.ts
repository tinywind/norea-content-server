import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { defaultLimits, digest, type PackageManifest } from '../src/packages.ts';
import { scanFolder, type FolderIndexItem } from '../src/folder-indexer.ts';
import { saveWork } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

async function setup(options: Partial<Parameters<typeof buildApp>[0]> = {}) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'chapter-files-'));
  const db = openDatabase(dataDir);
  saveWork(db, dataDir, { schemaVersion: 1, identity: { pluginId: 'source', novelPath: '/work' }, novel: { name: 'Work', cover: null, author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false }, cover: null });
  const app = await buildApp({ ...options, dataDir });
  const headers = await deviceHeaders(app);
  return { app, db, headers, dataDir, close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true }); } };
}

function description(files: Record<string, Buffer>): PackageManifest {
  return { packageVersion: 1, layout: 'chapter-files', identity: { pluginId: 'source', novelPath: '/work', chapterPath: '/chapter/1' }, novel: { name: 'Work', isLocal: false }, chapter: { name: 'First', position: 1, chapterNumber: '1', contentType: 'html', page: '1' }, bodyPath: 'content.html', files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, size: data.length, modifiedAt: 1700000000000 })) };
}

async function archive(files: Record<string, Buffer> | [string, Buffer][], options = { compress: false, mode: 0o100644 }) {
  const zip = new ZipFile();
  for (const [path, data] of Array.isArray(files) ? files : Object.entries(files)) zip.addBuffer(data, path, options);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function upload(s: Awaited<ReturnType<typeof setup>>, files: Record<string, Buffer>, metadata = description(files)) {
  const body = await multipart(files, metadata);
  return s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...s.headers, 'content-type': body.type }, payload: body.payload });
}

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(10); }
  assert.fail('Expected state did not become visible');
}

async function multipart(files: Record<string, Buffer>, metadata = description(files)) {
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  for (const [path, data] of Object.entries(files)) form.append(path, new Blob([new Uint8Array(data)]), path);
  const request = new Request('http://localhost', { method: 'POST', body: form });
  return { payload: Buffer.from(await request.arrayBuffer()), type: request.headers.get('content-type')! };
}

test('a complete server copy ignores later uploads and can be replaced after deletion', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('<p>First</p>') };
    const first = (await upload(s, files)).json();
    const changed = { 'content.html': Buffer.from('<p>Replacement</p>') };
    const ignored = await upload(s, changed);
    assert.equal(ignored.statusCode, 200, ignored.body);
    assert.deepEqual(ignored.json(), first);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${first.id}/revision`, headers: await consoleHeaders(s.app, s.dataDir), payload: { revision: first.revision } })).statusCode, 404);
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${first.id}`, headers: s.headers });
    const replacement = await upload(s, changed);
    assert.equal(replacement.statusCode, 200, replacement.body);
    assert.equal(replacement.json().deleted, false);
    assert.notEqual(replacement.json().revision, first.revision);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.deepEqual((await s.app.inject(`/api/v1/chapters/${first.id}/files?revision=${replacement.json().revision}&path=content.html`)).rawPayload, changed['content.html']);
    assert.equal((await s.app.inject(`/api/v1/chapters/${first.id}/files?revision=${first.revision}&path=content.html`)).statusCode, 404);
  } finally { await s.close(); }
});

test('missing server files are repaired by the next completed upload', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('<p>First</p>') };
    const first = (await upload(s, files)).json();
    const stored = (s.db.prepare('SELECT path FROM chapters WHERE id=?').get(first.id) as { path: string }).path;
    await writeFile(join(s.dataDir, stored, 'content.html'), 'truncated');
    const query = new URLSearchParams(first.manifest.identity);
    assert.equal((await s.app.inject(`/api/v1/catalog/chapter?${query}`)).statusCode, 404);
    assert.equal((await s.app.inject(`/api/v1/catalog/chapter?${query}&includeUnavailable=true`)).json().id, first.id);
    const repaired = await upload(s, files);
    assert.equal(repaired.statusCode, 200, repaired.body);
    assert.deepEqual(await readFile(join(s.dataDir, stored, 'content.html')), files['content.html']);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
  } finally { await s.close(); }
});

test('current uploads, rescans, and repairs preserve unrelated files in a chapter folder', async () => {
  const s = await setup();
  try {
    const work = s.db.prepare('SELECT directory FROM works').get() as { directory: string };
    const directory = join(s.dataDir, work.directory, '1-First');
    await mkdir(directory);
    const unrelated = Buffer.from('Opaque file that must not be read or replaced');
    await writeFile(join(directory, 'attachment.zip'), unrelated);
    const files = { 'content.html': Buffer.from('<p>Current chapter</p>') };
    const response = await upload(s, files);
    assert.equal(response.statusCode, 200, response.body);
    const entry = response.json();
    assert.deepEqual(await readFile(join(directory, 'attachment.zip')), unrelated);
    assert.deepEqual((await upload(s, files)).json(), entry);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=attachment.zip`)).statusCode, 400);
    const summary = await scanFolder({ dataDir: s.dataDir, db: s.db, limits: defaultLimits });
    assert.equal(summary.skipped, 0);
    const current = JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(entry.id) as { entry: string }).entry);
    assert.deepEqual(current.manifest.files.map((file: { path: string }) => file.path), ['content.html']);
    assert.deepEqual(await readFile(join(directory, 'attachment.zip')), unrelated);
    assert.equal((await scanFolder({ dataDir: s.dataDir, db: s.db, limits: defaultLimits })).unchanged, 2);
    await rm(join(directory, 'content.html'));
    assert.equal((await upload(s, files)).statusCode, 200);
    assert.deepEqual(await readFile(join(directory, 'attachment.zip')), unrelated);
    await writeFile(join(directory, 'content.html'), 'Incomplete');
    s.db.exec("CREATE TRIGGER reject_repair BEFORE INSERT ON catalog_changes BEGIN SELECT RAISE(ABORT, 'Repair failed'); END");
    assert.equal((await upload(s, files)).statusCode, 500);
    assert.equal(await readFile(join(directory, 'content.html'), 'utf8'), 'Incomplete');
    assert.deepEqual(await readFile(join(directory, 'attachment.zip')), unrelated);
  } finally { await s.close(); }
});

test('uploads never overwrite an unindexed current chapter file', async () => {
  const s = await setup();
  try {
    const work = s.db.prepare('SELECT directory FROM works').get() as { directory: string };
    const directory = join(s.dataDir, work.directory, '1-First');
    await mkdir(directory);
    await writeFile(join(directory, 'content.html'), 'Original body');
    const response = await upload(s, { 'content.html': Buffer.from('Replacement') });
    assert.equal(response.statusCode, 409);
    assert.equal(await readFile(join(directory, 'content.html'), 'utf8'), 'Original body');
    assert.equal(s.db.prepare('SELECT 1 FROM chapters').get(), undefined);
  } finally { await s.close(); }
});

test('failed publication removes only newly added files from an occupied folder', async () => {
  const s = await setup();
  try {
    const work = s.db.prepare('SELECT directory FROM works').get() as { directory: string };
    const directory = join(s.dataDir, work.directory, '1-First');
    await mkdir(directory);
    await writeFile(join(directory, 'notes.txt'), 'Preserve this file');
    s.db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON catalog_changes BEGIN SELECT RAISE(ABORT, 'Publication failed'); END");
    const response = await upload(s, { 'content.html': Buffer.from('Current body') });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(await readdir(directory), ['notes.txt']);
    assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'Preserve this file');
    assert.equal(s.db.prepare('SELECT 1 FROM chapters').get(), undefined);
  } finally { await s.close(); }
});

test('original chapter files round trip without rewriting or an outer archive', async () => {
  const s = await setup();
  try {
    const files = {
      'content.html': Buffer.from('\ufeff<p>Keep exact bytes</p>\r\n<img src="norea-media://reader-asset/a.png">'),
      'manifest.json': Buffer.from('{ "version": 1, "complete": true, "updatedAt": 123, "media": { "files": [{"fileName":"a.png","path":"media/a.png","bytes":4,"status":"stored","updatedAt":123}] } }\n'),
      'media.zip': await archive({ 'a.png': Buffer.from([0, 1, 255, 5]) }),
    };
    const body = await multipart(files);
    const response = await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...s.headers, 'content-type': body.type }, payload: body.payload });
    assert.equal(response.statusCode, 200, response.body);
    const entry = response.json();
    assert.equal(entry.manifest.layout, 'chapter-files');
    assert.deepEqual(entry.manifest.files, description(files).files);
    assert.equal(entry.zipBytes, undefined);
    assert.equal(entry.fileBytes, Object.values(files).reduce((sum, file) => sum + file.length, 0));
    const chapter = s.db.prepare('SELECT path FROM chapters WHERE id=?').get(entry.id) as { path: string };
    for (const [path, expected] of Object.entries(files)) {
      assert.deepEqual(await readFile(join(s.dataDir, chapter.path, path)), expected);
      const download = await s.app.inject({ url: `/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=${path}` });
      assert.equal(download.statusCode, 200, download.body);
      assert.deepEqual(download.rawPayload, expected);
      assert.equal(download.headers.etag, `"${entry.revision}:${path}"`);
      assert.equal(download.headers['content-length'], String(expected.length));
    }
    assert.deepEqual((await readdir(join(s.dataDir, chapter.path))).sort(), ['content.html', 'manifest.json', 'media.zip']);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.pdf`)).statusCode, 404);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/package`)).statusCode, 404);
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers })).statusCode, 200);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.html`)).statusCode, 410);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: s.headers })).statusCode, 200);
    assert.deepEqual((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.html`)).rawPayload, files['content.html']);
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers });
    const purged = await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/purge`, headers: await consoleHeaders(s.app, s.dataDir) });
    assert.equal(purged.statusCode, 200, purged.body);
    const purgedChapter = s.db.prepare('SELECT path FROM chapters WHERE id=?').get(entry.id) as { path: string | null };
    assert.equal(purgedChapter.path, null);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: s.headers })).statusCode, 410);
    assert.equal(JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(entry.id) as { entry: string }).entry).deleted, true);
    assert.equal((await upload(s, files)).statusCode, 200);
  } finally { await s.close(); }
});

test('PDF files retain their bytes and device read authorization', async () => {
  const s = await setup({ anonymousRead: false });
  try {
    const files = { 'content.pdf': Buffer.from('%PDF-1.7\r\noriginal bytes\0\xff', 'latin1') };
    const metadata = description(files); metadata.bodyPath = 'content.pdf'; metadata.chapter.contentType = 'pdf';
    const response = await upload(s, files, metadata);
    assert.equal(response.statusCode, 200, response.body);
    const entry = response.json();
    const url = `/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.pdf`;
    assert.equal((await s.app.inject(url)).statusCode, 401);
    assert.deepEqual((await s.app.inject({ url, headers: s.headers })).rawPayload, files['content.pdf']);
    const admin = await consoleHeaders(s.app, s.dataDir);
    const device = (await s.app.inject({ url: '/api/v1/admin/devices', headers: admin })).json().items[0];
    await s.app.inject({ method: 'PATCH', url: `/api/v1/admin/devices/${device.id}`, headers: admin, payload: { blocked: true } });
    assert.equal((await s.app.inject({ url, headers: s.headers })).statusCode, 403);
  } finally { await s.close(); }
});

test('raw uploads require a nonnegative safe integer modification time instead of a checksum', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('body') };
    for (const modifiedAt of [undefined, null, '1700000000000', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const metadata = description(files); Object.assign(metadata.files[0], { modifiedAt });
      const response = await upload(s, files, metadata);
      assert.equal(response.statusCode, 400, response.body);
    }
    const checksum = description(files); Object.assign(checksum.files[0], { sha256: digest('body') });
    assert.equal((await upload(s, files, checksum)).statusCode, 400);
    Reflect.deleteProperty(checksum.files[0], 'modifiedAt');
    assert.equal((await upload(s, files, checksum)).statusCode, 400);
    const noLayout = description(files); Reflect.deleteProperty(noLayout, 'layout');
    assert.equal((await upload(s, files, noLayout)).statusCode, 400);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    const metadata = description(files); metadata.files[0].modifiedAt = 0;
    const valid = await upload(s, files, metadata);
    assert.equal(valid.statusCode, 200, valid.body);
    assert.deepEqual(valid.json().manifest.files, [{ path: 'content.html', size: 4, modifiedAt: 0 }]);
  } finally { await s.close(); }
});

test('concurrent and changed uploads retain the complete stored copy', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('first') };
    const responses = await Promise.all([upload(s, files), upload(s, files)]);
    responses.forEach(response => assert.equal(response.statusCode, 200, response.body));
    assert.deepEqual(responses[0].json(), responses[1].json());
    const first = responses[0].json();
    const nextFiles = { 'content.html': Buffer.from('other') };
    const nextMetadata = description(nextFiles); nextMetadata.files[0].modifiedAt = 1700000000001;
    const next = await upload(s, nextFiles, nextMetadata);
    assert.equal(next.statusCode, 200, next.body);
    const second = next.json();
    assert.deepEqual(first, second);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM catalog_changes').get() as { n: number }).n, 1);
    for (const [entry, body] of [[first, files['content.html']], [second, files['content.html']]] as const) {
      assert.deepEqual((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.html`)).rawPayload, body);
    }
    const selected = await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${first.id}/revision`, headers: await consoleHeaders(s.app, s.dataDir), payload: { revision: second.revision } });
    assert.equal(selected.statusCode, 404);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

test('storage scans recognize current uploaded chapter directories without rewriting them', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('<img src="norea-media://reader-asset/preserve">') };
    const entry = (await upload(s, files)).json();
    const items: FolderIndexItem[] = [];
    const result = await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, onItem: item => { items.push(item); } });
    assert.equal(result.skipped, 0, JSON.stringify(items));
    assert.equal(result.failed, 0, JSON.stringify(items));
    const indexed = items.find(item => item.chapterId === entry.id)!;
    assert.equal(indexed.status, 'registered');
    assert.notEqual(indexed.revision, entry.revision);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM catalog_changes').get() as { n: number }).n, 2);
    assert.deepEqual((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${indexed.revision}&path=content.html`)).rawPayload, files['content.html']);
    assert.equal((await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits })).registered, 0);
  } finally { await s.close(); }
});

test('outer ZIP package uploads are unsupported', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('body') };
    const bytes = await archive({ ...files, 'manifest.json': Buffer.from(JSON.stringify(description(files))) });
    const response = await s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...s.headers, 'content-type': 'application/zip' }, payload: bytes });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
  } finally { await s.close(); }
});

test('an unavailable indexed directory can be repaired by upload and removed by deletion', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('original body') };
    const entry = (await upload(s, files)).json();
    const row = s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    const directory = join(s.dataDir, row.directory);
    await writeFile(join(directory, 'content.html.part'), 'unfinished');
    await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits });
    assert.equal((s.db.prepare('SELECT path FROM chapters WHERE id=?').get(entry.id) as { path: string | null }).path, null);
    assert.equal((await upload(s, files)).statusCode, 200);
    assert.deepEqual(await readdir(directory), ['content.html']);
    await writeFile(join(directory, 'content.html.part'), 'unfinished');
    await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits });
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers })).statusCode, 200);
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: s.headers })).statusCode, 410);
  } finally { await s.close(); }
});

test('restoring deleted files validates media again', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from('{"version":1,"complete":true,"media":{"files":[]}}') };
    const entry = (await upload(s, files)).json();
    const row = s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    await writeFile(join(s.dataDir, row.directory, 'manifest.json'), Buffer.alloc(files['manifest.json'].length, 33));
    await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits });
    await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers });
    const restore = await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: s.headers });
    assert.equal(restore.statusCode, 400, restore.body);
    assert.equal(JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(entry.id) as { entry: string }).entry).deleted, true);
  } finally { await s.close(); }
});

test('the first scan assigns a new token to a changed same-size uploaded body', async () => {
  const s = await setup();
  try {
    const entry = (await upload(s, { 'content.html': Buffer.from('first') })).json();
    const row = s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    await writeFile(join(s.dataDir, row.directory, 'content.html'), 'other');
    await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits });
    const current = JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(entry.id) as { entry: string }).entry);
    assert.notEqual(current.revision, entry.revision);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${current.revision}&path=content.html`)).body, 'other');
  } finally { await s.close(); }
});

test('the first storage scan validates uploaded files and preserves their identity after repair', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('original body'), 'manifest.json': Buffer.from('{"version":1,"complete":true,"media":{"files":[]}}') };
    const entry = (await upload(s, files)).json();
    const row = s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    const manifestPath = join(s.dataDir, row.directory, 'manifest.json'); await writeFile(manifestPath, Buffer.alloc(files['manifest.json'].length, 33));
    const invalid = await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits });
    assert.equal(invalid.skipped, 1);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.html`)).statusCode, 410);
    await writeFile(manifestPath, files['manifest.json']);
    const repaired = await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits });
    assert.equal(repaired.registered, 1);
    const current = JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(entry.id) as { entry: string }).entry);
    assert.deepEqual(current.manifest.identity, entry.manifest.identity);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapter_tombstones').get() as { n: number }).n, 0);
    assert.deepEqual((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${current.revision}&path=content.html`)).rawPayload, files['content.html']);
  } finally { await s.close(); }
});

test('missing, wrong-sized and interrupted files never enter the catalog', { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('complete body'), 'manifest.json': Buffer.from('{"version":1,"complete":true,"media":{"files":[]}}') };
    const complete = await multipart(files);
    const invalid = [
      await multipart({ 'content.html': files['content.html'] }, description(files)),
      await multipart({ ...files, 'content.html': Buffer.from('wrong body') }, description(files)),
      { ...complete, payload: complete.payload.subarray(0, complete.payload.length - 50) },
      { ...complete, payload: complete.payload.subarray(0, complete.payload.length - 3) },
      { ...complete, payload: complete.payload.subarray(0, complete.payload.length - 4) },
    ];
    for (const upload of invalid) {
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...s.headers, 'content-type': upload.type }, payload: upload.payload });
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
      assert.equal((s.db.prepare('SELECT count(*) AS count FROM chapters').get() as { count: number }).count, 0);
      assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    }
  } finally { await s.close(); }
});

test('a disconnected multipart upload is unpublished and removes staged files', { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const body = await multipart({ 'content.html': Buffer.alloc(128 * 1024, 65) });
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest(`${address}/api/v1/chapter-files`, { method: 'POST', headers: { ...s.headers, 'content-type': body.type } });
    request.on('error', () => {});
    request.write(body.payload.subarray(0, body.payload.length / 2));
    await waitFor(async () => (await readdir(join(s.dataDir, 'staging')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).length === 1);
    request.destroy();
    await waitFor(async () => (await readdir(join(s.dataDir, 'staging'))).length === 0);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
  } finally { await s.close(); }
});

test('a streaming multipart body that ends inside a file returns a client error', { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const body = await multipart({ 'content.html': Buffer.alloc(128 * 1024, 65) });
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
    let finish!: (response: { status: number; body: string }) => void;
    let fail!: (error: Error) => void;
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => { finish = resolve; fail = reject; });
    const request = httpRequest(`${address}/api/v1/chapter-files`, { method: 'POST', headers: { ...s.headers, 'content-type': body.type } }, incoming => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
        finish({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() });
      })().catch(fail);
    });
    request.on('error', fail);
    request.write(body.payload.subarray(0, body.payload.length / 2));
    await waitFor(async () => (await readdir(join(s.dataDir, 'staging')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).length === 1);
    request.end();
    const result = await response;
    assert.equal(result.status, 400, result.body);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

test('deletion and restoration during a streaming upload prevent publication', { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const first = (await upload(s, { 'content.html': Buffer.from('first') })).json();
    const body = await multipart({ 'content.html': Buffer.alloc(128 * 1024, 65) });
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
    let finish!: (response: { status: number; body: string }) => void;
    let fail!: (error: Error) => void;
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => { finish = resolve; fail = reject; });
    const request = httpRequest(`${address}/api/v1/chapter-files`, { method: 'POST', headers: { ...s.headers, 'content-type': body.type } }, incoming => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
        finish({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() });
      })().catch(fail);
    });
    request.on('error', fail);
    const split = Math.floor(body.payload.length / 2);
    request.write(body.payload.subarray(0, split));
    await waitFor(async () => (await readdir(join(s.dataDir, 'staging'))).length === 1);
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${first.id}`, headers: s.headers })).statusCode, 200);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${first.id}/restore`, headers: s.headers })).statusCode, 200);
    request.end(body.payload.subarray(split));
    const result = await response;
    assert.equal(result.status, 409, result.body);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

test('unsafe paths, incorrect body types, incomplete media and undeclared parts are rejected', { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('body') };
    const metadata = description(files);
    const invalid: { files: Record<string, Buffer>; metadata: PackageManifest }[] = [
      { files, metadata: { ...metadata, bodyPath: '../content.html', files: [{ ...metadata.files[0], path: '../content.html' }] } },
      { files, metadata: { ...metadata, files: [metadata.files[0], { path: 'media/a.png', size: 1, modifiedAt: 1700000000000 }] } },
      { files, metadata: { ...metadata, chapter: { ...metadata.chapter, contentType: 'pdf' } } },
      { files: { ...files, 'manifest.json': Buffer.from('{"version":1,"complete":false,"media":{"files":[]}}') }, metadata: description({ ...files, 'manifest.json': Buffer.from('{"version":1,"complete":false,"media":{"files":[]}}') }) },
      { files: { ...files, 'media.zip': Buffer.from('archive') }, metadata: description({ ...files, 'media.zip': Buffer.from('archive') }) },
      { files: { ...files, 'extra.txt': Buffer.from('extra') }, metadata },
    ];
    for (const item of invalid) {
      const response = await upload(s, item.files, item.metadata);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
      assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    }
    for (const order of ['file-first', 'duplicate-file', 'duplicate-metadata', 'wrong-filename']) {
      const form = new FormData();
      if (order !== 'file-first') form.append('metadata', JSON.stringify(metadata));
      form.append('content.html', new Blob(['body']), order === 'wrong-filename' ? 'other.html' : 'content.html');
      if (order === 'duplicate-file') form.append('content.html', new Blob(['body']), 'content.html');
      else if (order !== 'wrong-filename') form.append('metadata', JSON.stringify(metadata));
      const request = new Request('http://localhost', { method: 'POST', body: form });
      const response = await s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...s.headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
      assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    }
  } finally { await s.close(); }
});

test('raw artifact byte, metadata and file limits fail before publication', { timeout: 5000 }, async () => {
  for (const limits of [{ expandedBytes: 3 }, { files: 0 }, { zipBytes: 3 }]) {
    const s = await setup({ limits });
    try {
      const files: Record<string, Buffer> = { 'content.html': Buffer.from('body') };
      if (limits.zipBytes !== undefined) {
        files['manifest.json'] = Buffer.from('{"version":1,"complete":true,"media":{"files":[]}}');
        files['media.zip'] = Buffer.from('archive');
      }
      const response = await upload(s, files);
      assert.equal(response.statusCode, 413, response.body);
      assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
      assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    } finally { await s.close(); }
  }
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('body') };
    const metadata = description(files); metadata.novel.summary = 'a'.repeat(65 * 1024);
    assert.equal((await upload(s, files, metadata)).statusCode, 400);
    const understated = description(files); understated.files[0].size = 1;
    assert.equal((await upload(s, files, understated)).statusCode, 400);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

test('media central directories must exactly match complete stored manifest entries', async () => {
  const s = await setup();
  try {
    const media = { version: 1, complete: true, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 4, status: 'stored' }] } };
    const invalidArchives = [
      Buffer.from('invalid archive'),
      await archive({}),
      await archive({ 'b.png': Buffer.from('data') }),
      await archive({ 'a.png': Buffer.from('longer') }),
      await archive({ 'a.png': Buffer.from('data'), 'extra.png': Buffer.from('extra') }),
      await archive([['a.png', Buffer.from('data')], ['a.png', Buffer.from('data')]]),
      await archive({ 'a.png': Buffer.from('data') }, { compress: false, mode: 0o120777 }),
    ];
    for (const zip of invalidArchives) {
      const response = await upload(s, { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from(JSON.stringify(media)), 'media.zip': zip });
      assert.equal(response.statusCode, 400, response.body);
    }
    const zip = await archive({ 'a.png': Buffer.from('data') });
    for (const changed of [{ fileName: '../a.png' }, { path: 'outside/a.png' }, { bytes: -1 }, { status: 'remote' }]) {
      const invalid = { ...media, media: { files: [{ ...media.media.files[0], ...changed }] } };
      const response = await upload(s, { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from(JSON.stringify(invalid)), 'media.zip': zip });
      assert.equal(response.statusCode, 400, response.body);
    }
    const duplicates = { ...media, media: { files: [media.media.files[0], media.media.files[0]] } };
    assert.equal((await upload(s, { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from(JSON.stringify(duplicates)), 'media.zip': zip })).statusCode, 400);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

test('media uncompressed byte limits are checked without extracting the archive', async () => {
  const s = await setup({ limits: { expandedBytes: 1024 } });
  try {
    const media = { version: 1, complete: true, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 4096, status: 'stored' }] } };
    const files = { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from(JSON.stringify(media)), 'media.zip': await archive({ 'a.png': Buffer.alloc(4096) }, { compress: true, mode: 0o100644 }) };
    assert.ok(Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) < 1024);
    const response = await upload(s, files);
    assert.equal(response.statusCode, 413, response.body);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});
