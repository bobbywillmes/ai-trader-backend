# TradingView Phase 4A.2C3B.2: final-dispatch transaction contract

Status: **design, revision 2, for review. Nothing in this document is implemented.** C3B.1 is broker-inert and
adds no consumption writer, scheduler entry, broker adapter call or POST. Implementation of C3B.2 waits for review
of this contract.

Revision 2 corrects the first draft after an independent PostgreSQL 16/17 audit that exercised real lock and
snapshot behavior. The corrections are called out as **[R2]** where they replace a prior statement. File
references are to the current repository.

Baseline: `1adddc9` (C3A) plus C3B.1.

## 1. What exists, and what is missing

| Piece | Where | State today |
|---|---|---|
| Worker claim | `external_signal_broker_worker_claim_guard`, `processTradingViewOrderIntentForC2` | Written by C2/C3A. Atomically moves intent `pending→submitting`, claim `ENTRY_PENDING→ENTRY_SUBMITTING`, inserts `ExternalSignalBrokerWorkerClaim` and the `WORKER_CLAIMED_FOR_SUBMISSION` event. Then **always refuses** (`TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE`). |
| MI decision | `prepareObligatedDecision` (`market-policy-broker-dispatch.service.ts:205`) | Reusable as is. Own `READ COMMITTED` transaction; inserts an immutable `MarketPolicyBrokerDispatchDecision` with `dispatchExpiresAt ≤ evaluatedAt + 30 s`. Already requires `intent.status='submitting'` and an `ENTRY_SUBMITTING` unreleased claim. |
| MI consumption | `consumeDecision` (`:557`), trigger `validate_market_policy_broker_dispatch_consumption` | **Standalone** single-statement insert. For a marked intent the deferred `external_signal_dispatch_pair_check` rejects it at commit unless a TradingView consumption is in the same transaction. So the existing `authorizeDispatch` cannot be used for marked intents. |
| TV consumption | `ExternalSignalBrokerDispatchConsumption`, trigger `external_signal_broker_consumption_guard` | Table and guard exist; no writer. The guard takes the rollout advisory lock, locks `ExternalSignalBrokerDispatchState` and the authorization `FOR UPDATE`, and checks the evidence graph, authorization `AUTHORIZED`, dispatch state version and generation, and that the MI row cites the same intent, client order ID and `brokerPostOpportunityId`. It does **not** check signal age, pause/kill switch, accepted EXIT, worker-claim exposure state, or claim events (see §5.3). |
| Pair check | `external_signal_dispatch_pair_check` (deferred constraint triggers on both tables) | Both rows or neither, at commit. |
| Unenforced path | `MarketPolicyBrokerUnenforcedDispatch` | Trigger-forbidden for marked intents. A marked intent **must** have a frozen MI obligation to ever be consumed. |
| Broker opportunity | `OrderIntentBrokerPostOpportunity` (+ events, comparison attempts) | Compare-only telemetry. Not authority. |

`brokerPostOpportunityId` is nullable on both consumption tables, and the TV guard already enforces
`mi.brokerPostOpportunityId IS NOT DISTINCT FROM tv.brokerPostOpportunityId`. That is sufficient to prove "the
same exact opportunity, or none" (§4). No schema change is needed for it.

### 1.1 Market Intelligence obligation: confirmed chain and what the database does not guarantee **[R2]**

The first draft listed this as an open precondition. It is now confirmed against the code.

```
processProspectiveTradingViewEntries   external-signal-entry-admission.service.ts:45  (calls submitOrder at :78 with tradingViewExecution)
  → submitOrder                        place-order.service.ts            (BUY entry: admitEntryOrderIntent with tradingViewExecution)
    → admitEntryOrderIntent            market-policy-entry-admission.service.ts:511
      → admitInTransaction
```

* `admitInTransaction` refuses a TradingView request with `403 TRADINGVIEW_MARKET_POLICY_REQUIRED` when the MI
  runtime is inactive (`:325`) or the assignment has no effective authorization (`:340`). It never falls back to
  the legacy, unenforced admission for TradingView.
* On an `ALLOWED` evaluation, the claim, the `OrderIntent`, the admission attempt and the frozen
  `OrderIntentMarketPolicyEnforcementObligation` commit in one transaction (`:421`).
* A **duplicate** admission (`acquired.duplicate`, or the `prepared` path at `:320`) returns
  `marketPolicy.obligationId = null`. The return value therefore proves nothing about the obligation; C3B.2 must
  read it from the database.

**The database does not independently guarantee the obligation on every marked intent.**
`MarketPolicyBrokerDispatchDecision.obligationId` is nullable, no trigger requires an
`OrderIntentMarketPolicyEnforcementObligation` for a marked `OrderIntent`, and
`external_signal_order_intent_obligation_required` concerns the *TradingView* execution obligation, not the MI
one. An intent created by a defect, a manual SQL repair or a future second writer can be marked and have no MI
obligation. The only enforcement today is the service chain above.

C3B.2 must therefore:

1. **Refuse before decision preparation** (definite not-sent refusal through the existing C2 refusal path, code
   `TRADINGVIEW_MI_OBLIGATION_REQUIRED`) when no frozen `OrderIntentMarketPolicyEnforcementObligation` exists for
   the intent. Never run `prepareObligatedDecision` for it, and never fall back to an unenforced MI dispatch.
2. **Validate the obligation's exact identity** in the final database consumption guard (§5.3 item 10): the
   obligation belongs to this `orderIntentId`; `environment='PAPER'`; its `tradingAccountId`,
   `accountSubscriptionId`, `subscriptionId`, `securityId`, `strategyId` equal the worker claim's account cycle;
   the decision's `obligationId` equals it; `authorizationId`/`authorizationFingerprint`/`policyRevisionId`/
   `enrollmentGenerationId` equal the decision's; it was admitted for the same `clientOrderId`.
3. **Test** the missing-obligation fixture (marked intent, no obligation: refusal before any decision row, no
   consumption possible even by direct SQL) and duplicate admission (second admission of the same signal returns
   `obligationId = null` yet the guard still validates the stored obligation).

## 2. Minimal safe reuse of Market Intelligence code

Do not copy the evaluator or authority logic. Three small, behavior-preserving changes to
`market-policy-broker-dispatch.service.ts`:

1. **Export the decision phase unchanged.** `prepareObligated(db, request, intent, evaluator)` (and the stage
   error type) become exported as `prepareObligatedBrokerDecision`. TradingView calls it as the *decision phase*
   and gets a `DecisionResult` back.
2. **Split `consumeDecision` into an in-transaction primitive.** Add
   `insertMarketPolicyDispatchConsumption(tx, decision, request, brokerPostOpportunityId)` (the body of today's
   `consumeDecision`, taking a transaction client). `consumeDecision(db, …)` becomes that primitive in its own
   single-statement transaction, so unmarked behavior and its tests are byte-identical.
3. **Fail closed on the wrong entry point.** In `prepareEntryBrokerDispatch`, if the loaded intent is marked
   (`externalSignalAccountCycleId IS NOT NULL`), refuse before any decision with a technical, not-sent refusal
   (`TRADINGVIEW_REQUIRES_PAIRED_CONSUMPTION`).

TradingView owns only `finalizeTradingViewDispatch(...)` (new, in the broker-worker service): "decision phase
(MI) → final paired transaction (TV)". The MI evaluator, composition logic and gate persistence are never
reimplemented. The re-evaluation-on-refusal loop moves to the TV orchestrator, the only place that can retry the
whole pair.

## 3. Phases and the final transaction

```
 P  pre-checks       MI obligation present (§1.1), signal age early-out   READ COMMITTED, reads only
 D  decision phase   MI prepareObligatedBrokerDecision                    READ COMMITTED, own tx, commits
 F  final transaction TV finalizeTradingViewDispatch                      SERIALIZABLE, ordered locks, commits
 A  adapter          (C3C) client-order-ID lookup, then one POST
 O  observation      broker order / activity sync, recovery               (existing)
```

D produces a decision whose `dispatchExpiresAt` is at most 30 s away; F must commit before it. Neither phase
sends anything. The adapter is a later phase (C3C) and is **only** reachable after F committed.

### 3.1 Snapshot and lock semantics (PostgreSQL facts the design relies on) **[R2]**

The first draft said "all locks are taken before any validation read, so the snapshot is established after the
locks." **That is false and is removed.** What PostgreSQL actually does, as reproduced by the independent audit on 16.15 and 17.5:

1. A `SERIALIZABLE` transaction takes its snapshot when its **first statement starts**, not after locks are
   granted. F's first statement is the advisory lock; the snapshot is taken *before* that statement may block.
   A lock wait can therefore last seconds while the snapshot stays at the pre-wait instant.
2. **Advisory locking does not refresh the snapshot.** A plain `SELECT` after the wait still sees pre-wait data. A
   committed revoke, pause or EXIT that landed during the wait is invisible to plain reads.
3. A **row lock** (`FOR UPDATE`/`FOR SHARE`) on a row whose latest committed version is newer than the snapshot
   fails with `40001 could not serialize access due to concurrent update`. A **row-version write** (`UPDATE`) on
   such a row fails the same way. A row that was merely *locked* (not modified) by a committed transaction does
   **not** fail: the version is unchanged.
4. Lock strength matters. `FOR KEY SHARE` conflicts only with `FOR UPDATE` and key changes/`DELETE`. An ordinary
   non-key `UPDATE` (a kill-switch flip, `enabled=false`, `status` change) takes `FOR NO KEY UPDATE`, which does
   **not** conflict with `FOR KEY SHARE`. A fence meant to detect those updates must be `FOR SHARE` (conflicts with
   `FOR UPDATE` and `FOR NO KEY UPDATE`).
5. Absence checks ("no accepted EXIT", "no earlier event/consumption/BrokerOrder") on a plain read are only
   protected by SERIALIZABLE's predicate tracking, which aborts some, **not all**, anomalies. They must not be the
   sole fence.

Consequences, which are the rules F follows:

* **R-1. No stale authority authorizes dispatch.** Every mutable fact F relies on (account, assignment,
  Subscription, Security, Strategy, ExitProfile, source, binding, revision, authorization, account cycle,
  dispatch/rollout state, MI authorization) is read through a *locking* read in the mode of §6, so a concurrent
  committed change after the snapshot produces `40001` instead of a quietly old value. A validation that merely
  *read* an old value never authorizes.
* **R-2. `FOR SHARE`, not `FOR KEY SHARE`,** on mutable account, assignment, Subscription, Security, Strategy and
  ExitProfile rows, and on authorization, account-cycle and EXIT-evidence rows (§6).
* **R-3. F must write a row version on the intent and the claim** before inserting the consumption pair: a
  status-preserving touch of `OrderIntent` (e.g. `updatedAt`) and of `EntryExposureClaim`, then re-checked. Any
  racing terminalizer/refuser (unclaimed refusal, stale recovery, `refuseAndRelease`, which are
  `SERIALIZABLE` and `FOR UPDATE OF i,ec`) writes those rows, so whichever commits second gets `40001`: if the
  refuser committed first after F's snapshot, F's touch fails; if F committed first, the refuser's lock/update
  fails and its retry sees the consumption. This is what closes the "evidence inserted by a transaction that only
  *locked* the claim" gap (the event fence trigger locks the claim `FOR UPDATE` without modifying it).
  The C3B.2 migration must confirm the C2 guards permit the touch for the F path and, if they do not, add an
  explicit allowance bound to the consumption insert. This is covered by a required test (§9).
* **R-4. Revocation observed through stale SERIALIZABLE state is a `40001`, not a fresh read.** F does not
  re-read in the same transaction and "see" the revoke. It aborts, and a *new* transaction (new snapshot) decides.
* **R-5. A definite-non-send refusal never relies on F's snapshot.** After an F abort the refusal runs on an
  independently verified `READ COMMITTED` terminalization path that, under the exposure advisory lock and
  `OrderIntent FOR UPDATE`, re-reads the consumption by `orderIntentId` with a fresh statement snapshot and refuses
  to release if any exists (§7). Where that path is `SERIALIZABLE` instead, it carries the same row-version fence
  as R-3.
* **R-6. Validation by the database never depends on the caller's isolation level.** The guards of §5.3 use
  explicit locking statements, so they are correct under `READ COMMITTED` writers as well.

### 3.2 Phase F, in order

Isolation `SERIALIZABLE`, bounded to three attempts with the C3B.1 retry classifier and a fresh transaction each
attempt (a retry is the only way to obtain a fresh snapshot). `lock_timeout` 5 s and
`idle_in_transaction_session_timeout` set for F; a timeout is a retryable refusal.

1. Take the §6 locks in canonical order, **one single-table statement per relation**, strongest mode any trigger
   will later request (no upgrades: SHARE→UPDATE upgrades deadlock).
2. Validate dispatch state active, `activatedAt` set, `version` equal to the claim's `dispatchStateVersion`,
   generation equal to the claim's and the obligation's frozen generation.
3. Validate the worker claim (fingerprint, obligation, account cycle, client order ID, generation, state
   version); intent `submitting`; claim `ENTRY_SUBMITTING`, unreleased, no tracked position; its
   `WORKER_CLAIMED_FOR_SUBMISSION` event cites this worker claim; no
   `NOT_SENT/ADAPTER_INVOCATION_STARTED/DISPATCH_OUTCOME/BROKER_DELIVERY_UNCERTAIN` event; no existing MI/TV
   consumption, unenforced dispatch, `BrokerOrder`, `BrokerActivity` or non-compare opportunity event.
4. Validate current eligibility from the *locked* rows: PAPER account `ACTIVE`, `tradingEnabled`, not
   `killSwitchEnabled`, not `tradingBlocked` (**pause = status ≠ ACTIVE → refuse**), assignment
   `enabled && entriesEnabled`, Subscription/Security/Strategy/ExitProfile enabled, allocation enabled and
   account-matched, source/binding enabled, revision `ACTIVE`/`TRADE_ELIGIBLE`, authorization `AUTHORIZED` with
   the obligation's fingerprint, no accepted `EXIT_LONG` on the cycle, no `pendingExitAcceptedAt` or terminal
   account-cycle state, and no open `TrackedPosition` for account + Security.
5. Validate the MI decision `D` produced: `outcome='ALLOWED'`, `dispatchDisposition='DISPATCH_AUTHORIZED'`, the
   highest `dispatchSequence` for the intent, `clientOrderId` equals the claim's, `obligationId` equals the
   locked MI obligation, `clock_timestamp() < dispatchExpiresAt` minus a small margin (§3.3).
6. Row-version fence (R-3): touch intent then claim.
7. Insert the MI consumption via `insertMarketPolicyDispatchConsumption(tx, …)`, then the TV consumption
   (`workerClaimId`, `marketPolicyDispatchConsumptionId`, `executionObligationId`, `executionAuthorizationId`,
   `rolloutGenerationId`, `dispatchStateVersion`, same `clientOrderId`, same nullable `brokerPostOpportunityId`).
   The identical client-order ID and broker-opportunity identity on both rows is enforced by the guard (§5.3).
8. Commit. The deferred checks run now (pair check and the commit-stage guard of §5.3). **No broker request is
   made inside F or before F committed.**

The service-level checks in steps 2–5 give legible errors; the database guard of §5.3 is the authority.

If F aborts for any reason it leaves no consumption and the intent remains `submitting` with an unreleased
`ENTRY_SUBMITTING` claim, which is exactly the C2/C3A "stranded worker claim" state that recovery already
handles (§7).

### 3.3 Decision freshness and the 120 s rule **[R2]**

`D` and `F` are separate so that market evaluation (reads, possibly slow) is not inside the serialized lock
window. F re-checks `clock_timestamp() < dispatchExpiresAt − margin` (proposed 2 s, courtesy only). The MI
consumption trigger already re-checks `clock_timestamp() < dispatchExpiresAt`. On failure F rolls back; the
orchestrator may run `D` once more (a later `dispatchSequence` supersedes the older decision) and retry F
**once**, inside the 120 s signal bound; otherwise it records a definite-not-sent refusal.

**Signal age, 120 s, is enforced at commit, not at insert.** `statement_timestamp()` (the start of the insert
statement) and a `BEFORE INSERT` check are *not* adequate: the insert can happen at 119.9 s and the commit seconds
later after lock waits, trigger work and deferred checks. The invariant is evaluated with `clock_timestamp()` in a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger on the TV consumption (§5.3 item 1), which runs at the commit
boundary, after every other statement and lock wait of the transaction. A signal that is valid at insertion but
expired by commit makes the commit fail with `TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`, and nothing is consumed. The
residual gap between the deferred check and the durable commit record is bounded by WAL flush and is not
extendable by any lock wait; the adapter (C3C) additionally re-reads age with the database clock immediately
before its POST and does not send when it exceeded 120 s (the adapter check is defense in depth, never
authority).

## 4. Broker-opportunity semantics

| Concept | Record | Meaning | Authority? |
|---|---|---|---|
| Compare-only telemetry | `OrderIntentBrokerPostOpportunity` (`comparisonMode='COMPARE_ONLY'`, `tradingEffect='NONE'`) and its events | "At this moment a POST could have happened; here is what policy would have said." Best effort; may be missing, deferred or stale. | **No.** Never gates, never releases, never proves non-send. |
| Final authoritative consumption | `MarketPolicyBrokerDispatchConsumption` + `ExternalSignalBrokerDispatchConsumption` committed together | A single-use, database-linearized permission to *attempt* one POST for this intent. | Yes, for permission only. **Not proof of broker receipt**, and it never recalls an in-flight request. |
| Adapter invocation | `ADAPTER_INVOCATION_STARTED` claim event (written immediately before the HTTP call, C3C) | The process may have started the request. | Evidence of possible delivery; blocks release. |
| Observed broker state | `BrokerOrder` / `BrokerActivity` | The broker has something for this client order ID. | Authoritative evidence of delivery. |

`brokerPostOpportunityId` is **sufficient as is**: nullable on both rows (a missing observation never blocks and
never authorizes); the TV guard requires equality with the MI row's value (`IS NOT DISTINCT FROM`); the MI trigger
requires that a cited opportunity belongs to the same `orderIntentId`. To cite one, F selects the **latest**
`OrderIntentBrokerPostOpportunity` for the intent after the intent lock and passes the *same* value to both
inserts; if none exists both are `NULL`. If observation creation races F the worst outcome is `NULL`, never a
mismatch. Citing an opportunity adds no gate. No new column or table is required.

## 5. Failure, crash and retry matrix

"State" is the durable state after the event. Ten cases, unchanged in number and meaning, with the clarifications
**[R2]** noted in the last column.

| # | Event | Durable state | Next action |
|---|---|---|---|
| 1 | Failure before F (including D failing or refusing) | D may have written a decision (`ALLOWED` or not) only. Intent `submitting`, claim `ENTRY_SUBMITTING`. No consumption. | A refused decision → `refuseAndRelease` records `NOT_SENT_EVIDENCE_RECORDED` and blocks the intent; the claim then releases through the C3A not-sent path. An `ALLOWED` decision with no F is harmless (a later decision supersedes it). |
| 2 | Revocation during validation | Revoke takes `rollout advisory → source → binding → authorization FOR UPDATE`. | **[R2]** Revoke-first after F's snapshot: F's authorization `FOR SHARE`/touch raises **`40001`**, not a fresh read; the retry (new snapshot) sees `REVOKED` and refuses not-sent. F-first: consumption commits; the revoke commits after (cannot recall an in-flight request) and affects only later intents. |
| 3 | Accepted EXIT racing authorization | EXIT correlation locks `source → binding → trade cycle → account cycle` and sets `EXIT_PENDING`. | **[R2]** F takes the same four rows in the same order, `FOR SHARE` on the account cycle, so an EXIT committed after F's snapshot is `40001`, one committed before is seen. EXIT-first → refuse (`TRADINGVIEW_EXIT_ACCEPTED`), not-sent. F-first → consumption commits; the EXIT stays `EXIT_PENDING` and is honored after delivery is reconciled. |
| 4 | Deactivation while locks are held | Rollout/dispatch deactivation takes the rollout advisory lock and updates the state rows. | Deactivation-first → F sees a changed `activeRolloutGenerationId`/state version (`40001` or mismatch) and refuses not-sent. F-first → valid; deactivation applies to future work only. |
| 5 | Signal expiration | During lock waits, **or** between insert and commit. | **[R2]** Enforced by the deferred commit-stage guard with `clock_timestamp()` (§3.3, §5.3 item 1); an early check is only an optimization. Expired → rollback, definite not-sent refusal `TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`. |
| 6 | Duplicate workers | Second worker's claim insert hits the `orderIntentId` unique (`P2002`) → `NOT_CLAIMED`. Past the claim: F's locks serialize; the second sees an existing consumption or a unique violation on `orderIntentId`/`workerClaimId`/`decisionId`. | No second consumption can exist (four unique constraints). |
| 7 | F commits but the acknowledgment is lost | Both consumptions exist. Intent `submitting`, claim `ENTRY_SUBMITTING`. | **[R2]** After any failure that may have followed a commit (connection reset, timeout, `57P01`, unknown driver error), the orchestrator **must first read `ExternalSignalBrokerDispatchConsumption` by `orderIntentId`** (fresh `READ COMMITTED` statement) before considering any retry or refusal. If it exists the attempt is over: no retry of F, no refusal/release, hand the intent to recovery/C3C. |
| 8 | Process crashes immediately after F | Same as row 7, no `ADAPTER_INVOCATION_STARTED` event. | **[R2]** A committed pair is **single-use even with no adapter marker**, and **not proof of broker receipt**. Stale recovery treats the committed pair as `DISPATCH_OUTCOME_UNKNOWN`, retains exposure, never resends, and opens the C3A delivery-uncertainty attention. The C3C reconciler looks the order up by client order ID. |
| 9 | Alpaca already has this client order ID | C3C performs the client-order-ID lookup **before** the first POST and again on any ambiguity. | Link `BrokerOrder`, advance claim to `BROKER_ORDER_ACTIVE`, never POST. No new consumption is created or required. |
| 10 | F aborts with a retryable DB error (`40001`/`40P01`) | Nothing durable from F. | Up to three attempts, fresh transaction each (fresh snapshot); then refuse as technical not-sent via the independent `READ COMMITTED` path of R-5. Non-retryable classification fails closed. |

**Successful consumption is never treated as proof of broker receipt**, in code, docs or recovery.

### 5.1 How every durable outcome is handled by the existing paths **[R2]**

| Durable outcome (per intent) | Stale recovery (`entry-dispatch-recovery.service.ts`) | Operational Attention (`external-signal-delivery-attention.service.ts`) | Exposure |
|---|---|---|---|
| Worker claim only (no event, no consumption) | Terminalizes definite-not-sent after the stale window (`external_signal_stale_admission_elapsed`), under the exposure advisory lock | none | released through the C3A not-sent path |
| NOT_SENT evidence recorded | Releases claim, intent blocked/failed | none | released |
| MI decision(s) only, `ALLOWED` or refused | As "worker claim only"; decisions are harmless | none | released when stale |
| **Committed consumption pair, no marker** | `DISPATCH_OUTCOME_UNKNOWN`; never resends; **does not release** | opens one deduplicated `AUTHORITATIVE_ONLY` episode (works without usable credentials, C3B.1) | **retained** |
| Pair + `ADAPTER_INVOCATION_STARTED` | same | same | retained |
| `DISPATCH_OUTCOME_RECORDED` / `BROKER_DELIVERY_UNCERTAIN` | same | same | retained |
| `BrokerOrder` / `BrokerActivity` | normal order sync takes over | none (resolved) | normal lifecycle |
| Only an MI consumption (marked) | impossible: deferred pair check fails the commit | n/a | n/a |
| Only a TV consumption | impossible: FK to the MI row | n/a | n/a |

The marked-claim guards forbid releasing a consumed claim (`external_signal_exposure_claim_c2_guard`) and deleting
any marked claim (`external_signal_exposure_claim_delete_guard`, C3B.1). Retained exposure is **never** released
through definite-non-send recovery once consumption exists; the only release is C3C's authoritative
reconciliation.

## 5.3 Database invariants C3B.2 adds (new forward-only migration, proposed) **[R2]**

Two cooperating routines, both new or replaced with the trusted `search_path = pg_catalog, public, pg_temp`
restated (C3A function-level requirement, enforced by the static migration test and the C3B.1 preflight manifest;
the manifest must be regenerated in the same change):

* **`external_signal_broker_consumption_guard`** (replaced, `BEFORE INSERT`): takes the §6 locks **itself**, in
  explicit single-table statements in canonical order, so correctness never depends on the caller having
  pre-locked (R-6) nor on `FOR UPDATE OF a,b,c` ordering (§6.1). Performs the structural checks.
* **`external_signal_final_dispatch_commit_guard`** (new, `AFTER INSERT`, `CONSTRAINT TRIGGER … DEFERRABLE
  INITIALLY DEFERRED`, `FOR EACH ROW`): runs at the commit boundary, re-takes the same locks (already held, so
  never waits), and validates:

1. **Signal age ≤ 120 s** with `clock_timestamp()` (entry `Signal.createdAt` converted from UTC) at this boundary
   — not `statement_timestamp()`, not a `BEFORE INSERT` check.
2. **PAPER BUY only**: account `environment='PAPER'`, intent side `buy`, source `tradingview`.
3. Account `ACTIVE`, `tradingEnabled`, not `killSwitchEnabled`, not `tradingBlocked`; assignment `enabled &&
   entriesEnabled`; Subscription, Strategy, ExitProfile and Security enabled.
4. **Exact valid worker claim and active authorization/generation**: the claim exists for this intent and
   obligation, matches `clientOrderId`, generation and state version; authorization `AUTHORIZED`; rollout and
   dispatch state active at the claim's generation.
5. No accepted `EXIT_LONG` on the source cycle; account cycle not `EXIT_PENDING`/terminal.
6. Claim `ENTRY_SUBMITTING`, unreleased (**unreleased `ENTRY_SUBMITTING` exposure**), the owner event cites this
   worker claim, intent `submitting`.
7. **No earlier dispatch, broker order or contradictory event**: no other consumption, unenforced dispatch,
   `BrokerOrder`, `BrokerActivity` or `NOT_SENT/ADAPTER_INVOCATION_STARTED/DISPATCH_OUTCOME/BROKER_DELIVERY_UNCERTAIN`
   event.
8. **Latest allowed MI decision inside its short window**: the cited decision is `ALLOWED`/`DISPATCH_AUTHORIZED`,
   has the highest `dispatchSequence` for the intent, and `clock_timestamp() < dispatchExpiresAt`.
9. **Identical identities on both records**: `clientOrderId` and `brokerPostOpportunityId` equal on the MI and TV
   consumption rows, and equal to the claim's.
10. **Frozen MI obligation** (§1.1): present, belongs to this intent, identity-equal to the decision and the
    account cycle.
11. A row-version fence (R-3) was performed by this transaction on the intent and claim (the guard verifies the fence from the locked rows, so a service that skipped it fails; the exact mechanism
    is to be proven in C3B.2).
12. Nothing session-configurable (`current_setting`, GUC) can relax any of these.

Until this migration exists, the service-level checks of §3.2 are the only enforcement for the time, pause,
EXIT and obligation items, which is why C3B.2 is "service + migration", not service alone.

## 6. Canonical lock-acquisition contract **[R2]**

### 6.1 Why the order must be explicit

`SELECT … FROM a JOIN b … FOR UPDATE OF a, b, c` does **not** lock in `FROM` or `OF` order. PostgreSQL locks rows
as the plan produces them, so the join order the planner picks decides. This was reproduced against the existing
worker-claim guard (`FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec`): the account cycle, source cycle
and intent were locked ahead of the source row, which is the opposite of the EXIT-correlation order. The guard's
single statement therefore **cannot** be relied on to honor the order below. Rule: F, the claim transaction and
the new guards take every lock with **one single-table statement per relation, in the order below**, and the
guard's later multi-table `FOR UPDATE` finds the rows already held and cannot wait. No unproven reliance on
multi-table declaration order remains anywhere in the contract.

### 6.2 The order

Top to bottom; nothing may be acquired after a later row. "Mode" is the strongest mode any later trigger will
take in that transaction (never upgrade). `F` = final transaction; `Claim` = the worker-claim transaction, whose
guard takes `FOR UPDATE` on the identity rows (a stronger mode than F needs).
**New** marks relations absent from revision 1 (the audit counted six; this table is derived from the guard
sources and F's validation list and is a superset, each now an explicit row).

| # | Relation / lock | Mode (F / Claim) | Acquired by | Notes |
|---|---|---|---|---|
| 1 | Advisory `hashtext('external-signal-execution-rollout')` | exclusive | F, Claim, guards (re-entrant), revoke, grant, activate, unclaimed refusal | Serializes all TV dispatch. Acceptable for a PAPER canary. |
| 2 | `ExternalSignalExecutionRolloutState` id=1 | UPDATE | F; claim guard | |
| 3 | `ExternalSignalBrokerDispatchState` id=1 | UPDATE | F; claim guard; consumption guard | |
| 4 | `ExternalSignalExecutionRolloutGeneration` (frozen generation) | SHARE / UPDATE | claim guard (`gen`); consumption FK | **New** |
| 5 | `ExternalSignalSource` | SHARE / UPDATE | F; claim guard (`src`) | EXIT correlation and revoke start here. |
| 6 | `StrategySignalBinding` | SHARE / UPDATE | F; claim guard (`b`) | source → binding. |
| 7 | `StrategySignalRevision` | SHARE / UPDATE | claim guard (`rev`); F validation | **New**. Immediately after its binding. |
| 8 | `ExternalSignalTradeCycle` (source cycle) | SHARE / UPDATE | F; claim guard (`c`) | EXIT correlation: … → cycle. |
| 9 | `ExternalSignalTradeCycleAccount` | SHARE / UPDATE | F; claim guard (`ac`) | EXIT correlation: cycle → account cycle. **Source → binding → cycle → account-cycle** is therefore total. |
| 10 | `ExternalSignalEntryExecutionAuthorization` | SHARE / UPDATE | F; consumption guard (`FOR UPDATE`); claim guard (`auth`) | Revoke: source → binding → authorization. F stays `FOR UPDATE` because the consumption guard will request it. |
| 11 | `TradingAccount` | SHARE / UPDATE | F; claim guard (`ta`) | R-2: mutable (pause, kill switch), so `FOR SHARE`, not `FOR KEY SHARE`. |
| 12 | `TradingAccountSubscription` (assignment) | SHARE / UPDATE | F; claim guard (`tas`) | |
| 13 | `Subscription` | SHARE / UPDATE | F; claim guard (`sub`) | |
| 14 | `Strategy` | SHARE | F | **New** (enabled flag validated) |
| 15 | `ExitProfile` | SHARE | F | **New** (enabled flag validated) |
| 16 | `Security` | SHARE / UPDATE | F; claim guard (`sec`) | |
| 17 | `MarketPolicyEnforcementRuntimeRollout` id=1 | SHARE | F via `lockMarketPolicyEnforcementRollout` | MI order position 1. |
| 18 | Latest `AssignmentMarketPolicyEnforcementAuthorization` | SHARE | F via `resolveLockedAssignmentMarketPolicyEnforcement`; MI consumption trigger | |
| 19 | `StrategyMarketPolicyRevision`, `AssignmentMarketPolicyEnrollmentGeneration` named by the obligation | SHARE | F | **New** (mutable status) |
| 20 | Advisory `entry-exposure:<account>:<security>` | exclusive | F; Claim (after the §6.3 fix); admission; recovery; release; remediation | **After identity rows (11–16), before the intent.** See §6.3. |
| 21 | `OrderIntent` | UPDATE | F; Claim guard (`i`) | Intent before claim. |
| 22 | `EntryExposureClaim` | UPDATE | F; claim guard (`ec`); event fence | |
| 23 | `ExternalSignalBrokerWorkerClaim` | SHARE | F | Immutable. |
| 24 | `ExternalSignalEntryExecutionObligation` | SHARE | F; consumption FK | Immutable; **New** |
| 25 | `OrderIntentMarketPolicyEnforcementObligation` | SHARE | F | **New**; §1.1 |
| 26 | Latest `MarketPolicyBrokerDispatchDecision` for the intent | SHARE | F | **New** |
| 27 | Entry `Signal` | SHARE | F (age + identity read) | **New**; immutable by `external_signal_signal_v2_immutability_guard`. `SignalRoute` and `SignalRoutingRun` are immutable evidence read from the snapshot, as C2 already does. |
| 28 | New rows: MI consumption, TV consumption, optional claim event | key-share via FK | inserts | The event fence locks the claim (row 22, already held). |

### 6.3 Worker-claim / recovery lock inversion: hazard, fix and prerequisite **[R2]**

The independent audit **reproduced a `40P01` deadlock** between the existing worker claim and stale recovery:

* `processTradingViewOrderIntentForC2` (`external-signal-broker-worker.service.ts`) inserts the worker claim
  first. The claim trigger takes the `OrderIntent` (and identity) rows `FOR UPDATE` and only afterwards does the
  service take the `entry-exposure` advisory lock (`:103`).
* Recovery (`entry-dispatch-recovery.service.ts:1017`, `:444`, `:1148`) takes the `entry-exposure` advisory lock
  first, then `FOR UPDATE OF i`.

Opposite orders on the same intent: PostgreSQL resolves it by aborting one side with `40P01`. It is not a safety
violation (the classifier retries it) but it is nondeterministic stalling and a guaranteed flake source under
the C3B.2 interleaving tests.

**Proven correction (audit):** acquire the account/security exposure advisory lock **before** the worker-claim
insertion. This checkpoint does **not** change the worker path (C3B.1 forbids it); it records the fix and makes
it a hard prerequisite.

The canonical order is the §6.2 order, with one refinement the fix must honor. Ordinary MI admission locks
identity rows *before* the exposure advisory lock (its in-source comment states "identity-before-exposure"). If
the claim transaction only moved the advisory lock ahead of the claim insert, it would sit **before** the claim
guard's identity `FOR UPDATE` while admission holds identity `FOR SHARE` and then waits for the advisory lock — an
admission-vs-claim inversion. The corrected claim transaction is therefore:

1. rollout advisory (row 1);
2. explicit single-table pre-locks of rows 2–16 (identity rows in the **Claim** mode);
3. exposure advisory (row 20);
4. the claim insert (its guard finds rows 2–16 and the intent already held);
5. the exposure/intent updates and the claim event, as today.

Recovery, which takes only 20 → 21, is consistent with this. **C3B.2 acceptance requires** a passing two-connection
probe of each pair: claim vs stale recovery, claim vs admission (identity-before-exposure), claim vs
unclaimed-refusal, and F vs each, in both start orders, with zero `40P01`. Resolving this hazard is an explicit
prerequisite of C3B.2 acceptance, not an optimization.

### 6.4 Other hazards

* **A. TV rollout advisory (row 1) before the MI rollout row (row 17).** No existing path takes the MI rollout row
  and *then* the TV advisory (MI transitions take `User FOR SHARE → MI rollout`). Keep it that way and test it:
  nothing may take the MI rollout lock and then the TV rollout advisory lock.
* **B.** Exposure advisory vs `OrderIntent`: superseded by §6.3.
* **D. Unlocked reads in the MI consumption trigger.** It reads intent and claim unlocked. F's rows 21–22 close
  that for TradingView; the MI trigger is unchanged so unmarked behavior is unchanged.
* **E. Authorization revoke vs F.** Same relative order (5 → 6 → 10). No inversion.
* **F. EXIT ingestion.** Correlation does not take the rollout advisory lock; it takes `source → binding → cycle →
  account cycle` (rows 5, 6, 8, 9). F uses that order, so EXIT and F interleave only at rows 8–9 where the second
  waits and (at SERIALIZABLE) gets `40001` if the first committed a change.
* **G. Global serialization.** Rows 1–3 make TV dispatch single-file, which is intentional for the canary and is
  why `lock_timeout` is mandatory on F.

## 7. Recovery interaction

C3A already guarantees, and C3B.2 must not weaken:

* Any consumption, `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`, `BROKER_DELIVERY_UNCERTAIN`,
  `BrokerOrder` or `BrokerActivity` makes the claim's exposure **retained**, never auto-released, and opens one
  deduplicated `AUTHORITATIVE_ONLY` attention episode, now also for accounts with unusable credentials (C3B.1).
* `external_signal_exposure_claim_c2_guard` forbids releasing a consumed marked claim through the pre-dispatch
  path; `external_signal_exposure_claim_delete_guard` forbids deleting it.
* Stale recovery treats a committed dispatch record as `DISPATCH_OUTCOME_UNKNOWN` and never resends.

C3B.2 adds: the not-sent refusal path used after an F failure is the independent `READ COMMITTED` path of R-5 and
re-reads the consumption by `orderIntentId` under the exposure advisory lock and intent lock immediately before
releasing, so a lost-acknowledgment commit (case 7) can never be released as not-sent.

## 8. Remaining work and prerequisites

* **Prerequisite to C3B.2 acceptance:** the §6.3 correction of the worker-claim path and its probes; the C3B.1
  migration applied to development by the product owner and the preflight green on the real runtime identity.
* **C3B.2:** this contract, the three MI-service refactors, `finalizeTradingViewDispatch`, the §5.3 migration
  (and a regenerated security manifest), and the §9 tests.
* **C3B.3:** worker scheduling and rollout/activation operations, still with the adapter disabled.
* **C3C:** broker adapter invocation (client-order-ID lookup, single POST, `ADAPTER_INVOCATION_STARTED` marker,
  pre-POST age re-check), authoritative reconciliation and the only release path for retained exposure.
* **Before any canary:** broker-enabled readiness (`npm run db:security-preflight -- --mode broker-enabled` green
  on the real runtime connection), the role cutover with session draining applied and verified, the §6.3
  correction, the §1.1 obligation checks, a defined global kill procedure, and a PAPER rehearsal with the
  activation epoch. SELL and LIVE remain disabled.

## 9. Required interleaving tests (future implementation; none are written in this checkpoint)

Every test uses **two independent PostgreSQL connections** (separate sessions, not two statements on one
client), runs against PostgreSQL 16 and 17, and drives both commit orders deterministically with advisory-lock
or `pg_sleep` barriers placed at the contested statement (not timing guesses). For each scenario:

* run **F at SERIALIZABLE** against the competitor at **READ COMMITTED** and again against the competitor at
  **SERIALIZABLE**;
* run **both commit orders** (competitor commits first / F commits first) and, for F-first, also the case where
  the competitor began before F's snapshot;
* assert the outcome table below, that **at most one** `ExternalSignalBrokerDispatchConsumption` and one
  `MarketPolicyBrokerDispatchConsumption` exist, that the exposure claim is never released while a consumption
  exists, and that **no broker call occurred**: the `fetch` spy is never invoked with a non-GET, no `BrokerOrder`
  or `BrokerActivity` row exists, and no `ADAPTER_INVOCATION_STARTED` event exists (the adapter does not exist in
  this phase, so any POST is a defect).

| # | Scenario | Competitor first | F first |
|---|---|---|---|
| 1 | Authorization revoke vs final dispatch | F refuses not-sent (`40001` on first attempt, refusal on retry); zero consumption | consumption commits; revoke commits after; no recall |
| 2 | Account pause / kill switch vs final dispatch (separate runs for `status`, `tradingEnabled`, `killSwitchEnabled`, `tradingBlocked`) | F refuses not-sent; zero consumption | consumption commits |
| 3 | Accepted EXIT vs final dispatch (correlation at its own isolation) | F refuses `TRADINGVIEW_EXIT_ACCEPTED` | consumption commits; EXIT stays pending |
| 4 | Dispatch/rollout deactivation vs final dispatch | F refuses not-sent | consumption commits |
| 5 | Subscription / Strategy / ExitProfile / Security disable vs final dispatch (non-key `UPDATE`; proves `FOR SHARE`, and a negative control proves `FOR KEY SHARE` would miss it) | F refuses | consumption commits |
| 6 | Worker claim vs stale recovery, claim vs admission, claim vs unclaimed refusal (the §6.3 prerequisite) | zero `40P01`; exactly one of claim/terminalization wins | same |
| 7 | Duplicate finalization (two workers) and **lost commit acknowledgment** (kill the client connection after COMMIT is sent; then run recovery/orchestrator) | n/a | second F creates nothing; the orchestrator reads the pair by `orderIntentId` before any retry; recovery retains exposure; zero release |
| 8 | **Signal expiration during lock waits** (hold a needed lock until age passes 120 s) **and before commit** (signal 119.5 s old at insert; the deferred guard runs after 120 s; plus a manual two-insert transaction that `pg_sleep`s before `COMMIT`) | n/a | commit fails `TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`; zero consumption; a negative control shows a `statement_timestamp()` implementation would have passed |
| 9 | Racing high-isolation refuser (R-3): SERIALIZABLE `refuseAndRelease` vs F | one wins, the other `40001`; never both a consumption and a release | same |
| 10 | Missing MI obligation fixture, duplicate admission, wrong-identity obligation | refused before any decision; guard rejects direct SQL | n/a |
| 11 | Direct-SQL attempts: a consumption pair written by a session that skipped the pre-locks and the row-version fence | guard rejects (R-6, §5.3 item 11) | n/a |

Each test records the lock graph (`pg_locks`, `pg_stat_activity`) when blocked, so a hang is a diagnosed failure
and not a timeout.
