# Phase 3C.4 release-readiness evidence

This document inventories the seven migrations on `feat/market-intelligence-trading`
that are absent from `origin/main` at baseline `fa3f6d4`. It is a review artifact,
not approval to migrate or deploy. Production migration and application deployment
remain separate owner-approved operations.

## Pending-migration inventory

All seven migrations are forward-only. None deletes or rewrites positions,
OrderIntents, BrokerOrders, or existing lifecycle evidence. PostgreSQL DDL still
takes table locks, however, and a disabled runtime rollout does not make the DDL
operationally free.

### `20261017120000_add_entry_exposure_claims`

- Adds empty `EntryExposureClaim` and append-oriented `EntryExposureClaimEvent`
  tables. It adds restrictive foreign keys to TradingAccount, Security, OrderIntent,
  and TrackedPosition; unique owner/intent/position keys; one-active-claim-per-account-
  and-security uniqueness; lookup indexes; and owner/release-shape checks.
- It performs no backfill. Existing positions, intents, broker orders, and account
  rows are unchanged and receive no claims. The new backend deliberately treats
  unresolved pre-claim exposure as a readiness problem rather than guessing history.
- Current `origin/main` code does not reference the new tables, so the added schema is
  backward compatible. New code must not be deployed before this migration.
- New-table/index creation is normally short, but foreign-key installation briefly
  locks referenced lifecycle tables. Schedule a quiet window and observe blockers;
  no full application downtime is expected when lock acquisition is prompt.
- Rollback requires dropping claim tables and their evidence. Once the new application
  has written claims, that is audit-data loss and is not an acceptable routine rollback.

### `20261017130000_guard_entry_exposure_claim_states`

- Adds status-vocabulary and released-status CHECK constraints to the still-new claim
  table. It changes no lifecycle rows and adds no trigger or index.
- It is compatible with `origin/main`, which cannot write claims. Applied immediately
  after the preceding empty-table migration, validation is trivial.
- `ALTER TABLE` takes an access-exclusive lock on `EntryExposureClaim`; no downtime is
  expected before the new application writes claims. On a populated retry or partial
  rollout, validation can scan the table and block concurrent claim traffic.
- Removing the checks is mechanically possible but weakens the durable lifecycle
  boundary; it does not reverse claim data already written.

### `20261018120000_add_broker_order_sync_cursor`

- Adds nullable `OrderIntent.lastSubmittedOrderSyncAt` and a composite account/cursor/id
  index. Existing OrderIntents retain `NULL`; positions, BrokerOrders, claims, and
  accounts are unchanged.
- The nullable column is backward compatible with `origin/main`. The new index is also
  invisible to old behavior.
- `ALTER TABLE` requires a brief access-exclusive lock. `CREATE INDEX` is not
  concurrent and scans all OrderIntent rows while taking a share lock that blocks
  writes. This is the principal size-dependent lock/contention risk in the set; inspect
  OrderIntent size and active transactions and use a quiet maintenance window.
- Dropping the column/index loses only the new sync cursor, but an old image must not be
  restored until any newer code relying on cursor-driven recovery is stopped.

### `20261018130000_assignment_market_policy_enforcement_authorization`

- Adds authorization/action enums; immutable authorization and event tables; foreign
  keys, lifecycle/fingerprint/scope checks, one-active-authorization partial unique
  indexes, and lookup indexes. Validation/audit triggers govern grants and events.
  Invalidation triggers are attached to enrollment generation, policy revision,
  TradingAccount holder/environment, and TradingAccountSubscription identity changes.
- It creates no authorization rows and does not change positions, OrderIntents,
  BrokerOrders, claims, or account lifecycle state. With no authorization rows, the
  new invalidation triggers are effectively no-ops for old application writes; the
  environment trigger only refuses a change that conflicts with an authorization.
- It is compatible with the currently deployed code provided no newer authorization
  rows are created before that code is retired. Apply the full migration set in one
  approved maintenance sequence, not as a mixed-version feature rollout.
- New-table indexes are low risk. Trigger installation and function replacement take
  brief locks on existing configuration tables; concurrent configuration mutations
  may wait. Use a quiet window, but continuous API downtime is not inherently required.
- PostgreSQL enum values and append-preserving evidence are not safely reversible.
  Dropping this schema after grants exist destroys authority history.

### `20261018150000_market_policy_pre_intent_enforcement`

- Upgrades authorization evidence from V1 to V2 with frozen Subscription and Security
  identity, related foreign keys/indexes, regenerated fingerprint triggers, and broader
  invalidation triggers. It invalidates every still-`AUTHORIZED` V1 row for explicit
  reapproval; there should be none in a normal uninterrupted migration sequence.
- Adds lapse-resolution evidence, a singleton default-disabled runtime-rollout row and
  event log, immutable admission attempts/gates, frozen OrderIntent obligations, and
  deferred verification/backstop triggers on admission and OrderIntent creation.
- Existing positions, BrokerOrders, claims, accounts, and OrderIntents are not
  backfilled. The one data mutation is the explicit V1 authorization invalidation;
  record its affected-row count. The rollout insert is disabled and version zero.
- `origin/main` remains compatible while rollout is disabled and no grants exist: its
  OrderIntent inserts do not require obligations. Compatibility must be demonstrated
  on an isolated main-schema copy because the migration changes triggers on tables the
  old backend writes. Do not enable rollout while old code is running.
- The authorization UPDATE may lock matching rows; added foreign keys/checks and
  trigger creation take table locks; deferred triggers add work to relevant writes.
  Use a quiet maintenance window and inspect lock waits. Full downtime is not expected
  for a small database, but abort rather than wait unboundedly behind active traffic.
- Rollback cannot recreate V1 `AUTHORIZED` state or erase immutable admission evidence
  safely. A database backup is the only complete rollback point, and restoring it would
  also discard all post-backup trading data.

### `20261018170000_market_policy_broker_time_enforcement`

- Tightens admission timing checks and the OrderIntent backstop; adds broker-dispatch
  outcome/disposition enums, immutable decision/gate tables, single-use consumption,
  foreign keys, uniqueness/lookup indexes, and validation/deferred-verification
  triggers.
- It creates no rows and changes no existing position, intent, BrokerOrder, claim, or
  account state. With the rollout disabled, old-code entry inserts remain un-obligated.
- It is backward compatible with `origin/main` under that disabled/no-grant condition,
  but old code cannot understand or preserve a newly enabled enforcement lifecycle.
  Never enable the rollout until the reviewed application is deployed.
- Function replacement and trigger installation briefly lock OrderIntent and the new
  evidence tables. New indexes are on empty tables. No planned downtime is required,
  but use the same quiet window and lock monitoring as the preceding migration.
- Consumption is durable evidence that a POST may have begun. Once written, it must
  never be deleted to make a schema rollback easier. Image rollback is permissible
  only to code proven compatible with these tables and their lifecycle meaning.

### `20261019120000_market_policy_dispatch_recovery`

- Adds immutable `MarketPolicyBrokerUnenforcedDispatch`, with identity/scope/basis
  checks, foreign keys, one-record-per-intent uniqueness, lookup indexes, and a final
  serialized authorization trigger. Adds an UPDATE/DELETE rejection trigger to
  `EntryExposureClaimEvent`.
- It creates no rows and changes no positions, OrderIntents, BrokerOrders, claims, or
  accounts. Old code does not know this table and does not mutate claim events, so it
  remains compatible before the new application starts writing this evidence.
- New-table work is low contention. Installing the append-only trigger briefly locks
  `EntryExposureClaimEvent`; in the intended pre-deployment state that table is empty.
- Unenforced-dispatch and claim-event evidence is intentionally irreversible. Schema
  rollback after the new application runs would remove the proof used to prevent a
  duplicate broker POST and is unsafe.

## Compatibility acceptance

### Reported independent evidence

Hermes independently reported the following results against the reviewed feature
branch; these were not rerun as part of this documentation correction:

- All seven migrations applied successfully to a populated synthetic main-era
  database, and existing fixture row counts remained unchanged.
- Market-policy enforcement remained disabled.
- Representative lifecycle writes from the old backend succeeded after migration.
- The old backend's behavioral tests passed. Nine schema-drift tests failed because
  its intentionally older Prisma schema does not contain the new database objects.
- The new backend database suite passed: 463 tests passed and 23 were skipped.

This is useful compatibility evidence, but it is not evidence from an actual sanitized
production-sized database. A production-sized migration rehearsal remains required to
measure lock acquisition, migration duration, and contention under representative
table sizes and transactions.

Before production approval, restore a recent sanitized production backup (or create an
equivalent main-schema fixture) into an isolated PostgreSQL instance with no route to a
broker. Record the source backup identity and row counts. Using the exact reviewed
image, run `prisma migrate status`, then `prisma migrate deploy`; record exit codes,
durations, notices, V1 invalidation count, and lock observations. Run `migrate status`
again and verify all seven migrations in `_prisma_migrations`.

Start the currently deployed main-branch backend against a second copy of the migrated
database in observation-only mode, workers disabled where supported, and all trading
controls conservative. Exercise health and read-only lifecycle/account queries plus an
isolated disposable write fixture representative of old OrderIntent creation while the
rollout remains disabled. This establishes backward compatibility; merely seeing the
migration command succeed does not. Destroy both databases after retaining sanitized
evidence.

## Production migration acceptance criteria

- A tested backup and restore procedure, backup identifier, retention location, and
  restoration owner are recorded before migration.
- The exact reviewed immutable `IMAGE_ID` contains the seven reviewed migration files.
- `IMAGE_ID` was built, captured, and revision-verified during the separately approved
  read-only preparation gate before production migration status was run; every later
  gate reuses it without rebuilding from a tag.
- The operator records database identity, migration status, table sizes, active long
  transactions, available capacity, and a bounded quiet maintenance window.
- The owner separately approves the schema migration. This is not PAPER execution or
  application-deployment approval.
- Run migration status and deploy from the reviewed image on the Compose network. Do
  not start the backend service and do not use a mutable tag or host checkout.
- Verify command exit code zero, all seven `_prisma_migrations` rows completed, expected
  columns/tables/indexes/triggers exist, V1 authorization invalidation is understood,
  rollout id 1 remains disabled/version 0, and existing lifecycle row counts are
  unchanged. A failed or partial migration is STOP and requires diagnosis; do not edit
  `_prisma_migrations` manually.

Database rollback is not the normal recovery path. Forward repair is preferred. A
backup restore reverts the entire database and can discard fills, positions, intents,
and broker evidence created after the backup. It requires an incident decision,
broker reconciliation, and a separately reviewed outage plan.

## Nonproduction Docker smoke test

This plan must use a throwaway Compose project, disposable volumes/network, synthetic
PAPER identity, inert broker configuration, and an isolated PostgreSQL database. It
must not reference the production project name, production env file, production
network, or production container.

1. Check out the reviewed full SHA. Build with
   `--build-arg IMAGE_REVISION="$REVIEWED_SHA"`; capture `IMAGE_ID`, verify the OCI
   revision label, and verify `/app/.image-revision` equals the same full SHA even when
   `docker run -e IMAGE_REVISION=wrong` is used.
2. Start isolated PostgreSQL and migrate it from `origin/main`, then run all seven
   migrations from the exact `IMAGE_ID`. Record both exit codes and final migration
   status. Load only the minimum synthetic account/identity fixture needed for GO.
3. Run the preflight inside `IMAGE_ID`. Confirm nonzero/STOP for an invalid database
   identity and separately for an invalid expected revision. Confirm zero/GO only
   against the correctly migrated disposable database and synthetic authorized
   configuration; retain sanitized output.
4. Set `AI_TRADER_BACKEND_IMAGE` to the immutable ID. Render the throwaway base and
   image override with `docker compose ... config` into a mode-600 temporary file
   outside the worktree, following the restricted review and deletion procedure in
   the production runbook. Review that `backend.image` is the exact ID,
   `backend.build` is absent, the database/network/volumes are disposable, and no
   production resources resolve. Retain only sanitized assertions.
5. Run `docker compose -p <unique-throwaway-name> ... up -d --no-build --no-deps backend`.
   Confirm no build occurs and no dependency is created or changed by that command.
   Inspect the resulting container image ID and compare it byte-for-byte with
   `IMAGE_ID`. Tear down only the validated throwaway project and its disposable
   volumes.
6. Before and after, capture `docker inspect` for the production backend without
   restarting it. The production container ID, image ID, start time, and state must be
   unchanged. Any production change invalidates the test and triggers incident review.

Do not mark this smoke test passed unless every command actually ran and its exit code
was recorded. Lack of Docker daemon access is `PENDING`, not success.
