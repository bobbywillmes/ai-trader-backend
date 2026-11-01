# TradingView Phase 4A.2C3B.2: final-dispatch transaction contract

Status: **design for review. Nothing in this document is implemented.** C3B.1 is broker-inert and adds no
consumption writer, scheduler entry, broker adapter call or POST. Implementation of C3B.2 waits for review of
this contract.

Baseline: `1adddc9` (C3A) plus C3B.1. File references are to the current repository.

## 1. What exists, and what is missing

| Piece | Where | State today |
|---|---|---|
| Worker claim | `external_signal_broker_worker_claim_guard`, `processTradingViewOrderIntentForC2` | Written by C2/C3A. Atomically moves intent `pending→submitting`, claim `ENTRY_PENDING→ENTRY_SUBMITTING`, inserts `ExternalSignalBrokerWorkerClaim` and the `WORKER_CLAIMED_FOR_SUBMISSION` event. Then **always refuses** (`TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE`). |
| MI decision | `prepareObligatedDecision` (`market-policy-broker-dispatch.service.ts:205`) | Reusable as is. Own `READ COMMITTED` transaction; inserts an immutable `MarketPolicyBrokerDispatchDecision` with `dispatchExpiresAt ≤ evaluatedAt + 30 s`. Already requires `intent.status='submitting'` and an `ENTRY_SUBMITTING` unreleased claim. |
| MI consumption | `consumeDecision` (`:557`), trigger `validate_market_policy_broker_dispatch_consumption` | **Standalone** single-statement insert. For a marked intent the deferred `external_signal_dispatch_pair_check` rejects it at commit unless a TradingView consumption is in the same transaction. So the existing `authorizeDispatch` cannot be used for marked intents. |
| TV consumption | `ExternalSignalBrokerDispatchConsumption`, trigger `external_signal_broker_consumption_guard` | Table and guard exist; no writer. The guard checks the evidence graph, authorization `AUTHORIZED`, dispatch state version and generation, and that the MI row cites the same intent, client order ID and `brokerPostOpportunityId`. It does **not** check signal age, pause/kill switch, accepted EXIT, worker-claim exposure state, or claim events (see §5.3). |
| Pair check | `external_signal_dispatch_pair_check` (deferred constraint triggers on both tables) | Both rows or neither, at commit. |
| Unenforced path | `MarketPolicyBrokerUnenforcedDispatch` | Trigger-forbidden for marked intents. A marked intent **must** have an MI frozen obligation to ever be consumed. |
| Broker opportunity | `OrderIntentBrokerPostOpportunity` (+ events, comparison attempts) | Compare-only telemetry. Not authority. |

`brokerPostOpportunityId` is nullable on both consumption tables, and the TV guard already enforces
`mi.brokerPostOpportunityId IS NOT DISTINCT FROM tv.brokerPostOpportunityId`. That is sufficient to prove "the
same exact opportunity, or none" (§4). No schema change is needed for it.

**Open precondition to confirm before C3B.2 code:** `external-signal-entry-admission.service.ts` does not itself
reference MI obligations. C3B.2 must assert, before the decision phase, that the marked intent has a frozen
`OrderIntentMarketPolicyEnforcementObligation`. If it does not, the correct outcome is a definite-not-sent
refusal through the existing C2 refusal path (`TRADINGVIEW_MI_OBLIGATION_REQUIRED`), because no consumption
pair can ever be valid.

## 2. Minimal safe reuse of Market Intelligence code

Do not copy the evaluator or authority logic. Three small, behavior-preserving changes to
`market-policy-broker-dispatch.service.ts`:

1. **Export the decision phase unchanged.** `prepareObligated(db, request, intent, evaluator)` (and the stage
   error type) become exported as `prepareObligatedBrokerDecision`. It already contains authorization
   resolution, revision/generation/binding checks, the frozen-revision evaluation on the current composition,
   persistence of the decision and its gates, and the refusal bookkeeping (`technicalRefusal`, `denialRefusal`).
   TradingView calls it as the *decision phase* and gets a `DecisionResult` back.
2. **Split `consumeDecision` into an in-transaction primitive.** Add
   `insertMarketPolicyDispatchConsumption(tx, decision, request, brokerPostOpportunityId)` (the body of today's
   `consumeDecision`, taking a transaction client). `consumeDecision(db, …)` becomes
   `db.marketPolicyBrokerDispatchConsumption.create(...)`-equivalent via that primitive in its own
   single-statement transaction, so unmarked behavior and its tests are byte-identical.
3. **Fail closed on the wrong entry point.** In `prepareEntryBrokerDispatch`, if the loaded intent is marked
   (`externalSignalAccountCycleId IS NOT NULL`), refuse before any decision with a technical, not-sent refusal
   (`TRADINGVIEW_REQUIRES_PAIRED_CONSUMPTION`). A marked intent therefore cannot reach the standalone
   `consumeDecision`, even by a future caller mistake. The deferred pair check already makes it fail at commit;
   this makes it fail early and legibly.

TradingView owns only: `finalizeTradingViewDispatch(...)` (new, in the broker-worker service). It composes
"decision phase (MI) → final paired transaction (TV)". The MI evaluator, composition logic and gate persistence
are never reimplemented.

**Why not call `prepareEntryBrokerDispatch` and wrap its `authorizeDispatch`?** Its re-evaluation-on-refusal loop
(`:630-647`) is the right behavior but it commits the MI consumption as a standalone statement. For marked
intents we need the consumption to be a statement inside the TradingView transaction, so the loop moves to the
TV orchestrator, which is the only place that can retry the whole pair.

## 3. Phases and the final transaction

```
 D  decision phase   MI prepareObligatedBrokerDecision        READ COMMITTED, own tx, commits
 F  final transaction  TV finalizeTradingViewDispatch          SERIALIZABLE, explicit locks, commits
 A  adapter           (C3C) client-order-ID lookup, then one POST
 O  observation       broker order / activity sync, recovery  (existing)
```

D produces a decision whose `dispatchExpiresAt` is at most 30 s away; F must commit before it. Neither phase
sends anything. The adapter is a later phase (C3C) and is **only** reachable after F committed.

### 3.1 Phase F, in order

Isolation `SERIALIZABLE` (the claim transaction's level and the reason the consumption guard's comment says
stale snapshots abort), bounded to three attempts with the classifier from C3B.1 and a fresh transaction each
attempt. All locks are taken **before** any validation read, in the canonical order of §6, so the snapshot is
established after the locks and "re-lock of own rows" inside the DB triggers never waits.

1. Lock the TradingView rollout (advisory, exclusive) and the rollout/dispatch state rows (§6 rows 1–3).
2. Re-read and validate: dispatch state active, `activatedAt` set, `version` equals the claim's
   `dispatchStateVersion`, generation equals the claim's and the obligation's frozen generation.
3. Lock source/binding/cycle/account-cycle, then the identity chain (TradingAccount → assignment →
   Subscription → Security), then the MI rollout share lock and the latest MI authorization share lock (§6).
4. Lock the exact `OrderIntent` row `FOR UPDATE`, then the `EntryExposureClaim` row `FOR UPDATE` (intent before
   claim).
5. Validate exactly: the worker claim row for this intent (fingerprint, obligation, account cycle, client order
   ID, generation, state version); intent `submitting`; claim `ENTRY_SUBMITTING`, unreleased, no tracked
   position; the claim's `WORKER_CLAIMED_FOR_SUBMISSION` event cites this worker claim; no
   `NOT_SENT/ADAPTER_INVOCATION_STARTED/DISPATCH_OUTCOME/BROKER_DELIVERY_UNCERTAIN` event; no existing MI/TV
   consumption, unenforced dispatch, `BrokerOrder`, `BrokerActivity` or non-compare opportunity event.
6. Validate current eligibility from the locked rows: PAPER account, `ACTIVE`, `tradingEnabled`, not
   `killSwitchEnabled`, not `tradingBlocked` (**pause = status ≠ ACTIVE → refuse**), assignment
   `enabled && entriesEnabled`, Subscription/Security/Strategy/ExitProfile enabled, allocation enabled and
   account-matched, source enabled, binding enabled, revision `ACTIVE`/`TRADE_ELIGIBLE`, authorization
   `AUTHORIZED` with the obligation's fingerprint, and no accepted `EXIT_LONG` on the cycle or `pendingExitAcceptedAt`
   / terminal account-cycle state. No open `TrackedPosition` for account + Security.
7. Enforce the 120 s limit with **PostgreSQL time**: `statement_timestamp()`/`clock_timestamp()` against the
   entry `Signal.createdAt` (converted explicitly from UTC) inside this transaction, never the application
   clock. Today the C2 pre-check uses `Date.now()`; F supersedes it.
8. Validate the MI decision `D` produced: `outcome='ALLOWED'`, `dispatchDisposition='DISPATCH_AUTHORIZED'`, the
   highest `dispatchSequence` for the intent, `clock_timestamp() < dispatchExpiresAt` with a safety margin (§3.2),
   `clientOrderId` equals the claim's.
9. Insert the MI consumption via `insertMarketPolicyDispatchConsumption(tx, …)`, then the TV consumption
   (`workerClaimId`, `marketPolicyDispatchConsumptionId`, `executionObligationId`, `executionAuthorizationId`,
   `rolloutGenerationId`, `dispatchStateVersion`, same `clientOrderId`, same nullable `brokerPostOpportunityId`).
   Insert order is MI first because the TV row's FK and guard read the MI row.
10. Commit. The deferred pair check runs now. **No broker request is made inside F or before F committed.**

If F aborts for any reason it leaves no consumption and the intent remains `submitting` with an unreleased
`ENTRY_SUBMITTING` claim, which is exactly the C2/C3A "stranded worker claim" state that recovery already
handles (§7).

### 3.2 Decision freshness and the 120 s rule

`D` and `F` are separated so that market evaluation (reads, possibly slow) is not inside the serialized lock
window. `F` therefore re-checks time twice: signal age ≤ 120 s, and `clock_timestamp() < dispatchExpiresAt -
margin` where `margin` is a small constant (proposed 2 s) so the adapter has at least that much window left
only as a courtesy, not as authority. The MI consumption trigger already re-checks `clock_timestamp() <
dispatchExpiresAt`. If either fails, F rolls back, and the orchestrator may run `D` once more (fresh decision,
older one is closed by the later `dispatchSequence`) and retry F, **once**, within the 120 s signal bound.
Otherwise it records a definite-not-sent refusal through the existing `refuseAndRelease` path.

The frozen 120 s signal limit must also be a database invariant (§5.3, item 1), not only a service check.

## 4. Broker-opportunity semantics

| Concept | Record | Meaning | Authority? |
|---|---|---|---|
| Compare-only telemetry | `OrderIntentBrokerPostOpportunity` (`comparisonMode='COMPARE_ONLY'`, `tradingEffect='NONE'`) and its events | "At this moment a POST could have happened; here is what policy would have said." Best effort; may be missing, deferred or stale. | **No.** Never gates, never releases, never proves non-send. |
| Final authoritative consumption | `MarketPolicyBrokerDispatchConsumption` + `ExternalSignalBrokerDispatchConsumption` committed together | A single-use, database-linearized permission to *attempt* one POST for this intent. | Yes, for permission only. **Not proof of broker receipt**, and it never recalls an in-flight request. |
| Adapter invocation | `ADAPTER_INVOCATION_STARTED` claim event (written immediately before the HTTP call, C3C) | The process may have started the request. | Evidence of possible delivery; blocks release. |
| Observed broker state | `BrokerOrder` / `BrokerActivity` | The broker has something for this client order ID. | Authoritative evidence of delivery. |

`brokerPostOpportunityId` is **sufficient as is**:

* It is nullable on both consumption rows, so a missing or deferred observation never blocks and never
  authorizes (best-effort observation must not become execution authority).
* The TV guard already requires equality with the MI row's value (`IS NOT DISTINCT FROM`), and the MI trigger
  already requires that a cited opportunity belongs to the same `orderIntentId`.
* To cite an opportunity, F selects the **latest** `OrderIntentBrokerPostOpportunity` for the intent in the same
  transaction (after the intent lock) and passes the *same* value to both inserts. If none exists, both are
  `NULL`. If observation creation races F, the worst outcome is `NULL`, never a mismatch.
* Citing an opportunity adds no gate: the opportunity's own comparison result is deliberately ignored by F.

No new column or table is required. A possible later hardening (not proposed now) is a trigger forbidding a
consumption to cite an opportunity created after the consumption's decision; it is not needed for safety
because the opportunity carries no authority.

## 5. Failure, crash and retry matrix

"State" is the durable state after the event. "Intent" is the OrderIntent, "Claim" is the exposure claim.

| # | Event | Durable state | Next action |
|---|---|---|---|
| 1 | Failure before F (including D failing or refusing) | D may have written a decision (`ALLOWED` or not) and `MarketPolicyBrokerDispatchDecision` rows only. Intent `submitting`, claim `ENTRY_SUBMITTING` (worker claim exists). No consumption. | A refused decision → existing `refuseAndRelease` records `NOT_SENT_EVIDENCE_RECORDED` (`producer` from the closed set) and blocks the intent; claim then releases through the C3A not-sent path. A technical failure → same. An `ALLOWED` decision with no F is harmless (a later decision supersedes it). |
| 2 | Revocation during validation | Revoke takes `rollout advisory → source → binding → authorization FOR UPDATE`. F holds rollout advisory, so one fully precedes the other. If revoke wins, F sees `status<>'AUTHORIZED'` (or `40001` at SERIALIZABLE) and rolls back; if F wins, consumption commits and the revoke commits after (cannot recall an in-flight request, as documented for MI). | Revoke-first: refuse, not-sent. F-first: proceeds; revoke only affects later intents. |
| 3 | Accepted EXIT racing authorization | EXIT correlation locks `source → binding → trade cycle → account cycle` and sets `EXIT_PENDING`. F locks the same four rows in the same order **before** checking, so exactly one wins. EXIT-first: F refuses (`TRADINGVIEW_EXIT_ACCEPTED`), not-sent. F-first: consumption commits; EXIT remains `EXIT_PENDING` and is honored by exit handling after delivery is reconciled (no exit is "lost", but entry exposure is retained). | Documented ordering in §6; tested in C3B.2 by interleaving. |
| 4 | Deactivation while locks are held | Rollout/dispatch deactivation takes the same rollout advisory lock and updates the state rows. It waits for F to commit or aborts F (`40001`). After F commits, deactivation applies to future work only. | F-first consumption is valid; deactivation-first → F refuses (`activeRolloutGenerationId` mismatch), not-sent. |
| 5 | Signal expiration during lock waits | F evaluates age only after all locks are held, with the DB clock. | Expired → rollback, definite not-sent refusal (`TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`), claim released through the C3A path. |
| 6 | Duplicate workers | Second worker's claim `INSERT` hits the `orderIntentId` unique (`P2002`) → `NOT_CLAIMED` (C2). If both are past the claim: F's locks serialize them; the second sees an existing consumption (step 5) or unique violation on `orderIntentId`/`workerClaimId`/`decisionId` and aborts with no effect. | No second consumption can exist (four unique constraints). |
| 7 | F commits but the acknowledgment is lost | Both consumptions exist. Intent `submitting`, claim `ENTRY_SUBMITTING`. | On any failure after a possible commit, the orchestrator first reads `externalSignalBrokerDispatchConsumption` by `orderIntentId`. If present it **must not** POST from this attempt (`EntryDispatchRecordedNotSentError` pattern, as MI does in `throwIfDispatchRecorded`); it records dispatch-outcome-unknown and hands the intent to recovery/C3C. |
| 8 | Process crashes immediately after F | Same as row 7, plus no `ADAPTER_INVOCATION_STARTED` event. | Stale recovery sees a consumption: it already treats "a committed dispatch record" as `DISPATCH_OUTCOME_UNKNOWN`, retains exposure, never resends, and opens the (C3A) delivery-uncertainty attention. The C3C reconciler looks the order up by client order ID. |
| 9 | Alpaca already has this client order ID | C3C performs the client-order-ID lookup **before** the first POST (as the legacy worker does) and again on any ambiguity. If found: link `BrokerOrder`, advance claim to `BROKER_ORDER_ACTIVE`, never POST. | Reconcile only; no new consumption is created or required. |
| 10 | F aborts with a retryable DB error (`40001`/`40P01`) | Nothing durable from F. | Up to three attempts, fresh transaction each; then refuse as technical not-sent. Non-retryable classification (lookalikes) fails closed. |

**Successful consumption is never treated as proof of broker receipt**, in code, docs or recovery. Recovery
reads consumption as "possible delivery" (retain exposure), exactly as C3A's
`loadTradingViewDeliveryUncertainty` already does.

## 5.3 Database invariants C3B.2 should add (new forward-only migration, proposed)

The TV consumption guard is the last line of defense if a service bug or a second writer slips through. It
should additionally enforce, inside `external_signal_broker_consumption_guard` (replacing the function and
restating the trusted `search_path`):

1. `statement_timestamp()` ≤ entry `Signal.createdAt` (UTC) + 120 s.
2. Account `ACTIVE`, `tradingEnabled`, not `killSwitchEnabled`, not `tradingBlocked`; assignment/Subscription/
   Security enabled.
3. No `EXIT_LONG` on the source cycle; account cycle not `EXIT_PENDING`/terminal.
4. Claim `ENTRY_SUBMITTING`, unreleased, owner event cites this worker claim, no contradictory events,
   intent `submitting`.
5. Intent row locked `FOR UPDATE` before the claim row (so terminalizers serialize; today the MI trigger reads
   them unlocked).
6. `current_setting`-free: nothing session-configurable can relax any of these.

Until that migration exists, the service-level checks in §3.1 are the only enforcement for items 1–3, which is a
reason to treat C3B.2 as "service + migration", not service alone.

## 6. Lock-acquisition table for phase F

Order is top to bottom; an item may not be acquired after a later one. "Implicit" locks are taken by triggers
or FK checks during the statement named.

| # | Lock | Mode | Taken by | Notes / matches |
|---|---|---|---|---|
| 1 | Advisory `hashtext('external-signal-execution-rollout')` | exclusive | F explicitly (and again, re-entrantly, by the claim and consumption triggers) | Same key as rollout create/activate/deactivate, authorization grant/revoke, worker claim, unclaimed refusal. Serializes **all** TV dispatch globally. Acceptable for a PAPER canary; revisit before scale. |
| 2 | `ExternalSignalExecutionRolloutState` id=1 | FOR UPDATE | F; claim guard | Same as claim. |
| 3 | `ExternalSignalBrokerDispatchState` id=1 | FOR UPDATE | F; consumption guard (implicit) | Same as claim and consumption guard. |
| 4 | `ExternalSignalSource` | FOR UPDATE | F | Order of EXIT correlation and authorization revoke: source → binding. |
| 5 | `StrategySignalBinding` | FOR UPDATE | F | |
| 6 | `ExternalSignalTradeCycle` (source cycle) | FOR UPDATE | F | EXIT correlation order: … → cycle. |
| 7 | `ExternalSignalTradeCycleAccount` | FOR UPDATE | F | EXIT correlation: cycle → account cycle. |
| 8 | `ExternalSignalEntryExecutionAuthorization` | FOR UPDATE | F; consumption guard (implicit) | Revoke order: source → binding → authorization. (Rows 4–5–8 are in the same relative order as revoke; row 6–7 after, as correlation. No path takes 6–7 before 4–5.) |
| 9 | `TradingAccount` | FOR KEY SHARE | F | Matches MI admission/broker-decision order (identity chain). The claim guard locks it `FOR UPDATE`; F uses the weaker mode because F never mutates identity rows. |
| 10 | `TradingAccountSubscription` | FOR KEY SHARE | F | |
| 11 | `Subscription` | FOR KEY SHARE | F | |
| 12 | `Security` | FOR KEY SHARE | F | |
| 13 | `MarketPolicyEnforcementRuntimeRollout` id=1 | FOR SHARE | F via `lockMarketPolicyEnforcementRollout` | MI order position 1; here after TV rollout. See inversion note A. |
| 14 | Latest `AssignmentMarketPolicyEnforcementAuthorization` for the assignment | FOR SHARE | F via `resolveLockedAssignmentMarketPolicyEnforcement`; MI consumption trigger (implicit) | MI order: rollout, account, assignment, Subscription, Security, authorization. |
| 15 | Advisory `entry-exposure:<account>:<security>` | exclusive | F | Same key as admission, claim, recovery, release, remediation. |
| 16 | `OrderIntent` row | FOR UPDATE | F | **Intent before claim**, as required. |
| 17 | `EntryExposureClaim` row | FOR UPDATE | F | Fence trigger paths also update it. |
| 18 | `ExternalSignalBrokerWorkerClaim` row | FOR SHARE | F | Immutable; read-lock prevents none but pins identity for FK checks. |
| 19 | New rows: MI consumption, TV consumption (and their FK targets: decision, obligation, worker claim, opportunity, authorization, generation) | KEY SHARE (implicit, FK) | inserts | `ExternalSignalBrokerDispatchConsumption` guard also locks authorization `FOR UPDATE` (row 8, already held). |

### Inversions and hazards found (for review, not fixed here)

* **A. TV rollout advisory (row 1) before MI rollout row (row 13).** MI admission/broker-decision takes the MI
  rollout row first. No existing path takes the MI rollout row **then** the TV advisory lock (MI rollout
  transitions take `User FOR SHARE → MI rollout`, never the TV advisory), so no cycle exists today. Add a
  test and keep it that way: **nothing may take the MI rollout lock and then the TV rollout advisory lock.**
* **B. Exposure advisory vs `OrderIntent` row (rows 15–16).** `recoverTerminalEntryClaims`/dispatch recovery
  (`entry-dispatch-recovery.service.ts:1017-1030`) takes *exposure advisory → `FOR UPDATE OF i`*. C2's worker
  claim trigger takes the `OrderIntent` row *before* the exposure advisory lock, and `refuseAndRelease` takes
  the intent row alone. F as specified follows the claim trigger (row 16 after 15) — i.e. advisory first — so F
  *agrees with recovery* and **disagrees with the C2 claim's implicit order**. A deadlock between a claim and a
  recovery on the same intent is therefore already theoretically possible (PostgreSQL resolves it by aborting
  one with `40P01`, which the classifier treats as retryable; it is not a safety violation). Recommendation: in
  F, take row 15 before row 16 (as in the table) and, in C3B.2, also make the worker-claim transaction take the
  exposure advisory lock before the claim trigger fires so all writers share one order. This is a service
  change to `processTradingViewOrderIntentForC2`, not a migration.
* **C. Multi-relation `FOR UPDATE OF …` in the claim guard.** The guard locks ~16 relations in one statement;
  PostgreSQL locks them in plan order, which is not guaranteed to be the §6 order. Because F takes every one of
  those rows in canonical order **first** (rows 2–12, 16–17), the guard's later `FOR UPDATE` finds them already
  held and never waits. That is a hard requirement of F, not an optimization: do not remove the pre-locking.
* **D. Unlocked reads in the MI consumption trigger.** `validate_market_policy_broker_dispatch_consumption`
  reads the intent and claim without locking them. F's rows 16–17 close that for TradingView; the MI trigger
  itself is unchanged (unmarked behavior must not change).
* **E. Authorization revoke vs F.** Revoke locks `source → binding → authorization` under the rollout advisory
  lock; F follows the same relative order. No inversion.
* **F. EXIT ingestion.** Correlation does not take the rollout advisory lock at all (it takes
  `source → binding → cycle → account cycle`). F's rows 4–7 use that order. Consequence: an EXIT and F can
  interleave only at rows 6–7, which both take in the same order, so the second waits and then re-reads.
* **G. Global serialization.** Row 1–3 make all TV dispatch single-file. That is intentional for the canary and
  is also why a stuck transaction can stall dispatch: set `lock_timeout` (proposed 5 s) and
  `idle_in_transaction_session_timeout` on F; a timeout is a retryable refusal.

## 7. Recovery interaction

C3A already guarantees the following, and C3B.2 must not weaken any of it:

* Any consumption, `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`, `BROKER_DELIVERY_UNCERTAIN`,
  `BrokerOrder` or `BrokerActivity` makes the claim's exposure **retained**, never auto-released, and opens one
  deduplicated `AUTHORITATIVE_ONLY` attention episode (`external-signal-delivery-attention.service.ts`), now
  also for accounts with unusable credentials (C3B.1).
* `external_signal_exposure_claim_c2_guard` forbids releasing a consumed marked claim through the pre-dispatch
  path; `external_signal_exposure_claim_delete_guard` (C3B.1) forbids deleting it.
* Stale recovery treats a committed dispatch record as `DISPATCH_OUTCOME_UNKNOWN` and never resends.

## 8. What stays for later

* **C3B.2:** this contract, the three MI-service refactors, `finalizeTradingViewDispatch`, the consumption-guard
  migration (§5.3), and interleaving tests (revoke/EXIT/deactivate/expiry/duplicate/commit-loss/crash).
* **C3B.3:** worker scheduling and rollout/activation operations, still with the adapter disabled.
* **C3C:** broker adapter invocation (client-order-ID lookup, single POST, `ADAPTER_INVOCATION_STARTED`
  marker), authoritative reconciliation and the only release path for retained exposure.
* **Before any canary:** broker-enabled readiness (`npm run db:security-preflight -- --mode=broker-enabled`
  green on the real runtime role), the role cutover and TEMPORARY revocation applied and verified, resolution of
  hazard B, the confirmed MI-obligation precondition (§1), a defined global kill procedure, and a rehearsal on
  PAPER with the activation epoch.
