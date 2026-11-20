# Security Policy

## Supported Versions

Security fixes are applied to the active `0.2` release line and published in the
latest `linux/amd64` Docker image (`tinywind0/norea-content-server:0.2` /
`tinywind0/norea-content-server:latest`).

| Version / Channel | Supported |
| --- | --- |
| `0.2` (latest published Docker image / `0.2` branch) | Yes |
| Older `0.2` commits or image digests | No — update to the latest published image first |
| `< 0.2` or legacy `main` | No |

Supported runtimes are the published Docker image and Node.js 24+.

## Reporting a Vulnerability

Please report suspected security vulnerabilities privately through GitHub
Private Vulnerability Reporting:

- https://github.com/tinywind/norea-content-server/security/advisories/new

Do **not** open a public GitHub issue, pull request, or discussion for an
undisclosed vulnerability.

When submitting a report, include as much of the following as you can:

- Deployment details (Docker image digest or commit SHA, Node.js version,
  reverse-proxy setup, and relevant configuration such as
  `NOREA_ANONYMOUS_READ`).
- Affected component (for example: HTTP API endpoints, device registration or
  authentication, administration console or console sessions, work/chapter
  storage path validation and uploads, folder indexing, plugin repository
  registry fetching, shared user-state or reading-state sync, device backups, or
  rate limiting).
- Minimal reproduction steps or proof of concept.
- Expected security impact.

**Do not attach real secrets** such as `admin-password.hash`, device keys,
console session tokens, private plugin repository credentials, SQLite databases
containing personal user state, or personal device backup archives.

## Scope

### In scope

Issues in Norea Content Server (`tinywind/norea-content-server`), including:

- Authentication, authorization, and access-policy enforcement (private mode
  when `NOREA_ANONYMOUS_READ=false`, blocked device rejection, console-only
  administrative operations, session expiration, and authorization rechecks
  across long-polling requests).
- Filesystem and storage boundaries (path traversal, unsafe source IDs or cover
  filenames, symlink substitution and descriptor validation, malformed chapter
  or backup archives, and atomic publication guarantees).
- Request, upload, indexing, and rate-limiting protections (direct client IP
  rate limits, rejection of spoofed forwarded headers, multipart/stream limits,
  and concurrent metadata-change safety).
- Plugin repository index handling (same-origin redirect rules, credential
  isolation across origins, redirect-hop limits, and ensuring plugin URLs are
  not fetched or executed by the server).
- Administration console security (CSP, JSON content types, and session
  handling).
- Dependency and container image vulnerabilities affecting shipped `0.2` builds.

### Reported elsewhere

- **Norea client application** (Windows/Android app, WebView isolation,
  `norea-media`, local/SAF storage, VPN routing, reader sanitization): report in
  [tinywind/norea](https://github.com/tinywind/norea/security).
- **Source plugins and plugin catalogs**: report plugin-specific issues in
  [tinywind/norea-plugins](https://github.com/tinywind/norea-plugins/security)
  or the third-party plugin repository that publishes the plugin.

### Out of scope

- Intentional operator-configured policies documented in
  [README.md](https://github.com/tinywind/norea-content-server/blob/0.2/README.md)
  and
  [SECURITY_CHECKS.md](https://github.com/tinywind/norea-content-server/blob/0.2/SECURITY_CHECKS.md)
  (for example: anonymous catalog reads when `NOREA_ANONYMOUS_READ=true`,
  permissive automatic device registration on exposed networks, operator-chosen
  local or private plugin repository indexes, or shared rate-limit buckets when
  deployed behind a reverse proxy).
- Missing TLS when exposed directly without a TLS reverse proxy, or compromises
  where untrusted users already have write access to server storage or
  `admin-password.hash`.
- Attacks requiring local host root or administrator access.
- Automated scanner findings without a demonstrated impact in Norea Content
  Server (see
  [SECURITY_CHECKS.md](https://github.com/tinywind/norea-content-server/blob/0.2/SECURITY_CHECKS.md)
  for documented intentional flows and verification boundaries).

## Response and Disclosure

Norea Content Server is maintained on a best-effort basis:

- **Acknowledgement**: we aim to respond within 7 days in the private advisory
  thread.
- **Remediation**: confirmed vulnerabilities are prioritized by severity and
  fixed on the `0.2` branch, followed by a validated Docker image publication.
- **Disclosure**: please allow reasonable time for a fix and updated image
  before public disclosure. Once resolved, a GitHub Security Advisory may be
  published, with credit if you would like to be acknowledged.

## Security Maintenance

Repository-specific security verification boundaries and intentional data-flow
notes are maintained in
[SECURITY_CHECKS.md](https://github.com/tinywind/norea-content-server/blob/0.2/SECURITY_CHECKS.md).
