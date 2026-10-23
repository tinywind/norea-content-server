# Content synchronization implementation plan

> Use test-driven development and bounded parallel work on the server and native
> transfer adapter. The parent session owns app UI and integration.

Goal: run a real local content server and synchronize complete Norea chapters and
content with the connected S25, preserving local reading state and folder names.

Architecture: a Fastify REST server stores metadata in SQLite and original files
in readable chapter folders. Norea maps its local IDs to plugin/path
identities, delegates file transfer to native code, and keeps sync independent of
the reader. The protocol below is the shared implementation contract.

Tech stack: TypeScript, Fastify, REST/OpenAPI, SQLite, existing Tauri/Rust/Android.
Spec: [design.md](design.md).

Status: the original implementation has been followed by account-free device access.
The current authentication contract and development schema policy are recorded in
[device-access-plan.md](device-access-plan.md).
Its integration results are in [verification-2026-10-12.md](verification-2026-10-12.md).
See [verification-2026-10-11.md](verification-2026-10-11.md) for executed checks
and the design capabilities that remain unimplemented.

## Constraints

- Work in the existing main checkouts; preserve all unrelated files and app data.
- English source/docs, app translations only in strings/languages.
- Test artifacts and runtime state belong in `.tmp/`, never in tracked files.
- No replacement of readable plugin/work/chapter folders with opaque hashes.
- 512 MiB ZIP, 2 GiB expanded, 10,000 files; complete immutable publication only.
- Stream package files; do not move large binary arrays through the WebView.
- Test only Android aarch64 on ADB serial R5CY509QC0D; never clear device app data.

## Wire contract version 2

All JSON uses camelCase. An Identity is `{pluginId, novelId, novelPath, chapterPath}`.
The canonical identity string is `JSON.stringify([pluginId, novelPath, chapterPath])`.
An opaque server chapter ID can be a SHA-256 of this string; it is not a folder name.
The source plugin provides `novelId`, a required literal portable directory ID.
App and server files use `contents/<pluginId>/<novelId>/<chapter-number>/`;
titles remain in metadata. Unsafe IDs and directory collisions are rejected.

A PackageManifest is:

```typescript
interface PackageManifest {
  packageVersion: 1;
  layout: "chapter-files";
  identity: { pluginId: string; novelId: string; novelPath: string; chapterPath: string };
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: "html" | "text" | "markdown" | "pdf"; page: string };
  bodyPath: string;
  files: { path: string; size: number; modifiedAt: number }[];
}
```

New original-file transfers use `layout: "chapter-files"` and each descriptor is
`{path,size,modifiedAt}`. `modifiedAt` is a nonnegative safe integer Unix timestamp
in milliseconds. Send the metadata as the first multipart field, then the original
body (`content.html` or `content.pdf`), optional `manifest.json`, and optional
`media.zip`. The file field name and filename match the original path. Preserve
all file bytes and media references. Media must be complete; validate archive
central-directory names and sizes without extracting assets or checking CRCs.

Only the current original-file format is supported. Check declared sizes,
complete receive, and inventory before publication or installation. Do not retain
outer ZIP transfers, previous manifest readers, or file payload hashes.

Hash the RFC 8785 canonical JSON metadata manifest for revision identity. Files
are sorted by path. Modification times distinguish same-size changes to original
files. Reject unsafe, duplicate, missing, wrong-sized, and unlisted entries.

Endpoints (all under `/api/v1`):

- `GET /capabilities`: `{apiVersion:1,packageVersion:1,anonymousRead:boolean,authentication:"device-key",personalStateSync:false}`.
- `GET /openapi.json`: generated OpenAPI from route schemas.
- `POST /console-sessions` `{password}` -> `{token}`; 24-hour administrator session.
- `DELETE /console-sessions/current`: revoke the current console session.
- `POST /devices/register` `{deviceKey,deviceName}` -> `{id,deviceName}`.
  New keys are accepted automatically, existing keys are reused, blocked keys fail.
- `GET /admin/devices` -> `{items:[{id,deviceName,createdAt,lastSeenAt,blocked}]}`.
- `PATCH /admin/devices/:id` `{blocked:boolean}`: console-only access control.
- `GET /chapters?after=<integer>&limit=<1..100>` -> `{items:CatalogEntry[],cursor,hasMore}`.
- `POST /chapter-files`: original files as multipart with device bearer key -> CatalogEntry.
- `GET /chapters/:id/files?revision=...&path=...`: original bytes, Content-Length,
  and an ETag containing the quoted revision, a colon, and original path.
- `DELETE /chapters/:id`: device or console tombstone and trash.
- `POST /chapters/:id/restore`: explicit device or console restoration.
- `POST /chapters/:id/purge`: console-only permanent removal of deleted files.
- `GET /changes?catalogAfter=0&workAfter=0&waitSeconds=20` -> `{catalogCursor,workCursor}`.

CatalogEntry is `{id,revision,fileBytes,manifest,deleted,sequence}`.
`revision` identifies the current copy during a download; it is not version history.
There are no database upgrades or conversions from previous formats. Server
schema mismatch requires a fresh state volume. The app resets a mismatched schema.
Catalog pages include tombstones to suppress stale reuploads. Account, old session,
and personal-state routes are removed. Device keys are random 32-byte hex values;
servers persist only their hashes. Local reading records never enter the protocol.

### Incremental catalog and change hints

Catalog writes append durable sequence entries. A page cursor is the final returned
sequence; an empty page retains the requested cursor. Drain all pages and persist
each cursor only after successful application. Hints are targets, not applied-page
cursors. `catalogAfter` is a nonnegative safe integer; ahead-of-log cursors return
409. `waitSeconds` accepts 0 through 20. Bearer credentials are validated even
when anonymous reading is enabled, and again after a waited response. Disconnect
and shutdown release waiters. Personal-state changes never trigger server hints.

## Task 1: server

Files: package.json, tsconfig.json, .gitignore, src/{app,main,db,auth,packages,changes}.ts,
test/*.test.ts, README.md, Dockerfile and compose.yaml.

- [x] Write failing Fastify injection/integration tests using real SQLite and ZIPs
  for anonymous catalog, unauthorized upload, login/revocation, package checks,
  restart persistence, Range, deletion/reupload, and device/console boundaries.
- [x] Implement `buildApp({dataDir,anonymousRead?})` returning a Fastify instance;
  create an installation secret and automatically register device keys.
- [x] Run tests and typecheck. Document local startup, device access, OpenAPI and
  backup; package files must remain under readable plugin/work/chapter directories.

## Task 2: native chapter transfer

Files: Norea src-tauri/src/content_sync.rs, IPC registration, Android storage bridge
as needed, src/lib/content-sync/native.ts. No UI or DB query edits in this task.

Interfaces exported by native.ts:

- `uploadContentChapter(input: {serverUrl:string;token:string;chapterId:number;manifest:Omit<PackageManifest,"files"|"bodyPath">;storageDir:string}): Promise<CatalogEntry>`.
- `downloadContentChapter(input: {serverUrl:string;token?:string;entry:CatalogEntry;storageDir:string;chapterId:number}): Promise<{contentBytes:number;mediaBytes:number}>`.

`fingerprintContentChapter({storageDir})` records local file sizes and modification
times before upload without hashing payloads.
Types are defined in native.ts for app orchestration to import. The adapter
must support Android SAF storage and Windows existing storage roots. Verify complete
media before export, preserve current files on failed import, and stage temporary
files in app cache. Network helpers are app-owned, never source-plugin traffic.

- [x] Add failing validation/round-trip tests, then implement streaming packaging,
  HTTP transfer, size validation and atomic install with local reference conversion.
- [x] Run focused native checks and supply the parent with the exact IPC contract.

## Task 3: app synchronization and settings

Files: Norea src/lib/content-sync/{client,sync}.ts, src/store/content-sync.ts,
src/components/ContentServerSettings.tsx, settings integration, locale keys.

- [x] Test remote catalog import, local row-ID remapping, unchanged readable paths,
  tombstone suppression, retry after failure, key persistence and blocked access.
- [x] Add optional server URL/device settings, automatic registration, manual sync,
  and per-chapter download actions.
- [x] Persist pending content changes and per-device download exclusions.
  Trigger sync on configured lifecycle events without blocking local reading.
- [x] Keep library, read state, bookmarks, and positions local. Reading mutations
  must not queue transfers or contact personal-state endpoints.
- [x] Run TypeScript checks, relevant tests and project verification skills.

## Task 4: integration and device evidence

- [x] Start a loopback-only local server with data in server `.tmp/local-server`.
- [x] Build targeted Android aarch64 APK, preserve installed data, connect the S25
  through `adb reverse`, and install/update the correct app channel.
- [x] Exercise automatic registration, real package transfers, and offline reading.
  Use temporary owned fixture content only; do not delete the user's chapters.
- [x] Review the complete changes, resolve important findings, and record exact
  passing checks and any uncovered acceptance scenarios in a verification report.

## Review focus

- Torn ZIP uploads must remain unpublished (Task 1 integration test).
- Missing assets and malicious archive paths must fail before replacing files
  (Tasks 1 and 2 validation/rollback tests).
- Same plugin/path content with different local numeric IDs must restore properly
  (Tasks 2 and 3 round-trip tests).
- Server switches and retries must retain isolated device keys (Tasks 1 and 3).
- Offline restart and server deletion must not remove local data or resurrect
  server content (Tasks 1, 3 and device smoke).

## Administration and folder-ingestion implementation

1. Implement `plugin-registry.ts` and real manifest tests: multiple repositories,
   validation, update rollback, duplicate source IDs, enable/disable, and provider
   expansion. No plugin code execution.
2. Implement `folder-indexer.ts` with SQLite/ZIP fixtures: stable metadata
   snapshot, plugin-independent local traversal, complete portable packages, legacy skips,
   cancellation, tombstone preservation, and proof of unchanged source bytes.
3. Implement `administration.ts` and API tests: authenticated routes, persistent
   roots/jobs/results, scan cancellation/restart recovery, scheduling, catalog
   queries, device access management, and persisted anonymous-read policy.
4. Implement `web/` console and TypeScript asset build. Integrate static routes,
   OpenAPI, server lifecycle, and production dependency/build packaging.
5. Run server tests, TypeScript checks, and frontend build. Exercise the actual
   console in desktop/mobile layouts and perform a read-only scan of the existing
   local Norea folder. Keep runtime evidence under `.tmp/`; do not commit/push.
