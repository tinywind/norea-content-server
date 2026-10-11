# Norea Content Server design

Date: 2026-10-11

Status: approved design direction. This document records the accepted product,
storage, synchronization, and deployment decisions. Detailed wire schemas belong
in the implementation plan. The service has not been implemented.

Repository: <https://github.com/tinywind/norea-content-server>

## Purpose

Norea Content Server is an optional content storage and synchronization service
for the Norea reader. It preserves content already acquired by an app and makes
that content available to other devices. It also synchronizes personal reading
state between devices belonging to the same account.

The motivating use cases are reading previously acquired content while its
original source is temporarily unavailable, and moving between a PC and a tablet
without manually transferring files or finding the previous reading position.

The server acts as a secondary copy. Norea remains usable without a server,
without an account, and while a configured server is unavailable. Content must
reach a device before it can be read there offline. The service cannot recover
content that no participating device has acquired and uploaded.

## Agreed direction

- Maintain the server in the separate public `tinywind/norea-content-server`
  repository. Add the corresponding synchronization client to Norea separately.
- Keep local reading independent of server availability.
- Upload locally acquired content and download content held by the server.
- Share content within a server while keeping each account's reading state
  separate. Multiple devices using one account synchronize that account's state.
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

The server owns the shared catalog, completed content packages, account reading
state, and synchronization changes. Implement it in TypeScript with Fastify,
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

## Accounts and access

| Operation | Permission |
| --- | --- |
| Browse the catalog and download content | Anonymous by default; authenticated when anonymous reading is disabled |
| Upload content | Authenticated member |
| Read or change library membership, progress, read status, and bookmarks | The owning account |
| Delete shared content or change its default revision | Administrator |
| Provision accounts or reset passwords | Administrator |

Provision accounts through an administrator or an administrator-controlled
invitation. The first version excludes open registration, email delivery, and
social login. Password recovery uses an administrator reset.

Issue a separate authenticated session to each device so a lost device's session
can be revoked independently. Use HTTPS for external connections. Expired or
revoked sessions stop authenticated synchronization, not access to content already
stored on that device. Source-site credentials are never server credentials.

## Data ownership

| Data | Scope | Behavior |
| --- | --- | --- |
| Works, chapters, source identity, complete packages | Shared server catalog | Reused across accounts and devices |
| Library membership, current reading position, read status, bookmarks | Account | Synchronized between that account's devices |
| Downloaded files, local paths, storage usage, download selection | Device | Independently managed on each device |
| Pending transfers, credentials, local database IDs | Device | Never treated as shared content |

Library membership, reading position, read status, and bookmarks are all part of
the first version. Reader appearance settings, including fonts, margins, and
orientation, remain local, as do automatic download selections.

Content access must not expose another account's reading records. A shared content
package contains no account state, source credentials, or device-specific paths.
At first sign-in, offer an explicit choice between merging existing local reading
state and using server reading state. Do not upload existing local records before
that choice. Switching accounts must not merge the previous account's state into
the new account. These choices concern personal records, not deletion of local
content files.

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

The sync loop exchanges catalog changes and account state independently
from large packages. It uses persistent pending operations, idempotent writes,
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
| Remove download from this device | Remove this device's files; retain shared content and account reading state |
| Remove from my library | Change account membership; do not delete shared content |
| Delete server copy | Remove server availability; leave existing device copies intact |

The UI offers `Remove download from this device` when content is local,
and a distinct `Delete server copy` action when permitted. A second tap on an
unchanged button must not silently escalate local removal into shared deletion.
Server deletion should explain that other users will lose the ability to obtain
that server copy. Deleting every device's copy is outside the initial scope.

Only administrators can delete shared content. Support deleting an individual
chapter or a whole work. Existing device copies and personal reading records
remain intact. Download permission never implies shared deletion permission.

Server deletion creates a persistent deletion record. Old queued uploads and
devices returning after a long offline period must not resurrect the content.
Republication requires an explicit administrator restoration or permission to
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

## Account reading state and conflicts

Synchronize the same account's current chapter and position, while preserving
separate state for every other account. Record a device identity and operation
identity so retries and reordered delivery do not produce duplicate changes.

Do not resolve conflicts by always selecting the highest chapter or largest
progress percentage. Rereading and moving backward are valid actions. Device
clocks and server arrival order alone also cannot reliably establish reading order
after independent offline sessions.

Attach the last server state version observed by the device to each change.
Apply one-sided changes automatically and merge changes to independent items.
When devices concurrently change the reading position of the same work, retain
both candidates and let the user choose when opening that work. Present the
device associated with each candidate. Use a small versioned-state protocol;
a general CRDT synchronization framework is outside the first version.

Merge library membership and bookmarks per item. Concurrent addition and removal
of the same item resolve to removal; a subsequent explicit addition is allowed.
Preserve conflicting read/unread changes separately for resolution. In particular,
an old automatic completion record must not erase an explicit unread action.
Detailed operation schemas must distinguish concurrency from later intentional
changes and handle repeated operations without creating new conflicts.

Receiving a remote position must not move an actively displayed chapter without
the user's action. Offer to continue from the other device when appropriate.
For HTML and text, store paragraph identity information and an offset within the
paragraph. For PDF, store the document page and a position within that page. These
locators must not depend on viewport pagination. Include the content revision
with the position. If a changed revision prevents exact restoration, fall back to
chapter progress and disclose that the restored position is approximate.

## Protocol and compatibility

Define the wire protocol independently of Norea's internal SQLite schema and
backup ZIP format. Reuse existing storage and media handling where appropriate,
but do not synchronize a live database or treat a full backup as the incremental
sync protocol.

Use a REST API under `/api/v1` with explicit request and response schemas and an
independently versioned package format starting with `packageVersion: 1`. Query
supported protocol versions, package versions, and capabilities when connecting.
Unsupported versions must produce a clear sync error while local reading
continues. Publish the supported app/server combinations before release.
App-side data changes must also follow Norea's active release-line compatibility
policy.

Publish an OpenAPI document from the same route schemas used for request and
response validation. The selected stack is TypeScript, Fastify, REST/OpenAPI,
and SQLite. Do not introduce GraphQL, Java, or Spring Boot. File uploads and
downloads use ordinary streaming HTTP endpoints.

The protocol needs operations for server capabilities, shared catalog changes,
complete package publication and retrieval, explicit deletion and republication,
and account-scoped reading-state changes. Define endpoint names and detailed
schemas during implementation planning using the decisions in this document.

## Deployment and operations

Run a single Fastify instance with SQLite metadata and ZIP files on persistent
storage. Stream large transfers between disk and network rather than buffering
entire packages in memory. Do not add Redis, a separate queue service, or an S3
dependency to the first version. Reconsider a client/server database such as
PostgreSQL if deployment later requires multiple server instances or substantial
concurrent writes.

Enforce a server-wide storage limit and per-account limits on new upload data.
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

The first usable version connects each app profile to one server, supports
accounts with multiple devices, transfers complete chapter packages, discovers
shared catalog content, and synchronizes personal reading position, read status,
library membership, and bookmarks. It includes explicit local removal, controlled
server deletion, and recovery from interrupted
work. Reader appearance and download selection remain device-local.

Implementation should first prove complete package transfer and offline reading,
then account-state convergence and conflict handling. These are delivery steps
within the design, not a commitment to ship incomplete behavior as complete.

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
7. Two accounts can read the same content without sharing progress. Two devices
   on one account can continue from synchronized reading state.
8. Concurrent offline reading and intentional backward movement do not silently
   disappear under a highest-progress or last-arrival rule.
9. The same content restores correctly with different device database IDs and
   paths, including when the original source plugin is unavailable.
10. Server downtime, storage exhaustion, authentication failure, corrupt packages,
    and unsupported versions leave local reading usable and report sync status.
11. Anonymous readers can browse and download by default but cannot upload,
    change account records, or delete shared content. Disabling anonymous reading
    requires authentication for catalog access and downloads.
12. An interrupted download resumes only against the same ZIP. An interrupted
    upload restarts safely. Package limits reject excess data without publishing
    incomplete content.
13. An administrator can change a chapter's default revision without replacing
    device copies. Changed content uses an explicitly approximate position when
    its original locator cannot be restored.
14. Server deletion enters the 30-day trash period. Permanent file removal retains
    deletion records, and explicit administrator restoration permits republication.
15. First sign-in respects the selected local/server merge behavior. Switching
    accounts and revoking one device session do not leak personal records or
    prevent local reading.
16. Concurrent membership or bookmark addition/removal resolves to removal, while
    a later explicit addition succeeds. An old automatic completion record does
    not overwrite a deliberate unread action.
17. A restored backup contains every package and cover referenced by its database
    snapshot, including when publication or cleanup was active during backup.

These are planned acceptance checks. No server implementation or runtime
validation has been performed for this document.

## Implementation planning details

The product decisions above are accepted. The implementation plan still needs
concrete contracts and operational configuration:

- Request and response schemas, existing plugin/path identity encoding, local
  chapter mappings, and the canonical manifest field set.
- Device session storage and expiry, password storage, administrator bootstrap,
  account invitation/reset flow, and credential storage in the app.
- Version preconditions, independent-item merge boundaries, conflict resolution
  operations, and restart-safe transfer and synchronization cursors.
- Locator encoding, cover transfer, archive validation, partial-download identity
  checks, and recovery across filesystem/database publication boundaries.
- Deployment-specific quota values, backup schedule and destination, and the
  initial tested client/server compatibility matrix.

These details refine the accepted behavior; they do not reopen the selected access
model, stack, package unit, deletion scope, or first-release feature set.

## Current Norea integration references

Static source inspection identified the following existing boundaries. These
references are design inputs and do not imply that synchronization exists today.

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
