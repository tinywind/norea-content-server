# Norea Content Server

An optional content server for Norea. One Node.js 24 process stores catalog and
device metadata in SQLite and original chapter files on local disk.
Reading state stays usable on each device and can be explicitly exchanged with
the server using a private sync key. The API and package versions remain 1;
the optional reading-state protocol is advertised separately as version 1.

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

Requests are limited by the direct client IP: 6,000 requests per minute per route,
10 console login attempts per minute, and 60 device registrations per minute.
Excess requests return HTTP 429 with `Retry-After`. Forwarded IP headers are not
trusted; clients behind a reverse proxy share that proxy's limits.

Secret and work-file reads reject symbolic links and read through the validated
file descriptor. Keep storage directories writable only by trusted operators.

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
- `POST /api/v1/reading-state/read` accepts `{syncKey,offset?,limit?}` and returns
  `{entries,total,nextOffset}`. Default offset is 0; page size is 1–500, default 500.
- `POST /api/v1/reading-state/merge` accepts `{syncKey,entries}` (at most 200 entries)
  and returns `{received,updated,total}`. Both reading-state endpoints require a
  registered device bearer key, even when anonymous catalog reading is enabled.
  A separate private 64-character hexadecimal sync key identifies the person's
  records. Reuse that key on another device to transfer the same reading history;
  keep it private. See [reading-state.md](docs/reading-state.md) for entry identity,
  merge behavior, limits, and upgrade guarantees.
- `GET /api/v1/admin/devices` lists devices. Console administrators can set
  `{blocked:true}` or `{blocked:false}` with `PATCH /api/v1/admin/devices/:id`.
- `GET /api/v1/catalog/changes?after=0&limit=100` returns lightweight availability
  changes as `{items,cursor,hasMore}`. Each item contains only
  `{identity:{pluginId,novelId,novelPath,chapterPath},complete,deleted,sequence}`. Apply repeated
  identities in sequence order, including deletions and restorations. Only entries
  with `complete: true` and `deleted: false` are downloadable. The cursor
  is the last returned sequence, or `after` when the page is empty. Limits range
  from 1 to 100. Package file inventories are excluded; use the exact chapter
  lookup when a download needs the full manifest.
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
  one complete chapter by its exact, URL-encoded identity. Missing, incomplete,
  or deleted entries return 404. `includeUnavailable=true` exposes the saved
  record and its `complete` flag for nondeleted unavailable copies. Use its ID
  and revision with the chapter-file download route
  with `manifest.layout` set to `chapter-files`.
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
  upload of the original files in an app chapter directory. Register the
  exact work with `PUT /api/v1/works/:id` first; missing work metadata returns 409.
  The first part is a plain text field named `metadata`, containing the version-1
  package manifest with `layout: "chapter-files"`. Its sorted `files` list declares
  each original `path`, byte `size`, and `modifiedAt` as a nonnegative safe integer
  Unix timestamp in milliseconds. Send subsequent file parts with the
  original path as their field name and basename as their filename.
  Upload exactly one `content.html` or `content.pdf`, plus `manifest.json` and
  `media.zip` when present. `bodyPath` names that body file. PDF chapters use
  `content.pdf`; HTML, text, and Markdown chapters use `content.html`.
  The server sets `complete` by checking that every asset declared in
  `manifest.json` exists as a regular file in `media.zip`. It ignores the
  manifest's `complete`, per-asset `status`, and cached byte counts. Missing
  archives or assets are accepted with `complete: false`; body-only chapters
  are complete. Byte limits use the archive's uncompressed sizes.
  `media.zip` requires `manifest.json`. Loose `media/` files are unsupported.
  Body bytes, media URLs, media-manifest formatting and timestamps, and media ZIP
  bytes are preserved. The server creates no outer ZIP and does not extract or
  recompress the media archive. Safe extra ZIP entries are allowed; malformed
  archives, unsafe paths, duplicate names, symbolic entries, and encrypted entries
  are rejected. This inventory check does not decode assets or verify ZIP CRCs.
  Every file must match its declared size before the revision becomes visible.
  Missing declared parts, duplicates, wrong sizes, oversized files, and interrupted uploads are rejected
  and their staged files are removed. File payloads are not hashed. The initial
  revision hashes canonical metadata; replacements receive a fresh transfer token
  even when file sizes and modification times match.
  The optional query parameter `conflictPolicy` accepts `prefer-complete`
  (default), `keep-server`, or `replace-server`. `prefer-complete` replaces an
  incomplete copy only with a complete upload; ties retain the server copy.
  `keep-server` retains any available server copy. `replace-server` publishes the
  uploaded copy even when incomplete. All uploads are validated before this
  decision. A deletion during upload or a newer copy that would be overwritten
  returns 409; retry with a new request. Missing or wrong-sized server files can
  be repaired under any policy. Every catalog record includes the inspected
  `complete` flag and `fileBytes`, the sum of original file sizes.
- `GET /api/v1/chapters/:id/files?revision=<revision>&path=<original-path>` streams
  one original file from the current copy. A stale revision returns 404.
  Its ETag is the quoted revision,
  a colon, and the original path;
  Content-Length is its declared size. The route uses the same read policy as the
  catalog and checks supplied device keys even when anonymous reading is enabled.
  Check each file's size and receive the complete chapter before installing it.
- `GET /api/v1/chapters/:id/media?revision=<revision>&fileName=<name>&sourceUrl=<source>`
  returns one declared media asset for selective repair. URL-encode the exact
  filename and source URL from the device's media manifest. The server requires
  both to match its manifest, checks archive safety and the selected entry's size
  and CRC, and returns only that entry's bytes with Content-Length. A healthy asset
  can be retrieved from an incomplete chapter or an archive with another corrupt
  asset. Assets are limited to 256 MiB and the configured archive limits also apply.
  Stale revisions or missing assets return 404; unavailable or corrupt artifacts
  return 410. This route uses the catalog read policy and preserves every stored
  file. Clients merge the response into their existing media workspace without
  replacing the chapter body or valid local assets.
- Registered devices and console administrators use `DELETE /api/v1/chapters/:id`
  and `POST /api/v1/chapters/:id/restore` to manage shared availability.
  There is no revision selection endpoint. Upload conflict policy controls
  replacement; a new upload after deletion can also replace the copy.
- `POST /api/v1/chapters/:id/purge` permanently removes a deleted chapter's copy.
  Tombstones survive purge and restart. A new upload can republish the chapter.
- `DELETE /api/v1/admin/works/:id` permanently removes the selected work folder,
  chapters, cover and metadata. It requires a console session. Explicit device
  rescans can republish metadata using `PUT /api/v1/works/:id?restore=true`.
- `DELETE /api/v1/works/:id` provides the same whole-work deletion for registered,
  unblocked devices. The app exposes it in server browsing and the selected
  work's server data page. It preserves device copies and personal reading state;
  deletion records block automatic reuploads until an explicit restore.
- `GET /api/v1/changes?catalogAfter=0&workAfter=0&waitSeconds=20` returns
  `{catalogCursor,workCursor}`. Both cursors are required. It waits up to 20 seconds
  for catalog or work metadata changes. Disabling anonymous reading also
  protects this endpoint. Fetch catalog pages to consume a hint; persist only
  successfully applied page cursors. Authorization is checked again after waiting.
  A cursor ahead of the visible log returns HTTP 409 and requires cursor recovery.
  Change polling, work change pages, and catalog lists use the SQLite index without rescanning
  the content tree. API writes and folder import scans update the index as they
  publish. Direct edits to server files are indexed at startup; opening one work
  refreshes only that work from its authoritative `novel.json` and cover.

Capabilities include `authentication: "device-key"`, `personalStateSync: true`,
and `readingStateVersion: 1`. Account sessions and the legacy `/state` endpoints
are unsupported. The reading-state extension adds its table without changing the
current database checksum or replacing existing data. This development version
otherwise supports only the current database and original-file protocol. There
are no legacy format migrations, ZIP package endpoints, or format conversion paths.
An incompatible server database fails startup. Stop the server and use a fresh
state volume, retaining the `contents` mount and installation password, then scan
current chapter folders. Older formats remain untouched but are not registered.
Unrelated regular files in a chapter folder are ignored and preserved. An upload
can add current chapter files beside them, but cannot overwrite unindexed current
files. Scan those files first. Only the declared current files are served.

## Storage and limits

Original files use the same ID directories as the app:
`contents/<pluginId>/<novelId>/<chapter-number>/`.
The source plugin provides `novelId`; it is stored literally and is required in
both work and chapter metadata. Titles remain in metadata. Chapter numbers use
canonical decimal notation, including fractional numbers; a missing source number
uses the chapter's positive position.
Plugin IDs use lowercase kebab-case. Storage IDs are at most 240 UTF-8 bytes and
must be valid portable directory names: no separators, Windows reserved names,
control characters, leading dot or space, trailing dot or space, or unfinished
file suffixes. Invalid IDs are rejected rather than sanitized or hashed.
The chapter directory directly contains the original body, media manifest, and
media archive. SQLite stores one current path per chapter, without revision rows.
An identity that collides with another work or chapter directory is rejected.
Changing a registered work's source novel ID is also rejected. API work and chapter
IDs remain hashes of the original plugin and source paths; these hashes are never
directory names. Only the current directory format is indexed.
Uploads stream through a staging directory and are validated before becoming
visible in SQLite. The catalog metadata stays in SQLite; the uploaded media
`manifest.json` is never replaced by catalog metadata.
Interrupted uploads remain absent from the catalog. A deletion during an upload
invalidates its publication even if the chapter is restored before upload finishes.

Raw transfers accept at most three files, 64 KiB of metadata JSON, 16 MiB for
`manifest.json`, 512 MiB for `media.zip`, and 2 GiB for the total original files.
The media inventory is limited to 10,000 assets, with a 2 GiB total for their
declared uncompressed sizes plus the original body and media manifest.
Tests can supply smaller limits through `buildApp`. Ordinary JSON requests are
limited to 1 MiB.

Deleting a chapter moves its single copy to `trash/` and immediately blocks new
downloads. Files older than 30 days are purged at server startup. Explicit purge
can remove them earlier. Existing device content and local reading state remain intact.
Complete current copies are never automatically evicted.

For backup, stop the server and copy both the server state volume and the host
content directory. The state volume contains SQLite, its WAL files, staging,
and trash; the host content directory contains works and their current chapter files.
Include a separately mounted password file. Restore all mounts before restart.
This offline procedure gives a consistent database/files snapshot. Live backup,
automatic scheduled trash cleanup, storage quotas, and historical operator metrics
are not implemented. Protect public deployments with proxy-level rate limits and TLS.

## Docker

GitHub Actions validates branch changes and publishes the exact smoke-tested
image to Docker Hub as `latest` and the committed branch name (currently `0.2`).
See [deployment.md](docs/deployment.md) for CI configuration, the version-branch
contract, digest verification, tinywind-SER rollout, and rollback.

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

Reuse a state volume only with the exact current schema. For an incompatible
development build, create a fresh state volume and scan the current content
folders. Retain the previous volume separately until verification finishes.
Preserve the content bind mount and installation password without moving or
rewriting their files. Back up state and content together while the server is stopped.

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
control, installation-secret persistence, device registration/blocking, current
file publication, incomplete media, limits, tombstones, catalog long polling,
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
HTTP redirects may stay on the operator-selected origin, for at most five hops;
changes of origin or embedded credentials are rejected before another request.
Use the final index URL directly when a repository redirects to a different host.

The server scans only `<NOREA_DATA_DIR>/contents/`. Configure `NOREA_DATA_DIR`
at startup; the console cannot add, select, or detach roots. Storage displays
this path and controls its scan schedule. Scans traverse source directories regardless of plugin registration,
installation, or enabled status.
They never check the original site or whether it still publishes the work.
Each work folder must contain valid `novel.json` with its original plugin ID,
plugin-provided novel ID, base-URL-relative work path and title. The plugin and
novel IDs must match the enclosing directories. Other metadata is optional. Missing or invalid metadata
skips the whole work. The importer never recovers work identity from a folder
name, `cover.json`, an old app database, or source-site requests. Synthetic
`norea-folder:` work identities are rejected.

`novel.json` writers emit `schemaVersion`, `identity`, `novel`, `cover`, and `chapters`.
Readers require `identity.pluginId`, `identity.novelId`, `identity.novelPath`, and `novel.name`.
Unknown fields are ignored and omitted on write and transfer. An absent schema
version defaults to 1. `chapters` maps source chapter numbers to their exact titles
and defaults to an empty map when absent. Source metadata fetches update the map;
uploads preserve earlier catalog entries. The console lists the catalog with
server file availability, and chapter deletion retains its title in the catalog.
Apps can restore the full catalog from these files and identify downloaded chapters
by checking their completed local bodies. No update timestamp or source cover URL
is written or transferred. The server does not manage `cover.json`. Work metadata includes the original
status text and a nullable rating from 0 to 5. The scanner discovers actual work-local `cover.*` image files, including when
the optional cover descriptor is absent. The console serves these local files. Metadata-only works can be registered without chapters.
See [Filesystem Metadata v1](docs/design.md#filesystem-metadata-v1).

Chapter folders contain only a canonical chapter number, such as `1` or `1.5`.
The scanner discovers actual `content.html` or `content.pdf` files and restores
titles from the `novel.json` chapter map, falling back to the number.
Already indexed directories retain their exact chapter identity. New folders use
`norea-folder:<number>` as a chapter identity within that exact work.
Noncanonical numbers, conflicting body formats, unfinished files, and malformed
media are skipped with reasons in Jobs. Valid incomplete chapters stay indexed
with `complete: false`.

Text-only chapters need no media manifest or archive. A chapter's `manifest.json`
describes media assets and contains no source identities. Every declared asset
must exist as a regular ZIP entry for the chapter to be complete, regardless of
its stored or remote status. Work covers and `.nomedia` markers are not chapter
candidates.

The scanner reads existing work metadata, covers, and chapter files in place.
It validates new or changed chapters and registers their existing directories.
There is no copying, repacking, body rewriting, or payload hashing during scans.
Symbolic paths are rejected. Older ZIP packages and loose media are not converted.

SQLite indexes valid server-owned work files and available chapter packages.
Startup excludes obsolete inferred work metadata and its chapter index entries,
while retaining those files on disk. Metadata and cover changes use the work
cursor independently of chapter packages. Unchanged metadata does not rewrite
`novel.json`. A chapter that fails validation is unavailable until a later scan or
completed upload repairs it. Explicit server deletions remain authoritative.

Choose Manual, Periodic, or Changes scanning. Changes uses filesystem events
with a two-second debounce plus periodic reconciliation. Automatic scanning runs
while the server process is running, without an open console. Disabling the
schedule still allows Scan now. Jobs are serialized, persist progress/results,
can be cancelled, and are marked interrupted after an unclean restart.

**Scan now** and periodic scans list source and work directories to discover
added or removed chapter folders. Known complete chapters reuse the database
index without opening or statting their contents, including chapters uploaded by
the app. Work metadata and covers are checked separately on every scan.
SQLite also remembers unsupported chapter layouts, so they are not inspected
again on every pass. Incomplete copies and transient failures are retried.
Full inspection checks media inventories even when file signatures match.
The first pass still inspects every previously unclassified chapter folder.

Changes mode retains the affected paths and inspects those chapters or works.
Filesystem events can be missed, particularly on Docker host mounts. Periodic
scans still discover additions and removals; use **Full inspection** after editing
existing chapter files or repairing unsupported folders when no event was
received. Full inspection compares file identity, size, modification time, and
change time before revalidating changed payloads. No scan hashes or repacks
payloads. Stat checks cannot detect edits that preserve every recorded field.
Directory listings still scale with the number of folders; discovery is not
constant-time. Jobs aggregate unchanged and cached skipped counts rather than
persisting a detail row for each reused result.

Uploaded and scanned chapters share the same directory layout and validation.
Scans refresh changed file inventories and keep original chapter identities for
known directories when inspected. Missing folders become unavailable in the
index after successful enumeration. Observed folder removals record a deletion
cursor to reject uploads that started before the removal, while restoring valid
files still permits rediscovery. Validation failures do not create deletion
tombstones. Failed directory enumeration does not remove cached availability.

`GET /api/v1/admin/storage` returns the fixed path and current scan settings.
`PATCH /api/v1/admin/storage` accepts only `mode`, `intervalMinutes`, and `enabled`.
`POST /api/v1/admin/storage/scan` starts incremental discovery. Send
`{"full":true}` for a full inspection. Folder-root CRUD routes have been removed.

The server keeps one current copy per chapter and records its completeness.
The upload conflict policy determines whether an available copy is retained or
replaced. The default policy prefers complete content and keeps the server copy
when both copies have the same completeness. Missing or wrong-sized server files
can be repaired by a new upload.

An app chapter identified as `norea-folder:<number>` can recover a uniquely
matching chapter in the same source work, retaining the server's original
identity, ID, and directory. The selected conflict policy still applies. Ambiguous
chapter numbers are rejected, and a real source path never adopts another
identity solely because its chapter number matches.

In Content, each chapter has **Delete** beside **Inspect**. Chapter deletion moves
the indexed chapter directory to trash; local device copies remain intact.
A new upload after deletion replaces it and removes the trash copy. Scanning
alone does not restore deleted chapters. In the app, select chapters and choose
**Delete from server**, then use **Sync now** or wait for the configured sync mode
to upload replacements from completed local files. No local edit or explicit app
rescan is required. Other complete server chapters remain unchanged.

Deleting a chapter through the API or console publishes its deletion immediately.
When a chapter folder is removed directly from the filesystem, the server must
first observe that removal through Changes scanning, a periodic scan, or **Scan
now** before the app receives the deletion event. API and console deletions do
not need this extra scan.

Work cards have **Delete** beside **Metadata**. The chapter page also has
**Delete work** beside the work title. After confirmation, work deletion removes
the entire server work folder, including original loose chapters, metadata and
cover images, and removes its DB index. This action is permanent. Deletion
records prevent automatic reuploads; an explicit app rescan can republish the
work. Copies and reading state on devices remain intact.
The app offers **Delete work from server** in Browse -> Content server and in
each work's server data page, using the same whole-work deletion policy.
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
