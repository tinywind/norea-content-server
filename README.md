# Norea Content Server

An optional content server for Norea. One Node.js 24 process stores catalog and
device metadata in SQLite and complete chapter ZIPs on local disk. Reading state
stays on each device. The API capability version is 2; package format remains 1.

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
authentication for catalog and package access. External access requires a TLS
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
  entries return 404. Use its ID with the existing chapter package download route.
  Optional numeric `chapterNumber` matches a unique chapter within the exact
  same plugin ID and novel path. Exact identities take priority;
  an exact deletion is not replaced by a folder match. Multiple matches return
  409. The endpoint uses indexed chapter IDs and does not contact source sites.
  Catalog browsing follows the same anonymous-read and device-key policies as
  downloads. Queries read the current SQLite index without rescanning files.
  Import scans, API writes, and startup indexing populate that index. Use
  `GET /api/v1/works/:id` for full work metadata and
  `GET /api/v1/works/:id/cover` for the selected cover.
- `POST /api/v1/packages` streams an authenticated raw `application/zip` upload.
  Register the exact work with `PUT /api/v1/works/:id` first; missing work
  metadata returns 409. Every declared file is checked for size and SHA-256, and undeclared files,
  unsafe paths, duplicates, symlinks, encryption and invalid metadata are rejected.
  HTML resource URLs must be embedded data or declared package files. CSS imports
  and escaped CSS URLs are rejected; nested resource references inside separate
  CSS files and Markdown image syntax are not currently inspected.
  Revision identity is SHA-256 of the RFC 8785 canonical manifest. ZIP checksums
  are separate. Retrying a revision returns its original immutable package record.
- `GET /api/v1/chapters/:id/package` streams the current default. Downloads support
  one byte range, suffix ranges, ETag and If-Range. A mismatching If-Range returns
  the entire package. Verify ZIP bytes before installing content on the client.
- Registered devices and console administrators use `DELETE /api/v1/chapters/:id`
  and `POST /api/v1/chapters/:id/restore` to manage shared availability.
  Only console administrators use `POST /api/v1/chapters/:id/revision` to set defaults.
  A newer app upload does not automatically replace the first default revision.
  A changed source file found by a storage scan becomes the served default;
  previous immutable revisions remain available.
- `POST /api/v1/chapters/:id/purge` permanently removes a deleted chapter's ZIPs.
  Tombstones survive purge and restart. Restoration after purge permits a fresh
  upload but keeps the catalog entry deleted until a complete package is published.
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

Packages use the Norea readable directory rules:
`contents/<plugin>/<work-name>-<work-id-prefix>/<chapter-number>-<chapter-name>/<revision>.zip`.
An identity that collides with another chapter's sanitized directory is rejected.
Each ZIP contains portable body/assets and its manifest. ZIPs stream through a
staging directory and are validated before becoming visible in SQLite.
Interrupted uploads remain absent from the catalog. A deletion during an upload
invalidates its publication even if the chapter is restored before upload finishes.

Default limits are 512 MiB ZIP bytes, 2 GiB expanded bytes, and 10,000 content
files plus `manifest.json`. Manifests are limited to 4 MiB. Tests can supply
smaller limits through `buildApp`. JSON requests are limited to 1 MiB.

Deleting a chapter moves its revisions to `trash/` and immediately blocks new
downloads. Files older than 30 days are purged at server startup. Explicit purge
can remove them earlier. Existing device content and local reading state remain intact.
Available revisions are never automatically evicted.

For backup, stop the server and copy the entire data directory, including SQLite,
its WAL files, packages, and trash. Restore the complete directory before restart.
This offline procedure gives a consistent database/files snapshot. Live backup,
whole-work administration, work cover transfer, obsolete-revision removal,
automatic scheduled trash cleanup, storage quotas, and historical operator metrics are
not implemented. Protect public deployments with proxy-level rate limits and TLS.

## Docker

`docker compose up --build -d` exposes the service at `127.0.0.1:8787` and keeps
data in the `norea-data` volume. Read `/data/admin-password.hash` privately after
first startup to sign in. Back up the volume while the service is stopped.

## Checks

```text
pnpm test
pnpm typecheck
```

Tests use real SQLite databases and ZIP archives under `.tmp/`. They cover access
control, installation-secret persistence, device registration/blocking, immutable
revisions, Range, corrupt packages, limits, tombstones, catalog long polling,
shutdown/disconnect cleanup, and a disconnected HTTP upload.

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

`GET /api/v1/admin/storage` returns the fixed path and current scan settings.
`PATCH /api/v1/admin/storage` accepts only `mode`, `intervalMinutes`, and `enabled`.
`POST /api/v1/admin/storage/scan` starts a manual scan. Folder-root CRUD routes
have been removed.

In Content, inspect revisions, select the default, move server chapters to trash,
restore them, or permanently purge their server packages. These actions never
modify original loose chapters or imported archives. Deletion moves only indexed
server revision ZIPs to trash. Rescanning does not resurrect server tombstones.
Devices can be blocked or unblocked independently. Personal reading records stay
on each app and are never synchronized to the server.

Settings persists the anonymous-download policy. Its saved value takes precedence
over `NOREA_ANONYMOUS_READ` after the first console edit. Package limits and the
server data directory are read-only diagnostics. The existing offline backup
procedure still applies; the console does not provide live backup.

Administration REST routes are under `/api/v1/admin/` and require an administrator
bearer token, including filesystem paths and scan results. OpenAPI includes the
management routes. The Docker image builds and serves the same console assets.
Mount the single data directory writable: SQLite, staging, trash, and generated
packages share that directory. Existing source files remain unchanged by scans.
