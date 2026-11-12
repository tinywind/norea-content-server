import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { digest, type CatalogEntry, type PackageManifest } from '../src/packages.ts';
import { recordWorkMigrationLineage } from '../src/work-migration-lineage.ts';
import { migrationSnapshot } from '../src/work-migrations.ts';
import { recoverDiscardedMigrationChapters } from '../src/work-migration-recovery.ts';
import { deleteWork, saveWork, type NovelMetadataV1 } from '../src/works.ts';
import { deviceHeaders } from './access.ts';

test('recovers discarded server-only chapters from backup without reviving tombstoned source or mutating receipts', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/work-migration-recovery-'));
  const backupDataDir = join(root, 'backup-server');
  const backupSnapshotDir = join(root, 'backup-snapshot/newtoki-novel/58656');
  const hardlinkAnchorDir = join(root, 'hardlink-anchor');
  const liveDataDir = join(root, 'live-server');
  const stagingRoot = join(root, 'staging');
  await mkdir(backupDataDir, { recursive: true });
  await mkdir(backupSnapshotDir, { recursive: true });
  await mkdir(hardlinkAnchorDir, { recursive: true });
  await mkdir(liveDataDir, { recursive: true });

  const sourceMeta: NovelMetadataV1 = {
    schemaVersion: 1,
    identity: { pluginId: 'newtoki-novel', novelId: '58656', novelPath: '/novel/58656' },
    novel: { name: 'How an A-Rank Hunter Lives', author: 'Geommisung', artist: null, summary: 'Summary', status: null, genres: null, rating: null, isLocal: false },
    cover: null,
    chapters: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), `Episode ${i + 1}`])),
  };
  const compositionEntries = Array.from({ length: 10 }, (_, i) => ({
    id: `comp-${i + 1}`,
    path: `/bookkor/6951-ep-${i + 1}`,
    storageChapterNumber: String(i + 1),
    sources: [
      { pluginId: 'newtoki-novel', novelId: '58656', novelPath: '/novel/58656', chapterPath: `norea-folder:${i + 1}`, chapterNumber: String(i + 1), name: `Episode ${i + 1}`, position: i + 1, page: '1', contentType: 'html' as const, releaseTime: null },
      { pluginId: 'bookkor-novel', novelId: '6951', novelPath: '/bookkor/6951', chapterPath: `/bookkor/6951-ep-${i + 1}`, chapterNumber: String(i + 1), name: `Episode ${i + 1} Target`, position: i + 1, page: '1', contentType: 'html' as const, releaseTime: null },
    ],
    primarySource: 1,
    user: { included: true, order: i + 1, name: null, chapterNumber: String(i + 1) },
  }));
  const targetMeta = {
    schemaVersion: 1 as const,
    identity: { pluginId: 'bookkor-novel', novelId: '6951', novelPath: '/bookkor/6951' },
    novel: { name: 'How an A-Rank Hunter Lives', author: null, artist: null, summary: 'Target summary', status: 'Completed', genres: 'Fantasy', rating: 3, isLocal: false },
    cover: null,
    chapters: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), `Episode ${i + 1} Target`])),
    chapterComposition: { version: 1, updatedAt: 1000, entries: compositionEntries },
  } as NovelMetadataV1;

  try {
    // 1. Populate pre-migration backup DB + hardlinked backup HTML snapshot
    const backupDb = openDatabase(backupDataDir);
    saveWork(backupDb, backupDataDir, sourceMeta);
    const backupApp = await buildApp({ dataDir: backupDataDir, anonymousRead: true });
    const backupHeaders = await deviceHeaders(backupApp);
    const uploadedBackupEntries: CatalogEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      const html = `<p>Recovered paragraph ${i} - body verification ${i}</p>`;
      const manifest: PackageManifest = {
        packageVersion: 1,
        layout: 'chapter-files',
        identity: { ...sourceMeta.identity, chapterPath: `norea-folder:${i}` },
        novel: { name: sourceMeta.novel.name, author: sourceMeta.novel.author, summary: sourceMeta.novel.summary, isLocal: false },
        chapter: { name: `Episode ${i}`, chapterNumber: String(i), position: i, page: '1', contentType: 'html' },
        bodyPath: 'content.html',
        files: [{ path: 'content.html', size: Buffer.byteLength(html), modifiedAt: 1792811595000 + i }],
      };
      const form = new FormData();
      form.append('metadata', JSON.stringify(manifest));
      form.append('content.html', new Blob([html]), 'content.html');
      const req = new Request('http://fixture', { method: 'POST', body: form });
      const res = await backupApp.inject({
        method: 'POST',
        url: '/api/v1/chapter-files?conflictPolicy=replace-server',
        headers: { ...backupHeaders, 'content-type': req.headers.get('content-type')! },
        payload: Buffer.from(await req.arrayBuffer()),
      });
      assert.equal(res.statusCode, 200, res.body);
      uploadedBackupEntries.push(res.json<CatalogEntry>());

      const anchorFile = join(hardlinkAnchorDir, `ch-${i}.html`);
      await writeFile(anchorFile, html, 'utf8');
      await mkdir(join(backupSnapshotDir, String(i)), { recursive: true });
      await link(anchorFile, join(backupSnapshotDir, String(i), 'content.html'));
    }
    const preSourceSnap = migrationSnapshot(backupDb, backupDataDir, digest(JSON.stringify(['newtoki-novel', '/novel/58656'])));
    await backupApp.close();
    backupDb.close();

    // 2. Build post-loss live server state (source retired, historical delete-source lineage + receipt, target has 0 bodies + reading state)
    const liveDb = openDatabase(liveDataDir);
    saveWork(liveDb, liveDataDir, sourceMeta);
    saveWork(liveDb, liveDataDir, targetMeta);
    const liveApp = await buildApp({ dataDir: liveDataDir, anonymousRead: true });
    const liveHeaders = await deviceHeaders(liveApp);
    const scope = (await liveApp.inject({ url: '/api/v1/user-state/current', headers: liveHeaders })).json();
    const publishState = await liveApp.inject({
      method: 'POST',
      url: '/api/v1/user-state/current',
      headers: liveHeaders,
      payload: {
        ...scope,
        items: [
          {
            entity: { kind: 'reading', work: { pluginId: 'bookkor-novel', sourceNovelId: '6951', novelPath: '/bookkor/6951', name: 'How an A-Rank Hunter Lives' }, chapter: { chapterPath: '/bookkor/6951-ep-1' } },
            value: { progress: 100, unread: false, readAt: 12345 },
          },
          {
            entity: { kind: 'bookmark', work: { pluginId: 'bookkor-novel', sourceNovelId: '6951', novelPath: '/bookkor/6951', name: 'How an A-Rank Hunter Lives' }, chapter: { chapterPath: '/bookkor/6951-ep-5' } },
            value: { bookmarked: true },
          },
        ],
      },
    });
    assert.equal(publishState.statusCode, 200, publishState.body);

    const sourceWorkId = digest(JSON.stringify(['newtoki-novel', '/novel/58656']));
    const targetWorkId = digest(JSON.stringify(['bookkor-novel', '/bookkor/6951']));
    const targetSnapBefore = migrationSnapshot(liveDb, liveDataDir, targetWorkId);
    const operationId = randomUUID();
    deleteWork(liveDb, liveDataDir, sourceWorkId, deletedWork => {
      recordWorkMigrationLineage(liveDb, {
        operationId,
        sourceWork: preSourceSnap.work,
        targetWork: targetSnapBefore.work,
        deletedSource: { revision: preSourceSnap.work.revision, sequence: deletedWork.sequence },
        mappings: preSourceSnap.chapters.map(ch => ({ source: ch, decision: 'delete-source' as const, target: null, targetInventory: null })),
        chapterDecisions: preSourceSnap.chapters.map(ch => ({
          sourceChapterPath: ch.chapterPath,
          sourceChapterNumber: ch.chapterNumber,
          targetChapterPath: `/bookkor/6951-ep-${ch.chapterNumber}`,
          targetChapterNumber: ch.chapterNumber,
          discardSourceContent: true as const,
          sourceMetadataVerified: true,
          targetMetadataVerified: true,
        })),
        fullDecisionCoverage: true,
      });
      liveDb.prepare('INSERT INTO work_migrations(operation_id,source_work_id,request_hash,result) VALUES(?,?,?,?)')
        .run(operationId, sourceWorkId, 'f'.repeat(64), JSON.stringify({ operationId, deletedWork }));
    });

    const anchorStatBefore = await stat(join(hardlinkAnchorDir, 'ch-1.html'));

    // 3. Execute auditable recovery
    const report = await recoverDiscardedMigrationChapters({
      db: liveDb,
      dataDir: liveDataDir,
      backupDbPath: join(backupDataDir, 'metadata.sqlite'),
      backupSourceDir: backupSnapshotDir,
      stagingRoot,
      operationId,
      expectedChapterCount: 10,
    });
    assert.equal(report.totalCandidates, 10);
    assert.equal(report.publishedCount, 10);
    assert.equal(report.alreadyRecoveredCount, 0);

    // 4. Verify all 10 chapters are downloadable via HTTP API with matching SHA-256, source stays deleted, reading state & hardlinks intact
    const catalogRes = await liveApp.inject(`/api/v1/works/${targetWorkId}/migration-snapshot`);
    assert.equal(catalogRes.statusCode, 200);
    assert.equal(catalogRes.json().chapters.length, 10);
    for (let i = 1; i <= 10; i++) {
      const rec = report.chapters[i - 1];
      const expectedBytes = await readFile(join(hardlinkAnchorDir, `ch-${i}.html`));
      assert.equal(rec.sha256, digest(expectedBytes));
      const dl = await liveApp.inject(`/api/v1/chapters/${rec.targetChapterId}/files?revision=${rec.targetRevision}&path=content.html`);
      assert.equal(dl.statusCode, 200);
      assert.equal(digest(dl.rawPayload), digest(expectedBytes));
    }
    assert.equal((await liveApp.inject(`/api/v1/works/${sourceWorkId}`)).statusCode, 404);
    const anchorStatAfter = await stat(join(hardlinkAnchorDir, 'ch-1.html'));
    assert.equal(anchorStatAfter.ino, anchorStatBefore.ino);
    assert.equal(anchorStatAfter.mtimeMs, anchorStatBefore.mtimeMs);

    const viewAfter = (await liveApp.inject({ url: '/api/v1/user-state/current', headers: liveHeaders })).json();
    assert.equal(viewAfter.items.length, 2);

    // 5. Idempotency: second run skips all 10 without advancing catalog sequence or creating duplicates
    const seqBeforeReplay = (liveDb.prepare('SELECT max(sequence) AS n FROM catalog_changes').get() as { n: number }).n;
    const replay = await recoverDiscardedMigrationChapters({
      db: liveDb,
      dataDir: liveDataDir,
      backupDbPath: join(backupDataDir, 'metadata.sqlite'),
      backupSourceDir: backupSnapshotDir,
      stagingRoot,
      operationId,
      expectedChapterCount: 10,
    });
    assert.equal(replay.publishedCount, 0);
    assert.equal(replay.alreadyRecoveredCount, 10);
    assert.equal((liveDb.prepare('SELECT max(sequence) AS n FROM catalog_changes').get() as { n: number }).n, seqBeforeReplay);

    // 6. Conflict protection: if target chapter holds different content, recovery refuses to overwrite
    await writeFile(join(liveDataDir, 'contents/bookkor-novel/6951/1/content.html'), '<p>Different unverified body_________</p>', 'utf8');
    await assert.rejects(
      recoverDiscardedMigrationChapters({
        db: liveDb,
        dataDir: liveDataDir,
        backupDbPath: join(backupDataDir, 'metadata.sqlite'),
        backupSourceDir: backupSnapshotDir,
        stagingRoot,
        operationId,
        expectedChapterCount: 10,
      }),
      (err: unknown) => [409].includes((err as { statusCode: number }).statusCode),
    );

    await liveApp.close();
    liveDb.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
