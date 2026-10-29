import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { problem, transaction } from './db.ts';

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 5000;

export interface SourceDescriptor {
  id: string;
  name: string;
  lang: string;
  version: string;
  apiVersion: '0.2';
  url: string;
  iconUrl: string;
  installMode?: 'single' | 'multiSource';
}

export interface RegisteredPlugin {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  sources: SourceDescriptor[];
  updatedAt: string;
}

export interface RegisterPluginInput {
  url: string;
  name?: string;
  enabled?: boolean;
}

export function listPlugins(db: DatabaseSync): RegisteredPlugin[] {
  return db.prepare('SELECT * FROM plugin_registrations ORDER BY name,id').all().map(row => ({
    id: String(row.id), name: String(row.name), url: String(row.url), enabled: row.enabled === 1,
    sources: JSON.parse(String(row.sources)) as SourceDescriptor[], updatedAt: String(row.updated_at),
  }));
}

function httpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw problem(400, 'Repository and plugin URLs must be absolute HTTP(S) URLs.'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw problem(400, 'Repository and plugin URLs must use HTTP(S).');
  }
  url.hash = '';
  return url.href;
}

function repositoryLocation(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw problem(400, 'Repository URL or absolute JSON file path is required.');
  const location = value.trim();
  if (isAbsolute(location)) return resolve(location);
  if (location.startsWith('file:')) {
    try { return resolve(fileURLToPath(location)); } catch { throw problem(400, 'Invalid repository file URL.'); }
  }
  return httpUrl(location);
}

async function readRepository(location: string): Promise<string> {
  if (isAbsolute(location)) {
    const file = await open(location, 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile()) throw problem(400, 'Repository path must point to a JSON file.');
      if (stats.size > MAX_INDEX_BYTES) throw problem(400, 'Repository JSON is too large.');
      const buffer = Buffer.alloc(MAX_INDEX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_INDEX_BYTES) throw problem(400, 'Repository JSON is too large.');
      return buffer.subarray(0, length).toString('utf8');
    } finally { await file.close(); }
  }
  let url = new URL(location);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (url.username || url.password) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  const origin = url.origin;
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  for (let redirects = 0; ; redirects++) {
    response = await fetch(url, { signal, headers, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw problem(400, 'Repository redirect has no destination.');
    if (redirects >= 5) throw problem(400, 'Repository redirect limit exceeded.');
    const next = new URL(location, url);
    if (next.origin !== origin) throw problem(400, 'Repository redirects must stay on the selected origin.');
    if (next.username || next.password) throw problem(400, 'Repository redirects cannot change credentials.');
    url = next;
  }
  if (!response.ok) { await response.body?.cancel(); throw problem(400, `Repository returned HTTP ${response.status}.`); }
  if (Number(response.headers.get('content-length')) > MAX_INDEX_BYTES) {
    await response.body?.cancel();
    throw problem(400, 'Repository JSON is too large.');
  }
  if (!response.body) throw problem(400, 'Repository returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_INDEX_BYTES) throw problem(400, 'Repository JSON is too large.');
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

function parseSources(text: string): SourceDescriptor[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw problem(400, 'Expected a Norea repository JSON array; JavaScript plugin execution is not supported.'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_SOURCES) {
    throw problem(400, `Expected a non-empty Norea repository JSON array with at most ${MAX_SOURCES} plugins.`);
  }
  const seen = new Set<string>();
  const sources = parsed.map((item: unknown, index): SourceDescriptor => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw problem(400, `Invalid plugin at index ${index}.`);
    const value = item as Record<string, unknown>;
    for (const field of ['id', 'name', 'lang', 'version', 'url']) {
      if (typeof value[field] !== 'string' || !(value[field] as string).trim() || (value[field] as string).length > 2048) {
        throw problem(400, `Plugin at index ${index} requires string field '${field}'.`);
      }
    }
    const id = value.id as string;
    if (id !== id.trim() || id === '.' || id === '..' || /[\\/\u0000-\u001f\u007f]/.test(id)) throw problem(400, `Invalid source ID at index ${index}.`);
    if (seen.has(id)) throw problem(409, `Duplicate source ID '${id}' in repository.`);
    seen.add(id);
    if (value.apiVersion !== '0.2') throw problem(400, `Plugin '${id}' must declare apiVersion '0.2'.`);
    if (typeof value.iconUrl !== 'string') throw problem(400, `Plugin '${id}' requires string field 'iconUrl'.`);
    if (value.installMode !== undefined && value.installMode !== 'single' && value.installMode !== 'multiSource') {
      throw problem(400, `Plugin '${id}' has an unsupported installMode.`);
    }
    return {
      id, name: value.name as string, lang: value.lang as string, version: value.version as string,
      apiVersion: '0.2', url: httpUrl(value.url as string), iconUrl: value.iconUrl,
      ...(value.installMode === undefined ? {} : { installMode: value.installMode }),
    };
  });
  for (const source of sources) {
    if (source.installMode !== 'multiSource') continue;
    if (sources.some(other => other !== source && other.id.startsWith(`${source.id}:`))) {
      throw problem(409, `Duplicate source namespace '${source.id}' in repository.`);
    }
  }
  return sources;
}

function sourcesOverlap(left: SourceDescriptor, right: SourceDescriptor): boolean {
  return left.id === right.id
    || (left.installMode === 'multiSource' && right.id.startsWith(`${left.id}:`))
    || (right.installMode === 'multiSource' && left.id.startsWith(`${right.id}:`));
}

export async function registerPlugin(db: DatabaseSync, input: RegisterPluginInput): Promise<RegisteredPlugin> {
  if (!input || typeof input !== 'object') throw problem(400, 'Repository registration is required.');
  const url = repositoryLocation(input.url);
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200)) throw problem(400, 'Repository name must contain 1 to 200 characters.');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw problem(400, 'Repository enabled must be a boolean.');
  let text: string;
  try { text = await readRepository(url); } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    throw problem(400, `Cannot read repository JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sources = parseSources(text);
  return transaction(db, () => {
    const registrations = listPlugins(db);
    const existing = registrations.find(item => item.url === url);
    for (const registration of registrations) {
      if (registration.id === existing?.id) continue;
      const conflict = registration.sources.find(source => sources.some(candidate => sourcesOverlap(source, candidate)));
      if (conflict) throw problem(409, `Source '${conflict.id}' is already registered by '${registration.name}'.`);
    }
    const plugin: RegisteredPlugin = {
      id: existing?.id ?? createHash('sha256').update(url).digest('hex').slice(0, 24),
      name: input.name?.trim() ?? existing?.name ?? (isAbsolute(url) ? basename(url) : new URL(url).hostname),
      url, enabled: input.enabled ?? existing?.enabled ?? true, sources, updatedAt: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO plugin_registrations(id,url,name,enabled,sources,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,sources=excluded.sources,updated_at=excluded.updated_at`)
      .run(plugin.id, plugin.url, plugin.name, Number(plugin.enabled), JSON.stringify(plugin.sources), plugin.updatedAt);
    return plugin;
  });
}

export function removePlugin(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM plugin_registrations WHERE id=?').run(id).changes) > 0;
}

export function setPluginEnabled(db: DatabaseSync, id: string, enabled: boolean): RegisteredPlugin {
  if (typeof enabled !== 'boolean') throw problem(400, 'Repository enabled must be a boolean.');
  const result = db.prepare('UPDATE plugin_registrations SET enabled=?,updated_at=? WHERE id=?').run(Number(enabled), new Date().toISOString(), id);
  if (!result.changes) throw problem(404, 'Plugin repository not found.');
  return listPlugins(db).find(plugin => plugin.id === id)!;
}

export function enabledSources(db: DatabaseSync, installedSourceIds: string[] = []): SourceDescriptor[] {
  const result = new Map<string, SourceDescriptor>();
  for (const plugin of listPlugins(db).filter(item => item.enabled)) {
    for (const source of plugin.sources) {
      if (source.installMode !== 'multiSource') result.set(source.id, source);
      else for (const id of installedSourceIds) {
        if (id.startsWith(`${source.id}:`) && id.length > source.id.length + 1) {
          result.set(id, { ...source, id, name: id, installMode: 'single' });
        }
      }
    }
  }
  return [...result.values()];
}
