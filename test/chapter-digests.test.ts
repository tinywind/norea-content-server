import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { chapterPayloadHash, startChapterDigestBackfill } from '../src/chapter-inventory.ts';
import { reconcileChapterNumbers } from '../src/chapter-number-reconciliation.ts';
import { openDatabase } from '../src/db.ts';
import { scanFolder } from '../src/folder-indexer.ts';
import { defaultLimits } from '../src/packages.ts';
import { saveWork } from '../src/works.ts';
import { deviceHeaders } from './access.ts';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function archive(files: Record<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, value] of Object.entries(files)) zip.addBuffer(value, name, { compress: false });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function createFixture(anonymousRead = false) {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'chapter-digests-'));
  const db = openDatabase(dataDir);
  const work = saveWork(db, dataDir, {
    schemaVersion: 1,
    identity: { pluginId: 'source', novelId: 'work', novelPath: '/work' },
    novel: { name: 'Work', cover: null, author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false },
    cover: null,
  });
  const app = await buildApp({ dataDir, anonymousRead });
  const headers = await deviceHeaders(app);
  const upload = async (chapterNumber: string, chapterPath: string, files: Record<string, Buffer>) => {
    const metadata = {
      packageVersion: 1,
      layout: 'chapter-files',
      identity: { pluginId: 'source', novelId: 'work', novelPath: '/work', chapterPath },
      novel: { name: 'Work', isLocal: false },
      chapter: { name: `Chapter ${chapterNumber}`, position: Number(chapterNumber), chapterNumber, contentType: 'html', page: '1' },
      bodyPath: 'content.html',
      files: Object.entries(files).map(([path, value]) => ({ path, size: value.length, modifiedAt: 1 })),
    };
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    for (const [path, value] of Object.entries(files)) form.append(path, new Blob([new Uint8Array(value)]), path);
    const request = new Request('http://localhost', { method: 'POST', body: form });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chapter-files?conflictPolicy=replace-server',
      headers: { ...headers, 'content-type': request.headers.get('content-type')! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  return {
    app,
    db,
    dataDir,
    work,
    headers,
    upload,
    close: async () => {
      db.close();
      await app.close();
      await rm(dataDir, { recursive: true });
    },
  };
}

test('upload precomputes codepoint-sorted payloadHash and lifecycle updates chapter_inventory_digests', async () => {
  const f = await createFixture(false);
  try {
    const body = Buffer.from('<p>hello chapter 1</p>');
    const imgA = Buffer.from('asset-a');
    const imgB = Buffer.from('asset-B');
    const imgZ = Buffer.from('asset-Z');
    // Mixed case keys verify ASCII codepoint sorting ('media/B.png' < 'media/Z.png' < 'media/a.png').
    const manifest = {
      version: 1,
      complete: true,
      updatedAt: 1,
      media: {
        files: ['a.png', 'Z.png', 'B.png'].map(fileName => ({
          fileName,
          path: `media/${fileName}`,
          sourceUrl: `https://example.test/${fileName}`,
          status: 'stored',
          bytes: 7,
          updatedAt: 1,
        })),
      },
    };
    const zip = await archive({ 'a.png': imgA, 'Z.png': imgZ, 'B.png': imgB });
    const entry = await f.upload('1', '/ch/1', {
      'content.html': body,
      'manifest.json': Buffer.from(JSON.stringify(manifest)),
      'media.zip': zip,
    });

    const expectedCanonical = JSON.stringify([
      [sha256(body), body.length],
      ['media/B.png', 'media/Z.png', 'media/a.png'],
      [
        ['media/B.png', sha256(imgB), imgB.length],
        ['media/Z.png', sha256(imgZ), imgZ.length],
        ['media/a.png', sha256(imgA), imgA.length],
      ],
    ]);
    const expectedHash = sha256(expectedCanonical);

    const stored = f.db.prepare('SELECT revision, payload_hash, body_sha256, body_bytes FROM chapter_inventory_digests WHERE chapter_id=?').get(entry.id) as {
      revision: string;
      payload_hash: string;
      body_sha256: string;
      body_bytes: number;
    };
    assert.equal(stored.revision, entry.revision);
    assert.equal(stored.payload_hash, expectedHash);
    assert.equal(stored.body_sha256, sha256(body));
    assert.equal(stored.body_bytes, body.length);

    // Auth and 404 checks.
    assert.equal((await f.app.inject(`/api/v1/catalog/works/${f.work.id}/chapter-digests`)).statusCode, 401);
    assert.equal((await f.app.inject({ url: `/api/v1/catalog/works/${'0'.repeat(64)}/chapter-digests`, headers: f.headers })).statusCode, 404);

    // Bulk digests endpoint matches exact live storage-inventory hash.
    const bulk = await f.app.inject({ url: `/api/v1/catalog/works/${f.work.id}/chapter-digests`, headers: f.headers });
    assert.equal(bulk.statusCode, 200, bulk.body);
    assert.deepEqual(bulk.json(), {
      items: [{
        id: entry.id,
        revision: entry.revision,
        chapterPath: '/ch/1',
        chapterNumber: '1',
        position: 1,
        complete: true,
        payloadHash: expectedHash,
        bodySha256: sha256(body),
        bodyBytes: body.length,
      }],
      total: 1,
      hasMore: false,
    });

    const live = await f.app.inject({ url: `/api/v1/chapters/${entry.id}/storage-inventory?revision=${entry.revision}`, headers: f.headers });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(chapterPayloadHash(live.json().inventory), expectedHash);

    // Replacing chapter updates digest.
    const body2 = Buffer.from('<p>updated chapter 1</p>');
    const replaced = await f.upload('1', '/ch/1', { 'content.html': body2 });
    const replacedHash = sha256(JSON.stringify([[sha256(body2), body2.length], null, []]));
    const bulkAfterReplace = (await f.app.inject({ url: `/api/v1/catalog/works/${f.work.id}/chapter-digests`, headers: f.headers })).json();
    assert.equal(bulkAfterReplace.items[0].revision, replaced.revision);
    assert.equal(bulkAfterReplace.items[0].payloadHash, replacedHash);
    assert.equal(bulkAfterReplace.items[0].bodyBytes, body2.length);

    // Deleting removes digest; restoring repopulates digest.
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: f.headers })).statusCode, 200);
    assert.equal(f.db.prepare('SELECT 1 FROM chapter_inventory_digests WHERE chapter_id=?').get(entry.id), undefined);
    const restored = await f.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: f.headers });
    assert.equal(restored.statusCode, 200, restored.body);
    const afterRestore = f.db.prepare('SELECT payload_hash FROM chapter_inventory_digests WHERE chapter_id=?').get(entry.id) as { payload_hash: string } | undefined;
    assert.equal(afterRestore?.payload_hash, replacedHash);
  } finally {
    await f.close();
  }
});

test('chapter-digests computes missing digests on demand, paginates, and reports per-chapter errors', async () => {
  const f = await createFixture(true);
  try {
    const first = await f.upload('1', '/ch/1', { 'content.html': Buffer.from('first') });
    const second = await f.upload('2', '/ch/2', { 'content.html': Buffer.from('second') });
    const third = await f.upload('3', '/ch/3', { 'content.html': Buffer.from('third') });

    // Simulate pre-existing rows without cached digests and one corrupted chapter on disk.
    f.db.prepare('DELETE FROM chapter_inventory_digests').run();
    const row3 = f.db.prepare('SELECT directory FROM chapters WHERE id=?').get(third.id) as { directory: string };
    await unlink(join(f.dataDir, row3.directory, 'content.html'));

    const page1 = await f.app.inject(`/api/v1/catalog/works/${f.work.id}/chapter-digests?offset=0&limit=2`);
    assert.equal(page1.statusCode, 200, page1.body);
    const body1 = page1.json();
    assert.equal(body1.total, 3);
    assert.equal(body1.hasMore, true);
    assert.equal(body1.items.length, 2);
    assert.equal(body1.items[0].id, first.id);
    assert.equal(body1.items[0].bodyBytes, 5);
    assert.ok(body1.items[0].payloadHash);
    assert.equal(body1.items[1].id, second.id);
    assert.equal(body1.items[1].bodyBytes, 6);
    assert.ok(body1.items[1].payloadHash);
    // Persisted for subsequent requests.
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM chapter_inventory_digests').get() as { n: number }).n, 2);

    const page2 = await f.app.inject(`/api/v1/catalog/works/${f.work.id}/chapter-digests?offset=2&limit=2`);
    assert.equal(page2.statusCode, 200, page2.body);
    const body2 = page2.json();
    assert.equal(body2.total, 3);
    assert.equal(body2.hasMore, false);
    assert.equal(body2.items.length, 1);
    assert.equal(body2.items[0].id, third.id);
    assert.equal(body2.items[0].payloadHash, null);
    assert.equal(body2.items[0].bodySha256, null);
    assert.equal(body2.items[0].bodyBytes, null);
    assert.match(body2.items[0].error, /unavailable|not found/i);
  } finally {
    await f.close();
  }
});

test('folder scan, reconciliation, and background backfill maintain chapter digests', async () => {
  const f = await createFixture(true);
  try {
    // Write a folder chapter directly and scan.
    const chDir = join(f.dataDir, 'contents', 'source', 'work', '5');
    await mkdir(chDir, { recursive: true });
    const body = Buffer.from('<p>folder chapter</p>');
    await writeFile(join(chDir, 'content.html'), body);
    const scan1 = await scanFolder({ dataDir: f.dataDir, db: f.db, limits: defaultLimits });
    assert.equal(scan1.registered, 1);
    const expectedHash = sha256(JSON.stringify([[sha256(body), body.length], null, []]));
    const indexed = f.db.prepare('SELECT id, json_extract(entry, \'$.revision\') AS revision FROM chapters WHERE work_id=?').get(f.work.id) as { id: string; revision: string };
    const cached1 = f.db.prepare('SELECT payload_hash, revision FROM chapter_inventory_digests WHERE chapter_id=?').get(indexed.id) as { payload_hash: string; revision: string };
    assert.equal(cached1.payload_hash, expectedHash);
    assert.equal(cached1.revision, indexed.revision);

    // Delete digest and re-scan (unchanged fast path should repopulate digest).
    f.db.prepare('DELETE FROM chapter_inventory_digests').run();
    const scan2 = await scanFolder({ dataDir: f.dataDir, db: f.db, limits: defaultLimits });
    assert.equal(scan2.unchanged >= 1, true);
    const cached2 = f.db.prepare('SELECT payload_hash FROM chapter_inventory_digests WHERE chapter_id=?').get(indexed.id) as { payload_hash: string } | undefined;
    assert.equal(cached2?.payload_hash, expectedHash);

    // Reconciliation preserves payload_hash while updating revision.
    const workRow = f.db.prepare('SELECT fingerprint FROM works WHERE id=?').get(f.work.id) as { fingerprint: string };
    reconcileChapterNumbers(f.db, f.dataDir, f.work.id, {
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedWorkRevision: workRow.fingerprint,
      mappings: [{ chapterPath: '/ch/6', from: '5', to: '6' }],
    });
    const afterReconcileChapter = f.db.prepare('SELECT json_extract(entry, \'$.revision\') AS revision FROM chapters WHERE id=?').get(indexed.id) as { revision: string };
    const afterReconcileDigest = f.db.prepare('SELECT revision, payload_hash FROM chapter_inventory_digests WHERE chapter_id=?').get(indexed.id) as { revision: string; payload_hash: string };
    assert.equal(afterReconcileDigest.revision, afterReconcileChapter.revision);
    assert.equal(afterReconcileDigest.payload_hash, expectedHash);

    // Background backfill repopulates missing digests cleanly.
    f.db.prepare('DELETE FROM chapter_inventory_digests').run();
    const handle = startChapterDigestBackfill(f.db, f.dataDir, defaultLimits, 10);
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = f.db.prepare('SELECT payload_hash FROM chapter_inventory_digests WHERE chapter_id=?').get(indexed.id) as { payload_hash: string } | undefined;
        if (row?.payload_hash === expectedHash) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const backfilled = f.db.prepare('SELECT payload_hash FROM chapter_inventory_digests WHERE chapter_id=?').get(indexed.id) as { payload_hash: string } | undefined;
      assert.equal(backfilled?.payload_hash, expectedHash);
    } finally {
      await handle.stop();
    }
  } finally {
    await f.close();
  }
});
