import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { defaultLimits, digest } from '../src/packages.ts';
import { scanFolder } from '../src/folder-indexer.ts';
import { deviceHeaders } from './access.ts';

const identity = { pluginId: 'example', novelId: 'source-book-42', novelPath: '/books/42?lang=en' };
const id = digest(JSON.stringify(['example', '/books/42?lang=en']));
const metadata = () => ({ identity: { ...identity }, novel: { name: 'Book: original title' }, chapters: { '1.5': 'Side story: exact title' } });

async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/storage-identifiers-'));
  const app = await buildApp({ dataDir });
  const headers = await deviceHeaders(app);
  const put = (value: object, workId = id) => app.inject({ method: 'PUT', url: `/api/v1/works/${workId}`, headers, payload: value });
  const upload = async (chapterPath = '/chapters/one', chapterNumber: string | null = '001.500', novelId = identity.novelId, position = 3) => {
    const form = new FormData();
    form.append('metadata', JSON.stringify({ packageVersion: 1, layout: 'chapter-files', identity: { ...identity, novelId, chapterPath },
      novel: { name: 'Changed work title', isLocal: false }, chapter: { name: 'Changed chapter title', chapterNumber, position, page: '1', contentType: 'html' },
      bodyPath: 'content.html', files: [{ path: 'content.html', size: 4, modifiedAt: 1 }] }));
    form.append('content.html', new Blob(['body']), 'content.html');
    const request = new Request('http://localhost', { method: 'POST', body: form });
    return app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
  };
  return { dataDir, app, put, upload, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('work and chapter storage uses literal plugin IDs, source novel IDs, and canonical numbers', async () => {
  const f = await fixture();
  try {
    const saved = await f.put(metadata());
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().metadata.identity.novelId, 'source-book-42');
    assert.deepEqual(await readdir(join(f.dataDir, 'contents/example')), ['source-book-42']);
    const chapter = await f.upload();
    assert.equal(chapter.statusCode, 200, chapter.body);
    assert.deepEqual(await readFile(join(f.dataDir, 'contents/example/source-book-42/1.5/content.html'), 'utf8'), 'body');
    assert.equal((await f.put({ ...metadata(), novel: { name: 'Renamed work' } })).statusCode, 200);
    assert.deepEqual(await readdir(join(f.dataDir, 'contents/example')), ['source-book-42']);
    const fallback = await f.upload('/chapters/three', null);
    assert.equal(fallback.statusCode, 200, fallback.body);
    assert.equal(await readFile(join(f.dataDir, 'contents/example/source-book-42/3/content.html'), 'utf8'), 'body');
    for (const chapterNumber of ['not-a-number', '../2', '-1', 'Infinity']) assert.equal((await f.upload('/chapters/invalid', chapterNumber)).statusCode, 400, chapterNumber);
    assert.equal((await f.upload('/chapters/no-position', null, identity.novelId, 0)).statusCode, 400);
    assert.equal((await f.upload('/chapters/collision')).statusCode, 409);
    assert.equal((await f.upload('/chapters/one', '001.500', 'different-book')).statusCode, 409);
    assert.equal(await readFile(join(f.dataDir, 'contents/example/source-book-42/1.5/content.html'), 'utf8'), 'body');
  } finally { await f.close(); }
});

test('unsafe, missing, changed, and conflicting source IDs cannot replace work files', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.put(metadata())).statusCode, 200);
    for (const novelId of [undefined, '', '.', '..', '../other', 'a/b', 'a\\b', 'a:b', 'a?b', 'a*b', 'a<b', 'a>b', 'a"b', 'a|b', 'a\u0000b', '.hidden', ' leading', 'trailing ', 'trailing.', 'CON', 'aux.txt', 'COM1', 'lpt9.pdf', 'book.PART', 'book.tmp', 'book.norea-sync-backup', 'x'.repeat(241), 'é'.repeat(121), '\ud800']) {
      const value = { ...metadata(), identity: { ...identity, novelId } };
      const result = await f.put(value);
      assert.equal(result.statusCode, 400, JSON.stringify({ novelId, body: result.body }));
    }
    for (const number of ['-1', '1e+21', '01', '1.0', 'Infinity']) {
      assert.equal((await f.put({ ...metadata(), chapters: { [number]: 'Invalid chapter number' } })).statusCode, 400, number);
    }
    assert.equal((await f.put({ ...metadata(), identity: { ...identity, novelId: 'changed' } })).statusCode, 409);
    const otherPath = '/books/different';
    assert.equal((await f.put({ ...metadata(), identity: { ...identity, novelPath: otherPath } }, digest(JSON.stringify(['example', otherPath])))).statusCode, 409);
    assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'contents/example/source-book-42/novel.json'), 'utf8')).identity, identity);
    const unindexed = join(f.dataDir, 'contents/example/unindexed');
    await mkdir(unindexed);
    const original = { ...metadata(), identity: { ...identity, novelId: 'unindexed', novelPath: '/original' } };
    await writeFile(join(unindexed, 'novel.json'), JSON.stringify(original));
    const conflict = await f.put({ ...metadata(), identity: { ...identity, novelId: 'unindexed', novelPath: '/replacement' } }, digest(JSON.stringify(['example', '/replacement'])));
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(await readFile(join(unindexed, 'novel.json'), 'utf8'), JSON.stringify(original));
  } finally { await f.close(); }
});

test('numeric chapter folders recover metadata titles and reject title-based or mismatched work folders', async () => {
  const f = await fixture();
  const db = openDatabase(f.dataDir);
  try {
    const work = join(f.dataDir, 'contents/example/source-book-42');
    for (const name of ['1.5', '2', '3-Title', '04']) {
      await mkdir(join(work, name), { recursive: true });
      await writeFile(join(work, name, 'content.html'), name);
    }
    await writeFile(join(work, 'novel.json'), JSON.stringify(metadata()));
    const mismatched = join(f.dataDir, 'contents/example/title-based-name');
    await mkdir(join(mismatched, '1'), { recursive: true });
    await writeFile(join(mismatched, 'novel.json'), JSON.stringify({ ...metadata(), identity: { ...identity, novelId: 'other-id', novelPath: '/other' } }));
    await writeFile(join(mismatched, '1/content.html'), 'wrong folder');
    await scanFolder({ dataDir: f.dataDir, db, limits: defaultLimits, full: true });
    const entries = db.prepare('SELECT entry FROM chapters ORDER BY directory').all() as { entry: string }[];
    assert.deepEqual(entries.map(row => {
      const chapter = JSON.parse(row.entry).manifest;
      return [chapter.identity.novelId, chapter.chapter.chapterNumber, chapter.chapter.name];
    }), [['source-book-42', '1.5', 'Side story: exact title'], ['source-book-42', '2', '2']]);
    assert.equal((db.prepare('SELECT count(*) AS n FROM works').get() as { n: number }).n, 1);
  } finally { db.close(); await f.close(); }
});
