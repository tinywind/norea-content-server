# Account-free device access

## Approved scope

Remove accounts and cross-device personal reading-state synchronization. New
devices are admitted automatically, as explicitly selected by the operator.
Existing chapter packages, revisions, source folders, and local reading data are
preserved. Content journals and manual, periodic, and change-driven sync remain.

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
  sessions may manage settings, sources, folders, devices, purge, or select the
  default revision. Existing anonymous download policy remains supported.
- Capabilities advertise `apiVersion:1`, `packageVersion:1`,
  `authentication:'device-key'`, and `personalStateSync:false`. Clients must reject
  incompatible authentication protocols before transferring data.
- `/changes` accepts only `catalogAfter` and `waitSeconds`, and returns
  `{catalogCursor}`. Account, old session, and personal-state endpoints are removed.

## Data preservation

New databases have no account or personal-state tables. Existing legacy tables
are retained inertly to avoid deleting previously stored information during an
automatic startup migration; no live endpoint reads or writes them. Existing
account sessions cannot authorize requests. Device and console sessions use new
tables. Original Norea folders and databases remain read-only importer inputs.
App reading positions, bookmarks, read flags, and library membership stay local.
Existing app schema migrations are not rewritten. Local cache/journal evolution
must not reset local reader data or re-upload unchanged packages unnecessarily.

## Implementation and verification

1. Server: replace account authentication and state routes, add persistent device
   registration/blocking and initialization secret, retain catalog-only change
   notifications. Update integration tests for authentication boundaries, restart
   stability, blocked retries, removed endpoints, and legacy-data preservation.
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
