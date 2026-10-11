# Account-free device access verification

This pass replaces account authentication and personal-state synchronization with
an installation secret for the console and automatically admitted device keys.
The accepted contract is in [device-access-plan.md](device-access-plan.md).
Earlier verification reports describe the previous account-based prototype.

## Automated checks

| Check | Result |
| --- | --- |
| Server integration tests | 49 passed |
| App Vitest suite | 105 files, 1,202 tests passed |
| Focused app checks | 59 tests across 9 files passed |
| Server and console TypeScript checks | Passed |
| App TypeScript check | Passed, including the Android frontend build |
| Console build | Passed |
| Android aarch64 debug APK | Built and installed over the existing debug app without clearing data |
| Docker build and HTTP smoke | Passed |
| Working-tree whitespace checks | Passed in both repositories |

The native Rust code was unchanged. The Android build compiled it with existing
warnings; the Rust unit suite was not rerun. Tests for removed personal-state
features were replaced by device-access and local-state preservation checks, so
test totals differ from the previous report.

Server regressions cover persistent installation secrets, malformed files,
console expiry, credential separation, automatic idempotent device registration,
hash-only device credential storage, block/unblock, legacy-data preservation,
removed endpoints, and authorization checks after long polling. Existing package,
importer, plugin-registry, cancellation, and original-file checks remain active.

App regressions cover random keys persisted before registration, concurrent
initialization, server isolation, restart persistence, rejected registration,
blocked-key retention, backup exclusion, preservation during backup restoration,
content-only journals, local reading-state preservation, and sync scheduling.
Original release migration files were not modified.

## Local server and console

The server was restarted with the existing `.tmp/local-server` directory. Its
1,305 chapter rows and 1,307 revision rows survived unchanged. Legacy account,
session, and state rows remain stored but are inaccessible through the removed
APIs and are never used to authorize requests. The original connected Norea
folder was not scanned or written during this pass.

Seventeen live HTTP assertions passed: installation-secret login, automatic
registration and retry, device/admin separation, block/unblock, removed routes,
existing ZIP checksum, idempotent device upload, data counts, and console logout.
The console was checked in a headed browser with its single secret field and
Devices page; block and unblock confirmations were exercised. A 390-pixel mobile
viewport had no page overflow. Table content remains horizontally scrollable.

The Docker image returned 200 for capabilities and console assets, and 401 for
an unauthenticated device-management request. Its generated installation-secret
file was nonempty with mode 0600. The temporary smoke container was removed.

## S25 app checks

The connected S25 ran the updated `io.github.tinywind.norea.debug` APK. The
production app was not replaced. ADB reverse connected the existing owned test
profile to the loopback server; no user/password was entered.

- First sync registered the device automatically and received all 1,305 catalog
  chapters. Requests contained capabilities, device registration, and catalog
  pages; there were no account or personal-state requests.
- Existing fixture progress, read timestamp, read flag, bookmark, library
  membership, and downloaded status survived the update and synchronization.
- Blocking the registered key produced the blocked-device message. The app kept
  its key. After a process restart and unblock, it reused the same key and resumed
  from its saved catalog cursor without re-uploading unchanged content.
- An owned fixture's progress was temporarily changed to 37 percent, then manually
  synchronized. The content journal stayed at sequence 56; there were no native
  fingerprint/upload calls or personal-state requests. The original fixture
  progress was restored and the full saved reading-state comparison passed.
- Downloading the owned fixture through the new device authentication completed
  through the native ZIP path, preserved its reading metadata, and opened its
  local novel page without an error.

The test app remains in Manual only mode, and its device is unblocked. The local
server remains available at `http://127.0.0.1:8080/admin/`. Its console credential
is stored privately in `.tmp/local-server/admin-password.hash` and was not logged.
Automatic admission intentionally permits someone to register a different key;
blocking an existing key is not a person-level ban.

## Review and evidence

A separate agent performed a read-only review of authorization boundaries,
removed endpoints, key retention, backup exclusion, and local-state preservation.
No additional actionable issue remained in that review. This was code review,
not human review or an independent execution of the device checks.

Evidence is under `.tmp/device-access-smoke/` in each repository and Norea
`.tmp/skill-reports/device-content-sync.md`. The Android build log is at
Norea `.tmp/content-sync-smoke/android-build.log`. No commit or push was performed.
Automatic approval review rejected cleanup of the failed-test temporary directory
`.tmp/invalid-secret-SkrEOW` with `blocked by policy`; that directory remains.

## Plugin-independent archive scanning follow-up

Folder ingestion now derives content identity solely from saved Norea metadata
or a complete package manifest. Plugin registration, installed-plugin records,
enabled status, and current source-site availability are not prerequisites.
Registry management remains available independently of ingestion.

Two regressions failed against the previous implementation because unregistered
folders were excluded. They now pass: raw chapters without an installed-plugin
table and complete ZIPs without a metadata database are registered while network
access is intercepted and verified unused. Additional checks cover multi-source
identities after plugin removal, ZIP/folder identity mismatches, preservation of
source files, and retained server packages after the local source disappears.
The administration route test ingests a real ZIP with an empty plugin registry.

The complete server suite passes 51 tests; server/console type checks and the
console build pass. Incomplete-file validation, immutable publication, and
explicit server tombstones remain enforced. A missing raw chapter identity still
causes a skip; the scanner does not reconstruct source URLs from lossy names.
The local server was restarted with this code. Its existing 1,305 chapters and
1,307 revisions were retained, and the original library was not rescanned.
Evidence: `.tmp/archive-source-red.log` and `.tmp/archive-source-tests.log`.

## Publication checks and original-library rescan

The final app suite passes 1,200 tests across 104 files. Two tests and their
unused reader-activity flag were removed because personal-state synchronization
no longer consumes that flag. Both TypeScript checks, the console build, the app
frontend build, and the Docker image build pass. Vite reports its existing large
chunk warning. The app commit hook also ran TypeScript and the full test suite.
Git Bash needed a temporary launcher for the installed pnpm executable; the hook
was not bypassed. The earlier S25 checks above were not repeated for this cleanup.

Temporary evidence for publication is under `.tmp/rescan-publish/` in both
repositories. Installation secrets, device keys, original content, runtime
databases, and build outputs are excluded from the commits. An exact-value search
confirmed that the local installation secret is absent from tracked and pending
source files in both repositories.

The existing Windows Norea folder was rescanned through the authenticated admin
API. Job `e5fa3e84-d74e-403c-86c9-7714797d9d26` completed in approximately
10 minutes 38 seconds without cancellation or failures. Source-site requests and
plugin registration were not prerequisites. The root remains in manual mode.

| Result | Count |
| --- | --- |
| Scanned entries | 40,956 |
| Newly registered logical chapters | 3 |
| Additional revisions of existing chapters | 65 |
| Unchanged chapters | 1,239 |
| Skipped entries | 39,649 |
| Failed entries | 0 |
| Final server chapters, including the existing test fixture | 1,308 |
| Final server revisions | 1,375 |

The job's `registered: 68` combines three new chapters and 65 additional
revisions. The server started with 1,305 chapters and 1,307 revisions. Existing
revisions and default selections were retained. The broader scan traversed
previously excluded source directories, so its entry count exceeds the earlier
plugin-filtered scan.

| Skip reason | Count |
| --- | --- |
| Missing exact chapter identity metadata | 39,022 |
| Unsupported non-chapter file | 526 |
| Incomplete download or media repair required | 92 |
| Package source did not match its folder | 5 |
| External or missing chapter asset | 1 |
| Media archive inventory mismatch | 1 |
| Non-directory, symbolic, or unfinished source entry | 1 |
| Unfinished chapter files | 1 |

Missing identity metadata does not establish that a file is corrupt. These raw
chapters lack the exact source paths required by the sync contract and cannot be
identified safely from folder names alone.

Before/after inventories contain the same 45,511 original files with unchanged
paths, lengths, and modification timestamps. The original Norea database's
length and modification timestamp are unchanged; no WAL or SHM appeared beside
it. This is a metadata comparison, not a full-library hash audit. OneDrive may
hydrate files during reads. The importer did not write source files, and its
staging directory is empty after completion.

HTTP downloads of a newly registered local chapter, an existing text chapter,
and a chapter with 80 images all returned 200 with matching ZIP sizes and SHA-256
hashes. Evidence is in `result.json`, `preservation.json`, and `downloads.json`
under server `.tmp/rescan-publish/`.

## Published change locations

The following files contain the cumulative changes in this publication. Line
anchors identify the first changed region; removed files link to the prior version.

| Repository | File and line |
| --- | --- |
| norea | [README.md:49](https://github.com/tinywind/norea/blob/main/README.md#L49) |
| norea | [docs/content-sync.md:4](https://github.com/tinywind/norea/blob/main/docs/content-sync.md#L4) |
| norea | [src/components/ContentServerSettings.tsx:2](https://github.com/tinywind/norea/blob/main/src/components/ContentServerSettings.tsx#L2) |
| norea | [src/db/client.test.ts:2](https://github.com/tinywind/norea/blob/main/src/db/client.test.ts#L2) |
| norea | [src/db/client.ts:4](https://github.com/tinywind/norea/blob/main/src/db/client.ts#L4) |
| norea | [src/db/content-sync-journal.ts:1](https://github.com/tinywind/norea/blob/main/src/db/content-sync-journal.ts#L1) |
| norea | [src/db/queries/chapter.ts:874](https://github.com/tinywind/norea/blob/main/src/db/queries/chapter.ts#L874) |
| norea | [src/db/queries/content-sync.test.ts:7](https://github.com/tinywind/norea/blob/main/src/db/queries/content-sync.test.ts#L7) |
| norea | [src/db/queries/content-sync.ts:3](https://github.com/tinywind/norea/blob/main/src/db/queries/content-sync.ts#L3) |
| norea | [src/db/schema.ts:311](https://github.com/tinywind/norea/blob/main/src/db/schema.ts#L311) |
| norea | [src/lib/backup/snapshot.test.ts:19](https://github.com/tinywind/norea/blob/main/src/lib/backup/snapshot.test.ts#L19) |
| norea | [src/lib/backup/snapshot.ts:4](https://github.com/tinywind/norea/blob/main/src/lib/backup/snapshot.ts#L4) |
| norea | [src/lib/content-sync/client.test.ts:15](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/client.test.ts#L15) |
| norea | [src/lib/content-sync/client.ts:3](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/client.ts#L3) |
| norea | [src/lib/content-sync/device.test.ts:1](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/device.test.ts#L1) |
| norea | [src/lib/content-sync/device.ts:1](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/device.ts#L1) |
| norea | [src/lib/content-sync/scheduler.test.ts:1](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/scheduler.test.ts#L1) |
| norea | [src/lib/content-sync/scheduler.ts:1](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/scheduler.ts#L1) |
| norea | [src/lib/content-sync/storage-operation.test.ts:1](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/storage-operation.test.ts#L1) |
| norea | [src/lib/content-sync/storage-operation.ts:1](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/storage-operation.ts#L1) |
| norea | [src/lib/content-sync/sync.test.ts:1](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/sync.test.ts#L1) |
| norea | [src/lib/content-sync/sync.ts:2](https://github.com/tinywind/norea/blob/main/src/lib/content-sync/sync.ts#L2) |
| norea | [src/main.tsx:18](https://github.com/tinywind/norea/blob/main/src/main.tsx#L18) |
| norea | [src/store/content-sync.test.ts:1](https://github.com/tinywind/norea/blob/main/src/store/content-sync.test.ts#L1) |
| norea | [src/store/content-sync.ts:4](https://github.com/tinywind/norea/blob/main/src/store/content-sync.ts#L4) |
| norea | [strings/languages/en/app.json:2](https://github.com/tinywind/norea/blob/main/strings/languages/en/app.json#L2) |
| norea | [strings/languages/ko/app.json:2](https://github.com/tinywind/norea/blob/main/strings/languages/ko/app.json#L2) |
| norea-content-server | [.gitignore:6](https://github.com/tinywind/norea-content-server/blob/main/.gitignore#L6) |
| norea-content-server | [Dockerfile:1](https://github.com/tinywind/norea-content-server/blob/main/Dockerfile#L1) |
| norea-content-server | [README.md:3](https://github.com/tinywind/norea-content-server/blob/main/README.md#L3) |
| norea-content-server | [docs/design.md:7](https://github.com/tinywind/norea-content-server/blob/main/docs/design.md#L7) |
| norea-content-server | [docs/device-access-plan.md:1](https://github.com/tinywind/norea-content-server/blob/main/docs/device-access-plan.md#L1) |
| norea-content-server | [docs/implementation-plan.md:7](https://github.com/tinywind/norea-content-server/blob/main/docs/implementation-plan.md#L7) |
| norea-content-server | [docs/verification-2026-10-11.md:76](https://github.com/tinywind/norea-content-server/blob/main/docs/verification-2026-10-11.md#L76) |
| norea-content-server | [docs/verification-2026-10-12.md:1](https://github.com/tinywind/norea-content-server/blob/main/docs/verification-2026-10-12.md#L1) |
| norea-content-server | [package.json:10](https://github.com/tinywind/norea-content-server/blob/main/package.json#L10) |
| norea-content-server | [pnpm-lock.yaml:29](https://github.com/tinywind/norea-content-server/blob/main/pnpm-lock.yaml#L29) |
| norea-content-server | [src/admin.ts:1 (removed)](https://github.com/tinywind/norea-content-server/blob/5cf112e3f3e16f1d673d62438ea1a1d166d66161/src/admin.ts#L1) |
| norea-content-server | [src/administration.ts:1](https://github.com/tinywind/norea-content-server/blob/main/src/administration.ts#L1) |
| norea-content-server | [src/app.ts:6](https://github.com/tinywind/norea-content-server/blob/main/src/app.ts#L6) |
| norea-content-server | [src/auth.ts:1](https://github.com/tinywind/norea-content-server/blob/main/src/auth.ts#L1) |
| norea-content-server | [src/changes.ts:1](https://github.com/tinywind/norea-content-server/blob/main/src/changes.ts#L1) |
| norea-content-server | [src/db.ts:12](https://github.com/tinywind/norea-content-server/blob/main/src/db.ts#L12) |
| norea-content-server | [src/folder-indexer.ts:1](https://github.com/tinywind/norea-content-server/blob/main/src/folder-indexer.ts#L1) |
| norea-content-server | [src/plugin-registry.ts:1](https://github.com/tinywind/norea-content-server/blob/main/src/plugin-registry.ts#L1) |
| norea-content-server | [src/state.ts:1 (removed)](https://github.com/tinywind/norea-content-server/blob/5cf112e3f3e16f1d673d62438ea1a1d166d66161/src/state.ts#L1) |
| norea-content-server | [test/access.ts:1](https://github.com/tinywind/norea-content-server/blob/main/test/access.ts#L1) |
| norea-content-server | [test/administration.test.ts:1](https://github.com/tinywind/norea-content-server/blob/main/test/administration.test.ts#L1) |
| norea-content-server | [test/device-access.test.ts:1](https://github.com/tinywind/norea-content-server/blob/main/test/device-access.test.ts#L1) |
| norea-content-server | [test/folder-indexer.test.ts:1](https://github.com/tinywind/norea-content-server/blob/main/test/folder-indexer.test.ts#L1) |
| norea-content-server | [test/plugin-registry.test.ts:1](https://github.com/tinywind/norea-content-server/blob/main/test/plugin-registry.test.ts#L1) |
| norea-content-server | [test/server.test.ts:10](https://github.com/tinywind/norea-content-server/blob/main/test/server.test.ts#L10) |
| norea-content-server | [tsconfig.web.json:1](https://github.com/tinywind/norea-content-server/blob/main/tsconfig.web.json#L1) |
| norea-content-server | [web/admin.css:1](https://github.com/tinywind/norea-content-server/blob/main/web/admin.css#L1) |
| norea-content-server | [web/admin.ts:1](https://github.com/tinywind/norea-content-server/blob/main/web/admin.ts#L1) |
| norea-content-server | [web/index.html:1](https://github.com/tinywind/norea-content-server/blob/main/web/index.html#L1) |
