import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { initializePluginRegistry, listPlugins, registerPlugin, removePlugin, setPluginEnabled, enabledSources } from '../src/plugin-registry.ts';

const source = (id: string, installMode = 'single') => ({ id, name: id, lang: 'en', version: '1.0.0', apiVersion: '0.2', url: `https://example.com/${id}.js`, iconUrl: '', installMode });

async function setup() {
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp', 'registry-'));
  const db = new DatabaseSync(join(directory, 'test.sqlite'));
  initializePluginRegistry(db);
  const index = async (name: string, value: unknown) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; };
  return { db, directory, index, close: async () => { db.close(); await rm(directory, { recursive: true }); } };
}

test('registers several actual repository indexes, reloads stable identities and persists enabled state', async () => {
  const context = await setup();
  try {
    const firstUrl = await context.index('first.json', [source('project-gutenberg'), source('github-docs', 'multiSource')]);
    const first = await registerPlugin(context.db, { url: firstUrl, name: 'Public sources' });
    await registerPlugin(context.db, { url: await context.index('second.json', [source('komga')]) });
    assert.equal(listPlugins(context.db).length, 2);
    assert.deepEqual(enabledSources(context.db).map(item => item.id).sort(), ['komga', 'project-gutenberg']);
    assert.deepEqual(enabledSources(context.db, ['github-docs:my-book', 'github-docs-other:ignored']).map(item => item.id).sort(), ['github-docs:my-book', 'komga', 'project-gutenberg']);
    const updated = await registerPlugin(context.db, { url: firstUrl });
    assert.equal(updated.id, first.id);
    assert.equal(updated.name, 'Public sources');
    setPluginEnabled(context.db, first.id, false);
    const reopened = new DatabaseSync(join(context.directory, 'test.sqlite'));
    initializePluginRegistry(reopened);
    assert.deepEqual(enabledSources(reopened).map(item => item.id), ['komga']);
    reopened.close();
    assert.equal(removePlugin(context.db, first.id), true);
    assert.equal(removePlugin(context.db, first.id), false);
  } finally { await context.close(); }
});

test('rejects duplicate source IDs and keeps existing registry intact on failed reload', async () => {
  const context = await setup();
  try {
    const firstUrl = await context.index('first.json', [source('one')]);
    const first = await registerPlugin(context.db, { url: firstUrl });
    await registerPlugin(context.db, { url: await context.index('second.json', [source('two')]) });
    await writeFile(firstUrl, JSON.stringify([source('two')]));
    await assert.rejects(registerPlugin(context.db, { url: firstUrl }), /already registered/);
    assert.equal(listPlugins(context.db).find(item => item.id === first.id)?.sources[0].id, 'one');
    await assert.rejects(registerPlugin(context.db, { url: await context.index('third.json', [source('one'), source('one')]) }), /Duplicate/);
    assert.equal(listPlugins(context.db).length, 2);
  } finally { await context.close(); }
});

test('rejects JavaScript, incompatible metadata and unsafe IDs without evaluating source', async () => {
  const context = await setup();
  try {
    const jsPath = join(context.directory, 'plugin.js');
    await writeFile(jsPath, 'globalThis.executed = true; module.exports.default = {}');
    await assert.rejects(registerPlugin(context.db, { url: jsPath }), /repository JSON/);
    for (const value of [{ sources: [source('one')] }, [source('../escape')], [{ ...source('one'), apiVersion: '0.1' }], [{ ...source('one'), installMode: 'unknown' }], []]) {
      await assert.rejects(registerPlugin(context.db, { url: await context.index('invalid.json', value) }));
    }
    assert.deepEqual(listPlugins(context.db), []);
  } finally { await context.close(); }
});

test('rejects a concrete source ID that overlaps a multi-source provider namespace', async () => {
  const context = await setup();
  try {
    await registerPlugin(context.db, { url: await context.index('provider.json', [source('github-docs', 'multiSource')]) });
    await assert.rejects(registerPlugin(context.db, { url: await context.index('instance.json', [source('github-docs:my-book')]) }), /already registered/);
    assert.equal(listPlugins(context.db).length, 1);
  } finally { await context.close(); }
});

test('reads HTTP repository indexes and rejects oversized responses', async () => {
  const context = await setup();
  const server = createServer((request, response) => {
    if (request.url === '/large') { response.setHeader('content-length', 3 * 1024 * 1024); response.end('[]'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([source('remote')]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const registered = await registerPlugin(context.db, { url: `http://127.0.0.1:${address.port}/index.json` });
    assert.equal(registered.sources[0].id, 'remote');
    await assert.rejects(registerPlugin(context.db, { url: `http://127.0.0.1:${address.port}/large` }), /too large/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await context.close(); }
});

test('uses embedded URL credentials for HTTP authentication and preserves registered URLs', async () => {
  const context = await setup();
  const requests: { path: string | undefined; authorization: string | undefined }[] = [];
  const pluginUrl = 'https://x-access-token:sample-token@example.com/plugin.js';
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Basic ${Buffer.from('x-access-token:sample@token:/+').toString('base64')}`) {
      response.writeHead(401).end(); return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ ...source('private'), url: pluginUrl }]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const url = `http://x-access-token:${encodeURIComponent('sample@token:/+')}@127.0.0.1:${address.port}/index.json`;
    const registered = await registerPlugin(context.db, { url });
    assert.equal(registered.url, url);
    assert.equal(registered.sources[0].url, pluginUrl);
    assert.equal(requests[0].path, '/index.json');
    assert.equal(listPlugins(context.db)[0].url, url);
    assert.equal((await registerPlugin(context.db, { url })).id, registered.id);
    await assert.rejects(registerPlugin(context.db, { url: `http://127.0.0.1:${address.port}/index.json` }), /HTTP 401/);
    await assert.rejects(registerPlugin(context.db, { url: 'ftp://user:password@example.com/index.json' }), /HTTP\(S\)/);
    assert.equal(listPlugins(context.db).length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await context.close(); }
});
