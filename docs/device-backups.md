# Full device backup protocol, version 1

The app's previous reading-history exchange is replaced in its data settings UI
by an explicit full-device backup and restore. The server advertises
`deviceBackupVersion: 1` without changing API/package version 1 or the server
SQLite schema. Older `/reading-state/read` and `/reading-state/merge` clients
continue working unchanged.

## Contents and identity

The app produces an archive containing `manifest.json`, a consistent `norea.db`
snapshot, and its VPN profile file when present. The database includes installed
plugin source code and repository URLs, categories, library membership, progress,
work/chapter metadata and the app's persisted settings. The manifest carries
format/version/device name/creation time and settings that live outside SQLite.
Downloaded chapter bodies, images and cover files are excluded. The restoring
app validates its own archive format and database before replacing local data;
the server treats the archive as opaque bytes and does not execute or extract it.

The device's display name supplies the default backup slot. Clients URL-encode
that name. The server trims surrounding whitespace, permits 1–200 characters
without control characters, and hashes the name for filesystem paths. Two devices
using the same name intentionally share one latest backup slot. All registered,
unblocked devices can see all stored names and restore any of them; there is no
private sync-key filter. Existing automatic device admission still applies.

## Requests

- `GET /api/v1/device-backups` returns `items`, each with `deviceName`, `updatedAt`
  (milliseconds since Unix epoch), `size` (bytes), and `sha256` (lowercase hex).
- `PUT /api/v1/device-backups/:name` requires `application/octet-stream` and
  `X-Backup-Sha256`. The nonempty body is limited to 512 MiB and 120 seconds.
  Response 200 is the saved metadata. Hash/length/name failures return 400,
  excessive size 413, wrong content type 415, and upload timeout 408 when the
  connection remains writable. Disconnected clients cannot receive an error body.
- `GET /api/v1/device-backups/:name?sha256=<listed hash>` returns exact bytes with
  `Content-Length`, `X-Backup-Sha256`, and a digest ETag. A stale hash returns 409,
  an unknown name 404, and missing/incomplete stored bytes 410. Clients should
  refresh the list after 409 and verify the full download's digest before restore.

Every endpoint authenticates a registered, unblocked device bearer key and sends
`Cache-Control: no-store`. Console tokens do not grant these device APIs access.
Upload authorization is checked again immediately before publication so a device
blocked during transfer cannot publish the result. A completed transfer to a
valid device remains valid if that device is blocked after completion.

## Persistence and atomicity

The server keeps `device-backups/` inside its existing data directory:

- `staging/`: unique temporary upload and pointer files, removed after ordinary
  success, rejection, timeout or interruption.
- `blobs/`: immutable archive revisions, with hashed names and unique IDs.
- `slots/`: one small JSON pointer per hashed device name. The pointer carries the
  public metadata and the immutable revision's filename identity.

Uploads stream to a private file while accumulating their SHA-256. After complete
validation, the file is fsynced and renamed into the blob directory. A separately
fsynced metadata pointer is atomically renamed over the device's old pointer;
only then is its former blob removed. This publishes metadata and bytes together.
Concurrent same-name uploads serialize at publication; the last one to finish
publication becomes current. Download handlers open a validated file descriptor
under the same short slot lock, so an in-flight download can finish from its
original bytes even if a later upload replaces the name. Symbolic archive and
pointer files are not followed. No archive data is loaded fully into server RAM.

One process must own a data directory, as for the existing content server. A
machine/process crash can leave an unreferenced blob or staging file; these are
never returned by list/download. Preserve them during recovery until their
referencing slots have been inspected. No schema migration, catalog rewrite,
password reset, content cleanup, or volume replacement is needed for this feature.

## Release verification

Run the full server test suite, type checks and web build. The focused test file
`test/device-backups.test.ts` covers authenticated shared listing/restore,
large-body streaming, restart persistence, same-name replacement, stale requests,
invalid uploads, interruption/timeout/size limits, permission revocation during
transfer, concurrent reads, original data preservation and symlink rejection.

Follow `docs/deployment.md` to publish the exact tested commit and deploy its
verified registry digest while retaining all existing mounts and configuration.
Check `deviceBackupVersion: 1`, unauthenticated rejection, and a disposable
registered-device upload/list/download against the deployed service. Confirm the
existing catalog, settings, installation password and content remain available.
