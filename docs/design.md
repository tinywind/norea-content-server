# Norea Content Server design

Date: 2026-10-11

Status: design draft for review. This document records the agreed direction,
proposed behavior, and remaining decisions. It does not describe an implemented
service or authorize implementation.

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

A public source repository does not determine the deployed server's network
exposure or access policy. Whether downloads require authentication remains an
explicit deployment and product decision.

## Boundaries

The server owns the shared catalog, completed content packages, account reading
state, and synchronization changes. A minimal implementation can use a metadata
database and a filesystem package store. The implementation language, framework,
database engine, authentication mechanism, and deployment packaging are not yet
selected.

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

## Data ownership

| Data | Scope | Behavior |
| --- | --- | --- |
| Works, chapters, source identity, complete packages | Shared server catalog | Reused across accounts and devices |
| Library membership, current reading position, read status, bookmarks | Account | Synchronized between that account's devices |
| Downloaded files, local paths, storage usage, download selection | Device | Independently managed on each device |
| Pending transfers, credentials, local database IDs | Device | Never treated as shared content |

Account-scoped library membership and bookmarks are proposed alongside reading
position; reading position isolation is an explicit requirement. Device-specific
reader appearance settings should remain local in the first version.

Content access must not expose another account's reading records. A shared content
package contains no account state, source credentials, or device-specific paths.
Signing in must not silently replace existing offline reading state; the initial
association of local state with an account needs a defined merge flow.

## Content identity and revisions

Use separate identities for the logical work, logical chapter, and content
revision. Local numeric database IDs are only mappings within a device.

For source content, the proposed external identity is a stable source namespace
plus the source's work ID, followed by its chapter ID. Where a plugin supplies no
stable ID, use its existing work or chapter path as the fallback. A display name,
chapter number, or sanitized storage directory is not a reliable identity.

Initially, existing plugin IDs can help identify the source namespace, but plugin
renames and site domain changes need explicit aliases or migrations. Do not
silently strip URL components or merge similarly named works. Source identity
extraction must be defined with the Norea plugin contract before implementation.

For local imports, the original file's SHA-256 digest detects identical imported
files. A work and its extracted chapters also need identities that survive
reordering. Derive initial chapter identity from a stable entry in the imported
file where available, then preserve it. Independent imports with different file
bytes remain distinct unless the user explicitly associates them.

Represent a changed body or asset set as a new revision of the same chapter.
Reading state continues to refer to the logical chapter, with the content revision
recorded when necessary to interpret its position. Do not overwrite one complete
revision with a different upload solely because it arrived later.

A canonical manifest of relative file names, sizes, and content hashes can
identify a revision. The ZIP itself has a separate checksum for transfer
verification: ZIP timestamps or entry ordering can change its bytes without
changing the underlying content. Manifest serialization and identity versions
must be specified before interoperable clients are implemented.

## Complete ZIP packages

The proposed transfer unit is one chapter with its body and required assets.
This avoids repackaging a whole novel when a chapter is added or changed. Local
imports should use the same readable chapter boundary where possible; a PDF
represented as one chapter can remain one package.

Each package carries a versioned manifest, sufficient work and chapter metadata
for restoration, the stored content type, the body, and its required assets.
Internal references use portable relative paths. Work cover handling and any
assets shared by multiple chapters still need a precise format decision.

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
The specific byte-resume protocol is not selected; retry safety is required even
if the first implementation restarts an individual package transfer.

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

The proposed sync loop exchanges catalog changes and account state independently
from large packages. It uses persistent pending operations, idempotent writes,
and a server change cursor so reconnecting does not require transferring every
file. An empty response or connection failure is never interpreted as deletion.

Synchronize on explicit request and suitable app activity or reconnection. Do not
promise continuous synchronization while a mobile app is suspended. Persist enough
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

The proposed UI offers `Remove download from this device` when content is local,
and a distinct `Delete server copy` action when permitted. A second tap on an
unchanged button must not silently escalate local removal into shared deletion.
Server deletion should explain that other users will lose the ability to obtain
that server copy. Deleting every device's copy is outside the initial scope.

Restricting shared deletion to administrators is the initial recommendation, not
an approved access-control decision. Download permission must not imply shared
deletion permission.

Server deletion creates a persistent deletion record. Old queued uploads and
devices returning after a long offline period must not resurrect the content.
Republication requires an explicit operation against the current deletion state.
Deletion must also invalidate any pending publication for the affected item.

Logical unavailability can precede physical file cleanup. Retention, revision
purging, and deletion-record lifetime must be defined together; removing a
deletion record too early can allow a stale device to restore deleted content.

## Account reading state and conflicts

Synchronize the same account's current chapter and position, while preserving
separate state for every other account. Record a device identity and operation
identity so retries and reordered delivery do not produce duplicate changes.

Do not resolve conflicts by always selecting the highest chapter or largest
progress percentage. Rereading and moving backward are valid actions. Device
clocks and server arrival order alone also cannot reliably establish reading order
after independent offline sessions.

The proposed policy is to apply causally newer changes automatically and preserve
concurrent reading positions for a user choice. A small versioned state protocol
should be evaluated before introducing a general collaboration framework. The
exact conflict representation remains an implementation prerequisite.

Receiving a remote position must not move an actively displayed chapter without
the user's action. Offer to continue from the other device when appropriate.
Use a content-relative locator rather than a viewport page number where possible,
since layout differs between a PC and tablet. When a content revision changes,
validate the locator and use a defined fallback instead of claiming exact
position restoration. Read status and bookmarks need their own merge rules.

## Protocol and compatibility

Define the wire protocol independently of Norea's internal SQLite schema and
backup ZIP format. Reuse existing storage and media handling where appropriate,
but do not synchronize a live database or treat a full backup as the incremental
sync protocol.

Version the package format and API behavior explicitly. Unsupported versions must
produce a clear sync error while local reading continues. Define the supported
app/server combinations before release. App-side data changes must also follow
Norea's active release-line compatibility policy.

The protocol needs operations for server capabilities, shared catalog changes,
complete package publication and retrieval, explicit deletion and republication,
and account-scoped reading-state changes. Endpoint names and detailed request
schemas are deferred until identity, authentication, and conflict rules are
approved.

## Initial delivery scope

The proposed first usable version connects each app profile to one server, supports
accounts with multiple devices, transfers complete chapter packages, discovers
shared catalog content, and synchronizes personal reading position. It includes
explicit local removal, controlled server deletion, and recovery from interrupted
work. Account library membership and bookmarks should be confirmed before fixing
the first release scope.

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

These are planned acceptance checks. No server implementation or runtime
validation has been performed for this document.

## Decisions required before implementation

- Access model: anonymous content downloads or authenticated readers; who can
  upload; administrator-only shared deletion; account provisioning and recovery.
- Identity contract: source namespaces, path fallback rules, source renames, and
  stable identities for chapters created from local imports.
- Package contract: manifest serialization, content locators, work covers,
  supported asset references, size limits, and revision retention.
- Reading-state contract: causal versions, concurrent-change choices, bookmark
  and read-status merging, and first sign-in with existing local state.
- Deletion contract: chapter versus whole-work operations, revision deletion,
  explicit republication, and deletion-record retention.
- Operational choices: implementation stack, deployment target, transport and
  credential handling, quotas, server backups, and client/server version support.

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
