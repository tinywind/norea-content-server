# Content synchronization implementation plan

> Use test-driven development and bounded parallel work on the server and native
> transfer adapter. The parent session owns app UI and integration.

Goal: run a real local content server and synchronize complete Norea chapters and
account state with the connected S25, preserving offline reading and folder names.

Architecture: a Fastify REST server stores metadata in SQLite and immutable ZIP
revisions in readable chapter folders. Norea maps its local IDs to plugin/path
identities, delegates file transfer to native code, and keeps sync independent of
the reader. The protocol below is the shared implementation contract.

Tech stack: TypeScript, Fastify, REST/OpenAPI, SQLite, existing Tauri/Rust/Android.
Spec: [design.md](design.md).

Status: the first working implementation is complete for the scope below.
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

## Wire contract v1

All JSON uses camelCase. An Identity is `{pluginId, novelPath, chapterPath}`.
The canonical identity string is `JSON.stringify([pluginId, novelPath, chapterPath])`.
An opaque server chapter ID can be a SHA-256 of this string; it is not a folder name.

A PackageManifest is:

```typescript
interface PackageManifest {
  packageVersion: 1;
  identity: { pluginId: string; novelPath: string; chapterPath: string };
  novel: { name: string; author?: string | null; summary?: string | null; isLocal: boolean };
  chapter: { name: string; position: number; chapterNumber?: string | null; contentType: "html" | "text" | "markdown" | "pdf"; page: string };
  bodyPath: string;
  files: { path: string; size: number; sha256: string }[];
}
```

`manifest.json` is the envelope and is not listed in files. Other entries are the
body (`content.html` or `content.pdf`), optional `media-manifest.json` (existing
complete Norea media metadata), and expanded assets under `media/`. Export portable
relative asset references and restore Norea's local media references on import.
Hash the RFC 8785 canonical JSON manifest for revision identity. Files are sorted
by path. Reject unsafe, duplicate, missing, unlisted, and corrupt entries.

Endpoints (all under `/api/v1`):

- `GET /capabilities`: `{apiVersion:1,packageVersion:1,anonymousRead:boolean}`.
- `GET /openapi.json`: generated OpenAPI from registered route schemas.
- `POST /sessions` `{username,password,deviceName}` -> `{token,user:{id,username,role}}`.
- `DELETE /sessions/current`: revoke current bearer token.
- `GET /chapters?after=<integer>&limit=<1..100>` -> `{items: CatalogEntry[],cursor:number,hasMore:boolean}`.
- `POST /packages` with raw `application/zip` body and bearer token -> CatalogEntry.
- `GET /chapters/:id/package`: current complete ZIP, ETag, Content-Length, Range.
- `DELETE /chapters/:id`: admin tombstone and trash; ordinary uploads cannot revive it.
- `POST /chapters/:id/restore`: admin restore.
- `POST /chapters/:id/revision` `{revision}`: admin select default.
- `GET /state`: authenticated `{items: StateEntry[]}`.
- `PUT /state`: authenticated StateMutation -> StateEntry, HTTP 409 with current
  state and preserved candidates on a conflicting position/read-state update.

CatalogEntry is `{id,revision,zipSha256,zipBytes,manifest,deleted,sequence}`.
Catalog pages include tombstones so clients can suppress stale reuploads.
Authentication never accepts a user ID from the client as account authority.

StateEntry is `{key,version,value,conflicts}`. StateMutation is
`{key,baseVersion,operationId,deviceName,value}`. `key` is an identity string scoped
with `position:`, `read:`, `bookmark:`, or `library:`. Value is a JSON object.
Each conflict includes operationId, deviceName and value. Identical operation IDs
are idempotent; membership/bookmark concurrent removals win, while later explicit
adds are permitted. A resolution uses the returned current version.

## Task 1: server

Files: package.json, tsconfig.json, .gitignore, src/{app,main,db,auth,packages,state}.ts,
test/*.test.ts, README.md, Dockerfile and compose.yaml.

- [x] Write failing Fastify injection/integration tests using real SQLite and ZIPs
  for anonymous catalog, unauthorized upload, login/revocation, package checks,
  restart persistence, Range, deletion/reupload, and account-isolated conflicts.
- [x] Implement `buildApp({dataDir,anonymousRead?})` returning a Fastify instance;
  expose an admin provisioning CLI without tracked credentials.
- [x] Run tests and typecheck. Document local startup, provisioning, OpenAPI and
  backup; package files must remain under readable plugin/work/chapter directories.

## Task 2: native chapter transfer

Files: Norea src-tauri/src/content_sync.rs, IPC registration, Android storage bridge
as needed, src/lib/content-sync/native.ts. No UI or DB query edits in this task.

Interfaces exported by native.ts:

- `uploadContentChapter(input: {serverUrl:string;token:string;chapterId:number;manifest:Omit<PackageManifest,"files"|"bodyPath">;storageDir:string}): Promise<CatalogEntry>`.
- `downloadContentChapter(input: {serverUrl:string;token?:string;entry:CatalogEntry;storageDir:string;chapterId:number}): Promise<{contentBytes:number;mediaBytes:number}>`.

`fingerprintContentChapter({storageDir})` hashes local artifacts before upload.
Types are defined in native.ts for app orchestration to import. The adapter
must support Android SAF storage and Windows existing storage roots. Verify complete
media before export, preserve current files on failed import, and stage temporary
files in app cache. Network helpers are app-owned, never source-plugin traffic.

- [x] Add failing validation/round-trip tests, then implement streaming packaging,
  HTTP transfer, checksums and atomic install with local reference conversion.
- [x] Run focused native checks and supply the parent with the exact IPC contract.

## Task 3: app synchronization and settings

Files: Norea src/lib/content-sync/{client,sync}.ts, src/store/content-sync.ts,
src/components/ContentServerSettings.tsx, settings integration, locale keys.

- [x] Test remote catalog import, local row-ID remapping, unchanged readable paths,
  tombstone suppression, retry after failure, state conflicts and account isolation.
- [x] Add optional server URL/session settings, anonymous catalog browsing,
  explicit login merge choice, manual sync and per-chapter download actions.
- [x] Persist pending upload/state changes and per-device download exclusions.
  Trigger sync on configured lifecycle events without blocking local reading.
- [x] Synchronize library, read state, bookmark and position; preserve conflicts
  and offer explicit resolution without moving the active reader.
- [x] Run TypeScript checks, relevant tests and project verification skills.

## Task 4: integration and device evidence

- [x] Start a loopback-only local server with data in server `.tmp/local-server`.
- [x] Build targeted Android aarch64 APK, preserve installed data, connect the S25
  through `adb reverse`, and install/update the correct app channel.
- [x] Exercise login, real package upload/download, account state and offline reading.
  Use temporary owned fixture content only; do not delete the user's chapters.
- [x] Review the complete changes, resolve important findings, and record exact
  passing checks and any uncovered acceptance scenarios in a verification report.

## Review focus

- Torn ZIP uploads must remain unpublished (Task 1 integration test).
- Missing assets and malicious archive paths must fail before replacing files
  (Tasks 1 and 2 validation/rollback tests).
- Same plugin/path content with different local numeric IDs must restore properly
  (Tasks 2 and 3 round-trip tests).
- Account switches and retries must not leak or duplicate state (Tasks 1 and 3).
- Offline restart and server deletion must not remove local data or resurrect
  server content (Tasks 1, 3 and device smoke).
