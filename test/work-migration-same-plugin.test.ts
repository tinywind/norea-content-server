import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { digest, type PackageManifest, type CatalogEntry } from '../src/packages.ts';
import { migrationSnapshot, type FinalizeMigrationRequest } from '../src/work-migrations.ts';
import { saveWork, type NovelMetadataV1 } from '../src/works.ts';
import { deviceHeaders } from './access.ts';

const pluginId = 'bookkor-novel';
const source = { pluginId, novelId: '6579', novelPath: '/6579' };
const target = { pluginId, novelId: '6157', novelPath: '/6157' };
const sourceId = digest(JSON.stringify([pluginId, source.novelPath]));
const targetId = digest(JSON.stringify([pluginId, target.novelPath]));
const body = '<p>Saved content must survive same-source migration.</p>';
const sourcePath = '/6579/826';
const targetPath = '/6157/1001';

function metadata(identity: typeof source, chapters: Record<string,string>): NovelMetadataV1 {
  return {
    schemaVersion: 1, identity, novel: { name: '디펜스 게임의 폭군이 되었다',
      author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null, chapters,
  };
}

test('same-plugin distinct work IDs copy the approved body, retire only source, preserve tombstone and replay', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp/work-migration-same-plugin-'));
  const db = openDatabase(dataDir);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    saveWork(db, dataDir, metadata(source, { '826': 'Original first note' }));
    saveWork(db, dataDir, metadata(target, { '1001': 'Retained target note' }));
    app = await buildApp({ dataDir, anonymousRead: true });
    const headers = await deviceHeaders(app);
    assert.notEqual(sourceId, targetId);

    const bytes = Buffer.from(body);
    const manifest: PackageManifest = {
      packageVersion: 1, layout: 'chapter-files', identity: { ...source, chapterPath: sourcePath },
      novel: { name: '디펜스 게임의 폭군이 되었다', isLocal: false },
      chapter: { name: 'Original first note', chapterNumber: '826', position: 1, page: '1', contentType: 'html' },
      bodyPath: 'content.html', files: [{ path: 'content.html', size: bytes.length, modifiedAt: 1 }],
    };
    const uploadForm = new FormData();
    uploadForm.append('metadata', JSON.stringify(manifest));
    uploadForm.append('content.html', new Blob([new Uint8Array(bytes)]), 'content.html');
    const request = new Request('http://fixture', { method: 'POST', body: uploadForm });
    const uploaded = await app.inject({ method: 'POST', url: '/api/v1/chapter-files?conflictPolicy=replace-server',
      headers: { ...headers, 'content-type': request.headers.get('content-type')! },
      payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const original = uploaded.json<CatalogEntry>();

    const initialSource = migrationSnapshot(db, dataDir, sourceId);
    const initialTarget = migrationSnapshot(db, dataDir, targetId);
    const copyRequest = {
      decision: 'copy-source' as const,
      source: { revision: initialSource.work.revision, chapter: { id: original.id, revision: original.revision } },
      target: { id: targetId, revision: initialTarget.work.revision, expectedChapter: null,
        chapter: { chapterPath: targetPath, chapterNumber: '1001', name: 'Retained target note', position: 1, page: '1' } },
    };

    // A copy to the exact same work, even with another path, must be rejected.
    const selfCopy = await app.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/migration-copy',
      headers, payload: { ...copyRequest, target: { ...copyRequest.target, id: sourceId } } });
    assert.equal(selfCopy.statusCode, 409);
    assert.equal(migrationSnapshot(db, dataDir, sourceId).chapters.length, 1);

    const copied = await app.inject({ method: 'POST', url: '/api/v1/works/' + sourceId + '/migration-copy',
      headers, payload: copyRequest });
    assert.equal(copied.statusCode, 200, copied.body);
    const copiedChapter = copied.json().entry as CatalogEntry;
    assert.deepEqual(copiedChapter.manifest.identity, { ...target, chapterPath: targetPath });
    assert.equal(await readFile(join(dataDir, 'contents/bookkor-novel/6579/826/content.html'), 'utf8'), body);
    assert.equal(await readFile(join(dataDir, 'contents/bookkor-novel/6157/1001/content.html'), 'utf8'), body);

    const sourceSnapshot = migrationSnapshot(db, dataDir, sourceId);
    const targetSnapshot = migrationSnapshot(db, dataDir, targetId);
    const finalize: FinalizeMigrationRequest = {
      operationId: randomUUID(),
      source: { revision: sourceSnapshot.work.revision,
        chapters: sourceSnapshot.chapters.map(row => ({ id: row.id, revision: row.revision })) },
      target: { id: targetId, revision: targetSnapshot.work.revision },
      mappings: [{ sourceChapterId: original.id, targetChapterId: copiedChapter.id,
        targetRevision: copiedChapter.revision, decision: 'copy-source' }],
      chapterDecisions: [{ sourceChapterPath: sourcePath, sourceChapterNumber: '826',
        targetChapterPath: targetPath, targetChapterNumber: '1001' }],
    };
    const endpoint = '/api/v1/works/' + sourceId + '/finalize-migration';
    const completed = await app.inject({ method: 'POST', url: endpoint, headers, payload: finalize });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal((await app.inject({ url: '/api/v1/works/' + sourceId })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/v1/works/' + targetId })).statusCode, 200);
    assert.equal(await readFile(join(dataDir, 'contents/bookkor-novel/6157/1001/content.html'), 'utf8'), body);
    assert.equal((db.prepare('SELECT deleted FROM work_tombstones WHERE work_id=?').get(sourceId) as { deleted:number }).deleted, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM work_migration_lineage WHERE source_work_id=?').get(sourceId) as { n:number }).n, 1);
    const replay = await app.inject({ method: 'POST', url: endpoint, headers, payload: finalize });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), completed.json());
    const republish = await app.inject({ method: 'PUT', url: '/api/v1/works/' + sourceId, headers,
      payload: metadata(source, { '826': 'Original first note' }) });
    assert.equal(republish.statusCode, 410, republish.body);
  } finally {
    await app?.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
