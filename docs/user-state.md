# Shared user-state delta protocol

The content server stores personal library and reading changes as indexed records,
not as one repeatedly merged JSON snapshot. Registered, unblocked devices share a
single persistent workspace UUID and epoch. Device names are audit labels; they
are not storage partitions.

The server advertises:

- `userStateVersion: 1` for the normal delta protocol.
- `userStateCurrentVersion: 2` temporarily for deployed older clients during the
  transition.

Anonymous requests, console sessions, blocked devices, and requests for another
workspace are rejected. Responses use `Cache-Control: no-store`.

## Delta API

| Endpoint | Contract |
| --- | --- |
| `GET /api/v1/user-state` | Returns protocol version, workspace, epoch, and current head revision |
| `POST /api/v1/user-state/read` | Returns ordered records after a cursor through a frozen upper revision |
| `POST /api/v1/user-state/merge` | Applies immutable operations and returns exactly one receipt per operation |

An operation contains an operation UUID, entity, observed base revision, value,
and optional soft-seed flag. A record contains the entity/value, assigned revision,
operation UUID, authenticated device author, and server timestamp.

A page or merge batch contains at most 200 records or operations. Requests and
responses are limited to 32 MiB. Oversized merge responses roll back atomically so
the client can retry the same immutable operations in smaller batches.

## Database model and cost

The protocol uses the following SQLite tables:

- `user_state_records`: one current row per portable entity key.
- `user_state_changes`: append-only increasing revisions used by cursor reads.
- `user_state_operations`: idempotent operation receipts.
- `user_state_category_aliases`: stable category-ID canonicalization.

Normal merge work is proportional to the submitted operations: one indexed entity
lookup, validation, and one record upsert/change row per accepted value. It does
not scan or merge the accumulated user-state document.

Category membership rows additionally store `membership_category_id` and
`membership_included` in indexed columns. Deleting a category queries only the
included memberships belonging to that category and writes an explicit false
revision for each affected relation. This work is proportional to the relations
that must actually change, not to all personal-state records.

Reads use the `user_state_changes` revision primary key. A returning device asks
only for revisions after its saved cursor. The first connection may page through
existing history once; subsequent checks process only later changes.

## Merge behavior

Each entity is an independent conflict unit: library membership, category,
work/category membership, chapter reading tuple, bookmark, work resume position,
or complete chapter-composition document.

A command is applied only when its base revision matches the current entity
revision. An equivalent value converges without creating another revision. A
stale different value returns an explicit conflict while preserving the current
record. Soft seeds fill only absent entities and never replace a record or
negative value.

Removal, unread/reset progress, unbookmarking, category deletion, membership
removal, and resume clearing are first-class values. They are never inferred from
absence and never expire. Operation IDs are immutable and idempotent across the
workspace; replaying the same bytes returns the original receipt, while reusing an
ID with different bytes is rejected before any batch write occurs.

Category names are unique while active. A new category with an existing exact
name can alias to the canonical stable ID. Deleting a category advances included
membership records to false, preventing stale offline inclusion from resurrecting
it. Composition values retain their complete provenance, storage identities,
manual order, labels, and exclusions.

## Portable identities and privacy

Works use plugin ID plus provider-owned work ID. Chapters use their exact provider
path scoped to the work; composed chapters additionally require their composition
entry ID. Local database integers, titles, displayed chapter numbers, and folder
numbers are not portable identities.

Recovered source chapters may use an opaque `norea-stored:` identity containing a
content digest and encoded storage path. Applying such state requires exact local
ownership and body/media verification. Missing or ambiguous metadata remains
pending on the client rather than being guessed by name or number.

The protocol does not contain credentials, VPN settings, storage roots, plugin
code, download queues, cached chapter bodies, images, or viewport-only state.
Private/incognito reading is excluded by the app before operations are created.

## Upgrade from current-snapshot version 2

The compatibility endpoint remains available temporarily:

| Endpoint | Compatibility behavior |
| --- | --- |
| `GET /api/v1/user-state/current` | Returns the positive current-state projection |
| `POST /api/v1/user-state/current` | Accepts an older positive snapshot and bridges touched values into delta records |

At the first upgraded server start, existing `user_state_current_records` are
copied once into `user_state_records` and `user_state_changes` inside the additive
schema transaction. The deployed current snapshot is authoritative for this
one-time handoff: older positive delta records absent from it receive explicit
library/removal, reading-reset, unbookmark, membership/category-deletion, or
resume-clear revisions instead of being silently resurrected. Composition records
are retained because protocol version 1 has no composition-deletion value. A
completion marker prevents repeated full conversion. Existing content, devices,
credentials, settings, workspace identity, current rows, prior delta rows, and
operation receipts remain intact.

During the rollout, delta writes are projected back into the current table so an
older client can still read positive values. Explicit negative delta values are
protected from stale positive snapshots. Stable category IDs are mapped to current
name hashes in dedicated bridge tables; rename history is retained so an old
snapshot cannot rename a category back or restore memberships under its previous
name.

The compatibility path is transitional. New apps use only the delta endpoints and
do not upload the accumulated state snapshot.

## Completed migration reconciliation

`workMigrationReconcileVersion: 1` advertises
`POST /api/v1/works/:id/migration-reconcile`. Its body includes the exact legacy
receipt request and a separately reviewed current request. The server verifies
source/target identity, complete chapter coverage, storage numbers, selected body
and asset inventories, and existing preservation decisions before retiring a
restored source.

The new lineage records both the new operation ID and legacy operation ID.
Retirement, receipt, and lineage commit atomically. A deliberate restoration must
name the active migration operation and persists revocation; routine uploads or
rescans cannot silently reverse either a completed retirement or an explicit
restore.

## Deployment and recovery

The tables and columns above are added without replacing the installation's schema
checksum or deleting existing rows. Before deploying a database-changing server
image, create a consistent SQLite backup using the backup API (or stop writes for
a full persistent-state copy), validate integrity and representative records, and
retain the previous image digest for rollback.
