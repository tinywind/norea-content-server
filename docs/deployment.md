# Docker publication and tinywind-SER rollout

The content-server release branch follows the app release contract. The current
branch is `0.2`, matching the app's `0.2.0` version. The former `main` branch was
renamed to `0.2`; it is not a second release branch.

## Automatic image publication

[docker-publish.yml](../.github/workflows/docker-publish.yml) runs on pull
requests, pushes to branches, and manual **Run workflow** dispatches. It uses
GitHub-hosted Ubuntu runners, Node.js 24, and pnpm 11.25.0 with a frozen lockfile.
The first job runs type checks, the complete server test suite, and the console
build. It then builds one `linux/amd64` image from the exact Git commit, loads
that image, and starts a disposable container with temporary empty storage.
Smoke checks cover protocol/reading-state capabilities, the console HTML, and
the compiled console JavaScript. Production data is never mounted in CI.

Pull requests only validate. They receive no Docker Hub credential and publish
no image. For a branch push or manual branch run, the tested image is transferred
to a separate publishing job as an artifact. That job verifies the archive hash,
platform, and full source-revision label before authenticating to Docker Hub.
It pushes the same image, without rebuilding it, and verifies that the registry
manifest's image-config digest matches the configuration bytes exported from
the tested image. This also works when the Docker engine represents an image
as an OCI index rather than exposing its configuration digest as the image ID.

All external actions are pinned to full commit SHAs. Workflow token permissions
are limited to `contents: read`, and checkout does not persist credentials.
Buildx caches for pull requests and trusted branch runs have separate scopes.
The workflow has no self-hosted runner and no access to the PC's production data.

Repository configuration:

| Setting | Type | Value or purpose |
| --- | --- | --- |
| `DOCKERHUB_USERNAME` | Actions repository variable | `tinywind0` |
| `DOCKERHUB_TOKEN` | Actions repository secret | Dedicated Docker Hub access token with image Read & Write access |

The token is only passed to the Docker login action in the publishing job. Do
not put it in YAML, build arguments, Docker layers, logs, or Git. Rotate it in
Docker Hub and replace the repository secret when needed; no source change is
required to rotate it.

## Tag policy and source identity

A successful publication produces exactly the two requested tags:

```text
tinywind0/norea-content-server:<committed-branch-name>
tinywind0/norea-content-server:latest
```

For the current branch these are `:0.2` and `:latest`. A future `0.3` branch uses
`:0.3` automatically. Branch names must already be valid Docker tags: 1–128
ASCII letters, digits, underscores, periods, or hyphens, beginning with a letter,
digit, or underscore. The branch name `latest` is reserved. A name containing
`/`, for example, fails publication validation rather than being silently
rewritten into a potentially colliding tag. Pull requests may still use such
branch names because they do not publish.

`latest` means the last successful publication across branches. It does not mean
the numerically highest version. Match the app's contract to the version branch
and pin deployments to the verified digest when selecting a specific build.
The workflow does not create additional SHA tags. It records the full commit in
the OCI revision label and reports the immutable registry digest in the run's
job summary. These provide commit/digest traceability; the workflow does not
claim to produce a formal build attestation.

Publishing jobs are serialized with a pending-job queue, so another branch's
successful validation does not replace the one waiting to publish. Each job checks the current head of its source
branch immediately before publishing and again before updating `latest`.
An outdated run skips publication instead of replacing newer branch results.
If the branch advances after its version tag has been pushed, that run leaves
`latest` alone and reports the skipped promotion.

## Completing a server change

1. Commit and push the tested source on its version branch.
2. Wait for the GitHub Actions run for that exact commit. Read the publication
   summary and record its branch tag, full source commit, and `sha256` digest.
   A failed validation, failed publication, or stale-run skip is not a release.
3. Recreate the tinywind-SER container from the published digest, preserving its
   existing deployment configuration and data, then perform the checks below.

The push starts image publication automatically. Do not build and push a second
local image for the same commit. Publication alone does not update the running
PC container, and **docker restart alone does not switch its image**.

To rerun after a transient failure, use **Re-run failed jobs** while the tested
image artifact is retained. Artifacts expire after three days; after expiration,
start a fresh manual run on the intended branch so it validates and builds again.
If a branch has advanced, dispatch its current commit rather than repeatedly
rerunning an obsolete commit. A credentials failure requires fixing the Actions
variable/secret, not printing the token or adding it to a command.

## Rollout on tinywind-SER

Use the existing content-server deployment definition. Before replacement,
record the current container's image/digest, port mappings, environment, mounts,
network, restart policy, and relevant data counts. Keep any full configuration
snapshot private because environment values may contain credentials. Preserve
the existing data volume, content bind mount, and installation password.

Before a database-changing release, take a consistent SQLite backup through the
backup API and validate it with `PRAGMA integrity_check`,
`PRAGMA foreign_key_check`, the original schema checksum, and representative
catalog/device/settings records. Copying a live `metadata.sqlite` alone misses
possible WAL transactions. A full database-plus-content backup requires stopping
or pausing writes and cleanup while copying all relevant mounts. Keep the
previous published image digest and a validated backup available for rollback.

Pull the exact digest from the successful workflow summary:

```bash
release_image='tinywind0/norea-content-server@sha256:<published-digest>'
docker pull "$release_image"
docker image inspect "$release_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

The revision must equal the successful run's full source commit. Set that digest
as the image in the existing deployment definition and recreate the container.
For an existing Compose deployment, use its existing files and service name
with `up -d --no-build --force-recreate`; an image-only override can pin the
digest while retaining its other configuration. Do not run `down -v`, replace
the persistent mounts, regenerate the password, or rebuild during this step.

Verify the running container's image ID equals `docker image inspect` for the
pulled digest. Using the deployment's actual mapped port, verify:

- The server is running and `/api/v1/capabilities` responds with the expected
  API/package version and `readingStateVersion: 1`.
- `/admin/` and `/admin/admin.js` load, and the affected authenticated API works.
- The existing catalog, registered devices, administrator settings, installation
  password, and representative original content remain available.
- For a reading-state change, the app can exchange its private records and an
  unauthenticated reading-state request remains rejected.

Report the source commit, published branch tag and digest, running digest, and
verification outcome. A healthy old container is not evidence that a new image
was deployed; compare the IDs and revision explicitly.

## Rollback

If the new image fails health or functional verification, select the previously
recorded published digest in the same deployment definition and recreate the
container with its existing mounts/configuration. Recheck health, revision, and
existing records. For the additive reading-state table, reverting the image
does not require deleting that table or resetting the existing database.

If database restoration is actually necessary, stop the server first, preserve
the failed state for diagnosis, and restore the validated consistent backup
together with any content snapshot it requires. Account for records written
since the snapshot before restoring it. Never discard the live data merely to
make an older image start.
