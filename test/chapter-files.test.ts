import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
  saveWork(db, dataDir, { schemaVersion: 1, identity: { pluginId: 'source', novelId: 'work', novelPath: '/work' }, novel: { name: 'Work', cover: null, author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false }, cover: null });
  const app = await buildApp({ ...options, dataDir });
  const headers = await deviceHeaders(app);
  return { app, db, headers, dataDir, close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true }); } };
}

function description(files: Record<string, Buffer>): PackageManifest {
  return { packageVersion: 1, layout: 'chapter-files', identity: { pluginId: 'source', novelId: 'work', novelPath: '/work', chapterPath: '/chapter/1' }, novel: { name: 'Work', isLocal: false }, chapter: { name: 'First', position: 1, chapterNumber: '1', contentType: 'html', page: '1' }, bodyPath: 'content.html', files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, size: data.length, modifiedAt: 1700000000000 })) };
}

async function archive(files: Record<string, Buffer> | [string, Buffer][], options = { compress: false, mode: 0o100644 }) {
  const zip = new ZipFile();
  for (const [path, data] of Array.isArray(files) ? files : Object.entries(files)) zip.addBuffer(data, path, options);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function upload(s: Awaited<ReturnType<typeof setup>>, files: Record<string, Buffer>, metadata = description(files), conflictPolicy?: string) {
  const body = await multipart(files, metadata);
  const url = conflictPolicy ? `/api/v1/chapter-files?conflictPolicy=${conflictPolicy}` : '/api/v1/chapter-files';
  return s.app.inject({ method: 'POST', url, headers: { ...s.headers, 'content-type': body.type }, payload: body.payload });
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

for (const state of ['missing-archive', 'missing-entry', 'missing-regular-file', 'remote-with-entry', 'extra-entry']) test(`catalog completeness uses declared ZIP assets: ${state}`, async () => {
  const s = await setup();
  try {
    const media = { version: 1, complete: state.startsWith('missing'), media: { files: [{ fileName: 'a.png', path: state === 'remote-with-entry' ? '' : 'media/a.png', status: state === 'remote-with-entry' ? 'remote' : 'stored' }] } };
    if (state === 'missing-entry') media.media.files.push({ fileName: 'b.png', path: 'media/b.png', status: 'stored' });
    const files: Record<string, Buffer> = { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from(JSON.stringify(media)) };
    if (state !== 'missing-archive') files['media.zip'] = await archive(state === 'extra-entry' ? { 'a.png': Buffer.from('image'), 'extra.png': Buffer.from('extra') } : { 'a.png': Buffer.from('image') });
    if (state === 'missing-regular-file') {
      const centralDirectory = files['media.zip'].indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      files['media.zip'].writeUInt32LE(0x10, centralDirectory + 38);
    }
    const response = await upload(s, files);
    assert.equal(response.statusCode, 200, response.body);
    const entry = response.json();
    const complete = !state.startsWith('missing');
    assert.equal(entry.complete, complete);
    const saved = JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(entry.id) as { entry: string }).entry);
    assert.equal(saved.complete, complete);
    const query = new URLSearchParams({ pluginId: 'source', novelPath: '/work', chapterPath: '/chapter/1' });
    assert.equal((await s.app.inject(`/api/v1/catalog/chapter?${query}`)).statusCode, complete ? 200 : 404);
    const lookup = await s.app.inject(`/api/v1/catalog/chapter?${query}&includeUnavailable=true`);
    assert.equal(lookup.json().complete, complete);
    const work = digest(JSON.stringify(['source', '/work']));
    assert.equal((await s.app.inject(`/api/v1/catalog/works/${work}/chapters`)).json().total, complete ? 1 : 0);
    assert.equal((await s.app.inject('/api/v1/catalog/works')).json().items[0].chapterCount, complete ? 1 : 0);
    assert.equal((await s.app.inject('/api/v1/catalog/changes')).json().items[0].complete, complete);
    const headers = await consoleHeaders(s.app, s.dataDir);
    const managed = await s.app.inject({ url: `/api/v1/admin/works/${work}/chapters`, headers });
    assert.equal(managed.json().items[0].entry.complete, complete);
    const works = await s.app.inject({ url: '/api/v1/admin/works', headers });
    assert.equal(works.json().items[0].downloadedChapters, complete ? 1 : 0);
  } finally { await s.close(); }
});

for (const [policy, storedComplete, incomingComplete, replaces] of [
  [undefined, false, true, true],
  ['prefer-complete', false, false, false],
  ['prefer-complete', true, true, false],
  ['prefer-complete', true, false, false],
  ['keep-server', false, true, false],
  ['keep-server', true, false, false],
  ['replace-server', true, false, true],
  ['replace-server', true, true, true],
] as const) test(`upload conflict ${policy ?? 'default'}: ${storedComplete} -> ${incomingComplete}`, async () => {
  const s = await setup();
  try {
    const files = (body: string, complete: boolean) => ({
      'content.html': Buffer.from(body),
      ...(complete ? {} : { 'manifest.json': Buffer.from(JSON.stringify({ version: 1, complete: true, media: { files: [{ fileName: 'missing.png', path: 'media/missing.png', status: 'stored' }] } })) }),
    });
    const original = await upload(s, files('original body', storedComplete));
    assert.equal(original.statusCode, 200, original.body);
    const first = original.json();
    const incoming = files('replacement body', incomingComplete);
    const response = await upload(s, incoming, description(incoming), policy);
    assert.equal(response.statusCode, 200, response.body);
    const current = response.json();
    assert.equal(current.id, first.id);
    assert.equal(current.complete, replaces ? incomingComplete : storedComplete);
    assert.equal(current.sequence > first.sequence, replaces);
    const downloaded = await s.app.inject(`/api/v1/chapters/${current.id}/files?revision=${current.revision}&path=content.html`);
    assert.equal(downloaded.body, replaces ? 'replacement body' : 'original body');
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

test('replace-server changes the download token when metadata stays identical', async () => {
  const s = await setup();
  try {
    const first = (await upload(s, { 'content.html': Buffer.from('first') })).json();
    const files = { 'content.html': Buffer.from('other') };
    const replacement = await upload(s, files, description(files), 'replace-server');
    assert.equal(replacement.statusCode, 200, replacement.body);
    assert.notEqual(replacement.json().revision, first.revision);
    assert.equal((await s.app.inject(`/api/v1/chapters/${first.id}/files?revision=${first.revision}&path=content.html`)).statusCode, 404);
  } finally { await s.close(); }
});

test('replace-server rejects an upload overtaken by a newer replacement', { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const first = (await upload(s, { 'content.html': Buffer.from('first') })).json();
    const files = { 'content.html': Buffer.alloc(128 * 1024, 65) };
    const body = await multipart(files);
    const address = await s.app.listen({ host: '127.0.0.1', port: 0 });
    let request!: ReturnType<typeof httpRequest>;
    const response = new Promise<{ status: number; body: string }>((accept, reject) => {
      request = httpRequest(`${address}/api/v1/chapter-files?conflictPolicy=replace-server`, { method: 'POST', headers: { ...s.headers, 'content-type': body.type } }, incoming => {
        void (async () => {
          const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
          accept({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() });
        })().catch(reject);
      });
      request.on('error', reject);
    });
    const split = Math.floor(body.payload.length / 2);
    request.write(body.payload.subarray(0, split));
    await waitFor(async () => (await readdir(join(s.dataDir, 'staging'))).length === 1);
    const newer = { 'content.html': Buffer.from('newer copy') };
    const winner = await upload(s, newer, description(newer), 'replace-server');
    assert.equal(winner.statusCode, 200, winner.body);
    request.end(body.payload.subarray(split));
    const result = await response;
    assert.equal(result.status, 409, result.body);
    assert.equal((await s.app.inject(`/api/v1/chapters/${first.id}/files?revision=${winner.json().revision}&path=content.html`)).body, 'newer copy');
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

test('conflicting uploads are validated before retention and reject unknown policies', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('existing') };
    const original = (await upload(s, files)).json();
    for (const policy of ['prefer-complete', 'keep-server', 'replace-server']) {
      const incoming = { ...files, 'manifest.json': Buffer.from('invalid JSON') };
      assert.equal((await upload(s, incoming, description(incoming), policy)).statusCode, 400);
    }
    assert.equal((await upload(s, files, description(files), 'unexpected')).statusCode, 400);
    assert.equal(JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(original.id) as { entry: string }).entry).sequence, original.sequence);
  } finally { await s.close(); }
});

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

for (const removal of ['filesystem', 'api']) test(`a folder alias restores a ${removal}-removed chapter using its canonical identity and directory`, async () => {
  const s = await setup();
  try {
    const media = { version: 1, complete: true, media: { files: [{ fileName: 'a.png', path: 'media/a.png', status: 'stored' }] } };
    const files = { 'content.html': Buffer.from('<p>Original</p>'), 'manifest.json': Buffer.from(JSON.stringify(media)), 'media.zip': await archive({ 'a.png': Buffer.from('original image') }) };
    const firstResponse = await upload(s, files);
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    const first = firstResponse.json();
    const stored = (s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(first.id) as { directory: string }).directory;
    const displaced = join(s.dataDir, 'displaced-chapter');
    if (removal === 'filesystem') {
      await rename(join(s.dataDir, stored), displaced);
      const scan = await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, changedPaths: [relative(join(s.dataDir, 'contents'), join(s.dataDir, stored))] });
      assert.equal(scan.removed, 1);
      assert.deepEqual({ ...s.db.prepare('SELECT path,deleted_at FROM chapters WHERE id=?').get(first.id) }, { path: null, deleted_at: null });
    } else {
      const removed = await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${first.id}`, headers: s.headers });
      assert.equal(removed.statusCode, 200, removed.body);
    }
    const replacementFiles = { ...files, 'content.html': Buffer.from('<p>Replacement</p>'), 'media.zip': await archive({ 'a.png': Buffer.from('replacement image') }) };
    const replacementManifest = description(replacementFiles);
    replacementManifest.identity.chapterPath = 'norea-folder:1';
    replacementManifest.chapter.name = 'Client-side title';
    const response = await upload(s, replacementFiles, replacementManifest);
    assert.equal(response.statusCode, 200, response.body);
    const replacement = response.json();
    assert.equal(replacement.id, first.id);
    assert.deepEqual(replacement.manifest.identity, first.manifest.identity);
    assert.equal(replacement.deleted, false);
    const row = s.db.prepare('SELECT directory,path,deleted_at FROM chapters WHERE id=?').get(first.id);
    assert.deepEqual({ ...row }, { directory: stored, path: stored, deleted_at: null });
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    for (const [path, bytes] of Object.entries(replacementFiles)) {
      assert.deepEqual(await readFile(join(s.dataDir, stored, path)), bytes);
      assert.deepEqual((await s.app.inject(`/api/v1/chapters/${first.id}/files?revision=${replacement.revision}&path=${path}`)).rawPayload, bytes);
    }
    if (removal === 'filesystem') for (const [path, bytes] of Object.entries(files)) assert.deepEqual(await readFile(join(displaced, path)), bytes);
    else assert.deepEqual(await readdir(join(s.dataDir, 'trash')), []);
    const latest = JSON.parse((s.db.prepare('SELECT entry FROM catalog_changes ORDER BY sequence DESC LIMIT 1').get() as { entry: string }).entry);
    assert.equal(latest.id, first.id);
    assert.equal(latest.deleted, false);
  } finally { await s.close(); }
});

test('a complete canonical chapter ignores changed uploads under its folder alias', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('original'), 'manifest.json': Buffer.from('{"version":1,"media":{"files":[]}}') };
    const first = (await upload(s, files)).json();
    const changed = { 'content.html': Buffer.from('changed') };
    const alias = description(changed); alias.identity.chapterPath = 'norea-folder:1';
    const ignored = await upload(s, changed, alias);
    assert.equal(ignored.statusCode, 200, ignored.body);
    assert.deepEqual(ignored.json(), first);
    for (const [path, bytes] of Object.entries(files)) assert.deepEqual((await s.app.inject(`/api/v1/chapters/${first.id}/files?revision=${first.revision}&path=${path}`)).rawPayload, bytes);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});

for (const deleted of [false, true]) test(`a stored folder identity does not merge later distinct source paths (deleted: ${deleted})`, async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('original') };
    const alias = description(files); alias.identity.chapterPath = 'norea-folder:1';
    const firstResponse = await upload(s, files, alias);
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    const first = firstResponse.json();
    if (deleted) assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${first.id}`, headers: s.headers })).statusCode, 200);
    for (const [path, name] of [['/chapter/1', 'Source A'], ['/other/chapter/1', 'Source B']]) {
      const sourceFiles = { 'content.html': Buffer.from(name) };
      const source = description(sourceFiles); source.identity.chapterPath = path; source.chapter.name = name;
      const response = await upload(s, sourceFiles, source);
      assert.equal(response.statusCode, 409, response.body);
    }
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    const row = s.db.prepare('SELECT path,entry FROM chapters WHERE id=?').get(first.id) as { path: string; entry: string };
    assert.equal(JSON.parse(row.entry).deleted, deleted);
    assert.equal(JSON.parse(row.entry).manifest.identity.chapterPath, 'norea-folder:1');
    assert.deepEqual(await readFile(join(s.dataDir, row.path, 'content.html')), files['content.html']);
  } finally { await s.close(); }
});

test('a recovered folder identity cannot claim a different chapter number', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('original') };
    const first = (await upload(s, files)).json();
    const alias = description(files); alias.identity.chapterPath = 'norea-folder:1'; alias.chapter.chapterNumber = '2';
    const rejected = await upload(s, files, alias);
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.deepEqual((await s.app.inject(`/api/v1/chapters/${first.id}/files?revision=${first.revision}&path=content.html`)).rawPayload, files['content.html']);
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
    const directory = join(s.dataDir, work.directory, '1');
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
    const directory = join(s.dataDir, work.directory, '1');
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
    const directory = join(s.dataDir, work.directory, '1');
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

test('stored media round trips without trusting or rewriting its completion marker', async () => {
  for (const complete of [undefined, false]) {
    const s = await setup();
    try {
      const files = {
        'content.html': Buffer.from('<img src="norea-media://reader-asset/a.png">'),
        'manifest.json': Buffer.from(JSON.stringify({ version: 1, complete, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 4, status: 'stored' }] } })),
        'media.zip': await archive({ 'a.png': Buffer.from('data') }),
      };
      const response = await upload(s, files);
      assert.equal(response.statusCode, 200, response.body);
      const entry = response.json();
      for (const [path, original] of Object.entries(files)) {
        const download = await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=${path}`);
        assert.deepEqual(download.rawPayload, original);
      }
    } finally { await s.close(); }
  }
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

test('stored media uses archive sizes without rewriting cached byte counts', async () => {
  for (const bytes of [0, 999]) {
    const s = await setup();
    try {
      const files = {
        'content.html': Buffer.from('<img src="norea-media://reader-asset/a.png">'),
        'manifest.json': Buffer.from(JSON.stringify({ version: 1, complete: true, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes, status: 'stored' }] } })),
        'media.zip': await archive({ 'a.png': Buffer.from('data') }),
      };
      const response = await upload(s, files);
      assert.equal(response.statusCode, 200, response.body);
      const entry = response.json();
      for (const [path, original] of Object.entries(files)) {
        const download = await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=${path}`);
        assert.deepEqual(download.rawPayload, original);
      }
    } finally { await s.close(); }
  }
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
    assert.equal(indexed.status, 'unchanged');
    assert.equal(indexed.revision, entry.revision);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM catalog_changes').get() as { n: number }).n, 1);
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
    await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, full: true });
    assert.equal((s.db.prepare('SELECT path FROM chapters WHERE id=?').get(entry.id) as { path: string | null }).path, null);
    assert.equal((await upload(s, files)).statusCode, 200);
    assert.deepEqual(await readdir(directory), ['content.html']);
    await writeFile(join(directory, 'content.html.part'), 'unfinished');
    await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, full: true });
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers })).statusCode, 200);
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: s.headers })).statusCode, 410);
  } finally { await s.close(); }
});

test('removing an already unavailable folder emits one deletion and permits alias recovery', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('original body') };
    const first = (await upload(s, files)).json();
    const stored = (s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(first.id) as { directory: string }).directory;
    const directory = join(s.dataDir, stored);
    await writeFile(join(directory, 'content.html.part'), 'unfinished');
    assert.equal((await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, full: true })).skipped, 1);
    const unavailable = s.db.prepare('SELECT path,entry,deleted_at FROM chapters WHERE id=?').get(first.id) as { path: string | null; entry: string; deleted_at: number | null };
    assert.equal(unavailable.path, null);
    assert.equal(unavailable.deleted_at, null);
    assert.equal(JSON.parse(unavailable.entry).deleted, false);
    assert.equal(s.db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(first.id), undefined);
    const displaced = join(s.dataDir, 'displaced-chapter');
    await rename(directory, displaced);
    const options = { db: s.db, dataDir: s.dataDir, limits: defaultLimits, changedPaths: [relative(join(s.dataDir, 'contents'), directory)] };
    assert.equal((await scanFolder(options)).removed, 1);
    const row = s.db.prepare('SELECT path,entry,deleted_at FROM chapters WHERE id=?').get(first.id) as { path: string | null; entry: string; deleted_at: number | null };
    const deleted = JSON.parse(row.entry);
    assert.equal(row.path, null);
    assert.equal(row.deleted_at, null);
    assert.equal(deleted.deleted, true);
    assert.ok(deleted.sequence > first.sequence);
    assert.equal((s.db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(first.id) as { sequence: number }).sequence, deleted.sequence);
    assert.equal((await scanFolder(options)).removed, 0);
    assert.equal((s.db.prepare('SELECT max(sequence) AS sequence FROM catalog_changes').get() as { sequence: number }).sequence, deleted.sequence);
    assert.equal((s.db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(first.id) as { sequence: number }).sequence, deleted.sequence);
    const alias = description(files); alias.identity.chapterPath = 'norea-folder:1';
    const replacement = await upload(s, files, alias);
    assert.equal(replacement.statusCode, 200, replacement.body);
    assert.equal(replacement.json().id, first.id);
    assert.deepEqual(replacement.json().manifest.identity, first.manifest.identity);
    assert.deepEqual(await readFile(join(directory, 'content.html')), files['content.html']);
    assert.deepEqual(await readFile(join(displaced, 'content.html')), files['content.html']);
    assert.equal(await readFile(join(displaced, 'content.html.part'), 'utf8'), 'unfinished');
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
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

test('a completed upload supersedes a cached unsupported-layout scan result', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('complete body') };
    const entry = (await upload(s, files)).json();
    const row = s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    await mkdir(join(s.dataDir, row.directory, 'loose-media'));
    assert.equal((await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, full: true })).skipped, 1);
    assert.equal((await upload(s, files)).statusCode, 200);
    const result = await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits });
    assert.equal(result.skipped, 0); assert.equal(result.unchanged, 2);
  } finally { await s.close(); }
});

test('full inspection assigns a new token to a changed same-size uploaded body', async () => {
  const s = await setup();
  try {
    const entry = (await upload(s, { 'content.html': Buffer.from('first') })).json();
    const row = s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    await writeFile(join(s.dataDir, row.directory, 'content.html'), 'other');
    await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, full: true });
    const current = JSON.parse((s.db.prepare('SELECT entry FROM chapters WHERE id=?').get(entry.id) as { entry: string }).entry);
    assert.notEqual(current.revision, entry.revision);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${current.revision}&path=content.html`)).body, 'other');
  } finally { await s.close(); }
});

test('full inspection validates uploaded files and preserves their identity after repair', async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('original body'), 'manifest.json': Buffer.from('{"version":1,"complete":true,"media":{"files":[]}}') };
    const entry = (await upload(s, files)).json();
    const row = s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(entry.id) as { directory: string };
    const manifestPath = join(s.dataDir, row.directory, 'manifest.json'); await writeFile(manifestPath, Buffer.alloc(files['manifest.json'].length, 33));
    const invalid = await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, full: true });
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

for (const alias of [false, true]) test(`deletion and restoration during a streaming upload prevent publication (folder alias: ${alias})`, { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const first = (await upload(s, { 'content.html': Buffer.from('first') })).json();
    const files = { 'content.html': Buffer.alloc(128 * 1024, 65) };
    const metadata = description(files);
    if (alias) metadata.identity.chapterPath = 'norea-folder:1';
    const body = await multipart(files, metadata);
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

for (const alias of [false, true]) for (const removal of ['filesystem', 'api-after-scan']) test(`a ${removal} deletion rejects an in-flight repair but permits a new upload (folder alias: ${alias})`, { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const first = (await upload(s, { 'content.html': Buffer.from('original body') })).json();
    const stored = (s.db.prepare('SELECT directory FROM chapters WHERE id=?').get(first.id) as { directory: string }).directory;
    const directory = join(s.dataDir, stored);
    const displaced = join(s.dataDir, 'displaced-chapter');
    const removeAndScan = async () => {
      await rename(directory, displaced);
      const scan = await scanFolder({ db: s.db, dataDir: s.dataDir, limits: defaultLimits, changedPaths: [relative(join(s.dataDir, 'contents'), directory)] });
      assert.equal(scan.removed, 1);
      const row = s.db.prepare('SELECT entry,deleted_at FROM chapters WHERE id=?').get(first.id) as { entry: string; deleted_at: number | null };
      const deleted = JSON.parse(row.entry);
      assert.equal(deleted.deleted, true);
      assert.equal(row.deleted_at, null);
      assert.equal((s.db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(first.id) as { sequence: number }).sequence, deleted.sequence);
    };
    if (removal === 'api-after-scan') await removeAndScan();
    else await writeFile(join(directory, 'content.html'), 'incomplete');
    const cursor = (s.db.prepare('SELECT max(sequence) AS sequence FROM catalog_changes').get() as { sequence: number }).sequence;
    const files = { 'content.html': Buffer.alloc(128 * 1024, 65) };
    const metadata = description(files);
    if (alias) metadata.identity.chapterPath = 'norea-folder:1';
    const body = await multipart(files, metadata);
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
    await waitFor(async () => {
      const stages = await readdir(join(s.dataDir, 'staging'));
      return stages.length === 1 && (await readdir(join(s.dataDir, 'staging', stages[0]))).includes('content.html');
    });
    if (removal === 'filesystem') await removeAndScan();
    else {
      const deleted = await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${first.id}`, headers: s.headers });
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.notEqual((s.db.prepare('SELECT deleted_at FROM chapters WHERE id=?').get(first.id) as { deleted_at: number | null }).deleted_at, null);
    }
    assert.ok((s.db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(first.id) as { sequence: number }).sequence > cursor);
    request.end(body.payload.subarray(split));
    const result = await response;
    assert.equal(result.status, 409, result.body);
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    const retry = await upload(s, files, metadata);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().id, first.id);
    assert.deepEqual(retry.json().manifest.identity, first.manifest.identity);
    assert.deepEqual(await readFile(join(directory, 'content.html')), files['content.html']);
    assert.equal(await readFile(join(displaced, 'content.html'), 'utf8'), removal === 'filesystem' ? 'incomplete' : 'original body');
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
  } finally { await s.close(); }
});

test('unsafe paths, incorrect body types, malformed media and undeclared parts are rejected', { timeout: 5000 }, async () => {
  const s = await setup();
  try {
    const files = { 'content.html': Buffer.from('body') };
    const metadata = description(files);
    const invalid: { files: Record<string, Buffer>; metadata: PackageManifest }[] = [
      { files, metadata: { ...metadata, bodyPath: '../content.html', files: [{ ...metadata.files[0], path: '../content.html' }] } },
      { files, metadata: { ...metadata, files: [metadata.files[0], { path: 'media/a.png', size: 1, modifiedAt: 1700000000000 }] } },
      { files, metadata: { ...metadata, chapter: { ...metadata.chapter, contentType: 'pdf' } } },
      { files: { ...files, 'manifest.json': Buffer.from('{"version":1,"complete":true,"media":{"files":[{"fileName":"../a.png","path":"","bytes":0,"status":"remote"}]}}') }, metadata: description({ ...files, 'manifest.json': Buffer.from('{"version":1,"complete":true,"media":{"files":[{"fileName":"../a.png","path":"","bytes":0,"status":"remote"}]}}') }) },
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

test('unsafe ZIP entries and malformed media inventories are rejected', async () => {
  const s = await setup();
  try {
    const media = { version: 1, complete: true, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 4, status: 'stored' }] } };
    const invalidArchives = [
      Buffer.from('invalid archive'),
      await archive([['a.png', Buffer.from('data')], ['a.png', Buffer.from('data')]]),
      await archive({ 'a.png': Buffer.from('data') }, { compress: false, mode: 0o120777 }),
    ];
    for (const zip of invalidArchives) {
      const response = await upload(s, { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from(JSON.stringify(media)), 'media.zip': zip });
      assert.equal(response.statusCode, 400, response.body);
    }
    const zip = await archive({ 'a.png': Buffer.from('data') });
    for (const changed of [{ fileName: '../a.png' }, { path: 'outside/a.png' }]) {
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
    const media = { version: 1, complete: true, media: { files: [{ fileName: 'a.png', path: 'media/a.png', bytes: 0, status: 'stored' }] } };
    const files = { 'content.html': Buffer.from('body'), 'manifest.json': Buffer.from(JSON.stringify(media)), 'media.zip': await archive({ 'a.png': Buffer.alloc(4096) }, { compress: true, mode: 0o100644 }) };
    assert.ok(Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) < 1024);
    const response = await upload(s, files);
    assert.equal(response.statusCode, 413, response.body);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 0);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
  } finally { await s.close(); }
});
