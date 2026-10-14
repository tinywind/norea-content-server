import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ZipFile } from 'yazl';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { digest } from '../src/packages.ts';
import { saveWork } from '../src/works.ts';
import { consoleHeaders, deviceHeaders } from './access.ts';

async function setup() {
  await mkdir('.tmp', { recursive: true });
  const dataDir = await mkdtemp(resolve('.tmp', 'storage-mounts-'));
  const db = openDatabase(dataDir);
  saveWork(db, dataDir, { schemaVersion: 1, identity: { pluginId: 'source', novelPath: '/work' }, novel: { name: 'Work', cover: null, author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false }, cover: null });
  const app = await buildApp({ dataDir });
  const headers = await deviceHeaders(app);
  return { app, db, dataDir, headers, close: async () => { db.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

async function upload(s: Awaited<ReturnType<typeof setup>>, raw: boolean) {
  const body = Buffer.from('Original chapter bytes');
  const manifest = { packageVersion: 1, identity: { pluginId: 'source', novelPath: '/work', chapterPath: raw ? '/raw' : '/legacy' }, novel: { name: 'Work', isLocal: false }, chapter: { name: raw ? 'Raw' : 'Legacy', position: raw ? 1 : 2, contentType: 'html', page: '1' }, bodyPath: 'content.html', files: [{ path: 'content.html', size: body.length, ...raw ? { modifiedAt: 1700000000000 } : { sha256: digest(body) } }], ...raw ? { layout: 'chapter-files' } : {} };
  if (raw) {
    const form = new FormData();
    form.append('metadata', JSON.stringify(manifest));
    form.append('content.html', new Blob([body]), 'content.html');
    const request = new Request('http://localhost', { method: 'POST', body: form });
    return s.app.inject({ method: 'POST', url: '/api/v1/chapter-files', headers: { ...s.headers, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
  }
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  zip.addBuffer(body, 'content.html'); zip.end();
  const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return s.app.inject({ method: 'POST', url: '/api/v1/packages', headers: { ...s.headers, 'content-type': 'application/zip' }, payload: Buffer.concat(chunks) });
}

function separateContentsMount(dataDir: string) {
  const rename = fs.renameSync;
  const contents = join(dataDir, 'contents') + sep;
  let crossings = 0;
  fs.renameSync = (from, to) => {
    if (String(from).startsWith(contents) !== String(to).startsWith(contents)) {
      crossings++;
      throw Object.assign(new Error('Cross-device link'), { code: 'EXDEV' });
    }
    rename(from, to);
  };
  syncBuiltinESMExports();
  return { crossings: () => crossings, restore: () => { fs.renameSync = rename; syncBuiltinESMExports(); } };
}

test('separate content and state mounts support upload, download, trash, restore, and purge', async () => {
  const s = await setup(); const mount = separateContentsMount(s.dataDir);
  try {
    const admin = await consoleHeaders(s.app, s.dataDir);
    for (const raw of [true, false]) {
      const response = await upload(s, raw);
      assert.equal(response.statusCode, 200, response.body);
      const entry = response.json();
      const url = raw ? `/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.html` : `/api/v1/chapters/${entry.id}/package`;
      const original = (await s.app.inject(url)).rawPayload;
      assert.ok(original.length);
      const publishedPath = (s.db.prepare('SELECT path FROM revisions WHERE chapter_id=?').get(entry.id) as { path: string }).path;
      assert.ok(publishedPath.startsWith(`contents${sep}`));
      assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers })).statusCode, 200);
      const trashedPath = (s.db.prepare('SELECT path FROM revisions WHERE chapter_id=?').get(entry.id) as { path: string }).path;
      assert.ok(trashedPath.startsWith(`trash${sep}`));
      await assert.rejects(readFile(join(s.dataDir, publishedPath, ...raw ? ['content.html'] : [])), /ENOENT/);
      assert.equal((await s.app.inject(url)).statusCode, 410);
      assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: s.headers })).statusCode, 200);
      assert.deepEqual((await s.app.inject(url)).rawPayload, original);
      await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers });
      assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/purge`, headers: admin })).statusCode, 200);
    }
    assert.equal(mount.crossings(), 8);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    assert.equal((await readdir(s.dataDir, { recursive: true })).some(name => name.includes('.norea-move-')), false);
  } finally { mount.restore(); await s.close(); }
});

test('failed cross-device copies leave no published revision or partial content', async () => {
  const s = await setup(); const mount = separateContentsMount(s.dataDir);
  const copy = fs.cpSync;
  let copies = 0;
  fs.cpSync = (from, to, options) => { copy(from, to, options); copies++; throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }); };
  syncBuiltinESMExports();
  try {
    for (const raw of [true, false]) assert.equal((await upload(s, raw)).statusCode, 500);
    assert.equal(copies, 2);
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM revisions').get() as { n: number }).n, 0);
    assert.deepEqual(await readdir(join(s.dataDir, 'staging')), []);
    const names = await readdir(join(s.dataDir, 'contents'), { recursive: true });
    assert.equal(names.some(name => name.includes('.norea-move-') || /\.(files|zip)$/.test(name)), false);
  } finally { fs.cpSync = copy; mount.restore(); await s.close(); }
});

test('a locked retired source does not lose the complete copy or its catalog path', async () => {
  const s = await setup(); const mount = separateContentsMount(s.dataDir);
  const remove = fs.rmSync;
  try {
    const entry = (await upload(s, true)).json();
    fs.rmSync = (path, options) => {
      if (String(path).includes(`${sep}contents${sep}`) && String(path).includes('.norea-move-') && fs.existsSync(path)) {
        throw Object.assign(new Error('Retired source is locked'), { code: 'EBUSY' });
      }
      remove(path, options);
    };
    syncBuiltinESMExports();
    const deletion = await s.app.inject({ method: 'DELETE', url: `/api/v1/chapters/${entry.id}`, headers: s.headers });
    assert.equal(deletion.statusCode, 200, deletion.body);
    const stored = (s.db.prepare('SELECT path FROM revisions WHERE chapter_id=?').get(entry.id) as { path: string }).path;
    assert.ok(stored.startsWith(`trash${sep}`));
    assert.equal(await readFile(join(s.dataDir, stored, 'content.html'), 'utf8'), 'Original chapter bytes');
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/v1/chapters/${entry.id}/restore`, headers: s.headers })).statusCode, 200);
    assert.equal((await s.app.inject(`/api/v1/chapters/${entry.id}/files?revision=${entry.revision}&path=content.html`)).body, 'Original chapter bytes');
  } finally { fs.rmSync = remove; mount.restore(); await s.close(); }
});
