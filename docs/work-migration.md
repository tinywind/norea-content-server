# Conditional work migration

A source switch creates a different work identity: the work ID is the SHA-256
of JSON `[pluginId, novelPath]`. Ordinary synchronization does not infer a merge
from a matching title and does not delete a server work when it disappears from
a device.

Clients that have completed an explicit local merge can use the conditional
migration protocol to retire the old server work after preserving the selected
copies under the new source. Capability discovery exposes
`workMigrationVersion: 1`. This protocol does not fetch source websites, upload
files, infer episode equivalence, or rewrite chapter bodies and media.

## Client sequence

1. Persist a merge job with the source and target identities, the complete local
   chapter decisions, and the selected existing target inventories. Record it
   with the local merge so a restart cannot forget unfinished server work.
2. Hold the old identity out of metadata import and automatic upload while the
   job is pending. An unavailable server must not block local reading.
3. Read the source snapshot. Resolve explicit source paths first; recovered
   `norea-folder:` paths may use a unique chapter number within that exact work.
   Never equate chapter numbers across different source plugins.
4. Require a decision backed by a local merge for every server source chapter.
   A server-only chapter, excluded chapter, or ambiguous mapping leaves the
   job pending and the server source intact.
5. Upload the target work metadata and selected chapter files through the
   existing APIs. Read the target snapshot and resolve the target chapter IDs.
6. Persist the exact finalization request before sending it. Retry an uncertain
   result with the same operation ID and payload.
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

The work revision fingerprints the current canonical work metadata and cover
bytes. Chapter revisions are existing catalog transfer tokens; they are not
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
mapping, and each target may occur only once. All referenced files must still
be available. Unindexed source folders or files block finalization rather than
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

Unknown source files and chapter folders block finalization. A regular file named
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
