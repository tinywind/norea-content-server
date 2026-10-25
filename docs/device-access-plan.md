# Account-free device access

Historical scope note: the content-only reading-state decision below was extended
on 2026-10-25 by explicit private reading-history exchange. The current capability
is `personalStateSync:true,readingStateVersion:1`; see
[reading-state.md](reading-state.md). Device admission and console separation
remain as described here. The current-format database receives only an additive
reading-state table; it is not reset during this upgrade.

## Approved scope

Remove accounts and cross-device personal reading-state synchronization. New
devices are admitted automatically, as explicitly selected by the operator.
Content journals and manual, periodic, and change-driven sync remain. The current
development format has no backward-compatibility or database upgrade paths.

## Authentication contract

- On first server initialization, create `admin-password.hash` in the server data
  directory with an unpredictable 256-bit hexadecimal login secret. Despite the
  filename, its value is a bearer credential, not a publicly shareable verifier.
  Create exclusively with restrictive permissions; never log or serve the file.
  Existing files are reused and malformed files fail startup without replacement.
- `POST /api/v1/console-sessions` accepts `{password}` and returns `{token}`.
  The token expires after 24 hours and is restricted to administration.
  `DELETE /api/v1/console-sessions/current` revokes that session.
- The app generates a random 32-byte hex device key per server, persists it locally
  outside portable backup data, and never derives it from hardware identifiers.
- `POST /api/v1/devices/register` accepts `{deviceKey,deviceName}` and returns
  `{id,deviceName}`. It is idempotent and admits new keys automatically. The server
  stores only the key hash. Subsequent requests use `Authorization: Bearer <key>`.
  Blocked keys remain blocked on registration retries; clients never silently
  generate replacement keys to bypass that decision.
- `GET /api/v1/admin/devices` returns `{items:[{id,deviceName,createdAt,lastSeenAt,blocked}]}`.
  `PATCH /api/v1/admin/devices/:id` accepts `{blocked:boolean}`.
- Registered devices may upload, soft-delete, and restore content. Only console
  sessions may manage settings, sources, devices, and purge. Anonymous download
  policy remains supported.
- Capabilities advertise `apiVersion:1`, `packageVersion:1`,
  `authentication:'device-key'`, and `personalStateSync:false`. Clients must reject
  incompatible authentication protocols before transferring data.
- `/changes` requires `catalogAfter` and `workAfter`, accepts `waitSeconds`, and
  returns `{catalogCursor,workCursor}`. Account and personal-state endpoints are absent.

## Current data model

The schema contains only device and console credentials, content indexes, and
operational state. Account and personal-state tables do not exist. An incompatible
server database requires a fresh state volume; the app recreates its cache when
the schema checksum changes. Current chapter folders can be indexed again.
Scanning reads current files in place without conversion or rewriting. Reading
positions, bookmarks, read flags, and library membership stay local during sync.

## Implementation and verification

1. Server: replace account authentication and state routes, add persistent device
   registration/blocking and initialization secret, retain catalog-only change
   notifications. Update integration tests for authentication boundaries, restart
   stability, blocked retries, removed endpoints, and incompatible-schema rejection.
2. App: persist device credentials, automatically register during sync, remove
   account UI and all personal-state traffic, retain content scheduling and
   transfer. Update tests for restart persistence, key/server isolation, blocking,
   content-only journal behavior, and preservation of local reading state.
3. Console: replace account login with the installation secret and Accounts with
   Devices; provide block/unblock controls without exposing secrets.
4. Integrate both repositories and update current design/README. Run relevant
   tests, type checks, builds, and local server/browser checks under the existing
   session authorization. Commit and push after the requested archive rescan.
   Temporary artifacts stay in
   `.tmp/`. Do not mutate the original Norea library.
