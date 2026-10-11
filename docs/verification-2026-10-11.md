# Initial implementation verification

This report covers the first working server and Norea integration. The complete
product behavior in [design.md](design.md) remains the target; this is not a
declaration that every planned capability is implemented.

## Automated checks

| Check | Result |
| --- | --- |
| Server Node.js integration tests | 16 passed, real SQLite and ZIP archives |
| Server TypeScript check | Passed |
| Norea TypeScript check | Passed |
| Norea Vitest suite | 100 files, 1,178 tests passed |
| Norea Rust library suite | 243 passed, including 10 content-transfer tests |
| Android aarch64 debug APK | Built and installed on the connected S25 |

The Windows Rust test executable required the existing Common Controls v6
application manifest. Tests ran from a copied harness with that manifest. An
unmodified `cargo test` launch failed with `0xc0000139`; it is not reported as a
successful direct test invocation. Rust compilation and the copied harness passed.

The Android toolchain needed explicit NDK Clang include paths for the existing
OpenVPN binding generator. This was a local environment change. Frontend test
output and build logs were kept under the Norea `.tmp/` directory.

## Local server and S25 checks

The server ran on Windows at `127.0.0.1:8080`, with its database and packages in
`.tmp/local-server`. ADB reverse connected the S25 debug app to that address.
The production app was not replaced or cleared. Owned fixture files were stored
under `Documents/Norea-Content-Sync-20261011` on the device.

Verified through the actual app and server:

- Anonymous catalog retrieval and ZIP download of a chapter containing an image.
- Portable media references restored to the reader's local media protocol; the
  image decoded successfully in the reader.
- Existing readable directories retained:
  `contents/content-sync-smoke/Content-sync-smoke-work-owned-smoke-work/1-Offline-chapter-with-image`.
- Login with a provisioned test account and upload of device-local content.
  Editing the owned chapter created another immutable server revision; the
  original default remained selected.
- App reading position uploaded to the server. A server-side position change to
  37 percent subsequently appeared in the device SQLite row after app sync.
- Server shutdown followed by a cold app restart still allowed local reading.
- Simulated interruption between replacement renames: the chapter directory was
  left at its deterministic backup path while the app was stopped. Reopening the
  reader recovered the original directory, body, and image without the server.
- Server deletion propagated as a tombstone. The device chapter stayed downloaded,
  its file remained present, and synchronization did not resurrect the package.
- The app's Restore on server action restored availability without an error.

During testing, a proposed edit to the original schema migration caused a checksum
failure. That edit was removed. The existing migration SQL is unchanged; the new
device sync-cache table is created additively when the existing database opens.
The same device data then opened successfully without clearing it.

## Independent code review

A separate read-only reviewer identified account-initialization retry leakage,
backward-position restoration errors, interrupted replacement recovery, and media
timestamp-dependent revision identities. Each received a regression test and a
fix. The reviewer rechecked those fixes and found no remaining P1/P2 issue in that
scope. This was code review, not independent execution of the device checks.

## Not yet verified or implemented

- Docker execution, a Windows app runtime transfer, large-library load, and
  physical power-loss durability were not tested in this pass.
- Secure persistent app sessions, exact paragraph/PDF locators, cover transfer,
  per-work automatic download policies, app account administration, and client
  Range resume are not implemented.
- Remote state for content without matching local/shared-package metadata is
  retained but cannot yet create the missing work/chapter on its own.
- At this initial checkpoint, local imports waited for manual/startup/foreground
  sync. The incremental-sync pass below replaces that behavior.
- Server operational limitations are listed in [README.md](../README.md),
  including live backup, quotas, and scheduled trash cleanup.

Local evidence: Norea `.tmp/content-sync-tests.log`,
`.tmp/content-sync-native/rust-suite.log`, and `.tmp/content-sync-smoke/`.
These runtime logs, screenshots, credentials, packages, and databases are ignored
and are not part of either public repository.

## Incremental sync and scheduling follow-up

The app now supports Manual only, Periodically, and When changes occur. App
SQLite mutations create durable change records; the server exposes separate
catalog and account-state sequences. Persisted cursors, pending operation IDs,
and deferred incoming state support retries without scanning every chapter.

Automated checks after the final fixes:

| Check | Result |
| --- | --- |
| Server integration tests | 28 passed |
| Server TypeScript check | Passed |
| Norea Vitest suite | 104 files, 1,213 tests passed |
| Norea TypeScript check | Passed during the frontend build |
| Android aarch64 debug APK | Rebuilt and installed without clearing device data |

The Rust library suite above was not rerun for this TypeScript/SQL follow-up.
The Android build compiled the native host. Existing migration SQL was unchanged.

The S25 debug app connected to the local server through ADB reverse. Checks used
only the owned fixture and test account from the initial pass:

- Manual mode recorded a local library deletion without making a sync request.
  The journal survived a process restart; signing in sent the pending mutation.
- A one-minute periodic interval fetched a remote bookmark change on schedule,
  without immediately responding to the server mutation.
- Change-driven mode sent a local library change after the debounce and received
  a remote bookmark change through the change-wait endpoint.
- Personal-state-only sync made no native fingerprint or package-upload calls.
- While reading in the ordinary, non-fullscreen layout, the app uploaded its
  position and retained a remote bookmark change in its durable inbox. Leaving
  the reader applied the bookmark and emptied the inbox.

Device testing exposed two issues before the final build: unchanged download
metadata caused repeated sync, and the reader guard depended on fullscreen
layout. Metadata adoption now updates tracked fields only when their values
change, while actual content saves still record a change. A separate transient
reader-active flag protects both layouts. Regression tests and a repeat device
check passed. A separate read-only reviewer found no remaining blocker in these
fixes or the reviewed retry, cache-reservation, and backup-restore paths.

The final APK also repeated the manual and one-minute periodic checks. The test
app was left in Manual only mode with its interval restored to 15 minutes and
the fixture library membership restored. The production app remained untouched.

Automatic scheduling is foreground-only. Session tokens remain in memory, so
app restarts require signing in for personal state and uploads. Direct external
file edits require the explicit rescan action. Long-running background service
behavior and physical power-loss recovery were not tested.

Evidence is in Norea `.tmp/incremental-sync-smoke/` and
`.tmp/content-sync-smoke/android-build.log`, plus server
`.tmp/local-server/incremental-tests.log`. No commit or push was performed for
this follow-up.

## Administration console and existing-folder ingestion

The console now manages multiple plugin repositories, connected folders, content
revisions, scan jobs, accounts, device sessions, and anonymous read access.
Repository indexes supply source identities; the server does not execute plugin
JavaScript or fetch chapter content from source websites. The local check used
one public repository and a local index of four installed sources with embedded
URL credentials removed. That local index is a snapshot, not a live private
repository connection.

Final automated checks:

| Check | Result |
| --- | --- |
| Server integration tests | 57 passed |
| Server and console TypeScript checks | Passed |
| Console production build | Passed |
| Docker image build | Passed |
| Docker HTTP smoke | Capabilities, console HTML, JavaScript, and CSS returned 200; protected administration API returned 401 |

Tests cover original-file hashes and metadata, database/WAL snapshot isolation,
complete and incomplete media, renamed folder matching, stable revision identity,
source collisions, cancellation, tombstones, authorization, concurrent root
scheduling, filesystem change detection, and abandoned staging cleanup. A separate
read-only code review identified scheduling and root-update races; both were fixed
and rechecked. This was code review, not human review or independent device testing.

The Windows server scanned the existing Norea folder without modifying its files.
The completed job examined 25,668 candidates, registered 1,304 chapters, skipped
24,364 candidates, and reported zero failures. Candidate counts include unsupported
files and directories and are not the number of downloaded chapters.

| Skip reason | Count |
| --- | --- |
| Missing exact chapter identity metadata | 23,824 |
| Incomplete download or media repair required | 92 |
| Media archive inventory mismatch | 1 |
| Package source did not match the registered folder | 5 |
| Unregistered, ambiguous, symbolic, or unfinished source | 17 |
| Unfinished chapter files | 1 |
| Unsupported non-chapter file | 424 |

The 45,511 source files retained their paths, lengths, and modification timestamps.
The original Norea database retained its length and modification timestamp, and no
SQLite WAL/SHM files appeared beside it. This live comparison was a metadata
inventory, not a full-library cryptographic comparison. Fixture tests additionally
compare original hashes. Reading OneDrive files can hydrate them and change cloud
provider metadata; the server performs no source writes. Staging was empty after
the completed job.

HTTP downloads of a body-only chapter and a chapter containing 80 images returned
200. Both ZIP sizes and SHA-256 hashes matched their catalog entries. The latter
ZIP was 24,131,306 bytes. The catalog contains 1,305 chapters including the existing
single test fixture, and approximately 3.7 GB of package data.

Headed browser checks covered login, repository registration, folder connection,
scan results and pagination, content details, accounts, and settings. Desktop and
390-pixel mobile layouts were inspected. The local server remains available at
`http://127.0.0.1:8080/admin/`; the existing folder is left in manual scan mode.

The first scan exposed OneDrive hydration changing source signatures during reads.
A bounded copy retry fixed that case while still rejecting continuously changing
files. After the successful bulk scan, media-manifest serialization was aligned
with the app's stable key ordering and regression-tested. Existing imported ZIPs
remain valid; a later scan can create one canonical revision for affected media
chapters. Existing history was preserved, and another bulk scan was not run.

Evidence is stored under server `.tmp/admin-smoke/`,
`.tmp/admin-all-tests-final.log`, and Norea `.tmp/playwright/`. The Docker smoke
container was removed after checking the final image. This pass changed server
code only and did not rerun S25 app tests. No commit or push was performed.
