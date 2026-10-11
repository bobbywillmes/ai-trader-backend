# Local Development Database Backup

This runbook documents the manual PostgreSQL backup process for the AI Trader local development environment.

Use it before database migrations, schema refactors, destructive development experiments, large data changes, or whenever preserving the current local database state would be useful.

## Development environment

| Item | Value |
| --- | --- |
| Docker Compose file | `docker-compose.yml` |
| PostgreSQL service | `postgres` |
| PostgreSQL container | `ai-trader-postgres` |
| PostgreSQL version | 16 |
| Database | `ai_trader` |
| Database user | `trader` |
| Backup format | PostgreSQL custom archive (`.dump`) |
| Recommended backup location | Outside the Git repository |

The local Docker Compose configuration runs PostgreSQL only. The backend and workers normally run separately in the local development environment.

This procedure creates a logical PostgreSQL backup with `pg_dump`. It does not create a Docker volume snapshot.

## 1. Prepare the development environment

Run the backup from Git Bash at the root of the `ai-trader-backend` repository.

Confirm that PostgreSQL is running:

```bash
docker compose ps postgres
```

The `postgres` service should be running and healthy.

### Stop local application processes

If the backend, workers, scripts, experiments, or other processes that write to the development database are running, stop them before creating the backup.

For example, stop a locally running development server with `Ctrl+C`.

Do **not** stop PostgreSQL.

PostgreSQL `pg_dump` creates a transactionally consistent snapshot even while writes are occurring, but stopping application writers produces a cleaner application-level checkpoint and makes the backup easier to reason about later.

## 2. Define the backup filename

Choose a short lower-case reason for the backup.

Example:

```bash
BACKUP_REASON="before_market_policy_migration"
BACKUP_DIR="$HOME/Desktop/AI_Trader/local-db-backups"
BACKUP_NAME="ai_trader_dev_${BACKUP_REASON}_$(date -u +%Y%m%d_%H%M%S_UTC).dump"
BACKUP_FILE="$BACKUP_DIR/$BACKUP_NAME"

mkdir -p "$BACKUP_DIR"

echo "$BACKUP_FILE"
```

The resulting filename will resemble:

```text
ai_trader_dev_before_market_policy_migration_20261011_154500_UTC.dump
```

Backups should remain outside the Git repository.

## 3. Create the database dump

Run `pg_dump` inside the development PostgreSQL container and redirect the archive directly to the local backup directory:

```bash
docker compose exec -T postgres \
  pg_dump \
  --username=trader \
  --dbname=ai_trader \
  --format=custom \
  > "$BACKUP_FILE"
```

The `-T` option disables pseudo-TTY allocation. This is required when redirecting the binary archive to a file.

The custom archive format is preferred because it can be inspected with `pg_restore`, supports selective restoration, and is suitable for restoring the complete database.

## 4. Validate the backup

First, confirm that the archive exists and is not empty:

```bash
test -s "$BACKUP_FILE"
ls -lh "$BACKUP_FILE"
```

If `test -s` exits successfully, inspect the PostgreSQL archive catalog:

```bash
docker compose exec -T postgres \
  pg_restore --list < "$BACKUP_FILE" | sed -n '1,20p'
```

A valid archive will print PostgreSQL archive metadata followed by database objects.

Stop here if either validation command fails.

## 5. Create and verify a checksum

Create a SHA-256 checksum:

```bash
(
  cd "$BACKUP_DIR"
  sha256sum "$BACKUP_NAME" > "$BACKUP_NAME.sha256"
)
```

The backup directory should now contain:

```text
ai_trader_dev_<reason>_<timestamp>.dump
ai_trader_dev_<reason>_<timestamp>.dump.sha256
```

Verify the checksum immediately:

```bash
(
  cd "$BACKUP_DIR"
  sha256sum -c "$BACKUP_NAME.sha256"
)
```

Expected result:

```text
ai_trader_dev_<reason>_<timestamp>.dump: OK
```

Do not treat the backup as verified unless the command reports `OK`.

## 6. Resume development

After the dump and checksum have been validated, restart the backend and any workers or development processes that were stopped before the backup.

No PostgreSQL restart is required.

## 7. Retain the backup

After successful verification:

- Keep the `.dump` and matching `.sha256` file together.
- Keep backup files outside the Git repository.
- Do not commit database dumps to Git.
- Use descriptive backup reasons for backups associated with migrations or experiments.
- Delete obsolete development backups periodically when they are no longer useful.
- Preserve important checkpoint backups before destructive schema or data changes until the change has been fully validated.

Development database backups may contain broker observations, historical trading evidence, configuration, credentials stored in database records, or other sensitive application data. Treat them accordingly.

## Optional: perform a full restore test

`pg_restore --list` verifies that PostgreSQL can read the archive structure, but the strongest validation is restoring the archive into a temporary database.

This can be useful before a particularly risky migration.

Choose a temporary verification database:

```bash
VERIFY_DB="ai_trader_backup_verify"
```

Remove any previous verification database:

```bash
docker compose exec -T postgres \
  dropdb --username=trader --if-exists "$VERIFY_DB"
```

Create a fresh database:

```bash
docker compose exec -T postgres \
  createdb --username=trader "$VERIFY_DB"
```

Restore the backup:

```bash
docker compose exec -T postgres \
  pg_restore \
  --username=trader \
  --dbname="$VERIFY_DB" \
  --no-owner \
  --no-privileges \
  < "$BACKUP_FILE"
```

Confirm that tables are present:

```bash
docker compose exec -T postgres \
  psql \
  --username=trader \
  --dbname="$VERIFY_DB" \
  -c '\dt'
```

After successful verification, delete the temporary database:

```bash
docker compose exec -T postgres \
  dropdb --username=trader "$VERIFY_DB"
```

This does not modify the normal `ai_trader` development database.

## Failure handling

### The dump command fails

Do not rely on the resulting archive.

Remove the partial dump and checksum:

```bash
rm -f "$BACKUP_FILE" "$BACKUP_FILE.sha256"
```

Confirm that PostgreSQL is running:

```bash
docker compose ps postgres
```

Inspect recent PostgreSQL logs if necessary:

```bash
docker compose logs --tail=100 postgres
```

Then retry the backup after correcting the problem.

### Archive validation fails

If this command fails:

```bash
docker compose exec -T postgres \
  pg_restore --list < "$BACKUP_FILE"
```

delete the archive and create a new dump.

Do not preserve an archive that PostgreSQL cannot successfully inspect.

### Checksum verification fails

Do not use the backup.

Delete both files and create the backup again:

```bash
rm -f "$BACKUP_FILE" "$BACKUP_FILE.sha256"
```

## Restore warning

Creating and validating a backup is non-destructive.

Restoring a backup over the normal `ai_trader` development database is destructive because the existing development database must either be replaced or cleaned before restoration.

Do not run `pg_restore --clean` against the normal development database merely to test a backup.

Use the temporary restore-validation procedure above when the goal is only to confirm that a backup is restorable.