# TradingView Phase 4A.2C3B.2: final-dispatch transaction contract

Status: **design, revision 3, for review. Nothing in this document is implemented.** C3B.1 is broker-inert and
adds no consumption writer, scheduler entry, broker adapter call or POST. Implementation of C3B.2 waits for review
of this contract. No broker call is authorized in any checkpoint covered by this document.

Revision 2 corrected the first draft after an independent PostgreSQL 16/17 audit. Revision 3 corrects revision 2
after a second audit (16.15 and 17.5) that proved two of its statements false:

* **[R3-A]** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger is **not** a commit-time guarantee, so the claim
  that PostgreSQL trigger timing keeps final consumption inside the signal's 120-second life is removed. Freshness
  is redesigned as two boundaries, **F** (durable final authorization, §3.2) and **C3C** (the actual broker-send
  boundary, §3.6).
* **[R3-B]** The canonical lock order contained a reproducible `40P01` between the execution authorization and the
  account/assignment/Subscription/Security identity rows. It is corrected (§6).
* **[R3-C]** The "row-version fence" had no enforceable definition. It now has one, chosen after disposable probes
  (§3.4); `xmin` is rejected on evidence.
* **[R3-D]** Several transaction descriptions were inaccurate (§3.1).

Corrections are marked **[R2]** (revision 2, retained) or **[R3]** (this revision). File references are to the
current repository. Baseline: `1adddc9` (C3A) plus C3B.1.

## 1. What exists, and what is missing

| Piece | Where | State today |
|---|---|---|
| Worker claim | `external_signal_broker_worker_claim_guard`, `processTradingViewOrderIntentForC2` | Written by C2/C3A. Atomically moves intent `pending→submitting`, claim `ENTRY_PENDING→ENTRY_SUBMITTING`, inserts `ExternalSignalBrokerWorkerClaim` and the `WORKER_CLAIMED_FOR_SUBMISSION` event. Then **always refuses** (`TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE`). |
| MI decision | `prepareObligatedDecision` (`market-policy-broker-dispatch.service.ts:205`) | Reusable as is. Own `READ COMMITTED` transaction; inserts an immutable `MarketPolicyBrokerDispatchDecision` with `dispatchExpiresAt ≤ evaluatedAt + 30 s`. Already requires `intent.status='submitting'` and an `ENTRY_SUBMITTING` unreleased claim. |
| MI consumption | `consumeDecision` (`:557`), trigger `validate_market_policy_broker_dispatch_consumption` | **Standalone** single-statement insert. For a marked intent the deferred `external_signal_dispatch_pair_check` rejects it at commit unless a TradingView consumption is in the same transaction. So the existing `authorizeDispatch` cannot be used for marked intents. |
| TV consumption | `ExternalSignalBrokerDispatchConsumption`, trigger `external_signal_broker_consumption_guard` | Table and guard exist; no writer. The guard takes the rollout advisory lock, locks `ExternalSignalBrokerDispatchState` and the authorization `FOR UPDATE`, and checks the evidence graph, authorization `AUTHORIZED`, dispatch state version and generation, and that the MI row cites the same intent, client order ID and `brokerPostOpportunityId`. It does **not** check signal age, pause/kill switch, accepted EXIT, worker-claim exposure state, or claim events (see §5.3). |
| Pair check | `external_signal_dispatch_pair_check` (deferred constraint triggers on both tables) | Both rows or neither. Its deferral only affects *when* atomicity is checked; see §3.5 for why that is fail-closed. |
| Unenforced path | `MarketPolicyBrokerUnenforcedDispatch` | Trigger-forbidden for marked intents. A marked intent **must** have a frozen MI obligation to ever be consumed. |
| Broker opportunity | `OrderIntentBrokerPostOpportunity` (+ events, comparison attempts) | Compare-only telemetry. Not authority. |

`brokerPostOpportunityId` is nullable on both consumption tables, and the TV guard already enforces
`mi.brokerPostOpportunityId IS NOT DISTINCT FROM tv.brokerPostOpportunityId`. That is sufficient to prove "the
same exact opportunity, or none" (§4). No schema change is needed for it.

### 1.1 Market Intelligence obligation: confirmed chain and what the database does not guarantee **[R2]**

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

## 3. Phases and the two authorization boundaries

```
 P  pre-checks        MI obligation present (§1.1), signal age early-out              READ COMMITTED, reads only
 D  decision phase    MI prepareObligatedBrokerDecision                               READ COMMITTED, own tx, commits
 F  FINAL AUTHORIZATION  TV finalizeTradingViewDispatch                               SERIALIZABLE, ordered locks, commits
 ── C3B.2 ends here: a durable, deadline-bounded permission to ATTEMPT one dispatch. No adapter exists. ──
 S  send permit       (C3C) lookup, then a unique, database-enforced send decision    READ COMMITTED, explicit locks
 A  adapter           (C3C) one POST, only after S committed and the deadline re-read
 O  observation       broker order / activity sync, reconciliation                    (existing)
```

D produces a decision whose `dispatchExpiresAt` is at most 30 s away; F must insert before it. Neither phase
sends anything. S and A are C3C and are reachable **only** after F committed.

### 3.1 Snapshot, isolation and lock semantics: what PostgreSQL does and what the code does today **[R3]**

PostgreSQL facts, reproduced by the independent audit on 16.15 and 17.5 and by the disposable probes of §10 on
16.13 and 17.11:

1. A `SERIALIZABLE` transaction takes its snapshot when its **first statement starts**, not after locks are
   granted. If that first statement is the advisory lock, the snapshot is taken *before* the statement may block.
   **The initial SERIALIZABLE snapshot can therefore precede advisory-lock waits**, by seconds. The worker claim
   transaction (`external-signal-broker-worker.service.ts:92-111`, `Serializable`) is exactly this shape.
2. Advisory locking does not refresh the snapshot. A plain `SELECT` after the wait still sees pre-wait data. A
   committed revoke, pause or EXIT that landed during the wait is invisible to plain reads.
3. A **row lock** (`FOR UPDATE`/`FOR SHARE`) on a row whose latest committed version is newer than the snapshot
   fails with `40001`. A row-version write (`UPDATE`) fails the same way. A row that was merely *locked* (not
   modified) by a committed transaction does **not** fail: its version is unchanged.
4. **`FOR SHARE` is needed, not `FOR KEY SHARE`, against ordinary non-key identity updates.** `FOR KEY SHARE`
   conflicts only with `FOR UPDATE` and key changes/`DELETE`. A kill-switch flip, `enabled=false` or `status`
   change is a non-key `UPDATE` (`FOR NO KEY UPDATE`), which does not conflict with `FOR KEY SHARE`. A fence
   meant to detect those updates must be `FOR SHARE` (conflicts with `FOR UPDATE` and `FOR NO KEY UPDATE`).
5. Absence checks ("no accepted EXIT", "no earlier event/consumption/BrokerOrder") on a plain read are only
   protected by SERIALIZABLE's predicate tracking, which aborts some, **not all**, anomalies, and **not** the
   case where a competitor only *locked* a parent row and inserted evidence (probe P1, §10). They must not be the
   sole fence (§3.4).
6. **A serialization failure (`40001`) or deadlock (`40P01`) aborts the transaction. The retry is a new
   transaction with a new snapshot. It never makes the old transaction see the new values.** "F observed the
   revoke" always means "F aborted and a fresh transaction decided".
7. Inside a SERIALIZABLE (or REPEATABLE READ) transaction, statements run by triggers use the transaction
   snapshot, not a fresh one. A guard's plain reads are therefore as stale as the caller's snapshot unless they
   are locking reads or are protected by the fence (§3.4). Inside READ COMMITTED each statement, including a
   trigger's, takes a fresh snapshot.

What the code does today (the earlier draft misdescribed this):

| Path | Where | Isolation today |
|---|---|---|
| Worker claim | `external-signal-broker-worker.service.ts:92-111` | `Serializable` |
| Unclaimed refusal (`terminalizeUnclaimedRefusal`) | same file `:152-169` | `Serializable` |
| **`refuseAndRelease`** | same file `:184` | **READ COMMITTED** (no isolation option; Prisma/PostgreSQL default) |
| **Stale recovery** (`entry-dispatch-recovery.service.ts` `:443`, `:1016`, `:1147`) | | **READ COMMITTED** |
| Admission | `market-policy-entry-admission.service.ts:517` (`ADMISSION_TRANSACTION`: timeouts only) | **READ COMMITTED** (default); its first statement is the rollout advisory lock |
| Authorization grant / revoke / activate | `external-signal-execution-authority.service.ts` | `Serializable` |
| EXIT correlation | `external-signal-correlation.service.ts:117` | `ReadCommitted` |

Consequence for revision 2's R-3/R-5: it described the racing refusers as SERIALIZABLE. Only the unclaimed refusal
is. `refuseAndRelease` and stale recovery are READ COMMITTED, so against them F gets **no `40001`**: a READ
COMMITTED competitor either waits for F's row locks and then re-reads fresh data, or commits first and is seen
only if F holds a locking/fence read taken after it. The contract below is written to be correct for every
combination of isolation levels (R-6), and the tests of §9 run each pair in both directions.

### 3.2 Boundary F: durable final authorization **[R3]**

F answers one question: *"is it permitted, right now, to attempt exactly one dispatch of this intent?"* It
produces a durable, single-use, **deadline-bounded permission** and nothing else.

F:

* validates signal freshness with the **PostgreSQL clock** (`clock_timestamp()`) in the database guard, as close
  to authorization as practical (the `BEFORE INSERT` guard of the TV consumption), and re-checks it in the last
  statement before `COMMIT` as a courtesy;
* creates **exactly one atomic MI/TradingView consumption pair**;
* stores an **immutable authorization deadline**, `authorizationDeadlineAt`, stamped by the database, never later
  than the original signal's creation plus 120 seconds (§3.5);
* grants permission for a **bounded dispatch opportunity** (§3.6);
* **does not imply that a broker call occurred**, and is not proof of delivery;
* **does not rely on any commit-time trigger guarantee.** PostgreSQL does not provide one (§3.7, probe P3).

F does not assert that the final consumption *commits* within 120 s of the signal. It asserts that the permission
it creates **expires by itself** and is useless after `authorizationDeadlineAt`, whatever happens to the commit.

### 3.3 Phase F, in order

Isolation `SERIALIZABLE`, bounded to three attempts with the C3B.1 retry classifier and a fresh transaction each
attempt (a retry is the only way to obtain a fresh snapshot). `lock_timeout` 5 s and
`idle_in_transaction_session_timeout` set for F; a timeout is a retryable refusal.

1. Take the §6 locks in canonical order, **one single-table statement per relation**, strongest mode any trigger
   will later request (no upgrades: SHARE→UPDATE upgrades deadlock). Identity rows are taken **before** the
   authorization (§6).
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
   locked MI obligation, `clock_timestamp() < dispatchExpiresAt` minus a small margin (§3.5).
6. **Fence (§3.4):** `SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE`. This
   is the version-changing-operation proof. Remember `v`.
7. Insert the MI consumption via `insertMarketPolicyDispatchConsumption(tx, …)`, then the TV consumption
   (`workerClaimId`, `marketPolicyDispatchConsumptionId`, `executionObligationId`, `executionAuthorizationId`,
   `rolloutGenerationId`, `dispatchStateVersion`, same `clientOrderId`, same nullable `brokerPostOpportunityId`,
   and `fenceVersion = v`). The `BEFORE INSERT` guard **stamps** `authorizedAt = clock_timestamp()` and
   `authorizationDeadlineAt` (§3.5) and rejects any caller-supplied value for them.
8. Last statement: `SELECT external_signal_assert_authorization_open(<consumption id>)`, a non-deferred, advisory
   check that `authorizationDeadlineAt − clock_timestamp()` is still at least the minimum send window. On failure
   the service rolls back. **This is a courtesy to avoid creating a permission that is already nearly expired. It
   is not a guarantee and no safety property depends on it.**
9. `COMMIT`. **No broker request is made inside F or before the permit of §3.6.**

The service-level checks in steps 2–5 give legible errors; the database guard of §5.3 is the authority.

If F aborts for any reason it leaves no consumption, and the intent remains `submitting` with an unreleased
`ENTRY_SUBMITTING` claim: the C2/C3A "stranded worker claim" state that recovery already handles (§7).

### 3.4 The row-version fence: a concrete, enforceable mechanism **[R3]**

**Problem.** F runs SERIALIZABLE, so its validation reads use the pre-lock snapshot (§3.1 items 1, 2, 7). The
dangerous competitor is one that writes *evidence* (a `NOT_SENT_EVIDENCE_RECORDED` event, a `BrokerOrder`, a newer
decision) after F's snapshot. Revision 2 proposed that F "touch" the intent and claim so a racing terminalizer
would produce `40001`. **That does not work, and the second audit's concern is correct:** the evidence fence
trigger locks the claim `FOR UPDATE` and inserts the event, but never writes a new version of the claim. A
SERIALIZABLE transaction that later `UPDATE`s that claim succeeds without `40001` and still cannot see the event
(probe P1 below: touch outcome `ok`, events seen `0`).

**Candidate rejected on evidence: `xmin`.** Checking that the intent/claim row's `xmin` equals the current
transaction id proves only that *this transaction wrote that row*. Disposable probes on PostgreSQL 16.13 and 17.11
show it (a) is satisfied while a lock-only competitor's evidence is invisible (P1), (b) is **false** when the write
happens in a subtransaction (a `plpgsql` `EXCEPTION` block yields a subtransaction id, probe P1b), and (c) compares
a 32-bit `xid` with a 64-bit `xid8` (truncation, wraparound). It cannot detect the hazard it was proposed for, so
it is **not approved** and is not part of this design. Any future reconsideration requires the probes listed at
the end of this section on both versions and the real Prisma isolation level.

**Selected mechanism: a database-maintained dispatch fence counter.**

* New table `ExternalSignalDispatchFence`: `orderIntentId` primary key (FK), `version bigint NOT NULL`. Created at
  version `1` by the `OrderIntent` insert trigger for a marked intent, so it exists before any competitor.
* A trigger function `external_signal_dispatch_fence_bump()` runs `UPDATE "ExternalSignalDispatchFence" SET
  version = version + 1 WHERE "orderIntentId" = <intent>` as an **AFTER ROW** trigger on every table whose change
  could invalidate F's decision, **only for marked intents** (a `WHEN` clause or an early return): `OrderIntent`
  (update), `EntryExposureClaim` (insert/update/delete), `EntryExposureClaimEvent` (insert),
  `ExternalSignalBrokerWorkerClaim`, `MarketPolicyBrokerDispatchDecision`, `MarketPolicyBrokerDispatchConsumption`,
  `ExternalSignalBrokerDispatchConsumption`, `MarketPolicyBrokerUnenforcedDispatch`, `BrokerOrder`,
  `BrokerActivity`, and non-compare `OrderIntentBrokerOpportunityEvent`. Because the bump is *the fence row's own
  new version*, it is a version-changing write that conflicts with any SERIALIZABLE reader that locks it, whatever
  the writer's isolation level and even when the writer only locked the claim.
* The fence table is guarded: it accepts only `+1` updates issued from trigger context (`pg_trigger_depth() > 1`),
  and forbids direct update of other columns, `DELETE` and `TRUNCATE` (role privilege, C3B.1).
* F locks the fence row `FOR UPDATE` (step 6). In a SERIALIZABLE transaction this raises `40001` if any fenced
  write committed after F's snapshot. Otherwise the snapshot is, for every fenced table, as current as the fence,
  so F's plain absence checks (step 3) are sound.
* F records `fenceVersion = v` on the TV consumption. The `BEFORE INSERT` guard locks the fence `FOR UPDATE` itself
  (re-entrant after F's own lock) and **rejects the insert unless `NEW.fenceVersion = fence.version`**. A service
  that skipped step 6, supplied a stale value, or raced a fenced write fails closed. The consumption inserts
  themselves bump the fence (they are in the fenced set), so the stored `fenceVersion` is the version F validated
  against, and later paths can tell whether anything changed since authorization.
* The guard is correct at READ COMMITTED too (the lock returns the latest version and the equality still holds),
  so it never depends on the caller's isolation level (R-6).

**Cost and hazards.** Every fenced write for a marked intent also writes the fence row, so the fence is a
lock-order participant. It is the **last** lock a writer naturally takes (intent, claim, then the AFTER-trigger
bump), and the canonical position is row 24 of §6.2. Writers that touch `BrokerOrder`/`BrokerActivity` *before*
locking the intent (order sync) would invert it; §6.5 lists this as a prerequisite audit with deadlock probes. An
inversion is a nondeterministic `40P01` (one side aborts, fail-closed), never a safety bypass.

**Proof obligations before this mechanism is approved for implementation** (none is assumed; each is a test in §9):

| Concern | Required proof (PostgreSQL 16 **and** 17) |
|---|---|
| Version conflict | SERIALIZABLE F's fence lock fails `40001` after a committed bump, including when the bumping writer only locked the claim (reproduces probe P1 with the real tables). |
| Real Prisma isolation | The same through `prisma.$transaction(..., { isolationLevel: 'Serializable' })` and the pg driver adapter in use. |
| Trigger and FK behavior | Bumps fire from AFTER triggers inside FK-check and `ON CONFLICT` paths; no recursion; bump count equals write count for each fenced table. |
| Direct SQL bypass | A raw-SQL writer on every fenced table still bumps; `UPDATE`/`DELETE` of the fence row from a normal session is rejected; no role may set `session_replication_role`. |
| Duplicate workers | Two F attempts: the second fails the fence or a unique constraint; at most one pair. |
| Existing guards | The C2/C3A immutability guards on claim and intent are unchanged and unaffected; no new allowance is needed for a "touch" because none is performed. |

### 3.5 Signal freshness and the authorization deadline **[R3]**

`D` and `F` are separate so that market evaluation (reads, possibly slow) is not inside the serialized lock
window. F re-checks `clock_timestamp() < dispatchExpiresAt − margin` (proposed 2 s, courtesy only); the MI
consumption trigger already re-checks `clock_timestamp() < dispatchExpiresAt`. On failure F rolls back; the
orchestrator may run `D` once more (a later `dispatchSequence` supersedes the older decision) and retry F **once**,
inside the 120 s signal bound; otherwise it records a definite-not-sent refusal.

**The 120 s rule is enforced as an immutable deadline stamped by the database, not as a commit-time check.** The TV
consumption gains, in the C3B.2 migration:

| Column | Value |
|---|---|
| `authorizedAt timestamptz NOT NULL` | `clock_timestamp()` in the `BEFORE INSERT` guard. Caller values rejected. |
| `authorizationDeadlineAt timestamptz NOT NULL` | `least(signal."createdAt" + interval '120 seconds', "authorizedAt" + interval '30 seconds')`. The 30 s *dispatch window* is a proposed, reviewable constant; it may never exceed the 120 s signal bound. |
| `fenceVersion bigint NOT NULL` | §3.4. |

The guard **refuses to create** a consumption when `clock_timestamp() ≥ signal."createdAt" + 120 s` or when fewer
than the minimum send window (proposed 5 s) would remain, with `TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`. Existing guards
make consumption rows immutable (`UPDATE`/`DELETE` forbidden); the migration extends that to the new columns and a
test proves it. `Signal."createdAt"` is declared `@default(now())` in `prisma/schema.prisma`, but Prisma's query engine may
supply that value from the application clock. C3B.2 must therefore either prove the ingestion path leaves it to the
database default or stamp a database-clock reference in the signal's transaction; until then the deadline is only as
trustworthy as the application/database clock agreement, and this dependency is an explicit open item (§10). Because `now()` is the *start* of the signal's transaction, it can
only be earlier than the signal's commit, which shortens, never lengthens, the allowed window.

**What F guarantees, and what it deliberately does not.**

* Guaranteed: no consumption is *created* for an already expired signal; every consumption carries a deadline no
  later than signal + 120 s that the database stamped and nothing can change.
* **Not guaranteed:** that the transaction *commits* before that deadline. Lock waits, WAL flush, a stalled client
  or `SET CONSTRAINTS` games can place the commit later. That is harmless **by construction**: a consumption that
  commits after its deadline is born expired. Nothing may act on it (§3.6), and its exposure is handled by the
  expired-never-sent protocol (§3.6.3), not by assuming it was never created.

### 3.6 Boundary C3C: the actual broker-send boundary **[R3]**

C3C is where a broker request can actually leave the process. It is out of scope for C3B.2 implementation but its
contract constrains F, so it is fixed here. **Every rule below is a requirement on C3C; none is implemented, and no
broker call is authorized now.**

C3C must:

1. **Revalidate the immutable authorization deadline against the PostgreSQL clock immediately before broker
   invocation**, in two places: inside the permit guard (§3.6.1) and in a final `SELECT clock_timestamp() <
   <deadline>` round trip performed after the permit committed and before the HTTP call is constructed. If either
   says expired, **no POST is initiated**.
2. **Hold or obtain a durable, unique send decision through a database-enforced, nondeferrable transition**
   (§3.6.1). No marker, no POST. The adapter refuses to run without a committed permit for the exact consumption.
3. **Prevent concurrent expired-never-sent terminalization from racing with acquisition of that permit** (§3.6.2).
4. **Never initiate an Alpaca POST if authorization has expired before the send attempt.**
5. **Treat any committed adapter-invocation marker as possible delivery requiring reconciliation, even if the
   process crashes before issuing HTTP** (§3.6.4).
6. **Account for delay between obtaining the marker and beginning the HTTP call** with no unsupported guarantee of
   broker receipt before the deadline (§3.6.4).

#### 3.6.1 The send decision, a single unique row

New table `ExternalSignalBrokerSendDecision` (C3C migration; designed here so F's schema leaves room):

| Column | Meaning |
|---|---|
| `consumptionId` **UNIQUE**, FK to the TV consumption | the linearization point: at most one decision per consumption |
| `orderIntentId` UNIQUE | same, per intent |
| `kind` | `SEND_PERMITTED` or `EXPIRED_NEVER_SENT` (or `WITHDRAWN_NEVER_SENT`, §3.6.5) |
| `decidedAt` | `clock_timestamp()` stamped by the guard |
| `authorizationDeadlineAt` | copied from the consumption by the guard |
| `workerId`, `workerClaimId` | audit |

Rows are immutable (`UPDATE`/`DELETE` forbidden; `TRUNCATE` not granted). The `UNIQUE` constraints are
**nondeferrable** (PostgreSQL does not make a unique index check deferrable unless declared so; the migration
declares them plainly), so the transition is database-enforced independent of `SET CONSTRAINTS`.

`BEFORE INSERT` guard for `SEND_PERMITTED`, run under explicit locks in the §6 order (a subset: exposure advisory,
`OrderIntent`, claim, fence, then the consumption row):

* the consumption exists and belongs to this intent; claim `ENTRY_SUBMITTING`, unreleased; intent `submitting`;
* **`clock_timestamp() < authorizationDeadlineAt − minimum_remaining`** (proposed 2 s), else the insert is refused
  with `TRADINGVIEW_AUTHORIZATION_EXPIRED` and the caller proceeds to §3.6.3;
* no `BrokerOrder`/`BrokerActivity` or contradictory event exists (if one does, no send is needed; reconcile);
* the emergency stops are re-read under `FOR SHARE` locks in canonical order: account `ACTIVE`/`tradingEnabled`/
  not `killSwitchEnabled`/not `tradingBlocked`, dispatch state active. A failure becomes `WITHDRAWN_NEVER_SENT`;
* stamps `decidedAt`; inserts the claim event `ADAPTER_INVOCATION_STARTED` in the same statement context so every
  existing recovery and attention path classifies the intent as **possible delivery** and retains exposure.

The committed `SEND_PERMITTED` row **is** the adapter-invocation marker.

#### 3.6.2 The race between permit and expiry is closed by the unique index, not by timing

`EXPIRED_NEVER_SENT` and `SEND_PERMITTED` are two kinds of the *same* unique row. Whichever transaction inserts
first wins; the other **blocks on the first inserter's uncommitted index entry** and then fails with `23505`, or
proceeds only if the first rolled back. Disposable probe P2 (PG 16.13 and 17.11) shows all three outcomes:

| Order | Result |
|---|---|
| Permit inserted, expiry started while the permit is uncommitted | expiry **blocks**; after permit commit it fails `23505`. No terminalization. |
| Expiry inserted, permit started while the expiry is uncommitted | permit **blocks**; after expiry commit it fails `23505`. No send. |
| Permit rolls back while expiry waits | expiry then **succeeds**. Safe: no permit was ever durable. |

A permit stamped at `T1 < deadline` but committed after the deadline is still a valid permit, and *that is safe*:
the worker has not yet been told it may send; it learns this only on commit, and then performs the final
PostgreSQL-clock re-read (§3.6, item 1). If the deadline has passed it does not POST. The marker is nonetheless
committed, so the exposure is held and reconciled (§3.6.4); this is the conservative outcome and it never produces
a send after the deadline.

#### 3.6.3 Consumed pair expires before any marker is acquired: expired-never-sent terminalization

This is a **separate C3C-only protocol**. It is *not* C2's pre-dispatch release, and **C2's pre-dispatch release
guard must not be reused to release a consumed claim.** The existing `external_signal_exposure_claim_c2_guard`
rule "a consumed marked claim cannot be released through the pre-dispatch path" stays exactly as is. The
migration adds one narrow, independent allowance keyed to a positive proof object, not a loosening of the C2 rule.

Eligibility (all enforced by the `BEFORE INSERT` guard of `EXPIRED_NEVER_SENT`, under the same explicit locks):

1. the consumption exists and `clock_timestamp() ≥ authorizationDeadlineAt` (strictly past, PostgreSQL clock);
2. **no** `SEND_PERMITTED` row exists (guaranteed by the unique index and re-checked);
3. no `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`, `BROKER_DELIVERY_UNCERTAIN` event; no
   `BrokerOrder`, `BrokerActivity`; claim `ENTRY_SUBMITTING` and unreleased; intent `submitting`;
4. the fence version equals the version the terminalizer read under lock.

Steps, one transaction (READ COMMITTED with explicit locks, so every read is post-lock fresh):

1. exposure advisory → `OrderIntent` → claim → fence → consumption, single-table `FOR UPDATE` statements;
2. insert the `EXPIRED_NEVER_SENT` decision (the **exclusive ownership** step: only one transaction can);
3. insert the claim event `NOT_SENT_EVIDENCE_RECORDED` with classification **`NOT_SENT_CONSUMED_EXPIRED`** (a new
   class, distinct from `NOT_SENT_PRE_DISPATCH` so no C2 rule can mistake one for the other);
4. move the intent to its terminal blocked/failed state with reason `TRADINGVIEW_AUTHORIZATION_EXPIRED`;
5. release the claim. The claim guard's new branch permits the release **only** when an `EXPIRED_NEVER_SENT` row
   for this intent exists in the same transaction; the C2 pre-dispatch branch is untouched and still refuses;
6. write the `SystemEvent`. Commit.

Durable outcome: one immutable decision row plus the evidence event plus the terminal intent and released claim,
atomically. **Database enforcement preventing any later adapter invocation:** a `SEND_PERMITTED` insert is
impossible afterwards (unique violation, and the permit guard also refuses a terminal intent or released claim),
and the adapter refuses to run without a committed permit. Replays of the terminalizer are idempotent: they find
the existing row and return it.

**Exposure remains held whenever there is unresolved possible-delivery evidence.** If a `SEND_PERMITTED` row, a
`ADAPTER_INVOCATION_STARTED`/`DISPATCH_OUTCOME_*`/`BROKER_DELIVERY_UNCERTAIN` event, a `BrokerOrder` or a
`BrokerActivity` exists, the terminalizer refuses, the claim stays `ENTRY_SUBMITTING`, and only authoritative
reconciliation may resolve it (§3.6.4). A consumed pair **with** a decision row of any kind is never touched by
stale recovery's definite-non-send release.

**Residual assumption (recorded, not hidden).** "No permit row" proves no *compliant* adapter sent. A defective
or rogue process that POSTed without a marker is outside the model; the backstop is a client-order-ID lookup. C3C
should therefore perform an authoritative client-order-ID lookup and record an *absent* observation before it
invokes the terminalizer, and the guard may require that observation (to be decided in C3C; recommended before any
canary).

#### 3.6.4 After the marker: possible delivery, reconciliation, and the unavoidable delay

* A committed `SEND_PERMITTED` row means **possible delivery, not delivery**. Crash before the HTTP call, after it,
  or mid-flight are indistinguishable to the database, so all are `DISPATCH_OUTCOME_UNKNOWN`: exposure retained, no
  resend, one `AUTHORITATIVE_ONLY` attention episode (C3A/C3B.1), resolved only by C3C reconciliation (lookup by
  client order ID; `BrokerOrder` link; or operator-confirmed release during the canary).
* If the post-commit clock re-read finds the deadline passed, the worker does **not** POST. It may append a
  `NON_AUTHORITATIVE` note (`ADAPTER_INVOCATION_DECLINED_BY_WORKER`). That note is testimony, not proof, and does
  **not** release exposure: the marker stands and reconciliation decides.
* **Delay between marker and HTTP.** Time passes between the permit commit, the clock re-read, request
  construction and the socket write (scheduling, GC, VM pause, retry on connect). The design does **not** promise
  that the broker receives the order before `authorizationDeadlineAt`. The deadline bounds *initiation by a
  compliant adapter*, checked immediately before the call; the adapter additionally enforces a short monotonic
  bound between the re-read and the write, and sets a connect/response timeout so an in-flight request is bounded.
  A process that stalls after the re-read can still send late; the marker guarantees that case is reconciled, not
  silently lost. Reconciliation must wait out `deadline + HTTP timeout + a stall allowance` before treating a
  broker-absent result as non-delivery, and the safe default for the canary is operator-confirmed release.

#### 3.6.5 Withdrawal

If the permit-time emergency-stop re-check fails (kill switch, `tradingBlocked`, account not `ACTIVE`, dispatch
state inactive), the same unique row is inserted with `kind='WITHDRAWN_NEVER_SENT'` under the identical protocol
of §3.6.3 (same eligibility except step 1's deadline condition is replaced by the stop condition). It never
applies once any possible-delivery evidence exists.

### 3.7 Alternatives considered for the freshness guarantee, and the selection **[R3]**

| Option | Verdict |
|---|---|
| **A. Deferred constraint trigger at COMMIT (revision 2)** | **Rejected.** `SET CONSTRAINTS ALL IMMEDIATE` before or after the insert runs the check at insert time (probe P3: check ran 2 ms after insert, commit reached 1.5 s later). Any later lock wait or stalled client then delays the commit past the check. A session can always do this; a trigger cannot forbid it. |
| **B. Commit-timestamp tracking (`track_commit_timestamp`)** | **Not selected; not relied on.** It is `off` by default (probe: `SHOW track_commit_timestamp` is `off` on 16.13 and 17.11), changing it needs a restart and is a cluster setting that managed services may not expose, and with it off `pg_xact_commit_timestamp()` errors (probe: "could not get commit timestamp data"). Even when on, the commit timestamp exists only *after* commit, so it can classify a consumption as late post hoc but cannot prevent a late consumption from being durable and valid. It is evidence, not a gate. Any future use requires proof of availability, retention and failover behavior; none is claimed. |
| **C. Immutable deadline + unique send decision (§3.2, §3.6)** | **Selected.** Freshness is moved from "when the transaction commits" (unobservable and unbounded) to "whether a compliant sender may start", which the database linearizes with a unique, nondeferrable row. It needs only `clock_timestamp()`, plain constraints and explicit locks. |
| D. Short renewable lease | Rejected: renewing still needs the same unique linearization and adds a refresh race. |
| E. Make the F commit itself the send marker | Rejected: commit time is uncertain, a crash between commit and send becomes unknowable, and an expired-never-sent proof would be impossible because the marker would already exist. |

**Documented assumptions and limitations of the selection.**

1. All freshness comparisons use the primary's `clock_timestamp()` and `Signal."createdAt"`, whose clock source is an
   open item (§3.5). A
   failover to a node with an earlier clock can briefly make an expired deadline look open; the permit's
   uniqueness (the safety property) does not depend on the clock. A clock step is an incident, not a design input.
2. The deadline bounds initiation by a compliant adapter, not broker receipt (§3.6.4).
3. Definite-never-sent is provable only for a compliant adapter that obeys "no marker, no POST" (§3.6.3).
4. The 30 s dispatch window and 2 s/5 s margins are proposals for review, not measured values.

## 4. Broker-opportunity semantics

| Concept | Record | Meaning | Authority? |
|---|---|---|---|
| Compare-only telemetry | `OrderIntentBrokerPostOpportunity` (`comparisonMode='COMPARE_ONLY'`, `tradingEffect='NONE'`) and its events | "At this moment a POST could have happened; here is what policy would have said." Best effort; may be missing, deferred or stale. | **No.** Never gates, never releases, never proves non-send. |
| Final authorization | `MarketPolicyBrokerDispatchConsumption` + `ExternalSignalBrokerDispatchConsumption` committed together (F) | A single-use, database-linearized, **deadline-bounded permission to attempt** one dispatch. | Permission to *attempt* only. **Not a send, not proof of broker receipt**, and never recalls an in-flight request. |
| Send decision / adapter marker | `ExternalSignalBrokerSendDecision` (`SEND_PERMITTED`) + `ADAPTER_INVOCATION_STARTED` event (C3C) | The compliant adapter may start the request. | Evidence of **possible** delivery; blocks release. |
| Observed broker state | `BrokerOrder` / `BrokerActivity` | The broker has something for this client order ID. | Authoritative evidence of delivery. |

`brokerPostOpportunityId` is **sufficient as is**: nullable on both rows (a missing observation never blocks and
never authorizes); the TV guard requires equality with the MI row's value (`IS NOT DISTINCT FROM`); the MI trigger
requires that a cited opportunity belongs to the same `orderIntentId`. To cite one, F selects the **latest**
`OrderIntentBrokerPostOpportunity` for the intent after the intent lock and passes the *same* value to both
inserts; if none exists both are `NULL`. If observation creation races F the worst outcome is `NULL`, never a
mismatch. Citing an opportunity adds no gate. No new column or table is required.

## 5. Failure, crash and retry matrix

"State" is the durable state after the event. The ten original cases keep their numbers and meaning; **[R3]**
marks the rows revised by this revision, and cases 11 to 13 are added for the C3C boundary.

| # | Event | Durable state | Next action |
|---|---|---|---|
| 1 | Failure before F (including D failing or refusing) | D may have written a decision (`ALLOWED` or not) only. Intent `submitting`, claim `ENTRY_SUBMITTING`. No consumption. | A refused decision → `refuseAndRelease` records `NOT_SENT_EVIDENCE_RECORDED` and blocks the intent; the claim then releases through the C3A not-sent path. An `ALLOWED` decision with no F is harmless (a later decision supersedes it). |
| 2 | Revocation during validation | Revoke takes `rollout advisory → source → binding → authorization FOR UPDATE`. | **[R2]** Revoke-first after F's snapshot: F's locking reads raise **`40001`**, not a fresh read; the retry (new snapshot) sees `REVOKED` and refuses not-sent. F-first: consumption commits; the revoke commits after (cannot recall an in-flight request) and affects only later intents. |
| 3 | Accepted EXIT racing authorization | EXIT correlation locks `source → binding → trade cycle → account cycle` and sets `EXIT_PENDING`. | **[R2]** F takes the same rows in the same order, `FOR SHARE` on the account cycle, so an EXIT committed after F's snapshot is `40001`, one committed before is seen. EXIT-first → refuse (`TRADINGVIEW_EXIT_ACCEPTED`), not-sent. F-first → consumption commits; the EXIT stays `EXIT_PENDING` and is honored after delivery is reconciled. |
| 4 | Deactivation while locks are held | Rollout/dispatch deactivation takes the rollout advisory lock and updates the state rows. | Deactivation-first → F sees a changed `activeRolloutGenerationId`/state version (`40001` or mismatch) and refuses not-sent. F-first → valid; deactivation applies to future work only. |
| 5 | Signal expiration **[R3]** | During lock waits, between insert and commit, or after commit. | **Before insert:** the guard refuses to create the consumption (`TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`), definite not-sent refusal. **Between insert and commit, or after commit:** the consumption exists but carries an immutable `authorizationDeadlineAt` at or before signal + 120 s; it is *born expired* if it commits late. Nothing may act on it; see case 11. No commit-time guarantee is claimed. |
| 6 | Duplicate workers | Second worker's claim insert hits the `orderIntentId` unique (`P2002`) → `NOT_CLAIMED`. Past the claim: F's locks serialize; the second sees an existing consumption or a unique violation on `orderIntentId`/`workerClaimId`/`decisionId`. | No second consumption can exist (four unique constraints). |
| 7 | F commits but the acknowledgment is lost | Both consumptions exist. Intent `submitting`, claim `ENTRY_SUBMITTING`. | **[R2]** After any failure that may have followed a commit (connection reset, timeout, `57P01`, unknown driver error), the orchestrator **must first read `ExternalSignalBrokerDispatchConsumption` by `orderIntentId`** (fresh `READ COMMITTED` statement) before considering any retry or refusal. If it exists the attempt is over: no retry of F, no refusal/release, hand the intent to recovery/C3C. |
| 8 | Process crashes immediately after F **[R3]** | Same as row 7, no send decision and no `ADAPTER_INVOCATION_STARTED` event. | A committed pair is **single-use even with no marker**, and **not proof of broker receipt**. **Until C3C exists** (C3B.2, C3B.3) stale recovery treats it as `DISPATCH_OUTCOME_UNKNOWN`, retains exposure and never resends. **With C3C**, once `authorizationDeadlineAt` has passed and no send decision exists, the pair is eligible for the expired-never-sent protocol of §3.6.3 (case 11); before the deadline it is left alone so a live worker can take the permit. |
| 9 | Alpaca already has this client order ID | C3C performs the client-order-ID lookup **before** the first POST and again on any ambiguity. | Link `BrokerOrder`, advance claim to `BROKER_ORDER_ACTIVE`, never POST. No new consumption is created or required. |
| 10 | F aborts with a retryable DB error (`40001`/`40P01`) | Nothing durable from F. | Up to three attempts, fresh transaction each (fresh snapshot); then refuse as technical not-sent via the independent `READ COMMITTED` path of R-5. Non-retryable classification fails closed. |
| 11 | **[R3]** Consumed pair, deadline passes before any marker | Consumption exists; no send decision. | C3C-only expired-never-sent terminalization (§3.6.3): unique decision row, evidence class `NOT_SENT_CONSUMED_EXPIRED`, terminal intent, released claim, atomically. Not C2's release. |
| 12 | **[R3]** Permit and expiry race | Two transactions, one unique row. | Whichever inserts first wins; the other blocks, then fails `23505` (probe P2). Permit-first: no terminalization, reconcile. Expiry-first: no send. |
| 13 | **[R3]** Marker committed; crash, stall or declined send | `SEND_PERMITTED` exists. HTTP may or may not have started. | Possible delivery. Exposure retained, no resend, attention episode, reconciliation only (§3.6.4). |

**Successful consumption is never treated as proof of broker receipt**, in code, docs or recovery. **No consumed
exposure is released except by the authoritative reconciliation pathway or the provably-never-sent protocol of
§3.6.3.**

### 5.1 How every durable outcome is handled by the existing and the planned paths **[R3]**

| Durable outcome (per intent) | Stale recovery (`entry-dispatch-recovery.service.ts`) | Operational Attention (`external-signal-delivery-attention.service.ts`) | Exposure |
|---|---|---|---|
| Worker claim only (no event, no consumption) | Terminalizes definite-not-sent after the stale window (`external_signal_stale_admission_elapsed`), under the exposure advisory lock | none | released through the C3A not-sent path |
| NOT_SENT evidence recorded | Releases claim, intent blocked/failed | none | released |
| MI decision(s) only, `ALLOWED` or refused | As "worker claim only"; decisions are harmless | none | released when stale |
| **Committed consumption pair, no send decision** | Before C3C: `DISPATCH_OUTCOME_UNKNOWN`, never resends, **does not release**. With C3C: left alone until the deadline, then expired-never-sent (§3.6.3) | opens one deduplicated `AUTHORITATIVE_ONLY` episode while unresolved (works without usable credentials, C3B.1); closed by the terminalization | retained until §3.6.3 releases it |
| Pair + `SEND_PERMITTED` / `ADAPTER_INVOCATION_STARTED` | `DISPATCH_OUTCOME_UNKNOWN`; never resends; **does not release** | same | retained |
| `EXPIRED_NEVER_SENT` / `WITHDRAWN_NEVER_SENT` | terminal; nothing to do | closed | released by §3.6.3 |
| `DISPATCH_OUTCOME_RECORDED` / `BROKER_DELIVERY_UNCERTAIN` | same as above | same | retained |
| `BrokerOrder` / `BrokerActivity` | normal order sync takes over | none (resolved) | normal lifecycle |
| Only an MI consumption (marked) | impossible: deferred pair check fails the commit (fail-closed even under `SET CONSTRAINTS ALL IMMEDIATE`, §3.5 and probe P3) | n/a | n/a |
| Only a TV consumption | impossible: FK to the MI row | n/a | n/a |

The marked-claim guards forbid releasing a consumed claim through the pre-dispatch path
(`external_signal_exposure_claim_c2_guard`) and deleting any marked claim
(`external_signal_exposure_claim_delete_guard`, C3B.1). Retained exposure is **never** released through
definite-non-send recovery once a consumption exists, except by the single, separately keyed allowance of §3.6.3.

## 5.3 Database invariants C3B.2 adds (new forward-only migration, proposed) **[R3]**

All new or replaced routines restate the trusted `search_path = pg_catalog, public, pg_temp` (C3A function-level
requirement, enforced by the static migration test and the C3B.1 preflight manifest; the manifest must be
regenerated in the same change, from a freshly migrated disposable database, never from the database assessed).

* **`external_signal_broker_consumption_guard`** (replaced, `BEFORE INSERT`): takes the §6 locks **itself**, in
  explicit single-table statements in canonical order, so correctness never depends on the caller having
  pre-locked (R-6) nor on `FOR UPDATE OF a,b,c` ordering (§6.1). It performs the checks below and **stamps**
  `authorizedAt` and `authorizationDeadlineAt`.
* **`external_signal_dispatch_fence_bump`** and `ExternalSignalDispatchFence` (§3.4).
* **No deferred commit-stage freshness guard.** Revision 2's `external_signal_final_dispatch_commit_guard` is
  **removed from the design**: it cannot provide the property it claimed (§3.7).

Checks in the consumption guard:

1. **Signal still fresh at authorization**: `clock_timestamp() < signal.createdAt + 120 s − minimum send window`;
   else `TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`. Uses `clock_timestamp()`, not `statement_timestamp()`.
2. **PAPER BUY only**: account `environment='PAPER'`, intent side `buy`, source `tradingview`.
3. Account `ACTIVE`, `tradingEnabled`, not `killSwitchEnabled`, not `tradingBlocked`; assignment `enabled &&
   entriesEnabled`; Subscription, Strategy, ExitProfile and Security enabled; allocation enabled and account-matched.
4. **Exact valid worker claim and active authorization/generation**: the claim exists for this intent and
   obligation, matches `clientOrderId`, generation and state version; authorization `AUTHORIZED`; rollout and
   dispatch state active at the claim's generation.
5. No accepted `EXIT_LONG` on the source cycle; account cycle not `EXIT_PENDING`/terminal.
6. Claim `ENTRY_SUBMITTING`, unreleased, the owner event cites this worker claim, intent `submitting`.
7. **No earlier dispatch, broker order or contradictory event**: no other consumption, unenforced dispatch,
   `BrokerOrder`, `BrokerActivity` or `NOT_SENT/ADAPTER_INVOCATION_STARTED/DISPATCH_OUTCOME/BROKER_DELIVERY_UNCERTAIN`
   event.
8. **Latest allowed MI decision inside its short window**: `ALLOWED`/`DISPATCH_AUTHORIZED`, highest
   `dispatchSequence` for the intent, `clock_timestamp() < dispatchExpiresAt`.
9. **Identical identities on both records**: `clientOrderId` and `brokerPostOpportunityId` equal on the MI and TV
   consumption rows, and equal to the claim's.
10. **Frozen MI obligation** (§1.1): present, belongs to this intent, identity-equal to the decision and the
    account cycle.
11. **Fence equality** (§3.4): `NEW.fenceVersion` equals the locked fence row's `version`.
12. Nothing session-configurable (`current_setting`, GUC) can relax any of these.

Until this migration exists, the service-level checks of §3.3 are the only enforcement for the time, pause, EXIT
and obligation items, which is why C3B.2 is "service + migration", not service alone.

## 6. Canonical lock-acquisition contract **[R3]**

### 6.1 Why the order must be explicit

`SELECT … FROM a JOIN b … FOR UPDATE OF a, b, c` does **not** lock in `FROM` or `OF` order. PostgreSQL locks rows
as the plan produces them, so the join order the planner picks decides. This was reproduced against the existing
worker-claim guard (`FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec`) and applies equally to the
TradingView admission lock statement (`market-policy-entry-admission.service.ts:108`,
`FOR UPDATE OF ac,c,sr,rr,sig,auth,state,gen,work,ta,tas,sub,sec`). Rule: F, the claim transaction, admission and
the new guards take every lock with **one single-table statement per relation, in the order below**; a guard's
later multi-table `FOR UPDATE` finds the rows already held and cannot wait. No reliance on multi-table
declaration order remains anywhere in the contract.

### 6.2 The reproduced authorization/identity deadlock **[R3]**

Revision 2 placed the execution authorization (row 10) **before** `TradingAccount`, `TradingAccountSubscription`,
`Subscription` and `Security`. The existing identity-invalidation triggers
(`invalidate_external_signal_entry_authority`, migration `20261029120000`, `ExternalSignalEntryAuthority_*_invalidate`)
fire `AFTER UPDATE` on those identity tables, so they hold the identity row and then `UPDATE` the authorization:

```
F / proposed order:        authorization  →  TradingAccount (etc.)
identity update trigger:   TradingAccount (the updated row) →  authorization
```

Opposite orders on two relations: a reproducible `40P01`. The grant service already uses the correct direction
(`external-signal-execution-authority.service.ts:105-118`: `source → binding → generation → TradingAccount →
TradingAccountSubscription → Subscription → Security`, then the authorization is inserted). The order below follows
the existing code, and the authorization is placed **after every identity row**.

### 6.3 The order

Top to bottom; nothing may be acquired after a later row. "Mode" is the strongest mode any later trigger will take
in that transaction (never upgrade). `F` = final transaction; `Claim` = the worker-claim transaction, whose guard
takes `FOR UPDATE` on the identity rows. **Moved** = position changed in revision 3; **New** = absent before.

| # | Relation / lock | Mode (F / Claim) | Acquired by | Notes |
|---|---|---|---|---|
| 1 | Advisory `hashtext('external-signal-execution-rollout')` | exclusive | F, Claim, guards (re-entrant), admission, revoke, grant, activate, unclaimed refusal | Serializes all TV dispatch. Acceptable for a PAPER canary. |
| 2 | `ExternalSignalExecutionRolloutState` id=1 | UPDATE | F; claim guard | |
| 3 | `ExternalSignalBrokerDispatchState` id=1 | UPDATE | F; claim guard; consumption guard | |
| 4 | `ExternalSignalSource` | SHARE / UPDATE | F; claim guard; grant; revoke; EXIT correlation | Revoke, EXIT and the source-disable trigger start here. **Moved** after the state rows (before generation). |
| 5 | `StrategySignalBinding` | SHARE / UPDATE | same | source → binding. |
| 6 | `StrategySignalRevision` | SHARE / UPDATE | claim guard; F validation | Immediately after its binding. |
| 7 | `ExternalSignalExecutionRolloutGeneration` (frozen generation) | SHARE / UPDATE | grant (`:111`); claim guard; consumption FK | **Moved** from row 4: grant locks it after binding. |
| 8 | `ExternalSignalTradeCycle` (source cycle) | SHARE / UPDATE | F; claim guard; EXIT correlation | |
| 9 | `ExternalSignalTradeCycleAccount` | SHARE / UPDATE | F; claim guard; EXIT correlation | **Source → binding → cycle → account-cycle** is total. |
| 10 | `TradingAccount` | SHARE / UPDATE | F; claim guard; grant; identity trigger | **Moved before authorization.** Mutable (pause, kill switch): `FOR SHARE`, not `FOR KEY SHARE`. |
| 11 | `TradingAccountSubscription` (assignment) | SHARE / UPDATE | same | **Moved.** |
| 12 | `Subscription` | SHARE / UPDATE | same | **Moved.** |
| 13 | `Strategy` | SHARE | F | New (enabled flag validated). |
| 14 | `ExitProfile` | SHARE | F | New (enabled flag validated). |
| 15 | `Security` | SHARE / UPDATE | same as 10 | **Moved.** |
| 16 | `TradingAccountAllocation` | SHARE | F | **New.** The design validates it (enabled, account-matched) and revision 2 omitted it. Its writers are not known to lock an identity row afterwards; probe required (§9). |
| 17 | `ExternalSignalEntryExecutionAuthorization` | SHARE / UPDATE | F; consumption guard (`FOR UPDATE`); claim guard; revoke; identity triggers | **Moved after all identity rows.** F stays `FOR UPDATE` because the consumption guard will request it. Revoke: source → binding → authorization (consistent). Identity triggers: identity → authorization (now consistent). |
| 18 | `MarketPolicyEnforcementRuntimeRollout` id=1 | SHARE | F via `lockMarketPolicyEnforcementRollout` | MI order position 1. |
| 19 | Latest `AssignmentMarketPolicyEnforcementAuthorization` | SHARE | F via `resolveLockedAssignmentMarketPolicyEnforcement`; MI consumption trigger | |
| 20 | `StrategyMarketPolicyRevision`, `AssignmentMarketPolicyEnrollmentGeneration` named by the obligation | SHARE | F | New (mutable status). |
| 21 | Advisory `entry-exposure:<account>:<security>` | exclusive | F; Claim (after §6.4 fix); admission; recovery; release; remediation; C3C permit and terminalizer | **After identity and authorization, before the intent.** |
| 22 | `OrderIntent` | UPDATE | F; claim guard; C3C | Intent before claim. |
| 23 | `EntryExposureClaim` | UPDATE | F; claim guard; event fence; C3C | |
| 24 | `ExternalSignalDispatchFence` | UPDATE | F; consumption guard; every fenced writer's AFTER trigger; C3C | **New (§3.4).** Last, because triggers bump it after the intent and claim writes. |
| 25 | `ExternalSignalBrokerWorkerClaim` | SHARE | F | Immutable. |
| 26 | `ExternalSignalEntryExecutionObligation` | SHARE | F; consumption FK | Immutable. |
| 27 | `OrderIntentMarketPolicyEnforcementObligation` | SHARE | F | New; §1.1. |
| 28 | Latest `MarketPolicyBrokerDispatchDecision` for the intent | SHARE | F | New. |
| 29 | Entry `Signal` | SHARE | F (age + identity read) | New; immutable by `external_signal_signal_v2_immutability_guard`. `SignalRoute` and `SignalRoutingRun` are immutable evidence read from the snapshot, as C2 already does. |
| 30 | Consumption row (C3C: the TV consumption) | UPDATE | C3C permit and terminalizer | New rows in F: MI consumption, TV consumption, optional claim event (key-share via FK; the event fence locks the claim, row 23, already held). |

**Derivation and what is proven.** Rows 4-9 are the observed EXIT-correlation and revoke orders; the grant order
(rollout state, source, binding, generation, account, assignment, Subscription, Security, then the authorization
insert; it does not lock the revision) is the subsequence 2, 4, 5, 7, 10, 11, 12, 15, 17; rows 10-15 → 17 is the identity-trigger order; rows 21-23 are the recovery, claim-guard
and exposure order. The table is a total order consistent with every path named above, from the sources cited. It
is **not** proven by execution yet: §9 requires a two-connection probe of every adjacent pair listed there on
PostgreSQL 16 and 17 before C3B.2 acceptance.

**Admission** currently takes rows 4-17 in one planner-ordered statement (`:108`). It must be rewritten to
single-table statements in this order before C3B.2; the order change does not alter its behavior.

### 6.4 Worker-claim / recovery lock inversion: hazard, fix and prerequisite **[R2, order updated R3]**

The independent audit **reproduced a `40P01` deadlock** between the existing worker claim and stale recovery:

* `processTradingViewOrderIntentForC2` (`external-signal-broker-worker.service.ts`) inserts the worker claim
  first. The claim trigger takes the `OrderIntent` (and identity) rows `FOR UPDATE` and only afterwards does the
  service take the `entry-exposure` advisory lock (`:103`).
* Recovery (`entry-dispatch-recovery.service.ts:1017`, `:444`, `:1148`) takes the `entry-exposure` advisory lock
  first, then `FOR UPDATE OF i`.

Opposite orders on the same intent; PostgreSQL aborts one side with `40P01`. It is not a safety violation (the
classifier retries it) but it is nondeterministic stalling and a flake source under the C3B.2 interleavings.

**Corrected claim transaction (applies the revision-3 order):**

1. rollout advisory (row 1);
2. explicit single-table pre-locks of rows 2-17, **identity rows (10-16) before the authorization (17)**, in the
   Claim mode;
3. exposure advisory (row 21);
4. the claim insert (its guard finds rows 2-17, the intent and the claim already held; the fence is taken at row 24);
5. the exposure/intent updates and the claim event, as today.

If the claim transaction only moved the advisory lock ahead of the claim insert, it would sit before the claim
guard's identity `FOR UPDATE` while admission holds identity `FOR SHARE` and then waits for the advisory lock, an
admission-versus-claim inversion; hence step 2. Recovery, which takes only rows 21 → 22, is consistent. The
corrected order is the **same** order F uses (§3.3 step 1): one contract for both.

This checkpoint does **not** change the worker path (C3B.1 forbids it); it records the fix and makes it a hard
prerequisite.

### 6.5 Other hazards

* **A. TV rollout advisory (row 1) before the MI rollout row (row 18).** No existing path takes the MI rollout row
  and *then* the TV advisory (MI transitions take `User FOR SHARE → MI rollout`). Keep it so and test it.
* **B.** Exposure advisory vs `OrderIntent`: superseded by §6.4.
* **D. Unlocked reads in the MI consumption trigger.** It reads intent and claim unlocked. F's rows 22-23 close that
  for TradingView; the MI trigger is unchanged so unmarked behavior is unchanged.
* **E. Authorization revoke vs F.** Same relative order (4 → 5 → 17). No inversion.
* **F. EXIT ingestion.** Correlation does not take the rollout advisory lock; it takes `source → binding → cycle →
  account cycle` (rows 4, 5, 8, 9). F uses that order, so EXIT and F interleave only at rows 8-9.
* **G. Global serialization.** Rows 1-3 make TV dispatch single-file, intentional for the canary and why
  `lock_timeout` is mandatory on F.
* **H. Fence writers (new, §3.4).** Order sync and other writers of `BrokerOrder`/`BrokerActivity` must lock the
  intent and claim (rows 22-23) before the fenced insert so the AFTER-trigger bump (row 24) comes last. Audit and
  probe every fenced writer; an inversion is an aborted transaction, never a bypass.

## 7. Recovery interaction

C3A already guarantees, and C3B.2 must not weaken:

* Any consumption, `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`, `BROKER_DELIVERY_UNCERTAIN`,
  `BrokerOrder` or `BrokerActivity` makes the claim's exposure **retained**, never auto-released, and opens one
  deduplicated `AUTHORITATIVE_ONLY` attention episode, now also for accounts with unusable credentials (C3B.1).
* `external_signal_exposure_claim_c2_guard` forbids releasing a consumed marked claim through the pre-dispatch
  path; `external_signal_exposure_claim_delete_guard` forbids deleting it.
* Stale recovery treats a committed dispatch record as `DISPATCH_OUTCOME_UNKNOWN` and never resends.

C3B.2 adds: the not-sent refusal path used after an F failure is the independent `READ COMMITTED` path of R-5; it
takes the exposure advisory lock and the intent lock, then **re-reads the consumption by `orderIntentId` with a
fresh statement snapshot immediately before releasing**, so a lost-acknowledgment commit (case 7) can never be
released as not-sent. C3C adds the single separately keyed release of §3.6.3.

## 8. Remaining work and prerequisites

* **Prerequisite to C3B.2 acceptance:** the §6.4 correction of the worker-claim path with explicit pre-locks and
  its probes; the admission lock statement rewritten in canonical single-table order (§6.3); the C3B.1 migration
  applied to development by the product owner; the preflight green on the real runtime identity.
* **C3B.2:** this contract, the three MI-service refactors, `finalizeTradingViewDispatch`, the §5.3 migration
  (fence table and bump triggers, consumption deadline columns and guard, a regenerated security manifest), and
  the §9 tests.
* **C3B.3:** worker scheduling and rollout/activation operations, still with the adapter disabled.
* **C3C:** the send-decision table and guards, the expired-never-sent terminalizer, the broker adapter
  (client-order-ID lookup, single POST, pre-POST PostgreSQL-clock re-read), authoritative reconciliation and the
  only release path for retained exposure.
* **Before any canary:** broker-enabled readiness (`npm run db:security-preflight -- --mode broker-enabled` green
  on the real runtime connection); the role cutover with session draining applied and verified; the §6.4
  correction; the §1.1 obligation checks; a defined global kill procedure; a PAPER rehearsal with the activation
  epoch; SELL and LIVE remain disabled. Also, retained as documented pre-canary hardening (found by the same
  audits, not part of C3B.1):
  1. **Function configuration drift**: the manifest pins body, language, volatility and the trusted
     `search_path`, but not other `proconfig` entries such as `statement_timeout`; a function could gain or lose
     such a setting unnoticed.
  2. **PostgreSQL 17 `MAINTAIN` privilege** and the associated denial-of-service exposure through
     `VACUUM`/`ANALYZE`/`REINDEX`-class operations on application tables.
  3. **Driver-adapter package class-identity consistency** between the packages that supply the pg adapter and the
     pg driver, so error classes and `instanceof` checks cannot silently diverge.

## 9. Required interleaving and acceptance tests (future implementation; none are written in this checkpoint)

Every test uses **two independent PostgreSQL connections** (separate sessions, not two statements on one client),
runs against PostgreSQL 16 and 17, and drives both commit orders deterministically with advisory-lock or `pg_sleep`
barriers placed at the contested statement (not timing guesses). For each scenario:

* run **F at SERIALIZABLE** against the competitor at **READ COMMITTED** and again at **SERIALIZABLE** (the
  competitor's real isolation per §3.1 is also exercised: refusal and recovery at READ COMMITTED);
* run **both commit orders** (competitor commits first / F commits first) and, for F-first, also the case where the
  competitor began before F's snapshot;
* assert the outcome below, that **at most one** `ExternalSignalBrokerDispatchConsumption` and one
  `MarketPolicyBrokerDispatchConsumption` exist, that the exposure claim is never released while possible-delivery
  evidence exists, and that **no broker call occurred**: the `fetch` spy is never invoked with a non-GET, no
  `BrokerOrder` or `BrokerActivity` row exists, and no adapter-invocation marker exists (no adapter exists in this
  phase, so any POST is a defect);
* record the lock graph (`pg_locks`, `pg_stat_activity`) when blocked, so a hang is a diagnosed failure and not a
  timeout.

| # | Scenario | Competitor commits first | F commits first |
|---|---|---|---|
| 1 | **The exact authorization/identity deadlock.** Hold an identity row (`TradingAccount` non-key update that fires `invalidate_external_signal_entry_authority`) while F runs its lock sequence, and the reverse. Also assert that the revision-2 order *does* deadlock (negative control) and the revision-3 order does not. | zero `40P01`; either the identity change commits and F refuses not-sent (authorization `INVALIDATED`), or F waits | consumption commits; the identity change then invalidates the authorization for later intents; zero `40P01` |
| 2 | **Worker claim versus recovery, admission and refusal.** Claim vs stale recovery, claim vs admission (identity-before-exposure), claim vs unclaimed refusal, claim vs `refuseAndRelease`; and F vs each. | exactly one of claim/terminalization wins; the loser retries to a safe outcome; zero `40P01` | same |
| 3 | **Accepted EXIT vs authorization** (correlation at its own `ReadCommitted`): EXIT correlation vs F, and vs the claim, and vs admission. | F refuses `TRADINGVIEW_EXIT_ACCEPTED`, not-sent, zero consumption | consumption commits; EXIT stays `EXIT_PENDING` and is honored after reconciliation; no recall |
| 4 | **Account pause and kill switch vs authorization**, separate runs for `status`, `tradingEnabled`, `killSwitchEnabled`, `tradingBlocked`; plus Subscription/Strategy/ExitProfile/Security/allocation disable (non-key `UPDATE`; a negative control proves `FOR KEY SHARE` would miss it); plus source disablement and TV authorization **revoke**; plus rollout/dispatch deactivation. | F refuses not-sent (`40001` on the first attempt, refusal on retry); zero consumption | consumption commits; the change affects only later intents |
| 5 | **Signal expiration during locking**: hold a needed lock until the signal is past 120 s; and a signal 119.5 s old at insert. | guard refuses creation `TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`; zero consumption | n/a (never created) |
| 6 | **`SET CONSTRAINTS ALL IMMEDIATE` before and after consumption insertion.** Before: pair check fails closed at the first insert; after both inserts: passes with a valid pair. Assert the freshness property does **not** change: a consumption stamped, then delayed past its deadline by a held lock, commits yet is expired (`authorizationDeadlineAt` unchanged) and cannot obtain a permit. A negative control shows a deferred-trigger freshness check would have passed. | n/a | commits; pair intact; deadline unchanged; permit refused after the deadline |
| 7 | **Signal expiration after paired consumption but before send-permit acquisition** (C3C). | permit refused `TRADINGVIEW_AUTHORIZATION_EXPIRED`; expired-never-sent terminalization (§3.6.3) succeeds | n/a |
| 8 | **Expiration terminalization racing with adapter-send authorization** (C3C), around the deadline, both orders, including a permit stamped before the deadline and committed after it. | permit first: terminalization blocks then `23505`, no release, reconcile. Expiry first: permit blocks then `23505`, no send | same |
| 9 | **Lost commit acknowledgment and duplicate finalization**: kill the client connection after COMMIT is sent; then run recovery and the orchestrator; run two workers. | n/a | second F creates nothing; the orchestrator reads the pair by `orderIntentId` before any retry; recovery retains exposure; zero release |
| 10 | **No second consumption, broker invocation or exposure release under uncertainty**: every row of the §5 matrix, plus permit-committed crash, stalled worker, and declined send, asserting retained exposure and zero POST. | n/a | n/a |
| 11 | Fence proof obligations of §3.4 (version conflict via a lock-only competitor, real Prisma isolation, trigger/FK, direct-SQL bypass, duplicate workers, existing guards), and the `xmin` negative control reproducing probes P1/P1b. | | |
| 12 | Missing MI obligation fixture, duplicate admission, wrong-identity obligation; direct-SQL consumption by a session that skipped pre-locks and the fence. | refused before any decision; guard rejects | n/a |

## 10. Disposable-database probe evidence

The probes are in [`scripts/design-probes/c3b2-postgres-probes.mjs`](../../scripts/design-probes/c3b2-postgres-probes.mjs).
They create and drop a scratch database on a throwaway server, touch no application schema and issue no broker
call. They were run against PostgreSQL **16.13** and **17.11** with identical outcomes:

| Probe | Observation (both versions) | Used for |
|---|---|---|
| P1 | SERIALIZABLE reader sees 0 events; a competitor locks the claim `FOR UPDATE`, inserts an event, commits; the reader's later `UPDATE` of the claim returns **ok** (no `40001`), still sees 0 events, and `xmin` equals its transaction id. | A row "touch" and an `xmin` check do not detect lock-only evidence writers (§3.4). |
| P1 (fence) | Same competitor also bumps a fence row; the reader's `SELECT … FOR UPDATE` on the fence raises **`40001`**. | The fence counter works (§3.4). |
| P1b | After a `plpgsql` `EXCEPTION` block writes the row, `xmin` ≠ the top-level transaction id. | `xmin` is unreliable under subtransactions. |
| P2 | Unique-index insert of a second decision blocks while the first is uncommitted, then `23505`; if the first rolls back the second succeeds. | Permit versus expiry linearization (§3.6.2). |
| P3 | With `SET CONSTRAINTS ALL IMMEDIATE`, a "deferred" check ran 2 ms after the insert; the commit was reached ~1.5 s later after a lock wait. | Deferred triggers are not a commit-time guarantee (§3.7). |
| P3 | `track_commit_timestamp = off`; `pg_xact_commit_timestamp()` errors. | Commit-timestamp tracking is not available by default (§3.7). |

**Not yet probed (required before implementation):** the clock source of `Signal."createdAt"` on the real ingestion path, the real Prisma `Serializable` transaction and driver adapter,
the proposed fence triggers on the real tables, the lock-order pairs of §6.3, and PostgreSQL behavior under the
exact interleavings of §9. Nothing in this document is approved on the strength of the primitive probes alone.
