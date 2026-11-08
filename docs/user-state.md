# Shared user state v1

User-state sharing is a merge protocol for user actions, separate from original chapter content and full-device recovery archives. It advertises `userStateVersion: 1`. The existing reading-state v1 and device-backup v1 endpoints keep their meanings and data.

## Shared scope and authentication

The server creates one persistent random workspace UUID and a separate random epoch UUID in an additive SQLite extension. Every registered, unblocked device shares this workspace, matching existing full-device-backup access. Device names are author labels, never slot keys or identities. Console sessions and anonymous readers cannot use these routes. Device registration/blocking is unchanged.

Workspace IDs are namespace checks, not credentials. A different workspace or epoch is a 409; clients retain unsent edits and require an explicit reconnect/rebind. This release provides no reset or destructive namespace-replacement route. Existing private reading profiles are not imported or guessed.

## Routes

All routes are below `/api/v1`, require the existing device bearer, and return `Cache-Control: no-store`.

- `GET /user-state` returns `{version:1,workspaceId,epoch,headRevision}`.
- `POST /user-state/read` accepts `{workspaceId,epoch,after,through?,limit?}`. It returns the workspace fields plus `through,nextCursor,hasMore,records`.
- `POST /user-state/merge` accepts `{workspaceId,epoch,operations}`. It returns the workspace fields plus `results`.

A record is `{entity,value,revision,operationId,updatedAt,deviceId,deviceName}`. The server assigns the revision, millisecond update time and authenticated author. Operations cannot supply author identity or authoritative time.

A merge operation is `{operationId,entity,baseRevision,value,seed?:true}`. Results are `{operationId,status,current,reason?,categoryAlias?}`, where status is `applied`, `unchanged`, `seed-skipped`, `conflict` or `aliased`.

## Values and portable identity

| Entity kind | Value |
| --- | --- |
| library | `{inLibrary,addedAt}` |
| category | `{name,sort,deleted}` |
| membership | `{included}` |
| reading | `{progress,unread,readAt}` |
| bookmark | `{bookmarked}` |
| resume | `{chapter,anchor,openedAt}` |
| composition | `{composition: ChapterCompositionV1}` |

Work identity is plugin ID plus the ASCII-case-folded source novel ID. Source paths and names are lookup descriptions; titles, display chapter numbers and local SQLite IDs never identify a known work. The wire protocol requires a source novel ID; an unresolved local work remains deferred on the client until legitimate metadata provides it. Local imported-file works use the app's stable source-file identity. Recovered numeric chapter placeholders remain unresolved.

Chapter identity is its stable source/composition chapter path scoped by the work. An optional composition entry ID is an additional ownership proof. Two different supplied proofs cannot silently replace one another. Library, reading and bookmarks are independent mutation groups. Reading's progress/unread/readAt tuple is atomic, including legacy tuples already allowed by SQLite.

Library added times, reading times and resume opened times use Unix seconds, matching the app database. Server updatedAt and anchor savedAt use milliseconds.

Portable resume anchors contain a segment index/count, optional media ordinal, fractional element offset, normalized progress and saved time. They contain no local row ID, screen page index or pixel offset. An empty resume cannot contain an anchor. The destination validates the anchor against its own body.

Composition is one valid, non-null v1 document and one atomic revision. Existing composition validation preserves unique stable entry IDs, paths and storage keys, source provenance, excluded entries and a consecutive included order. Null is not a supported way to detach provenance. Excluding chapters or restoring an order is represented by a valid document; removing the work from the library uses `inLibrary:false`.

The protocol neither accepts arbitrary device settings nor replaces SQLite/localStorage. Plugin code, bearer credentials, VPN configuration, download queues/flags and device filesystem roots are outside the export contract.

## Merge and retry rules

Every operation ID is immutable across this shared workspace, including retries from another admitted device. The server retains a canonical payload hash and the original result. A response-loss retry returns that same result even when later changes exist. Replaying the same operation from a different device also returns the first authored receipt and retains the original author identity. Reusing an ID with a different payload is 409. Duplicate IDs inside one batch are rejected. A malformed operation anywhere in a batch prevents all user-state writes.

For ordinary operations, equivalent values converge as `unchanged` even with an older base. Otherwise the entity's current revision must equal `baseRevision`; an absent entity has revision zero. A stale different value produces a durable `conflict` result with the current record and a reason. Client wall clocks and arrival time do not overwrite an unseen competing edit.

A seed requires base revision zero and only fills an absent entity. It cannot replace a current record or tombstone. False, zero and null (where the value type permits null) are explicit values. Missing records never mean deletion. There is no progress MAX, bookmark OR or unread AND rule for ordinary edits.

Clients acknowledge only the exact immutable operation and retain later local edits. A conflicted operation remains visible as intent; resolving it creates a new operation ID with the observed shared revision. An old response cannot discard newer pending work.

## Categories

Category IDs are stable and separate from local integer IDs and mutable names. Existing categories can use `legacy-<SHA256 exact original name>`; newly created categories use random IDs. Active name uniqueness is exact and case-sensitive.

Creating an absent category at base zero with the exact name of an active category returns `aliased`, including the canonical category record and `{from,to}`. Soft-seed creation follows the same rule. Aliases are permanent and flattened. Old attempted membership payloads can retain the alias ID: the server resolves it and returns the canonical membership record with the alias mapping.

A rename cannot silently merge categories. Name collision is `category-name-conflict`; stale entity edits are `revision-mismatch`. Including a work in an absent or deleted category is respectively `category-missing` or `category-deleted`. Explicit exclusion remains possible. Restoring a category requires its current tombstone revision and an available active name.

Deleting a category atomically publishes false records for all of its currently included shared memberships. Each derived record has a stable ID based on the deleting device, deletion operation and membership identity, and appears in the ordinary change log. Already-false memberships and other categories do not change. The deletion receipt still contains the category record. Retrying the deletion returns that original receipt without cascading again. This advances membership revisions so an old offline inclusion conflicts after restoration; an explicit new inclusion can use the latest false revision.

## Paging, limits and retention

Reads use durable monotonically increasing change revisions, never OFFSET over mutable current rows. The first page freezes `through` at the current head; subsequent pages preserve it. Records appear in ascending revision order. A finishing page advances `nextCursor` to `through`; later changes are read in the next pass. Cursor values beyond the requested history fail explicitly.

Batches and pages contain at most 200 items. JSON request and response budgets are 32 MiB. The existing composition limit is 16 MiB, at most 100,000 entries. Read pages stop at the byte budget as well as the item limit. Merge results are measured while still inside the transaction; an oversized result causes 413 and rolls the batch back. Retry the same immutable operations in smaller batches, including one operation at a time when necessary.

User-state current records, changes, negative values/tombstones, category aliases and operation receipts have no automatic expiry. Arbitrary age-based cleanup would let an old offline device resurrect removed state or reapply an acknowledged operation. Any future compaction must define a new baseline and explicit stale-cursor behavior.

## Storage and compatibility

The original schema checksum remains unchanged. `user_state_meta`, `user_state_records`, `user_state_changes`, `user_state_operations` and `user_state_category_aliases` are additive tables in `metadata.sqlite`. Existing catalog records, original files, passwords, admitted devices, settings and private reading entries are retained.

The new endpoints only write their user-state tables. They do not restore a device archive, rewrite content files, alter plugins/VPN/queues or import a private reading profile. Existing server archive files are retained for separate explicit recovery.

### Composition and existing work metadata

When shared composition state exists, normal work-metadata publication overlays the shared manual choices onto valid current/stored provider snapshots. Newer provider facts can refresh the exact same source identity; default new chapters of the target provider can append without resurrecting retained excluded origins. Unshared foreign-source/manual additions are not treated as provider discoveries. Device wall clocks select provider fact freshness, never the winner between manual choices. Without shared state the existing work metadata timestamp behavior is preserved.

Before writing novel.json, existing physical chapter folders must keep their proven path, storage key and primary source. A different entry UUID is accepted only for an ordinary original target-provider path with otherwise identical ownership. Synthetic entry ID changes, foreign-source substitution, moved storage keys and unproven occupied folders defer with 409. The state record remains available for explicit resolution; no body files are renamed or overwritten by the state API. Metadata-only entries without physical data do not create false storage conflicts.

Before deploying the additive database extension, follow `AGENTS.md` and `docs/deployment.md`: validate a consistent SQLite backup, preserve all existing data/credentials/mounts, publish the exact tested commit through CI, deploy its verified image digest and check preserved data plus the new capability.
