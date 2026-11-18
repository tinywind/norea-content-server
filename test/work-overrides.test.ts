import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { digest } from '../src/packages.ts';
import { mergeWorkOverride, parseWorkOverride, type WorkOverrideV1 } from '../src/work-overrides.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const identity = (novelId = 'Book') => ({ pluginId: 'example', novelId, novelPath: '/books/' + novelId });
const workId = (novelId = 'Book') => digest(JSON.stringify(['example', '/books/' + novelId]));
const metadata = (novelId = 'Book') => ({ schemaVersion: 1, identity: identity(novelId),
  novel: { name: novelId, author: null, artist: null, summary: null, status: 'Ongoing', rating: null, genres: null, isLocal: false },
  cover: null, chapters: {} });
const override = (fields: Record<string, unknown>, novelId = 'Book') => ({ schemaVersion: 1, identity: identity(novelId), fields });
const completed = (value: boolean | null, updatedAt: number) => ({ completed: { value, updatedAt } });
const url = (novelId = 'Book') => '/api/v1/works/' + workId(novelId) + '/override';

async function fixture(anonymousRead = false, works = ['Book']) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/work-overrides-'));
  const app = await buildApp({ dataDir, anonymousRead });
  const headers = await deviceHeaders(app);
  for (const novelId of works) {
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/works/' + workId(novelId), headers, payload: metadata(novelId) });
    assert.equal(saved.statusCode, 200, saved.body);
  }
  const put = (payload: unknown, novelId = 'Book') => app.inject({ method: 'PUT', url: url(novelId), headers, payload: payload as object });
  const get = (novelId = 'Book') => app.inject({ url: url(novelId), headers });
  const feed = (query = '') => app.inject({ url: '/api/v1/work-overrides' + query, headers });
  const file = (novelId = 'Book') => join(dataDir, 'contents/example', novelId, 'override.json');
  return { app, dataDir, headers, put, get, feed, file, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('accepts the contract example, drops unknown top-level keys, and preserves unknown fields verbatim', () => {
  const example = { schemaVersion: 1, identity: { pluginId: 'goodtoon-webtoon', novelId: 'gt-16195', novelPath: '/manga/gt-16195/' },
    fields: { completed: { value: true, updatedAt: 1763350000000 } } };
  assert.deepEqual(parseWorkOverride(example), example);
  const { schemaVersion: _version, ...unversioned } = example;
  assert.deepEqual(parseWorkOverride(unversioned), example);
  const fields = { title: { value: 'Custom title', updatedAt: 3 }, rating: { value: 4.5, updatedAt: 2 }, completed: { value: null, updatedAt: 1 },
    futureFlag: { value: false, updatedAt: Number.MAX_SAFE_INTEGER }, constructor: { value: 'x'.repeat(8192), updatedAt: 5 } };
  const parsed = parseWorkOverride({ ...example, extra: true, fields });
  assert.deepEqual(parsed, { ...example, fields });
  assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'identity', 'fields']);
  assert.deepEqual(Object.keys(parsed.fields), ['completed', 'constructor', 'futureFlag', 'rating', 'title']);
});

test('rejects invalid override shapes', () => {
  const entry = { value: true, updatedAt: 1 };
  const invalid: [string, unknown][] = [
    ['not an object', []],
    ['another version', { ...override(completed(true, 1)), schemaVersion: 2 }],
    ['a textual version', { ...override(completed(true, 1)), schemaVersion: '1' }],
    ['a missing identity', { schemaVersion: 1, fields: {} }],
    ['an empty plugin ID', { ...override({}), identity: { ...identity(), pluginId: '' } }],
    ['an unsafe source ID', { ...override({}), identity: { ...identity(), novelId: '../Book' } }],
    ['an empty path', { ...override({}), identity: { ...identity(), novelPath: ' ' } }],
    ['a recovered folder path', { ...override({}), identity: { ...identity(), novelPath: 'norea-folder:1' } }],
    ['missing fields', { schemaVersion: 1, identity: identity() }],
    ['array fields', override([] as unknown as Record<string, unknown>)],
    ['an uppercase field name', override({ Completed: entry })],
    ['a numeric field name', override({ '1abc': entry })],
    ['a punctuated field name', override({ 'my-field': entry })],
    ['an overlong field name', override({ ['a'.repeat(65)]: entry })],
    ['a bare field value', override({ completed: true })],
    ['an extra entry key', override({ note: { ...entry, source: 'device' } })],
    ['a missing timestamp', override({ note: { value: 'text' } })],
    ['a missing value', override({ note: { updatedAt: 1 } })],
    ['a zero timestamp', override({ note: { value: 'text', updatedAt: 0 } })],
    ['a fractional timestamp', override({ note: { value: 'text', updatedAt: 1.5 } })],
    ['an unsafe timestamp', override({ note: { value: 'text', updatedAt: Number.MAX_SAFE_INTEGER + 1 } })],
    ['a textual timestamp', override({ note: { value: 'text', updatedAt: '1' } })],
    ['an object value', override({ note: { value: {}, updatedAt: 1 } })],
    ['an array value', override({ note: { value: [], updatedAt: 1 } })],
    ['a nonfinite number', override({ note: { value: Number.POSITIVE_INFINITY, updatedAt: 1 } })],
    ['an overlong string', override({ note: { value: 'x'.repeat(8193), updatedAt: 1 } })],
    ['a textual completion flag', override({ completed: { value: 'yes', updatedAt: 1 } })],
    ['a numeric completion flag', override({ completed: { value: 1, updatedAt: 1 } })],
    ['too many fields', override(Object.fromEntries(Array.from({ length: 65 }, (_item, index) => ['field' + index, entry])))],
  ];
  for (const [label, value] of invalid) {
    assert.throws(() => parseWorkOverride(value), (error: Error & { statusCode?: number }) => error.statusCode === 400 && /^work override: |Storage IDs/.test(error.message), label);
  }
  assert.equal(Object.keys(parseWorkOverride(override(Object.fromEntries(Array.from({ length: 64 }, (_item, index) => ['field' + index, entry])))).fields).length, 64);
  const oversized = override(Object.fromEntries(Array.from({ length: 40 }, (_item, index) => ['field' + index, { value: 'x'.repeat(8192), updatedAt: 1 }])));
  assert.throws(() => parseWorkOverride(oversized), (error: Error & { statusCode?: number }) => error.statusCode === 413);
});

test('merges per field: newer wins, a tie keeps the base, and a cleared value propagates', () => {
  const base = parseWorkOverride(override({ completed: { value: true, updatedAt: 10 }, title: { value: 'Base', updatedAt: 10 }, baseOnly: { value: 1, updatedAt: 1 } }));
  const incoming = parseWorkOverride({ ...override({ completed: { value: null, updatedAt: 11 }, title: { value: 'Incoming', updatedAt: 10 }, incomingOnly: { value: 'kept', updatedAt: 1 } }),
    identity: { pluginId: 'other', novelId: 'Elsewhere', novelPath: '/other' } });
  const merged = mergeWorkOverride(base, incoming);
  assert.deepEqual(merged, override({ baseOnly: { value: 1, updatedAt: 1 }, completed: { value: null, updatedAt: 11 }, incomingOnly: { value: 'kept', updatedAt: 1 }, title: { value: 'Base', updatedAt: 10 } }));
  assert.deepEqual(Object.keys(merged.fields), ['baseOnly', 'completed', 'incomingOnly', 'title']);
  assert.deepEqual(mergeWorkOverride(merged, incoming), merged);
  assert.deepEqual(mergeWorkOverride(merged, merged), merged);
  const older = parseWorkOverride(override(completed(false, 9)));
  assert.deepEqual(mergeWorkOverride(base, older), base);
  assert.deepEqual(mergeWorkOverride(older, base).fields.completed, { value: true, updatedAt: 10 });
  const reversed = mergeWorkOverride(incoming, base);
  assert.deepEqual(reversed.identity, incoming.identity);
  assert.deepEqual(reversed.fields.title, { value: 'Incoming', updatedAt: 10 });
  assert.deepEqual(reversed.fields.completed, merged.fields.completed);
});

test('stores merged overrides with a revision that advances only when the document changes', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/api/v1/capabilities')).json().workOverrideVersion, 1);
    const missing = await f.get();
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().message, 'Work override not found');
    const empty = await f.put(override({}));
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json(), { revision: 0, override: override({}) });
    assert.equal((await f.get()).statusCode, 404); assert.equal(existsSync(f.file()), false);

    const first = await f.put({ ...override({ ...completed(true, 10), futureField: { value: 'kept', updatedAt: 4 } }), ignored: true });
    assert.equal(first.statusCode, 200, first.body);
    const stored = override({ ...completed(true, 10), futureField: { value: 'kept', updatedAt: 4 } });
    assert.deepEqual(first.json(), { revision: 1, override: stored });
    assert.equal(first.headers['cache-control'], 'no-store');
    const read = await f.get();
    assert.equal(read.statusCode, 200); assert.deepEqual(read.json(), { revision: 1, override: stored });
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(await readFile(f.file(), 'utf8')), stored);
    const written = (await stat(f.file())).mtimeMs;

    for (const repeated of [stored, override(completed(false, 10)), override(completed(false, 9)), override({})]) {
      const response = await f.put(repeated);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { revision: 1, override: stored });
    }
    assert.equal((await stat(f.file())).mtimeMs, written);

    const cleared = await f.put(override(completed(null, 11)));
    const next = override({ ...completed(null, 11), futureField: { value: 'kept', updatedAt: 4 } });
    assert.deepEqual(cleared.json(), { revision: 2, override: next });
    assert.deepEqual((await f.get()).json(), { revision: 2, override: next });
    assert.deepEqual(JSON.parse(await readFile(f.file(), 'utf8')), next);
    await f.app.close();
    const restarted = await buildApp({ dataDir: f.dataDir, anonymousRead: false });
    try {
      assert.deepEqual((await restarted.inject({ url: url(), headers: f.headers })).json(), { revision: 2, override: next });
      const later = await restarted.inject({ method: 'PUT', url: url(), headers: f.headers, payload: override(completed(false, 12)) });
      assert.equal(later.json().revision, 3);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('rejects malformed uploads, identity mismatches, unknown works, and local works without storing anything', async () => {
  const f = await fixture(false, ['Book', 'Other']);
  try {
    const rejected = async (response: Awaited<ReturnType<typeof f.put>>, status: number, message?: RegExp) => {
      assert.equal(response.statusCode, status, response.body);
      if (message) assert.match(response.json().message, message);
    };
    await rejected(await f.put(override({ completed: { value: 'yes', updatedAt: 1 } })), 400, /^work override: /);
    await rejected(await f.put({ ...override(completed(true, 1)), schemaVersion: 2 }), 400, /^work override: invalid version/);
    await rejected(await f.put(override(completed(true, 1), 'Other')), 400, /does not match requested ID/);
    await rejected(await f.put({ ...override(completed(true, 1)), identity: { ...identity(), novelId: 'Renamed' } }), 400, /does not match the stored work/);
    await rejected(await f.put(override(completed(true, 1), 'Missing'), 'Missing'), 404, /^Work not found$/);
    await rejected(await f.get('Missing'), 404, /^Work not found$/);
    await rejected(await f.app.inject({ method: 'PUT', url: '/api/v1/works/not-an-id/override', headers: f.headers, payload: override(completed(true, 1)) }), 400);
    const local = { schemaVersion: 1, identity: { pluginId: 'local', novelId: 'Book', novelPath: '/local/book' }, fields: completed(true, 1) };
    await rejected(await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + digest(JSON.stringify(['local', '/local/book'])) + '/override', headers: f.headers, payload: local }), 400, /^Local works cannot/);
    const large = override(Object.fromEntries(Array.from({ length: 40 }, (_item, index) => ['field' + index, { value: 'x'.repeat(8192), updatedAt: 1 }])));
    await rejected(await f.put(large), 413);
    assert.deepEqual((await f.feed()).json(), { items: [], cursor: 0, hasMore: false });
    assert.equal(existsSync(f.file()), false);

    const half = (prefix: string) => override(Object.fromEntries(Array.from({ length: 40 }, (_item, index) => [prefix + index, { value: true, updatedAt: 1 }])));
    assert.equal((await f.put(half('left'))).statusCode, 200);
    await rejected(await f.put(half('right')), 400, /^work override: too many fields/);
    assert.equal(Object.keys((await f.get()).json().override.fields).length, 40);
    assert.equal((await f.get()).json().revision, 1);
  } finally { await f.close(); }
});

test('indexed local works cannot receive or expose an override', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/work-overrides-local-'));
  const local = { pluginId: 'local', novelId: 'Book', novelPath: '/local/book' };
  const directory = join(dataDir, 'contents/local/Book');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'novel.json'), JSON.stringify({ identity: local, novel: { name: 'Local book', isLocal: true } }));
  await writeFile(join(directory, 'override.json'), JSON.stringify({ schemaVersion: 1, identity: local, fields: completed(true, 1) }));
  const app = await buildApp({ dataDir, anonymousRead: true });
  try {
    const id = digest(JSON.stringify(['local', '/local/book']));
    assert.equal((await app.inject('/api/v1/works/' + id)).statusCode, 200);
    const read = await app.inject('/api/v1/works/' + id + '/override');
    assert.equal(read.statusCode, 404); assert.equal(read.json().message, 'Work override not found');
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/works/' + id + '/override', headers: await deviceHeaders(app), payload: { schemaVersion: 1, identity: local, fields: completed(true, 2) } });
    assert.equal(saved.statusCode, 400, saved.body);
    assert.deepEqual((await app.inject('/api/v1/work-overrides')).json().items, []);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('pages the change feed in revision order with one entry per work and never reuses a revision', async () => {
  const f = await fixture(false, ['Book', 'Second', 'Third']);
  try {
    assert.deepEqual((await f.feed('?after=7')).json(), { items: [], cursor: 7, hasMore: false });
    assert.equal((await f.put(override(completed(true, 1)))).json().revision, 1);
    assert.equal((await f.put(override(completed(false, 1), 'Second'), 'Second')).json().revision, 2);
    assert.equal((await f.put(override(completed(null, 1), 'Third'), 'Third')).json().revision, 3);
    assert.equal((await f.put(override(completed(false, 2)))).json().revision, 4);
    const all = (await f.feed()).json();
    assert.deepEqual(all, { items: [
      { workId: workId('Second'), revision: 2, override: override(completed(false, 1), 'Second') },
      { workId: workId('Third'), revision: 3, override: override(completed(null, 1), 'Third') },
      { workId: workId(), revision: 4, override: override(completed(false, 2)) },
    ], cursor: 4, hasMore: false });
    const first = (await f.feed('?limit=2')).json();
    assert.deepEqual(first.items.map((item: { revision: number }) => item.revision), [2, 3]);
    assert.equal(first.cursor, 3); assert.equal(first.hasMore, true);
    const second = (await f.feed('?after=3&limit=2')).json();
    assert.deepEqual(second.items.map((item: { workId: string }) => item.workId), [workId()]);
    assert.equal(second.cursor, 4); assert.equal(second.hasMore, false);
    assert.deepEqual((await f.feed('?after=4')).json(), { items: [], cursor: 4, hasMore: false });
    assert.deepEqual((await f.feed('?after=2&limit=1')).json().items.map((item: { revision: number }) => item.revision), [3]);
    for (const query of ['?limit=0', '?limit=101', '?after=-1', '?after=x']) assert.equal((await f.feed(query)).statusCode, 400, query);

    assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/v1/works/' + workId(), headers: f.headers })).statusCode, 200);
    assert.deepEqual((await f.feed()).json().items.map((item: { revision: number }) => item.revision), [2, 3]);
    assert.equal((await f.put(override(completed(true, 2), 'Second'), 'Second')).json().revision, 5);
    assert.deepEqual((await f.feed('?after=4')).json().items.map((item: { workId: string }) => item.workId), [workId('Second')]);
  } finally { await f.close(); }
});

test('reads follow the anonymous-read policy while uploads always require a device key', async () => {
  const open = await fixture(true);
  try {
    assert.equal((await open.put(override(completed(true, 1)))).statusCode, 200);
    assert.equal((await open.app.inject(url())).statusCode, 200);
    assert.equal((await open.app.inject('/api/v1/work-overrides')).statusCode, 200);
    const unknown = { authorization: 'Bearer ' + '0'.repeat(64) };
    assert.equal((await open.app.inject({ url: url(), headers: unknown })).statusCode, 401);
    assert.equal((await open.app.inject({ url: '/api/v1/work-overrides', headers: unknown })).statusCode, 401);
    const admin = await consoleHeaders(open.app, open.dataDir);
    assert.equal((await open.app.inject({ url: url(), headers: admin })).statusCode, 200);
    const payload = override(completed(false, 2));
    assert.equal((await open.app.inject({ method: 'PUT', url: url(), payload })).statusCode, 401);
    assert.equal((await open.app.inject({ method: 'PUT', url: url(), headers: unknown, payload })).statusCode, 401);
    const denied = await open.app.inject({ method: 'PUT', url: url(), headers: admin, payload });
    assert.equal(denied.statusCode, 403); assert.equal(denied.json().message, 'Device key required');
    assert.deepEqual((await open.get()).json(), { revision: 1, override: override(completed(true, 1)) });
  } finally { await open.close(); }
  const closed = await fixture(false);
  try {
    assert.equal((await closed.put(override(completed(true, 1)))).statusCode, 200);
    assert.equal((await closed.app.inject(url())).statusCode, 401);
    assert.equal((await closed.app.inject('/api/v1/work-overrides')).statusCode, 401);
    assert.equal((await closed.get()).statusCode, 200);
    assert.equal((await closed.feed()).statusCode, 200);
    const db = openDatabase(closed.dataDir);
    try { db.prepare('UPDATE devices SET blocked=1').run(); } finally { db.close(); }
    assert.equal((await closed.get()).statusCode, 403);
    assert.equal((await closed.put(override(completed(false, 2)))).statusCode, 403);
  } finally { await closed.close(); }
});

for (const access of ['console', 'device']) test(`${access} work deletion removes the override and a restore does not resurrect it`, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.put(override(completed(true, 1)))).json().revision, 1);
    const removed = await f.app.inject({ method: 'DELETE', url: `/api/v1/${access === 'console' ? 'admin/' : ''}works/${workId()}`,
      headers: access === 'console' ? await consoleHeaders(f.app, f.dataDir) : f.headers });
    assert.equal(removed.statusCode, 200, removed.body);
    const db = openDatabase(f.dataDir);
    try { assert.equal((db.prepare('SELECT count(*) AS n FROM work_overrides').get() as { n: number }).n, 0); } finally { db.close(); }
    assert.equal(existsSync(f.file()), false);
    assert.deepEqual((await f.feed()).json(), { items: [], cursor: 0, hasMore: false });
    const gone = await f.get();
    assert.equal(gone.statusCode, 410); assert.equal(gone.json().message, 'Work was deleted from the server');
    assert.equal((await f.put(override(completed(false, 2)))).statusCode, 410);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + workId() + '?restore=true', headers: f.headers, payload: metadata() })).statusCode, 200);
    const restored = await f.get();
    assert.equal(restored.statusCode, 404); assert.equal(restored.json().message, 'Work override not found');
    assert.deepEqual((await f.put(override(completed(false, 2)))).json(), { revision: 2, override: override(completed(false, 2)) });
  } finally { await f.close(); }
});

test('merges an externally synchronized override file and ignores an invalid one', async () => {
  const f = await fixture();
  try {
    const external = override({ ...completed(true, 5), title: { value: 'From another device', updatedAt: 5 } });
    await writeFile(f.file(), JSON.stringify(external));
    assert.deepEqual((await f.feed()).json().items, []);
    assert.deepEqual((await f.get()).json(), { revision: 1, override: external });
    assert.equal(await readFile(f.file(), 'utf8'), JSON.stringify(external));
    assert.deepEqual((await f.get()).json(), { revision: 1, override: external });

    await writeFile(f.file(), JSON.stringify(override({ ...completed(false, 6), title: { value: 'Stale', updatedAt: 4 } }), null, 4));
    const merged = override({ ...completed(false, 6), title: { value: 'From another device', updatedAt: 5 } });
    assert.deepEqual((await f.get()).json(), { revision: 2, override: merged });
    assert.deepEqual(JSON.parse(await readFile(f.file(), 'utf8')), merged);

    await writeFile(f.file(), JSON.stringify(override({ note: { value: 'file', updatedAt: 7 } })));
    const uploaded = await f.put(override(completed(true, 8)));
    const combined = override({ ...completed(true, 8), note: { value: 'file', updatedAt: 7 }, title: { value: 'From another device', updatedAt: 5 } });
    assert.deepEqual(uploaded.json(), { revision: 3, override: combined });
    assert.deepEqual(JSON.parse(await readFile(f.file(), 'utf8')), combined);

    for (const invalid of ['{ not json', JSON.stringify(override({ completed: { value: 'yes', updatedAt: 99 } })), JSON.stringify(override(completed(false, 99), 'Other'))]) {
      await writeFile(f.file(), invalid);
      assert.deepEqual((await f.get()).json(), { revision: 3, override: combined });
      assert.deepEqual(JSON.parse(await readFile(f.file(), 'utf8')), combined);
    }
    await rm(f.file());
    assert.deepEqual((await f.get()).json(), { revision: 3, override: combined });
    assert.deepEqual(JSON.parse(await readFile(f.file(), 'utf8')), combined);
    assert.deepEqual((await f.feed()).json().items.map((item: { revision: number; override: WorkOverrideV1 }) => [item.revision, item.override]), [[3, combined]]);
  } finally { await f.close(); }
});

test('filters browsed works by completion, letting a set override decide over the plugin status', async () => {
  const f = await fixture(false, ['Ongoing', 'Marked', 'Unmarked', 'Cleared']);
  try {
    for (const [novelId, status] of [['Plugin', 'Completed'], ['Finished', 'Publishing Finished'],
      ['Hiatus', 'On Hiatus'], ['Cancelled', 'Cancelled'], ['Licensed', 'Licensed'], ['Unknown', 'Unknown'],
      ['Unmarked', 'Completed'], ['Cleared', 'Completed'], ['Void', null]] as const) {
      const saved = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + workId(novelId), headers: f.headers, payload: { ...metadata(novelId), novel: { ...metadata(novelId).novel, status } } });
      assert.equal(saved.statusCode, 200, saved.body);
    }
    for (const invalidStatus of ['완결', 'completed', 'ongoing']) {
      const rejected = await f.app.inject({ method: 'PUT', url: '/api/v1/works/' + workId('Invalid_' + invalidStatus), headers: f.headers, payload: { ...metadata('Invalid'), novel: { ...metadata('Invalid').novel, status: invalidStatus } } });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.match(rejected.body, /invalid novel status/);
    }
    for (const [novelId, value] of [['Marked', true], ['Unmarked', false], ['Cleared', null]] as const) {
      assert.equal((await f.put(override(completed(value, 5), novelId), novelId)).statusCode, 200);
    }
    const names = async (completion: string) => {
      const response = await f.app.inject({ url: '/api/v1/catalog/works?completion=' + completion, headers: f.headers });
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json();
      assert.equal(page.total, page.items.length);
      return page.items.map((item: { novel: { name: string } }) => item.novel.name);
    };
    assert.deepEqual(await names('completed'), ['Cleared', 'Marked', 'Plugin']);
    assert.deepEqual(await names('ongoing'), ['Cancelled', 'Finished', 'Hiatus', 'Licensed', 'Ongoing', 'Unknown', 'Unmarked', 'Void']);
    assert.equal((await f.app.inject({ url: '/api/v1/catalog/works?completion=done', headers: f.headers })).statusCode, 400);
  } finally { await f.close(); }
});
