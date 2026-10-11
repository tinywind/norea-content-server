# Legacy folder import verification

This pass replaces the missing-address rejection recorded in
[the earlier verification](verification-2026-10-12.md). Complete legacy chapters
can now be registered using Norea's existing `<number>-<title>` folder rule.
The number identifies the chapter inside its work; subsequent hyphens remain in
the title. Retained database or file identities take precedence. A recovered
`norea-folder:` identity does not claim to reconstruct an original site URL.

## Automated checks

- Server suite: 81 tests passed, with no failures or skipped tests.
- Server and console TypeScript checks passed.
- Console build and Docker image build passed.
- Norea native tests: 248 passed, including a shortened-lifetime reproduction
  and a regression for transaction continuity across IPC calls. The local
  Windows test executable needed the existing Common Controls manifest applied
  to an untracked copy before execution; direct Cargo test execution hit a
  Windows loader error. No test code was changed by that workaround.
- The Norea Android aarch64 debug APK rebuilt successfully, including the
  frontend TypeScript check, and installed on the S25 without clearing data.
- The app pre-commit hook passed TypeScript checking and all 1,236 tests in
  109 files. The hook ran normally after providing a local shell launcher for
  the installed pnpm executable.
- Regression coverage includes numeric ordering, title hyphens, repeated scans,
  retained identities, a database connected after folder recovery, normalized
  source folders, malformed cover metadata, empty covers, bounded concurrency,
  and cancellation cleanup.
- A separate agent reviewed the importer changes. Its findings were addressed;
  the final focused review confirmed that lazy stream creation closes the
  cancellation error-handler gap. This was static review, not human review.

## Deployment and full scan

The existing `norea-content-server` container runs the rebuilt
`norea-content-server:local-metadata-v1` image on port 8080. Both the original
Norea folder and the optional app database directory remain read-only bind
mounts. Server-owned metadata and packages use the existing data volume.
The importer reads local files without contacting source sites or plugins.

Job `159bc357-71f0-4f9f-99a3-04ad232901bf` completed in approximately 46 minutes.
It inspected 40,737 items: 23,688 registered, 2,868 unchanged, 14,181 skipped,
and zero failed. Registered entries comprise 257 works and 23,431 chapters;
unchanged entries comprise 51 works and 2,817 chapters. Earlier verification
scans had already registered some content. The final server catalog contains
309 works, 264 covers, and 26,249 chapter packages, including existing content.

| Remaining skip reason | Count |
| --- | ---: |
| External or missing chapter assets | 6,521 |
| Missing current body or unsupported legacy format | 5,798 |
| Media still represented by remote addresses | 1,791 |
| Incomplete download or media repair flag | 25 |
| Incomplete or unsupported media manifest | 21 |
| Unfinished chapter files | 8 |
| Ambiguous chapter number | 6 |
| Package source identity mismatch | 5 |
| Archive inventory mismatch | 3 |
| Source snapshot changed during inspection | 2 |
| Missing media referenced by the body | 1 |

The three originally reported chapter folders numbered 364, 365, and 366 have
only `content.html` and `manifest.json`, with 80, 84, and 84 remote media assets
respectively. Their folder identities are recoverable, but their images are
absent. They now report undownloaded media instead of missing chapter identity.

The before/after source inventories contain the same 45,511 files with identical
paths, lengths, and modification timestamps. The original app database also
retains its size and modification timestamp, with no WAL or SHM created beside
it. This comparison is not a full-library hash audit. The server staging
directory is empty after completion. Runtime importer and console source hashes
match the checked-out files.

## S25 verification

The Norea debug app on the connected S25 Edge was exercised through its actual
WebView UI and native storage operations.

- Manual synchronization discovered recovered legacy works.
- A six-chapter text work retained chapter number `0` and its hyphenated title.
  Its first chapter and cover were downloaded through the app. The downloaded
  body (2,759 bytes) and cover (17,214 bytes) matched the original file hashes.
- A three-chapter image work retained chapter number `1`. Its first chapter
  downloaded and rendered local images. The downloaded cover (92,512 bytes)
  matched the original file hash.
- Both representative works displayed their covers in the library and opened
  offline after the server connection was removed.
- After a cold app restart without server access, library covers still decoded
  successfully. The test connection was restored afterward.

These are representative text/image synchronization and persistence checks,
not a claim that every imported chapter was downloaded or visually inspected.
Device test files reside in a separate test folder; original PC content was
not used as a download destination.

An additional large-catalog sync exposed `cannot commit - no transaction is
active` after extended app use. Norea's single-connection SQL pool still used
the default connection lifetime and idle expiry, although frontend transactions
span separate IPC calls. The app now disables both automatic expiry timers.
The shortened-lifetime native test reproduces the same error; the configured
pool passes the transaction regression. A separate static review found no
remaining issue in this focused native change. No database schema changed.

After installing the corrected APK, existing library covers still decoded and
manual sync resumed without an immediate error. The additional full-catalog
device sync is slow and was still running when this report was recorded; its
completion is not included in the representative download checks above.

## Evidence scope

Local logs and scan snapshots are under server `.tmp/folder-import/`. Device
hash comparisons and screenshots are under app `.tmp/folder-import/`. They are
untracked and are not part of the public repository.
