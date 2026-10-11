import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import yauzl from 'yauzl';
import { canonicalize } from 'json-canonicalize';
import { SAXParser } from 'parse5-sax-parser';
import { problem, transaction } from './db.ts';

export interface PackageManifest {
  packageVersion: 1;
  identity: { pluginId: string; novelPath: string; chapterPath: string };
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: 'html' | 'text' | 'markdown' | 'pdf'; page: string };
  bodyPath: string;
  files: { path: string; size: number; sha256: string }[];
}
export interface CatalogEntry { id: string; revision: string; zipSha256: string; zipBytes: number; manifest: PackageManifest; deleted: boolean; sequence: number }
export interface Limits { zipBytes: number; expandedBytes: number; files: number }
export const defaultLimits: Limits = { zipBytes: 512 * 1024 ** 2, expandedBytes: 2 * 1024 ** 3, files: 10000 };
export const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const workId = (identity: PackageManifest['identity']) => digest(JSON.stringify([identity.pluginId, identity.novelPath]));
function safeSegment(value: string | null | undefined, fallback: string): string {
  const sanitized = (value?.trim() || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return !sanitized || sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

function safeLabel(value: string, fallback: string): string {
  const sanitized = [...(value.trim() || fallback)].map(ch => {
    const code = ch.codePointAt(0)!;
    const unsafeFormat = code === 0x180e || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
    return /[\s/:*?"<>|\\]/.test(ch) || unsafeFormat ? '-' : ch;
  }).join('').replace(/^[.-]+|[.-]+$/g, '').slice(0, 96);
  return !sanitized || sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

function chapterDirectory(manifest: PackageManifest): string {
  const plugin = safeSegment(manifest.identity.pluginId, 'source');
  const novel = `${safeLabel(manifest.novel.name, 'novel')}-${safeSegment(manifest.identity.novelPath, 'novel')}`;
  const chapter = `${safeSegment(manifest.chapter.chapterNumber, manifest.chapter.position > 0 ? String(manifest.chapter.position) : 'chapter')}-${safeLabel(manifest.chapter.name, 'chapter')}`;
  const path = `contents/${plugin}/${novel}/${chapter}`;
  if (!safeArchivePath(path)) throw problem(400, 'Content identity cannot be stored in a portable readable directory');
  return join('contents', plugin, novel, chapter);
}

export function safeArchivePath(path: string): boolean {
  return !!path && path.length <= 1024 && !path.includes('\\') && !path.includes(':') && !/[\x00-\x1f]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export function validateManifest(value: unknown): asserts value is PackageManifest {
  const m = value as PackageManifest;
  if (!m || typeof m !== 'object' || m.packageVersion !== 1 || !m.identity || !m.novel || !m.chapter || !Array.isArray(m.files)) throw problem(400, 'Unsupported or incomplete package manifest');
  const allowed = (object: object, names: string[]) => { if (Object.keys(object).some(key => !names.includes(key))) throw problem(400, 'Unknown package manifest field'); };
  allowed(m, ['packageVersion','identity','novel','chapter','bodyPath','files']);
  allowed(m.identity, ['pluginId','novelPath','chapterPath']);
  allowed(m.novel, ['name','author','summary','isLocal']);
  allowed(m.chapter, ['name','position','chapterNumber','contentType','page']);
  for (const value of [m.novel.author, m.novel.summary, m.chapter.chapterNumber]) if (value !== undefined && value !== null && typeof value !== 'string') throw problem(400, 'Invalid optional package metadata');
  const validUnicode = (value: unknown): void => {
    if (typeof value === 'string' && !value.isWellFormed()) throw problem(400, 'Invalid Unicode in package manifest');
    if (value && typeof value === 'object') for (const item of Object.values(value)) validUnicode(item);
  };
  validUnicode(m);
  for (const v of [m.identity.pluginId, m.identity.novelPath, m.identity.chapterPath, m.novel.name, m.chapter.name]) if (typeof v !== 'string' || !v || v.length > 4096) throw problem(400, 'Invalid package identity or title');
  if (typeof m.novel.isLocal !== 'boolean' || !Number.isFinite(m.chapter.position) || typeof m.chapter.page !== 'string' || !['html','text','markdown','pdf'].includes(m.chapter.contentType)) throw problem(400, 'Invalid package metadata');
  if (typeof m.bodyPath !== 'string' || !safeArchivePath(m.bodyPath)) throw problem(400, 'Invalid body path');
  for (let index = 0; index < m.files.length; index++) {
    const file = m.files[index];
    if (!file || typeof file.path !== 'string' || !safeArchivePath(file.path) || file.path === 'manifest.json' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw problem(400, 'Invalid file manifest');
    allowed(file, ['path','size','sha256']);
    if (index && m.files[index - 1].path >= file.path) throw problem(400, 'Manifest files must be sorted and unique');
  }
  if (!m.files.some(file => file.path === m.bodyPath)) throw problem(400, 'Body is absent from file manifest');
}

async function inspectZip(path: string, limits: Limits): Promise<PackageManifest> {
  const zip = await new Promise<yauzl.ZipFile>((accept, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(problem(400, 'Invalid ZIP package')) : accept(value!)));
  const found = new Map<string, { size: number; sha256: string }>();
  const entries = new Map<string, yauzl.Entry>();
  const portableNames = new Set<string>();
  let manifest: PackageManifest | undefined;
  let expanded = 0;
  try {
    await new Promise<void>((accept, reject) => {
      zip.on('error', reject);
      zip.on('end', accept);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const name = entry.fileName;
          entries.set(name, entry);
          const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (!safeArchivePath(name) || portableNames.has(name.toLowerCase()) || (unixType !== 0 && unixType !== 0x8000) || (entry.generalPurposeBitFlag & 1)) throw problem(400, 'Unsafe, duplicate, or encrypted archive entry');
          portableNames.add(name.toLowerCase());
          if (portableNames.size > limits.files + 1) throw problem(413, 'Package file limit exceeded');
          if (expanded + entry.uncompressedSize > limits.expandedBytes || (name === 'manifest.json' && entry.uncompressedSize > 4 * 1024 ** 2)) throw problem(413, 'Expanded package limit exceeded');
          const stream = await new Promise<Readable>((acceptStream, rejectStream) => zip.openReadStream(entry, (error, value) => error ? rejectStream(error) : acceptStream(value!)));
          const hash = createHash('sha256');
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.length; expanded += chunk.length;
            if (expanded > limits.expandedBytes || (name === 'manifest.json' && size > 4 * 1024 ** 2)) { stream.destroy(); throw problem(413, 'Expanded package limit exceeded'); }
            hash.update(chunk);
            if (name === 'manifest.json') chunks.push(chunk);
          }
          found.set(name, { size, sha256: hash.digest('hex') });
          if (name === 'manifest.json') { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); validateManifest(parsed); manifest = parsed; }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    if (!manifest || manifest.files.length + 1 !== found.size) throw problem(400, 'Missing manifest or undeclared archive files');
    for (const file of manifest.files) {
      const actual = found.get(file.path);
      if (!actual || actual.size !== file.size || actual.sha256 !== file.sha256) throw problem(400, 'Missing or corrupt package file');
    }
    if (manifest.chapter.contentType === 'html') {
      const stream = await new Promise<Readable>((accept, reject) => zip.openReadStream(entries.get(manifest!.bodyPath)!, (error, stream) => error ? reject(error) : accept(stream!)));
      await validateHtmlAssets(stream, manifest);
    }
    return manifest;
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error;
    throw problem(400, 'Invalid ZIP package');
  } finally { zip.close(); }
}

async function validateHtmlAssets(stream: Readable, manifest: PackageManifest): Promise<void> {
  stream.setEncoding('utf8');
  const files = new Set(manifest.files.map(file => file.path));
  const parser = new SAXParser();
  let failure: Error | undefined;
  const reference = (raw: string) => {
    const value = raw.trim();
    if (!value || value.startsWith('#') || /^data:/i.test(value)) return;
    try {
      if (/^[a-z][a-z\d+.-]*:|^\/|\\/i.test(value)) throw new Error();
      const base = new URL(manifest.bodyPath, 'https://package.invalid/');
      const url = new URL(value, base);
      const path = decodeURIComponent(url.pathname.slice(1));
      if (!safeArchivePath(path) || !files.has(path)) throw new Error();
    } catch { failure ??= problem(400, 'Chapter references an external or missing asset'); }
  };
  const css = (value: string) => {
    if (/\\|@import/i.test(value)) { failure ??= problem(400, 'CSS imports and escaped asset URLs are unsupported'); return; }
    for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) reference(match[1] ?? match[2] ?? match[3]);
  };
  let style = false;
  parser.on('startTag', token => {
    if (token.tagName === 'base') failure ??= problem(400, 'Package HTML cannot override its asset base URL');
    style = token.tagName === 'style';
    for (const attribute of token.attrs) {
      const name = attribute.name;
      if (['src','poster','background'].includes(name) || (name === 'href' && ['link','image','use'].includes(token.tagName)) || (name === 'data' && token.tagName === 'object')) reference(attribute.value);
      if (name === 'srcset') for (const item of attribute.value.split(',')) reference(item.trim().split(/\s+/)[0]);
      if (name === 'style') css(attribute.value);
    }
  });
  parser.on('endTag', token => { if (token.tagName === 'style') style = false; });
  parser.on('text', token => { if (style) css(token.text); });
  await pipeline(stream, parser, new Writable({ write(_chunk, _encoding, done) { done(); } }));
  if (failure) throw failure;
}

export function recordEntry(db: DatabaseSync, entry: CatalogEntry): CatalogEntry {
  const next = { ...entry };
  const result = db.prepare('INSERT INTO catalog_changes(chapter_id,entry) VALUES(?,?)').run(entry.id, '{}');
  next.sequence = Number(result.lastInsertRowid);
  const json = JSON.stringify(next);
  db.prepare('UPDATE catalog_changes SET entry=? WHERE sequence=?').run(json, next.sequence);
  db.prepare('UPDATE chapters SET entry=? WHERE id=?').run(json, next.id);
  return next;
}

export async function publishPackage(db: DatabaseSync, dataDir: string, input: Readable, limits: Limits): Promise<CatalogEntry> {
  const startedAt = Number((db.prepare('SELECT coalesce(max(sequence),0) AS seq FROM catalog_changes').get() as { seq: number }).seq);
  const stageDir = join(dataDir, 'staging'); await mkdir(stageDir, { recursive: true });
  const stage = join(stageDir, `${randomUUID()}.zip`);
  let zipBytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, _encoding, done) {
    zipBytes += chunk.length;
    if (zipBytes > limits.zipBytes) return done(problem(413, 'ZIP package limit exceeded'));
    hash.update(chunk); done(null, chunk);
  } });
  try {
    const forwardError = (error: Error) => meter.destroy(error);
    input.on('error', forwardError);
    try { await pipeline(input.pipe(meter), createWriteStream(stage, { flags: 'wx' })); }
    finally { input.off('error', forwardError); input.unpipe(meter); input.resume(); }
    const manifest = await inspectZip(stage, limits);
    const id = digest(JSON.stringify([manifest.identity.pluginId, manifest.identity.novelPath, manifest.identity.chapterPath]));
    const revision = digest(canonicalize(manifest));
    const entry: CatalogEntry = { id, revision, zipSha256: hash.digest('hex'), zipBytes, manifest, deleted: false, sequence: 0 };
    return transaction(db, () => {
      const existing = db.prepare('SELECT entry,directory,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; deleted_at: number | null } | undefined;
      const work = workId(manifest.identity);
      const workDeletion = db.prepare('SELECT deleted,sequence FROM work_tombstones WHERE work_id=?').get(work) as { deleted: number; sequence: number } | undefined;
      const deletion = db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(id) as { sequence: number } | undefined;
      if (existing?.deleted_at != null || workDeletion?.deleted || (deletion?.sequence ?? 0) > startedAt || (workDeletion?.sequence ?? 0) > startedAt) throw problem(409, 'Content was deleted; an administrator must restore it');
      const previous = db.prepare('SELECT entry,path,deleted FROM revisions WHERE chapter_id=? AND revision=?').get(id, revision) as { entry: string; path: string | null; deleted: number } | undefined;
      if (previous?.deleted) throw problem(409, 'Revision was permanently deleted');
      if (previous?.path) return JSON.parse(previous.entry);
      const storedWork = db.prepare('SELECT directory,entry FROM works WHERE id=?').get(work) as { directory: string; entry: string } | undefined;
      const storedChapter = storedWork ? (JSON.parse(storedWork.entry).metadata.chapters as { path: string; directory: string }[]).find(chapter => chapter.path === manifest.identity.chapterPath) : undefined;
      const directory = existing?.directory ?? (storedWork ? join(storedWork.directory, storedChapter?.directory ?? basename(chapterDirectory(manifest))) : chapterDirectory(manifest));
      if (!existing && db.prepare('SELECT id FROM chapters WHERE lower(directory)=lower(?) AND id<>?').get(directory, id)) throw problem(409, 'Readable chapter directory is already used by another identity');
      const file = join(directory, `${revision}.zip`);
      mkdirSync(join(dataDir, directory), { recursive: true });
      renameSync(stage, join(dataDir, file));
      try {
        if (!existing) db.prepare('INSERT INTO chapters(id,work_id,entry,directory) VALUES(?,?,?,?)').run(id, work, JSON.stringify(entry), directory);
        const current = existing ? JSON.parse(existing.entry) as CatalogEntry : undefined;
        const published = !current || current.deleted || !db.prepare('SELECT path FROM revisions WHERE chapter_id=? AND revision=? AND path IS NOT NULL').get(id, current.revision) ? recordEntry(db, entry) : { ...entry, sequence: current.sequence };
        db.prepare('INSERT INTO revisions(chapter_id,revision,entry,path) VALUES(?,?,?,?) ON CONFLICT(chapter_id,revision) DO UPDATE SET entry=excluded.entry,path=excluded.path').run(id, revision, JSON.stringify(published), file);
        return published;
      } catch (error) { rmSync(join(dataDir, file), { force: true }); throw error; }
    });
  } finally { await rm(stage, { force: true }); }
}

export function chapterRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT entry,directory,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; deleted_at: number | null } | undefined;
  if (!row) throw problem(404, 'Chapter not found');
  return { ...row, catalog: JSON.parse(row.entry) as CatalogEntry };
}

export function deleteChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry {
  const row = chapterRow(db, id);
  if (row.catalog.deleted) return row.catalog;
  const trash = join('trash', `${id}-${Date.now()}`);
  const source = join(dataDir, row.directory);
  const destination = join(dataDir, trash);
  mkdirSync(join(dataDir, 'trash'), { recursive: true });
  if (existsSync(source)) renameSync(source, destination);
  try {
    return transaction(db, () => {
      const revisions = db.prepare('SELECT revision,path FROM revisions WHERE chapter_id=?').all(id) as { revision: string; path: string | null }[];
      for (const revision of revisions) if (revision.path) db.prepare('UPDATE revisions SET path=? WHERE chapter_id=? AND revision=?').run(join(trash, `${revision.revision}.zip`), id, revision.revision);
      db.prepare('UPDATE chapters SET deleted_at=?,generation=generation+1 WHERE id=?').run(Date.now(), id);
      const entry = recordEntry(db, { ...row.catalog, deleted: true });
      db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(id, entry.sequence);
      return entry;
    });
  } catch (error) { if (existsSync(destination)) renameSync(destination, source); throw error; }
}

export function restoreChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry {
  const row = chapterRow(db, id);
  const workDeletion = db.prepare('SELECT deleted FROM work_tombstones WHERE work_id=?').get(workId(row.catalog.manifest.identity)) as { deleted: number } | undefined;
  if (workDeletion?.deleted) throw problem(409, 'Restore the work before restoring its chapters');
  if (!row.catalog.deleted) return row.catalog;
  const revisions = db.prepare('SELECT revision,path FROM revisions WHERE chapter_id=? AND path IS NOT NULL').all(id) as { revision: string; path: string }[];
  const moves: { from: string; to: string }[] = [];
  try {
    mkdirSync(join(dataDir, row.directory), { recursive: true });
    for (const revision of revisions) {
      const from = join(dataDir, revision.path); const to = join(dataDir, row.directory, `${revision.revision}.zip`);
      renameSync(from, to); moves.push({ from, to });
    }
    return transaction(db, () => {
      for (const revision of revisions) db.prepare('UPDATE revisions SET path=? WHERE chapter_id=? AND revision=?').run(join(row.directory, `${revision.revision}.zip`), id, revision.revision);
      db.prepare('UPDATE chapters SET deleted_at=NULL WHERE id=?').run(id);
      return recordEntry(db, { ...row.catalog, deleted: !revisions.some(revision => revision.revision === row.catalog.revision) });
    });
  } catch (error) { for (const move of moves.reverse()) renameSync(move.to, move.from); throw error; }
}

export function purgeChapter(db: DatabaseSync, dataDir: string, id: string): void {
  const row = chapterRow(db, id);
  if (row.deleted_at === null) throw problem(409, 'Only deleted chapters can be purged');
  const revisions = db.prepare('SELECT path FROM revisions WHERE chapter_id=? AND path IS NOT NULL').all(id) as { path: string }[];
  for (const revision of revisions) {
    const file = resolve(dataDir, revision.path);
    if (!file.startsWith(resolve(dataDir, 'trash') + sep)) throw problem(500, 'Unexpected package storage path');
    rmSync(file, { force: true });
  }
  db.prepare('UPDATE revisions SET path=NULL WHERE chapter_id=?').run(id);
}

export function packageStream(db: DatabaseSync, dataDir: string, id: string) {
  const { catalog } = chapterRow(db, id);
  if (catalog.deleted) throw problem(410, 'Chapter was deleted');
  const revision = db.prepare('SELECT path FROM revisions WHERE chapter_id=? AND revision=? AND deleted=0').get(id, catalog.revision) as { path: string | null } | undefined;
  if (!revision?.path || !existsSync(join(dataDir, revision.path))) throw problem(410, 'Package is unavailable');
  return { catalog, open: (start?: number, end?: number) => createReadStream(join(dataDir, revision.path!), { start, end }) };
}
