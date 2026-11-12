import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { defaultLimits, digest, type CatalogEntry, type PackageManifest } from '../src/packages.ts';
import { finalizeMigration, migrationSnapshot, type FinalizeMigrationRequest, type MigrationInventory } from '../src/work-migrations.ts';
import { saveWork } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const metadata = (pluginId: string) => ({
  schemaVersion: 1, identity: { pluginId, novelId: 'book', novelPath: '/book' },
  novel: { name: 'Synthetic migration fixture', author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
  cover: null, chapters: {},
});
const workId = (side: string) => digest(JSON.stringify([side, '/book']));
const sourceId = workId('source');
const targetId = workId('target');
async function archive(files: Record<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, bytes] of Object.entries(files)) zip.addBuffer(bytes, name, { compress: false });
  zip.end(); const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/work-migration-'));
  const db = openDatabase(dataDir);
  saveWork(db, dataDir, metadata('source')); saveWork(db, dataDir, metadata('target'));
  const app = await buildApp({ dataDir, anonymousRead: true });
  const headers = await deviceHeaders(app);
  const upload = async (side: string, index = 1, body = 'synthetic body', assets?: Record<string, Buffer>, path?: string) => {
    const files: Record<string, Buffer> = { 'content.html': Buffer.from(body) };
    if (assets) {
      files['manifest.json'] = Buffer.from(JSON.stringify({ version: 1, complete: true, updatedAt: 1,
        media: { files: Object.entries(assets).map(([fileName, bytes]) => ({ fileName, sourceUrl: 'https://fixture.invalid/' + fileName,
          path: 'media/' + fileName, status: 'stored', bytes: bytes.length, updatedAt: 1 })) } }));
      files['media.zip'] = await archive(assets);
    }
    const manifest: PackageManifest = { packageVersion: 1, layout: 'chapter-files',
      identity: { ...metadata(side).identity, chapterPath: path ?? '/' + side + '/' + index },
      novel: { name: metadata(side).novel.name, isLocal: false },
      chapter: { name: 'Episode ' + index, position: index, chapterNumber: String(side === 'target' ? index + 1000 : index), contentType: 'html', page: '1' },
      bodyPath: 'content.html', files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, size: bytes.length, modifiedAt: 1 })) };
    const form = new FormData(); form.append('metadata', JSON.stringify(manifest));
    for (const [name, bytes] of Object.entries(files)) form.append(name, new Blob([new Uint8Array(bytes)]), name);
    const request = new Request('http://fixture', { method: 'POST', body: form });
    const response = await app.inject({ method: 'POST', url: '/api/v1/chapter-files?conflictPolicy=replace-server',
      headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<CatalogEntry>();
  };
  const request = (): FinalizeMigrationRequest => {
    const source = migrationSnapshot(db, dataDir, sourceId);
    const target = migrationSnapshot(db, dataDir, targetId);
    return { operationId: randomUUID(), source: { revision: source.work.revision, chapters: source.chapters.map(({ id, revision }) => ({ id, revision })) },
      target: { id: target.work.id, revision: target.work.revision },
      mappings: source.chapters.map(chapter => {
        const matching = target.chapters.find(value => value.position === chapter.position)!;
        return { sourceChapterId: chapter.id, targetChapterId: matching.id, targetRevision: matching.revision, decision: 'copy-source' };
      }) };
  };
  const submit = (payload: FinalizeMigrationRequest) => app.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/finalize-migration', headers, payload });
  const inventory = async (entry: CatalogEntry): Promise<MigrationInventory> => {
    const result = await app.inject('/api/v1/chapters/' + entry.id + '/storage-inventory?revision=' + entry.revision);
    assert.equal(result.statusCode, 200, result.body); return result.json().inventory;
  };
  return { db, app, dataDir, headers, upload, request, submit, inventory,
    sourceBody: () => readFile(join(dataDir, 'contents/source/book/1/content.html'), 'utf8'),
    close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('finalizes body-only folder aliases, persists the receipt, and rejects reuse or restored-source retries', async () => {
  const f = await fixture();
  try {
    await f.upload('source', 1, 'synthetic body', undefined, 'norea-folder:1');
    const target = await f.upload('target');
    const snapshot = await f.app.inject('/api/v1/works/' + sourceId + '/migration-snapshot');
    assert.equal(snapshot.statusCode, 200);
    assert.match(snapshot.json().work.revision, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.json().chapters[0].chapterPath, 'norea-folder:1');
    assert.equal((await f.app.inject('/api/v1/capabilities')).json().workMigrationVersion, 1);
    const payload = f.request();
    const result = await f.submit(payload);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().deletedWork.id, sourceId);
    assert.equal(result.json().deletedWork.deleted, true);
    assert.equal((await f.app.inject('/api/v1/works/' + sourceId)).statusCode, 404);
    assert.equal((await f.app.inject('/api/v1/works/' + targetId)).statusCode, 200);
    assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'synthetic body');
    assert.equal((f.db.prepare('SELECT deleted FROM work_tombstones WHERE work_id=?').get(sourceId) as { deleted: number }).deleted, 1);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapter_tombstones').get() as { n: number }).n, 1);
    const replay = await f.submit(payload);
    assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), result.json());
    const mismatch = structuredClone(payload); mismatch.mappings[0].targetRevision = '0'.repeat(64);
    assert.equal((await f.submit(mismatch)).statusCode, 409);
    assert.equal((await f.submit({ ...payload, operationId: randomUUID() })).statusCode, 409);
    await f.app.close();
    const restarted = await buildApp({ dataDir: f.dataDir });
    try {
      const retry = await restarted.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/finalize-migration', headers: f.headers, payload });
      assert.equal(retry.statusCode, 200); assert.deepEqual(retry.json(), result.json());
      assert.equal((await restarted.inject('/api/v1/chapters/' + target.id + '/storage-inventory?revision=' + target.revision)).statusCode, 200);
      const restored = await restarted.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true&restoreMigrationOperationId=' + payload.operationId, headers: f.headers, payload: metadata('source') });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal((await restarted.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/finalize-migration', headers: f.headers, payload })).statusCode, 409);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('copy-source verifies actual body and media bytes without rewriting the target', async () => {
  const f = await fixture();
  try {
    const assets = { 'a.png': Buffer.from('first synthetic image'), 'b.png': Buffer.from('second synthetic image') };
    await f.upload('source', 1, '<img src="a.png"><img src="b.png">', assets);
    const target = await f.upload('target', 1, '<img src="a.png"><img src="b.png">', assets);
    const before = await f.inventory(target);
    const response = await f.submit(f.request());
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await f.inventory(target), before);
  } finally { await f.close(); }
});

test('keep-target accepts a different selected complete copy but requires its exact captured inventory', async () => {
  const f = await fixture();
  try {
    await f.upload('source', 1, 'old body', { 'old.png': Buffer.from('old image') });
    const target = await f.upload('target', 1, 'new body', { 'new.png': Buffer.from('new image') });
    const payload = f.request();
    payload.mappings[0].decision = 'keep-target';
    assert.equal((await f.submit(payload)).statusCode, 409);
    payload.mappings[0].expectedTargetInventory = await f.inventory(target);
    const wrong = structuredClone(payload); wrong.mappings[0].expectedTargetInventory!.body!.sha256 = '0'.repeat(64);
    assert.equal((await f.submit(wrong)).statusCode, 409);
    assert.equal(await f.sourceBody(), 'old body');
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'new body');
  } finally { await f.close(); }
});

for (const mismatch of ['body', 'asset', 'missing-asset', 'unavailable-target', 'unknown-source-file'] as const) test('retains source on failed preservation: ' + mismatch, async () => {
  const f = await fixture();
  try {
    const assets = { 'a.png': Buffer.from('right') };
    await f.upload('source', 1, 'same body', assets);
    await f.upload('target', 1, mismatch === 'body' ? 'different' : 'same body',
      mismatch === 'asset' ? { 'a.png': Buffer.from('wrong') } : mismatch === 'missing-asset' ? {} : assets);
    const payload = f.request();
    if (mismatch === 'unavailable-target') await unlink(join(f.dataDir, 'contents/target/book/1001/media.zip'));
    if (mismatch === 'unknown-source-file') await writeFile(join(f.dataDir, 'contents/source/book/unindexed.bin'), 'preserve me');
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(await f.sourceBody(), 'same body');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_tombstones').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

for (const mismatch of ['missing-mapping', 'duplicate-target', 'source-only-new-chapter', 'source-revision', 'target-revision', 'work-revision'] as const) test('rejects stale or ambiguous migration: ' + mismatch, async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    if (mismatch === 'duplicate-target') { await f.upload('source', 2); await f.upload('target', 2); }
    const payload = f.request();
    if (mismatch === 'missing-mapping') payload.mappings = [];
    if (mismatch === 'duplicate-target') payload.mappings[1] = { ...payload.mappings[0], sourceChapterId: payload.mappings[1].sourceChapterId };
    if (mismatch === 'source-only-new-chapter') await f.upload('source', 2);
    if (mismatch === 'source-revision') await f.upload('source', 1, 'replacement');
    if (mismatch === 'target-revision') await f.upload('target', 1, 'replacement');
    if (mismatch === 'work-revision') saveWork(f.db, f.dataDir, { ...metadata('source'), novel: { ...metadata('source').novel, name: 'Changed title' } });
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await f.app.inject('/api/v1/works/' + sourceId)).statusCode, 200);
  } finally { await f.close(); }
});

test('snapshot includes unavailable and unmapped server chapters instead of silently filtering them', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('source', 2);
    await unlink(join(f.dataDir, 'contents/source/book/2/content.html'));
    const response = await f.app.inject('/api/v1/works/' + sourceId + '/migration-snapshot');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().chapters.length, 2);
    assert.equal(response.json().chapters.filter((row: { available: boolean }) => !row.available).length, 1);
  } finally { await f.close(); }
});

test('covers an exact regular safeBackup metadata copy without changing the persisted migration request', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const root = join(f.dataDir, 'contents/source/book');
    await writeFile(join(root, 'novel-tinywind-SER-safeBackup-0001.json'), await readFile(join(root, 'novel.json')));
    const payload = f.request();
    const before = structuredClone(payload);
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(payload, before);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 1);
    assert.deepEqual(await readdir(join(f.dataDir, 'contents/source')), []);
    assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'synthetic body');
  } finally { await f.close(); }
});

for (const mismatch of ['different-bytes', 'other-name', 'symlink', 'orphan-chapter'] as const) test('retains source on unproven metadata coverage: ' + mismatch, async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const root = join(f.dataDir, 'contents/source/book');
    const bytes = await readFile(join(root, 'novel.json'));
    const name = mismatch === 'other-name' ? 'novel-copy.json' : 'novel-tinywind-SER-safeBackup-0001.json';
    if (mismatch === 'orphan-chapter') await mkdir(join(root, '47'));
    else if (mismatch === 'symlink') await symlink('novel.json', join(root, name));
    else await writeFile(join(root, name), mismatch === 'different-bytes' ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes);
    const response = await f.submit(f.request());
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(await f.sourceBody(), 'synthetic body');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_tombstones').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

for (const name of ['novel.json', 'novel-tinywind-SER-safeBackup-0001.json']) test('keeps the compared metadata file fenced through commit: ' + name, async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const root = join(f.dataDir, 'contents/source/book');
    const bytes = await readFile(join(root, 'novel.json'));
    await writeFile(join(root, 'novel-tinywind-SER-safeBackup-0001.json'), bytes);
    const pending = finalizeMigration(f.db, f.dataDir, sourceId, f.request(), defaultLimits);
    const changed = Buffer.concat([bytes, Buffer.from(' ')]);
    writeFileSync(join(root, name), changed);
    await assert.rejects(pending, (error: { statusCode?: number; message?: string }) =>
      error.statusCode === 409 && !!error.message?.includes('files changed during verification'));
    assert.deepEqual(await readFile(join(root, name)), changed);
    assert.equal(await f.sourceBody(), 'synthetic body');
    assert.deepEqual(await readdir(join(f.dataDir, 'contents/source')), ['book']);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_tombstones').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('guards an earlier verified chapter and the full source set until the final synchronous commit', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const payload = f.request();
    const pending = finalizeMigration(f.db, f.dataDir, sourceId, payload, defaultLimits);
    const row = f.db.prepare('SELECT entry FROM chapters WHERE id=?').get(payload.source.chapters[0].id) as { entry: string };
    const entry = JSON.parse(row.entry); entry.revision = 'a'.repeat(64);
    f.db.prepare('UPDATE chapters SET entry=? WHERE id=?').run(JSON.stringify(entry), entry.id);
    await assert.rejects(pending, (error: { statusCode?: number }) => error.statusCode === 409);
    assert.equal(await f.sourceBody(), 'synthetic body');
  } finally { await f.close(); }
});

test('rolls back folder retirement and tombstones when recording the durable receipt fails', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    f.db.exec("CREATE TRIGGER fail_migration_receipt BEFORE INSERT ON work_migrations BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    const response = await f.submit(f.request());
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(await f.sourceBody(), 'synthetic body');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_tombstones').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM chapter_tombstones').get() as { n: number }).n, 0);
    assert.deepEqual(await readdir(join(f.dataDir, 'contents/source')), ['book']);
  } finally { await f.close(); }
});

test('only a registered unblocked device can finalize; anonymous snapshots follow normal read policy', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const payload = f.request();
    const url = '/api/v1/works/' + sourceId + '/finalize-migration';
    assert.equal((await f.app.inject({ method: 'POST', url, payload })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url, payload, headers: await consoleHeaders(f.app, f.dataDir) })).statusCode, 403);
    f.db.prepare('UPDATE devices SET blocked=1').run();
    assert.equal((await f.submit(payload)).statusCode, 403);
    assert.equal(await f.sourceBody(), 'synthetic body');
  } finally { await f.close(); }
});

test('adding migration receipts preserves the original schema and existing stored data on reopen', async () => {
  const f = await fixture();
  try {
    await f.upload('source');
    const checksum = f.db.prepare('SELECT checksum FROM schema_state').get();
    const before = f.db.prepare('SELECT entry FROM works ORDER BY id').all();
    f.db.exec('DROP TABLE work_migrations');
    const reopened = openDatabase(f.dataDir);
    try {
      assert.deepEqual(reopened.prepare('SELECT checksum FROM schema_state').get(), checksum);
      assert.deepEqual(reopened.prepare('SELECT entry FROM works ORDER BY id').all(), before);
      assert.equal((reopened.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 0);
      assert.equal(await f.sourceBody(), 'synthetic body');
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('simultaneous exact retries resolve to the same committed receipt', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const payload = f.request();
    const [first, second] = await Promise.all([f.submit(payload), f.submit(payload)]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(first.json(), second.json());
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test('retains source if device authorization is withdrawn before the commit', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    await assert.rejects(finalizeMigration(f.db, f.dataDir, sourceId, f.request(), defaultLimits,
      () => { throw Object.assign(new Error('Device blocked'), { statusCode: 403 }); }),
    (error: { statusCode?: number }) => error.statusCode === 403);
    assert.equal(await f.sourceBody(), 'synthetic body');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('private server snapshots require authentication and never return payload bytes', async () => {
  const f = await fixture();
  try {
    await f.upload('source');
    await f.app.close();
    const privateApp = await buildApp({ dataDir: f.dataDir, anonymousRead: false });
    try {
      const url = '/api/v1/works/' + sourceId + '/migration-snapshot';
      assert.equal((await privateApp.inject(url)).statusCode, 401);
      const response = await privateApp.inject({ url, headers: f.headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body.includes('synthetic body'), false);
      assert.equal(response.headers['cache-control'], 'no-store');
    } finally { await privateApp.close(); }
  } finally { await f.close(); }
});

test('final integrity guards hold the SQLite write lock used by deletion and the receipt', async () => {
  const f = await fixture();
  const contender = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
  contender.exec('PRAGMA busy_timeout=0');
  try {
    await f.upload('source'); await f.upload('target');
    let guarded = false;
    const result = await finalizeMigration(f.db, f.dataDir, sourceId, f.request(), defaultLimits, () => {
      let acquired = false;
      try { contender.exec('BEGIN IMMEDIATE'); acquired = true; }
      catch (error) { assert.match(String(error), /locked/); }
      finally { if (acquired) contender.exec('ROLLBACK'); }
      assert.equal(acquired, false, 'Another connection must not write between verification and deletion');
      guarded = true;
    });
    assert.equal(guarded, true);
    assert.equal(result.deletedWork.deleted, true);
  } finally { contender.close(); await f.close(); }
});

for (const decision of ['copy-source', 'keep-target'] as const) test('body-only media cannot authorize source deletion with ' + decision, async () => {
  const f = await fixture();
  try {
    const body = '<p>Body.</p><img src="https://fixture.invalid/missing.png">';
    await f.upload('source', 1, decision === 'copy-source' ? body : 'old source body');
    const target = await f.upload('target', 1, body);
    const payload = f.request(); payload.mappings[0].decision = decision;
    if (decision === 'keep-target') payload.mappings[0].expectedTargetInventory = await f.inventory(target);
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().message, /body-only target/);
    assert.equal(await f.sourceBody(), decision === 'copy-source' ? body : 'old source body');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('body-only kept target accepts verified text markup with null declarations', async () => {
  const f = await fixture();
  try {
    await f.upload('source', 1, 'old source body');
    const body = '<p style="color:#333">New synthetic paragraph.</p><p>Another paragraph.</p>';
    const target = await f.upload('target', 1, body);
    const payload = f.request(); payload.mappings[0].decision = 'keep-target';
    payload.mappings[0].expectedTargetInventory = await f.inventory(target);
    assert.equal(payload.mappings[0].expectedTargetInventory.expectedAssetKeys, null);
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), body);
  } finally { await f.close(); }
});


function allDecisions(f: Awaited<ReturnType<typeof fixture>>, request: FinalizeMigrationRequest): NonNullable<FinalizeMigrationRequest['chapterDecisions']> {
  const source = migrationSnapshot(f.db, f.dataDir, sourceId);
  const target = migrationSnapshot(f.db, f.dataDir, targetId);
  return request.mappings.map(mapping => {
    const from = source.chapters.find(chapter => chapter.id === mapping.sourceChapterId)!;
    const to = mapping.decision === 'delete-source' ? undefined : target.chapters.find(chapter => chapter.id === mapping.targetChapterId)!;
    return { sourceChapterPath: from.chapterPath, sourceChapterNumber: from.chapterNumber, targetChapterPath: to?.chapterPath ?? null, targetChapterNumber: to?.chapterNumber ?? null };
  });
}

test('lineage preserves full captured metadata, explicit chapter decisions and verified inventories after source retirement', async () => {
  const f = await fixture();
  try {
    saveWork(f.db, f.dataDir, { ...metadata('source'), novel: { ...metadata('source').novel, author: 'Old source author' }, chapters: { '1': 'Episode 1', '2': 'Unread metadata-only episode' } });
    saveWork(f.db, f.dataDir, { ...metadata('target'), novel: { ...metadata('target').novel, author: 'Fresh target author' }, chapters: { '1001': 'Episode 1' } });
    await f.upload('source'); const target = await f.upload('target');
    const payload = f.request();
    payload.chapterDecisions = [...allDecisions(f, payload),
      { sourceChapterPath: '/source/2', sourceChapterNumber: '2', targetChapterPath: null, targetChapterNumber: null },
      { sourceChapterPath: '/local-only/99', sourceChapterNumber: '99', targetChapterPath: null, targetChapterNumber: null }];
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 200, response.body);
    const feed = await f.app.inject('/api/v1/work-migrations');
    assert.equal(feed.statusCode, 200, feed.body);
    assert.equal(feed.headers['cache-control'], 'no-store');
    const page = feed.json();
    assert.equal(page.items.length, 1); assert.equal(page.hasMore, false);
    const entry = page.items[0];
    assert.equal(entry.sequence, page.cursor); assert.equal(entry.operationId, payload.operationId); assert.equal(entry.active, true);
    assert.equal(entry.sourceWork.id, sourceId); assert.equal(entry.sourceWork.metadata.novel.author, 'Old source author');
    assert.equal(entry.targetWork.id, targetId); assert.equal(entry.targetWork.metadata.novel.author, 'Fresh target author');
    assert.deepEqual(entry.targetWork.metadata.chapters, { '1001': 'Episode 1' });
    assert.deepEqual(entry.deletedSource, { revision: payload.source.revision, sequence: response.json().deletedWork.sequence });
    assert.equal(entry.fullDecisionCoverage, true);
    assert.equal(entry.chapterDecisions.length, 3);
    assert.equal(entry.chapterDecisions[1].sourceMetadataVerified, true);
    assert.equal(entry.chapterDecisions[2].sourceMetadataVerified, false);
    assert.deepEqual(entry.mappings[0].targetInventory, await f.inventory(target));
    assert.equal(entry.mappings[0].source.chapterPath, '/source/1');
    assert.equal(entry.mappings[0].target.chapterNumber, '1001');
    assert.equal(JSON.stringify(entry).includes('synthetic body'), false);
    assert.deepEqual((await f.app.inject('/api/v1/work-migrations/' + payload.operationId)).json(), entry);
    assert.deepEqual((await f.app.inject('/api/v1/works/' + targetId + '/migration-history')).json().items, [entry]);
    assert.deepEqual((await f.app.inject('/api/v1/works/' + sourceId + '/migration-history')).json().items, [entry]);
    assert.deepEqual((await f.app.inject('/api/v1/work-migrations?after=' + page.cursor)).json(), { items: [], cursor: page.cursor, hasMore: false });
    assert.equal((await f.app.inject('/api/v1/work-migrations?after=' + (page.cursor + 1))).statusCode, 409);
    assert.equal((await f.app.inject('/api/v1/work-migrations/' + randomUUID())).statusCode, 404);
  } finally { await f.close(); }
});

test('explicit delete-source works for an unavailable selected source and does not fabricate a target package', async () => {
  const f = await fixture();
  try {
    saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: { '1': 'Episode 1' } });
    const source = await f.upload('source');
    await unlink(join(f.dataDir, 'contents/source/book/1/content.html'));
    const from = migrationSnapshot(f.db, f.dataDir, sourceId);
    const to = migrationSnapshot(f.db, f.dataDir, targetId);
    const payload: FinalizeMigrationRequest = { operationId: randomUUID(), source: { revision: from.work.revision, chapters: [{ id: source.id, revision: source.revision }] }, target: { id: targetId, revision: to.work.revision },
      mappings: [{ sourceChapterId: source.id, decision: 'delete-source' }],
      chapterDecisions: [{ sourceChapterPath: '/source/1', sourceChapterNumber: '1', targetChapterPath: null, targetChapterNumber: null }] };
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 200, response.body);
    const entry = (await f.app.inject('/api/v1/work-migrations/' + payload.operationId)).json();
    assert.deepEqual(entry.mappings[0], { source: { ...from.chapters[0], available: false }, decision: 'delete-source', target: null, targetInventory: null });
    assert.equal((await f.app.inject('/api/v1/works/' + sourceId)).statusCode, 404);
    assert.equal(migrationSnapshot(f.db, f.dataDir, targetId).chapters.length, 0);
  } finally { await f.close(); }
});

for (const invalid of ['missing-metadata-decision', 'delete-without-decision', 'contradictory-delete', 'contradictory-copy', 'wrong-source-number', 'wrong-target-number'] as const) test('retains original data when full decisions are invalid: ' + invalid, async () => {
  const f = await fixture();
  try {
    saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: { '1': 'Episode 1', '2': 'Metadata only' } });
    saveWork(f.db, f.dataDir, { ...metadata('target'), chapters: { '1001': 'Episode 1' } });
    await f.upload('source'); await f.upload('target');
    const payload = f.request();
    payload.chapterDecisions = [...allDecisions(f, payload), { sourceChapterPath: '/source/2', sourceChapterNumber: '2', targetChapterPath: null, targetChapterNumber: null }];
    if (invalid === 'missing-metadata-decision') payload.chapterDecisions.pop();
    if (invalid === 'delete-without-decision') { payload.mappings[0] = { sourceChapterId: payload.mappings[0].sourceChapterId, decision: 'delete-source' }; delete payload.chapterDecisions; }
    if (invalid === 'contradictory-delete') payload.mappings[0] = { sourceChapterId: payload.mappings[0].sourceChapterId, decision: 'delete-source' };
    if (invalid === 'contradictory-copy') { payload.chapterDecisions![0].targetChapterPath = null; payload.chapterDecisions![0].targetChapterNumber = null; }
    if (invalid === 'wrong-source-number') payload.chapterDecisions![0].sourceChapterNumber = '50';
    if (invalid === 'wrong-target-number') payload.chapterDecisions![0].targetChapterNumber = '50';
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(await f.sourceBody(), 'synthetic body');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migration_lineage').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migration_events').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('legacy payload-only finalization is explicitly marked as incomplete decision coverage', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const payload = f.request(); assert.equal((await f.submit(payload)).statusCode, 200);
    const entry = (await f.app.inject('/api/v1/work-migrations/' + payload.operationId)).json();
    assert.equal(entry.fullDecisionCoverage, false);
    assert.deepEqual(entry.chapterDecisions, []);
  } finally { await f.close(); }
});

test('explicit source restoration appends revocation and coalesces historical active events for new devices', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const payload = f.request(); payload.chapterDecisions = allDecisions(f, payload);
    assert.equal((await f.submit(payload)).statusCode, 200);
    const before = (await f.app.inject('/api/v1/work-migrations')).json();
    const ordinary = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId, headers: f.headers, payload: metadata('source') });
    assert.equal(ordinary.statusCode, 410);
    assert.equal((await f.app.inject('/api/v1/work-migrations/' + payload.operationId)).json().active, true);
    f.db.exec("CREATE TRIGGER fail_revocation BEFORE INSERT ON work_migration_events WHEN NEW.active=0 BEGIN SELECT RAISE(ABORT,'synthetic revocation failure'); END");
    const failedRestore = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true&restoreMigrationOperationId=' + payload.operationId, headers: f.headers, payload: metadata('source') });
    assert.equal(failedRestore.statusCode, 500);
    assert.equal((await f.app.inject('/api/v1/works/' + sourceId)).statusCode, 404);
    assert.equal((await f.app.inject('/api/v1/work-migrations/' + payload.operationId)).json().active, true);
    f.db.exec('DROP TRIGGER fail_revocation');
    const restored = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true&restoreMigrationOperationId=' + payload.operationId, headers: f.headers, payload: metadata('source') });
    assert.equal(restored.statusCode, 200, restored.body);
    const revoked = (await f.app.inject('/api/v1/work-migrations?after=' + before.cursor)).json();
    assert.equal(revoked.items.length, 1); assert.ok(revoked.cursor > before.cursor);
    assert.equal(revoked.items[0].active, false); assert.equal(revoked.items[0].operationId, payload.operationId);
    assert.deepEqual(revoked.items[0].chapterDecisions, before.items[0].chapterDecisions);
    assert.deepEqual((await f.app.inject('/api/v1/work-migrations')).json().items, revoked.items);
    assert.deepEqual((await f.app.inject('/api/v1/work-migrations/' + payload.operationId)).json(), revoked.items[0]);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migration_events').get() as { n: number }).n, 2);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migration_lineage').get() as { n: number }).n, 1);
    assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'synthetic body');
  } finally { await f.close(); }
});

test('lineage failure rolls back source retirement, chapter tombstones and receipt atomically', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const payload = f.request(); payload.chapterDecisions = allDecisions(f, payload);
    f.db.exec("CREATE TRIGGER fail_lineage_event BEFORE INSERT ON work_migration_events BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END");
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(await f.sourceBody(), 'synthetic body');
    for (const table of ['work_migrations', 'work_migration_lineage', 'work_migration_events', 'work_tombstones', 'chapter_tombstones']) assert.equal((f.db.prepare('SELECT count(*) AS n FROM ' + table).get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('lineage retains an entire A to B to C chain after intermediate target deletion and restart', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const first = f.request(); first.chapterDecisions = allDecisions(f, first);
    assert.equal((await f.submit(first)).statusCode, 200);
    saveWork(f.db, f.dataDir, metadata('third'));
    const third = await f.upload('third');
    const middle = migrationSnapshot(f.db, f.dataDir, targetId);
    const last = migrationSnapshot(f.db, f.dataDir, workId('third'));
    const second: FinalizeMigrationRequest = { operationId: randomUUID(), source: { revision: middle.work.revision, chapters: middle.chapters.map(({ id, revision }) => ({ id, revision })) },
      target: { id: last.work.id, revision: last.work.revision }, mappings: [{ sourceChapterId: middle.chapters[0].id, targetChapterId: third.id, targetRevision: third.revision, decision: 'copy-source' }],
      chapterDecisions: [{ sourceChapterPath: middle.chapters[0].chapterPath, sourceChapterNumber: middle.chapters[0].chapterNumber, targetChapterPath: third.manifest.identity.chapterPath, targetChapterNumber: third.manifest.chapter.chapterNumber! }] };
    const response = await f.app.inject({ method: 'POST', url: '/api/v1/works/' + targetId + '/finalize-migration', headers: f.headers, payload: second });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await f.app.inject('/api/v1/works/' + targetId)).statusCode, 404);
    await f.app.close();
    const restarted = await buildApp({ dataDir: f.dataDir, anonymousRead: false });
    try {
      assert.equal((await restarted.inject('/api/v1/work-migrations')).statusCode, 401);
      assert.equal((await restarted.inject('/api/v1/work-migrations/' + first.operationId)).statusCode, 401);
      const firstPage = await restarted.inject({ url: '/api/v1/works/' + workId('third') + '/migration-history?limit=1', headers: f.headers });
      assert.equal(firstPage.statusCode, 200);
      assert.equal(firstPage.json().hasMore, true);
      const next = await restarted.inject({ url: '/api/v1/works/' + workId('third') + '/migration-history?after=' + firstPage.json().cursor + '&limit=1', headers: f.headers });
      assert.deepEqual([firstPage.json().items[0].operationId, next.json().items[0].operationId], [first.operationId, second.operationId]);
      assert.equal(firstPage.json().items[0].active, true); assert.equal(next.json().items[0].active, true);
      assert.equal(firstPage.json().items[0].targetWork.metadata.identity.pluginId, 'target');
      assert.equal(next.json().items[0].targetWork.metadata.identity.pluginId, 'third');
      assert.equal((await restarted.inject({ url: '/api/v1/works/' + sourceId + '/migration-history', headers: f.headers })).json().items.length, 2);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('additive lineage tables preserve original schema, credentials, data and older receipts without inventing history', async () => {
  const f = await fixture();
  try {
    await f.upload('source'); await f.upload('target');
    const payload = f.request(); assert.equal((await f.submit(payload)).statusCode, 200);
    const checksum = f.db.prepare('SELECT checksum FROM schema_state').get();
    const schemaVersion = f.db.prepare('PRAGMA user_version').get();
    const works = f.db.prepare('SELECT * FROM works ORDER BY id').all();
    const receipts = f.db.prepare('SELECT * FROM work_migrations').all();
    const devices = f.db.prepare('SELECT id,key_hash,device_name,blocked FROM devices').all();
    f.db.exec('DROP TABLE work_migration_events; DROP TABLE work_migration_lineage');
    const reopened = openDatabase(f.dataDir);
    try {
      assert.deepEqual(reopened.prepare('SELECT checksum FROM schema_state').get(), checksum);
      assert.deepEqual(reopened.prepare('PRAGMA user_version').get(), schemaVersion);
      assert.deepEqual(reopened.prepare('SELECT * FROM works ORDER BY id').all(), works);
      assert.deepEqual(reopened.prepare('SELECT * FROM work_migrations').all(), receipts);
      assert.deepEqual(reopened.prepare('SELECT id,key_hash,device_name,blocked FROM devices').all(), devices);
      assert.equal((reopened.prepare('SELECT count(*) AS n FROM work_migration_lineage').get() as { n: number }).n, 0);
      assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'synthetic body');
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('all regular source cover formats are fenced while the fresh target metadata remains authoritative', async () => {
  const f = await fixture();
  try {
    const from = { ...metadata('source'), cover: { fileName: 'cover.jpg', contentType: 'image/jpeg' } };
    saveWork(f.db, f.dataDir, from);
    await writeFile(join(f.dataDir, 'contents/source/book/cover.jpg'), 'source selected cover');
    await writeFile(join(f.dataDir, 'contents/source/book/cover.png'), 'source older cover');
    await f.upload('source'); await f.upload('target');
    const payload = f.request(); payload.chapterDecisions = allDecisions(f, payload);
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 200, response.body);
    const target = (await f.app.inject('/api/v1/works/' + targetId)).json();
    assert.equal(target.hasCover, false); assert.equal(target.metadata.cover, null);
    const lineage = (await f.app.inject('/api/v1/work-migrations/' + payload.operationId)).json();
    assert.equal(lineage.sourceWork.coverSha256, digest(Buffer.from('source selected cover')));
    assert.equal(lineage.targetWork.coverSha256, null);
  } finally { await f.close(); }
});

for (const hasTargetBody of [false, true]) test('blocks unapproved delete-source when the server still stores the source body (B body: ' + hasTargetBody + ')', async () => {
  const f = await fixture();
  try {
    saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: { '1': 'A episode' } });
    saveWork(f.db, f.dataDir, { ...metadata('target'), chapters: { '1001': 'B episode' } });
    const original = await f.upload('source', 1, 'A original body');
    if (hasTargetBody) await f.upload('target', 1, 'B chosen body');
    const from = migrationSnapshot(f.db, f.dataDir, sourceId);
    const to = migrationSnapshot(f.db, f.dataDir, targetId);
    const payload: FinalizeMigrationRequest = {
      operationId: randomUUID(),
      source: { revision: from.work.revision, chapters: [{ id: original.id, revision: original.revision }] },
      target: { id: targetId, revision: to.work.revision },
      mappings: [{ sourceChapterId: original.id, decision: 'delete-source' }],
      chapterDecisions: [{ sourceChapterPath: '/source/1', sourceChapterNumber: '1', targetChapterPath: '/target/1',
        targetChapterNumber: '1001', discardSourceContent: true }],
    };
    const response = await f.submit(payload);
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.json().message, /stored source chapter content cannot be deleted/);
    assert.equal(await f.sourceBody(), 'A original body');
    assert.equal((await f.app.inject('/api/v1/works/' + sourceId)).statusCode, 200);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_migrations').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM work_tombstones').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('blocks delete-source when partial source files remain on disk and allows explicit user discard only with exact source inventory', async () => {
  const f = await fixture();
  try {
    saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: { '1': 'A episode' } });
    saveWork(f.db, f.dataDir, { ...metadata('target'), chapters: { '1001': 'B episode' } });
    const original = await f.upload('source', 1, 'A original body');
    const sourceInventory = await f.inventory(original);
    // Truncate content.html so availableChapter becomes false while partial bytes still remain on disk.
    await writeFile(join(f.dataDir, 'contents/source/book/1/content.html'), 'truncated');
    const partialFrom = migrationSnapshot(f.db, f.dataDir, sourceId);
    const partialTo = migrationSnapshot(f.db, f.dataDir, targetId);
    const partialPayload: FinalizeMigrationRequest = {
      operationId: randomUUID(),
      source: { revision: partialFrom.work.revision, chapters: [{ id: original.id, revision: original.revision }] },
      target: { id: targetId, revision: partialTo.work.revision },
      mappings: [{ sourceChapterId: original.id, decision: 'delete-source' }],
      chapterDecisions: [{ sourceChapterPath: '/source/1', sourceChapterNumber: '1', targetChapterPath: null, targetChapterNumber: null }],
    };
    const partialResult = await f.submit(partialPayload);
    assert.equal(partialResult.statusCode, 409, partialResult.body);
    assert.equal(await f.sourceBody(), 'truncated');

    // Restore exact original bytes and verify explicit inventory-bound user discard checks SHA-256.
    await writeFile(join(f.dataDir, 'contents/source/book/1/content.html'), 'A original body');
    const wrongInventory = structuredClone(sourceInventory);
    wrongInventory.body!.sha256 = '0'.repeat(64);
    const wrongPayload: FinalizeMigrationRequest = {
      operationId: randomUUID(),
      source: { revision: partialFrom.work.revision, chapters: [{ id: original.id, revision: original.revision }] },
      target: { id: targetId, revision: partialTo.work.revision },
      mappings: [{ sourceChapterId: original.id, decision: 'delete-source', explicitSourceDiscard: { approvedByUser: true, expectedSourceInventory: wrongInventory } }],
      chapterDecisions: [{ sourceChapterPath: '/source/1', sourceChapterNumber: '1', targetChapterPath: '/target/1', targetChapterNumber: '1001', discardSourceContent: true }],
    };
    assert.equal((await f.submit(wrongPayload)).statusCode, 409);
    assert.equal(await f.sourceBody(), 'A original body');

    const approvedPayload: FinalizeMigrationRequest = {
      ...wrongPayload,
      operationId: randomUUID(),
      mappings: [{ sourceChapterId: original.id, decision: 'delete-source', explicitSourceDiscard: { approvedByUser: true, expectedSourceInventory: sourceInventory } }],
    };
    const approvedResult = await f.submit(approvedPayload);
    assert.equal(approvedResult.statusCode, 200, approvedResult.body);
    const entry = (await f.app.inject('/api/v1/work-migrations/' + approvedPayload.operationId)).json();
    assert.deepEqual(entry.mappings[0].discardedSourceInventory, sourceInventory);
  } finally { await f.close(); }
});

test('protects existing migration patterns: 5 stored composed chapters (6579->6157) and pre-existing identical target bodies without duplication (57768->6439)', async () => {
  const f = await fixture();
  try {
    // Pattern 1: 6579 -> 6157 (5 stored chapters + 5 metadata-only chapters)
    const srcChapters: Record<string, string> = {};
    const dstChapters: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) {
      srcChapters[String(i)] = `Episode ${i}`;
      dstChapters[String(1000 + i)] = `Episode ${i}`;
    }
    saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: srcChapters });
    saveWork(f.db, f.dataDir, { ...metadata('target'), chapters: dstChapters });
    const uploadedSource: CatalogEntry[] = [];
    const uploadedTarget: CatalogEntry[] = [];
    for (let i = 1; i <= 5; i++) {
      uploadedSource.push(await f.upload('source', i, `Preserved body ${i}`, undefined, `norea-composed:src-${i}`));
      uploadedTarget.push(await f.upload('target', i, `Preserved body ${i}`, undefined, `norea-composed:dst-${i}`));
    }
    const from1 = migrationSnapshot(f.db, f.dataDir, sourceId);
    const to1 = migrationSnapshot(f.db, f.dataDir, targetId);
    const req1: FinalizeMigrationRequest = {
      operationId: randomUUID(),
      source: { revision: from1.work.revision, chapters: from1.chapters.map(({ id, revision }) => ({ id, revision })) },
      target: { id: targetId, revision: to1.work.revision },
      mappings: uploadedSource.map((src, idx) => ({
        sourceChapterId: src.id,
        targetChapterId: uploadedTarget[idx].id,
        targetRevision: uploadedTarget[idx].revision,
        decision: 'copy-source' as const,
      })),
      chapterDecisions: [
        ...uploadedSource.map((src, idx) => ({
          sourceChapterPath: src.manifest.identity.chapterPath,
          sourceChapterNumber: String(idx + 1),
          targetChapterPath: uploadedTarget[idx].manifest.identity.chapterPath,
          targetChapterNumber: String(1001 + idx),
        })),
        ...[6, 7, 8, 9, 10].map(i => ({
          sourceChapterPath: `/source/${i}`,
          sourceChapterNumber: String(i),
          targetChapterPath: `/target/${i}`,
          targetChapterNumber: String(1000 + i),
        })),
      ],
    };
    const res1 = await f.submit(req1);
    assert.equal(res1.statusCode, 200, res1.body);
    const afterTo1 = migrationSnapshot(f.db, f.dataDir, targetId);
    assert.equal(afterTo1.chapters.length, 5);
    for (let i = 1; i <= 5; i++) {
      assert.equal(await readFile(join(f.dataDir, `contents/target/book/${1000 + i}/content.html`), 'utf8'), `Preserved body ${i}`);
    }
  } finally { await f.close(); }

  // Pattern 2: 57768 -> 6439 (norea-folder source chapters mapped to native target paths that already hold identical bodies)
  const f2 = await fixture();
  try {
    const srcChapters: Record<string, string> = {};
    const dstChapters: Record<string, string> = {};
    for (let i = 1; i <= 6; i++) {
      srcChapters[String(i)] = `Episode ${i}`;
      dstChapters[String(1000 + i)] = `Shepherd Mage Episode ${i}`;
    }
    saveWork(f2.db, f2.dataDir, { ...metadata('source'), chapters: srcChapters });
    saveWork(f2.db, f2.dataDir, { ...metadata('target'), chapters: dstChapters });
    const srcEntries: CatalogEntry[] = [];
    const dstEntries: CatalogEntry[] = [];
    for (let i = 1; i <= 6; i++) {
      srcEntries.push(await f2.upload('source', i, `<p>Shared episode ${i}</p>`, undefined, `norea-folder:${i}`));
      dstEntries.push(await f2.upload('target', i, `<p>Shared episode ${i}</p>`, undefined, `/bookkor/ep-${i}`));
    }
    const from2 = migrationSnapshot(f2.db, f2.dataDir, sourceId);
    const to2 = migrationSnapshot(f2.db, f2.dataDir, targetId);
    const req2: FinalizeMigrationRequest = {
      operationId: randomUUID(),
      source: { revision: from2.work.revision, chapters: from2.chapters.map(({ id, revision }) => ({ id, revision })) },
      target: { id: targetId, revision: to2.work.revision },
      mappings: srcEntries.map((src, idx) => ({
        sourceChapterId: src.id,
        targetChapterId: dstEntries[idx].id,
        targetRevision: dstEntries[idx].revision,
        decision: 'copy-source' as const,
      })),
      chapterDecisions: srcEntries.map((src, idx) => ({
        sourceChapterPath: src.manifest.identity.chapterPath,
        sourceChapterNumber: String(idx + 1),
        targetChapterPath: dstEntries[idx].manifest.identity.chapterPath,
        targetChapterNumber: String(1001 + idx),
      })),
    };
    const res2 = await f2.submit(req2);
    assert.equal(res2.statusCode, 200, res2.body);
    assert.equal(migrationSnapshot(f2.db, f2.dataDir, targetId).chapters.length, 6);
  } finally { await f2.close(); }
});

async function legacyCompletedFixture(keepTarget = false, resurrected = true) {
  const f = await fixture();
  saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: { '1': 'Source episode' } });
  saveWork(f.db, f.dataDir, { ...metadata('target'), chapters: { '1001': 'Target episode' } });
  await f.upload('source'); const target = await f.upload('target', 1, keepTarget ? 'chosen target body' : 'synthetic body');
  const legacy = f.request();
  if (keepTarget) { legacy.mappings[0].decision = 'keep-target'; legacy.mappings[0].expectedTargetInventory = await f.inventory(target); }
  assert.equal((await f.submit(legacy)).statusCode, 200);
  // Reproduce the old server: only its immutable successful receipt existed.
  f.db.exec('DELETE FROM work_migration_events; DELETE FROM work_migration_lineage');
  if (resurrected) {
    f.db.prepare('UPDATE work_tombstones SET deleted=0 WHERE work_id=?').run(sourceId);
    for (const row of legacy.source.chapters) f.db.prepare('DELETE FROM chapter_tombstones WHERE chapter_id=?').run(row.id);
    saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: { '1': 'Source episode' } }); await f.upload('source');
  }
  const reconcile = (current: FinalizeMigrationRequest, exact = legacy, headers = f.headers, reviewedCurrentState?: true) => f.app.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/migration-reconcile', headers,
    payload: { legacyOperationId: legacy.operationId, legacyRequest: exact, current, ...(reviewedCurrentState ? { reviewedCurrentState } : {}) } });
  const current = () => { const request = f.request(); if (keepTarget) { request.mappings[0].decision = 'keep-target'; request.mappings[0].expectedTargetInventory = legacy.mappings[0].expectedTargetInventory; } request.chapterDecisions = allDecisions(f, request); return request; };
  return { ...f, legacy, reconcile, current };
}

test('reconciliation verifies a legacy receipt and fresh bodies, records exact binding and replays its own receipt', async () => {
  const f = await legacyCompletedFixture();
  try {
    const beforeLegacy = f.db.prepare('SELECT * FROM work_migrations WHERE operation_id=?').get(f.legacy.operationId);
    const current = f.current(); const response = await f.reconcile(current);
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().operationId, current.operationId);
    assert.deepEqual((await f.reconcile(current)).json(), response.json());
    assert.deepEqual(f.db.prepare('SELECT * FROM work_migrations WHERE operation_id=?').get(f.legacy.operationId), beforeLegacy);
    const lineage = (await f.app.inject('/api/v1/work-migrations/' + current.operationId)).json();
    assert.equal(lineage.legacyOperationId, f.legacy.operationId); assert.equal(lineage.fullDecisionCoverage, true);
    assert.equal(lineage.mappings[0].target.chapterNumber, '1001'); assert.equal(lineage.chapterDecisions[0].targetChapterNumber, '1001');
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true', headers: f.headers, payload: metadata('source') })).statusCode, 409);
    const restored = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true&restoreMigrationOperationId=' + current.operationId, headers: f.headers, payload: metadata('source') });
    assert.equal(restored.statusCode, 200, restored.body);
    const revoked = (await f.app.inject('/api/v1/work-migrations/' + current.operationId)).json(); assert.equal(revoked.active, false); assert.equal(revoked.legacyOperationId, f.legacy.operationId);
    assert.equal((await f.reconcile(current)).statusCode, 409); assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'synthetic body');
  } finally { await f.close(); }
});

for (const invalid of ['changed-proof', 'missing-full-decisions', 'new-source', 'changed-source-body', 'stale-target-number', 'different-decision'] as const) test('legacy reconciliation keeps source on ' + invalid, async () => {
  const f = await legacyCompletedFixture();
  try {
    if (invalid === 'new-source') { await f.upload('source', 2); await f.upload('target', 2); }
    if (invalid === 'changed-source-body') await f.upload('source', 1, 'new body must remain');
    const current = f.current(), exact = structuredClone(f.legacy);
    if (invalid === 'changed-proof') exact.source.revision = '0'.repeat(64);
    if (invalid === 'missing-full-decisions') delete current.chapterDecisions;
    if (invalid === 'stale-target-number') current.chapterDecisions![0].targetChapterNumber = '346378';
    if (invalid === 'different-decision') current.mappings[0] = { sourceChapterId: current.mappings[0].sourceChapterId, decision: 'delete-source' };
    const before = await f.sourceBody(); const response = await f.reconcile(current, exact);
    assert.equal(response.statusCode, 409, response.body); assert.equal(await f.sourceBody(), before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_migration_lineage').get()?.n, 0);
  } finally { await f.close(); }
});

test('a legacy keep-target decision preserves the selected copy but cannot discard a newly changed source', async () => {
  const f = await legacyCompletedFixture(true);
  try {
    await f.upload('source', 1, 'a newer source body');
    const response = await f.reconcile(f.current()); assert.equal(response.statusCode, 409, response.body);
    assert.equal(await f.sourceBody(), 'a newer source body');
  } finally { await f.close(); }
  const unchanged = await legacyCompletedFixture(true);
  try { const response = await unchanged.reconcile(unchanged.current()); assert.equal(response.statusCode, 200, response.body); assert.equal(await readFile(join(unchanged.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'chosen target body'); }
  finally { await unchanged.close(); }
});

test('legacy receipt-only retirement blocks automatic restore and remembers deliberate restoration without inventing lineage', async () => {
  const f = await legacyCompletedFixture(false, false);
  try {
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true', headers: f.headers, payload: metadata('source') })).statusCode, 409);
    const restored = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true&restoreMigrationOperationId=' + f.legacy.operationId, headers: f.headers, payload: metadata('source') });
    assert.equal(restored.statusCode, 200, restored.body);
    for (const chapter of f.legacy.source.chapters) f.db.prepare('DELETE FROM chapter_tombstones WHERE chapter_id=?').run(chapter.id);
    await f.upload('source');
    assert.equal((await f.reconcile(f.current())).statusCode, 409);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_migration_restorations').get()?.n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM work_migration_lineage').get()?.n, 0);
  } finally { await f.close(); }
});

test('active lineage projects old positive work and exact chapter state into its target without transplanting A composition', async () => {
  const f = await fixture();
  try {
    saveWork(f.db, f.dataDir, { ...metadata('source'), chapters: { '1': 'Source', '2': 'Excluded metadata-only chapter' } });
    saveWork(f.db, f.dataDir, { ...metadata('target'), chapters: { '1001': 'Target' } });
    await f.upload('source'); await f.upload('target');
    const scope = (await f.app.inject({ url: '/api/v1/user-state/current', headers: f.headers })).json();
    const work = (side: string) => ({ pluginId: side, sourceNovelId: 'book', novelPath: '/book', name: 'Shared fixture' });
    const sourceWork = work('source'), targetWork = work('target');
    const oldComposition = { version: 1, updatedAt: 100, entries: [{ id: 'old-source-entry', path: '/source/1', storageChapterNumber: '1', primarySource: 0,
      sources: [{ ...metadata('source').identity, chapterPath: '/source/1', sourceChapterId: 'source-stable', chapterNumber: '1', name: 'A title', position: 1, page: '1', contentType: 'text', releaseTime: null }],
      user: { included: true, order: 1, name: 'Old A user title', chapterNumber: '1' } }] };
    const oldItems = [
      { entity: { kind: 'library', work: sourceWork }, value: { inLibrary: true, addedAt: 1 } },
      { entity: { kind: 'reading', work: sourceWork, chapter: { chapterPath: '/source/1' } }, value: { progress: 90, unread: false, readAt: 10 } },
      { entity: { kind: 'bookmark', work: sourceWork, chapter: { chapterPath: '/source/1' } }, value: { bookmarked: true } },
      { entity: { kind: 'reading', work: sourceWork, chapter: { chapterPath: '/source/2' } }, value: { progress: 20, unread: false, readAt: 2 } },
      { entity: { kind: 'resume', work: sourceWork }, value: { chapter: { chapterPath: '/source/1' }, anchor: null, openedAt: 10 } },
      { entity: { kind: 'composition', work: sourceWork }, value: { composition: oldComposition } },
    ];
    const publish = (items: unknown[]) => f.app.inject({ method: 'POST', url: '/api/v1/user-state/current', headers: f.headers, payload: { ...scope, items } });
    assert.equal((await publish([...oldItems, { entity: { kind: 'reading', work: targetWork, chapter: { chapterPath: '/target/1' } }, value: { progress: 60, unread: false, readAt: 20 } }])).statusCode, 200);
    const migration = f.request(); migration.chapterDecisions = [...allDecisions(f, migration), { sourceChapterPath: '/source/2', sourceChapterNumber: '2', targetChapterPath: null, targetChapterNumber: null }];
    assert.equal((await f.submit(migration)).statusCode, 200);
    const view = (await f.app.inject({ url: '/api/v1/user-state/current', headers: f.headers })).json();
    assert.equal(view.items.length, 4); assert(view.items.every((row: any) => row.entity.work.pluginId === 'target'));
    assert.deepEqual(view.items.find((row: any) => row.entity.kind === 'reading').value, { progress: 60, unread: false, readAt: 20 });
    assert.equal(view.items.find((row: any) => row.entity.kind === 'resume').value.chapter.chapterPath, '/target/1');
    const replay = await publish(oldItems); assert.equal(replay.statusCode, 200, replay.body);
    assert(replay.json().items.every((row: any) => row.entity.work.pluginId === 'target')); assert.equal(replay.json().items.some((row: any) => row.entity.kind === 'composition'), false);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM user_state_current_records WHERE kind='library' AND json_extract(item,'$.entity.work.pluginId')='source'").get()?.n, 0);
    // Omitted old composition and unresolvable/excluded values are retained privately, never deleted or assigned to B.
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM user_state_current_records WHERE kind='composition' AND json_extract(item,'$.entity.work.pluginId')='source'").get()?.n, 1);
  } finally { await f.close(); }
});

test('an explicit newly reviewed decision can consolidate reindexed source IDs while automatic repair stays blocked', async () => {
  const f = await legacyCompletedFixture();
  try {
    f.db.prepare('DELETE FROM chapters WHERE id=?').run(f.legacy.source.chapters[0].id);
    await rm(join(f.dataDir, 'contents/source/book/1'), { recursive: true });
    await f.upload('source', 1, 'synthetic body', undefined, 'norea-folder:1');
    const current = f.current(); assert.notEqual(current.mappings[0].sourceChapterId, f.legacy.mappings[0].sourceChapterId);
    assert.equal((await f.reconcile(current)).statusCode, 409);
    const response = await f.reconcile(current, f.legacy, f.headers, true); assert.equal(response.statusCode, 200, response.body);
    const lineage = (await f.app.inject('/api/v1/work-migrations/' + current.operationId)).json();
    assert.equal(lineage.legacyOperationId, f.legacy.operationId); assert.equal(lineage.mappings[0].source.chapterPath, 'norea-folder:1');
    assert.equal(await readFile(join(f.dataDir, 'contents/target/book/1001/content.html'), 'utf8'), 'synthetic body');
  } finally { await f.close(); }
});

test('reviewed current decisions require the fresh target inventory and still respect durable restoration revocation', async () => {
  const f = await legacyCompletedFixture(true);
  try {
    await f.upload('source', 1, 'a newer explicitly reviewed source');
    const current = f.current(), corrupt = structuredClone(current); corrupt.mappings[0].expectedTargetInventory!.body!.sha256 = '0'.repeat(64);
    assert.equal((await f.reconcile(corrupt, f.legacy, f.headers, true)).statusCode, 409); assert.equal(await f.sourceBody(), 'a newer explicitly reviewed source');
    assert.equal((await f.reconcile(current)).statusCode, 409);
    const response = await f.reconcile(current, f.legacy, f.headers, true); assert.equal(response.statusCode, 200, response.body);
    const restored = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true&restoreMigrationOperationId=' + current.operationId, headers: f.headers, payload: metadata('source') }); assert.equal(restored.statusCode, 200);
    assert.equal((await f.reconcile(current, f.legacy, f.headers, true)).statusCode, 409);
  } finally { await f.close(); }
});
