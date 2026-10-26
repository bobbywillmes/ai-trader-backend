# Offline Development Snapshot Inventory

This Phase 1C.1B.1 workflow applies the accepted Phase 1C.0 classifier only to an
approved PostgreSQL 16 custom archive restored by the controlled disposable procedure.
It grants no permission to read or back up a persistent database.

## Trust model

Three categories are deliberately separate:

1. Code verifies archive bytes/checksum/header, PostgreSQL 16 archive catalog, file
   security, signed bindings, live Docker metadata, PostgreSQL cluster identity,
   reader posture, and deterministic inventory-table digests.
2. Source container, volume, Docker context, absence of production containers, and
   absence of tunnels are operator observations recorded in the manifest. They are not
   represented as independently proven facts.
3. A human approves an exact manifest/archive/catalog tuple. Approval is represented
   by an HMAC file created with a random owner-only approval key stored beside neither
   the archive nor report. An editable manifest is therefore not authorization.

The controlled restore verifies the approval, refuses a nonempty target, executes
`pg_restore` itself, provisions one SELECT-only reader, computes table digests, and
seals them with live container, volume, run, cluster, archive, and approval identities
in the restore receipt. Inventory recomputes digests before and after classification.

## Source preparation — separate owner approval

Only after approval to inspect the development source:

- require Docker context `default` and the exact checked-in development Compose file;
- verify Compose labels and working directory, service `postgres`, container
  `ai-trader-postgres`, exact image `postgres:16`, database/user `ai_trader`/`trader`,
  full 64-character container ID, the development-specific `*_postgres_data` volume,
  and PostgreSQL `system_identifier` and major version;
- stop application writers, broker tunnels, and database tunnels before the common
  snapshot point; record the two absence checks as operator observations;
- create one custom-format archive with `pg_dump` inside that exact container;
- inspect it with the exact `postgres:16` image using `pg_restore --list`, record the
  normalized catalog SHA-256, archive SHA-256, size, timestamp, and observed source
  facts in an `AI_TRADER_DEVELOPMENT_BACKUP_V2` manifest; and
- place archive, manifest, key, approvals, credentials, receipts, and reports outside
  Git and outside cloud-synchronized directories.

The archive begins with `PGDMP`. A filename, environment variable, database contents,
or the manifest's own source claims are never sufficient proof.

## Protected approval

Generate a 32-byte random approval key once for the review, set an explicit owner-only
ACL, and keep it separately. All sensitive input files must have non-inherited,
non-broad ACLs on Windows or mode 0600 on POSIX. Then run:

```powershell
npm.cmd run lifecycle:snapshot-control -- approve `
  --manifest=C:\secure\snapshot.manifest.json `
  --dump=C:\secure\snapshot.dump `
  --approval-key=C:\separate-secure\approval.key `
  --approval-output=C:\secure\snapshot.approval.json `
  --approved-by=bobby
```

This uses a network-disabled `postgres:16` inspection container. It refuses a bad
header, bad checksum, wrong archive, non-v16 tool, invalid custom catalog, stale
chronology, or catalog mismatch.

## Fresh disposable run

Generate a cryptographically random lower-case 32-hex run ID, unused loopback port,
reader name `snapshot_reader_<first-12-run-hex>`, database
`ai_trader_snapshot_<run-id>`, and URL-safe random reader password. Put those fields
in an owner-only `AI_TRADER_SNAPSHOT_READER_CREDENTIAL_V1` JSON file. The password
never appears in argv, logs, manifest, receipt, or report.

Before startup, require that no Compose project, container, network, or volume with the
run identity exists. Set only non-secret `SNAPSHOT_RUN_ID` and `SNAPSHOT_HOST_PORT`, then:

```powershell
docker compose -p "ai-trader-snapshot-$env:SNAPSHOT_RUN_ID" `
  -f docker-compose.snapshot-inventory.yml up -d --wait postgres
```

The topology has one PostgreSQL 16 service, a new run-labeled volume, a dedicated
bridge with IP masquerading disabled, and one local ingress binding on `127.0.0.1`. It contains no app,
worker, broker credentials, or persistent volume reference. The internal network
blocks container egress while the explicit loopback mapping lets the approved host CLI
connect. Disabling masquerading prevents ordinary container Internet egress while
preserving Docker Desktop's host port publishing (Docker Desktop suppresses published
ports on an `internal: true` network). Do not attach another service or network.

Run the controlled restore:

```powershell
npm.cmd run lifecycle:snapshot-control -- restore `
  --manifest=C:\secure\snapshot.manifest.json `
  --dump=C:\secure\snapshot.dump `
  --approval=C:\secure\snapshot.approval.json `
  --approval-key=C:\separate-secure\approval.key `
  --credential-file=C:\secure\reader-credential.json `
  --receipt-output=C:\secure\restore-receipt.json
```

It rejects existing public objects, an existing reader, unexpected/multiple project
containers, mismatched labels, image, loopback port, mount, volume, or run identity.
It copies the approved archive into the exact container, restores with `--no-owner
--no-privileges --exit-on-error`, removes the container copy, creates only the
run-specific reader, and signs the receipt after digesting relevant tables.

## Inventory and output

Create an existing empty output directory outside the canonical Git repository and
cloud-synchronized folders. On POSIX it must be mode 0700. On Windows remove ACL
inheritance and broad Users/Everyone/Authenticated Users grants; execution refuses if
the ACL cannot be verified. Then clear application discovery variables and run:

```powershell
Remove-Item Env:DATABASE_URL,Env:NODE_ENV -ErrorAction SilentlyContinue
npm.cmd run lifecycle:evidence-inventory:offline -- `
  --manifest=C:\secure\snapshot.manifest.json `
  --dump=C:\secure\snapshot.dump `
  --approval=C:\secure\snapshot.approval.json `
  --approval-key=C:\separate-secure\approval.key `
  --restore-receipt=C:\secure\restore-receipt.json `
  --credential-file=C:\secure\reader-credential.json `
  --output-root=C:\local-not-synced\inventory-review `
  --output-name=position-lifecycle.json
```

The canonical repository root comes from Git, not the invocation directory. Realpath,
link/junction, filename, directory ACL, and containment checks precede connection.
Finalization creates a secured temporary file and uses an atomic same-directory hard
link; an existing or concurrently created destination returns `EEXIST`, never an
overwrite. Ordinary failures remove the incomplete file. Unsupported filesystems fail
closed rather than falling back to rename.

The report references archive, approval, receipt run, container, volume, cluster and
table digests, but contains no password or approval key. External identifiers use a
fresh unpersisted per-run HMAC. Classification remains read-only, bounded, and performs
no network/provider calls.

## Verified cleanup

After the retention decision, cleanup reads the signed receipt, re-verifies the exact
live container, volume and project resource set, and refuses unexpected resources:

```powershell
npm.cmd run lifecycle:snapshot-control -- cleanup `
  --restore-receipt=C:\secure\restore-receipt.json `
  --approval-key=C:\separate-secure\approval.key
```

It removes only the receipt's container, volume, and project network. It never uses a
generic environment variable, prune operation, development volume, or production
resource. Verify no run-labeled resource remains before deleting retained local files.

## Approval gates and limitations

Separate owner approval is required for source inspection, writer quiescence, backup
creation, archive approval, disposable startup/restore, inventory execution, cleanup,
and retained-file deletion. Docker/host administrators remain outside this model.
The approval key is a minimal local review capability, not a general signing system.
The Windows contract depends on `icacls` and hard-link support; unsupported ACL or
filesystem behavior fails closed.
