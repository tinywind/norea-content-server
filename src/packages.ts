import { createHash, randomUUID } from 'node:crypto';
import { cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import yauzl from 'yauzl';
import { canonicalize } from 'json-canonicalize';
import { SAXParser } from 'parse5-sax-parser';
import { problem, transaction } from './db.ts';

export interface PackageManifest {
  packageVersion: 1;
  layout?: 'chapter-files';
  identity: { pluginId: string; novelPath: string; chapterPath: string };
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: 'html' | 'text' | 'markdown' | 'pdf'; page: string };
  bodyPath: string;
  files: ({ path: string; size: number } & ({ sha256: string; modifiedAt?: never } | { modifiedAt: number; sha256?: never }))[];
}
export interface CatalogEntry { id: string; revision: string; zipSha256?: string; zipBytes?: number; fileBytes?: number; manifest: PackageManifest; deleted: boolean; sequence: number }
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
  const path = join('contents', plugin, novel, chapter);
  if (!safeArchivePath(path.split('\\').join('/'))) throw problem(400, 'Content identity cannot be stored in a portable readable directory');
  return path;
}

export function safeArchivePath(path: string): boolean {
  return !!path && path.length <= 1024 && !path.includes('\\') && !path.includes(':') && !/[\x00-\x1f]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export function validateManifest(value: unknown): asserts value is PackageManifest {
  const m = value as PackageManifest;
  if (!m || typeof m !== 'object' || m.packageVersion !== 1 || !m.identity || !m.novel || !m.chapter || !Array.isArray(m.files)) throw problem(400, 'Unsupported or incomplete package manifest');
  const allowed = (object: object, names: string[]) => { if (Object.keys(object).some(key => !names.includes(key))) throw problem(400, 'Unknown package manifest field'); };
  allowed(m, ['packageVersion','layout','identity','novel','chapter','bodyPath','files']);
  if (m.layout !== undefined && m.layout !== 'chapter-files') throw problem(400, 'Unsupported chapter file layout');
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
    if (!file || typeof file.path !== 'string' || !safeArchivePath(file.path) || (file.path === 'manifest.json' && m.layout !== 'chapter-files') || !Number.isSafeInteger(file.size) || file.size < 0) throw problem(400, 'Invalid file manifest');
    if (m.layout === 'chapter-files') {
      if (typeof file.modifiedAt !== 'number' || !Number.isSafeInteger(file.modifiedAt) || file.modifiedAt < 0) throw problem(400, 'Invalid file modification time');
      allowed(file, ['path','size','modifiedAt']);
    } else {
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw problem(400, 'Invalid legacy file checksum');
      allowed(file, ['path','size','sha256']);
    }
    if (index && m.files[index - 1].path >= file.path) throw problem(400, 'Manifest files must be sorted and unique');
  }
  if (!m.files.some(file => file.path === m.bodyPath)) throw problem(400, 'Body is absent from file manifest');
}

async function inspectZip(path: string, limits: Limits): Promise<PackageManifest> {
  const zip = await new Promise<yauzl.ZipFile>((accept, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(problem(400, 'Invalid ZIP package')) : accept(value!)));
  const found = new Map<string, number>();
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
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.length; expanded += chunk.length;
            if (expanded > limits.expandedBytes || (name === 'manifest.json' && size > 4 * 1024 ** 2)) { stream.destroy(); throw problem(413, 'Expanded package limit exceeded'); }
            if (name === 'manifest.json') chunks.push(chunk);
          }
          found.set(name, size);
          if (name === 'manifest.json') { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); validateManifest(parsed); manifest = parsed; }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    if (!manifest || manifest.files.length + 1 !== found.size) throw problem(400, 'Missing manifest or undeclared archive files');
    for (const file of manifest.files) {
      const actual = found.get(file.path);
      if (actual === undefined || actual !== file.size) throw problem(400, 'Missing or wrong-sized package file');
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

export async function publishPackage(db: DatabaseSync, dataDir: string, input: Readable, limits: Limits, imported = false): Promise<CatalogEntry> {
  const startedAt = uploadCursor(db);
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
    if (manifest.layout !== undefined) throw problem(400, 'Original chapter files require the chapter-files upload endpoint');
    const id = digest(JSON.stringify([manifest.identity.pluginId, manifest.identity.novelPath, manifest.identity.chapterPath]));
    const revision = digest(canonicalize(manifest));
    const entry: CatalogEntry = { id, revision, zipSha256: hash.digest('hex'), zipBytes, manifest, deleted: false, sequence: 0 };
    return publishRevision(db, dataDir, stage, entry, startedAt, imported);
  } finally { await rm(stage, { force: true }); }
}

function moveStoredRevision(source: string, destination: string): void {
  try { renameSync(source, destination); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  // Content bind mounts can be on a different filesystem from server state.
  const temporary = join(dirname(destination), `.norea-move-${randomUUID()}`);
  try {
    cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const retired = join(dirname(source), `.norea-move-${randomUUID()}`);
  try { renameSync(source, retired); }
  catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
  // A locked cleanup file must not invalidate the completed copy or its DB path.
  try { rmSync(retired, { recursive: true }); }
  catch { console.warn('Deferred removal of a retired chapter storage copy'); }
}

function storedFilesExist(dataDir: string, path: string, entry: CatalogEntry): boolean {
  const regularFile = (path: string, bytes: number | undefined) => {
    try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const target = join(dataDir, path);
  if (entry.manifest.layout !== 'chapter-files') return regularFile(target, entry.zipBytes);
  try { if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  return entry.manifest.files.every(file => regularFile(join(target, file.path), file.size));
}

export function completeChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry | undefined {
  const row = db.prepare("SELECT c.entry,r.path FROM chapters c JOIN revisions r ON r.chapter_id=c.id AND r.revision=json_extract(c.entry,'$.revision') WHERE c.id=? AND c.deleted_at IS NULL AND r.deleted=0").get(id) as { entry: string; path: string | null } | undefined;
  if (!row?.path) return;
  const entry = JSON.parse(row.entry) as CatalogEntry;
  return storedFilesExist(dataDir, row.path, entry) ? entry : undefined;
}

export function discardChapterHistory(db: DatabaseSync, dataDir: string): void {
  const chapters = db.prepare('SELECT chapter_id FROM revisions GROUP BY chapter_id HAVING count(*)>1').all() as { chapter_id: string }[];
  for (const { chapter_id: id } of chapters) {
    const current = chapterRow(db, id).catalog;
    const copies = db.prepare('SELECT revision,entry,path FROM revisions WHERE chapter_id=? ORDER BY rowid DESC').all(id) as { revision: string; entry: string; path: string | null }[];
    const preferred = copies.find(copy => copy.revision === current.revision);
    const complete = (copy: typeof preferred) => copy?.path && storedFilesExist(dataDir, copy.path, JSON.parse(copy.entry));
    const keep = (complete(preferred) ? preferred : copies.find(complete)) ?? preferred ?? copies[0];
    for (const copy of copies) {
      if (copy === keep || !copy.path || copy.path === keep.path) continue;
      rmSync(join(dataDir, copy.path), { recursive: true, force: true });
    }
    transaction(db, () => {
      if (keep.revision !== current.revision) recordEntry(db, { ...JSON.parse(keep.entry), deleted: current.deleted });
      db.prepare('DELETE FROM revisions WHERE chapter_id=? AND revision<>?').run(id, keep.revision);
    });
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS revisions_chapter ON revisions(chapter_id)');
}

export function uploadCursor(db: DatabaseSync): { catalog: number; works: number } {
  return db.prepare('SELECT (SELECT coalesce(max(sequence),0) FROM catalog_changes) AS catalog,(SELECT coalesce(max(sequence),0) FROM work_changes) AS works').get() as { catalog: number; works: number };
}

export function publishRevision(db: DatabaseSync, dataDir: string, stage: string, entry: CatalogEntry, startedAt: ReturnType<typeof uploadCursor>, imported = false): CatalogEntry {
  const { id, revision, manifest } = entry;
  const backups: { from: string; to: string }[] = [];
  let publishedPath: string | undefined;
  let committed = false;
  try {
    const result = transaction(db, () => {
      const existing = db.prepare('SELECT entry,directory,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; deleted_at: number | null } | undefined;
      const work = workId(manifest.identity);
      const workDeletion = db.prepare('SELECT deleted,sequence FROM work_tombstones WHERE work_id=?').get(work) as { deleted: number; sequence: number } | undefined;
      const deletion = db.prepare('SELECT sequence FROM chapter_tombstones WHERE chapter_id=?').get(id) as { sequence: number } | undefined;
      if ((imported && existing?.deleted_at != null) || workDeletion?.deleted || (deletion?.sequence ?? 0) > startedAt.catalog || (workDeletion?.sequence ?? 0) > startedAt.works) throw problem(409, 'Content was deleted; start a new upload to replace it');
      const current = completeChapter(db, dataDir, id);
      if (current) return current;
      const storedWork = db.prepare('SELECT directory,entry FROM works WHERE id=?').get(work) as { directory: string; entry: string } | undefined;
      if (!storedWork || manifest.identity.novelPath.startsWith('norea-folder:')) throw problem(409, 'Register exact work metadata before uploading chapter packages');
      const directory = existing?.directory ?? join(storedWork.directory, ...(imported ? ['.packages'] : []), basename(chapterDirectory(manifest)));
      if (!existing && db.prepare('SELECT id FROM chapters WHERE lower(directory)=lower(?) AND id<>?').get(directory, id)) throw problem(409, 'Readable chapter directory is already used by another identity');
      const file = join(directory, revisionFileName(entry));
      if (imported) {
        for (let current = resolve(dataDir, file); ; current = dirname(current)) {
          if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw problem(400, 'Symbolic package storage paths are unsupported');
          if (dirname(current) === current) break;
        }
      }
      mkdirSync(join(dataDir, directory), { recursive: true });
      for (const previous of db.prepare('SELECT path FROM revisions WHERE chapter_id=? AND path IS NOT NULL').all(id) as { path: string }[]) {
        const from = join(dataDir, previous.path);
        if (!existsSync(from)) continue;
        const to = join(dirname(from), `.norea-replaced-${randomUUID()}`);
        renameSync(from, to); backups.push({ from, to });
      }
      moveStoredRevision(stage, join(dataDir, file));
      publishedPath = join(dataDir, file);
      if (!existing) db.prepare('INSERT INTO chapters(id,work_id,entry,directory) VALUES(?,?,?,?)').run(id, work, JSON.stringify(entry), directory);
      db.prepare('UPDATE chapters SET deleted_at=NULL WHERE id=?').run(id);
      const published = recordEntry(db, entry);
      db.prepare('DELETE FROM revisions WHERE chapter_id=?').run(id);
      db.prepare('INSERT INTO revisions(chapter_id,revision,entry,path) VALUES(?,?,?,?)').run(id, revision, JSON.stringify(published), file);
      return published;
    });
    committed = true;
    return result;
  } finally {
    if (committed) { for (const backup of backups) rmSync(backup.to, { recursive: true, force: true }); }
    else {
      if (publishedPath) rmSync(publishedPath, { recursive: true, force: true });
      for (const backup of backups.reverse()) renameSync(backup.to, backup.from);
    }
  }
}

function revisionFileName(entry: CatalogEntry): string { return `${entry.revision}.${entry.manifest.layout === 'chapter-files' ? 'files' : 'zip'}`; }

export function chapterRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT entry,directory,deleted_at FROM chapters WHERE id=?').get(id) as { entry: string; directory: string; deleted_at: number | null } | undefined;
  if (!row) throw problem(404, 'Chapter not found');
  return { ...row, catalog: JSON.parse(row.entry) as CatalogEntry };
}

export function deleteChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry {
  const row = chapterRow(db, id);
  if (row.catalog.deleted) return row.catalog;
  const trash = join('trash', `${id}-${Date.now()}`);
  const revisions = db.prepare('SELECT revision,path,entry FROM revisions WHERE chapter_id=?').all(id) as { revision: string; path: string | null; entry: string }[];
  const moves: { from: string; to: string }[] = [];
  try {
    mkdirSync(join(dataDir, trash), { recursive: true });
    for (const revision of revisions) {
      if (!revision.path) continue;
      const from = join(dataDir, revision.path); const to = join(dataDir, trash, revisionFileName(JSON.parse(revision.entry)));
      if (existsSync(from)) { moveStoredRevision(from, to); moves.push({ from, to }); }
    }
    return transaction(db, () => {
      for (const revision of revisions) if (revision.path) db.prepare('UPDATE revisions SET path=? WHERE chapter_id=? AND revision=?').run(join(trash, revisionFileName(JSON.parse(revision.entry))), id, revision.revision);
      db.prepare('UPDATE chapters SET deleted_at=?,generation=generation+1 WHERE id=?').run(Date.now(), id);
      const entry = recordEntry(db, { ...row.catalog, deleted: true });
      db.prepare('INSERT INTO chapter_tombstones VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET sequence=excluded.sequence').run(id, entry.sequence);
      return entry;
    });
  } catch (error) { for (const move of moves.reverse()) moveStoredRevision(move.to, move.from); throw error; }
}

export function restoreChapter(db: DatabaseSync, dataDir: string, id: string): CatalogEntry {
  const row = chapterRow(db, id);
  const workDeletion = db.prepare('SELECT deleted FROM work_tombstones WHERE work_id=?').get(workId(row.catalog.manifest.identity)) as { deleted: number } | undefined;
  if (workDeletion?.deleted) throw problem(409, 'Restore the work before restoring its chapters');
  if (!row.catalog.deleted) return row.catalog;
  const revisions = db.prepare('SELECT revision,path,entry FROM revisions WHERE chapter_id=? AND path IS NOT NULL').all(id) as { revision: string; path: string; entry: string }[];
  const moves: { from: string; to: string }[] = [];
  try {
    mkdirSync(join(dataDir, row.directory), { recursive: true });
    for (const revision of revisions) {
      const from = join(dataDir, revision.path); const to = join(dataDir, row.directory, revisionFileName(JSON.parse(revision.entry)));
      moveStoredRevision(from, to); moves.push({ from, to });
    }
    return transaction(db, () => {
      for (const revision of revisions) db.prepare('UPDATE revisions SET path=? WHERE chapter_id=? AND revision=?').run(join(row.directory, revisionFileName(JSON.parse(revision.entry))), id, revision.revision);
      db.prepare('UPDATE chapters SET deleted_at=NULL WHERE id=?').run(id);
      return recordEntry(db, { ...row.catalog, deleted: !revisions.some(revision => revision.revision === row.catalog.revision) });
    });
  } catch (error) { for (const move of moves.reverse()) moveStoredRevision(move.to, move.from); throw error; }
}

export function purgeChapter(db: DatabaseSync, dataDir: string, id: string): void {
  const row = chapterRow(db, id);
  if (row.deleted_at === null) throw problem(409, 'Only deleted chapters can be purged');
  const revisions = db.prepare('SELECT path FROM revisions WHERE chapter_id=? AND path IS NOT NULL').all(id) as { path: string }[];
  for (const revision of revisions) {
    const file = resolve(dataDir, revision.path);
    if (!file.startsWith(resolve(dataDir, 'trash') + sep)) throw problem(500, 'Unexpected package storage path');
    rmSync(file, { recursive: true, force: true });
  }
  db.prepare('UPDATE revisions SET path=NULL WHERE chapter_id=?').run(id);
}

export function packageStream(db: DatabaseSync, dataDir: string, id: string) {
  const { catalog } = chapterRow(db, id);
  if (catalog.deleted) throw problem(410, 'Chapter was deleted');
  if (catalog.manifest.layout === 'chapter-files' || catalog.zipBytes === undefined || !catalog.zipSha256) throw problem(406, 'Download the original chapter files instead of a ZIP package');
  const revision = db.prepare('SELECT path FROM revisions WHERE chapter_id=? AND revision=? AND deleted=0').get(id, catalog.revision) as { path: string | null } | undefined;
  if (!revision?.path || !existsSync(join(dataDir, revision.path))) throw problem(410, 'Package is unavailable');
  return { catalog: { ...catalog, zipBytes: catalog.zipBytes, zipSha256: catalog.zipSha256 }, open: (start?: number, end?: number) => createReadStream(join(dataDir, revision.path!), { start, end }) };
}
