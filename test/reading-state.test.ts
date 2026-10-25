import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import type { ReadingStateEntry } from '../src/reading-state.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

const entry = (overrides: Partial<ReadingStateEntry> = {}): ReadingStateEntry => ({
  pluginId: 'example-source', sourceNovelId: 'work-1', novelPath: '/novel/1',
  chapterPath: '/novel/1/chapter/1', chapterNumber: '1', page: '1',
  unread: true, progress: 35, bookmark: false, readAt: 1700000000,
  ...overrides,
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-reading-state-'));
  const app = await buildApp({ dataDir, anonymousRead: true });
  const headers = await deviceHeaders(app);
  const syncKey = randomBytes(32).toString('hex');
  const merge = (entries: ReadingStateEntry[], key = syncKey) => app.inject({ method: 'POST', url: '/api/v1/reading-state/merge', headers, payload: { syncKey: key, entries } });
  const read = (offset = 0, limit = 500, key = syncKey) => app.inject({ method: 'POST', url: '/api/v1/reading-state/read', headers, payload: { syncKey: key, offset, limit } });
  return { dataDir, app, headers, syncKey, merge, read, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('reading progress is private, admitted-device only and does not store the sync secret', async () => {
  const f = await fixture();
  try {
    const admin = await consoleHeaders(f.app, f.dataDir);
    for (const route of ['read', 'merge']) {
      const payload = route === 'read' ? { syncKey: f.syncKey } : { syncKey: f.syncKey, entries: [entry()] };
      assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/reading-state/${route}`, payload })).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'POST', url: `/api/v1/reading-state/${route}`, payload, headers: admin })).statusCode, 403);
    }
    const saved = await f.merge([entry()]);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.headers['cache-control'], 'no-store');
    assert.deepEqual(saved.json(), { received: 1, updated: 1, total: 1 });
    const unknown = await f.read(0, 500, randomBytes(32).toString('hex'));
    assert.deepEqual(unknown.json(), { entries: [], total: 0, nextOffset: null });
    const secondDevice = await deviceHeaders(f.app, 'Tablet');
    const shared = await f.app.inject({ method: 'POST', url: '/api/v1/reading-state/read', headers: secondDevice, payload: { syncKey: f.syncKey } });
    assert.equal(shared.statusCode, 200, shared.body);
    assert.deepEqual(shared.json().entries, [entry()]);
    assert.equal(shared.headers['cache-control'], 'no-store');
    const db = new DatabaseSync(join(f.dataDir, 'metadata.sqlite'));
    try {
      const row = db.prepare('SELECT profile_hash,entry FROM reading_state_entries').get() as { profile_hash: string; entry: string };
      assert.equal(row.profile_hash, createHash('sha256').update(f.syncKey).digest('hex'));
      assert.equal(JSON.stringify(row).includes(f.syncKey), false);
      db.prepare('UPDATE devices SET blocked=1').run();
    } finally { db.close(); }
    assert.equal((await f.read()).statusCode, 403);
    assert.equal((await f.merge([entry()])).statusCode, 403);
    assert.equal((await f.app.inject('/api/v1/reading-state')).statusCode, 404);
  } finally { await f.close(); }
});

test('reading-state merges preserve more complete state and are idempotent', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.merge([entry({ progress: 90, bookmark: true, readAt: 1700000020 })])).statusCode, 200);
    const merged = await f.merge([entry({ progress: 12, unread: false, readAt: 1700000001 })]);
    assert.deepEqual(merged.json(), { received: 1, updated: 1, total: 1 });
    const expected = entry({ progress: 90, bookmark: true, unread: false, readAt: 1700000020 });
    assert.deepEqual((await f.read()).json().entries, [expected]);
    assert.deepEqual((await f.merge([entry({ progress: 12, unread: false, readAt: 1700000001 })])).json(), { received: 1, updated: 0, total: 1 });
    assert.deepEqual((await f.merge([entry({ progress: 100, unread: true, bookmark: false, readAt: null })])).json(), { received: 1, updated: 1, total: 1 });
    assert.deepEqual((await f.read()).json().entries, [{ ...expected, progress: 100 }]);
    assert.deepEqual((await f.merge([])).json(), { received: 0, updated: 0, total: 1 });
  } finally { await f.close(); }
});

test('reading-state identities follow stable source IDs with separate chapter pages and path namespaces', async () => {
  const f = await fixture();
  try {
    const entries = [
      entry({ sourceNovelId: 'WORK-1' }),
      entry({ page: '2' }),
      entry({ sourceNovelId: null, novelPath: 'work-1' }),
      entry({ chapterNumber: null, chapterPath: '1' }),
      entry({ pluginId: 'other-source' }),
    ];
    assert.deepEqual((await f.merge(entries)).json(), { received: 5, updated: 5, total: 5 });
    const moved = entry({ novelPath: '/novel/new-url', chapterPath: '/new/chapter-url', progress: 80, readAt: 1700000100 });
    assert.deepEqual((await f.merge([moved])).json(), { received: 1, updated: 1, total: 5 });
    const records = (await f.read()).json().entries as ReadingStateEntry[];
    assert.deepEqual(records[0], moved);
    assert.equal(records[1].page, '2');
    assert.equal(records[2].sourceNovelId, null);
    assert.equal(records[3].chapterNumber, null);
    assert.equal(records[4].pluginId, 'other-source');
  } finally { await f.close(); }
});

test('reading-state pagination is bounded and retains order across updates, appended entries and restart', async () => {
  const f = await fixture();
  try {
    const records = Array.from({ length: 505 }, (_, index) => entry({ chapterNumber: String(index + 1), chapterPath: `/chapter/${index + 1}` }));
    for (let index = 0; index < records.length; index += 200) {
      const response = await f.merge(records.slice(index, index + 200));
      assert.equal(response.statusCode, 200, response.body);
    }
    const first = (await f.read()).json();
    assert.equal(first.entries.length, 500);
    assert.equal(first.total, 505);
    assert.equal(first.nextOffset, 500);
    await f.merge([{ ...records[0], progress: 90 }, entry({ chapterNumber: '999', chapterPath: '/chapter/999' })]);
    const second = (await f.read(500)).json();
    assert.equal(second.entries.length, 6);
    assert.equal(second.total, 506);
    assert.equal(second.nextOffset, null);
    assert.deepEqual(second.entries.slice(0, 5), records.slice(500));
    assert.equal(second.entries[5].chapterNumber, '999');
    await f.app.close();
    const restarted = await buildApp({ dataDir: f.dataDir });
    try {
      const response = await restarted.inject({ method: 'POST', url: '/api/v1/reading-state/read', headers: f.headers, payload: { syncKey: f.syncKey, limit: 1 } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().total, 506);
      assert.equal(response.json().entries[0].progress, 90);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('invalid reading-state batches are rejected before any partial write', async () => {
  const f = await fixture();
  try {
    const invalidEntries: ReadingStateEntry[] = [
      entry({ progress: -1 }), entry({ progress: 101 }), entry({ readAt: -1 }), entry({ readAt: 1.5 }),
      entry({ pluginId: '' }), entry({ pluginId: '   ' }), entry({ page: '' }), entry({ chapterNumber: '' }),
      entry({ sourceNovelId: '' }), entry({ novelPath: '' }), entry({ chapterPath: '' }),
    ];
    for (const invalid of invalidEntries) {
      const response = await f.merge([entry(), invalid]);
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal((await f.merge(Array.from({ length: 201 }, () => entry()))).statusCode, 400);
    assert.equal((await f.merge([entry()], 'not-a-key')).statusCode, 400);
    for (const [offset, limit] of [[-1, 500], [0, 0], [0, 501], [0.5, 1]]) assert.equal((await f.read(offset, limit)).statusCode, 400);
    assert.equal((await f.read()).json().total, 0);
  } finally { await f.close(); }
});

test('reading-state additive upgrade preserves the original schema checksum, catalog, credentials, settings and files', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-reading-upgrade-'));
  try {
    const original = openDatabase(dataDir);
    const checksum = original.prepare('SELECT checksum FROM schema_state').get()?.checksum;
    // Removing only the new extension recreates a pre-feature current-format DB.
    original.exec('DROP TABLE reading_state_entries');
    original.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?)').run('existing-setting', 'preserve');
    original.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?)').run('existing-device', 'existing-hash', 'Existing phone', 1, 2, 0);
    original.prepare('INSERT INTO works VALUES(?,?,?,?)').run('existing-work', 'work-directory', '{"name":"Preserved book"}', 'fingerprint');
    original.prepare('INSERT INTO chapters VALUES(?,?,?,?,?,?)').run('existing-chapter', 'existing-work', '{"state":"preserve"}', 'chapter-directory', '/chapter/1', null);
    original.close();
    const artifactPath = join(dataDir, 'original-chapter-bytes');
    const artifact = Buffer.from([0, 255, 13, 10, 99, 111, 110, 116, 101, 110, 116]);
    await writeFile(artifactPath, artifact);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const upgraded = openDatabase(dataDir);
      try {
        assert.equal(upgraded.prepare('SELECT checksum FROM schema_state').get()?.checksum, checksum);
        assert.equal(upgraded.prepare('SELECT value FROM admin_settings WHERE key=?').get('existing-setting')?.value, 'preserve');
        assert.equal(upgraded.prepare('SELECT key_hash FROM devices WHERE id=?').get('existing-device')?.key_hash, 'existing-hash');
        assert.equal(upgraded.prepare('SELECT entry FROM works WHERE id=?').get('existing-work')?.entry, '{"name":"Preserved book"}');
        assert.equal(upgraded.prepare('SELECT entry FROM chapters WHERE id=?').get('existing-chapter')?.entry, '{"state":"preserve"}');
        assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM reading_state_entries').get()?.count, 0);
      } finally { upgraded.close(); }
    }
    assert.deepEqual(await readFile(artifactPath), artifact);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
