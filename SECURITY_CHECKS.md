# Security verification

These checks use isolated fixture data. They do not migrate an existing database
or deploy the service. The Linux checks use Node.js 24; Windows was not exercised.

Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
and `pnpm audit`. The test suite includes the following boundaries:

| Boundary | Evidence |
| --- | --- |
| Repeated login, registration, and API requests | `test/security-boundaries.test.ts` verifies the route limits, HTTP 429, `Retry-After`, separate client addresses, and rejection of spoofed forwarded addresses. |
| Secret and work-file replacement | The same test replaces a validated pathname with a symlink. Reads must fail closed or retain the originally opened file. Descriptors use `O_NOFOLLOW`, regular-file checks, and inode/device identity before reading. |
| Repository redirects | `test/plugin-registry.test.ts` uses two real HTTP servers. Same-origin redirects preserve the configured Basic credentials; another origin or redirect credentials are rejected before any second-origin request. Redirect loops stop after five hops. |
| Local and private repository indexes | Registry tests preserve explicitly configured local JSON files, loopback HTTP indexes, and embedded Basic credentials. Index entries are parsed and stored; their plugin URLs are not fetched or executed by the server. |
| Storage paths and uploads | `test/chapter-files.test.ts` and `test/works.test.ts` reject traversal paths, unsafe source IDs, invalid cover filenames, undeclared parts, malformed archives, and identity changes without replacing published data. `chapterStoragePath` bounds resolved paths to contents/trash and rejects symlink ancestors; metadata parsing validates source IDs before constructing paths. |
| Metadata changes during indexing | `test/folder-indexer.test.ts` observes reads by file identity for both paths and descriptors. One-time changes retry; repeated changes are skipped without publication or checkpoints. |
| Access policy | Administration and server tests cover private reads, blocked devices, console-only operations, and authorization rechecks after long polling. |

CodeQL findings require their individual data flow to be reviewed. A passing
dependency audit does not establish that source findings are fixed.

The following flows are intentional and have separate boundaries:

- `tokenDigest` hashes randomly generated 256-bit installation secrets, device
  keys, and session tokens. It does not hash user-selected account passwords.
- Anonymous catalog reads are an explicit server policy. Private mode requires
  authentication; supplied device credentials are checked even in anonymous mode.
- Authenticated uploads write validated cover and metadata content to bounded
  storage paths. Receiving file content over HTTP is the upload feature.
- Console repository registration is an operator capability that accepts local
  JSON files and HTTP(S) destinations, including private servers. Remote redirects
  cannot change the selected origin or inject new credentials. Network egress
  policy remains the operator's responsibility.
- Management endpoints return JSON with `application/json`; console HTML is a
  fixed asset with a restrictive Content Security Policy.
- Filesystem mutations in test fixtures occur under private temporary directories
  and deliberately exercise concurrent changes. They are not production handlers.

The default rate limit applies per route and direct client IP. The service does
not trust forwarded headers; reverse-proxy clients therefore share the proxy's
limits. Keep server storage writable only by trusted operators.
