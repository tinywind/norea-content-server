# Content server completion requirements

The user has authorized the complete publish-and-deploy workflow. Whenever this
content server changes, finish the following steps before reporting completion:

1. Implement the change and pass the relevant tests, type checks, and build.
2. Commit and push the tested source changes to the repository.
3. Wait for `.github/workflows/docker-publish.yml` to validate that exact commit
   and publish its smoke-tested image to Docker Hub. Use the successful run's
   registry digest; do not duplicate the automated build/publication locally.
   A failed, skipped, or still-running publication does not complete this step.
4. Pull the published image on `tinywind-SER`, then recreate/restart the content
   server container from that image. Preserve the existing persistent volumes,
   content mounts, installation password, environment/settings, ports, network,
   and restart policy. Inspect the actual deployment configuration first.
5. Verify the running image matches the published image digest, the service is
   healthy, the changed APIs behave correctly, and existing catalog data,
   credentials, settings, and original content remain available.

Use a server release branch matching the app release contract (currently `0.2`).
Publication uses the exact Docker-compatible branch name and `latest`; it does
not create SHA tags or silently rewrite branch names. `latest` follows the last
successful publication across branches. Prefer the matching version branch and
the verified registry digest when deploying. See `docs/deployment.md` for the
GitHub Actions configuration, rollout checks, and rollback procedure. Image
publication is automated; deployment to `tinywind-SER` remains required and is
not performed by a self-hosted runner.

Before a database-changing deployment, create and validate a consistent backup.
Use SQLite's backup API for a live database; do not copy only `metadata.sqlite`
while WAL writes may be active. A consistent full database-and-files backup
requires pausing writes/cleanup or stopping the server before copying all
persistent state/content mounts and any separately mounted password file.
Validate database integrity and representative existing records in the backup,
and retain the previous image reference for rollback.

Do not delete/reinitialize the live database, remove volumes, or discard existing
data to make an upgrade succeed. Code tests or an unpublished local image alone
do not satisfy this workflow. Report the source commit, published tag/digest,
deployment result, and verification outcome. If a required step is blocked,
state the exact blocker and what remains incomplete.
