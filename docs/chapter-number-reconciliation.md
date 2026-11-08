# Same-work chapter number reconciliation

A source episode ID is an identity, not necessarily its reading ordinal. A source plugin can correct chapter numbers without changing its work identity or source chapter paths. Ordinary chapter upload deliberately preserves an existing directory, and work metadata upload merges chapter keys. Neither operation can safely repair an existing numbered library on its own.

The server advertises `chapterNumberReconciliationVersion: 1` from `GET /api/v1/capabilities`. The app must check that capability before starting a repair. Keep the exact request in a durable client job and hold ordinary upload, pull, and recovered-folder import for the affected work until the server has acknowledged it.

## API contract

Read `GET /api/v1/works/:id/migration-snapshot` first. Use its `work.revision` as `expectedWorkRevision`. Then send an admitted device's bearer credentials to:

```http
POST /api/v1/works/:id/reconcile-chapter-numbers
Content-Type: application/json
```

```json
{
  "operationId": "83d015c2-d1a5-433a-a1c4-301f3dcacaf0",
  "expectedWorkRevision": "<64 lowercase hexadecimal characters>",
  "mappings": [
    { "chapterPath": "/episode/9001", "from": "9001", "to": "1" },
    { "chapterPath": "/episode/9007", "from": "9007", "to": "2" }
  ]
}
```

The response contains `operationId`, the existing `WorkEntry` representation under `work` (including `metadata.identity`), `updatedChapters`, and `updatedReadingStates`. The counters describe applied mappings and reading-state updates; metadata-only mappings count even when no chapter payload is present. Responses are not cacheable.

The operation requires:

- A live registered remote work with the exact source plugin, novel ID, and novel path.
- An unchanged work revision for every newly applied mapping.
- Between 1 and 10,000 mappings, with canonical positive safe-integer strings.
- Unique source numbers, target numbers, and chapter paths. The old and new number sets must be disjoint. Cycles and swaps are rejected.
- An actual source chapter path. A `norea-folder:` or `local-folder:` target is rejected. This API does not infer URLs or refine an earlier target path.
- An exact existing source row, or one unique same-work recovered row whose path is exactly `norea-folder:<from>`. A different actual source path cannot be claimed by number.
- For a metadata-only mapping, an existing old chapter key and no unindexed old folder.
- No target metadata key, declared stored chapter number, registered directory, physical folder, or conflicting registered alias. Deleted and unavailable rows also count when checking identity conflicts.

Conflicts return 409 with the prefix `Chapter number reconciliation conflict: `. Invalid request syntax or a placeholder target returns 400. Anonymous callers, console sessions, and blocked devices cannot perform the operation.

## Stable identity and stale input

For a normal source row, the chapter ID and source path remain unchanged. A recovered folder row keeps its existing chapter ID while its path becomes the explicitly supplied actual source path. A persisted alias records the original path, actual path, old/new numbers, and the committed operation.

Only that validated same-work alias may preserve an ID different from the actual path's ordinary hash. Upload, catalog lookup, folder indexing, and later cross-source work migration all use the same resolver. Unregistered identities retain the original exact hash behavior.

Registered aliases also normalize subsequent stale input:

- Old chapter-number keys in work metadata map to the canonical keys.
- Old or new recovered folder aliases and the registered actual path resolve to the same stable ID.
- Upload metadata receives the canonical number and position.
- A different chapter path cannot claim a reserved old or new number.
- A physical old-number folder is rejected during import, including an identical copy that would otherwise return the current entry early. The server preserves that folder for explicit review.
- Reading-state identities normalize before both sides of a monotonic merge.

Aliases and operation receipts must be included in database backups. Do not remove them after an apparently successful repair; they prevent later devices or copied metadata from restoring obsolete number keys.

## Reading already applied mappings before import

The server also advertises `chapterNumberMappingsVersion: 1`. An updated client that imports an already reconciled work first reads:

```http
GET /api/v1/works/:id/chapter-number-mappings
```

The response is `{ work: { ...WorkEntry, revision }, mappings: [{ chapterPath, from, to }] }`. It includes **every registered mapping**, including chapters represented only in `novel.json` without downloaded payloads. Mappings are ordered by their numeric target ordinal. An unreconciled work returns its current work entry and an empty array.

The work metadata, sequence, revision, committed-operation proof, aliases, and current canonical chapter identities are checked in one database transaction. The revision is exactly the existing migration snapshot fingerprint: SHA-256 of `canonicalize(metadata) + '\n' + (coverBytes ? SHA256(coverBytes) : '')`. It is not the app's local work-cache fingerprint. Responses use `Cache-Control: no-store` and the same anonymous/authenticated read policy as `GET /works/:id`.

Before merging incoming metadata, the client verifies the work identity and complete mapping coverage, then uses its existing durable local reconciliation journal to update local payload directories, chapter rows, and exclusions. It must not create a new server mutation job for mappings already committed remotely. When incoming and local numbering differ, a missing read capability or conflicting mapping proof keeps the incoming import pending instead of inferring ordinal mappings from titles or silently merging different numbering schemes.

This endpoint adds no client-version gate to existing read APIs. Older clients continue to receive canonical server metadata through those APIs.

## Durable storage and recovery

Before touching chapter folders, the server commits a prepared SQLite journal. It contains the original and replacement `novel.json` bytes and hashes, the exact folder moves, and each original directory's device/inode identity.

The server then performs one synchronous transaction:

1. Recheck the work, chapter rows, metadata bytes, and folder identities.
2. Rename each disjoint old directory to its canonical number and sync the parent directory.
3. Replace `novel.json` atomically and sync its bytes and parent directory. Unknown document fields are preserved.
4. Record aliases, chapter metadata/revisions, canonical restoration directories, catalog changes, and work changes. Original payload files are not rewritten.
5. Rekey or merge reading states for every matching profile. Preserve maximum progress, read status, bookmarks, and latest reading time.
6. Revalidate device authorization and commit the durable response receipt with the database changes.

Deleted chapters remain deleted. Their chapter ID, deletion timestamp, and trash payload path survive; their tombstone is retained and their eventual restoration directory uses the new number.

A failure rolls back the database transaction and restores the exact original metadata and folder names from the prepared journal. Startup performs this recovery **before** rebuilding work indexes. Recovery can itself stop and safely resume.

Recovery never overwrites an unexpected folder or independently edited metadata:

- Original inode at the old path with no target: the move did not happen.
- Original inode at the new path with no old path: rename it back.
- Both paths, neither path, a different inode, or an unexpected metadata hash: preserve the journal and fail closed.

A work awaiting unresolved recovery is blocked from ordinary mutation. An operator must inspect the retained journal and external changes rather than deleting the journal or resetting the database. The server's startup error deliberately prevents a partially renamed tree from being indexed as deleted content.

## Retry and multiple devices

Persist and retry the exact operation ID, revision, and mapping body. A committed matching receipt returns the original response. Reusing its ID for another request returns 409.

A second device may use a new operation ID after the same mappings have already committed. If every mapping exactly matches its persisted alias and current work identities, the server returns a successful no-op even when that device holds the previous revision. Conflicting or partly new mappings still require a fresh revision.

After acknowledgment, the client must reconcile its own durable local storage and number-keyed exclusions using the same mapping, then resume ordinary sync. Restart a reading-state pull from offset zero because equivalent old/new rows may have been consolidated.

## Deployment and rollback

This feature adds tables outside the original schema checksum. It preserves existing catalogs, device credentials, settings, and payloads; no database rebuild is required.

Before the first live repair, retain a consistent SQLite backup and a backup of the affected work folders using the deployment procedure. Files from unrelated works do not need to be copied for this operation.

After a reconciliation has committed, an older server binary without alias support cannot safely interpret every preserved recovered chapter ID. A binary-only rollback is therefore insufficient. Retain alias support, or restore the matching pre-repair database and affected work folders together.

A metadata or source connection outage is not grounds to invent missing chapter paths. Works whose actual paths cannot be proven remain unchanged until the source can be read.

## Verification

`test/chapter-number-reconciliation.test.ts` uses isolated synthetic fixtures under ignored `.tmp`. It covers stable real/recovered IDs and bytes, stale uploads/imports, metadata-only rows, target identity conflicts, multiple reading profiles, tombstones/restoration, authentication, exact and cross-device retries, transaction failure, process crashes around every filesystem/database boundary, interrupted recovery, and conflicting external changes. It does not contact source sites or live server data.
