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
- Local imports wait for the next manual/startup/foreground content sync.
- Server operational limitations are listed in [README.md](../README.md),
  including live backup, quotas, and scheduled trash cleanup.

Local evidence: Norea `.tmp/content-sync-tests.log`,
`.tmp/content-sync-native/rust-suite.log`, and `.tmp/content-sync-smoke/`.
These runtime logs, screenshots, credentials, packages, and databases are ignored
and are not part of either public repository.
