import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { chapterCompositionCatalog, type ChapterCompositionEntry, type ChapterCompositionV1 } from '../src/chapter-composition.ts';
import { digest } from '../src/packages.ts';
import type { NovelMetadataV1 } from '../src/works.ts';
import { deviceHeaders } from './access.ts';

const identity = { pluginId: 'example', novelId: 'Book', novelPath: '/books/1' };
const id = digest(JSON.stringify([identity.pluginId, identity.novelPath]));
function entry(number: number): ChapterCompositionEntry {
  return { id: `entry-${number}`, path: `/chapter/${number}`, storageChapterNumber: String(number), primarySource: 0,
    sources: [{ ...identity, chapterPath: `/chapter/${number}`, sourceChapterId: `source-${number}`, chapterNumber: String(number), name: `Source ${number}`, position: number, page: '1', contentType: 'text', releaseTime: null }],
    user: { included: true, order: number, name: null, chapterNumber: String(number) } };
}
function composition(entries = [entry(1)], updatedAt = 100): ChapterCompositionV1 { return { version: 1, updatedAt, entries }; }
function metadata(document?: ChapterCompositionV1): NovelMetadataV1 {
  return { schemaVersion: 1, identity, novel: { name: 'Book', author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null, chapters: document ? chapterCompositionCatalog(document) : { '1': 'Source 1' }, ...(document ? { chapterComposition: document } : {}) };
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-user-state-composition-'));
  const app = await buildApp({ dataDir });
  const headers = await deviceHeaders(app);
  const { workspaceId, epoch } = (await app.inject({ url: '/api/v1/user-state', headers })).json();
  const share = (document: ChapterCompositionV1, baseRevision = 0) => app.inject({ method: 'POST', url: '/api/v1/user-state/merge', headers, payload: {
    workspaceId, epoch, operations: [{ operationId: randomUUID(), entity: { kind: 'composition', work: { pluginId: identity.pluginId, sourceNovelId: identity.novelId, novelPath: identity.novelPath, name: 'Book' } }, value: { composition: document }, baseRevision }],
  } });
  const put = (document?: ChapterCompositionV1) => app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers, payload: metadata(document) });
  const directory = join(dataDir, 'contents', identity.pluginId, identity.novelId);
  const file = join(directory, 'novel.json');
  return { app, headers, dataDir, directory, file, share, put, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
function successful(response: { statusCode: number; body: string; json: () => any }) { assert.equal(response.statusCode, 200, response.body); return response.json(); }

test('shared manual choices win over newer metadata clocks while exact provider facts and new chapters survive', async () => {
  const f = await fixture();
  try {
    const excluded = entry(2); excluded.user = { included: false, order: 0, name: 'Excluded user title', chapterNumber: null };
    const original = composition([entry(1), excluded]);
    successful(await f.put(original));
    const bytes = await readFile(f.file);
    const shared = structuredClone(original); shared.entries[0].user.name = 'Shared manual title'; shared.entries[0].user.chapterNumber = '7';
    const saved = successful(await f.share(shared)).results[0].current;
    // The user-state API is metadata-only SQLite state; it does not rewrite original work files.
    assert.deepEqual(await readFile(f.file), bytes);
    const incoming = composition([entry(1), entry(2), entry(3)], 200);
    incoming.entries[0].user.name = 'An unshared manual title';
    incoming.entries[0].sources[0].name = 'Refreshed provider title';
    const updated = successful(await f.put(incoming)).metadata.chapterComposition as ChapterCompositionV1;
    assert.equal(updated.entries[0].user.name, 'Shared manual title');
    assert.equal(updated.entries[0].user.chapterNumber, '7');
    assert.equal(updated.entries[0].sources[0].name, 'Refreshed provider title');
    assert.equal(updated.entries[1].user.included, false);
    assert.equal(updated.entries[2].sources[0].chapterNumber, '3');
    assert.equal(updated.entries[2].user.order, 2);
    assert.equal(updated.entries[2].user.chapterNumber, '2');
    const backwardsClock = structuredClone(shared); backwardsClock.updatedAt = 1; backwardsClock.entries[0].user.name = 'New intent from a slower clock';
    successful(await f.share(backwardsClock, saved.revision));
    const replayed = successful(await f.put(incoming)).metadata.chapterComposition as ChapterCompositionV1;
    assert.equal(replayed.entries[0].user.name, 'New intent from a slower clock');
    assert.equal(replayed.entries[0].sources[0].name, 'Refreshed provider title');
    assert.equal(replayed.entries.length, 3);
    assert.equal(await readFile(f.file, 'utf8'), JSON.stringify(successful(await f.put(incoming)).metadata, null, 2) + '\n');
  } finally { await f.close(); }
});

test('stored and incoming provider additions are both retained without adopting foreign unshared manual additions', async () => {
  const f = await fixture();
  try {
    successful(await f.share(composition()));
    const stored = composition([entry(1), entry(2)], 300);
    successful(await f.put(stored));
    const incoming = composition([entry(1), entry(3)], 200);
    incoming.entries[1].user.order = 2; incoming.entries[1].user.chapterNumber = '2';
    const foreign = entry(4); foreign.sources[0].novelId = 'Foreign'; foreign.user.order = 3; foreign.user.chapterNumber = '3';
    incoming.entries.push(foreign);
    const result = successful(await f.put(incoming)).metadata.chapterComposition as ChapterCompositionV1;
    assert.deepEqual(new Set(result.entries.map(item => item.sources[0].sourceChapterId)), new Set(['source-1', 'source-2', 'source-3']));
    assert(result.entries.every(item => item.sources[0].novelId === 'Book'));
  } finally { await f.close(); }
});

test('ambiguous new provider storage is a 409 before replacing work metadata or its catalog entry', async () => {
  const f = await fixture();
  try {
    const excluded = entry(2); excluded.user.included = false; excluded.user.order = 0;
    const shared = composition([entry(1), excluded]);
    const initial = successful(await f.put(shared)); successful(await f.share(shared));
    const before = await readFile(f.file);
    const discovery = entry(3); discovery.storageChapterNumber = '2'; discovery.user.order = 2; discovery.user.chapterNumber = '2';
    const invalid = composition([entry(1), discovery], 200);
    assert.equal((await f.put(invalid)).statusCode, 409);
    assert.deepEqual(await readFile(f.file), before);
    assert.equal((await f.app.inject({ url: `/api/v1/works/${id}`, headers: f.headers })).json().sequence, initial.sequence);
  } finally { await f.close(); }
});

test('an original target-provider row may adopt a different device UUID without changing its stored body', async () => {
  const f = await fixture();
  try {
    const original = composition(); successful(await f.put(original));
    await mkdir(join(f.directory, '1')); await writeFile(join(f.directory, '1', 'content.txt'), 'original body');
    const shared = structuredClone(original); shared.entries[0].id = 'other-device-uuid'; shared.entries[0].user.name = 'Shared title';
    successful(await f.share(shared));
    const changed = successful(await f.put(original)).metadata.chapterComposition as ChapterCompositionV1;
    assert.equal(changed.entries[0].id, 'other-device-uuid');
    assert.equal(await readFile(join(f.directory, '1', 'content.txt'), 'utf8'), 'original body');
    assert.equal(changed.entries[0].path, original.entries[0].path);
    assert.equal(changed.entries[0].storageChapterNumber, original.entries[0].storageChapterNumber);
  } finally { await f.close(); }
});

for (const mismatch of ['synthetic-id', 'source-owner', 'primary-body', 'storage-key', 'entry-path'] as const) test(`physical composition ownership rejects ${mismatch} before touching stored data`, async () => {
  const f = await fixture();
  try {
    const original = composition();
    if (mismatch === 'synthetic-id') original.entries[0].path = 'norea-composed:existing';
    successful(await f.put(original));
    await mkdir(join(f.directory, '1')); await writeFile(join(f.directory, '1', 'content.txt'), 'owned body');
    const before = await readFile(f.file);
    const shared = structuredClone(original);
    if (mismatch === 'synthetic-id') shared.entries[0].id = 'different-synthetic-id';
    if (mismatch === 'source-owner') shared.entries[0].sources[0].novelId = 'Different-work';
    if (mismatch === 'primary-body') shared.entries[0].sources[0].sourceChapterId = 'different-body';
    if (mismatch === 'storage-key') shared.entries[0].storageChapterNumber = '2';
    if (mismatch === 'entry-path') shared.entries[0].path = '/another-chapter';
    successful(await f.share(shared));
    assert.equal((await f.put(original)).statusCode, 409);
    assert.deepEqual(await readFile(f.file), before);
    assert.equal(await readFile(join(f.directory, '1', 'content.txt'), 'utf8'), 'owned body');
  } finally { await f.close(); }
});

test('expanding provenance with the same primary source preserves a stored body; metadata-only rows need no false physical conflict', async () => {
  const f = await fixture();
  try {
    const original = composition(); successful(await f.put(original));
    await mkdir(join(f.directory, '1')); await writeFile(join(f.directory, '1', 'content.txt'), 'unchanged body');
    const shared = structuredClone(original);
    shared.entries[0].sources.push({ ...shared.entries[0].sources[0], novelId: 'Other', sourceChapterId: 'other-chapter' });
    successful(await f.share(shared));
    assert.equal(successful(await f.put(original)).metadata.chapterComposition.entries[0].sources.length, 2);
    assert.equal(await readFile(join(f.directory, '1', 'content.txt'), 'utf8'), 'unchanged body');
  } finally { await f.close(); }
  const empty = await fixture();
  try {
    const original = composition(); successful(await empty.put(original));
    const shared = structuredClone(original); shared.entries[0].storageChapterNumber = '9';
    successful(await empty.share(shared));
    assert.equal(successful(await empty.put(original)).metadata.chapterComposition.entries[0].storageChapterNumber, '9');
  } finally { await empty.close(); }
});

test('first composition requires exact indexed source ownership when a physical folder already exists', async () => {
  const f = await fixture();
  try {
    successful(await f.put());
    const bytes = 'original';
    const form = new FormData();
    form.append('metadata', JSON.stringify({ packageVersion: 1, layout: 'chapter-files', identity: { ...identity, chapterPath: '/chapter/1' }, novel: { name: 'Book', isLocal: false },
      chapter: { name: 'Source 1', position: 1, chapterNumber: '1', contentType: 'html', page: '1' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: bytes.length, modifiedAt: 1 }] }));
    form.append('content.html', new Blob([bytes]), 'content.html');
    const upload = new Request('http://localhost', { method: 'POST', body: form });
    successful(await f.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...f.headers, 'content-type': upload.headers.get('content-type')! }, payload: Buffer.from(await upload.arrayBuffer()) }));
    successful(await f.share(composition()));
    const accepted = successful(await f.put());
    assert.equal(accepted.metadata.chapterComposition.entries[0].path, '/chapter/1');
    assert.equal(await readFile(join(f.directory, '1', 'content.html'), 'utf8'), bytes);
  } finally { await f.close(); }
  const unknown = await fixture();
  try {
    successful(await unknown.put());
    await mkdir(join(unknown.directory, '1')); await writeFile(join(unknown.directory, '1', 'content.txt'), 'unproven bytes');
    const before = await readFile(unknown.file);
    successful(await unknown.share(composition()));
    assert.equal((await unknown.put()).statusCode, 409);
    assert.deepEqual(await readFile(unknown.file), before);
  } finally { await unknown.close(); }
});

test('legacy metadata without shared composition retains its existing timestamp behavior', async () => {
  const f = await fixture();
  try {
    const newer = composition(undefined, 200); newer.entries[0].user.name = 'Existing latest';
    successful(await f.put(newer));
    const stale = composition(undefined, 100); stale.entries[0].user.name = 'Older';
    assert.equal(successful(await f.put(stale)).metadata.chapterComposition.entries[0].user.name, 'Existing latest');
  } finally { await f.close(); }
});

test('opening a genuine pre-user-state schema adds an empty namespace without importing or altering old state', async () => {
  const f = await fixture();
  let next: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    successful(await f.put(composition()));
    const bytes = await readFile(f.file), password = await readFile(join(f.dataDir, 'admin-password.hash'));
    await f.app.close();
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    let checksum: unknown;
    try {
      checksum = db.prepare('SELECT checksum FROM schema_state').get()?.checksum;
      db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('pre-existing-private-scope', 'a-chapter', '{}');
      for (const table of ['user_state_category_aliases', 'user_state_operations', 'user_state_changes', 'user_state_records', 'user_state_meta']) db.exec(`DROP TABLE ${table}`);
    } finally { db.close(); }
    next = await buildApp({ dataDir: f.dataDir });
    const workspace = successful(await next.inject({ url: '/api/v1/user-state', headers: f.headers }));
    assert.equal(workspace.headRevision, 0);
    assert.deepEqual(await readFile(f.file), bytes);
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), password);
    const check = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      assert.equal(check.prepare('SELECT checksum FROM schema_state').get()?.checksum, checksum);
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM works').get()?.count, 1);
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM reading_state_entries').get()?.count, 1);
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM user_state_records').get()?.count, 0);
    } finally { check.close(); }
  } finally { await next?.close(); await f.close(); }
});
