import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { chapterIdentityId } from '../src/chapter-number-mappings.ts';
import { reconcileChapterNumbers, recoverChapterNumberReconciliations, type ChapterNumberMapping, type ReconcileChapterNumbersRequest } from '../src/chapter-number-reconciliation.ts';
import { openDatabase } from '../src/db.ts';
import { scanFolder } from '../src/folder-indexer.ts';
import { defaultLimits, digest, publishChapter, uploadCursor, type CatalogEntry, type PackageManifest } from '../src/packages.ts';
import { readingStateKey, type ReadingStateEntry } from '../src/reading-state.ts';
import { migrationSnapshot } from '../src/work-migrations.ts';
import { saveWork } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const identity = { pluginId: 'bookkor-novel', novelId: 'fixture-900', novelPath: '/novel/fixture-900' };
const workId = digest(JSON.stringify([identity.pluginId, identity.novelPath]));
const metadata = (chapters: Record<string, string> = { '9001': 'Prologue', '9007': 'First chapter' }) => ({
  schemaVersion: 1, identity,
  novel: { name: 'Synthetic ordinal fixture', author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
  cover: null, chapters,
});
const mappings = (): ChapterNumberMapping[] => [
  { chapterPath: '/episode/9001', from: '9001', to: '1' },
  { chapterPath: '/episode/9007', from: '9007', to: '2' },
];
async function fixture(chapters?: Record<string, string>) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/chapter-number-'));
  const db = openDatabase(dataDir);
  saveWork(db, dataDir, metadata(chapters));
  const root = join(dataDir, 'contents', identity.pluginId, identity.novelId);
  const app = await buildApp({ dataDir, anonymousRead: true });
  const headers = await deviceHeaders(app);
  const uploadResponse = async (number = '9001', path = '/episode/' + number, body = 'Synthetic chapter bytes', otherIdentity = identity) => {
    const bytes = Buffer.from(body);
    const manifest: PackageManifest = {
      packageVersion: 1, layout: 'chapter-files', identity: { ...otherIdentity, chapterPath: path },
      novel: { name: 'Synthetic ordinal fixture', isLocal: false },
      chapter: { name: 'Episode ' + number, chapterNumber: number, position: Number(number), contentType: 'html', page: '1' },
      bodyPath: 'content.html', files: [{ path: 'content.html', size: bytes.length, modifiedAt: 1 }],
    };
    const form = new FormData(); form.append('metadata', JSON.stringify(manifest));
    form.append('content.html', new Blob([new Uint8Array(bytes)]), 'content.html');
    const request = new Request('http://fixture', { method: 'POST', body: form });
    return app.inject({ method: 'POST', url: '/api/v1/chapter-files?conflictPolicy=replace-server',
      headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
  };
  const upload = async (...args: Parameters<typeof uploadResponse>): Promise<CatalogEntry> => {
    const response = await uploadResponse(...args); assert.equal(response.statusCode, 200, response.body); return response.json<CatalogEntry>();
  };
  const request = (values = mappings()): ReconcileChapterNumbersRequest => ({
    operationId: randomUUID(), expectedWorkRevision: migrationSnapshot(db, dataDir, workId).work.revision, mappings: values,
  });
  const submit = (payload: ReconcileChapterNumbersRequest) => app.inject({ method: 'POST', url: '/api/v1/works/' + workId + '/reconcile-chapter-numbers', headers, payload });
  const entry = (id: string) => JSON.parse((db.prepare('SELECT entry FROM chapters WHERE id=?').get(id) as { entry: string }).entry) as CatalogEntry;
  const count = (table: string) => Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n);
  return { app, db, dataDir, root, headers, upload, uploadResponse, request, submit, entry, count,
    close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('reconciles real paths, canonical folders and metadata atomically while retaining IDs and bytes', async () => {
  const f = await fixture();
  try {
    const first = await f.upload(); const second = await f.upload('9007', '/episode/9007', 'Other exact bytes');
    await writeFile(join(f.root, '9001/reader-note.txt'), 'Preserve unrelated bytes');
    const raw = JSON.parse(await readFile(join(f.root, 'novel.json'), 'utf8')); raw.extension = { preserved: true };
    await writeFile(join(f.root, 'novel.json'), JSON.stringify(raw) + '\n');
    const checksum = f.db.prepare('SELECT checksum FROM schema_state').get();
    const payload = f.request(); const response = await f.submit(payload);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await f.app.inject('/api/v1/capabilities')).json().chapterNumberReconciliationVersion, 1);
    assert.equal(response.json().updatedChapters, 2); assert.equal(response.json().work.id, workId);
    assert.deepEqual(response.json().work.metadata.identity, identity);
    assert.deepEqual(response.json().work.metadata.chapters, { '1': 'Prologue', '2': 'First chapter' });
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'novel.json'), 'utf8')).extension, { preserved: true });
    assert.equal(await readFile(join(f.root, '1/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.equal(await readFile(join(f.root, '2/content.html'), 'utf8'), 'Other exact bytes');
    assert.equal(await readFile(join(f.root, '1/reader-note.txt'), 'utf8'), 'Preserve unrelated bytes');
    assert.equal(existsSync(join(f.root, '9001')), false); assert.equal(existsSync(join(f.root, '9007')), false);
    for (const [old, number] of [[first, '1'], [second, '2']] as const) {
      const current = f.entry(old.id);
      assert.equal(current.id, old.id); assert.equal(current.manifest.identity.chapterPath, old.manifest.identity.chapterPath);
      assert.equal(current.manifest.chapter.chapterNumber, number); assert.equal(current.manifest.chapter.position, Number(number));
      assert.equal(current.deleted, false); assert.equal(current.complete, old.complete);
      assert.deepEqual(current.manifest.files, old.manifest.files);
      const inventory = await f.app.inject('/api/v1/chapters/' + old.id + '/storage-inventory?revision=' + current.revision);
      assert.equal(inventory.statusCode, 200, inventory.body);
    }
    assert.deepEqual(f.db.prepare('SELECT checksum FROM schema_state').get(), checksum);
    assert.equal(f.count('chapter_number_aliases'), 2);
    const replay = await f.submit(payload); assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json(), response.json());
    const changed = structuredClone(payload); changed.mappings[0].to = '3';
    assert.equal((await f.submit(changed)).statusCode, 409);
    const otherDevice = await f.submit({ ...payload, operationId: randomUUID() });
    assert.equal(otherDevice.statusCode, 200, otherDevice.body); assert.equal(otherDevice.json().updatedChapters, 0);
  } finally { await f.close(); }
});

test('binds a unique recovered folder to its real path and preserves stable ID through uploads, scan and restart', async () => {
  const f = await fixture({ '9001': 'Recovered chapter' });
  try {
    const recovered = await f.upload('9001', 'norea-folder:9001');
    const payload = f.request(mappings().slice(0, 1)); const result = await f.submit(payload);
    assert.equal(result.statusCode, 200, result.body);
    const current = f.entry(recovered.id);
    assert.equal(current.id, recovered.id); assert.equal(current.manifest.identity.chapterPath, '/episode/9001');
    for (const path of ['/episode/9001', 'norea-folder:9001', 'norea-folder:1']) {
      assert.equal(chapterIdentityId(f.db, { ...identity, chapterPath: path }), recovered.id);
      const query = new URLSearchParams({ pluginId: identity.pluginId, novelPath: identity.novelPath, chapterPath: path, chapterNumber: '1' });
      const response = await f.app.inject('/api/v1/catalog/chapter?' + query);
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().id, recovered.id);
    }
    const stale = await f.upload('9001', 'norea-folder:9001', 'Preserved stale-device upload');
    assert.equal(stale.id, recovered.id); assert.equal(stale.manifest.chapter.chapterNumber, '1');
    assert.equal(stale.manifest.identity.chapterPath, '/episode/9001'); assert.equal(existsSync(join(f.root, '9001')), false);
    const scanned = await scanFolder({ db: f.db, dataDir: f.dataDir, limits: defaultLimits, full: true });
    assert.equal(scanned.failed, 0); assert.equal(f.count('chapters'), 1); assert.equal(f.entry(recovered.id).manifest.chapter.chapterNumber, '1');
    assert.equal(migrationSnapshot(f.db, f.dataDir, workId).chapters[0].id, recovered.id);
    await f.app.close();
    const restarted = await buildApp({ dataDir: f.dataDir });
    try {
      const retry = await restarted.inject({ method: 'POST', url: '/api/v1/works/' + workId + '/reconcile-chapter-numbers', headers: f.headers, payload });
      assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().operationId, payload.operationId);
      assert.equal(f.entry(recovered.id).manifest.identity.chapterPath, '/episode/9001');
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('an identical imported old folder is rejected before the current-entry early return', async () => {
  const f = await fixture({ '9001': 'Episode 9001' });
  try {
    const original = await f.upload('9001', 'norea-folder:9001');
    const response = await f.submit(f.request(mappings().slice(0, 1)));
    assert.equal(response.statusCode, 200, response.body);
    await cp(join(f.root, '1'), join(f.root, '9001'), { recursive: true, preserveTimestamps: true });
    assert.throws(() => publishChapter(f.db, f.dataDir, join(f.root, '9001'), original, uploadCursor(f.db), true), /old chapter folders must not be reimported/);
    assert.equal(f.count('chapters'), 1);
    assert.equal(await readFile(join(f.root, '9001/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.equal(f.entry(original.id).manifest.chapter.chapterNumber, '1');
    await scanFolder({ db: f.db, dataDir: f.dataDir, limits: defaultLimits, full: true });
    assert.equal(f.count('chapters'), 1);
  } finally { await f.close(); }
});

test('metadata-only mappings normalize stale metadata and reject unregistered paths or old imported folders', async () => {
  const f = await fixture({ '9001': 'No downloaded body' });
  try {
    const response = await f.submit(f.request(mappings().slice(0, 1)));
    assert.equal(response.statusCode, 200, response.body); assert.equal(f.count('chapters'), 0);
    const staleMetadata = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + workId, headers: f.headers, payload: metadata({ '9001': 'Old device title' }) });
    assert.equal(staleMetadata.statusCode, 200, staleMetadata.body);
    assert.deepEqual(Object.keys(staleMetadata.json().metadata.chapters), ['1']);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.root, 'novel.json'), 'utf8')).chapters), ['1']);
    const forged = await f.uploadResponse('9001', '/wrong/source/path');
    assert.equal(forged.statusCode, 409, forged.body); assert.equal(f.count('chapters'), 0);
    await mkdir(join(f.root, '9001')); await writeFile(join(f.root, '9001/content.html'), 'Do not adopt old directory');
    const scan = await scanFolder({ db: f.db, dataDir: f.dataDir, limits: defaultLimits, full: true });
    assert.equal(scan.registered, 0); assert.equal(f.count('chapters'), 0);
    assert.equal(await readFile(join(f.root, '9001/content.html'), 'utf8'), 'Do not adopt old directory');
    await rm(join(f.root, '9001'), { recursive: true });
    const uploaded = await f.upload('9001', '/episode/9001');
    assert.equal(uploaded.manifest.chapter.chapterNumber, '1'); assert.equal(existsSync(join(f.root, '1/content.html')), true);
    await writeFile(join(f.root, 'novel.json'), JSON.stringify(metadata({ '9001': 'Copied stale metadata' })));
    const work = await f.app.inject('/api/v1/works/' + workId);
    assert.equal(work.statusCode, 200, work.body); assert.deepEqual(Object.keys(work.json().metadata.chapters), ['1']);
  } finally { await f.close(); }
});

test('rekeys all matching reading profiles without losing monotonic progress or later timestamps', async () => {
  const f = await fixture({ '9001': 'Read chapter' });
  try {
    const make = (number: string, path: string, values: Partial<ReadingStateEntry> = {}): ReadingStateEntry => ({
      pluginId: identity.pluginId, sourceNovelId: identity.novelId, novelPath: identity.novelPath, chapterPath: path, chapterNumber: number, page: '1',
      unread: true, progress: 1, bookmark: false, readAt: 1, ...values,
    });
    const add = (profile: string, entry: ReadingStateEntry) => f.db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run(profile, readingStateKey(entry), JSON.stringify(entry));
    add('profile-one', make('9001', '/episode/9001', { progress: 80, readAt: 20 }));
    add('profile-one', make('1', '/episode/9001', { progress: 100, unread: false, bookmark: true, readAt: 10 }));
    add('profile-two', make('9001', 'norea-folder:9001', { progress: 40, readAt: 5 }));
    add('profile-two', make('1', '/episode/9001', { progress: 20, bookmark: true, readAt: 50 }));
    add('unrelated', make('9001', '/different/work/chapter', { novelPath: '/other', sourceNovelId: 'other' }));
    const response = await f.submit(f.request(mappings().slice(0, 1)));
    assert.equal(response.statusCode, 200, response.body);
    const rows = f.db.prepare('SELECT profile_hash,entry FROM reading_state_entries ORDER BY profile_hash').all() as { profile_hash: string; entry: string }[];
    assert.equal(rows.length, 3);
    const first = JSON.parse(rows[0].entry) as ReadingStateEntry; const second = JSON.parse(rows[1].entry) as ReadingStateEntry;
    assert.equal(first.chapterNumber, '1'); assert.equal(first.chapterPath, '/episode/9001');
    assert.equal(first.progress, 100); assert.equal(first.unread, false); assert.equal(first.bookmark, true); assert.equal(first.readAt, 20);
    assert.equal(second.chapterNumber, '1'); assert.equal(second.progress, 40); assert.equal(second.bookmark, true); assert.equal(second.readAt, 50);
    assert.equal(JSON.parse(rows[2].entry).chapterNumber, '9001');
    const staleMerge = await f.app.inject({ method: 'POST', url: '/api/v1/reading-state/merge', headers: f.headers,
      payload: { syncKey: 'a'.repeat(64), entries: [make('9001', 'norea-folder:9001', { progress: 70, readAt: 80 })] } });
    assert.equal(staleMerge.statusCode, 200, staleMerge.body);
    const read = await f.app.inject({ method: 'POST', url: '/api/v1/reading-state/read', headers: f.headers, payload: { syncKey: 'a'.repeat(64) } });
    assert.equal(read.json().entries[0].chapterNumber, '1'); assert.equal(read.json().entries[0].chapterPath, '/episode/9001');
  } finally { await f.close(); }
});

test('retains deleted chapter ID, tombstone and trash bytes while changing only its restoration folder', async () => {
  const f = await fixture({ '9001': 'Deleted chapter' });
  try {
    const entry = await f.upload(); const deletion = await f.app.inject({ method: 'DELETE', url: '/api/v1/chapters/' + entry.id, headers: f.headers });
    assert.equal(deletion.statusCode, 200, deletion.body);
    const before = f.db.prepare('SELECT path,deleted_at FROM chapters WHERE id=?').get(entry.id) as { path: string; deleted_at: number };
    const response = await f.submit(f.request(mappings().slice(0, 1)));
    assert.equal(response.statusCode, 200, response.body);
    const after = f.db.prepare('SELECT directory,path,deleted_at FROM chapters WHERE id=?').get(entry.id) as { directory: string; path: string; deleted_at: number };
    assert.equal(after.path, before.path); assert.equal(after.deleted_at, before.deleted_at);
    assert.equal(after.directory, join('contents', identity.pluginId, identity.novelId, '1')); assert.equal(f.entry(entry.id).deleted, true);
    assert.equal(f.count('chapter_tombstones'), 1); assert.equal(await readFile(join(f.dataDir, before.path, 'content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.equal(existsSync(join(f.root, '1')), false);
    const restored = await f.app.inject({ method: 'POST', url: '/api/v1/chapters/' + entry.id + '/restore', headers: f.headers });
    assert.equal(restored.statusCode, 200, restored.body); assert.equal(restored.json().id, entry.id);
    assert.equal(await readFile(join(f.root, '1/content.html'), 'utf8'), 'Synthetic chapter bytes');
  } finally { await f.close(); }
});

for (const kind of ['duplicate-source', 'duplicate-target', 'duplicate-path', 'cycle', 'wrong-path', 'stale-revision', 'missing-identity', 'target-folder', 'target-metadata', 'target-declared-number', 'unindexed-source', 'placeholder-target'] as const) {
  test('rejects unsafe mapping without changing files: ' + kind, async () => {
    const f = await fixture();
    try {
      if (kind !== 'unindexed-source') { await f.upload(); await f.upload('9007'); }
      else { await mkdir(join(f.root, '9001')); await writeFile(join(f.root, '9001/content.html'), 'Unindexed payload'); }
      const payload = f.request();
      if (kind === 'duplicate-source') payload.mappings[1].from = payload.mappings[0].from;
      if (kind === 'duplicate-target') payload.mappings[1].to = payload.mappings[0].to;
      if (kind === 'duplicate-path') payload.mappings[1].chapterPath = payload.mappings[0].chapterPath;
      if (kind === 'cycle') { payload.mappings[0].to = '9007'; payload.mappings[1].to = '9001'; }
      if (kind === 'wrong-path') payload.mappings[0].chapterPath = '/unproven/path';
      if (kind === 'stale-revision') payload.expectedWorkRevision = '0'.repeat(64);
      if (kind === 'missing-identity') payload.mappings[0].from = '777777';
      if (kind === 'target-declared-number') {
        const row = f.db.prepare("SELECT id,entry FROM chapters WHERE json_extract(entry,'$.manifest.chapter.chapterNumber')='9007'").get() as { id: string; entry: string };
        const dirty = JSON.parse(row.entry); dirty.manifest.chapter.chapterNumber = '1';
        f.db.prepare('UPDATE chapters SET entry=? WHERE id=?').run(JSON.stringify(dirty), row.id);
      }
      if (kind === 'target-folder') { await mkdir(join(f.root, '1')); await writeFile(join(f.root, '1/preserve.txt'), 'Occupied target'); }
      if (kind === 'target-metadata') { saveWork(f.db, f.dataDir, metadata({ '1': 'Existing target' })); payload.expectedWorkRevision = f.request().expectedWorkRevision; }
      if (kind === 'placeholder-target') payload.mappings[0].chapterPath = 'norea-folder:1';
      const before = await readFile(join(f.root, 'novel.json'));
      const response = await f.submit(payload);
      assert.equal(response.statusCode, kind === 'placeholder-target' ? 400 : 409, response.body);
      assert.deepEqual(await readFile(join(f.root, 'novel.json')), before);
      assert.equal(existsSync(join(f.root, '9001/content.html')), true);
      if (kind === 'target-folder') assert.equal(await readFile(join(f.root, '1/preserve.txt'), 'utf8'), 'Occupied target');
      assert.equal(f.count('chapter_number_aliases'), 0); assert.equal(f.count('chapter_number_reconciliations'), 0);
    } finally { await f.close(); }
  });
}

test('rejects ambiguous recovered identities and forged or cross-work alias proofs', async () => {
  const f = await fixture({ '9001': 'One source chapter' });
  try {
    const first = await f.upload('9001', 'norea-folder:9001');
    const duplicate = structuredClone(first); duplicate.id = digest(JSON.stringify([identity.pluginId, identity.novelPath, '/different']));
    duplicate.manifest.identity.chapterPath = '/different';
    f.db.prepare('INSERT INTO chapters(id,work_id,entry,directory,path) VALUES(?,?,?,?,NULL)').run(duplicate.id, workId, JSON.stringify(duplicate), 'contents/bookkor-novel/fixture-900/ambiguous');
    const request = f.request(mappings().slice(0, 1));
    assert.equal((await f.submit(request)).statusCode, 409);
    f.db.prepare('DELETE FROM chapters WHERE id=?').run(duplicate.id);
    const response = await f.submit(request); assert.equal(response.statusCode, 200, response.body);
    assert.equal(chapterIdentityId(f.db, { ...identity, novelPath: '/other-work', chapterPath: '/episode/9001' }),
      digest(JSON.stringify([identity.pluginId, '/other-work', '/episode/9001'])));
    const other = { ...identity, novelId: 'other-book', novelPath: '/other-work' };
    saveWork(f.db, f.dataDir, { ...metadata(), identity: other });
    const otherUpload = await f.upload('9001', '/episode/9001', 'Other work bytes', other);
    assert.notEqual(otherUpload.id, first.id);
    f.db.prepare('UPDATE chapter_number_aliases SET chapter_id=? WHERE work_id=?').run(otherUpload.id, workId);
    assert.throws(() => chapterIdentityId(f.db, { ...identity, chapterPath: '/episode/9001' }), /identity proof/);
    f.db.prepare('UPDATE chapter_number_aliases SET chapter_id=?,operation_id=? WHERE work_id=?').run(first.id, randomUUID(), workId);
    assert.throws(() => chapterIdentityId(f.db, { ...identity, chapterPath: '/episode/9001' }), /committed same-work operation/);
  } finally { await f.close(); }
});

test('rolls back exact original metadata and all moves if the final receipt cannot commit, then retries', async () => {
  const f = await fixture();
  try {
    const first = await f.upload(); await f.upload('9007');
    const before = await readFile(join(f.root, 'novel.json'));
    const payload = f.request();
    f.db.exec("CREATE TRIGGER fail_number_receipt BEFORE UPDATE OF result ON chapter_number_reconciliations WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    const failure = await f.submit(payload); assert.equal(failure.statusCode, 500, failure.body);
    assert.deepEqual(await readFile(join(f.root, 'novel.json')), before);
    assert.equal(await readFile(join(f.root, '9001/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.equal(existsSync(join(f.root, '1')), false); assert.equal(existsSync(join(f.root, '2')), false);
    assert.equal(f.entry(first.id).manifest.chapter.chapterNumber, '9001');
    assert.equal(f.count('chapter_number_aliases'), 0); assert.equal(f.count('chapter_number_reconciliations'), 0);
    f.db.exec('DROP TRIGGER fail_number_receipt');
    const retry = await f.submit(payload); assert.equal(retry.statusCode, 200, retry.body);
  } finally { await f.close(); }
});

test('losing the prepared journal before the write lock cannot publish unjournaled filesystem changes', async () => {
  const f = await fixture({ '9001': 'Chapter' });
  try {
    const original = await f.upload(); const before = await readFile(join(f.root, 'novel.json'));
    f.db.exec("CREATE TRIGGER concurrent_prepared_recovery AFTER INSERT ON chapter_number_reconciliations WHEN NEW.state='prepared' BEGIN DELETE FROM chapter_number_reconciliations WHERE operation_id=NEW.operation_id; END");
    const result = await f.submit(f.request(mappings().slice(0, 1)));
    assert.equal(result.statusCode, 409, result.body); assert.match(result.json().message, /prepared operation changed/);
    assert.deepEqual(await readFile(join(f.root, 'novel.json')), before);
    assert.equal(existsSync(join(f.root, '9001/content.html')), true); assert.equal(existsSync(join(f.root, '1')), false);
    assert.equal(f.entry(original.id).manifest.chapter.chapterNumber, '9001'); assert.equal(f.count('chapter_number_aliases'), 0);
  } finally { await f.close(); }
});

function crashProcess(dataDir: string, request: ReconcileChapterNumbersRequest, phase: string): void {
  const dbModule = new URL('../src/db.ts', import.meta.url).href;
  const renumberModule = new URL('../src/chapter-number-reconciliation.ts', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { openDatabase } from ${JSON.stringify(dbModule)};
    import { reconcileChapterNumbers, recoverChapterNumberReconciliations } from ${JSON.stringify(renumberModule)};
    const dataDir = ${JSON.stringify(dataDir)};
    const phase = ${JSON.stringify(phase)};
    const db = openDatabase(dataDir);
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      rename(from, to);
      if ((phase === 'first-move' && String(to).endsWith('/1')) ||
          (phase === 'metadata' && String(to).endsWith('/novel.json')) ||
          (phase === 'rollback' && String(to).endsWith('/9007'))) process.exit(73);
    };
    syncBuiltinESMExports();
    if (phase === 'rollback') recoverChapterNumberReconciliations(db, dataDir);
    else reconcileChapterNumbers(db, dataDir, ${JSON.stringify(workId)}, ${JSON.stringify(request)}, () => {
      if (phase === 'before-commit') process.exit(73);
    });
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 73, child.stderr + child.stdout);
}

for (const phase of ['first-move', 'metadata', 'before-commit'] as const) test('startup recovers a process crash at ' + phase + ' and exact retry succeeds', async () => {
  const f = await fixture();
  try {
    const first = await f.upload(); await f.upload('9007');
    const before = await readFile(join(f.root, 'novel.json')); const payload = f.request();
    await f.app.close();
    crashProcess(f.dataDir, payload, phase);
    assert.equal(f.count('chapter_number_reconciliations'), 1); assert.equal(f.count('chapter_number_aliases'), 0);
    const restarted = await buildApp({ dataDir: f.dataDir });
    try {
      assert.deepEqual(await readFile(join(f.root, 'novel.json')), before);
      assert.equal(existsSync(join(f.root, '9001/content.html')), true); assert.equal(existsSync(join(f.root, '9007/content.html')), true);
      assert.equal(existsSync(join(f.root, '1')), false); assert.equal(existsSync(join(f.root, '2')), false);
      assert.equal(f.entry(first.id).manifest.chapter.chapterNumber, '9001'); assert.equal(f.count('chapter_number_reconciliations'), 0);
      const retry = await restarted.inject({ method: 'POST', url: '/api/v1/works/' + workId + '/reconcile-chapter-numbers', headers: f.headers, payload });
      assert.equal(retry.statusCode, 200, retry.body); assert.equal(f.entry(first.id).manifest.chapter.chapterNumber, '1');
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('recovery itself can crash and retry without deleting or overwriting either payload', async () => {
  const f = await fixture();
  try {
    await f.upload(); await f.upload('9007'); const before = await readFile(join(f.root, 'novel.json')); const payload = f.request();
    await f.app.close(); crashProcess(f.dataDir, payload, 'before-commit'); crashProcess(f.dataDir, payload, 'rollback');
    assert.equal(f.count('chapter_number_reconciliations'), 1);
    recoverChapterNumberReconciliations(f.db, f.dataDir);
    assert.deepEqual(await readFile(join(f.root, 'novel.json')), before);
    assert.equal(await readFile(join(f.root, '9001/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.equal(await readFile(join(f.root, '9007/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.equal(f.count('chapter_number_reconciliations'), 0);
  } finally { await f.close(); }
});

for (const obstruction of ['folder', 'metadata'] as const) test('ambiguous recovery preserves outside changes and leaves the durable journal: ' + obstruction, async () => {
  const f = await fixture();
  try {
    await f.upload(); await f.upload('9007'); const payload = f.request(); await f.app.close();
    const original = await readFile(join(f.root, 'novel.json'));
    crashProcess(f.dataDir, payload, 'before-commit');
    if (obstruction === 'folder') { await mkdir(join(f.root, '9001')); await writeFile(join(f.root, '9001/preserve.txt'), 'Outside new folder'); }
    else await writeFile(join(f.root, 'novel.json'), original.toString() + ' ');
    assert.throws(() => recoverChapterNumberReconciliations(f.db, f.dataDir), /recovery is retained/);
    assert.equal(f.count('chapter_number_reconciliations'), 1);
    assert.equal(await readFile(join(f.root, '1/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.throws(() => saveWork(f.db, f.dataDir, metadata()), /unfinished storage recovery/);
    if (obstruction === 'folder') {
      assert.equal(await readFile(join(f.root, '9001/preserve.txt'), 'utf8'), 'Outside new folder'); await rm(join(f.root, '9001'), { recursive: true });
    } else await writeFile(join(f.root, 'novel.json'), original);
    recoverChapterNumberReconciliations(f.db, f.dataDir);
    assert.equal(f.count('chapter_number_reconciliations'), 0);
    assert.equal(await readFile(join(f.root, '9001/content.html'), 'utf8'), 'Synthetic chapter bytes');
  } finally { await f.close(); }
});

test('requires an admitted unblocked device and preserves additive schema data on reopen', async () => {
  const f = await fixture({ '9001': 'Metadata only' });
  try {
    const payload = f.request(mappings().slice(0, 1)); const url = '/api/v1/works/' + workId + '/reconcile-chapter-numbers';
    assert.equal((await f.app.inject({ method: 'POST', url, payload })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url, payload, headers: await consoleHeaders(f.app, f.dataDir) })).statusCode, 403);
    f.db.prepare('UPDATE devices SET blocked=1').run(); assert.equal((await f.submit(payload)).statusCode, 403);
    const checksum = f.db.prepare('SELECT checksum FROM schema_state').get(); const works = f.db.prepare('SELECT entry FROM works').all();
    f.db.exec('DROP TABLE chapter_number_aliases; DROP TABLE chapter_number_reconciliations');
    const reopened = openDatabase(f.dataDir);
    try {
      assert.deepEqual(reopened.prepare('SELECT checksum FROM schema_state').get(), checksum);
      assert.deepEqual(reopened.prepare('SELECT entry FROM works').all(), works);
      assert.equal(Number(reopened.prepare('SELECT count(*) AS n FROM devices').get()!.n), 1);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('a reconciled recovered ID remains valid for the existing cross-source finalize API', async () => {
  const f = await fixture({ '9001': 'Recovered chapter' });
  try {
    const source = await f.upload('9001', 'norea-folder:9001');
    const reconciled = await f.submit(f.request(mappings().slice(0, 1))); assert.equal(reconciled.statusCode, 200, reconciled.body);
    const targetIdentity = { pluginId: 'target', novelId: 'target-book', novelPath: '/target-book' };
    const targetId = digest(JSON.stringify([targetIdentity.pluginId, targetIdentity.novelPath]));
    saveWork(f.db, f.dataDir, { ...metadata({ '1001': 'Target copy' }), identity: targetIdentity });
    const target = await f.upload('1001', '/target/episode', 'Synthetic chapter bytes', targetIdentity);
    const sourceSnapshot = migrationSnapshot(f.db, f.dataDir, workId);
    const targetSnapshot = migrationSnapshot(f.db, f.dataDir, targetId);
    const response = await f.app.inject({ method: 'POST', url: '/api/v1/works/' + workId + '/finalize-migration', headers: f.headers,
      payload: { operationId: randomUUID(), source: { revision: sourceSnapshot.work.revision, chapters: sourceSnapshot.chapters.map(({ id, revision }) => ({ id, revision })) },
        target: { id: targetId, revision: targetSnapshot.work.revision },
        mappings: [{ sourceChapterId: source.id, targetChapterId: target.id, targetRevision: target.revision, decision: 'copy-source' }] } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().deletedWork.id, workId);
    assert.equal(await readFile(join(f.dataDir, 'contents/target/target-book/1001/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.ok(f.db.prepare('SELECT 1 FROM chapter_tombstones WHERE chapter_id=?').get(source.id));
  } finally { await f.close(); }
});

test('conflicting reading-state target identity rolls back the entire numbering change', async () => {
  const f = await fixture({ '9001': 'Read chapter' });
  try {
    await f.upload();
    const state: ReadingStateEntry = { pluginId: identity.pluginId, sourceNovelId: identity.novelId, novelPath: identity.novelPath,
      chapterPath: '/different/chapter', chapterNumber: '1', page: '1', unread: false, progress: 100, bookmark: true, readAt: 5 };
    f.db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('profile', readingStateKey(state), JSON.stringify(state));
    const before = await readFile(join(f.root, 'novel.json'));
    const response = await f.submit(f.request(mappings().slice(0, 1)));
    assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /^Chapter number reconciliation conflict: /);
    assert.deepEqual(await readFile(join(f.root, 'novel.json')), before);
    assert.equal(await readFile(join(f.root, '9001/content.html'), 'utf8'), 'Synthetic chapter bytes');
    assert.equal(f.count('chapter_number_aliases'), 0); assert.equal(f.count('chapter_number_reconciliations'), 0);
    assert.equal((f.db.prepare('SELECT entry FROM reading_state_entries').get() as { entry: string }).entry, JSON.stringify(state));
  } finally { await f.close(); }
});

test('direct reconciliation rechecks authorization after moving files and rolls back a rejected commit', async () => {
  const f = await fixture({ '9001': 'Downloaded chapter' });
  try {
    await f.upload(); const before = readFileSync(join(f.root, 'novel.json'));
    assert.throws(() => reconcileChapterNumbers(f.db, f.dataDir, workId, f.request(mappings().slice(0, 1)), () => { throw new Error('revoked'); }), /revoked/);
    assert.deepEqual(readFileSync(join(f.root, 'novel.json')), before);
    assert.equal(existsSync(join(f.root, '9001/content.html')), true); assert.equal(existsSync(join(f.root, '1')), false);
    assert.equal(f.count('chapter_number_reconciliations'), 0);
    // A work-local field remains byte exact even if a failed operation rewrote metadata.
    writeFileSync(join(f.root, 'novel.json'), before);
    assert.deepEqual((await readdir(f.root)).sort(), ['9001', 'novel.json']);
  } finally { await f.close(); }
});
