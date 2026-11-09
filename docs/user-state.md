# Shared current user state v2

User-state sharing exchanges a positive snapshot of the current SQLite values. It does not replay an operation journal, copy a database file, replace localStorage, or interpret missing rows as deletion. Capabilities advertise both `userStateVersion: 2` and `userStateCurrentVersion: 2`; legacy user-state discovery, `/read` and `/merge` return 426 so old clients cannot publish an unnoticed second history.

## Scope and API

Every registered, unblocked device shares one persistent workspace UUID and a separate persistent epoch UUID. Device names are labels and never storage slots. Console sessions and anonymous readers cannot use current-state endpoints. Device registration, original content access, private reading profiles and device recovery archives keep their existing authentication and data.

Both `GET /api/v1/user-state/current` and `POST /api/v1/user-state/current` return `{version:2,workspaceId,epoch,items:[{entity,value}]}`. POST accepts this same shape. A workspace or epoch mismatch returns 409 without discarding client state. Responses use `Cache-Control: no-store`.

GET obtains the initial workspace and current snapshot. A bound client exports its real current SQLite values, POSTs once and applies the returned merged current snapshot. There are no operation IDs, base revisions, per-operation acknowledgements or change-feed pages. A complete POST is validated before one SQLite write transaction. Both request and merged response are limited to 32 MiB and 100,000 items; a response overflow rolls the transaction back and retains the previous readable snapshot. Authentication is checked again after the body arrives.

## Current-value merge

| Kind | Accepted current value | Merge rule |
| --- | --- | --- |
| library | `inLibrary:true`, nullable `addedAt` | Earliest nonnull added time |
| category | Current trimmed name, sort, `deleted:false` | Exact name identity; minimum sort |
| membership | `included:true` | Add the named category relation |
| bookmark | `bookmarked:true` | Add the bookmark |
| reading | Progress, unread and readAt tuple | Later readAt wins the whole tuple; equal times use maximum progress and unread only if both unread |
| resume | Nonnull portable chapter, optional anchor, openedAt | Later openedAt, then later anchor savedAt, then canonical JSON tie-break |
| composition | Valid nonnull v1 composition document | Later document updatedAt owns manual choices; deterministic equal-time tie, with safe exact-source overlay |

Absence, local removal, unbookmarking, category deletion and clearing resume do not delete another device's positive state. Negative membership/library/bookmark/category payloads are rejected. An explicit newer reading timestamp may carry lower progress; an older full snapshot cannot regress it. Reading/open/added times use Unix seconds; scroll-anchor savedAt and composition updatedAt use milliseconds.

Categories use `name-` plus the SHA-256 of the exact trimmed UTF-8 current name. The request's category ID-to-name mapping canonicalizes its memberships. A renamed category is a separate positive name; an old device can retain its old name. Neither unrelated names nor local integer IDs overwrite one another. No permanent alias redirects a reused old category UUID to a new name.

Work identity is plugin ID plus the ASCII-case-folded source novel ID. Names, local row IDs and user-visible chapter numbers are not identities. Work-scoped values require a resolved source ID. Chapters use their stable path scoped to the work; recovered numeric folder placeholders are rejected. Synthetic composed/source paths additionally require an exact composition entry ID. Conflicting synthetic ownership returns 409 without a partial write. Provider paths do not require a device-generated entry UUID.

Shared composition choices retain primary sources, manual order, exclusions, user titles, IDs and storage assignments. Safe overlay retains exact provider facts and default target-provider discoveries. Ambiguous physical storage is rejected. Physical source chapter numbers and user composition order are distinct.

## Additive upgrade and retained data

`user_state_current_meta` and `user_state_current_records` extend the existing database without changing its original schema checksum. The first upgrade imports positive current records from v1 `user_state_records` in the same transaction, normalizing category names and memberships. Original v1 records, operations, changes, category aliases and namespace are retained unchanged and are no longer writable through public v1 routes. Legacy private reading profiles are never imported. Catalog rows, credentials, settings, content files and device backups are retained. There is no reset route or automatic expiry.

## Completed migration reconciliation

`workMigrationReconcileVersion:1` advertises `POST /api/v1/works/:id/migration-reconcile`. Its body is `{legacyOperationId,legacyRequest,current}`: the exact originally completed finalize request plus a new UUID request with fresh snapshots, full chapter decisions and current path-resolved physical numbers. The server verifies the immutable receipt hash and target, exact original source-to-target decisions, complete current source coverage and the existing body/asset preservation fences before retirement. Unknown new source bodies, changed targets or stale numbers cause 409 and leave source data intact. A keep-target/delete-source decision may discard only the exact captured legacy source revision. Copy-source verifies actual current body and stored assets against the target.

A fresh user-reviewed reconciliation may additionally supply `reviewedCurrentState:true`. Automatic clients never send this field. The explicit mode accepts reindexed source IDs and fresh keep-target decisions while retaining the same legacy receipt, source/target identity, current full coverage, selected target inventory and body/asset verification. It does not override prior explicit restoration.

The new lineage carries its new operationId and the exact legacyOperationId. Its source deletion, receipt and lineage commit atomically, and replay uses the new immutable receipt. `?restore=true` alone cannot reactivate a migrated source, including older receipt-only retirements. A deliberate restore supplies `restoreMigrationOperationId` naming the current retirement; it persists revocation and deactivates active lineage. Automatic reconciliation of that legacy operation is thereafter rejected. Existing receipts are not rewritten, and routine uploads cannot undo a user's deliberate restoration or a completed retirement.

## Active migration projection

GET and POST project current positive values through active exact source-to-target lineage, including chains. Library and membership values follow the exact work identity; reading, bookmarks and resume require an exact chapter-decision path. Deleted, unmapped or ambiguous destinations are withheld without guessing a title or chapter number. A source composition is retained internally and never transplanted over the target composition. Resume anchors carry over only with verified copy-source payloads; another selected body clears the old anchor. Successfully mapped current keys converge on the target and use the normal type-specific current-value merge. Original v1 rows remain unchanged. A restored/revoked lineage is not an active projection edge.
