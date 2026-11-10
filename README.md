# Norea Content Server

Norea Content Server is the optional shared content service for Norea. It stores
work metadata, covers, chapter packages, device registrations, backups, and
explicit shared user-state data. Norea remains local-first: reading and local
downloads continue to work when the server is unavailable.

The service is a single Node.js process with SQLite metadata, filesystem package
storage, and a built-in administration console.

## Quick start

Requirements: Node.js 24 and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm build
NOREA_DATA_DIR=data NOREA_PORT=8787 pnpm start
```

The default bind address is `127.0.0.1:8787`. Set `NOREA_HOST` and
`NOREA_PORT` to change it. Use a TLS reverse proxy for external access and run
only one server process against a data directory.

First startup creates `admin-password.hash` in the data directory. Its contents
are the console credential. Treat it as a secret and keep the data directory
private.

## Access model

There are no user accounts.

- Each Norea app creates a random per-server device key and registers
  automatically.
- The server stores only the device-key hash and lets console administrators
  block or unblock registrations.
- Device credentials can synchronize content, backups, and supported private
  state. They never grant console access.
- Console sessions are separate and expire after 24 hours.
- Anonymous catalog browsing and content download are enabled by default and can
  be disabled with `NOREA_ANONYMOUS_READ=false`.

Automatic registration is intentionally permissive: anyone who can reach the
server can register a new device key. Network exposure and TLS remain operator
responsibilities.

## What is synchronized

The server has independent synchronization lanes:

- **Content** — work metadata, covers, chapter packages, availability changes,
  deletions/restores, and chapter-number reconciliation.
- **Shared user changes** — library membership, categories, reading tuples,
  bookmarks, resume state, and chapter compositions using durable revisions and
  idempotent operation receipts.
- **Legacy reading state** — the older explicit reading-state API remains
  available for compatible clients.
- **Device backups** — opaque full-device backup archives are stored by device
  name and SHA-256 digest.

Content synchronization does not require the original source site or plugin when
the server already owns a valid chapter package. The server never executes source
plugins and never receives source cookies.

## API

`GET /api/v1/openapi.json` is the authoritative endpoint/schema reference.
`GET /api/v1/capabilities` reports supported protocol features.

Major endpoint families:

- `/api/v1/devices/*` — device registration and access.
- `/api/v1/catalog/*` — work/chapter browsing and change cursors.
- `/api/v1/works/*` — work metadata, covers, migrations, and reconciliation.
- `/api/v1/chapters/*` — package upload, download, deletion, and restore.
- `/api/v1/user-state/*` — durable shared user-state synchronization.
- `/api/v1/reading-state/*` — legacy explicit reading-history exchange.
- `/api/v1/device-backups/*` — full-device backup archives.
- `/api/v1/admin/*` and `/api/v1/console-sessions/*` — administration.

Large content and backup transfers are streamed and published atomically. Path
validation rejects traversal and symbolic-link substitution.

## Storage

The data directory contains:

- SQLite metadata and journals,
- chapter package directories,
- work metadata and covers,
- device backup archives,
- the console credential.

SQLite is authoritative for catalog/state metadata; package files remain ordinary
filesystem files so operators can inspect and back them up. A successful publish
never exposes an incomplete replacement. Soft-deleted content remains recoverable
until purge/retention policy removes package bytes.

Do not place the server SQLite database inside a directory that an app also scans
as Norea content.

## Administration console

The built-in console is served from `/admin/`. It manages devices, access
policy, plugin repositories, storage scans, works, chapters, and operational
maintenance. It uses the same server process and REST API; there is no separate
frontend service.

## Backup and deployment

Use the supplied Docker/deployment workflow for production. Back up SQLite and
the package/backup directories as one consistent server state before replacing a
deployment. Keep the previous image and data backup until health and functional
checks pass.

See:

- [Deployment](docs/deployment.md)
- [Device backups](docs/device-backups.md)
- [Current architecture](docs/design.md)
- [Shared user state](docs/user-state.md)
- [Reading state](docs/reading-state.md)
- [Work migration](docs/work-migration.md)
- [Chapter-number reconciliation](docs/chapter-number-reconciliation.md)
- [Security checks](SECURITY_CHECKS.md)

## Development

```bash
pnpm tsc
pnpm test
pnpm build
```

Run focused tests while iterating, then the full suite before release changes.
The OpenAPI document, tests, and current topical docs are the contract; historical
implementation plans and one-off verification reports are intentionally not kept
in the repository.
