# Offline Development Snapshot Inventory

This runbook is the Phase 1C.1B boundary for applying the accepted Phase 1C.0
classifier to a manually approved development backup. It does not authorize creating
a backup, accessing the persistent development database, or running a real inventory.

## Separation of duties

Source preparation and offline analysis are separate approvals. Source preparation is
run from the repository root against the checked-in `docker-compose.yml`; it ends after
creating a custom-format archive and provenance manifest outside Git. Offline analysis
starts from those two files and has no reason to connect to the source container.

The offline command does not load dotenv and refuses to run when `DATABASE_URL` or
`NODE_ENV` is present. It receives a target URL only as an explicit CLI argument. The
fixed Compose project is `ai-trader-snapshot-inventory`; its PostgreSQL 16 volume is
new and labeled disposable, no application service exists, its network is internal,
and PostgreSQL is exposed only on `127.0.0.1:55432` for the approved local operator.
Never add application, worker, tunnel, broker, or provider credentials to this file.

## Separately approved source preflight and backup

Do not perform these steps until the owner separately approves backup creation.

1. Stop every local backend, worker, tunnel, and research process. Confirm the Docker
   context is exactly `default` with `docker context show`.
2. Save `docker compose -f docker-compose.yml config` and SHA-256 hash that rendered
   configuration. Confirm it defines only service `postgres`, container
   `ai-trader-postgres`, image `postgres:16`, database `ai_trader`, user `trader`, and
   the volume destination `/var/lib/postgresql/data`.
3. Inspect the running container by Compose labels, not by name alone. Require
   `com.docker.compose.project.working_dir` to equal this repository,
   `com.docker.compose.service=postgres`, and the rendered Compose config hash to match
   the reviewed file. Record the full container ID, image digest, and exact source
   volume name. Inspect its mounts and require exactly that volume at the data path.
4. Inside that exact container run read-only identity queries for
   `current_database()`, `current_user`, `server_version_num`, and
   `pg_control_system().system_identifier`. Require `ai_trader`, `trader`, and major
   version 16. A filename, `DATABASE_URL`, database contents, or an environment value
   is never source proof.
5. List all running containers and processes. Stop if any production Compose label,
   production database container, ngrok/cloudflared/SSH tunnel, or unreviewed database
   proxy is present. Record affirmative `productionContainersAbsent` and
   `tunnelsAbsent` checks.
6. Only after a second owner confirmation, create a PostgreSQL custom archive with
   `pg_dump` inside that verified container as described by
   `docs/development/local-database-backup.md`. Write outside Git with owner-only ACLs.
   Do not use a host PostgreSQL client and do not restore anything at this stage.
7. Validate the archive with `pg_restore --list` using the same PostgreSQL 16 image.
   Record UTC timestamp, exact byte count, SHA-256, archive basename, and all verified
   source values in a manifest with `schemaVersion` set to
   `AI_TRADER_DEVELOPMENT_BACKUP_V1`. Add approval fields `approvedBy`, `approvedAt`,
   and purpose `POSITION_LIFECYCLE_EVIDENCE_INVENTORY`. Review and approve the archive
   and manifest as one immutable pair.

The manifest shape is enforced by
`src/services/position-lifecycle-offline-snapshot.service.ts`. Backups can contain
encrypted credentials, tokens, configuration, and broker history. Store them only in
the owner-approved encrypted location; do not commit, upload, email, or attach them.

## Offline restore and inventory (later approval)

Use a clean shell with application and broker variables removed. Substitute only the
owner-approved absolute archive, manifest, target-identity, and report paths.

```powershell
docker compose -f docker-compose.snapshot-inventory.yml up -d --wait postgres
docker compose -f docker-compose.snapshot-inventory.yml exec -T postgres dropdb -U snapshot_admin --if-exists ai_trader_snapshot_inventory
docker compose -f docker-compose.snapshot-inventory.yml exec -T postgres createdb -U snapshot_admin ai_trader_snapshot_inventory
docker compose -f docker-compose.snapshot-inventory.yml cp C:\approved\snapshot.dump postgres:/tmp/approved-snapshot.dump
docker compose -f docker-compose.snapshot-inventory.yml exec -T postgres pg_restore -U snapshot_admin -d ai_trader_snapshot_inventory --no-owner --no-privileges --exit-on-error /tmp/approved-snapshot.dump
docker compose -f docker-compose.snapshot-inventory.yml exec -T postgres rm /tmp/approved-snapshot.dump
```

Verify `current_database`, server address/port, PostgreSQL major, database system
identifier, Compose project/service labels, and disposable volume label. Create a
small owner-only target identity JSON containing exactly `database`, `host`, `port`,
and `sessionUser`. Create a dedicated LOGIN reader in the disposable database only,
set role-level `default_transaction_read_only=on`, grant CONNECT/USAGE/SELECT only,
and remove every other membership and privilege. The Phase 1C.0 verifier rejects the
reader if it can escalate or mutate. The URL below uses that disposable reader.

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
npm.cmd run lifecycle:evidence-inventory:offline -- `
  --manifest=C:\approved\snapshot.manifest.json `
  --dump=C:\approved\snapshot.dump `
  --target-identity=C:\approved\target-identity.json `
  --target-url=postgresql://snapshot_reader:<one-time-password>@127.0.0.1:55432/ai_trader_snapshot_inventory `
  --output=C:\approved\reports\position-lifecycle-inventory.json `
  --timeout-ms=30000 --max-positions=10000 --max-output-bytes=52428800
```

The classifier runs in one `REPEATABLE READ READ ONLY` transaction with local
statement and idle-transaction timeouts. It imports no mutation or broker service.
External identifiers use a fresh per-run HMAC-SHA-256 key that is never persisted.
The report keeps source provenance and target identity in separate objects. Output
must be an absolute `.json` path outside Git, is created with exclusive owner-only
permissions through an incomplete temporary file, and is atomically renamed only on
success. Row or byte limits, cancellation, timeout, identity mismatch, or any error
leave no incomplete report.

## Cleanup

First copy the completed report to its approved encrypted retention location. Treat it
as sensitive and delete it at the end of the approved review period. Then run the
following fixed command from this repository; do not substitute a project name or
derive a deletion target from an environment variable.

```powershell
docker compose -p ai-trader-snapshot-inventory -f docker-compose.snapshot-inventory.yml down --volumes --remove-orphans
docker volume ls --filter label=ai-trader-purpose=disposable-snapshot-inventory
```

The second command must return no volume for this project. Cleanup deletes only the
fixed disposable Compose project and its labeled volume. It never addresses
`postgres_data`, `ai-trader-postgres`, or `ai_trader`.

## Approval gates

Separate owner approval is required for: (1) stopping writers and inspecting the
persistent development container, (2) creating the source backup, (3) accepting its
manifest/checksum for analysis, (4) starting the disposable restore, (5) running the
real inventory, and (6) deleting the archive/report at the retention deadline. This
checkpoint grants none of those approvals.

Remaining limitations: Docker/host administrators can bypass container isolation;
Windows ACL inheritance must be reviewed on the chosen output directory; a logical
backup necessarily includes sensitive non-inventory tables; and this initial workflow
uses a loopback TCP connection rather than a mutually authenticated local socket.
