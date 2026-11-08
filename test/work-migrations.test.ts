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
      const restored = await restarted.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId + '?restore=true', headers: f.headers, payload: metadata('source') });
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
