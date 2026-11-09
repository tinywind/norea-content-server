import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.ts';
import { currentCategoryId } from '../src/user-state-current-store.ts';
import { parseUserStateCurrentSnapshot, USER_STATE_CURRENT_MAX_BYTES, type UserStateCurrentItem } from '../src/user-state-current-protocol.ts';
import { userStateEntityKey, type UserStateEntity, type UserStateValue } from '../src/user-state-protocol.ts';
import type { ChapterCompositionV1 } from '../src/chapter-composition.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const work = (sourceNovelId = 'novel-1') => ({ pluginId: 'example-source', sourceNovelId, novelPath: `/novel/${sourceNovelId}`, name: 'A work' });
const library = (id = 'novel-1'): UserStateEntity => ({ kind: 'library', work: work(id) });
const reading = (id = 'novel-1'): UserStateEntity => ({ kind: 'reading', work: work(id), chapter: { chapterPath: '/chapter/1' } });
const bookmark = (): UserStateEntity => ({ kind: 'bookmark', work: work(), chapter: { chapterPath: '/chapter/1' } });
const category = (id: string): UserStateEntity => ({ kind: 'category', categoryId: id });
const membership = (id: string): UserStateEntity => ({ kind: 'membership', work: work(), categoryId: id });
const item = (entity: UserStateEntity, value: UserStateValue): UserStateCurrentItem => ({ entity, value });
function composition(count = 2, padding = ''): ChapterCompositionV1 {
  return { version: 1, updatedAt: 100, entries: Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`, path: `norea-composed:entry-${index}`, storageChapterNumber: String(index + 1), primarySource: 0,
    sources: [{ pluginId: 'example-source', novelId: 'novel-1', novelPath: '/novel/novel-1', chapterPath: `/source/${index}`, sourceChapterId: `source-${index}`,
      chapterNumber: String(index + 1), name: padding || `Source ${index}`, position: index, page: '1', contentType: 'text', releaseTime: padding || null }],
    user: { included: index !== 1, order: index === 0 ? 1 : index === 1 ? 0 : index, name: padding || null, chapterNumber: null },
  })) };
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-current-state-'));
  const app = await buildApp({ dataDir });
  const headers = await deviceHeaders(app, 'Same name'), second = await deviceHeaders(app, 'Same name');
  const initial = parseUserStateCurrentSnapshot((await app.inject({ url: '/api/v1/user-state/current', headers })).json());
  const scope = { version: 2 as const, workspaceId: initial.workspaceId, epoch: initial.epoch };
  const post = (items: unknown[], author = headers, binding = scope) => app.inject({ method: 'POST', url: '/api/v1/user-state/current', headers: author, payload: { ...binding, items } });
  const get = (author = headers) => app.inject({ url: '/api/v1/user-state/current', headers: author });
  return { app, dataDir, headers, second, initial, scope, post, get, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
function result(response: { statusCode: number; body: string; json: () => unknown }) {
  assert.equal(response.statusCode, 200, response.body.slice(0, 1200)); return parseUserStateCurrentSnapshot(response.json());
}
const find = (items: UserStateCurrentItem[], entity: UserStateEntity) => items.find(value => userStateEntityKey(value.entity) === userStateEntityKey(entity))!;

test('one stable current workspace joins devices, preserves absence and rejects obsolete history clients', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(result(await f.get(f.second)), f.initial); assert.notEqual(f.scope.workspaceId, f.scope.epoch);
    const caps = (await f.app.inject('/api/v1/capabilities')).json();
    assert.equal(caps.userStateVersion, 2); assert.equal(caps.userStateCurrentVersion, 2); assert.equal(caps.readingStateVersion, 1);
    assert.equal((await f.get()).headers['cache-control'], 'no-store');
    for (const suffix of ['', '/read', '/merge']) assert.equal((await f.app.inject({ method: suffix ? 'POST' : 'GET', url: '/api/v1/user-state' + suffix, headers: f.headers, ...(suffix ? { payload: {} } : {}) })).statusCode, 426);
    result(await f.post([item(library(), { inLibrary: true, addedAt: 20 })]));
    const b = result(await f.post([item(bookmark(), { bookmarked: true })], f.second));
    assert.equal(b.items.length, 2); assert.deepEqual(result(await f.post([], f.second)), b); assert.deepEqual(result(await f.post(b.items)), b);
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try { for (const table of ['user_state_operations', 'user_state_changes', 'user_state_records']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0); } finally { db.close(); }
  } finally { await f.close(); }
});

test('anonymous, console, blocked and wrong-workspace access cannot read or write current state', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/api/v1/user-state/current')).statusCode, 401);
    assert.equal((await f.get(await consoleHeaders(f.app, f.dataDir))).statusCode, 403);
    assert.equal((await f.post([], f.headers, { ...f.scope, epoch: randomUUID() })).statusCode, 409);
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite')); try { db.prepare('UPDATE devices SET blocked=1').run(); } finally { db.close(); }
    assert.equal((await f.get()).statusCode, 403); assert.equal((await f.post([])).statusCode, 403);
  } finally { await f.close(); }
});

test('blocking a device while its bulk body arrives prevents the final transaction', async () => {
  const f = await fixture(), db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const body = Buffer.from(JSON.stringify({ ...f.scope, items: [item(library(), { inLibrary: true, addedAt: 1 })] }));
    db.prepare('UPDATE devices SET last_seen_at=0').run();
    let finish!: (value: number | Error) => void; const finished = new Promise<number | Error>(resolve => { finish = resolve; });
    request = httpRequest(`${address}/api/v1/user-state/current`, { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json', 'content-length': body.length } }, response => { response.resume(); finish(response.statusCode!); });
    request.on('error', finish); request.write(body.subarray(0, 12));
    for (let attempt = 0; attempt < 100; attempt++) { if (Number(db.prepare('SELECT max(last_seen_at) AS seen FROM devices').get()?.seen) > 0) break; await delay(5); }
    assert(Number(db.prepare('SELECT max(last_seen_at) AS seen FROM devices').get()?.seen) > 0);
    db.prepare('UPDATE devices SET blocked=1').run(); request.end(body.subarray(12));
    assert.equal(await finished, 403); assert.equal(db.prepare('SELECT count(*) AS n FROM user_state_current_records').get()?.n, 0);
  } finally { request?.destroy(); db.close(); await f.close(); }
});

test('older snapshots cannot regress reading or initial library time, newer reading tuples remain atomic', async () => {
  const f = await fixture();
  try {
    result(await f.post([item(library(), { inLibrary: true, addedAt: 10 }), item(reading(), { progress: 80, unread: false, readAt: 20 }), item(bookmark(), { bookmarked: true })]));
    let current = result(await f.post([item(library(), { inLibrary: true, addedAt: 30 }), item(reading(), { progress: 10, unread: true, readAt: 10 })], f.second));
    assert.deepEqual(find(current.items, reading()).value, { progress: 80, unread: false, readAt: 20 }); assert.deepEqual(find(current.items, library()).value, { inLibrary: true, addedAt: 10 }); assert(find(current.items, bookmark()));
    current = result(await f.post([item(reading(), { progress: 5, unread: true, readAt: 30 })])); assert.deepEqual(find(current.items, reading()).value, { progress: 5, unread: true, readAt: 30 });
    current = result(await f.post([item(reading(), { progress: 30, unread: false, readAt: 30 })])); assert.deepEqual(find(current.items, reading()).value, { progress: 30, unread: false, readAt: 30 });
    assert.equal((await f.post([item(library(), { inLibrary: false, addedAt: null })])).statusCode, 400); assert.equal(result(await f.get()).items.length, 3);
  } finally { await f.close(); }
});

test('exact category names avoid row-ID collisions and forced rename without permanent UUID-to-name aliases', async () => {
  const f = await fixture();
  try {
    result(await f.post([item(category('same-id'), { name: 'Old', sort: 5, deleted: false }), item(membership('same-id'), { included: true })]));
    const current = result(await f.post([item(category('same-id'), { name: ' New ', sort: 3, deleted: false }), item(membership('same-id'), { included: true }), item(category('other-id'), { name: 'Old', sort: 2, deleted: false })], f.second));
    assert.equal(current.items.length, 4);
    for (const name of ['New', 'Old']) { assert(find(current.items, category(currentCategoryId(name)))); assert(find(current.items, membership(currentCategoryId(name)))); }
    assert.deepEqual(find(current.items, category(currentCategoryId('Old'))).value, { name: 'Old', sort: 2, deleted: false });
    result(await f.post([item(category('same-id'), { name: 'Old', sort: 4, deleted: false }), item(membership('same-id'), { included: true })]));
    assert.equal((await f.post([item(library('uncommitted'), { inLibrary: true, addedAt: 1 }), item(membership('unknown'), { included: true })])).statusCode, 400);
    assert.equal(result(await f.get()).items.length, 4);
  } finally { await f.close(); }
});

test('portable identity ignores labels and rejects numeric recovered paths or missing synthetic ownership', async () => {
  const f = await fixture();
  try {
    result(await f.post([item(library('ABC'), { inLibrary: true, addedAt: 1 })]));
    const renamed: UserStateEntity = { kind: 'library', work: { ...work('abc'), novelPath: '/new/path', name: 'Other label' } };
    assert.equal(result(await f.post([item(renamed, { inLibrary: true, addedAt: 2 })], f.second)).items.length, 1);
    for (const path of ['norea-folder:12', 'local-folder:99', 'norea-composed:entry-without-proof']) assert.equal((await f.post([item({ kind: 'reading', work: work(), chapter: { chapterPath: path } }, { progress: 10, unread: false, readAt: 1 })])).statusCode, 400);
    assert.equal((await f.post([{ entity: { kind: 'library', work: { ...work(), sourceNovelId: null } }, value: { inLibrary: true, addedAt: null } }])).statusCode, 400);
  } finally { await f.close(); }
});

test('resume keeps newer anchors and synthetic ownership mismatch rolls the entire bulk transaction back', async () => {
  const f = await fixture();
  try {
    const resume: UserStateEntity = { kind: 'resume', work: work() }; const anchor = { segmentIndex: 1, segmentCount: 3, offset: 0.25, progress: 40, savedAt: 1000 };
    result(await f.post([item(resume, { chapter: { chapterPath: '/chapter/1' }, anchor, openedAt: 20 })]));
    const current = result(await f.post([item(resume, { chapter: { chapterPath: '/chapter/2' }, anchor: null, openedAt: 10 })], f.second));
    assert.deepEqual(find(current.items, resume).value, { chapter: { chapterPath: '/chapter/1' }, anchor, openedAt: 20 });
    const synthetic: UserStateEntity = { kind: 'reading', work: work(), chapter: { chapterPath: 'norea-composed:shared', compositionEntryId: 'owner-a' } };
    result(await f.post([item(synthetic, { progress: 90, unread: false, readAt: 40 })]));
    const changed = { ...synthetic, chapter: { ...synthetic.chapter, compositionEntryId: 'owner-b' } };
    assert.equal((await f.post([item(library('must-not-save'), { inLibrary: true, addedAt: 1 }), item(changed, { progress: 1, unread: true, readAt: 50 })])).statusCode, 409);
    assert.equal(find(result(await f.get()).items, library('must-not-save')), undefined);
    assert.equal((await f.post([item(resume, { chapter: null, anchor: null, openedAt: 50 })])).statusCode, 400);
  } finally { await f.close(); }
});

test('composition retains excluded provenance and selects the newest current manual document', async () => {
  const f = await fixture();
  try {
    const entity: UserStateEntity = { kind: 'composition', work: work() }; const a = composition(); a.entries[0].user.name = 'First';
    result(await f.post([item(entity, { composition: a })])); const b = structuredClone(a); b.updatedAt = 200; b.entries[0].user.name = 'Newest';
    result(await f.post([item(entity, { composition: b })], f.second)); assert.deepEqual(find(result(await f.post([item(entity, { composition: a })])).items, entity).value, { composition: b });
    assert.equal((await f.post([{ entity, value: { composition: null } }])).statusCode, 400);
  } finally { await f.close(); }
});

test('a single bulk transaction accepts 5505 rows without growing legacy operation history', async () => {
  const f = await fixture();
  try {
    const items = Array.from({ length: 5505 }, (_, i) => item(reading('book-' + i), { progress: i % 101, unread: false, readAt: i + 1 }));
    const saved = result(await f.post(items)); assert.equal(saved.items.length, 5505); assert.deepEqual(result(await f.post(items, f.second)), saved);
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite')); try { assert.equal(db.prepare('SELECT count(*) AS n FROM user_state_current_records').get()?.n, 5505); assert.equal(db.prepare('SELECT count(*) AS n FROM user_state_operations').get()?.n, 0); } finally { db.close(); }
    assert.equal((await f.post([{ entity: library(), value: { inLibrary: true, addedAt: 1 }, operationId: randomUUID() }])).statusCode, 400);
  } finally { await f.close(); }
});

test('oversized current response rolls back while the preceding snapshot remains readable', async () => {
  const f = await fixture();
  try {
    const large = composition(1200, 'x'.repeat(4096));
    for (const id of ['large-1', 'large-2']) result(await f.post([item({ kind: 'composition', work: work(id) }, { composition: large })]));
    const before = result(await f.get()); assert.equal(before.items.length, 2);
    assert.equal((await f.post([item({ kind: 'composition', work: work('large-3') }, { composition: large })])).statusCode, 413);
    const after = await f.get(); assert(Buffer.byteLength(after.body) <= USER_STATE_CURRENT_MAX_BYTES); assert.deepEqual(result(after), before);
  } finally { await f.close(); }
});

test('v2 imports positive v1 current values once and preserves original state, private rows and credentials', async () => {
  const f = await fixture(); let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const password = await readFile(join(f.dataDir, 'admin-password.hash')); await writeFile(join(f.dataDir, 'original.txt'), 'original retained'); await f.app.close();
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite')); const positive = item(library(), { inLibrary: true, addedAt: 7 }), negative = item(bookmark(), { bookmarked: false }); let oldRows: unknown, checksum: unknown;
    try {
      checksum = db.prepare('SELECT checksum FROM schema_state').get(); db.exec('DROP TABLE user_state_current_records; DROP TABLE user_state_current_meta');
      for (const [i, entry] of [positive, negative].entries()) { const record = { ...entry, revision: i + 1, operationId: randomUUID(), updatedAt: 1, deviceId: 'old-device', deviceName: 'Same name' }; db.prepare('INSERT INTO user_state_records(entity_key,kind,revision,record) VALUES(?,?,?,?)').run(userStateEntityKey(entry.entity), entry.entity.kind, i + 1, JSON.stringify(record)); }
      db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('private-profile', 'private-chapter', '{}'); oldRows = db.prepare('SELECT * FROM user_state_records ORDER BY entity_key').all();
    } finally { db.close(); }
    restarted = await buildApp({ dataDir: f.dataDir }); const current = result(await restarted.inject({ url: '/api/v1/user-state/current', headers: f.headers }));
    assert.deepEqual(current.items, [positive]); assert.equal(current.workspaceId, f.scope.workspaceId); assert.equal(current.epoch, f.scope.epoch);
    const check = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try { assert.deepEqual(check.prepare('SELECT * FROM user_state_records ORDER BY entity_key').all(), oldRows); assert.deepEqual(check.prepare('SELECT checksum FROM schema_state').get(), checksum); assert.equal(check.prepare('SELECT count(*) AS n FROM reading_state_entries').get()?.n, 1); check.prepare('UPDATE user_state_records SET record=? WHERE entity_key=?').run(JSON.stringify({ ...positive, value: { inLibrary: true, addedAt: 1 } }), userStateEntityKey(positive.entity)); } finally { check.close(); }
    await restarted.close(); restarted = await buildApp({ dataDir: f.dataDir }); assert.deepEqual(result(await restarted.inject({ url: '/api/v1/user-state/current', headers: f.headers })).items, [positive]);
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), password); assert.equal(await readFile(join(f.dataDir, 'original.txt'), 'utf8'), 'original retained');
  } finally { await restarted?.close(); await f.close(); }
});
