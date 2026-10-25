# Content server completion requirements

The user has authorized the complete publish-and-deploy workflow. Whenever this
content server changes, finish the following steps before reporting completion:

1. Implement the change and pass the relevant tests, type checks, and build.
2. Commit and push the tested source changes to the repository.
3. Build the Docker image from that exact committed source and publish it to the
   existing Docker Hub repository using the deployment's established tags.
4. Pull the published image on `tinywind-SER`, then recreate/restart the content
   server container from that image. Preserve the existing persistent volumes,
   content mounts, installation password, environment/settings, ports, network,
   and restart policy. Inspect the actual deployment configuration first.
5. Verify the running image matches the published image digest, the service is
   healthy, the changed APIs behave correctly, and existing catalog data,
   credentials, settings, and original content remain available.

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
