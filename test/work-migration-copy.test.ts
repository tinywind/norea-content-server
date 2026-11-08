import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { openDatabase, problem } from '../src/db.ts';
import { defaultLimits, digest, type CatalogEntry, type PackageManifest } from '../src/packages.ts';
import { copyMigrationChapter, type MigrationCopyRequest } from '../src/work-migration-copy.ts';
import { migrationSnapshot, type FinalizeMigrationRequest } from '../src/work-migrations.ts';
import { saveWork, type NovelMetadataV1 } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const metadata = (pluginId: string): NovelMetadataV1 => ({
  schemaVersion: 1, identity: { pluginId, novelId: 'book', novelPath: '/' + pluginId + '/book' },
  novel: { name: pluginId === 'target' ? 'Fresh target title' : 'Old source title', author: pluginId === 'target' ? 'Fresh author' : 'Old author', artist: null,
    summary: pluginId === 'target' ? 'Fresh summary' : 'Old summary', status: null, genres: null, rating: null, isLocal: false },
  cover: null, chapters: pluginId === 'target' ? { '1001': 'Fresh first episode' } : { '1': 'Old first episode' },
});
const workId = (side: string) => digest(JSON.stringify([side, '/' + side + '/book']));
const sourceId = workId('source');
const targetId = workId('target');
async function archive() {
  const zip = new ZipFile(); zip.addBuffer(Buffer.from('synthetic image bytes'), 'page.png', { compress: false }); zip.end();
  const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/migration-copy-'));
  const db = openDatabase(dataDir);
  saveWork(db, dataDir, metadata('source')); saveWork(db, dataDir, metadata('target'));
  const app = await buildApp({ dataDir, anonymousRead: false });
  const headers = await deviceHeaders(app);
  const upload = async (side: string, body = 'synthetic body', media = false, expectedStatus = 200) => {
    const number = side === 'target' ? '1001' : '1';
    const value = metadata(side);
    const files: Record<string, Buffer> = { 'content.html': Buffer.from(body) };
    if (media) {
      files['manifest.json'] = Buffer.from(JSON.stringify({ version: 1, complete: true, updatedAt: 1, media: { files: [{ fileName: 'page.png', sourceUrl: 'https://fixture.invalid/page.png', path: 'media/page.png', status: 'stored', bytes: Buffer.byteLength('synthetic image bytes'), updatedAt: 1 }] } }));
      files['media.zip'] = await archive();
    }
    const manifest: PackageManifest = { packageVersion: 1, layout: 'chapter-files', identity: { ...value.identity, chapterPath: '/' + side + '/1' },
      novel: { name: value.novel.name, author: value.novel.author, summary: value.novel.summary, isLocal: false },
      chapter: { name: value.chapters[number], chapterNumber: number, position: 1, page: '1', contentType: 'html' }, bodyPath: 'content.html',
      files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, size: bytes.length, modifiedAt: 1 })) };
    const form = new FormData(); form.append('metadata', JSON.stringify(manifest));
    for (const [name, bytes] of Object.entries(files)) form.append(name, new Blob([new Uint8Array(bytes)]), name);
    const request = new Request('http://fixture', { method: 'POST', body: form });
    const response = await app.inject({ method: 'POST', url: '/api/v1/chapter-files?conflictPolicy=replace-server',
      headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(response.statusCode, expectedStatus, response.body); return response.json<CatalogEntry>();
  };
  const request = (source: CatalogEntry, target: CatalogEntry | null = null): MigrationCopyRequest => ({
    decision: 'copy-source', source: { revision: migrationSnapshot(db, dataDir, sourceId).work.revision, chapter: { id: source.id, revision: source.revision } },
    target: { id: targetId, revision: migrationSnapshot(db, dataDir, targetId).work.revision, chapter: { chapterPath: '/target/1', chapterNumber: '1001', position: 1, name: 'Fresh first episode', page: '1' },
      expectedChapter: target ? { id: target.id, revision: target.revision } : null },
  });
  const copy = (payload: MigrationCopyRequest) => app.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/migration-copy', headers, payload });
  const body = (side: string) => readFile(join(dataDir, 'contents', side, 'book', side === 'target' ? '1001' : '1', 'content.html'), 'utf8');
  return { db, app, dataDir, headers, upload, request, copy, body, close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('server migration copy preserves original body and media, rewrites only target metadata, and safely replays a lost response', async () => {
  const f = await fixture();
  try {
    const source = await f.upload('source', '<p>Synthetic image</p><img src="page.png">', true);
    const request = f.request(source);
    const response = await f.copy(request);
    assert.equal(response.statusCode, 200, response.body);
    const entry = response.json().entry as CatalogEntry;
    assert.deepEqual(entry.manifest.identity, { ...metadata('target').identity, chapterPath: '/target/1' });
    assert.deepEqual(entry.manifest.novel, { name: 'Fresh target title', author: 'Fresh author', summary: 'Fresh summary', isLocal: false });
    assert.equal(entry.manifest.chapter.chapterNumber, '1001'); assert.equal(entry.manifest.chapter.position, 1);
    assert.equal(entry.manifest.chapter.name, 'Fresh first episode'); assert.equal(entry.complete, true);
    for (const name of ['content.html', 'manifest.json', 'media.zip']) {
      const before = await readFile(join(f.dataDir, 'contents/source/book/1', name));
      const after = await readFile(join(f.dataDir, 'contents/target/book/1001', name));
      assert.equal(digest(after), digest(before));
    }
    assert.equal((await f.app.inject({ url: '/api/v1/works/' + sourceId, headers: f.headers })).statusCode, 200);
    const sequence = (f.db.prepare('SELECT max(sequence) AS n FROM catalog_changes').get() as { n: number }).n;
    const replay = await f.copy(request);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), response.json());
    assert.equal((f.db.prepare('SELECT max(sequence) AS n FROM catalog_changes').get() as { n: number }).n, sequence);
    const from = migrationSnapshot(f.db, f.dataDir, sourceId);
    const to = migrationSnapshot(f.db, f.dataDir, targetId);
    const finalize: FinalizeMigrationRequest = { operationId: randomUUID(), source: { revision: from.work.revision, chapters: from.chapters.map(({ id, revision }) => ({ id, revision })) },
      target: { id: targetId, revision: to.work.revision }, mappings: [{ sourceChapterId: source.id, targetChapterId: entry.id, targetRevision: entry.revision, decision: 'copy-source' }],
      chapterDecisions: [{ sourceChapterPath: '/source/1', sourceChapterNumber: '1', targetChapterPath: '/target/1', targetChapterNumber: '1001' }] };
    const completed = await f.app.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/finalize-migration', headers: f.headers, payload: finalize });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal((await f.app.inject({ url: '/api/v1/works/' + sourceId, headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId, headers: f.headers, payload: metadata('source') })).statusCode, 410);
    await f.upload('source', 'stale automatic reupload', false, 409);
    assert.equal(await f.body('target'), '<p>Synthetic image</p><img src="page.png">');
  } finally { await f.close(); }
});

test('a different target copy is replaced only after the exact target revision and explicit copy-source decision', async () => {
  const f = await fixture();
  try {
    const source = await f.upload('source', 'selected source');
    const target = await f.upload('target', 'previous target');
    assert.equal((await f.copy(f.request(source))).statusCode, 409);
    assert.equal(await f.body('target'), 'previous target');
    const request = f.request(source, target);
    const response = await f.copy(request);
    assert.equal(response.statusCode, 200, response.body);
    assert.notEqual(response.json().entry.revision, target.revision);
    assert.equal(await f.body('source'), 'selected source'); assert.equal(await f.body('target'), 'selected source');
    assert.deepEqual((await f.copy(request)).json(), response.json());
  } finally { await f.close(); }
});

for (const stale of ['source-work', 'source-chapter', 'target-work', 'target-chapter', 'target-title'] as const) test('copy rejects stale or contradictory metadata: ' + stale, async () => {
  const f = await fixture();
  try {
    const source = await f.upload('source', 'original source');
    const target = await f.upload('target', 'original target');
    const request = f.request(source, target);
    if (stale === 'source-work') request.source.revision = '0'.repeat(64);
    if (stale === 'source-chapter') request.source.chapter.revision = '0'.repeat(64);
    if (stale === 'target-work') request.target.revision = '0'.repeat(64);
    if (stale === 'target-chapter') request.target.expectedChapter!.revision = '0'.repeat(64);
    if (stale === 'target-title') request.target.chapter.name = 'Old title';
    const response = await f.copy(request);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(await f.body('source'), 'original source'); assert.equal(await f.body('target'), 'original target');
  } finally { await f.close(); }
});

test('copy failures after staging leave source and the previous target intact', async () => {
  const f = await fixture();
  try {
    const source = await f.upload('source', 'original source');
    const target = await f.upload('target', 'original target');
    let guards = 0;
    await assert.rejects(copyMigrationChapter(f.db, f.dataDir, sourceId, f.request(source, target), defaultLimits, () => {
      if (++guards === 2) throw problem(403, 'Synthetic revoked device');
    }), (error: unknown) => (error as { statusCode: number }).statusCode === 403);
    assert.equal(guards, 2);
    assert.equal(await f.body('source'), 'original source'); assert.equal(await f.body('target'), 'original target');
    assert.deepEqual(JSON.parse((f.db.prepare('SELECT entry FROM chapters WHERE id=?').get(target.id) as { entry: string }).entry), target);
    assert.deepEqual(await readdir(join(f.dataDir, 'staging')), []);
  } finally { await f.close(); }
});

test('the final copy publication verifies source and target while holding the SQLite writer lock', async () => {
  const f = await fixture();
  const other = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
  try {
    other.exec('PRAGMA busy_timeout=0');
    const source = await f.upload('source');
    let guards = 0;
    const result = await copyMigrationChapter(f.db, f.dataDir, sourceId, f.request(source), defaultLimits, () => {
      if (++guards === 2) assert.throws(() => other.exec('BEGIN IMMEDIATE'), /locked/);
    });
    assert.equal(guards, 2); assert.equal(result.entry.complete, true);
    assert.equal(await f.body('source'), 'synthetic body'); assert.equal(await f.body('target'), 'synthetic body');
  } finally { other.close(); await f.close(); }
});

test('source changes during asynchronous inspection block the copy before target publication', async () => {
  const f = await fixture();
  try {
    const source = await f.upload('source');
    const request = f.request(source);
    const pending = copyMigrationChapter(f.db, f.dataDir, sourceId, request, defaultLimits);
    writeFileSync(join(f.dataDir, 'contents/source/book/1/content.html'), 'changed source body');
    await assert.rejects(pending, (error: unknown) => [409, 410].includes((error as { statusCode: number }).statusCode));
    assert.equal(await f.body('source'), 'changed source body');
    assert.equal(migrationSnapshot(f.db, f.dataDir, targetId).chapters.length, 0);
  } finally { await f.close(); }
});

test('copy API requires a registered unblocked device and preserves existing payloads on denied requests', async () => {
  const f = await fixture();
  try {
    const source = await f.upload('source');
    const payload = f.request(source);
    const url = '/api/v1/works/' + sourceId + '/migration-copy';
    assert.equal((await f.app.inject({ method: 'POST', url, payload })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url, headers: await consoleHeaders(f.app, f.dataDir), payload })).statusCode, 403);
    f.db.exec('UPDATE devices SET blocked=1');
    assert.equal((await f.copy(payload)).statusCode, 403);
    assert.equal(await f.body('source'), 'synthetic body');
    assert.equal(migrationSnapshot(f.db, f.dataDir, targetId).chapters.length, 0);
  } finally { await f.close(); }
});
