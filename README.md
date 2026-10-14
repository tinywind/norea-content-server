# Norea Content Server

An optional content server for Norea. One Node.js 24 process stores catalog and
device metadata in SQLite and original chapter files on local disk. Existing ZIP
packages remain readable. Reading state stays on each device. The API and
package versions remain 1.

The server is an optional shadow backup. App navigation, reading, local downloads,
and metadata updates must finish without waiting for server discovery or uploads.
Clients may copy completed downloads in the background and retry a failed transfer
later. An unavailable server must not prevent local use.

## Run locally

Install Node.js 24 and pnpm, then run `pnpm install --frozen-lockfile`.
The server uses Node's native TypeScript support. Run `pnpm build` to compile the
administration console before starting the server.

PowerShell:

```powershell
$env:NOREA_DATA_DIR = '.tmp/local-server'
$env:NOREA_PORT = '8080'
pnpm start
```

The default address is `127.0.0.1:8787`. `NOREA_HOST` and `NOREA_PORT` override it.
`NOREA_DATA_DIR` defaults to `data`. Set `NOREA_ANONYMOUS_READ=false` to require
authentication for catalog and content access. External access requires a TLS
reverse proxy. Run exactly one server process against a data directory.

First startup creates `admin-password.hash` inside `NOREA_DATA_DIR`. Enter that
file's value in the console login. The value is a secret credential despite its
filename; do not publish it. Restarts reuse the file. There are no user accounts.

Each app generates a random key per server and registers automatically. The server
stores a hash of that key and can block it through the console. Automatic admission
means anyone who can reach the server can register another key; blocking a key
does not identify or permanently ban a person. Device keys never grant console
access. Keep the server data directory and device credentials private.

## API

`GET /api/v1/openapi.json` serves OpenAPI generated from route schemas.
`GET /api/v1/capabilities` reports supported protocol/package versions and access
policy. See [implementation-plan.md](docs/implementation-plan.md) for the shared
client contract and [design.md](docs/design.md) for the intended product behavior.

- `POST /api/v1/console-sessions` accepts `{password}` and returns `{token}`.
  Console sessions expire after 24 hours. `DELETE /api/v1/console-sessions/current`
  signs out. Send the token as `Authorization: Bearer <token>`.
- `POST /api/v1/devices/register` accepts `{deviceKey,deviceName}` and returns
  `{id,deviceName}`. Registration is idempotent; blocked keys are rejected.
  Device requests use `Authorization: Bearer <deviceKey>` without an account login.
- `GET /api/v1/admin/devices` lists devices. Console administrators can set
  `{blocked:true}` or `{blocked:false}` with `PATCH /api/v1/admin/devices/:id`.
- `GET /api/v1/chapters?after=0&limit=100` returns ordered catalog changes.
  Apply every entry in order, including repeated chapter IDs and tombstones, and
  save the returned cursor. Follow `hasMore` before considering the catalog current.
- `GET /api/v1/catalog/changes?after=0&limit=100` returns lightweight availability
  changes as `{items,cursor,hasMore}`. Each item contains only
  `{identity:{pluginId,novelPath,chapterPath},deleted,sequence}`. Apply repeated
  identities in sequence order, including deletions and restorations. The cursor
  is the last returned sequence, or `after` when the page is empty. Limits range
  from 1 to 100. Package file inventories are excluded; use the exact chapter
  lookup when a download needs the full manifest. The existing `/chapters` change
  endpoint retains its full-entry response for older clients.
- `GET /api/v1/catalog/works?q=title&source=plugin-id&offset=0&limit=40` browses current work
  summaries without downloading change history. Omit `source` to include all sources;
  otherwise it matches an exact plugin ID. `q` matches a literal title substring,
  ignoring ASCII letter case. Results contain `{items,total,hasMore}`, ordered by
  title and ID. Each item has `id`, `sequence`, `identity`, `novel`, `hasCover`, and
  `chapterCount`, the number of available nondeleted chapter packages. Summaries
  exclude chapter metadata and package file lists. Metadata-only works remain visible.
- `GET /api/v1/catalog/sources` returns `{items:[{id,workCount}]}` for sources
  represented by current work metadata, ordered by source ID.
- `GET /api/v1/catalog/works/:id/chapters?offset=0&limit=100` returns
  `{items,total,hasMore}` with current nondeleted chapter summaries containing
  `{id,chapterPath,position,name,chapterNumber,page,contentType}`, ordered by chapter position and ID. Package
  file manifests are excluded. Unknown works return 404; known works without packages return
  an empty page. Both paginated endpoints accept limits from 1 to 100. Concurrent
  writes can shift offset pages; these pages are for browsing, not change tracking.
- `GET /api/v1/catalog/chapter?pluginId=...&novelPath=...&chapterPath=...` resolves
  one available chapter by its exact, URL-encoded identity. Missing or deleted
  entries return 404. Use its ID and revision with the chapter-file download route
  when `manifest.layout` is `chapter-files`; older entries use the ZIP route.
  Optional numeric `chapterNumber` matches a unique chapter within the exact
  same plugin ID and novel path. Exact identities take priority;
  an exact deletion is not replaced by a folder match. Multiple matches return
  409. The endpoint uses indexed chapter IDs and does not contact source sites.
  Catalog browsing follows the same anonymous-read and device-key policies as
  downloads. Queries read the current SQLite index without rescanning files.
  Import scans, API writes, and startup indexing populate that index. Use
  `GET /api/v1/works/:id` for full work metadata and
  `GET /api/v1/works/:id/cover` for the selected cover.
- `POST /api/v1/chapter-files` accepts an authenticated `multipart/form-data`
  upload of the original files in a completed app chapter directory. Register the
  exact work with `PUT /api/v1/works/:id` first; missing work metadata returns 409.
  The first part is a plain text field named `metadata`, containing the version-1
  package manifest with `layout: "chapter-files"`. Its sorted `files` list declares
  each original `path`, byte `size`, and `modifiedAt` as a nonnegative safe integer
  Unix timestamp in milliseconds. Send subsequent file parts with the
  original path as their field name and basename as their filename.
  Upload exactly one `content.html` or `content.pdf`, plus `manifest.json` and
  `media.zip` when present. `bodyPath` names that body file. PDF chapters use
  `content.pdf`; HTML, text, and Markdown chapters use `content.html`.
  The media manifest must report a complete download with all assets stored.
  `media.zip` requires `manifest.json`; a nonempty media inventory requires
  `media.zip`. Loose legacy `media/` files are rejected by this endpoint.
  Body bytes, media URLs, media-manifest formatting and timestamps, and media ZIP
  bytes are preserved. The server creates no outer ZIP and does not extract or
  recompress the media archive. Its central directory must match the media
  manifest's names and sizes, without extra, duplicate, symbolic, or encrypted
  entries. This inventory check does not decode assets or verify their ZIP CRCs.
  Every file must match its declared size before the revision becomes visible.
  Missing, duplicate, wrong-sized, oversized, and interrupted uploads are rejected
  and their staged files are removed. File payloads are not hashed. Revision
  identity is SHA-256 of the canonical metadata manifest, including each file's
  modification time. A retry returns the same immutable record. Payload changes
  that preserve sizes and modification times cannot be distinguished.
  Raw records include `fileBytes`, the sum of original file sizes; ZIP records
  retain `zipBytes` and `zipSha256`. Clients must allow those ZIP fields to be absent.
- `GET /api/v1/chapters/:id/files?revision=<revision>&path=<original-path>` streams
  one original file from that immutable revision. Its ETag is the quoted revision,
  a colon, and the original path;
  Content-Length is its declared size. The route uses the same read policy as the
  catalog and checks supplied device keys even when anonymous reading is enabled.
  Check each file's size and receive the complete chapter before installing it.
- `POST /api/v1/packages` retains the legacy authenticated `application/zip` upload.
  Register the exact work with `PUT /api/v1/works/:id` first; missing work
  metadata returns 409. Every declared file is checked for size, and undeclared files,
  unsafe paths, duplicates, symlinks, encryption and invalid metadata are rejected.
  HTML resource URLs must be embedded data or declared package files. CSS imports
  and escaped CSS URLs are rejected; nested resource references inside separate
  CSS files and Markdown image syntax are not currently inspected.
  Legacy file `sha256` fields remain in manifests for format compatibility;
  uploads do not compare them with file payloads. Revision identity is SHA-256
  of the RFC 8785 canonical manifest. The stored ZIP checksum remains available
  for legacy ETags. Retrying a revision returns its original immutable package record.
- `GET /api/v1/chapters/:id/package` streams a legacy ZIP default. Raw-file defaults
  return 406 and must use the original-file route. ZIP downloads support
  one byte range, suffix ranges, ETag and If-Range. A mismatching If-Range returns
  the entire package. Check the received size and package inventory before
  installing content on the client.
- Registered devices and console administrators use `DELETE /api/v1/chapters/:id`
  and `POST /api/v1/chapters/:id/restore` to manage shared availability.
  There is no revision selection endpoint. A complete copy is retained until
  deleted; a new upload after deletion replaces it.
- `POST /api/v1/chapters/:id/purge` permanently removes a deleted chapter's copy.
  Tombstones survive purge and restart. A new upload can republish the chapter.
- `DELETE /api/v1/admin/works/:id` permanently removes the selected work folder,
  chapters, cover and metadata. It requires a console session. Explicit device
  rescans can republish metadata using `PUT /api/v1/works/:id?restore=true`.
- `GET /api/v1/changes?catalogAfter=0&waitSeconds=20` returns `{catalogCursor}`.
  It waits up to 20 seconds for catalog changes. Disabling anonymous reading also
  protects this endpoint. Fetch catalog pages to consume a hint; persist only
  successfully applied page cursors. Authorization is checked again after waiting.
  A cursor ahead of the visible log returns HTTP 409 and requires cursor recovery.
  Include `workAfter` to wait for work metadata changes as well. Change polling,
  work change pages, and catalog lists use the SQLite index without rescanning
  the content tree. API writes and folder import scans update the index as they
  publish. Direct edits to server files are indexed at startup; opening one work
  refreshes only that work from its authoritative `novel.json` and cover.

Capabilities include `authentication: "device-key"` and `personalStateSync: false`.
Old account, session, and personal-state endpoints are removed. Existing legacy
database tables are retained without being used; existing content remains available.

## Storage and limits

Original files use the Norea readable directory rules:
`contents/<plugin>/<work-name>-<work-id-prefix>/<chapter-number>-<chapter-name>/<revision>.files/`.
Each revision directory contains the original body, media manifest, and media
archive that were uploaded. Older revisions keep their `<revision>.zip` paths.
An identity that collides with another chapter's sanitized directory is rejected.
Uploads stream through a staging directory and are validated before becoming
visible in SQLite. The catalog metadata stays in SQLite; the uploaded media
`manifest.json` is never replaced by catalog metadata.
Interrupted uploads remain absent from the catalog. A deletion during an upload
invalidates its publication even if the chapter is restored before upload finishes.

Raw transfers accept at most three files, 64 KiB of metadata JSON, 16 MiB for
`manifest.json`, 512 MiB for `media.zip`, and 2 GiB for the total original files.
The media inventory is limited to 10,000 assets, with a 2 GiB total for their
declared uncompressed sizes plus the original body and media manifest.
Legacy ZIP limits remain 512 MiB ZIP bytes, 2 GiB expanded bytes, and 10,000 content
files plus a package `manifest.json` of at most 4 MiB. Tests can supply smaller
limits through `buildApp`. Ordinary JSON requests are limited to 1 MiB.

Deleting a chapter moves its single copy to `trash/` and immediately blocks new
downloads. Files older than 30 days are purged at server startup. Explicit purge
can remove them earlier. Existing device content and local reading state remain intact.
Complete current copies are never automatically evicted.

For backup, stop the server and copy both the server state volume and the host
content directory, including SQLite, its WAL files, revision files, and trash.
Include a separately mounted password file. Restore all mounts before restart.
This offline procedure gives a consistent database/files snapshot. Live backup,
whole-work administration, work cover transfer, obsolete-revision removal,
automatic scheduled trash cleanup, storage quotas, and historical operator metrics are
not implemented. Protect public deployments with proxy-level rate limits and TLS.

## Docker

`docker compose up --build -d` exposes the service at `127.0.0.1:8787`.
The `norea-state` volume holds `/data`, including SQLite, staging, trash, and the
installation secret. Only `/data/contents` is bound to a host content directory;
it defaults to `./data/contents`. Set `NOREA_CONTENTS_PATH` to an existing
`Norea/contents` directory before starting Compose. On Linux, grant UID 1000 write
access to that host directory.

For an existing Windows library and the published image:

```powershell
docker run -d --name norea-content-server --restart unless-stopped `
  -p 8080:8787 `
  --mount type=volume,source=norea-content-server-state,target=/data `
  --mount "type=bind,source=C:\Users\tinywind\OneDrive\Documents\Norea\contents,target=/data/contents" `
  tinywind0/norea-content-server:latest
```

Read `/data/admin-password.hash` privately after first startup to sign in.
To retain an existing host password file, also mount that file at
`/data/admin-password.hash`; the host file must already exist. Bind only
`Norea/contents`, not the entire `Norea` directory, so database and staging writes
stay out of the host content folder and cloud-sync clients.

When replacing an older container, stop it first and copy `metadata.sqlite` and
any remaining `metadata.sqlite-wal` and `metadata.sqlite-shm` files into the state
volume. Preserve `trash/` and the installation secret there unless the secret is
mounted separately. Keep a stopped-server backup until the new container can
read the existing catalog. Preserve the content bind mount without moving or
rewriting its files. Back up state and content together while the server is stopped.

Content and state may reside on different filesystems. Publication and trash
moves copy into a temporary sibling of the destination, then rename the complete
file or directory. Failed copies remove that temporary destination and preserve
the source. These hidden temporary names are excluded from content scans.

## Checks

```text
pnpm test
pnpm typecheck
```

Tests use real SQLite databases, chapter files, and ZIP archives under `.tmp/`. They cover access
control, installation-secret persistence, device registration/blocking, immutable
revisions, Range, corrupt packages, limits, tombstones, catalog long polling,
shutdown/disconnect cleanup, byte-identical multipart transfers, and disconnected
HTTP uploads.

## Administration console

Run `pnpm build` after installation, then open `http://127.0.0.1:8787/admin/`
(or the configured port). Sign in with the value from `admin-password.hash`.
The console has Overview, Plugins, Storage, Content, Jobs, Devices,
and Settings views. The session token stays in tab session storage across reloads
until expiry or logout. Each view has its own `/admin/<view>` route; reloading
restores that view, and browser Back/Forward follows navigation history.

Register multiple current Norea `apiVersion: "0.2"` repository JSON indexes in
Plugins. Both HTTP(S) URLs and absolute server-local JSON paths are supported.
An index is the same PluginItem array consumed by Norea. Repository registrations
are available for source inventory and do not determine which folders are indexed.
JavaScript plugin modules are never executed.
Re-register a URL to refresh it; duplicate source IDs/namespaces are rejected.
Existing multi-source identities are retained from local content metadata.
Private repositories may use `https://username:token@host/path/plugins.json`.
The server sends embedded credentials as HTTP Basic authentication when fetching
the index. Repository and plugin URLs are stored as entered, including credentials,
and are visible in the authenticated management console.

The server scans only `<NOREA_DATA_DIR>/contents/`. Configure `NOREA_DATA_DIR`
at startup; the console cannot add, select, or detach roots. Storage displays
this path and controls its scan schedule. Legacy connected-root records are no
longer used. Scans traverse source directories regardless of plugin registration,
installation, or enabled status.
They never check the original site or whether it still publishes the work.
Each work folder must contain valid `novel.json` with its original plugin ID,
base-URL-relative work path, title, and metadata. Missing or invalid metadata
skips the whole work. The importer never recovers work identity from a folder
name, `cover.json`, an old app database, or source-site requests. Synthetic
`norea-folder:` work identities are rejected.

`novel.json` contains only `schemaVersion`, `identity`, `novel`, and `cover`.
It has no chapter list or update timestamp. Work metadata includes the original
status text and a nullable rating from 0 to 5. Cover files named by its descriptor
are indexed separately. Metadata-only works can be registered without chapters.
See [Filesystem Metadata v1](docs/design.md#filesystem-metadata-v1).

Chapter folders follow `<number>-<title>`. Additional hyphens belong to the title.
The scanner discovers actual `content.html` or `content.pdf` files and complete
chapter packages. Package manifests retain original chapter paths only when their
work identity matches `novel.json`. Raw folders use `norea-folder:<number>` as a
chapter identity within that exact work. Duplicate numbers, conflicting body
formats, unfinished files, and incomplete media are skipped with reasons in Jobs.

Text-only chapters need no media manifest or archive. A chapter's `manifest.json`
describes media assets and contains no source identities. Remote assets remain
incomplete even when the manifest says `complete`; all referenced media must be
stored locally. Work covers and `.nomedia` markers are not chapter candidates.

The scanner reads existing work metadata, covers, and chapter files in place.
It snapshots new or changed chapters into staging, verifies them, and publishes
immutable packages under `<work>/.packages/<chapter>/<revision>.zip`. Originals
are not rewritten. Server-created packages are excluded from source discovery
and change notifications. Symbolic source and package paths are rejected.
Abandoned importer snapshots are removed from staging at startup.

SQLite indexes valid server-owned work files and available chapter packages.
Startup excludes obsolete inferred work metadata and its chapter index entries,
while retaining those files on disk. Metadata and cover changes use the work
cursor independently of chapter packages. Unchanged metadata does not rewrite
`novel.json`. Source chapter disappearance does not delete a generated package; explicit server
deletions and tombstones remain authoritative.

Choose Manual, Periodic, or Changes scanning. Changes uses filesystem events
with a two-second debounce plus periodic reconciliation. Automatic scanning runs
while the server process is running, without an open console. Disabling the
schedule still allows Scan now. Jobs are serialized, persist progress/results,
can be cancelled, and are marked interrupted after an unclean restart.

Successful work and chapter checkpoints persist in SQLite. Rescans enumerate
folders and compare file identity, size, modification time, and change time.
Unchanged chapter bodies and media are not read, hashed, or repacked. New and
changed files are verified; failed or incomplete candidates retry on later scans.
Work metadata and cover changes update the work index without rebuilding unchanged
chapter packages. The scan still lists and stats the tree; it does not guarantee
constant-time discovery or detect byte edits that preserve every recorded stat field.

Registered `.files` revision directories are recognized as unchanged server
content. Scans do not reimport or repackage them. The existing loose-folder import
path still builds legacy ZIP revisions from source snapshots; it is separate from
the original-file upload route, and it leaves those source folders unchanged.

`GET /api/v1/admin/storage` returns the fixed path and current scan settings.
`PATCH /api/v1/admin/storage` accepts only `mode`, `intervalMinutes`, and `enabled`.
`POST /api/v1/admin/storage/scan` starts a manual scan. Folder-root CRUD routes
have been removed.

The server keeps one complete copy per chapter. An upload for a chapter that is
already complete returns the existing entry without storing another version.
The app checks the server before copying or sending local files. Missing or
wrong-sized server files can be repaired by a completed upload. On upgrade,
historical copies are removed while keeping the complete current copy, or the
most recent available copy if the current one is missing.

In Content, each chapter has **Delete** beside **Inspect**. Chapter deletion moves
its indexed server copy to trash; local device copies and original scan inputs
remain intact. A new upload after deletion replaces it and removes the trash
copy. Scanning alone does not restore deleted chapters. In the app, select
chapters and choose **Delete from server**, then use **Rescan local files and
sync** to upload replacements. Background sync respects deletion records.

Work cards have **Delete** beside **Metadata**. The chapter page also has
**Delete work** beside the work title. After confirmation, work deletion removes
the entire server work folder, including original loose chapters, metadata and
cover images, and removes its DB index. This action is permanent. Deletion
records prevent automatic reuploads; an explicit app rescan can republish the
work. Copies and reading state on devices remain intact.
Devices can be blocked or unblocked independently. Personal reading records stay
on each app and are never synchronized to the server.

Settings persists the anonymous-download policy. Its saved value takes precedence
over `NOREA_ANONYMOUS_READ` after the first console edit. Package limits and the
server data directory are read-only diagnostics. The existing offline backup
procedure still applies; the console does not provide live backup.

Administration REST routes are under `/api/v1/admin/` and require an administrator
bearer token, including filesystem paths and scan results. OpenAPI includes the
management routes. The Docker image builds and serves the same console assets.
Keep the state volume and content bind mount writable. SQLite, staging, and trash
stay in the state volume; chapter files and work metadata stay in the content
bind mount. Existing source files remain unchanged by scans.
