import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db.ts';
import { inspectChapterInventory } from '../src/chapter-inventory.ts';
import { defaultLimits } from '../src/packages.ts';
import { writeFile } from 'node:fs/promises';

test('revision changes while inspection runs cannot produce mixed evidence', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'inventory-race-'));
  const db = openDatabase(dataDir);
  try {
    const directory = 'contents/source/work/1'; await mkdir(join(dataDir, directory), { recursive: true });
    await writeFile(join(dataDir, directory, 'content.html'), 'body');
    const revision = 'a'.repeat(64); const id = 'b'.repeat(64);
    const entry = { id, revision, deleted: false, manifest: { identity: { pluginId: 'source', novelId: 'work', novelPath: '/work', chapterPath: '/1' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: 4 }] } };
    db.prepare('INSERT INTO chapters (id, work_id, directory, path, entry) VALUES (?, ?, ?, ?, ?)').run(id, 'work', directory, directory, JSON.stringify(entry));
    const pending = inspectChapterInventory(db, dataDir, id, revision, defaultLimits);
    entry.revision = 'c'.repeat(64);
    db.prepare('UPDATE chapters SET entry=? WHERE id=?').run(JSON.stringify(entry), id);
    await assert.rejects(pending, /changed during inspection/);
  } finally { db.close(); await rm(dataDir, { recursive: true }); }
});
