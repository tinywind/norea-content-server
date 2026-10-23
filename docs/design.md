# Norea Content Server design

Date: 2026-10-11

Status: approved design direction. This document records the accepted product,
storage, synchronization, and deployment decisions. Detailed wire schemas belong
in the implementation plan. The service and Norea integration implement the
initial scope; [verification notes](verification-2026-10-11.md) distinguish the
implemented behavior from remaining work.

The account-free access update is verified separately in
[verification-2026-10-12.md](verification-2026-10-12.md).

Repository: <https://github.com/tinywind/norea-content-server>

## Purpose

Norea Content Server is an optional content storage and synchronization service
for the Norea reader. It preserves content already acquired by an app and makes
that content available to other devices. Reading state remains local to each app.

The motivating use cases are reading previously acquired content while its
original source is temporarily unavailable, and moving between a PC and a tablet
without manually transferring files. Each device retains its own reading position.

The server acts as a secondary copy. Norea remains usable without a server,
and while a configured server is unavailable. Content must
reach a device before it can be read there offline. The service cannot recover
content that no participating device has acquired and uploaded.

## Agreed direction

- Maintain the server in the separate public `tinywind/norea-content-server`
  repository. Add the corresponding synchronization client to Norea separately.
- Keep local reading independent of server availability.
- Upload locally acquired content and download content held by the server.
- Share content within a server. Keep reading position, read status, bookmarks,
  and library membership on each device; there are no accounts.
- Separate catalog synchronization from downloading every content file. A device
  can discover server content without storing all of it locally.
- Distinguish local removal from server deletion.
- Inspect media completeness from declared assets and regular ZIP entries.
  Retain valid incomplete copies in the catalog without advertising them for download.
- Use cross-device content identities instead of local database row IDs.
- Share the app's plugin ID, source novel ID, and chapter number directories.
  Accept the existing plugin ID collision limitation across distribution sources.

A public source repository does not determine the deployed server's network
exposure. Anonymous catalog access and downloads are enabled by default; operators
can disable anonymous reading to require authentication.

## Boundaries

The server owns the shared catalog, chapter files and their completeness, registered
devices, and catalog changes. Implement it in TypeScript with Fastify,
SQLite for metadata, and a filesystem package store. The initial deployment is a
single server instance distributed as a Linux Docker image with a persistent data
volume. This server target does not change Norea's supported app platforms.

The Norea app owns source access, local imports, local storage, reading, and the
sync client. Source plugins continue to acquire content through Norea's existing
plugin fetch and browser-session path. The server does not execute source plugins,
scrape sites, or receive source cookies and login sessions.

Server transfers use a separate app-owned connection. They must not require the
original source to be reachable or its plugin to be installed just to restore a
completed, supported package. Fetching new content from that source still uses
the existing plugin requirements.

The initial scope excludes a web reader, cross-server federation, automatic
matching of works from different sites, and synchronization of the entire app
database or all app settings. Independent backups remain necessary because
synchronization can propagate unwanted changes and the server can lose data.

## Console and device access

| Operation | Permission |
| --- | --- |
| Browse the catalog and download content | Anonymous by default; device or console credential when anonymous reading is disabled |
| Upload chapter files | Registered, unblocked device |
| Soft-delete or restore shared content | Registered device or console session |
| Purge chapters, delete whole work folders, or manage the server | Console session |
| Read or change personal reading state | Local app only |

First server initialization creates a random 256-bit secret in
`admin-password.hash` inside its data directory. The file value is the console
login credential, not a public password verifier. Create it exclusively with
restrictive permissions, reuse it on restart, and never log or expose it through
the API. A successful login issues a separate 24-hour console session.

Each app generates a random device key per server and persists it outside portable
backups. Keys are independent of hardware identifiers. Registration is automatic,
with no approval or username/password. The server stores only the key hash and
records the device name, registration time, last access, and blocked status.
Administrators can block or unblock a key. A blocked app retains its key and
reports the rejection; it must not silently generate another key.

Automatic admission is an explicit product decision: anyone who can reach the
server can register a new key. Blocking identifies a credential, not a person,
and does not prevent somebody from registering a different key. Device credentials
do not grant console access. Use HTTPS outside local device testing.

Removing server access does not prevent local reading. Source-site credentials
are never server credentials. Account sessions and personal-state tables are not
part of the current schema.

## Data ownership

| Data | Scope | Behavior |
| --- | --- | --- |
| Works, chapters, source identity, chapter files and completeness | Shared server catalog | Reused across devices |
| Library membership, reading position, read status, bookmarks | Device | Never synchronized to this server |
| Downloaded files, local paths, storage usage, download selection | Device | Independently managed |
| Device keys, pending transfers, local database IDs | Device | Excluded from shared packages and portable credential backups |

Local reading records survive connecting, disconnecting, changing servers, and
blocked access. Reader appearance settings remain local. The server publishes
content metadata and package availability without changing a device's reading
position or library selection. No first-login merge or conflict resolution is
needed because personal state is not exchanged.

## Content identity and revisions

Use separate identities for the logical work, logical chapter, and content
revision. Local numeric database IDs are only mappings within a device.

For source content, identify a work by its existing plugin ID and original work
path, and a chapter by that work identity and original chapter path when retained.
Current folder scanning identifies chapters by their folder numbers,
as specified under administration below. Do not add
repository UUIDs, distribution namespaces, or automatic cross-plugin merging.
Local numeric row IDs remain device-specific. Matching plugin IDs and paths from
different distributions can collide; this limitation is explicitly accepted for
the intended personal and small-server use.

Store original files under `contents/<pluginId>/<novelId>/<chapter-number>/`
on both the app and server. The source plugin supplies the literal novel ID.
Titles remain in metadata; changing a title does not rename a directory.
Chapter directories use canonical numeric notation, including fractional numbers,
or the chapter's positive position when no source number exists.
Reject unsafe IDs, ID changes for an existing work, and directory collisions.
Metadata digests identify API records and revisions without becoming folder names.
Only the current layout is supported; existing folders are never migrated.

For local imports, the original file's SHA-256 digest detects identical imported
files. A work and its extracted chapters also need identities that survive
reordering. Derive initial chapter identity from a stable entry in the imported
file where available, then preserve it. Independent imports with different file
bytes remain distinct. Automatic recognition of a revised local book is outside
the first version.

Keep one current copy per logical chapter. Uploads accept `conflictPolicy` values
`prefer-complete`, `keep-server`, and `replace-server`. The default prefers complete
copies and retains the server copy on ties. Keeping the server accepts any
available copy; replacement accepts the incoming copy regardless of completeness.
Missing or wrong-sized files allow a new upload to repair the stored copy.
Apply this decision atomically after validating the incoming files, and reject
a replacement if a deletion or newer publication occurred during the upload.
The revision field is a transfer/cache token, not a selectable version history.
The database stores one path per chapter. There is no historical-copy table or
upgrade path for previous storage formats.

A canonical metadata manifest identifies the initial revision. Original-file manifests list
each file's relative path, byte size, and source modification time as a nonnegative
safe integer Unix timestamp in milliseconds. Use RFC 8785 JSON canonicalization
and SHA-256 for this small manifest; do not hash original file payloads. Exclude
uploader identity and transfer timestamps. An actual replacement includes a
fresh publication identifier in the token so same-size edits with unchanged
modification times cannot reuse a stale download token. Scanning also records file identity and change
time to detect external edits without reading file payloads.

## Complete chapter transfers

The transfer unit is one chapter with its body and required assets.
This avoids repackaging a whole novel when a chapter is added or changed. Local
imports should use the same readable chapter boundary where possible; a PDF
represented as one chapter can remain one package.

New uploads send a `multipart/form-data` body with a versioned metadata manifest
first, followed by the original `content.html` or `content.pdf`, optional media
`manifest.json`, and optional `media.zip`. The metadata uses `layout: "chapter-files"`
and preserves work and chapter identities. Preserve all file bytes and local media
references without building an outer ZIP. Record `complete: true` only when every
declared asset exists as a regular entry in the media ZIP. Missing archives or
entries are valid incomplete copies; a body without a manifest is complete.
Ignore manifest completion flags, asset statuses, and cached byte counts. Safe
extra entries are allowed, but unsafe or malformed archives are rejected.
Byte limits use the archive's uncompressed sizes. This inventory check does not
extract assets or verify ZIP CRCs. Store work covers separately at work
scope and cache them locally when needed.

Only this original-file format is supported. No outer ZIP encoder, decoder,
media-path conversion, or older manifest reader is retained.

Initial configurable package limits are 512 MiB of ZIP data, 2 GiB of expanded
data, and 10,000 files. These are provisional operating defaults, not measured
capacity claims; validate them with representative content during implementation.
Reject an oversized package explicitly rather than truncating it or accepting a
partial chapter.

Publication follows this sequence:

1. Select the local chapter files to transfer.
2. Capture an immutable snapshot and its file sizes and modification times.
3. Enqueue a durable upload operation for the original files.
4. Upload to a server staging area that is absent from the public catalog.
5. Validate identity, package version, declared files, sizes, and media inventory.
6. Apply the conflict policy and publish the copy with its inspected completeness
   and catalog change atomically from readers' perspective.

Readers must never discover a package that has only partially uploaded. A repeated
upload of the same revision must be safe and must not create duplicate chapters.
Interrupted or rejected uploads stay unpublished and can be retried or cleaned up.
Restart an interrupted upload of one chapter. Legacy ZIP downloads
support resuming from an offset only after confirming that the stored partial
download belongs to the same immutable ZIP. If that cannot be confirmed, restart
the download. Retrying the same revision remains idempotent.

Downloading follows the same completion boundary: receive into temporary storage,
check sizes and inventory, install the body and assets, then mark the chapter locally
available. Original-file ETags contain the immutable revision and original path.
An interrupted replacement must leave the previous complete revision usable.
Package validation must reject path traversal and enforce archive size limits
before extraction. Receiving a package must not execute code from it.

## Local reading and synchronization

| Situation | Required behavior |
| --- | --- |
| Content exists locally | Open it immediately without checking the server |
| Local acquisition completes | Queue an upload without delaying reading |
| Content exists only on the server | Download and install it locally before offline use |
| Content exists neither locally nor on the server | Use the existing source acquisition path |
| Server is unavailable | Keep local reading working; retain pending sync work |
| Source is unavailable | Use complete copies already held locally or by the server |

A server lookup has a bounded wait so an unavailable server does not stall source
acquisition. Once a valid local copy exists, the reader must not stream its normal
content from the server or require the server to renew access to that copy.

The sync loop exchanges catalog changes independently from large packages. It uses persistent pending operations, idempotent writes,
and a server change cursor so reconnecting does not require transferring every
file. An empty response or connection failure is never interpreted as deletion.

Synchronize on explicit request, app startup, foreground return, and reconnection.
Do not promise continuous synchronization while a mobile app is suspended. Persist enough
state to recover after the app or device restarts, and make pending or failed
work visible without interrupting reading.

Catalog entries can be synchronized broadly, while package downloads follow
device choices: on demand, selected works, or an explicit full download. Removing
a local package must also update the device's selection or exclusion state so the
next sync does not immediately download it again.

Present local availability separately from server availability. Useful states
include available on this device, stored on the server, upload pending, and sync
failed. A cached server availability indicator must not imply a live guarantee.

## Deletion semantics

| Action | Effect |
| --- | --- |
| Remove download from this device | Remove this device's files; retain shared content and local reading state |
| Remove from my library | Change local membership; do not delete shared content |
| Delete server copy | Remove server availability; leave existing device copies intact |

The UI offers `Remove download from this device` when content is local,
and a distinct `Delete server copy` action when permitted. A second tap on an
unchanged button must not silently escalate local removal into shared deletion.
Server deletion should explain that other users will lose the ability to obtain
that server copy. Deleting every device's copy is outside the initial scope.

Registered devices and administrators can soft-delete chapters. Console sessions
can permanently delete whole work folders, including loose source chapters,
metadata and cover images. Work deletion removes its work/chapter index rows and
records chapter and work tombstones. Existing device copies and reading records
remain intact.

Server deletion creates a persistent deletion record. An upload started before
deletion cannot publish afterward. Background app sync respects server deletions.
A new chapter upload after deletion can replace the copy. Explicit local rescans
can republish deleted chapters and works; work metadata uses `PUT /works/:id?restore=true`.
The original work folder is not recovered by this operation; it uploads the
device's current files.

Deletion blocks new downloads immediately and retains the files in a trash area
for 30 days by default. An administrator can permanently delete the files earlier.
Retain the small deletion record indefinitely, including after the files are
purged, so a stale device cannot resurrect the content.

A replacement upload removes the prior trash copy. No chapter version history
or version-selection endpoint is retained. Storage exhaustion rejects uploads
without evicting current complete content. File cleanup must respect backups.

## Device-local reading state

Reading position, current chapter, completion status, bookmarks, and library
membership stay in the app's local database. Content synchronization neither
uploads nor downloads these records. Reading on a PC and tablet can therefore
progress independently, including rereading or moving backward.

Content changes retain their durable journal and catalog cursors. Reading-only
changes must not enqueue uploads or trigger content synchronization.

## Protocol and compatibility

Define the wire protocol independently of Norea's internal SQLite schema and
backup ZIP format. Reuse existing storage and media handling where appropriate,
but do not synchronize a live database or treat a full backup as the incremental
sync protocol.

Use a REST API under `/api/v1` with explicit request and response schemas and an
independently versioned package format starting with `packageVersion: 1`. The
account-free protocol reports `apiVersion: 1` and `authentication: "device-key"`
while retaining the existing `/api/v1` route prefix. Query
supported protocol versions, package versions, and capabilities when connecting.
Unsupported versions must produce a clear sync error while local reading
continues. Publish the supported app/server combinations before release.
During early development, support only the current schema and wire format.
Do not add upgrade migrations, old field defaults, or compatibility readers.
The app recreates a database with a different schema checksum. An incompatible
server database fails startup and requires a fresh state volume. Existing current
chapter folders can then be scanned again; old files are not converted.

Publish an OpenAPI document from the same route schemas used for request and
response validation. The selected stack is TypeScript, Fastify, REST/OpenAPI,
and SQLite. Do not introduce GraphQL, Java, or Spring Boot. File uploads and
downloads use ordinary streaming HTTP endpoints.

Content synchronization consumes an append-only catalog change log. Reconnecting
devices resume from a durable cursor. Each chapter change includes its inspected
`complete` flag; download availability requires `complete: true` and
`deleted: false`. The default conflict policy retains already complete copies.
Account and personal-state endpoints are removed.

Connected clients can wait up to 20 seconds for catalog cursor changes. A hint
contains only the catalog cursor and triggers ordinary paged feed
reads. Anonymous clients receive catalog hints under the same reading policy as
catalog requests. Stopping a request or shutting down the server releases the
waiter's resources. The database remains authoritative across reconnects and
server restarts.

The app offers manual, periodic, and on-change synchronization. Manual is the
default. Periodic mode runs when enabled, on foreground/network recovery, and
then at the configured interval after each run finishes; its default is 15
minutes, adjustable from 1 to 1,440 minutes. On-change mode uses those same
startup/recovery triggers, debounces local changes for 1.5 seconds, and waits
for server hints. The scheduler runs while the app is in the foreground; it does
not promise continuous Android background execution. The manual sync button
remains available in every mode.

Ordinary synchronization processes incremental changes. An explicit rescan
discovers file changes made outside the app. Reading progress never triggers
network synchronization. Selecting
manual mode cancels future automatic work and an outstanding hint request;
an already-started transfer can finish. These modes preserve manual content
download choices and do not download every catalog package. The first version
retains its change logs without automatic pruning.

The protocol needs operations for server capabilities, shared catalog changes,
complete package publication and retrieval, explicit deletion and republication,
and device registration/blocking. Define endpoint names and detailed
schemas during implementation planning using the decisions in this document.

## Deployment and operations

Run a single Fastify instance with persistent state and content storage.
In Docker, mount a named state volume at `/data` for SQLite, staging, trash, and
the installation secret. Bind only the host `Norea/contents` directory at
`/data/contents`. An existing host `admin-password.hash` can be mounted separately
at `/data/admin-password.hash`. The host content directory must not receive
SQLite databases, WAL files, or the server staging directory.

Publishing or moving revisions across these mounts must handle different
filesystems. Copy to a hidden temporary sibling at the destination, then rename
the complete revision before updating the catalog. Copy failure preserves the
source and removes the partial destination. Keep both mounts across container
replacement and back them up together while the server is stopped.

Stream large transfers between disk and network rather than buffering
entire packages in memory. Do not add Redis, a separate queue service, or an S3
dependency to the first version. Reconsider a client/server database such as
PostgreSQL if deployment later requires multiple server instances or substantial
concurrent writes.

A future storage quota can enforce a server-wide limit on new upload data.
An exhausted limit leaves existing content available and holds or rejects new
uploads with a clear reason. Specific quota values depend on the deployment;
they are separate from the package validation limits.

Back up a consistent SQLite snapshot together with every ZIP and work cover it
references. Use the SQLite backup API or an equivalent consistent snapshot
mechanism instead of copying a live database file directly. Coordinate package
publication and cleanup with the snapshot so referenced files remain available
until backup completion. Keep backups independently of the live data volume and
verify restoration before release.

Develop and test the server on the local Windows machine. Test the Norea Android
integration on the ADB-connected Samsung S25, using the aarch64 APK only. Keep test
data, logs, and generated artifacts under each project's `.tmp/` directory. Local
device tests may use an ADB reverse connection to a loopback-only HTTP server;
external deployments still require HTTPS.

## Initial delivery scope

The first usable version connects each app profile to one server using a durable
device key, transfers complete chapter packages, and discovers shared catalog
content. The console uses its installation secret and manages sources, folders,
packages, and devices. It includes explicit local removal, server deletion, and
recovery from interrupted transfers. Personal reading state remains device-local.

Verify automatic registration, separation of console/device permissions, complete
package transfer, and offline reading. Existing packages and local reading data
must remain usable when upgrading from the account-based prototype.

## Acceptance scenarios

1. A PC acquires a chapter and uploads it. With the PC and original source
   unavailable, a tablet obtains the package and reads it.
2. After that download, disconnecting the server and restarting the tablet still
   permits reading the local chapter and recording local progress.
3. A chapter with an unfinished asset download never appears as a complete server
   package. An interrupted upload is also invisible to catalog readers.
4. Retrying after interrupted upload or download produces one valid installation
   without duplicate logical chapters or loss of a previous complete revision.
5. Removing a tablet download preserves the PC and server copies and does not
   trigger an immediate automatic redownload.
6. Deleting a server copy prevents new downloads and rejects stale queued uploads,
   while previously downloaded copies remain readable.
7. Two devices can share packages while retaining independent reading progress.
8. Local rereading, bookmarks, and completion changes make no personal-state
   requests and do not enqueue content uploads.
9. The same content restores correctly with different device database IDs and
   paths, including when the original source plugin is unavailable.
10. Server downtime, storage exhaustion, authentication failure, corrupt packages,
    and unsupported versions leave local reading usable and report sync status.
11. Anonymous readers can browse and download by default but cannot upload,
    access console administration, or delete shared content without registering.
    Disabling anonymous reading
    requires authentication for catalog access and downloads.
12. An interrupted download resumes only against the same ZIP. An interrupted
    upload restarts safely. Package limits reject excess data without publishing
    incomplete content.
13. The default upload policy preserves a complete server chapter. Explicit
    replacement leaves one current copy, records its completeness, and preserves
    device files.
14. Server deletion enters the 30-day trash period. Permanent file removal retains
    deletion records, and explicit device or administrator restoration permits republication.
15. First connection registers a device without username/password. Restarting
    reuses its key, and connecting to another server uses a separate key.
16. A blocked key fails registration and mutation retries without silently
    changing identity. Console login remains independent of device credentials.
17. A restored backup contains every package and cover referenced by its database
    snapshot, including when publication or cleanup was active during backup.

These are acceptance targets. Executed checks and remaining limitations are
recorded in the verification documents.

## Implementation planning details

The product decisions above are accepted. The implementation plan still needs
concrete contracts and operational configuration:

- Request and response schemas, existing plugin/path identity encoding, local
  chapter mappings, and the canonical manifest field set.
- Console session expiry, installation-secret creation, automatic device
  registration, blocking, and local credential storage in the app.
- Restart-safe transfers, idempotent publication, and catalog cursors.
- Cover transfer, archive validation, partial-download identity
  checks, and recovery across filesystem/database publication boundaries.
- Deployment-specific quota values, backup schedule and destination, and the
  initial tested client/server compatibility matrix.

These details refine the accepted behavior; they do not reopen the selected access
model, stack, package unit, deletion scope, or first-release feature set.

## Current Norea integration references

Static source inspection identified the following integration boundaries. See
[verification notes](verification-2026-10-11.md) for the implemented and tested scope.

| Norea path | Relevant responsibility |
| --- | --- |
| `src/db/schema.ts` | Device-local work and chapter IDs and reading metadata |
| `src/lib/reader-chapter.ts` | Reading locally stored chapter content |
| `src/lib/chapter-content-storage.ts` | Body storage and metadata reconciliation |
| `src/lib/chapter-media/types.ts` | Media manifests and completion state |
| `src/lib/local-import.ts` | Content-hash-based local import identification |
| `src/lib/tasks/chapter-download.ts` | Existing source download pipeline |
| `src/db/queries/chapter.ts` | Reading progress persistence |
| `docs/release-compatibility.md` | App data and release-line compatibility |

Related background: [Local-first software](https://www.inkandswitch.com/essay/local-first/).

Technical references:

- [JSON canonicalization: RFC 8785](https://www.rfc-editor.org/info/rfc8785/)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Fastify streaming responses](https://github.com/fastify/fastify/blob/main/docs/Reference/Reply.md)
- [SQLite deployment guidance](https://sqlite.org/whentouse.html)
- [SQLite backup API](https://www.sqlite.org/backup.html)

## Administration console and existing-folder ingestion

The server serves an administrator-only operational console at `/admin/`.
The console uses the existing REST API, tab session-storage bearer sessions, and locally
built TypeScript/CSS assets. It has no separate frontend service or runtime.
Reloads retain the session until expiry or logout and restore the current
`/admin/<view>` route. Browser Back/Forward follows view navigation.
Its primary workflows are plugin repositories, storage scanning, content and
chapter management, scan results, registered devices, and access policy.

Multiple plugin repositories can be registered using a repository JSON URL or
an absolute server-local JSON path. The supported manifest is the current Norea
0.2 PluginItem array. Repository metadata supplies source IDs; the server never
executes plugin JavaScript or visits source sites during indexing. Updates are
explicit and atomic. Duplicate source IDs across registrations are rejected.
HTTP(S) repository URLs may contain a username and password or token. The server
uses these as HTTP Basic authentication when fetching the index. Embedded
credentials remain in stored repository and plugin URLs and are visible to
authenticated console administrators.
Repository inventory is independent of folder scanning. Existing source IDs,
including multi-source instances, come from local content metadata or package
manifests. Their literal plugin and novel IDs determine work directories.

The sole content root is `<NOREA_DATA_DIR>/contents`, selected at server startup.
The console displays it but cannot add, select, edit, or detach content roots.
Every source directory is eligible regardless of plugin registration, installation,
or enabled status. The scan never queries plugin code, a repository, or an original
site to verify a work's existence. Local imports follow the same completeness and
identity rules. Storage has manual, periodic, or change-driven scanning;
periodic reconciliation also covers missed filesystem events. A scan reports each registered, unchanged,
skipped, or failed candidate. Unsupported old formats are skipped. Valid
incomplete chapters are indexed without converting or repairing their files.
Every work requires valid original identity and title metadata in its
source-folder `novel.json`.

The walker excludes work-level cover images and `.nomedia` markers
from chapter counts and skip reports. Cover synchronization is not part of the
chapter package. Text-only bodies do not require a media manifest or archive.
The app's `manifest.json` is a media inventory, not chapter identity metadata.
It may exist without `media.zip`. The importer records completeness from regular
ZIP entries, ignoring completion and asset status flags. Incomplete copies remain
visible in administration but are excluded from download availability.

Work identity and title come exclusively from `novel.json`. Missing or invalid
metadata skips the whole work; folder names, cover sidecars, and old databases
cannot establish a work identity. No plugin or source-site requests are made.

The work directory must match `identity.pluginId` and `identity.novelId`.
Discover chapters from numeric-only folders such as `1` or `1.5`.
Chapter titles come from the work's chapter map, falling back to the number.
Already indexed directories retain their original chapter identity.
New folders use `norea-folder:<number>` within that exact work.
Synthetic work identities, noncanonical numbers, conflicting bodies,
malformed media, and changing files are skipped.

Metadata-only works and covers can be registered independently. A removed source
work or plugin does not prevent importing a complete local copy with valid work
metadata. Explicit server deletions remain authoritative. Files that change
during validation are skipped and retried on a later scan.

The scanner indexes work metadata and covers in place and leaves their original
files unchanged. Chapter directories are registered in place after the same
current-file validation used for uploads. There are no snapshots or generated
packages. Symbolic paths are rejected. Explicit server deletion moves the indexed
chapter directory to trash, while whole-work deletion removes the work directory.

Normal and periodic scans enumerate source and work directories, reuse known
complete chapter rows without visiting those chapter directories, and validate
new folders. This also reuses chapters validated during uploads before any scan.
SQLite checkpoints retain successful stat inventories and stable unsupported
layout results across restarts. Incomplete copies and transient failures retry;
cached unsupported layouts wait for a change event or full inspection.
Full inspection rereads media inventories even when cached stat signatures match. Work
metadata and cover stats are checked independently on each selected work.

Changes mode debounces affected paths and inspects only related chapters or
works. Events arriving during a scan remain pending. Periodic discovery finds
added or removed folders even when a filesystem event is lost. Docker host
mounts may not deliver all events, so the console also exposes Full inspection
(`POST /api/v1/admin/storage/scan` with `{"full":true}`) for in-place edits and
repaired unsupported folders. It checks stat inventories before validating
changed payloads. No scanning mode hashes or repacks payloads. Directory
enumeration still scales with folder count, and stat checks cannot detect edits
that preserve every recorded field.

Missing chapter or work folders update the index after successful enumeration;
enumeration errors do not remove cached availability. Missing folders and
validation failures do not create explicit deletion tombstones, allowing a
later successful scan or upload to restore availability. Reused results update
job totals without adding individual result rows; new results and errors retain
their paths and reasons.
Explicit deletion tombstones remain authoritative during server folder scans.

Console data includes per-source metadata/version, the single storage scan configuration,
content identities and revisions, package sizes, persistent job status and
per-candidate reasons. Device administration shows registration and access metadata;
personal reading history remains local. Chapter deletion, restoration, purge,
and permanent whole-work deletion are explicit console actions. Each chapter row
has Delete beside Inspect; work cards have Delete beside Metadata, and chapter
pages have Delete work beside the title.
Private filesystem paths and job results require administrator authentication.

## Filesystem Metadata v1

Each work directory stores this metadata-only document:

```json
{
  "schemaVersion": 1,
  "identity": { "pluginId": "example", "novelId": "123456", "novelPath": "/novel/123456" },
  "novel": {
    "name": "Example work",
    "author": null,
    "artist": null,
    "summary": null,
    "status": "Ongoing",
    "rating": 4.5,
    "genres": null,
    "isLocal": false
  },
  "cover": {
    "fileName": "cover.jpg",
    "contentType": "image/jpeg"
  },
  "chapters": {
    "1": "Opening",
    "2": "The next chapter"
  }
}
```

Readers require `identity.pluginId`, `identity.novelId`, `identity.novelPath`,
and `novel.name`. Plugin IDs use lowercase kebab-case. Storage IDs are
well-formed Unicode with at most 240 UTF-8 bytes. They cannot contain separators,
Windows filename punctuation, C0 controls, reserved device names, leading dot or
space, trailing dot or space, or unfinished suffixes (`.tmp`, `.bak`, `.part`,
`.partial`, `.norea-sync-backup`). IDs are rejected without sanitization.
An absent `schemaVersion` means 1. Missing text, rating, and cover fields default
to null; `isLocal` defaults to false. Unknown fields are ignored and omitted when
writing or transferring metadata. Present supported fields must have valid types.
Rating is finite and between 0 and 5. The entire cover descriptor may be null. Status preserves
the source text. `identity.novelPath` excludes the source base URL and retains
identity query parameters, such as `/webtoon/list?titleId=123`. Absolute HTTP(S),
protocol-relative, and synthetic `norea-folder:` work paths are rejected.

`chapters` stores canonical numeric source chapter keys and their exact titles.
Fractional keys are preserved. The map defaults to empty when absent; malformed
maps are rejected. Source metadata fetches populate the full catalog and merge
incremental results. Work uploads preserve previously known catalog entries.
Downloads, chapter deletion, and reading activity do not edit the catalog.
No update timestamp, source pagination, reading state, or sync bookkeeping is
stored in the work document. Restoring these files rebuilds the app catalog;
completed local bodies determine downloaded flags. The lightweight chapter catalog includes
number, page, and content type without package file inventories. Number fallback
lookup is limited to a unique chapter in the exact canonical work.

Files are authoritative. The server indexes valid owned work files at startup
and removes obsolete inferred entries from its metadata and chapter indexes.
Their files remain on disk. Source imports require valid `novel.json` and never
rewrite original content files. The scanner discovers local `cover.*` image
files even without a cover descriptor. An existing declared image takes priority;
otherwise filename order selects a cover. The console serves these files through
the authenticated local cover endpoint. Neither source cover URLs nor `cover.json`
are generated, transferred, or managed by the server.
Identical metadata preserves the file timestamp; sync sequence numbers stay in
the server database. Upload clients register work metadata before chapter packages.

`GET /api/v1/works?after=0&limit=100` provides incremental work changes.
`GET` and device-authenticated `PUT /api/v1/works/:id` transfer metadata;
`GET` and `PUT /api/v1/works/:id/cover` transfer image bytes separately, up to 10 MiB.
The work ID hashes the exact plugin ID and novel path. Metadata and cover changes
advance the work cursor. Clients retain file fingerprints to preserve pending local
edits and avoid unchanged uploads. Chapters transfer only their original files.

`GET /api/v1/admin/works/:id/chapters?search=&offset=0&limit=50` lists the
saved catalog with available server copies attached as `entry`. Missing and
deleted bodies have a null entry. Each available entry contains only `id` and
`fileBytes`; Inspect loads its full details on demand. Available packages absent from the saved map
remain visible. The download catalog continues to return only available files,
using the saved map for chapter titles. Scans also use these titles without
renaming chapter folders or rewriting their contents.

The console offers work-cover grids and lists, search, chapter counts, a metadata
dialog, and chapter deletion and restoration actions. Cover requests carry console authentication
in headers rather than URLs.
Work summaries show catalog and available-file counts separately and omit the
chapter map. The Metadata action fetches the complete work document on demand.
