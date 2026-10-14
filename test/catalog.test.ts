import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { defaultLimits, digest } from '../src/packages.ts';
import { scanFolder } from '../src/folder-indexer.ts';
import type { PackageManifest } from '../src/packages.ts';
import type { NovelMetadataV1 } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

function metadata(pluginId: string, name: string): NovelMetadataV1 {
  return { schemaVersion: 1, identity: { pluginId, novelPath: `/books/${name}` }, novel: { name, author: 'Writer', artist: null, summary: 'Summary', status: null, rating: null, genres: null, isLocal: false }, cover: null };
}
async function fixture(anonymousRead = true) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/catalog-'));
  const app = await buildApp({ dataDir, anonymousRead });
  const headers = await deviceHeaders(app);
  const putWork = async (value: NovelMetadataV1) => {
    const id = digest(JSON.stringify([value.identity.pluginId, value.identity.novelPath]));
    const response = await app.inject({ method: 'PUT', url: `/api/v1/works/${id}`, headers, payload: value });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const putChapter = async (work: NovelMetadataV1, path: string, position: number) => {
    const id = digest(JSON.stringify([work.identity.pluginId, work.identity.novelPath]));
    if ((await app.inject({ url: `/api/v1/works/${id}`, headers })).statusCode === 404) await putWork(work);
    const bytes = Buffer.from('Chapter content');
    const manifest: PackageManifest = { packageVersion: 1, layout: 'chapter-files', identity: { ...work.identity, chapterPath: path }, novel: { name: work.novel.name, isLocal: work.novel.isLocal }, chapter: { name: path, position, chapterNumber: String(position), contentType: 'html', page: '1' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: bytes.length, modifiedAt: 1 }] };
    const form = new FormData();
    form.append('metadata', JSON.stringify(manifest));
    form.append('content.html', new Blob([bytes]), 'content.html');
    const request = new Request('http://localhost', { method: 'POST', body: form });
    const response = await app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  return { app, dataDir, headers, putWork, putChapter, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('browses current work summaries with bounded pages, literal search and source counts', async () => {
  const f = await fixture();
  try {
    const a = metadata('source-a', 'Alpha'); const b = metadata('source-b', 'Beta'); const c = metadata('source-a', 'Gamma%');
    const first = await f.putWork(a); await f.putWork(b); await f.putWork(c);
    await f.putWork({ ...a, novel: { ...a.novel, summary: 'Updated' } });
    await f.putChapter(a, '/chapter/one', 1);
    const response = await f.app.inject('/api/v1/catalog/works?limit=2');
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json(); assert.equal(page.total, 3); assert.equal(page.hasMore, true);
    assert.deepEqual(page.items.map((item: { novel: { name: string } }) => item.novel.name), ['Alpha', 'Beta']);
    assert.equal(page.items[0].chapterCount, 1); assert.equal(page.items[1].chapterCount, 0);
    assert.ok(page.items[0].sequence > first.sequence); assert.equal(page.items[0].novel.summary, 'Updated');
    assert.deepEqual(Object.keys(page.items[0]).sort(), ['chapterCount', 'hasCover', 'id', 'identity', 'novel', 'sequence']);
    const next = (await f.app.inject('/api/v1/catalog/works?offset=2&limit=2')).json();
    assert.equal(next.items[0].novel.name, 'Gamma%'); assert.equal(next.hasMore, false);
    assert.deepEqual((await f.app.inject('/api/v1/catalog/works?offset=99')).json(), { items: [], total: 3, hasMore: false });
    const filtered = (await f.app.inject('/api/v1/catalog/works?source=source-a&q=ALP')).json();
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0].id, first.id);
    assert.equal((await f.app.inject('/api/v1/catalog/works?q=%25')).json().total, 1);
    assert.equal((await f.app.inject('/api/v1/catalog/works?source=missing')).json().total, 0);
    assert.deepEqual((await f.app.inject('/api/v1/catalog/sources')).json(), { items: [{ id: 'source-a', workCount: 2 }, { id: 'source-b', workCount: 1 }] });
    const [directory] = await readdir(join(f.dataDir, 'contents', 'source-a'));
    await writeFile(join(f.dataDir, 'contents', 'source-a', directory, 'novel.json'), '{broken');
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try { db.exec("UPDATE work_changes SET entry='{broken'; UPDATE catalog_changes SET entry='{broken'"); } finally { db.close(); }
    assert.equal((await f.app.inject('/api/v1/catalog/works')).statusCode, 200);
    assert.equal((await f.app.inject('/api/v1/catalog/sources')).statusCode, 200);
    assert.equal((await f.app.inject(`/api/v1/catalog/works/${first.id}/chapters`)).statusCode, 200);
  } finally { await f.close(); }
});

test('pages live chapters by position and id and resolves exact identities without deleted entries', async () => {
  const f = await fixture();
  try {
    const work = metadata('source-a', 'Alpha'); const stored = await f.putWork(work);
    const last = await f.putChapter(work, '/chapter/last?x=1&y=2', 8);
    const first = await f.putChapter(work, '/chapter/first', 1); const tied = await f.putChapter(work, '/chapter/tied', 1);
    const ordered = [first, tied].sort((a, b) => a.id.localeCompare(b.id));
    const summarize = (entry: typeof first) => ({ id: entry.id, chapterPath: entry.manifest.identity.chapterPath, position: entry.manifest.chapter.position, name: entry.manifest.chapter.name, chapterNumber: entry.manifest.chapter.chapterNumber, page: entry.manifest.chapter.page, contentType: entry.manifest.chapter.contentType });
    const page = (await f.app.inject(`/api/v1/catalog/works/${stored.id}/chapters?limit=1`)).json();
    assert.deepEqual(page, { items: [summarize(ordered[0])], total: 3, hasMore: true });
    assert.deepEqual((await f.app.inject(`/api/v1/catalog/works/${stored.id}/chapters?offset=1&limit=2`)).json(), { items: [summarize(ordered[1]), summarize(last)], total: 3, hasMore: false });
    const query = new URLSearchParams({ ...work.identity, chapterPath: last.manifest.identity.chapterPath });
    assert.deepEqual((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).json(), last);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${last.id}`, headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).statusCode, 404);
    const live = (await f.app.inject(`/api/v1/catalog/works/${stored.id}/chapters`)).json();
    assert.equal(live.total, 2); assert.deepEqual(live.items, ordered.map(summarize));
    assert.equal((await f.app.inject('/api/v1/catalog/works')).json().items[0].chapterCount, 2);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/chapters/${last.id}/restore`, headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).json().deleted, false);
    assert.equal((await f.app.inject(`/api/v1/catalog/works/${'f'.repeat(64)}/chapters`)).statusCode, 404);
    const empty = await f.putWork(metadata('source-a', 'Empty'));
    assert.deepEqual((await f.app.inject(`/api/v1/catalog/works/${empty.id}/chapters`)).json(), { items: [], total: 0, hasMore: false });
  } finally { await f.close(); }
});

test('resolves folder chapters only within the exact canonical work', async () => {
  const f = await fixture();
  try {
    const work = metadata('source-a', 'A work');
    const stored = await f.putChapter(work, 'norea-folder:7', 7);
    const query = new URLSearchParams({ ...work.identity, chapterPath: '/chapter/seven', chapterNumber: '7' });
    const lookup = () => f.app.inject(`/api/v1/catalog/chapter?${query}`);
    assert.deepEqual((await lookup()).json(), stored);
    query.set('novelPath', '/different'); assert.equal((await lookup()).statusCode, 404);
    query.set('novelPath', work.identity.novelPath);
    await f.putChapter(work, '/chapter/other', 7);
    assert.equal((await lookup()).statusCode, 409);
    const exact = await f.putChapter(work, '/chapter/seven', 7);
    assert.deepEqual((await lookup()).json(), exact);
    await f.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${exact.id}`, headers: f.headers });
    assert.equal((await lookup()).statusCode, 404);
    const other = metadata('source-a', 'Another work');
    const original = await f.putChapter(other, '/original/chapter', 3);
    const reverse = new URLSearchParams({ ...other.identity, chapterPath: 'norea-folder:3', chapterNumber: '3' });
    assert.deepEqual((await f.app.inject(`/api/v1/catalog/chapter?${reverse}`)).json(), original);
  } finally { await f.close(); }
});

test('keeps different local files separate when their chapter numbers match', async () => {
  const f = await fixture();
  try {
    const work = metadata('local', 'local');
    work.novel.isLocal = true;
    const stored = await f.putChapter(work, 'norea-folder:1', 1);
    const query = new URLSearchParams({ ...work.identity, chapterPath: 'local:markdown:different/chapter-0001', chapterNumber: '1' });
    assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).statusCode, 404);
    query.set('includeUnavailable', 'true');
    assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).statusCode, 404);
    query.set('chapterPath', stored.manifest.identity.chapterPath);
    assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).json().id, stored.id);
  } finally { await f.close(); }
});

test('invalid scanned chapters leave available pages and return after repair with the same identity', async () => {
  const f = await fixture();
  try {
    const work = metadata('source-a', 'Alpha'); const savedWork = await f.putWork(work);
    const chapter = await f.putChapter(work, '/chapter/one', 1);
    const db = openDatabase(f.dataDir);
    try {
      const row = db.prepare('SELECT directory FROM chapters WHERE id=?').get(chapter.id) as { directory: string };
      const temporary = join(f.dataDir, row.directory, 'content.html.part'); await writeFile(temporary, 'partial');
      const invalid = await scanFolder({ db, dataDir: f.dataDir, limits: defaultLimits, full: true });
      assert.equal(invalid.skipped, 1);
      assert.equal((await f.app.inject('/api/v1/catalog/works')).json().items[0].chapterCount, 0);
      assert.deepEqual((await f.app.inject(`/api/v1/catalog/works/${savedWork.id}/chapters`)).json(), { items: [], total: 0, hasMore: false });
      const query = new URLSearchParams(chapter.manifest.identity);
      assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).statusCode, 404);
      assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}&includeUnavailable=true`)).json().id, chapter.id);
      query.set('chapterPath', 'norea-folder:1'); query.set('chapterNumber', '1');
      assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).statusCode, 404);
      assert.equal((await f.app.inject(`/api/v1/catalog/chapter?${query}&includeUnavailable=true`)).json().id, chapter.id);
      assert.equal((db.prepare('SELECT count(*) AS n FROM chapter_tombstones').get() as { n: number }).n, 0);
      await rm(temporary);
      const repaired = await scanFolder({ db, dataDir: f.dataDir, limits: defaultLimits });
      assert.equal(repaired.registered, 1);
      assert.equal((await f.app.inject('/api/v1/catalog/works')).json().items[0].chapterCount, 1);
      assert.equal((await f.app.inject(`/api/v1/catalog/works/${savedWork.id}/chapters`)).json().items[0].id, chapter.id);
      assert.deepEqual((await f.app.inject(`/api/v1/catalog/chapter?${query}`)).json().manifest.identity, chapter.manifest.identity);
      assert.equal((db.prepare('SELECT count(*) AS n FROM chapters').get() as { n: number }).n, 1);
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('catalog reads follow anonymous, invalid-key and blocked-device policies and expose schemas', async () => {
  const f = await fixture(false);
  try {
    const work = metadata('source-a', 'Alpha'); const stored = await f.putWork(work);
    await f.putChapter(work, '/chapter/one', 1);
    const query = new URLSearchParams({ ...work.identity, chapterPath: '/chapter/one' });
    const routes = ['/api/v1/catalog/changes', '/api/v1/catalog/works', '/api/v1/catalog/sources', `/api/v1/catalog/works/${stored.id}/chapters`, `/api/v1/catalog/chapter?${query}`];
    for (const url of routes) {
      assert.equal((await f.app.inject(url)).statusCode, 401);
      assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 200);
      assert.equal((await f.app.inject({ url, headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
    }
    const admin = await consoleHeaders(f.app, f.dataDir);
    await f.app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: { anonymousRead: true } });
    const device = (await f.app.inject({ url: '/api/v1/admin/devices', headers: admin })).json().items[0];
    await f.app.inject({ method: 'PATCH', url: `/api/v1/admin/devices/${device.id}`, headers: admin, payload: { blocked: true } });
    for (const url of routes) {
      assert.equal((await f.app.inject(url)).statusCode, 200);
      assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 403);
    }
    for (const suffix of ['limit=0', 'limit=101', 'offset=-1', 'offset=9007199254740992', 'offset=1.5', `q=${'a'.repeat(501)}`]) assert.equal((await f.app.inject(`/api/v1/catalog/works?${suffix}`)).statusCode, 400, suffix);
    for (const suffix of ['limit=0', 'limit=101', 'offset=-1']) assert.equal((await f.app.inject(`/api/v1/catalog/works/${stored.id}/chapters?${suffix}`)).statusCode, 400, suffix);
    assert.equal((await f.app.inject('/api/v1/catalog/chapter?pluginId=source-a')).statusCode, 400);
    const schema = (await f.app.inject('/api/v1/openapi.json')).json();
    for (const path of ['/api/v1/catalog/changes', '/api/v1/catalog/works', '/api/v1/catalog/sources', '/api/v1/catalog/works/{id}/chapters', '/api/v1/catalog/chapter']) assert.ok(schema.paths[path].get.responses['200'].content['application/json'].schema);
  } finally { await f.close(); }
});

test('incremental availability pages preserve ordered deletions and restores without file inventories', async () => {
  const f = await fixture();
  try {
    const work = metadata('source-a', 'Alpha');
    const first = await f.putChapter(work, '/chapter/one', 1);
    const second = await f.putChapter(work, '/chapter/two', 2);
    const deletion = await f.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${first.id}`, headers: f.headers });
    assert.equal(deletion.statusCode, 200, deletion.body);
    const restore = await f.app.inject({ method: 'POST', url: `/api/v1/chapters/${first.id}/restore`, headers: f.headers });
    assert.equal(restore.statusCode, 200, restore.body);
    const summarize = (entry: typeof first) => ({ identity: entry.manifest.identity, deleted: entry.deleted, sequence: entry.sequence });
    const page = await f.app.inject('/api/v1/catalog/changes?limit=2');
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(page.json(), { items: [summarize(first), summarize(second)], cursor: second.sequence, hasMore: true });
    const next = await f.app.inject(`/api/v1/catalog/changes?after=${second.sequence}&limit=2`);
    assert.deepEqual(next.json(), { items: [summarize(deletion.json()), summarize(restore.json())], cursor: restore.json().sequence, hasMore: false });
    assert.deepEqual((await f.app.inject(`/api/v1/catalog/changes?after=${restore.json().sequence}`)).json(), { items: [], cursor: restore.json().sequence, hasMore: false });
    assert.deepEqual((await f.app.inject('/api/v1/catalog/changes?after=999999')).json(), { items: [], cursor: 999999, hasMore: false });
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      db.prepare("UPDATE catalog_changes SET entry=json_set(entry,'$.manifest.novel.summary',?)").run('A long work summary. '.repeat(1000));
    } finally { db.close(); }
    const lightweight = await f.app.inject('/api/v1/catalog/changes');
    assert.ok(lightweight.rawPayload.length < 2000, lightweight.rawPayload.length.toString());
    assert.deepEqual(lightweight.json().items, [first, second, deletion.json(), restore.json()].map(summarize));
    for (const suffix of ['after=-1', 'after=1.5', 'after=9007199254740992', 'limit=0', 'limit=101']) assert.equal((await f.app.inject(`/api/v1/catalog/changes?${suffix}`)).statusCode, 400, suffix);
  } finally { await f.close(); }
});

test('default work pages stay bounded and the current schema provides browsing indexes', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 42; i++) await f.putWork(metadata('source', `Book ${String(i).padStart(2, '0')}`));
    const page = (await f.app.inject('/api/v1/catalog/works')).json();
    assert.equal(page.items.length, 40); assert.equal(page.total, 42); assert.equal(page.hasMore, true);
    assert.deepEqual((await f.app.inject('/api/v1/catalog/works?offset=40')).json().items.map((item: { novel: { name: string } }) => item.novel.name), ['Book 40', 'Book 41']);
    const db = openDatabase(f.dataDir);
    try {
      const plans = [
        ["SELECT id FROM works ORDER BY json_extract(entry,'$.metadata.novel.name'),id LIMIT 40", 'works_catalog_name'],
        ["SELECT id FROM works WHERE json_extract(entry,'$.metadata.identity.pluginId')='source' ORDER BY json_extract(entry,'$.metadata.novel.name'),id LIMIT 40", 'works_catalog_source'],
        ["SELECT json_extract(entry,'$.metadata.identity.pluginId'),COUNT(*) FROM works GROUP BY json_extract(entry,'$.metadata.identity.pluginId')", 'works_catalog_source'],
        ["SELECT entry FROM chapters WHERE work_id='work' AND deleted_at IS NULL AND path IS NOT NULL ORDER BY json_extract(entry,'$.manifest.chapter.position'),id LIMIT 100", 'chapters_catalog_work'],
        ["SELECT COUNT(*) FROM chapters WHERE work_id='work' AND deleted_at IS NULL AND path IS NOT NULL", 'chapters_catalog_work'],
      ];
      for (const [sql, index] of plans) {
        const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(row => row.detail).join('\n');
        assert.ok(details.includes(index), details); assert.ok(!details.includes('TEMP B-TREE'), details);
      }
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM works').get() as { n: number }).n, 42);
    } finally { db.close(); }
  } finally { await f.close(); }
});
