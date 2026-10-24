# Position Lifecycle Evidence Inventory

Phase 1C.0 is a disconnected, read-only inventory of persisted `TrackedPosition`
evidence. Its classifications are shadow diagnostics. They grant no account authority,
position ownership, exit eligibility, repair permission, or broker-write capability.

## V1 classification contract

- `COMPLETE_LOCAL_ORDER_CHAIN` requires one reconciled BUY intent; frozen Subscription
  and assignment identity; position-consistent BrokerOrder and FILL links; unique
  activity identity; exact executed quantity; stable order identity; exactly one final
  dispatch record; and exactly one matching adapter-invocation marker.
- `POSITIVE_EXTERNAL_ORIGIN` requires independently verified external-origin evidence.
  Existing provenance decisions are currently reported as `UNVERIFIED`, so an
  unsupported `BROKER_EXTERNAL` row remains unresolved.
- `UNKNOWN_INCOMPLETE_LINEAGE` covers missing, partial, multiple-but-unreconciled, or
  otherwise insufficient evidence. Symbol, timing, quantity, enabled Subscription,
  repair/adoption history, and current broker position quantity are not proof.
- `CONTRADICTORY_EVIDENCE` takes precedence when explicit identities disagree.

The report includes local database IDs but hashes broker order, client order, activity,
and fill order identities. Broker account identifiers are masked. Raw broker JSON,
credentials, connection strings, and decrypted secrets are never selected.

## Transaction and query boundary

`runPositionLifecycleEvidenceInventory` opens one
`REPEATABLE READ READ ONLY` transaction, verifies the exact database/host/port/user,
role posture, and transaction mode, then reads positions in keyset-ordered batches.
Each bounded batch bulk-loads related intents, orders, fills, dispatch records, claims,
attribution, provenance, and attention. The query layer receives only the transaction
client and imports no lifecycle, repair, recovery, broker, or mutation service.

The CLI refuses to run unless all of the following are true:

1. `ALLOW_PERSISTENT_DEVELOPMENT_LIFECYCLE_INVENTORY=I_UNDERSTAND_READ_ONLY`.
2. `LIFECYCLE_INVENTORY_APPROVED_DATABASE_IDENTITIES` is a non-empty JSON array of
   exact `database`, `host`, `port`, and `user` values.
3. The connected identity exactly matches an entry.
4. The role is non-superuser, has no INSERT/UPDATE/DELETE privilege on protected
   lifecycle tables, and has `default_transaction_read_only=on`.
5. The transaction reports `transaction_read_only=on`.

Example shape only; obtain and independently verify the real development reader
identity before use:

```powershell
$env:ALLOW_PERSISTENT_DEVELOPMENT_LIFECYCLE_INVENTORY='I_UNDERSTAND_READ_ONLY'
$env:LIFECYCLE_INVENTORY_APPROVED_DATABASE_IDENTITIES='[{"database":"approved_dev","host":"127.0.0.1","port":5432,"user":"approved_reader"}]'
npm.cmd run lifecycle:evidence-inventory -- --page-size=250
```

Do not run the CLI with normal application, migration, owner, or superuser credentials.
Phase 1C.0 does not create a reader role. Until a verified SELECT-only development role
and exact identity allowlist exist, use only the disposable PostgreSQL tests.

## Output and review

Every historical position is included, including closed and account-unattributed rows.
Aggregates are grouped by database tier, account environment, broker, and position
status. Classification counts are exclusive; reason and readiness counts overlap.
Open/closing positions with an exit state but without complete V1 local proof are
marked `LEGACY_EXIT_CONTINUITY_REVIEW_REQUIRED`. Existing exit state or protective
orders never establish entry ownership, and the inventory changes none of them.
