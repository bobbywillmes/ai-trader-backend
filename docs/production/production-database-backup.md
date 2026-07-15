# Production Database Backup

This runbook documents the manual PostgreSQL backup process for the AI Trader production environment. Use it before database migrations, schema refactors, direct production data changes, or other deployments where a rollback copy is warranted.

## Production environment

| Item | Value |
| --- | --- |
| VPS | `srv1700402.hstgr.cloud` |
| Application directory | `/opt/ai-trader` |
| Docker Compose file | `docker-compose.prod.yml` |
| PostgreSQL service | `postgres` |
| PostgreSQL container | `ai-trader-prod-postgres` |
| Database | `ai_trader` |
| Database user | `trader` |
| Backup directory | `~/ai-trader-backups` |
| Backup format | PostgreSQL custom archive (`.dump`) |

This procedure creates a logical PostgreSQL backup with `pg_dump`. It does not create a filesystem snapshot or provide point-in-time recovery.

## 1. Connect to production

Run this from the local computer:

```bash
ssh root@srv1700402.hstgr.cloud
```

On the VPS:

```bash
cd /opt/ai-trader
docker compose -f docker-compose.prod.yml ps
```

Confirm that the expected production services are present and that the `postgres` service is healthy before continuing.

## 2. Define the backup filename

Choose a short lower-case reason for the backup. The example below is the backup created before the User refactor.

```bash
BACKUP_REASON="before_user_refactor"
BACKUP_DIR="$HOME/ai-trader-backups"
BACKUP_NAME="ai_trader_${BACKUP_REASON}_$(date -u +%Y%m%d_%H%M%S_UTC).dump"
BACKUP_FILE="$BACKUP_DIR/$BACKUP_NAME"

mkdir -p "$BACKUP_DIR"

echo "$BACKUP_FILE"
```

The resulting filename will resemble:

```text
/root/ai-trader-backups/ai_trader_before_user_refactor_20260712_140952_UTC.dump
```

Keep the exact filename shown by `echo`; it will be needed when copying the backup to the local computer.

## 3. Pause application writes

Stop the backend before creating the dump:

```bash
docker compose -f docker-compose.prod.yml stop backend
```

The PostgreSQL service must remain running.

Stopping the backend prevents its API routes and workers from writing to the database while the dump is created. Do not leave production in this state longer than necessary.

## 4. Create the database dump

Run `pg_dump` inside the production PostgreSQL container and write the archive to the VPS:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres   pg_dump   --username=trader   --dbname=ai_trader   --format=custom   > "$BACKUP_FILE"
```

The `-T` option disables pseudo-TTY allocation, which is required when redirecting the binary archive to a file.

## 5. Validate the backup

First, confirm that the archive exists and is not empty:

```bash
test -s "$BACKUP_FILE"
ls -lh "$BACKUP_FILE"
```

Then confirm that PostgreSQL can read the archive catalog:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres   pg_restore --list < "$BACKUP_FILE" | sed -n '1,20p'
```

A valid archive will print PostgreSQL archive metadata and object entries. Stop here if `test -s` or `pg_restore --list` fails.

## 6. Create a checksum

Create the checksum from inside the backup directory so the checksum file contains a relative filename that can also be verified after download:

```bash
(
  cd "$BACKUP_DIR"
  sha256sum "$BACKUP_NAME" > "$BACKUP_NAME.sha256"
)

cat "$BACKUP_FILE.sha256"
ls -lh "$BACKUP_FILE" "$BACKUP_FILE.sha256"
```

The VPS should now contain both files:

```text
ai_trader_<reason>_<timestamp>.dump
ai_trader_<reason>_<timestamp>.dump.sha256
```

## 7. Resume production

When the backup is not immediately followed by a deployment, restart the backend:

```bash
docker compose -f docker-compose.prod.yml start backend
docker compose -f docker-compose.prod.yml ps
```

Run the normal production health check and confirm that the web application loads data normally.

When the backup is part of a deployment, continue with the documented migration and deployment steps instead of briefly restarting the old backend.

## 8. Download the backup

Exit the SSH session:

```bash
exit
```

The following `scp` commands must run on the local computer, not inside the production SSH session.

### Git Bash

```bash
cd ~/Desktop/AI_Trader/backups

scp root@srv1700402.hstgr.cloud:~/ai-trader-backups/<exact-backup-filename> .
scp root@srv1700402.hstgr.cloud:~/ai-trader-backups/<exact-backup-filename>.sha256 .
```

Replace `<exact-backup-filename>` with the complete timestamped filename created earlier, including its `.dump` extension.

Example:

```bash
scp root@srv1700402.hstgr.cloud:~/ai-trader-backups/ai_trader_before_user_refactor_20260712_140952_UTC.dump .
scp root@srv1700402.hstgr.cloud:~/ai-trader-backups/ai_trader_before_user_refactor_20260712_140952_UTC.dump.sha256 .
```

## 9. Verify the local copy

From the local directory containing both downloaded files:

```bash
sha256sum -c <exact-backup-filename>.sha256
```

Expected result:

```text
<exact-backup-filename>: OK
```

Do not treat the local copy as verified unless the command reports `OK`.

### PowerShell alternative

When `sha256sum` is unavailable, calculate the hash in PowerShell:

```powershell
(Get-FileHash ".\<exact-backup-name>.dump" -Algorithm SHA256).Hash.ToLower()
Get-Content ".\<exact-backup-name>.dump.sha256"
```

The two SHA-256 values must match exactly.

## 10. Retain and protect the backup

After successful verification:

- Keep the `.dump` and matching `.sha256` file together.
- Do not commit either file to Git.
- Store the local copy somewhere protected from accidental deletion.
- Keep the VPS copy until the migration or production change has been fully verified.
- Treat the dump as sensitive production data.

## Failure handling

### The dump command fails

Do not proceed with the migration. Remove any empty or partial file:

```bash
rm -f "$BACKUP_FILE" "$BACKUP_FILE.sha256"
```

Review the PostgreSQL container status and available disk space:

```bash
docker compose -f docker-compose.prod.yml ps postgres
df -h
```

Restart the backend if it was stopped and no deployment will continue:

```bash
docker compose -f docker-compose.prod.yml start backend
```

### Local checksum verification fails

Do not use the downloaded file. Delete the local copies and download both files again from the VPS. Confirm that the checksum filename corresponds to the exact dump filename.

## Restore warning

This runbook covers backup creation, archive validation, download, and checksum verification. A production restore is a separate incident procedure because it is destructive and requires an explicit decision about the target database, application downtime, migrations, and post-restore verification.

Never run `pg_restore --clean` against production as an exploratory command.