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
- Wait for the complete body and required assets before producing and uploading
  a ZIP package. Do not synchronize an acquisition that is still incomplete.
- Use cross-device content identities instead of local database row IDs.
- Preserve Norea's existing readable plugin/work/chapter folder structure.
  Accept the existing plugin ID collision limitation across distribution sources.

A public source repository does not determine the deployed server's network
exposure. Anonymous catalog access and downloads are enabled by default; operators
can disable anonymous reading to require authentication.

## Boundaries

The server owns the shared catalog, completed content packages, registered
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
| Upload complete content | Registered, unblocked device |
| Soft-delete or restore shared content | Registered device or console session |
| Purge content, select revisions, or manage the server | Console session |
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
are never server credentials. Old account sessions are invalid after this change;
existing legacy database tables remain inert to preserve previously stored data.

## Data ownership

| Data | Scope | Behavior |
| --- | --- | --- |
| Works, chapters, source identity, complete packages | Shared server catalog | Reused across devices |
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
path, and a chapter by that work identity and original chapter path. Do not add
repository UUIDs, distribution namespaces, or automatic cross-plugin merging.
Local numeric row IDs remain device-specific. Matching plugin IDs and paths from
different distributions can collide; this limitation is explicitly accepted for
the intended personal and small-server use.

Preserve the current readable storage layout: plugin ID, work name/path, then
chapter number/name. Users must remain able to find and open a work or chapter
directly in the filesystem. Do not replace these directories with hash-only names
or migrate existing folders for synchronization. Content hashes verify revisions
and transfers; they do not replace the readable directory hierarchy. Packages
carry original identity fields separately from sanitized filesystem paths.

For local imports, the original file's SHA-256 digest detects identical imported
files. A work and its extracted chapters also need identities that survive
reordering. Derive initial chapter identity from a stable entry in the imported
file where available, then preserve it. Independent imports with different file
bytes remain distinct. Automatic recognition of a revised local book is outside
the first version.

Represent a changed body or asset set as a new revision of the same chapter.
Reading state continues to refer to the logical chapter, with the content revision
recorded when necessary to interpret its position. Do not overwrite one complete
revision with a different upload solely because it arrived later. The first
complete revision becomes the default for new downloads. Further revisions are
retained, and only an administrator can select a different default. A default
change does not automatically replace content already downloaded to a device.

A canonical manifest of relative file names, sizes, and content hashes identifies
a revision. Use RFC 8785 JSON canonicalization and SHA-256 for the content
manifest. Exclude uploader identity, transfer timestamps, and other operational
metadata from the content digest. The ZIP itself has a separate checksum for
transfer verification: ZIP timestamps or entry ordering can change its bytes without
changing the underlying content. Specify the exact manifest fields and file-list
ordering in the versioned package schema before implementing interoperable clients.

## Complete ZIP packages

The transfer unit is one chapter with its body and required assets.
This avoids repackaging a whole novel when a chapter is added or changed. Local
imports should use the same readable chapter boundary where possible; a PDF
represented as one chapter can remain one package.

Each package carries a versioned `manifest.json`, sufficient work and chapter
metadata for restoration, the stored content type, the body, and its required assets.
Internal references use portable relative paths. Store work covers separately at
work scope and cache them locally when needed. Include every asset required to
read a chapter in that chapter's ZIP, even if another chapter uses the same asset.
Avoid cross-package asset dependencies in the first version.

Initial configurable package limits are 512 MiB of ZIP data, 2 GiB of expanded
data, and 10,000 files. These are provisional operating defaults, not measured
capacity claims; validate them with representative content during implementation.
Reject an oversized package explicitly rather than truncating it or accepting a
partial chapter.

Publication follows this sequence:

1. Finish local acquisition, including all required assets.
2. Capture an immutable snapshot and calculate its manifest and hashes.
3. Build the ZIP and enqueue a durable upload operation.
4. Upload to a server staging area that is absent from the public catalog.
5. Validate identity, package version, declared files, sizes, and hashes.
6. Publish the completed package and its catalog change atomically from readers'
   perspective.

Readers must never discover a package that has only partially uploaded. A repeated
upload of the same revision must be safe and must not create duplicate chapters.
Interrupted or rejected uploads stay unpublished and can be retried or cleaned up.
The first version restarts an interrupted upload of an individual ZIP. Downloads
support resuming from an offset only after confirming that the stored partial
download belongs to the same immutable ZIP. If that cannot be confirmed, restart
the download. Retrying the same revision remains idempotent.

Downloading follows the same completion boundary: receive into temporary storage,
verify, install the body and assets, then mark the chapter locally available.
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

Registered devices and administrators can soft-delete shared content. Support
deleting an individual chapter or a whole work. Existing device copies and personal reading records
remain intact. Download permission never implies shared deletion permission.

Server deletion creates a persistent deletion record. Old queued uploads and
devices returning after a long offline period must not resurrect the content.
Republication requires an explicit restoration by an authorized device or console, or permission to
re-upload against the current deletion state. Deletion must also invalidate any
pending publication for the affected item.

Deletion blocks new downloads immediately and retains the files in a trash area
for 30 days by default. An administrator can permanently delete the files earlier.
Retain the small deletion record indefinitely, including after the files are
purged, so a stale device cannot resurrect the content.

Do not automatically purge older revisions of otherwise available content in the
first version. Administrators can inspect storage usage and explicitly remove
obsolete revisions. Deleted revisions must remain protected against stale
re-uploads. Storage exhaustion rejects new uploads instead of silently evicting
existing content. File cleanup must respect an active backup snapshot.

## Device-local reading state

Reading position, current chapter, completion status, bookmarks, and library
membership stay in the app's local database. Content synchronization neither
uploads nor downloads these records. Reading on a PC and tablet can therefore
progress independently, including rereading or moving backward.

Existing local values and release-line database compatibility must be preserved.
Old pending personal-state caches and server legacy state are no longer consumed.
Content changes retain their durable journal and catalog cursors. Reading-only
changes must not enqueue uploads or trigger content synchronization.

## Protocol and compatibility

Define the wire protocol independently of Norea's internal SQLite schema and
backup ZIP format. Reuse existing storage and media handling where appropriate,
but do not synchronize a live database or treat a full backup as the incremental
sync protocol.

Use a REST API under `/api/v1` with explicit request and response schemas and an
independently versioned package format starting with `packageVersion: 1`. The
account-free protocol reports `apiVersion: 2` and `authentication: "device-key"`
while retaining the existing `/api/v1` route prefix. Query
supported protocol versions, package versions, and capabilities when connecting.
Unsupported versions must produce a clear sync error while local reading
continues. Publish the supported app/server combinations before release.
App-side data changes must also follow Norea's active release-line compatibility
policy.

Publish an OpenAPI document from the same route schemas used for request and
response validation. The selected stack is TypeScript, Fastify, REST/OpenAPI,
and SQLite. Do not introduce GraphQL, Java, or Spring Boot. File uploads and
downloads use ordinary streaming HTTP endpoints.

Content synchronization consumes an append-only catalog change log. Reconnecting
devices resume from a durable cursor. Complete immutable package publication is
idempotent. Account and personal-state endpoints are removed.

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

Run a single Fastify instance with SQLite metadata and ZIP files on persistent
storage. Stream large transfers between disk and network rather than buffering
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
13. An administrator can change a chapter's default revision without replacing
    device copies. Changed content uses an explicitly approximate position when
    its original locator cannot be restored.
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
The console uses the existing REST API, in-memory bearer sessions, and locally
built TypeScript/CSS assets. It has no separate frontend service or runtime.
Its primary workflows are plugin repositories, connected folders, content and
revision management, scan results, registered devices, and access policy.

Multiple plugin repositories can be registered using a repository JSON URL or
an absolute server-local JSON path. The supported manifest is the current Norea
0.2 PluginItem array. Repository metadata supplies source IDs; the server never
executes plugin JavaScript or visits source sites during indexing. Updates are
explicit and atomic. Duplicate source IDs across registrations are rejected.
Repository inventory is independent of folder scanning. Existing source IDs,
including multi-source instances, come from local content metadata or package
manifests. IDs and readable folder rules stay unchanged.

A connected folder points to an existing Norea root containing `contents/`.
Every source directory is eligible regardless of plugin registration, installation,
or enabled status. The scan never queries plugin code, a repository, or an original
site to verify a work's existence. Local imports follow the same completeness and
identity rules. Each connection has manual, periodic, or change-driven scanning;
periodic reconciliation also covers missed filesystem events. A scan reports each registered, unchanged,
skipped, or failed candidate. Unsupported old formats and incomplete assets are
skipped without conversion or repair. Missing metadata is a skip, not permission
to infer a new logical identity from a lossy folder name.

When a site removes a work, its complete local chapters can still be registered
from the saved metadata. Previously published server copies remain available
when a site, plugin, repository, or local original disappears. Explicit server
deletion and its tombstones remain authoritative; scanning does not undo them.

For existing folders, an optional Norea database path supplies exact source,
work, and chapter identities. The importer copies a stable database/WAL snapshot
to server staging before opening SQLite; it never opens the original database
with SQLite. Only content fields are used, never account reading state or source
credentials. Snapshot files are removed when the job ends. A chapter file that
changes during its first copy is retried once, accommodating OneDrive hydration.
Continued changes and unstable database snapshots are skipped until a later scan.
The importer accepts renamed work or chapter folders only when the existing
database identity maps uniquely to their retained path suffix or chapter prefix.
Media manifests use stable key ordering compatible with app package exports.

The original Norea folder and metadata files are read-only inputs: no manifests,
locks, repairs, renames, deletions, or database side effects are written there.
Symlink escapes and overlapping source/server storage are rejected. Complete
chapter snapshots become portable ZIPs under server-owned storage and pass the
same validation/publication path as app uploads. This uses additional disk space
but preserves an immutable server copy independently of the source folder.
Server deletions are not reversed by rescanning; loss of an original does not
remove an already published package. Detaching a folder only stops scanning.

Console data includes per-source metadata/version, folder scan configuration,
content identities and revisions, package sizes, persistent job status and
per-candidate reasons. Device administration shows registration and access metadata;
personal reading history remains local. Server deletion, restoration, default
revision selection, and permanent purge use the existing administrator actions.
Private filesystem paths and job results require administrator authentication.
