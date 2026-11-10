import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import type { ChapterCompositionV1 } from '../src/chapter-composition.ts';
import { USER_STATE_MAX_BYTES } from '../src/user-state.ts';
import {
  parseUserStateWorkspace, parseUserStateReadResponse, parseUserStateMergeResponse,
  userStateEntityKey, userStateWorkKey, canonicalUserStateJson,
  type UserStateEntity, type UserStateOperation, type UserStateValue, type UserStateWorkspace,
} from '../src/user-state-protocol.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const work = (sourceNovelId = 'novel-1') => ({ pluginId: 'example-source', sourceNovelId, novelPath: `/novel/${sourceNovelId}`, name: 'A work' });
const chapter = (path = '/chapter/1') => ({ chapterPath: path });
const library = (id = 'novel-1'): UserStateEntity => ({ kind: 'library', work: work(id) });
const reading = (id = 'novel-1'): UserStateEntity => ({ kind: 'reading', work: work(id), chapter: chapter() });
const bookmark = (id = 'novel-1'): UserStateEntity => ({ kind: 'bookmark', work: work(id), chapter: chapter() });
const category = (id: string): UserStateEntity => ({ kind: 'category', categoryId: id });
const membership = (id: string): UserStateEntity => ({ kind: 'membership', work: work(), categoryId: id });
const operation = (entity: UserStateEntity, value: UserStateValue, baseRevision = 0, seed = false): UserStateOperation => ({
  operationId: randomUUID(), entity, value, baseRevision, ...(seed ? { seed: true } : {}),
});
function composition(count = 2, padding = ''): ChapterCompositionV1 {
  return { version: 1, updatedAt: 1700000000000, entries: Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`, path: `norea-composed:entry-${index}`, storageChapterNumber: String(index + 1), primarySource: 0,
    sources: [{ pluginId: 'example-source', novelId: 'source-1', novelPath: '/source/1', chapterPath: `/source/1/${index}`, sourceChapterId: `source-${index}`,
      chapterNumber: String(index + 1), name: padding || `Source ${index}`, position: index, page: '1', contentType: 'text', releaseTime: padding || null }],
    user: { included: index !== 1, order: index === 0 ? 1 : index === 1 ? 0 : index, name: padding || null, chapterNumber: null },
  })) };
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-user-state-'));
  const app = await buildApp({ dataDir, anonymousRead: true });
  const headers = await deviceHeaders(app, 'Same display name');
  const second = await deviceHeaders(app, 'Same display name');
  const workspaceReply = await app.inject({ url: '/api/v1/user-state', headers });
  assert.equal(workspaceReply.statusCode, 200, workspaceReply.body);
  const workspace = parseUserStateWorkspace(workspaceReply.json());
  const scope = { workspaceId: workspace.workspaceId, epoch: workspace.epoch };
  const merge = (operations: unknown[], author = headers, binding = scope) => app.inject({ method: 'POST', url: '/api/v1/user-state/merge', headers: author, payload: { ...binding, operations } });
  const read = (after = 0, through?: number, limit = 200, author = headers) => app.inject({ method: 'POST', url: '/api/v1/user-state/read', headers: author, payload: { ...scope, after, ...(through === undefined ? {} : { through }), limit } });
  return { app, dataDir, headers, second, workspace, scope, merge, read, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
function result(response: { statusCode: number; body: string; json: () => unknown }, index = 0) {
  assert.equal(response.statusCode, 200, response.body.slice(0,1000));
  return parseUserStateMergeResponse(response.json()).results[index];
}
function page(response: { statusCode: number; body: string; json: () => unknown }) {
  assert.equal(response.statusCode, 200, response.body.slice(0,1000));
  return parseUserStateReadResponse(response.json());
}

test('user state has one stable namespace shared by admitted devices, not their display names', async () => {
  const f = await fixture();
  try {
    const other = parseUserStateWorkspace((await f.app.inject({ url: '/api/v1/user-state', headers: f.second })).json());
    assert.deepEqual(other, f.workspace);
    assert.notEqual(f.workspace.workspaceId, f.workspace.epoch);
    const capabilities = (await f.app.inject('/api/v1/capabilities')).json();
    assert.equal(capabilities.userStateVersion, 1);
    assert.equal(capabilities.userStateBulkVersion, 1);
    assert.equal(capabilities.userStateOpaqueIdentityVersion, 1);
    assert.equal(capabilities.readingStateVersion, 1);
    assert.equal(capabilities.deviceBackupVersion, 1);
    const a = result(await f.merge([operation(library(), { inLibrary: true, addedAt: 123 })]));
    const b = result(await f.merge([operation(bookmark(), { bookmarked: true })], f.second));
    assert.notEqual(a.current!.deviceId, b.current!.deviceId);
    assert.equal(a.current!.deviceName, b.current!.deviceName);
    assert.equal((await f.read()).headers['cache-control'], 'no-store');
    assert.equal(page(await f.read(0, undefined, 200, f.second)).records.length, 2);
  } finally { await f.close(); }
});

test('namespace discovery, reads and merges reject anonymous, console, blocked and wrong-workspace access', async () => {
  const f = await fixture();
  try {
    const admin = await consoleHeaders(f.app, f.dataDir);
    for (const [method, url, payload] of [
      ['GET', '/api/v1/user-state', undefined],
      ['POST', '/api/v1/user-state/read', { ...f.scope, after: 0 }],
      ['POST', '/api/v1/user-state/merge', { ...f.scope, operations: [] }],
    ] as const) {
      assert.equal((await f.app.inject({ method, url, payload })).statusCode, 401);
      assert.equal((await f.app.inject({ method, url, payload, headers: admin })).statusCode, 403);
    }
    assert.equal((await f.merge([], f.headers, { ...f.scope, workspaceId: randomUUID() })).statusCode, 409);
    assert.equal((await f.merge([], f.headers, { ...f.scope, epoch: randomUUID() })).statusCode, 409);
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try { db.prepare('UPDATE devices SET blocked=1').run(); } finally { db.close(); }
    assert.equal((await f.app.inject({ url: '/api/v1/user-state', headers: f.headers })).statusCode, 403);
    assert.equal((await f.read()).statusCode, 403);
    assert.equal((await f.merge([])).statusCode, 403);
  } finally { await f.close(); }
});

test('portable identity ignores names/local row IDs, folds only ASCII source IDs, and scopes chapter paths to works', async () => {
  const known = work('WORK-A');
  const renamed = { ...known, sourceNovelId: 'work-a', novelPath: '/different', name: '' };
  assert.equal(userStateWorkKey(known), '["example-source","id","work-a"]');
  assert.equal(userStateEntityKey({ kind: 'library', work: known }), JSON.stringify(['library', userStateWorkKey(renamed)]));
  assert.equal(canonicalUserStateJson({ z: 1, a: [false, null] }), '{"a":[false,null],"z":1}');
  assert.notEqual(userStateWorkKey(work('İ')), userStateWorkKey(work('i')));
  const f = await fixture();
  try {
    const first = result(await f.merge([operation({ kind: 'library', work: known }, { inLibrary: true, addedAt: null })]));
    assert.equal(result(await f.merge([operation({ kind: 'library', work: renamed }, { inLibrary: true, addedAt: null })])).status, 'unchanged');
    assert.equal(result(await f.merge([operation(reading('other-work'), { progress: 70, unread: false, readAt: 50 })])).status, 'applied');
    assert.equal(first.current!.revision, 1);
    const opaqueWork: UserStateEntity = { kind: 'library', work: { ...work(), sourceNovelId: null } };
    const opaqueChapter: UserStateEntity = { kind: 'reading', work: work(), chapter: { chapterPath: 'norea-folder:1' } };
    assert.equal(result(await f.merge([operation(opaqueWork, { inLibrary: true, addedAt: 9 })])).status, 'applied');
    assert.equal(result(await f.merge([operation(opaqueChapter, { progress: 33, unread: false, readAt: 9 })])).status, 'applied');
    const opaqueRecords = page(await f.read()).records;
    assert(opaqueRecords.some(record => record.entity.kind === 'library' && record.entity.work.sourceNovelId === null));
    assert(opaqueRecords.some(record => record.entity.kind === 'reading' && record.entity.chapter.chapterPath === 'norea-folder:1'));
    const currentReply = await f.app.inject({ url: '/api/v1/user-state/current', headers: f.headers });
    assert.equal(currentReply.statusCode, 200, currentReply.body);
    const currentItems = currentReply.json().items as { entity: UserStateEntity }[];
    assert(!currentItems.some(item => 'work' in item.entity && item.entity.work.sourceNovelId === null));
    assert(!currentItems.some(item => (item.entity.kind === 'reading' || item.entity.kind === 'bookmark') &&
      item.entity.chapter.chapterPath === 'norea-folder:1'));
    for (const bad of [
      { ...operation(library(), { inLibrary: true, addedAt: null }), localDatabaseId: 1 },
      { ...operation(library(), { inLibrary: true, addedAt: null }), entity: { kind: 'library', work: { ...work(), localId: 1 } } },
    ]) assert.equal((await f.merge([bad])).statusCode, 400);
  } finally { await f.close(); }
});

test('blocking a device while a user-state request body arrives prevents both reads and writes', async () => {
  for (const route of ['read', 'merge']) {
    const f = await fixture();
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    let request: ReturnType<typeof httpRequest> | undefined;
    try {
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const body = Buffer.from(JSON.stringify(route === 'read' ? { ...f.scope, after: 0 } : { ...f.scope, operations: [operation(library(), { inLibrary: true, addedAt: 1 })] }));
      db.prepare('UPDATE devices SET last_seen_at=0').run();
      let finish!: (value: number | Error) => void;
      const finished = new Promise<number | Error>(resolve => { finish = resolve; });
      request = httpRequest(`${address}/api/v1/user-state/${route}`, { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json', 'content-length': body.length } }, response => { response.resume(); finish(response.statusCode!); });
      request.on('error', finish);
      request.write(body.subarray(0, 12));
      for (let attempt = 0; attempt < 100; attempt++) {
        if (Number(db.prepare('SELECT max(last_seen_at) AS seen FROM devices').get()?.seen) > 0) break;
        await delay(5);
      }
      assert(Number(db.prepare('SELECT max(last_seen_at) AS seen FROM devices').get()?.seen) > 0);
      db.prepare('UPDATE devices SET blocked=1').run();
      request.end(body.subarray(12));
      assert.equal(await finished, 403);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_state_records').get()?.count, 0);
    } finally { request?.destroy(); db.close(); await f.close(); }
  }
});

test('independent state groups merge while explicit removal, unread, rewind and unbookmark replace prior values', async () => {
  const f = await fixture();
  try {
    const a = parseUserStateMergeResponse((await f.merge([
      operation(library(), { inLibrary: true, addedAt: 1 }),
      operation(reading(), { progress: 100, unread: false, readAt: 100 }),
      operation(bookmark(), { bookmarked: true }),
    ])).json()).results;
    const b = parseUserStateMergeResponse((await f.merge([
      operation(bookmark(), { bookmarked: false }, a[2].current!.revision),
      operation(reading(), { progress: 5, unread: true, readAt: null }, a[1].current!.revision),
      operation(library(), { inLibrary: false, addedAt: null }, a[0].current!.revision),
    ], f.second)).json()).results;
    assert(b.every(item => item.status === 'applied'));
    assert.deepEqual(b[0].current!.value, { bookmarked: false });
    assert.deepEqual(b[1].current!.value, { progress: 5, unread: true, readAt: null });
    assert.deepEqual(b[2].current!.value, { inLibrary: false, addedAt: null });
    // Existing SQLite permits this atomic legacy tuple; never manufacture or normalize another tuple.
    const legacy = result(await f.merge([operation(reading(), { progress: 100, unread: true, readAt: 200 }, b[1].current!.revision)]));
    assert.deepEqual(legacy.current!.value, { progress: 100, unread: true, readAt: 200 });
  } finally { await f.close(); }
});

test('explicit edits use server-revision last-write-wins while equivalent values and soft seeds remain idempotent', async () => {
  const f = await fixture();
  try {
    const initial = result(await f.merge([operation(library(), { inLibrary: true, addedAt: 10 }, 0, true)]));
    const removed = result(await f.merge([operation(library(), { inLibrary: false, addedAt: null }, initial.current!.revision)], f.second));
    const later = result(await f.merge([operation(library(), { inLibrary: true, addedAt: 20 }, initial.current!.revision)]));
    assert.equal(later.status, 'applied');
    assert.deepEqual(later.current!.value, { inLibrary: true, addedAt: 20 });
    assert(later.current!.revision > removed.current!.revision);
    const equal = result(await f.merge([operation(library(), { inLibrary: true, addedAt: 20 }, 0)]));
    assert.equal(equal.status, 'unchanged'); assert.equal(equal.current!.revision, later.current!.revision);
    const seed = result(await f.merge([operation(library(), { inLibrary: false, addedAt: null }, 0, true)]));
    assert.equal(seed.status, 'seed-skipped'); assert.deepEqual(seed.current, later.current);
    assert.equal((await f.merge([operation(library(), { inLibrary: true, addedAt: 10 }, 1, true)])).statusCode, 400);
    assert.equal(page(await f.read()).headRevision, 3);
  } finally { await f.close(); }
});

test('lost-response retries replay the exact durable result and operation-ID reuse is atomic', async () => {
  const f = await fixture();
  try {
    const original = operation(reading(), { progress: 40, unread: false, readAt: 100 });
    const accepted = result(await f.merge([original]));
    // Copied immutable outboxes remain idempotent under another device bearer.
    assert.deepEqual(result(await f.merge([original], f.second)), accepted);
    result(await f.merge([operation(reading(), { progress: 0, unread: true, readAt: null }, accepted.current!.revision)], f.second));
    assert.deepEqual(result(await f.merge([original])), accepted);
    const before = page(await f.read()).headRevision;
    const changed = { ...original, value: { progress: 41, unread: false, readAt: 100 } };
    assert.equal((await f.merge([operation(library('new'), { inLibrary: true, addedAt: 10 }), changed])).statusCode, 409);
    assert.equal((await f.merge([changed], f.second)).statusCode, 409);
    assert.equal(page(await f.read()).headRevision, before);
    assert.equal((await f.merge([original, original])).statusCode, 400);
    // The immutable payload includes its identity spelling, even when the semantic key is equal.
    assert.equal((await f.merge([{ ...original, entity: { kind: 'reading', work: { ...work(), sourceNovelId: 'NOVEL-1' }, chapter: chapter() } }])).statusCode, 409);
  } finally { await f.close(); }
});

test('same-name category creation aliases once, old membership IDs remain usable, and invalid rename collisions reject atomically', async () => {
  const f = await fixture();
  try {
    const first = result(await f.merge([operation(category('first'), { name: 'Favourites', sort: -5, deleted: false })]));
    const aliasOp = operation(category('second'), { name: 'Favourites', sort: 10, deleted: false }, 0, true);
    const alias = result(await f.merge([aliasOp], f.second));
    assert.equal(alias.status, 'aliased'); assert.deepEqual(alias.categoryAlias, { from: 'second', to: 'first' });
    assert.deepEqual(alias.current, first.current);
    const member = result(await f.merge([operation(membership('second'), { included: true })], f.second));
    assert.deepEqual(member.current!.entity, membership('first'));
    assert.deepEqual(member.categoryAlias, { from: 'second', to: 'first' });
    assert.deepEqual(result(await f.merge([aliasOp], f.second)), alias);
    const other = result(await f.merge([operation(category('third'), { name: 'Other', sort: 1, deleted: false })]));
    const collision = await f.merge([operation(category('third'), { name: 'Favourites', sort: 1, deleted: false }, other.current!.revision)]);
    assert.equal(collision.statusCode, 409, collision.body);
    assert.match(collision.json().message, /category name is already owned/);
  } finally { await f.close(); }
});

test('later membership edits restore a deleted category and server revision order converges without conflicts', async () => {
  const f = await fixture();
  try {
    const created = result(await f.merge([operation(category('category'), { name: 'History', sort: 0, deleted: false })]));
    const member = result(await f.merge([operation(membership('category'), { included: true })]));
    const beforeDeletion = page(await f.read()).headRevision;
    const deletion = operation(category('category'), { name: 'History', sort: 0, deleted: true }, created.current!.revision);
    const removed = result(await f.merge([deletion], f.second));
    const cascade = page(await f.read(beforeDeletion));
    assert.equal(cascade.records.length, 2);
    assert.deepEqual(cascade.records.at(-1)!.value, { included: false });

    const restoredMembership = result(await f.merge([
      operation(membership('category'), { included: true }, member.current!.revision),
    ]));
    assert.equal(restoredMembership.status, 'applied');
    assert.deepEqual(restoredMembership.current!.value, { included: true });

    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      const categoryRow = JSON.parse(String(db.prepare("SELECT record FROM user_state_records WHERE kind='category'").get()?.record));
      assert.deepEqual(categoryRow.value, { name: 'History', sort: 0, deleted: false });
      const membershipRow = JSON.parse(String(db.prepare("SELECT record FROM user_state_records WHERE kind='membership'").get()?.record));
      assert.deepEqual(membershipRow.value, { included: true });
    } finally { db.close(); }

    const excluded = result(await f.merge([
      operation(membership('category'), { included: false }, member.current!.revision),
    ], f.second));
    assert.equal(excluded.status, 'applied');
    assert.deepEqual(excluded.current!.value, { included: false });

    const beforeReplay = page(await f.read()).headRevision;
    assert.deepEqual(result(await f.merge([deletion], f.second)), removed);
    assert.equal(page(await f.read()).headRevision, beforeReplay);

    const absent = await f.merge([operation(membership('missing'), { included: true })]);
    assert.equal(absent.statusCode, 409, absent.body);
    assert.equal(result(await f.merge([operation(membership('missing'), { included: false })])).status, 'applied');
  } finally { await f.close(); }
});

test('bounded revision paging freezes a boundary and does not miss updates made while pages are read', async () => {
  const f = await fixture();
  try {
    await f.merge([1, 2, 3].map(id => operation(library(String(id)), { inLibrary: true, addedAt: null })));
    const first = page(await f.read(0, undefined, 1));
    assert.equal(first.through, 3); assert.equal(first.nextCursor, 1); assert.equal(first.hasMore, true);
    await f.merge([operation(library('1'), { inLibrary: false, addedAt: null }, 1)], f.second);
    const second = page(await f.read(first.nextCursor, first.through, 1));
    const third = page(await f.read(second.nextCursor, first.through, 1));
    assert.equal(second.headRevision, 4); assert.equal(third.nextCursor, 3); assert.equal(third.hasMore, false);
    const next = page(await f.read(third.nextCursor));
    assert.equal(next.records.length, 1); assert.equal(next.records[0].revision, 4);
    assert.deepEqual(next.records[0].value, { inLibrary: false, addedAt: null });
    assert.equal((await f.read(5)).statusCode, 409);
    assert.equal((await f.read(0, 5)).statusCode, 409);
    assert.equal((await f.read(3, 2)).statusCode, 409);
    assert.equal((await f.read(0, undefined, 201)).statusCode, 200);
  } finally { await f.close(); }
});

test('malformed batches, wrong value groups and arbitrary device state cannot partially write', async () => {
  const f = await fixture();
  try {
    const valid = operation(library(), { inLibrary: true, addedAt: null });
    for (const invalid of [
      { ...operation(reading(), { progress: 0, unread: true, readAt: null }), value: { progress: 101, unread: true, readAt: null } },
      { ...valid, deviceId: 'claimed-device' },
      { ...valid, value: { inLibrary: true, addedAt: null, credentials: 'not allowed' } },
      { ...valid, value: { bookmarked: true } },
      { ...valid, operationId: 'not an identifier' },
      { ...valid, entity: { kind: 'category', categoryId: 'x' }, value: { name: 'x'.repeat(513), sort: 0, deleted: false } },
    ]) {
      assert.equal((await f.merge([valid, invalid])).statusCode, 400);
      assert.equal(page(await f.read()).headRevision, 0);
    }
    const operations = Array.from({ length: 1681 }, (_, index) =>
      operation(library(String(index)), { inLibrary: true, addedAt: null }));
    const bulk = await f.merge(operations);
    assert.equal(bulk.statusCode, 200, bulk.body);
    assert.equal(parseUserStateMergeResponse(bulk.json()).results.length, 1681);
    const all = page(await f.read(0, undefined, 20_000));
    assert.equal(all.records.length, 1681); assert.equal(all.hasMore, false);
    assert(all.records.every(record => Object.keys(record).sort().join(',') === 'deviceId,deviceName,entity,operationId,revision,updatedAt,value'));
    const legacy = page(await f.read(0, all.through, 200));
    assert.equal(legacy.records.length, 200); assert.equal(legacy.hasMore, true);
  } finally { await f.close(); }
});

test('resume accepts portable anchors and rejects pixel/local-ID fields, and chapter ownership cannot silently change', async () => {
  const f = await fixture();
  try {
    const anchor = { segmentIndex: 1, mediaOrdinal: 0, segmentCount: 3, offset: 0.25, progress: 45, savedAt: 1700000000000 };
    const entity: UserStateEntity = { kind: 'resume', work: work() };
    const saved = result(await f.merge([operation(entity, { chapter: chapter(), anchor, openedAt: 1700000000000 })]));
    assert.deepEqual(saved.current!.value, { chapter: chapter(), anchor, openedAt: 1700000000000 });
    for (const value of [
      { chapter: null, anchor, openedAt: null },
      { chapter: chapter(), anchor: { ...anchor, novelId: 1 }, openedAt: null },
      { chapter: chapter(), anchor: { ...anchor, offset: 20 }, openedAt: null },
      { chapter: chapter(), anchor: { ...anchor, segmentIndex: 3 }, openedAt: null },
    ]) assert.equal((await f.merge([{ ...operation(entity, { chapter: null, anchor: null, openedAt: null }), value }])).statusCode, 400);
    const opaqueResume = result(await f.merge([operation(entity,
      { chapter: { chapterPath: 'local-folder:12' }, anchor: null, openedAt: 1700000000001 }, saved.current!.revision)]));
    assert.equal(opaqueResume.status, 'applied');
    assert.deepEqual(opaqueResume.current!.value, { chapter: { chapterPath: 'local-folder:12' }, anchor: null, openedAt: 1700000000001 });
    const owned: UserStateEntity = { kind: 'reading', work: work(), chapter: { ...chapter(), compositionEntryId: 'entry-a' } };
    const first = result(await f.merge([operation(owned, { progress: 10, unread: false, readAt: null })]));
    const mismatch = await f.merge([operation({ ...owned, chapter: { ...chapter(), compositionEntryId: 'entry-b' } }, { progress: 10, unread: false, readAt: null }, first.current!.revision)]);
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    assert.match(mismatch.json().message, /chapter identity mismatch/);
  } finally { await f.close(); }
});

test('composition state preserves provenance, validates documents, and later server commits win', async () => {
  const f = await fixture();
  try {
    const entity: UserStateEntity = { kind: 'composition', work: work() }, document = composition();
    const first = result(await f.merge([operation(entity, { composition: document })]));
    assert.deepEqual(first.current!.value, { composition: document });
    const changed = structuredClone(document); changed.updatedAt++; changed.entries[0].user.name = 'Edited title';
    const next = result(await f.merge([operation(entity, { composition: changed }, first.current!.revision)], f.second));
    const later = structuredClone(document); later.entries[1].user.included = true; later.entries[1].user.order = 2;
    const appliedLater = result(await f.merge([operation(entity, { composition: later }, first.current!.revision)]));
    assert.equal(appliedLater.status, 'applied');
    assert.deepEqual(appliedLater.current!.value, { composition: later });
    assert(appliedLater.current!.revision > next.current!.revision);
    assert.equal((await f.merge([{ ...operation(entity, { composition: document }), value: { composition: null } }])).statusCode, 400);
    const broken = structuredClone(document); broken.entries[1].storageChapterNumber = broken.entries[0].storageChapterNumber;
    assert.equal((await f.merge([operation(entity, { composition: broken })])).statusCode, 400);
    assert.deepEqual((page(await f.read()).records.at(-1)!.value as { composition: ChapterCompositionV1 }).composition.entries[1], later.entries[1]);
  } finally { await f.close(); }
});

test('large composition responses are byte-bounded and an oversized merge response rolls back for smaller retries', async () => {
  const f = await fixture();
  try {
    const large = composition(1200, 'x'.repeat(4096));
    const documentBytes = Buffer.byteLength(JSON.stringify(large));
    assert(documentBytes > 12 * 1024 * 1024 && documentBytes < 16 * 1024 * 1024);
    const entities: UserStateEntity[] = [1, 2, 3].map(id => ({ kind: 'composition', work: work(`large-${id}`) }));
    for (const entity of entities) result(await f.merge([operation(entity, { composition: large })]));
    const response = await f.read();
    assert(Buffer.byteLength(response.body) <= USER_STATE_MAX_BYTES);
    const first = page(response); assert.equal(first.records.length, 2); assert.equal(first.hasMore, true);
    const last = page(await f.read(first.nextCursor, first.through));
    assert.equal(last.records.length, 1); assert.equal(last.hasMore, false);
    const replacements = entities.map(entity => operation(entity, { composition: composition() }, 0, true));
    const tooLarge = await f.merge(replacements);
    assert.equal(tooLarge.statusCode, 413);
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      for (const op of replacements) assert.equal(db.prepare('SELECT 1 FROM user_state_operations WHERE operation_id=?').get(op.operationId), undefined);
    } finally { db.close(); }
    for (const op of replacements) assert.equal(result(await f.merge([op])).status, 'seed-skipped');
  } finally { await f.close(); }
});

test('additive upgrade and restart preserve original schema, credentials, legacy reading, files and operation receipts', async () => {
  const f = await fixture();
  let reopened: FastifyInstance | undefined;
  try {
    const original = operation(library(), { inLibrary: true, addedAt: 5 });
    const receipt = result(await f.merge([original]));
    result(await f.merge([operation(category('upgrade-category'), { name: 'Upgrade', sort: 0, deleted: false })]));
    result(await f.merge([operation(membership('upgrade-category'), { included: true })]));
    const beforePassword = await readFile(join(f.dataDir, 'admin-password.hash'));
    await writeFile(join(f.dataDir, 'original.txt'), 'content that must remain');
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    let checksum: unknown;
    try {
      checksum = db.prepare('SELECT checksum FROM schema_state').get()?.checksum;
      db.prepare('INSERT INTO reading_state_entries(profile_hash,entry_key,entry) VALUES(?,?,?)').run('legacy-private-profile', 'chapter', '{}');
      db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run('user-state-preserve-test', 'retained');
    } finally { db.close(); }
    await f.app.close();
    const oldShape = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      oldShape.exec(`
        DROP INDEX IF EXISTS user_state_record_kinds;
        DROP INDEX IF EXISTS user_state_active_category_names;
        DROP INDEX IF EXISTS user_state_membership_categories;
        ALTER TABLE user_state_records RENAME TO user_state_records_new_shape;
        CREATE TABLE user_state_records (
          entity_key TEXT PRIMARY KEY, kind TEXT NOT NULL, category_name TEXT, category_deleted INTEGER,
          revision INTEGER NOT NULL, record TEXT NOT NULL
        );
        INSERT INTO user_state_records(entity_key,kind,category_name,category_deleted,revision,record)
          SELECT entity_key,kind,category_name,category_deleted,revision,record FROM user_state_records_new_shape;
        DROP TABLE user_state_records_new_shape;
      `);
    } finally { oldShape.close(); }
    reopened = await buildApp({ dataDir: f.dataDir });
    const workspace = parseUserStateWorkspace((await reopened.inject({ url: '/api/v1/user-state', headers: f.headers })).json());
    assert.equal(workspace.workspaceId, f.workspace.workspaceId); assert.equal(workspace.epoch, f.workspace.epoch);
    const retry = await reopened.inject({ method: 'POST', url: '/api/v1/user-state/merge', headers: f.headers, payload: { ...f.scope, operations: [original] } });
    assert.deepEqual(result(retry), receipt);
    assert.deepEqual(await readFile(join(f.dataDir, 'admin-password.hash')), beforePassword);
    assert.equal(await readFile(join(f.dataDir, 'original.txt'), 'utf8'), 'content that must remain');
    const check = openDatabase(f.dataDir);
    try {
      assert.equal(check.prepare('SELECT checksum FROM schema_state').get()?.checksum, checksum);
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM reading_state_entries').get()?.count, 1);
      assert.equal(check.prepare('SELECT value FROM admin_settings WHERE key=?').get('user-state-preserve-test')?.value, 'retained');
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM devices').get()?.count, 2);
      assert.deepEqual({ ...(check.prepare(`SELECT membership_category_id AS categoryId,membership_included AS included
        FROM user_state_records WHERE kind='membership'`).get() as { categoryId: string; included: number }) },
        { categoryId: 'upgrade-category', included: 1 });
      assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='index' AND name='user_state_membership_categories'").get()?.count, 1);
      assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('accounts','sessions','state','state_changes','operations')").get()?.count, 0);
    } finally { check.close(); }
  } finally { await reopened?.close(); await f.close(); }
});
