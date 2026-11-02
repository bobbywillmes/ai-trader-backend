# TradingView C3B.2-1 migration runbook: receipt clock and dispatch-fence foundation

Migration: `20261103120000_tradingview_receipt_clock_dispatch_fence_foundation` (forward-only; the 109th migration).

This migration is **database safety infrastructure only**. It adds no writer of TradingView paired consumption, no broker-send permit, no scheduler
and no broker capability. TradingView ENTRY trading stays disabled and the backend stays observer-only before, during and after it. Do **not** apply
it to a persistent database until the C3B.2-1 checkpoint has been independently accepted.

## What the migration does, in lock order

It runs as **one implicit transaction** (Prisma applies the script as a single multi-statement query). It contains no `BEGIN`/`COMMIT`; do not add
one (a nested wrapper would end the transaction early or hide a failure from the migration history).

1. `SET LOCAL lock_timeout = '15s'`.
2. `ACCESS EXCLUSIVE` on `"Signal"`, then on `"ExternalSignalBrokerDispatchConsumption"` (the two tables that gain columns). Nothing is ever
   upgraded to this mode later.
3. `SHARE ROW EXCLUSIVE`, in one statement and this fixed order: `OrderIntent`, `EntryExposureClaim`, `EntryExposureClaimEvent`,
   `ExternalSignalBrokerWorkerClaim`, `MarketPolicyBrokerDispatchDecision`, `MarketPolicyBrokerUnenforcedDispatch`,
   `OrderIntentBrokerOpportunityEvent`, `BrokerOrder`, `BrokerActivity`, `MarketPolicyBrokerDispatchConsumption`,
   `ExternalSignalTradeCycleAccount`, `ExternalSignalEntryExecutionObligation`.
4. Preconditions (fence table and `Signal.receivedAt` absent; no TradingView consumption pair exists).
5. Creates the fence table and its guard, **backfills version 1 for every historical marked intent before any fence trigger exists**, installs
   the guard, the creation trigger and the bump triggers, and asserts zero missing and zero unexpected fences.
6. Adds `Signal.receivedAt` (no default, **no backfill**) and the receipt/epoch functions and stamps, and rewrites two accepted guards to read it.
7. Adds the consumption columns, the canonical lock-prelude function and trigger, the complete consumption guard and the post-pair bump and
   verification triggers.
8. Restates the trusted `search_path` audit and asserts no application function is unpinned.

Row-lock order at run time (acceptance correction): every fence bump takes the `EntryExposureClaim` of a marked intent `FOR NO KEY UPDATE`
**before** the fence row (claim, then fence), because a claim mutation already holds the claim when its own bump reaches the fence. The
OrderIntent-update and claim-event bumps do this explicitly; neither creates a claim or a fence, and a missing fence still raises. Unmarked
PAPER and LIVE records lock nothing extra. `external_signal_broker_consumption_guard` reads its authorization clock (`clock_timestamp()`)
only after its last protected-row lock, so a wait for a lock can never authorize a signal that expired during the wait.

A session that holds any conflicting lock makes step 2 or 3 wait up to 15 s and then **fail cleanly** with `55P03`. The lock turns a missed drain
into a bounded wait or a clean failure, never into a missing fence.

## Before applying (maintenance window)

1. **Confirm the observer-only state**: TradingView ENTRY trading disabled, no dispatch activation, `ExternalSignalBrokerDispatchState` inactive.
2. **Drain activity that writes the locked tables.** Stop, in this order, then confirm quiet:
   * webhook ingestion (the `Signal` writer) and routing/correlation workers;
   * TradingView admission (`processProspectiveTradingViewEntries`) and the C2 worker-claim path;
   * the order, order-sync, position-tracking and exit-evaluation workers (they write `OrderIntent`, `BrokerOrder`, `BrokerActivity`);
   * any operator script that writes those tables.
3. **Prove nothing holds a conflicting lock** (all counts must be 0 for the application database):

   ```sql
   SELECT count(*) FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
     AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')
     AND xact_start IS NOT NULL;

   SELECT l.pid, c.relname, l.mode, l.granted FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
   WHERE c.relname IN ('Signal','ExternalSignalBrokerDispatchConsumption','OrderIntent','EntryExposureClaim','EntryExposureClaimEvent',
     'ExternalSignalBrokerWorkerClaim','MarketPolicyBrokerDispatchDecision','MarketPolicyBrokerUnenforcedDispatch',
     'OrderIntentBrokerOpportunityEvent','BrokerOrder','BrokerActivity','MarketPolicyBrokerDispatchConsumption',
     'ExternalSignalTradeCycleAccount','ExternalSignalEntryExecutionObligation') AND l.pid <> pg_backend_pid();
   ```
4. **Back up** (see `production-database-backup.md`), and record the pre-state used for the post-checks:

   ```sql
   SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;        -- expect 108
   SELECT count(*) AS marked_intents FROM "OrderIntent" WHERE "externalSignalAccountCycleId" IS NOT NULL;
   SELECT count(*) AS consumption_pairs FROM "ExternalSignalBrokerDispatchConsumption";   -- must be 0
   SELECT count(*) AS signals FROM "Signal";
   SELECT p.proname, encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
     WHERE p.proname IN ('external_signal_broker_consumption_guard','external_signal_broker_evidence_quarantine',
       'external_signal_entry_obligation_guard','external_signal_broker_worker_claim_guard') ORDER BY 1;   -- keep for failure analysis
   ```
5. Apply with the **migration identity** (not the restricted runtime role): `npx prisma migrate deploy`. Do not run it while the backend is serving.

## After applying: verify before restarting any worker

```sql
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;                     -- expect 109
SELECT count(*) FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" f WHERE f."orderIntentId" = i.id);   -- expect 0 (missing fences)
SELECT count(*) FROM "ExternalSignalDispatchFence" f WHERE NOT EXISTS
  (SELECT 1 FROM "OrderIntent" i WHERE i.id = f."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL);   -- expect 0 (unexpected fences)
SELECT count(*) FROM "ExternalSignalDispatchFence" WHERE version <> 1;                      -- expect 0 right after the migration
SELECT count(*) FROM "Signal" WHERE "receivedAt" IS NOT NULL;                                 -- expect 0 (nothing is backfilled)
```

Then run the database security preflight in `BROKER_ENABLED` and `DEVELOPMENT_OBSERVATION` mode (`paper-broker-write:preflight`): the reviewed
manifest version must read `20261103120000_tradingview_receipt_clock_dispatch_fence_foundation` with no function or trigger drift, no
`CRITICAL_TRIGGER_UNSAFE` and no `CRITICAL_TRIGGER_ORDER_UNSAFE`. Only then restart ingestion, routing, admission and the workers.

Operational consequences to expect (all in the safe direction):

* Every pre-migration `Signal` has `receivedAt IS NULL`. Such a signal can **never** authorize broker work. A TradingView signal that was accepted
  just before the migration and was still inside its 120 seconds is refused `ENTRY_SIGNAL_EXPIRED` at admission. Existing C2 recovery,
  release and evidence writing for historical intents are unaffected (they never read `receivedAt`).
* Every historical marked intent has a version-1 fence; the first fenced write moves it to 2.
* The runtime role keeps the privileges it has. The fence rejects direct inserts, updates, deletes and truncation by any role through its guard;
  because guards run as the invoker, the role necessarily holds `INSERT` and `UPDATE` on the fence table, so the guard (not a missing privilege)
  is the protection. `session_replication_role` remains the only bypass and the preflight already refuses a runtime role that can set it.

## If `prisma migrate deploy` fails

Prisma records the migration as failed in `_prisma_migrations` and refuses later deploys until it is resolved. **Never run
`prisma migrate resolve --rolled-back` until you have proved that the failed script left no persistent change.** The script is one transaction, so a
failure must have rolled everything back; prove it, do not assume it.

1. Read the error. `55P03` (`lock_timeout`) means a session held a conflicting lock: drain it and retry. A precondition error names what it found.
2. Inspect the history row (read-only):

   ```sql
   SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, left(logs, 400)
   FROM "_prisma_migrations" WHERE migration_name = '20261103120000_tradingview_receipt_clock_dispatch_fence_foundation';
   ```
3. **Prove no persistent change survived.** All of these must hold:

   ```sql
   SELECT to_regclass('public."ExternalSignalDispatchFence"') IS NULL AS fence_table_absent;                       -- true
   SELECT count(*) = 0 AS receivedat_absent FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'Signal' AND column_name = 'receivedAt';                        -- true
   SELECT count(*) = 0 AS consumption_columns_absent FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ExternalSignalBrokerDispatchConsumption'
       AND column_name IN ('authorizedAt','authorizationDeadlineAt','fenceVersion');                                -- true
   SELECT count(*) = 0 AS new_functions_absent FROM pg_proc WHERE proname IN ('external_signal_dispatch_fence_guard',
     'external_signal_lock_dispatch_graph','external_signal_signal_receipt_open','external_signal_broker_evidence_marked_intents');   -- true
   SELECT count(*) = 0 AS new_triggers_absent FROM pg_trigger WHERE tgname LIKE '%dispatch_fence%' OR tgname LIKE '%\_a\_epoch\_stamp'
     OR tgname = 'Signal_received_at_guard' OR tgname = 'BrokerDispatchConsumption_a_lock_prelude';                  -- true
   -- the four replaced functions still carry the hashes recorded before the migration
   SELECT p.proname, encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
     WHERE p.proname IN ('external_signal_broker_consumption_guard','external_signal_broker_evidence_quarantine',
       'external_signal_entry_obligation_guard','external_signal_broker_worker_claim_guard') ORDER BY 1;
   SELECT count(*) AS migrations_finished FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;                  -- still 108
   ```
4. Only if **every** check above holds: `npx prisma migrate resolve --rolled-back 20261103120000_tradingview_receipt_clock_dispatch_fence_foundation`,
   fix the cause, and `npx prisma migrate deploy` again.
5. If **any** check shows a persistent change (an object created, a hash changed, a fence row present), **stop**. Do not mark the migration rolled
   back. Restore from the backup taken above, or repair forward under review; record exactly what survived.

## Rollback

The migration is forward-only. After it has committed, "rolling back" means restoring the pre-migration backup (which discards everything written
since) or a reviewed forward fix. Because TradingView trading is disabled and no consumption writer exists, restoring is the only supported undo.
