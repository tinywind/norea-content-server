# Conditional work migration

A source switch creates a different work identity: the work ID is the SHA-256
of JSON `[pluginId, novelPath]`. Ordinary synchronization does not infer a merge
from a matching title and does not delete a server work when it disappears from
a device.

Clients that have completed an explicit local merge can use the conditional
migration protocol to retire the old server work after preserving the selected
copies under the new source. Capability discovery exposes
`workMigrationVersion: 1`. Finalization does not fetch source websites or infer
episode equivalence. The explicit server-copy extension stages existing original
files under the target identity without rewriting chapter bodies or media.

## Client sequence

1. Persist a merge job with the source and target identities, the complete local
   chapter decisions, and the selected existing target inventories. Record it
   with the local merge so a restart cannot forget unfinished server work.
2. Hold the old identity out of metadata import and automatic upload while the
   job is pending. An unavailable server must not block local reading.
3. Read the source snapshot. Resolve explicit source paths first; recovered
   `norea-folder:` paths may use a unique chapter number within that exact work.
   Never equate chapter numbers across different source plugins.
4. Require a captured merge decision for every server source chapter and every
   saved source metadata number. Missing or ambiguous choices leave the job
   pending and the server source intact.
5. Upload fresh authoritative target metadata and cover, then verify their snapshot.
   Upload locally selected files through ordinary APIs; use `migration-copy` for
   selected bodies stored only on the server. Read a fresh target snapshot.
6. Include full `chapterDecisions`, including explicit exclusions. Persist the
   exact request before sending it. Retry an uncertain result with the same
   operation ID and payload.
7. On success, consume `deletedWork` through the normal durable work-deletion
   exclusion path. Clear the pending job only after that state is persisted.

The protocol requires one-to-one chapter mappings. It does not silently discard
multiple source copies that the device collapsed into one target chapter.

## Snapshot

`GET /api/v1/works/:id/migration-snapshot` follows the normal anonymous-read
setting. It returns `Cache-Control: no-store` and contains no chapter prose or
media bytes.

~~~json
{
  "work": {
    "id": "<64 lowercase hex characters>",
    "revision": "<64 lowercase hex characters>",
    "identity": {
      "pluginId": "source-plugin",
      "novelId": "source-work",
      "novelPath": "/source/work"
    }
  },
  "chapters": [
    {
      "id": "<chapter ID>",
      "revision": "<chapter revision>",
      "chapterPath": "norea-folder:1",
      "chapterNumber": "1",
      "position": 1,
      "name": "Episode 1",
      "complete": true,
      "available": true
    }
  ]
}
~~~

The work object also includes `metadata` (complete `NovelMetadataV1`) and
`coverSha256` (the actual selected cover SHA-256, or null). The revision
fingerprints that metadata and cover digest. A cover changing during capture
returns 409. Chapter revisions are existing catalog transfer tokens; they are not
body-content hashes. A snapshot includes **every nondeleted chapter**, including
unavailable copies, sorted by chapter ID. More than 10,000 chapters returns 409.
It does not hash every chapter payload. Obtain an individual inventory with
`GET /chapters/:id/storage-inventory?revision=...` when needed.

## Finalization request

`POST /api/v1/works/:sourceId/finalize-migration` requires an unblocked registered
device credential. A console token cannot invoke it. The source ID is in the
URL; the target must be a remote work owned by a different plugin.

~~~json
{
  "operationId": "94ea494e-c052-4fc8-86ce-928737b9a399",
  "source": {
    "revision": "<source work revision>",
    "chapters": [
      { "id": "<source chapter ID>", "revision": "<source chapter revision>" }
    ]
  },
  "target": {
    "id": "<target work ID>",
    "revision": "<target work revision>"
  },
  "mappings": [
    {
      "sourceChapterId": "<source chapter ID>",
      "targetChapterId": "<target chapter ID>",
      "targetRevision": "<target chapter revision>",
      "decision": "copy-source"
    }
  ]
}
~~~

The source chapter set must exactly match the current nondeleted server set:
no missing, extra, repeated, or newly uploaded rows. Each source needs one
mapping, and each retained target may occur only once. Preservation mappings
require available files; explicit `delete-source` choices may retire an
unavailable selected source package. Unindexed source folders or files block finalization rather than
being deleted incidentally.

### Copying the source

`decision: "copy-source"` requires the current target body SHA-256 and byte
length to equal the source. Media declarations must match, and every stored
source asset must exist under the same key with the same SHA-256 and byte length.
The target must also contain all of its declared assets. A complete target may
therefore replace a partial source without losing any stored source asset.

The server hashes the actual files again during finalization; catalog
`complete` and revision values alone are not sufficient evidence.

### Keeping the selected target

`decision: "keep-target"` requires `expectedTargetInventory`, captured from the
actual existing target copy chosen during the local merge:

~~~json
{
  "body": { "sha256": "<body hash>", "bytes": 1234 },
  "expectedAssetKeys": ["media/page-1.png"],
  "storedAssets": [
    { "key": "media/page-1.png", "sha256": "<asset hash>", "bytes": 5678 }
  ]
}
~~~

The inventory has the same three fields as the storage-inventory API.
Native-only fingerprint and byte-summary fields are not part of this request.
The actual server target inventory must equal this captured selection, and the
target must be complete. The chosen target can legitimately have different
body or image bytes from the old source.

A body-only text/HTML/PDF copy without a media manifest or archive is verified
by its nonempty body SHA-256 and length; its inventory has
`expectedAssetKeys: null` and `storedAssets: []`. A copy with a media manifest
or archive requires valid declarations and every declared asset. Invalid or
missing declarations are not treated as a text-only copy. A non-PDF body with
null or empty asset declarations also needs a matching actual body digest and
conservative text-only verification. It must be UTF-8, at most 16 MiB, and free
of media elements/attributes, executable content, and CSS resource references,
escapes, or comments. Unsupported markup returns 409 rather than authorizing
source deletion. PDF copies retain the self-contained single-body contract;
this HTML check does not rewrite any stored content.

## Commit, conflicts, and retries

The server inspects payloads asynchronously and refreshes both work revisions.
A migration-only verification callback then runs under the existing deletion
transaction's SQLite write lock. It rechecks both work rows, the entire source
chapter set, every chapter row, directory contents, and file fingerprints before
any database row is removed. The source folder uses its temporary retired path
during these checks; a failed guard rolls back and restores that folder. No
await occurs in this section, and other SQLite writers cannot change the
verified records before the tombstones and receipt commit.

Unknown source files and chapter folders block finalization. All recognized
regular local cover formats are fenced, including older alternatives; these do
not replace the target's fresh cover. A regular file named
`novel-<device>-safeBackup-<four digits>.json` is covered only when its raw bytes
exactly equal the current `novel.json`. Both files are fenced before comparison
and rechecked under the final deletion lock. Modified backups, other filenames,
symlinks, and unindexed chapter folders still return 409. This does not change
the source snapshot or the client's persisted finalization request.

The deletion transaction records the usual work/chapter tombstones and an
idempotency receipt together. Receipt storage is an additive table; the original
schema checksum and existing catalogs, devices, settings, and files are retained.
The source folder is restored if the transaction fails.

Success returns:

~~~json
{
  "operationId": "<same UUID>",
  "deletedWork": { "...": "normal WorkEntry", "deleted": true }
}
~~~

A retry with the same operation ID and identical request returns the stored
response, including after restart or an earlier lost response. Reusing the ID
for different data returns 409. A manually deleted source without this receipt,
or a source restored after successful migration, also returns 409.

Stale revisions, incomplete snapshots, unavailable files, ambiguous mappings,
changed file bytes, and invalid preservation evidence return 409 and leave the
source intact. Malformed JSON/schema fields return 400; transient inventory
capacity limits may return 503. Authentication uses normal 401/403 responses.

Finalization may inspect many large archives. The route allows 300 seconds of
socket inactivity; clients should allow a corresponding request timeout and
persist the exact request before submission. A client timeout is an uncertain
outcome: retry the persisted request rather than minting a new operation ID or
calling unconditional DELETE.

## Fresh metadata and explicit cover removal

The latest target-plugin metadata is authoritative, including null fields.
Do not fill author or cover from the old source. Upload fresh target metadata
and cover bytes, then compare the snapshot metadata and actual `coverSha256`
with the captured selection. A fetch or upload failure keeps the migration pending.

Ordinary metadata-only PUT requests may lack locally downloaded image bytes, so
`cover: null` does not implicitly delete an existing physical cover. When a fresh
target fetch explicitly has no cover, `workCoverDeletionVersion: 1` enables:

~~~http
DELETE /api/v1/works/:id/cover
Content-Type: application/json

{"revision":"<current work snapshot revision>"}
~~~

An unblocked registered device is required. The response is a normal `WorkEntry`
with `hasCover: false` and `metadata.cover: null`. All recognized regular local
cover formats are removed, so reindexing cannot rediscover an older alternative.
Other metadata and chapter bodies remain unchanged. A stale revision returns 409;
nonregular cover paths are rejected. Synchronous file or index failures restore
the original files and index. `novel.json` stays continuously present during
staging. A cover upload that started before a work revision change returns 409,
preventing a stale upload from resurrecting the cleared image. After a lost
response, read a fresh snapshot and accept an already absent cover.

## Server-side payload copying

Capability `workMigrationCopyVersion: 1` lets a migration copy bodies stored
only on the server without downloading and reuploading them through a device.

`POST /api/v1/works/:sourceId/migration-copy` accepts one selected source chapter:

~~~json
{
  "decision": "copy-source",
  "source": {
    "revision": "<source work revision>",
    "chapter": {"id":"<source chapter ID>","revision":"<source chapter revision>"}
  },
  "target": {
    "id": "<target work ID>",
    "revision": "<target work revision>",
    "chapter": {
      "chapterPath": "/new/1",
      "chapterNumber": "1",
      "position": 1,
      "name": "Fresh episode title",
      "page": "1"
    },
    "expectedChapter": null
  }
}
~~~

`expectedChapter` is null only when no target copy is expected. Replacing a
different existing copy requires its exact `{id, revision}`. The chapter name and
number must match the current target metadata. Novel identity, title, author,
and summary come from that metadata. Body, media manifest, archive, content type,
and file descriptors come from the source. A uniquely matching indexed recovered
folder alias is retained rather than silently reassigning its identity.

The server verifies the source inventory, stages its original files, and uses
ordinary chapter publication. Work records, chapter records, file fingerprints,
expected target state, and device authorization are checked again under the
publication write lock. The source is never deleted by this endpoint. Failure
retains the source and any previous target. Success returns
`{"entry": <CatalogEntry>}`. An exact retry reuses a target that already has the
same verified inventory and package metadata, without advancing its revision.

Persist the request before sending it and refresh the target snapshot afterward.
Missing/stale source or target state returns 409. Authorization and transient
server failures retain their normal status. Partial media can be copied without
losing existing files, but finalization still requires a complete selected target.

## Full chapter choices and explicit deletion

Capability `workMigrationLineageVersion: 1` adds `chapterDecisions` to finalization.
New clients send every captured selection, including metadata-only chapters:

~~~json
{
  "chapterDecisions": [
    {"sourceChapterPath":"/old/1","sourceChapterNumber":"1","targetChapterPath":"/new/1","targetChapterNumber":"1"},
    {"sourceChapterPath":"/old/2","sourceChapterNumber":"2","targetChapterPath":null,"targetChapterNumber":null}
  ]
}
~~~

Null targets are explicit user exclusions. Every saved source metadata number
and server source package must be covered. Exact paths take precedence; fallback
by number is permitted only within the same exact work and must be unique.
Repeated choices, missing coverage, or disagreement with package mappings returns
409. Local-only choices remain recorded; lineage marks number membership with
`sourceMetadataVerified` and `targetMetadataVerified`. These flags do not prove
a website path or establish a new equivalence.

Every server source package needs one copy, keep, or explicit deletion mapping.
An excluded package uses:

~~~json
{"sourceChapterId":"<source chapter ID>","decision":"delete-source"}
~~~

It requires a matching null-target chapter decision and cannot carry target
fields or inventory. The source snapshot still fixes its current revision.
An unavailable source package may be explicitly deleted, but remaining files
are fenced and unindexed contents still block retirement. Copy and keep retain
all prior preservation and completeness checks.

Older requests without `chapterDecisions` can use the original copy/keep
protocol. Their lineage has `fullDecisionCoverage: false` and an empty decision
list; receiving devices must not infer metadata-only deletions. Already frozen
requests are retried unchanged under the same operation ID.

## Durable lineage and other devices

Source retirement stores tombstones, receipt, immutable lineage, and an active
event in one transaction. Lineage retains full source and target work snapshots,
their entire chapter maps and cover hashes, package mappings, verified target
inventories, all declared chapter choices, and `deletedSource: {revision, sequence}`.

`GET /api/v1/work-migrations?after=0&limit=100` returns:

~~~json
{
  "items": [{
    "sequence": 1,
    "operationId": "<UUID>",
    "sourceWork": {"...":"complete captured work snapshot"},
    "targetWork": {"...":"complete captured work snapshot"},
    "deletedSource": {"revision":"<source work revision>","sequence":42},
    "mappings": [{
      "source":{"...":"source chapter snapshot"},
      "target":{"...":"target chapter snapshot"},
      "decision":"copy-source",
      "targetInventory":{"body":{"sha256":"<hash>","bytes":123},"expectedAssetKeys":null,"storedAssets":[]}
    }],
    "chapterDecisions": [],
    "fullDecisionCoverage": false,
    "active": true
  }],
  "cursor": 1,
  "hasMore": false
}
~~~

Delete mappings have `target: null` and `targetInventory: null`. The exact contract
is `WorkMigrationLineage` in `src/work-migration-lineage.ts`. These APIs use the
normal read authentication policy and `Cache-Control: no-store`. They include no
chapter prose, image bytes, credentials, or personal reading state.

The feed coalesces each operation to its latest event before pagination, ordered
by event sequence. Persist cursors only after durably handling a page. Ahead
cursors return 409. Existing work/catalog notifications also wake clients for
committed migrations and restorations.

Explicit `PUT /works/:sourceId?restore=true` records an inactive event atomically
with restoration. Its higher sequence delivers revocation to devices that already
consumed the migration. New devices see the current inactive state rather than
first replaying an obsolete active event. Revocation releases migration exclusions;
it does not undo completed local migrations. Ordinary metadata and chapter uploads
cannot resurrect the retired source.

`GET /api/v1/work-migrations/:operationId` returns the current event or 404.
Pending clients should recheck it before applying and immediately before retiring
local source data; changed or inactive events supersede the pending selection.

`GET /api/v1/works/:id/migration-history?after=0&limit=100` returns the same page
shape for the complete connected chain, in either direction, including deleted
intermediate works. A-to-B-to-C remains replayable after B disappears. Migrating
B to C does not revoke A to B.

Both tables are additive extensions outside the original schema checksum.
Upgrades retain catalogs, credentials, settings, tombstones, files, and older
receipts. A historical request hash cannot recover a target mapping, so no
lineage is fabricated for migrations completed before this extension.
