import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';

test('the current server exposes only original chapter file transfers and no revision history table', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'current-format-'));
  const app = await buildApp({ dataDir });
  try {
    const paths = (await app.inject('/api/v1/openapi.json')).json().paths;
    assert.equal(paths['/api/v1/packages'], undefined);
    assert.equal(paths['/api/v1/chapters'], undefined);
    assert.equal(paths['/api/v1/chapters/{id}/package'], undefined);
    assert(paths['/api/v1/chapter-files']);
    assert.equal((await app.inject('/api/v1/chapters?after=0&limit=100')).statusCode, 404);
    const db = openDatabase(dataDir);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='revisions'").get(), undefined);
    assert((db.prepare('PRAGMA table_info(chapters)').all() as { name: string }[]).some(column => column.name === 'path'));
    db.close();
  } finally { await app.close(); await rm(dataDir, { recursive: true }); }
});

test('an obsolete database is rejected without schema migration or modifying its data', async () => {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(join('.tmp', 'obsolete-schema-'));
  try {
    const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'));
    db.exec("CREATE TABLE old_data(value TEXT); INSERT INTO old_data VALUES('preserve'); PRAGMA user_version=1");
    db.close();
    let unexpected: DatabaseSync | undefined;
    try { assert.throws(() => { unexpected = openDatabase(dataDir); }, /current schema/); }
    finally { unexpected?.close(); }
    const check = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly: true });
    assert.equal(check.prepare('SELECT value FROM old_data').get()?.value, 'preserve');
    check.close();
  } finally { await rm(dataDir, { recursive: true }); }
});
