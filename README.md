# Norea Content Server

An optional content and reading-state server for Norea. One Node.js 24 process
stores account metadata in SQLite and complete chapter ZIPs on local disk.
The API and package format are version 1. The Norea integration is under development.

## Run locally

Install Node.js 24 and pnpm, then run `pnpm install --frozen-lockfile`.
The server uses Node's native TypeScript support; no build step is required.

PowerShell:

```powershell
$env:NOREA_DATA_DIR = '.tmp/local-server'
$env:NOREA_PORT = '8080'
pnpm start
```

The default address is `127.0.0.1:8787`. `NOREA_HOST` and `NOREA_PORT` override it.
`NOREA_DATA_DIR` defaults to `data`. Set `NOREA_ANONYMOUS_READ=false` to require
authentication for catalog and package access. External access requires a TLS
reverse proxy. Run exactly one server process against a data directory.

To provision an account or reset its password, supply `NOREA_ACCOUNT_PASSWORD`
through the process environment, then run:

```text
pnpm admin <username> admin
pnpm admin <username> member
```

The CLI uses the same `NOREA_DATA_DIR` as the server. Passwords must contain at
least 12 characters. A reset revokes every session for that account. Clear the
password environment variable afterwards; never put passwords in command arguments,
tracked configuration, or logs. An authenticated administrator can also provision
or reset accounts through `POST /api/v1/accounts`.

## API

`GET /api/v1/openapi.json` serves OpenAPI generated from route schemas.
`GET /api/v1/capabilities` reports supported protocol/package versions and access
policy. See [implementation-plan.md](docs/implementation-plan.md) for the shared
client contract and [design.md](docs/design.md) for the intended product behavior.

- `POST /api/v1/sessions` accepts username, password and deviceName. Send the
  returned token as `Authorization: Bearer <token>`. Sessions expire in 30 days.
- `GET /api/v1/sessions` lists the account's device sessions.
  `DELETE /api/v1/sessions/:id` revokes one, and
  `DELETE /api/v1/sessions/current` signs out the current device.
- `GET /api/v1/chapters?after=0&limit=100` returns ordered catalog changes.
  Apply every entry in order, including repeated chapter IDs and tombstones, and
  save the returned cursor. Follow `hasMore` before considering the catalog current.
- `POST /api/v1/packages` streams an authenticated raw `application/zip` upload.
  Every declared file is checked for size and SHA-256, and undeclared files,
  unsafe paths, duplicates, symlinks, encryption and invalid metadata are rejected.
  HTML resource URLs must be embedded data or declared package files. CSS imports
  and escaped CSS URLs are rejected; nested resource references inside separate
  CSS files and Markdown image syntax are not currently inspected.
  Revision identity is SHA-256 of the RFC 8785 canonical manifest. ZIP checksums
  are separate. Retrying a revision returns its original immutable package record.
- `GET /api/v1/chapters/:id/package` streams the current default. Downloads support
  one byte range, suffix ranges, ETag and If-Range. A mismatching If-Range returns
  the entire package. Verify ZIP bytes before installing content on the client.
- Administrators use `DELETE /api/v1/chapters/:id`,
  `POST /api/v1/chapters/:id/restore`, and
  `POST /api/v1/chapters/:id/revision` to manage shared availability and defaults.
  A newer upload does not automatically replace the first default revision.
- `POST /api/v1/chapters/:id/purge` permanently removes a deleted chapter's ZIPs.
  Tombstones survive purge and restart. Restoration after purge permits a fresh
  upload but keeps the catalog entry deleted until a complete package is published.
- `GET /api/v1/state` and `PUT /api/v1/state` operate only on the authenticated
  account. Repeated operation IDs must carry the exact same mutation. Position and
  read-state conflicts return HTTP 409 with a StateEntry directly, retaining both
  candidates. Resolve against its returned version. Library/bookmark values use
  `{ "deleted": true }` for removal and `false` for addition; concurrent removals
  win, while an addition based on the latest version succeeds.

## Storage and limits

Packages use the Norea readable directory rules:
`contents/<plugin>/<work-name>-<work-path>/<chapter-number>-<chapter-name>/<revision>.zip`.
An identity that collides with another chapter's sanitized directory is rejected.
Each ZIP contains portable body/assets and its manifest. ZIPs stream through a
staging directory and are validated before becoming visible in SQLite.
Interrupted uploads remain absent from the catalog. A deletion during an upload
invalidates its publication even if the chapter is restored before upload finishes.

Default limits are 512 MiB ZIP bytes, 2 GiB expanded bytes, and 10,000 content
files plus `manifest.json`. Manifests are limited to 4 MiB. Tests can supply
smaller limits through `buildApp`. JSON requests are limited to 1 MiB.

Deleting a chapter moves its revisions to `trash/` and immediately blocks new
downloads. Files older than 30 days are purged at server startup. Explicit purge
can remove them earlier. Existing device content and account state remain intact.
Available revisions are never automatically evicted.

For backup, stop the server and copy the entire data directory, including SQLite,
its WAL files, packages, and trash. Restore the complete directory before restart.
This offline procedure gives a consistent database/files snapshot. Live backup,
whole-work administration, work cover transfer, obsolete-revision removal,
automatic scheduled trash cleanup, per-account quotas, and operator metrics are
not implemented. Protect public deployments with proxy-level rate limits and TLS.

## Docker

`docker compose up --build -d` exposes the service at `127.0.0.1:8787` and keeps
data in the `norea-data` volume. Provision through the CLI in the container with
an environment-supplied password. Back up the volume while the service is stopped.
The container build and deployment need separate platform validation.

## Checks

```text
pnpm test
pnpm typecheck
```

Tests use real SQLite databases and ZIP archives under `.tmp/`. They cover access
control, account reset/revocation, persistence, immutable revisions, Range, corrupt
packages, limits, tombstones, causal state conflicts, and a disconnected HTTP upload.
