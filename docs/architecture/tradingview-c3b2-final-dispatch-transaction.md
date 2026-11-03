# TradingView Phase 4A.2C3B.2: final-dispatch transaction contract

Status: **design, revision 5. C3B.2-0 and C3B.2-1 are accepted and migrated to persistent development (109 migrations). C3B.2-2 adds the atomic paired-finalization service on that accepted schema and is awaiting independent acceptance. It remains test-only, default-off, and has no runtime caller.** C3B.1 is independently accepted and its migration is applied to persistent development;
it is broker-inert and adds no consumption writer, scheduler entry, broker adapter call or POST. Implementation of C3B.2 waits for review of this contract. No broker call is authorized in any checkpoint covered by this document.

Revision 2 corrected the first draft after an independent PostgreSQL 16/17 audit. Revision 3 removed the false claim that a deferred constraint trigger is a commit-time guarantee and introduced the dispatch fence.
Revision 4 corrected revision 3 after a third audit and resolved five precision findings. **Revision 5 is a focused correction of revision 4, not a redesign.** Hermes reviewed revision 4 on PostgreSQL 16.15 and 17.5; the fence and
receipt-clock architecture is sound (61 existing and 19 additional independent probes passed on each version), but the review returned **ARCHITECTURE CORRECTIONS REQUIRED**: one HIGH migration issue, four MEDIUM issues and several
LOW findings. Every claim below that says "probe" was executed against a **real migrated schema** (all 107 repository migrations plus the proposed overlay) on **PostgreSQL 16.13 and 17.11** with identical results:
**137 checks, 11 upgrade checks and 19 classified adapter error shapes on each version, 0 failures** (section 10.3).

* **[R5-1] HIGH, existing marked intents had no fence.** The migration created a fence only for intents inserted afterwards, so recovery, evidence writing and release would fail for every existing marked intent. The corrected migration sequence
  locks the fenced tables, **backfills** a version-1 fence for every existing marked intent before any fence trigger exists, installs the creation trigger and the bump triggers, and asserts the post-condition, all in one transaction. Historical rows,
  receipts and recovery are untouched (section 3.4.8; probes U0 to U9).
* **[R5-2] MEDIUM, final consumption must reject existing broker evidence.** A correct fence version is necessary but not sufficient: probe E0 commits a valid pair next to committed BrokerOrder evidence with the revision-4 guard. The replaced guard is now **complete**:
  it takes the canonical locks itself, then revalidates the worker claim, the frozen Market Intelligence obligation, the decision, the authorization, live eligibility, the receipt and the fence, and refuses every form of existing evidence, under both isolation levels (sections 3.4.9, 5.3; probes E0 to E5, A6c).
* **[R5-3] MEDIUM, the evidence key must be account-scoped.** Every branch now requires the marked intent's trading account; `NULL` never matches; `BrokerActivity.brokerOrderRecordId` is covered. A LIVE order sharing a `clientOrderId` neither bumps the PAPER fence nor is refused by the quarantine (section 3.4.6; probes S0 to S5).
* **[R5-4] MEDIUM, one execution clock.** Every execution-eligibility comparison against an activation epoch moves to `Signal.receivedAt`. The audit found two accepted database functions and five service lines that compare `Signal.createdAt`, two through an implicit TimeZone cast; the epoch columns are already database-stamped and only the candidate side needs a stamp (section 3.5.5; probes T1 to T4).
* **[R5-5] MEDIUM, `refuseCandidate` locks the account cycle before its parent cycle.** Reproduced as a deadlock in one queue order; the required parent-first contract and an audit of every account-cycle writer are in section 6.9.1 (probes O1a to O1c). The fix belongs to the earliest implementation checkpoint (11.5.3).
* **[R5-6] LOW, fence INSERT integrity.** The fence guard now accepts an insert only from the marked-intent creation trigger, at version 1, for an existing marked intent (section 3.4.8; probes I1a to I1e).
* **[R5-7] LOW, trigger execution order.** The not-sent protection depends on a trigger-name order; a catalog regression and an order invariant pin it, the flip is reproduced as a hazard, and a one-statement independent alternative is documented (section 6.9.3; probes I2, I3).
* **[R5-8] Retry classification stays fail-closed.** Measured with the production adapter: the structured SQLSTATE lives in a known place for every real conflict, and message text is never authority. Non-conflicts and ambiguous failures re-read durable consumption under the F locks before any retry, refusal or release (section 3.8; 19 captured shapes).
* **[R5-9] Probe assumptions corrected.** The outdated harness comment is removed; the probes seed a real frozen obligation; the real decision chain stays a named proof obligation (sections 10.4, 11.5.2).
* **[R5-10] New finding from the revision-5 probes: the lock prelude must live in the database.** The Market Intelligence consumption insert takes a lock the TradingView guard would otherwise take later; a caller that skipped F's pre-locks deadlocked with the real MI revoke. The whole prelude is one function, called by the guard and by an inert-for-unmarked trigger on the MI consumption (section 3.4.9, 6.9.2; probes O2, O2c).

Revision 4 corrections, retained unchanged:

* **[R4-A]** The revision-3 fence bumped the version on the Market Intelligence (MI) consumption insert, so the TradingView
  guard's equality check against the version F had validated always failed (probe A1: F read `8`, the MI insert moved the
  fence to `9`, the TV insert was rejected `supplied 8, current 9`). The protocol is redesigned around a **stable
  pre-consumption version** and a **single post-pair bump** (section 3.4).
* **[R4-B]** `Signal.createdAt` is `timestamp(3)` without time zone, written by the application clock, and a comparison with
  `clock_timestamp()` depends on the session `TimeZone` (probe: a 200-second-old signal is "fresh" in five of nine zones).
  A database-owned, immutable `Signal.receivedAt timestamptz` replaces it as the 120-second authority (section 3.5).
* **[R4-C]** The proposed TradingView lock order deadlocked (`40P01`) with the real Market Intelligence grant. The audit
  found one inversion; the catalog extraction found **two more in already-accepted C1/C2 code** (the TradingView
  authorization grant and its guard's `User FOR UPDATE`) and an implicit trigger lock that inverts the account-cycle/cycle
  order. Section 6 is a complete per-operation matrix including every trigger lock, the chosen correction (identity rows
  `FOR SHARE`, `User` first, no upgrades) and probes of both commit orders on the real services and guards.
* **[R4-D]** Precision corrections: the existing evidence fence does write the claim row (D1); bump counts are
  "strictly increasing", not "one per event" (D2); the C3C send-decision lock order is fixed (D3); one identity key serves
  the fence and the absence check, and it finds evidence the `orderIntentId`-only check misses (D4); every new trigger is
  inert for unmarked records (D5, probe).
* **[R4-E]** Sequencing: **C3B.3 must not schedule finalization until the C3C expired-never-sent terminalizer exists**
  (sections 3.6.8 and 8).

Correction notes in this document are marked **[R2]**, **[R3]**, **[R4]** or **[R5]**. File references are to the current repository. Baseline: C3A and C3B.1 (`733a426` and its accepted corrections); revision-4 design commit `e00e0df`.
The proposed objects exist only in the disposable overlay [`scripts/design-probes/c3b2-r5-overlay.sql`](../../scripts/design-probes/c3b2-r5-overlay.sql); they are not migrations. The revision-4 overlay and results are kept unchanged as that revision's evidence.

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

### 1.1 Market Intelligence obligation: confirmed chain and what the database guarantees **[R2, R4]**

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

**[R4] Correction to revisions 2 and 3: the database does guarantee an obligation on every consumable decision.**
Revisions 2 and 3 said `MarketPolicyBrokerDispatchDecision.obligationId` is nullable and that nothing in the database requires
an MI obligation. That was incomplete. Read from the migrated catalog:

* `BrokerDispatchDecision_obligation_check` (a `CHECK`, which no trigger bypass or `session_replication_role` can skip) requires
  `obligationId IS NOT NULL` for every outcome except `LEGACY_UNOBLIGATED_QUARANTINED` and `TECHNICAL_FAILURE`, which also
  fixes `authorityVersion = 'PAPER_MARKET_POLICY_ENFORCEMENT_V2'`.
* `validate_market_policy_broker_dispatch_decision` loads the cited obligation and rejects the decision unless the obligation's
  intent, account, assignment, Subscription, Security and symbol (and further identity columns) equal the decision's.
* `validate_market_policy_broker_dispatch_consumption` consumes only an `ALLOWED` / `DISPATCH_AUTHORIZED` decision.

So a marked intent that has no MI obligation can never obtain a consumable decision, whatever created it. (The probe's seeded
`ALLOWED` decision had to cite an obligation id for the `CHECK` to pass.) What the database does **not** do is refuse early with
a legible, auditable reason, or write the refusal through the C2 path; a defective intent would instead accumulate
`LEGACY_UNOBLIGATED_QUARANTINED` decisions. C3B.2 therefore still:

1. **Refuses before decision preparation** (definite not-sent refusal through the existing C2 refusal path, code
   `TRADINGVIEW_MI_OBLIGATION_REQUIRED`) when no frozen `OrderIntentMarketPolicyEnforcementObligation` exists for the intent,
   never running `prepareObligatedDecision` and never falling back to an unenforced MI dispatch. This is a clarity and
   hygiene rule, not the only barrier.
2. **Re-validates the obligation's identity in the final guard** (section 5.3 item 10) as defense in depth: the obligation
   belongs to this `orderIntentId`; `environment='PAPER'`; its account, assignment, Subscription, Security and Strategy equal
   the worker claim's account cycle; the decision's `obligationId`, `authorizationId`/`authorizationFingerprint`/
   `policyRevisionId`/`enrollmentGenerationId` equal the obligation's; it was admitted for the same `clientOrderId`.
3. **Tests** direct SQL that tries to create an `ALLOWED` decision without an obligation (the `CHECK` rejects it), a marked
   intent with no obligation (refusal before any decision row), and duplicate admission (the second admission returns
   `obligationId = null` yet the guard validates the stored obligation).


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
  than the signal's database receipt time plus 120 seconds (§3.5);
* grants permission for a **bounded dispatch opportunity** (§3.6);
* **does not imply that a broker call occurred**, and is not proof of delivery;
* **does not rely on any commit-time trigger guarantee.** PostgreSQL does not provide one (§3.7, probe P3).

F does not assert that the final consumption *commits* within 120 s of the signal. It asserts that the permission
it creates **expires by itself** and is useless after `authorizationDeadlineAt`, whatever happens to the commit.

### 3.3 Phase F, in order

Isolation `SERIALIZABLE`, bounded to three attempts with the C3B.1 retry classifier and a fresh transaction each
attempt (a retry is the only way to obtain a fresh snapshot). `lock_timeout` 5 s and
`idle_in_transaction_session_timeout` set for F; a timeout is a `NO_EFFECT_REFUSAL` (re-read, then at most one retry; **[R5]** 3.8), not a retryable conflict.

1. Take the §6 locks in canonical order, **one single-table statement per relation**, strongest mode any trigger
   will later request (no upgrades: SHARE→UPDATE upgrades deadlock). Identity rows are taken **before** the
   authorization (§6).
2. Validate dispatch state active, `activatedAt` set, `version` equal to the claim's `dispatchStateVersion`,
   generation equal to the claim's and the obligation's frozen generation.
3. Validate the worker claim (fingerprint, obligation, account cycle, client order ID, generation, state
   version); intent `submitting`; claim `ENTRY_SUBMITTING`, unreleased, no tracked position; its
   `WORKER_CLAIMED_FOR_SUBMISSION` event cites this worker claim; no
   `NOT_SENT/ADAPTER_INVOCATION_STARTED/DISPATCH_OUTCOME/BROKER_DELIVERY_UNCERTAIN` event; no existing MI/TV
   consumption, unenforced dispatch, `BrokerOrder`, `BrokerActivity` (under the shared identity key of section 3.4.6) or
   non-compare opportunity event.
4. Validate current eligibility from the *locked* rows: PAPER account `ACTIVE`, `tradingEnabled`, not
   `killSwitchEnabled`, not `tradingBlocked` (**pause = status ≠ ACTIVE → refuse**), assignment
   `enabled && entriesEnabled`, Subscription/Security/Strategy/ExitProfile enabled, allocation enabled and
   account-matched, source/binding enabled, revision `ACTIVE`/`TRADE_ELIGIBLE`, authorization `AUTHORIZED` with
   the obligation's fingerprint, no accepted `EXIT_LONG` on the cycle, no `pendingExitAcceptedAt` or terminal
   account-cycle state, and no open `TrackedPosition` for account + Security.
5. Validate the MI decision `D` produced: `outcome='ALLOWED'`, `dispatchDisposition='DISPATCH_AUTHORIZED'`, the
   highest `dispatchSequence` for the intent, `clientOrderId` equals the claim's, `obligationId` equals the
   locked MI obligation, `clock_timestamp() < dispatchExpiresAt` minus a small margin (§3.5); and the entry signal's receipt is
   still open (`external_signal_signal_receipt_open`, section 3.5.2).
6. **Fence read (section 3.4).** `SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE`. This is
   the **pre-consumption version `v`**, and the lock is held to commit. From here to step 8, F issues **no other fenced
   write** (section 3.4.6 lists the fenced tables); F's pair is the only thing that may move the fence while F holds it.
7. Insert the MI consumption via `insertMarketPolicyDispatchConsumption(tx, …)`. The MI consumption table is **not** in the
   fence's bump set (section 3.4.2), so `v` is unchanged afterwards (probe A2: `v` before = `v` after).
8. Insert the TV consumption (`workerClaimId`, `marketPolicyDispatchConsumptionId`, `executionObligationId`,
   `executionAuthorizationId`, `rolloutGenerationId`, `dispatchStateVersion`, same `clientOrderId`, same nullable
   `brokerPostOpportunityId`, and `fenceVersion = v`). The `BEFORE INSERT` guard stamps `authorizedAt = clock_timestamp()` and
   `authorizationDeadlineAt` (section 3.5) and rejects caller-supplied values for them, then **verifies that
   `NEW.fenceVersion` equals the locked fence row's `version`**. After the row is inserted the **one post-pair bump**
   (`v → v+1`) runs, and the `AFTER INSERT` self-verification asserts the fence is exactly `NEW.fenceVersion + 1` (a missing
   bump, or a fenced write inside F that slipped in after step 6, fails the transaction: probes A4, A5, A5b).
9. Last statement: `SELECT external_signal_assert_authorization_open(<consumption id>)`, a non-deferred, advisory check that
   `authorizationDeadlineAt − clock_timestamp()` is still at least the minimum send window. On failure the service rolls
   back. **This is a courtesy to avoid creating a permission that is already nearly expired. It is not a guarantee and no
   safety property depends on it.**
10. `COMMIT`. **No broker request is made inside F or before the permit of section 3.6.** The fence is `v+1` after a
    successful pair and `v` after a rolled-back pair (probes A2, A3).

The service-level checks in steps 2–5 give legible errors; the database guard of §5.3 is the authority. **[R5]** That guard is complete (3.4.9): it takes the canonical locks itself, so F's step-1 locks are an optimization and the explicit order of 6.5 is the service contract, not the only protection.

If F aborts for any reason it leaves no consumption, and the intent remains `submitting` with an unreleased
`ENTRY_SUBMITTING` claim: the C2/C3A "stranded worker claim" state that recovery already handles (§7).

### 3.4 The dispatch fence: a concrete, enforceable mechanism **[R4: version protocol redesigned]**

**Problem (unchanged from revision 3).** F runs SERIALIZABLE, so its validation reads use a snapshot taken before its lock
waits (section 3.1 items 1, 2, 7). The dangerous competitor writes *evidence* (a `BrokerOrder`, a newer decision, an event)
after that snapshot, possibly while only **locking** the intent and claim, so neither a row "touch" nor an `xmin` comparison
sees it. `xmin` is rejected on evidence (disposable probes P1/P1b, PG 16.13/17.11): it is satisfied while a lock-only
competitor's evidence is invisible, is false after a subtransaction write, and compares a 32-bit `xid` with a 64-bit `xid8`.

**Mechanism.** A database-maintained counter, `ExternalSignalDispatchFence(orderIntentId PK, version bigint)`, created at
version `1` by the `OrderIntent` insert trigger for a marked intent (and by the migration backfill for the marked intents that already exist, **[R5]** 3.4.8) and incremented only by `AFTER ROW` triggers on the fenced
tables (section 3.4.6), only for marked intents, only by `+1`, only from trigger context (`pg_trigger_depth() > 1`); never
deleted or truncated (probe A0 rejects direct `UPDATE`, `DELETE` and `TRUNCATE` even from a superuser session).
`session_replication_role` remains the single bypass: a privilege that no runtime role may hold (a C3B.2 role test must assert it,
section 11.2).

#### 3.4.1 The revision-3 contradiction, reproduced **[R4]**

Revision 3 put both consumption tables in the bump set and had the TV guard require `NEW.fenceVersion = fence.version`.
F reads `v`, inserts the MI consumption (the AFTER trigger bumps to `v+1`), then inserts the TV consumption with `fenceVersion
= v`; the guard compares `v` with `v+1` and rejects its own authorization. **Probe A1** (real tables, real TV consumption
guard plus the overlay guard): `fenceReadByF = 8`, `fenceAfterMiInsert = 9`, TV insert rejected with
`TradingView dispatch fence version is stale or missing (supplied 8, current 9)`.

#### 3.4.2 The corrected protocol **[R4]**

```
F (SERIALIZABLE, holds intent + claim FOR UPDATE)                          fence.version
 step 6   SELECT version FROM fence WHERE orderIntentId=$1 FOR UPDATE  → v        v
 step 7   INSERT MarketPolicyBrokerDispatchConsumption                  (not fenced) v
 step 8   INSERT ExternalSignalBrokerDispatchConsumption (fenceVersion = v)
            BEFORE INSERT guard : lock fence, require fence.version = NEW.fenceVersion    v   ✓
            row inserted
            AFTER INSERT bump   : fence.version := fence.version + 1                      v+1
            AFTER INSERT verify : require fence.version = NEW.fenceVersion + 1            v+1 ✓
 step 10  COMMIT → v+1 durable          |  ROLLBACK → v (no row anywhere)
```

* `fenceVersion` stored on the TV consumption is the **pre-consumption version F validated**, never the post-bump value.
* The bump is the single **post-pair bump**: it runs on the TV consumption insert, after that row's own guard, and nothing in
  F reads the fence again. Its job is to invalidate every snapshot that predates the pair (section 3.4.4).
* **Final values (probes A2, A3, A5):** successful pair: `fence = v+1`, `consumption.fenceVersion = v`. Rolled-back pair: fence
  `= v`, zero consumptions, and a retry succeeds and ends at `v+1`. A fenced write by F *after* step 8 is legal and raises the
  version further (`v+2`); a fenced write by F *between* steps 6 and 8 changes the version F validated and the guard rejects
  the insert (probe A5), so F must keep that window empty. Wrong, stale (`v±1`) or `NULL` `fenceVersion` is rejected (A4).
* **Self-verification (probe A5b).** With the bump trigger disabled the TV insert itself fails
  (`did not advance exactly once … stored 8, current 8`): a pair can never exist next to an unadvanced fence.
* **One-shot authorization is untouched.** It still rests on the existing unique constraints (`orderIntentId`,
  `workerClaimId`, `marketPolicyDispatchConsumptionId`, the MI decision and intent uniques); probe A2b: a second MI
  consumption for the intent is rejected.
* **Unmarked behavior is untouched.** The MI consumption primitive is unchanged and the standalone MI path never touches the
  fence (section 3.4.7).

#### 3.4.3 Why dropping the MI consumption from the bump set does not weaken release or stale-snapshot protection **[R4]**

1. **No observable "consumption without a bump".** For a marked intent the deferred `external_signal_dispatch_pair_check`
   makes a committed MI consumption impossible without the TV consumption in the same transaction, and it fails closed even
   under `SET CONSTRAINTS ALL IMMEDIATE` (probe P3: the check then runs at insert and fails the lone MI insert). The TV
   consumption always bumps, and its own self-verification forbids it without one. Every committed change of "does a
   consumption exist" therefore carries a committed `+1`, atomically with it. A competitor can never see the pair at fence `v`.
2. **An uncommitted MI insert is invisible to others and the competitors are serialized by locks F already holds.** F holds the
   intent, claim and fence rows until commit.
3. **Competitor behavior with the pair in place** (all measured, section 3.4.4): a READ COMMITTED release waits for F's claim
   lock and then reads the pair; a REPEATABLE READ or SERIALIZABLE stale writer's first fenced write updates a fence row that
   F already advanced, which is `40001`.
4. **What would break.** If *neither* consumption bumped, a stale snapshot would find the fence unchanged: probe A7.4 shows the
   consequence on the real tables. A REPEATABLE READ releaser with valid not-sent evidence of its own commits `evidence`,
   `blocked` and `RELEASED` for a claim that already has a committed pair. With the fence the same sequence is `40001` at
   every step (A7.3).

| Alternative | Verdict |
|---|---|
| Both consumptions bump; guard compares with `v` (revision 3) | Rejected: self-defeating (probe A1). |
| Both bump; guard accepts `v` or `v+1` | Rejected: it would also accept a competitor's single bump, which is exactly what the check must refuse. |
| Neither bumps | Rejected: no post-pair invalidation (A7.4). |
| **MI does not bump; TV consumption bumps once, after its own guard; verify trigger** | **Selected.** Two small triggers, no new state, no txid bookkeeping. |
| Count F's own bumps in a transaction-local variable | Rejected: more state, the same guarantee, and it hides unexpected writes the selected design rejects (A5). |

#### 3.4.4 Concurrent release, stale finalizer and evidence writers: measured **[R4]**

All rows ran on PG 16.13 and 17.11 against the real worker-claim, consumption, exposure-claim and event guards.

| Probe | Interleaving | Result |
|---|---|---|
| A7.1 | READ COMMITTED or SERIALIZABLE release starts while F holds claim + fence with an uncommitted pair; F then commits | The release **blocks** on the claim lock, then is refused by the existing release guard. Claim stays unreleased. |
| A7.2 | Release after the pair committed (snapshot may predate it) | Refused by the existing guard. |
| **A7.3** | Stale **REPEATABLE READ** or **SERIALIZABLE** releaser with valid not-sent evidence of its own, F commits the pair after its snapshot | `40001` on the evidence insert (and on every later step). Pair intact, claim unreleased. |
| **A7.4** | Same releaser, fence bump triggers **disabled** (negative control, REPEATABLE READ) | **Evidence, intent block and release all commit; the consumed claim is released.** SERIALIZABLE alone is aborted by SSI in this particular shape (A7.4b); SSI cannot be relied on in general (it ignores READ COMMITTED peers and lock-only writers). |
| A6.O1 | Lock-only competitor (a `BrokerOrder` whose foreign key only `KEY SHARE`-locks the intent) commits after F's snapshot, W = RC and SER | F's intent and claim `FOR UPDATE` **pass** (no new row version); the fence lock raises `40001`. |
| A6.O2 | F commits first, then a competitor whose snapshot predates F writes evidence | W = SER: `40001`. W = RC: proceeds, fence `v+2` (post-pair evidence is legitimate). |
| A6.O3a | Competitor in flight when F starts | F waits at the **intent** lock (the competitor's foreign key), then after commit fails at the fence (`40001`); after rollback F commits the pair at `v+1`. |
| A6.O3b | F already holds its locks; competitor's write blocks on F | Competitor proceeds only after F commits: SER `40001`, RC at fence `v+2`. |
| A6c | Negative control: `BrokerOrder` bump trigger disabled | **F commits a pair next to committed broker evidence.** This is the hazard the fence closes. |
| A8 | Existing evidence fence only (section 3.4.5) | A SERIALIZABLE claim lock fails `40001` after an evidence event of the five fenced types. |

Two consequences. First, a foreign key's `KEY SHARE` lock on the intent conflicts with F's `FOR UPDATE`, so a competitor
cannot even *insert* evidence while F holds the intent; the dangerous window is only the interval before F's locks. Second,
the pair is atomic and every protected reader is either blocked, aborted (`40001`, retry sees the pair) or already sees the
pair.

#### 3.4.5 What the existing evidence fence already protects (D1) **[R4]**

Revisions 2 and 3 said the current evidence fence "never changes the exposure claim row". **That was wrong.**
`external_signal_c2_delivery_event_fence` (C3A, migration `20261031120000`) runs `UPDATE "EntryExposureClaim" SET
"lastDiagnosedAt" = "lastDiagnosedAt"` for a marked claim on every `WORKER_CLAIMED_FOR_SUBMISSION`, `NOT_SENT_EVIDENCE_RECORDED`,
`ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED` and `BROKER_DELIVERY_UNCERTAIN` event. A same-value `UPDATE` writes a
new tuple version, so:

| Case | Existing fence | Still needs the dispatch fence |
|---|---|---|
| Release (RC) vs one of the five event types | protected: the update waits, the release guard then sees the event | |
| Release (RR/SER) with a stale snapshot vs one of the five event types | protected: `40001` | |
| F's SERIALIZABLE `claim FOR UPDATE` after one of the five event types committed | protected: `40001` (probe A8) | |
| Event of another type | | yes (no claim write) |
| `BrokerOrder`, `BrokerActivity` (insert, status update, attribution) | | **yes** (no claim write; probe A6) |
| MI decision insert, non-compare opportunity event | | **yes** |
| TV/MI consumption pair vs a stale RR/SER writer | | **yes** (A7.3/A7.4) |
| Lock-only competitor that touches neither claim nor intent | | **yes** (A6.O1, primitive P1) |

The dispatch fence adds new *bumps* for these cases and leaves the existing event fence in place; the event fence also bumps
the dispatch fence through the claim `UPDATE` (probe D2: three statements produced four bumps).

#### 3.4.6 Fenced writes, bump semantics and the shared, account-scoped evidence key (D2, D4) **[R4, R5]**

**Bump semantics (D2).** One logical event may change several fenced rows and so bump several times. The requirement is
*strictly increasing, non-skippable* protection for every invalidating row change, not "one bump per logical event". Probe
D2: an intent `UPDATE`, a claim `UPDATE` and a claim-event insert (three statements) advanced the version `8 → 12`, because the
event fence's own claim `UPDATE` is a fourth fenced write. No test may assert an exact count.

| Fenced table and operation | Why |
|---|---|
| `OrderIntent` UPDATE | status, block reason, progress |
| `EntryExposureClaim` INSERT/UPDATE/DELETE | release, status moves, diagnostics |
| `EntryExposureClaimEvent` INSERT (every type) | evidence of any kind |
| `ExternalSignalBrokerWorkerClaim` INSERT | claim events |
| `MarketPolicyBrokerDispatchDecision` INSERT | a newer decision supersedes F's |
| `MarketPolicyBrokerUnenforcedDispatch` INSERT | trigger-forbidden for marked intents; fenced as a belt |
| `OrderIntentBrokerOpportunityEvent` INSERT, non-compare types | `OPPORTUNITY_CAPTURED`, `DEFERRED`, `MISSING_OBSERVATION` are compare-only telemetry and are excluded |
| `BrokerOrder` and `BrokerActivity` INSERT/UPDATE/DELETE | broker evidence, **by the shared key below** |
| `ExternalSignalBrokerDispatchConsumption` INSERT | the single post-pair bump |
| `MarketPolicyBrokerDispatchConsumption` INSERT | **deliberately not fenced** (section 3.4.3) |

Identity and authority rows (`TradingAccount`, `TradingAccountSubscription`, `Subscription`, `Security`, allocation, source,
binding, revision, generation, cycle, account cycle, authorization, rollout and dispatch state) are **not** fenced: their
changes are row-version updates and F locks them, so a SERIALIZABLE F gets `40001` after any committed change (probes C6b,
C7). An accepted EXIT signal also writes the source cycle (`Signal_external_exit_touch_source_cycle`, an `AFTER INSERT`
`UPDATE` of the cycle row), so F's cycle lock fails `40001` after an EXIT ingest committed after its snapshot (read from the
catalog; a probe is a remaining obligation, section 11).

**One account-scoped identity key (D4, MEDIUM finding) [R5].** A broker row belongs to a marked intent only when its **trading account is the marked
intent's trading account** *and* any of these hold: its `orderIntentId` names the intent; its `clientOrderId` equals the frozen
`ExternalSignalEntryExecutionObligation.clientOrderId`; for activity, its `orderId` equals the `brokerOrderId` of a **same-account** `BrokerOrder` that belongs to the
intent (by `orderIntentId` or by `clientOrderId`); or its `brokerOrderRecordId` names a **same-account** `BrokerOrder` that belongs to the intent. One SQL function,
`external_signal_broker_evidence_marked_intents(orderIntentId, clientOrderId, brokerOrderId, tradingAccountId, brokerOrderRecordId)`, returns the marked intents
and has four consumers: the fence triggers, the quarantine, the complete consumption guard (through `external_signal_marked_intent_broker_evidence`, which runs the same
function in reverse for one intent) and F's step 3. Both old and new values of an `UPDATE` are resolved, so attribution to the intent and a move away from it both bump.

*Revision 4's key had no account scope* (`b."tradingAccountId" IS NOT DISTINCT FROM p_account_id` in two branches and none in the others), so an order of **another
account** that merely shared a `clientOrderId` or a broker order id would bump a PAPER marked intent's fence and, once the quarantine used the key, would be rejected by
it. A `NULL` account compared equal to a `NULL` account. Revision 5 requires `i."tradingAccountId" = p_account_id` for the candidate intent in the single outer predicate
(so no branch can bypass it) and `b."tradingAccountId" = p_account_id` for every `BrokerOrder` used as a bridge; **`NULL` never matches**.

**The quarantine on the shared key.** C3B.2 still quarantines *all* broker evidence for a marked intent (C3C relaxes it), but through the scoped key, and with two added
refusals so that excluding other accounts cannot hide anything: a row that **names a marked intent by `orderIntentId` but carries another or no account** is refused as
contradictory (`broker evidence names a marked TradingView intent but carries a different or unknown trading account`), and a row with **no account** that any identifier ties to a
marked intent is refused as unattributable. An unrelated LIVE order is accepted and moves nothing. The quarantine is relaxed (C3C) only in a migration that keeps the
shared key, both refusals, the fence bumps and the guard's absence check together.

**Measured** (`c3b2-r5-scope-section.ts`: a PAPER marked intent and a LIVE account; same `clientOrderId`, same broker order id strings; PostgreSQL 16.13 and 17.11):

| Probe | Case | Result |
|---|---|---|
| S0 | The key function, nine argument shapes | PAPER matches for intent id, `clientOrderId`, `brokerOrderId` and `brokerOrderRecordId`; LIVE and `NULL` never match |
| S1 | **Quarantine enabled** (the real C3B.2 state): LIVE BrokerOrder with the marked `clientOrderId`; LIVE activity by `orderId`; LIVE activity by `brokerOrderRecordId` only; LIVE status sync | all **accepted**; the PAPER fence does not move |
| S1b | Those LIVE rows exist, then the PAPER pair is inserted by the complete guard | the PAPER pair **commits**: LIVE rows are not PAPER evidence |
| S2 | PAPER evidence by intent id, by the frozen `clientOrderId` under another intent, by activity intent id | all **rejected** by the quarantine (revision 4 accepted the second); fence unchanged |
| S3 | A row naming the PAPER intent but carrying LIVE or no account | **rejected** as contradictory |
| S4, S4b | Quarantine relaxed: PAPER BrokerOrder by intent id and by `clientOrderId`, activity by `orderId`, activity by `brokerOrderRecordId` **only** (`orderId` and `orderIntentId` absent) → each bumps; LIVE counterparts → **zero** bumps, including a LIVE activity using the **same order-id string** as the PAPER order; attributing an unattributed PAPER activity bumps and moving it away bumps again; attributing a LIVE activity bumps nothing; retargeting a LIVE order's `clientOrderId` bumps nothing | as stated |
| S4c | Quarantine enabled: attributing a LIVE or `NULL`-account activity to the PAPER marked intent | **rejected**, no bump |
| S5 | `NULL`-account activity tied to a marked intent by order id or record id | **rejected**; an unrelated `NULL`-account activity is accepted |

*A BrokerActivity reachable only through `brokerOrderRecordId`* (no `orderId`, no `orderIntentId`) was invisible to revision 4's key and to every
`orderIntentId`-keyed check. Its BrokerOrder is evidence in its own right, so the absence check would trip on that order; the record-id branch matters for the **fence**: a
new activity row linked only by record id must bump (S4), and for activity whose BrokerOrder was later detached or removed. Activity with no BrokerOrder row, no intent and no
account cannot be tied to an intent by any database key; only the authoritative client-order-ID lookup (section 3.6.6) covers it.

#### 3.4.7 Unmarked compatibility, cost and hazards (D5) **[R4]**

* **Inert for unmarked records.** Each bump trigger resolves the marked set first and returns without a write, lock or
  error when it is empty; the `OrderIntent` insert trigger creates a fence only for a marked intent. Probe D5 drove an
  unmarked intent through claim insert and update, claim event, intent status moves, `BrokerOrder` insert and status sync,
  a legacy-style `BrokerActivity` insert, `updateMany` attribution, deletes and a claim delete, in one transaction: zero
  fence-table inserts, updates or deletes (read from `pg_stat_xact_user_tables` as a delta inside the transaction) and every
  existing fence version unchanged. SQL-level equivalents are not the services: C3B.2 acceptance must also run the existing
  legacy fill-import, broker-activity synchronization and order-lifecycle integration suites against a database carrying the
  new triggers (section 11).
* **Cost.** Unmarked `BrokerOrder`/`BrokerActivity` writes pay one extra index probe on `OrderIntent` and on
  `ExternalSignalEntryExecutionObligation`. The migration adds a partial index on `ExternalSignalEntryExecutionObligation
  ("clientOrderId")` and a `BrokerOrder ("tradingAccountId","brokerOrderId")` lookup already exists. The function must be
  written typed (not the probe overlay's `to_jsonb` dispatch) and its plans checked.
  **[C3B.2-1 correction]** That sentence was wrong about the index: the existing account-scoped unique index has `broker` as its middle column, so a lookup by account and broker order id walked the whole account range, and `BrokerOrder.orderIntentId` had no index at all. Measured on 20 000 historical rows, the first typed implementation cost about 480 µs per unmarked broker write (against about 30 µs before); section 13.6 records the corrected design and measurements.
* **Lock position.** The fence is the last lock a writer takes (row 24, section 6.5): the bump runs after the intent/claim
  write. Order sync and any `updateMany` over several rows must visit intents in ascending id, or accept `40P01` as fail-closed
  noise.
* **No bypass for a runtime role:** no `UPDATE`/`DELETE`/`TRUNCATE` privilege on the fence, no `session_replication_role`,
  no `ALTER TABLE … DISABLE TRIGGER` (table owner). The tests of section 9 that disable triggers (A5b, A6c, A7.4) do so only
  in the disposable database as the owner, as controls.

#### 3.4.8 Fence creation, backfill of existing marked intents, and INSERT integrity (HIGH finding, LOW finding) **[R5]**

**The defect.** Revision 4 created a fence only from an `AFTER INSERT` trigger on `OrderIntent`. Every marked intent that already exists when the
migration runs (C2 and C3A produced them; the persistent development database holds some) would have **no fence**. The first fenced write on it
raises `marked intent N has no dispatch fence`, so recovery, evidence writing and release would all fail closed for exactly the intents that most
need them. The revision-4 probes always built their graphs after the overlay, so the gap was invisible to them.

**The corrected migration sequence.** One forward-only migration, applied by Prisma as one multi-statement script, which is one transaction
(`c3b2-r5-overlay.sql` is that script, statement for statement):

| Step | Statement | Why it is there |
|---|---|---|
| 0 | `SET LOCAL lock_timeout = '15s'`; **one** `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE` over `OrderIntent`, the eight other fenced tables, both consumption tables and `Signal` | `SHARE ROW EXCLUSIVE` conflicts with every `INSERT`/`UPDATE`/`DELETE` (and with itself) and permits reads. One statement, one fixed order, held to `COMMIT`: from here until commit no marked intent can be created, changed or deleted and no fenced row can be written, and every transaction that already wrote one has finished before the backfill reads. A missed worker drain becomes a bounded wait or a clean failure, never a missing fence. |
| 0b | Preconditions: fence table absent; no TradingView consumption pair exists | The consumption table gains `NOT NULL` columns, and a second application of the script must fail rather than half-apply. |
| 1 | `CREATE TABLE "ExternalSignalDispatchFence"` and its guard function | |
| 2 | **Backfill:** `INSERT … SELECT id, 1 FROM "OrderIntent" WHERE "externalSignalAccountCycleId" IS NOT NULL` | Runs **before any trigger exists on the fence** and before the table is visible to any other session. That is the migration's own, un-spoofable creation context (no setting, role or flag is involved). Unmarked intents get nothing. Nothing else is read or written, so claims, events, positions, terminal states and signal rows are untouched. |
| 3 | Install the fence guard (`BEFORE INSERT OR UPDATE OR DELETE`) and the `TRUNCATE` guard | After the backfill, so the backfill needs no exception in the guard. |
| 4 | Install `OrderIntent_dispatch_fence_create` (`AFTER INSERT`) | From the migration's `COMMIT` on, every new marked intent receives its fence in its own insert statement. `externalSignalAccountCycleId` is insert-only and immutable (`OrderIntent_external_signal_origin_immutable`), so an `UPDATE` can never promote an unmarked intent and the trigger needs no `UPDATE` branch (probe I1e). |
| 5 | Install the bump triggers | After the backfill, so the backfill does not bump (historical fences are exactly version 1). |
| 6 | `DO` block: no marked intent without a fence, no fence without a marked intent, every version 1 | Any failure rolls the whole migration back. |
| 7 | `Signal.receivedAt` (nullable, **no default, no backfill**), its guard, the receipt and epoch functions, candidate-side timestamp stamps, consumption columns, the complete guard (3.4.9), the post-pair bump and verify triggers | Section 3.5 and 3.4.9. |

**What this guarantees, and what each probe measured** (`c3b2-r5-upgrade-probes.ts`: PostgreSQL 16.13 and 17.11, a database that holds six
historical marked intents *before* the script runs: claim `ENTRY_PENDING` with the intent `received`, the same with the intent `pending`, two
`ENTRY_SUBMITTING`, one `BLOCKED` with its not-sent evidence recorded and the claim still held, and one fully released; plus an unmarked intent):

| Probe | Result |
|---|---|
| U0 | The historical population exists in all six states and no fence table exists. |
| U1 | With a writer holding a marked intent open, the migration fails on `lock_timeout` (`55P03`) and **leaves no table, trigger or column behind** (atomic). |
| U2 | A marked-intent writer started *while the migration transaction was open* blocks behind the table locks and completes after `COMMIT`, with a fence created by the new trigger. |
| U3 | Every one of the six historical marked intents has a fence at version 1; the unmarked intent has none; no extra fence; no marked intent without a fence. |
| U4a | All rows that existed before the migration are **byte-identical** afterwards in ten tables (worker claims, exposure claims, claim events, intents, signals, obligations, account cycles, source cycles, authorizations, positions). |
| U4b | **No receipt was manufactured**: the six historical signals still have `receivedAt IS NULL`, and `external_signal_signal_receipt_open` is `false` for each. |
| U5 | C2 pre-dispatch recovery of a historical `ENTRY_SUBMITTING` intent (not-sent evidence, block, release) **works after the upgrade**, with the fence only increasing. |
| U6 | A historical `ENTRY_SUBMITTING` graph with a valid Market Intelligence decision, a valid pair and the current fence version is **refused final authorization** (`TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`): its signal has no receipt. |
| U7 | The historical `BLOCKED` graph still releases; the historical released graph stays released. |
| U8 | Applying the script a second time fails on its own precondition and changes nothing. |
| U9 | A marked intent created after the migration has its fence (created at 1, advanced by the claim insert of its own admission) and its entry signal has a database receipt. |

Historical recovery needs no receipt: nothing in the C2/C3A recovery path reads `Signal.receivedAt`; only broker *authorization* does.

**Fence INSERT integrity (LOW finding).** A runtime role with ordinary DML privileges could, in revision 4, insert any fence at any version for any
intent. The `BEFORE INSERT` branch of the fence guard now requires all of: `pg_trigger_depth() >= 2` (the only inserter is the
`OrderIntent` creation trigger, so a direct statement, which runs the guard at depth 1, is refused), `version = 1`, and an existing intent whose
`externalSignalAccountCycleId IS NOT NULL`. The `UPDATE` branch is unchanged (trigger-issued strict `+1`); `DELETE` and `TRUNCATE` are refused. Probes I1a to I1e:
as the owner/superuser and as a role holding `SELECT, INSERT, UPDATE, DELETE` on every table, an insert for an unmarked intent, an insert at version
999, an insert at version 1 issued directly, a direct `UPDATE`, `DELETE` and `TRUNCATE` are all rejected and the table is unchanged; `SET
session_replication_role` is refused to the role; and the *legitimate* path still works under the restricted role (a marked intent inserted by it receives
its fence from the trigger). A marked intent that nevertheless lacks a fence (a missed backfill, or an owner deleting the row with the guard disabled) is
**detectable** (`SELECT count(*) FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM
"ExternalSignalDispatchFence" f WHERE f."orderIntentId" = i.id)` must be `0`; this belongs in the broker-enabled preflight) and **fails closed**: every
later fenced write on it raises, and with the creation trigger disabled even admission fails at its first fenced write (the claim insert). The bypasses that
remain are owner-only (`DISABLE TRIGGER`, `session_replication_role`), which the existing preflight denies to the runtime role.

#### 3.4.9 A correct fence version is necessary but not sufficient: the complete consumption guard (MEDIUM finding) **[R5]**

**The gap.** The fence detects *change after F read it*. Broker evidence that committed **before** F read the fence is already inside the version F
read, so a caller that supplies the current version passes the equality check. Revision 4 put only that equality check in the new insert guard and
left the rest of the guard to the caller. Probe **E0** replaces the guard, under the same trigger name, with the revision-4 shape (fence equality
only) and commits a BrokerOrder for the same intent and account first: a plain `READ COMMITTED` direct-SQL transaction reads the current fence
version, inserts a valid MI consumption and a valid TradingView consumption, and **both commit next to the committed BrokerOrder**.

**The two mechanisms are complementary, not redundant** (probes **A6c.RC** and **A6c.SER**, bump trigger disabled so only the other mechanism is left):

| F isolation | Guard evidence check (reads after its locks) | Fence bump | Outcome with the fence bump **disabled** |
|---|---|---|---|
| `READ COMMITTED` | each statement takes a fresh snapshot, so it sees the committed evidence | not needed | pair **refused** `TRADINGVIEW_BROKER_EVIDENCE_EXISTS` |
| `SERIALIZABLE`, snapshot older than the evidence's commit | reads the stale snapshot and does not see it; a lock-only writer leaves the intent and claim row versions unchanged | **required**: the fence lock raises `40001` | pair **committed** next to the evidence (negative control) |

So the guard covers READ COMMITTED callers and the fence covers stale SERIALIZABLE snapshots; each proves the other is needed.

**The replaced guard is complete** (`external_signal_broker_consumption_guard`, same trigger name `ExternalSignalBrokerDispatchConsumption_guard`, so the
manifest binding is unchanged). Its structure:

1. Reject any caller-supplied `authorizedAt` or `authorizationDeadlineAt` (database-stamped).
2. **Take every lock first**, in the section 6.5 order, by calling `external_signal_lock_dispatch_graph(intent, decision)` (rows 1 to 23), then the fence
   `FOR UPDATE` (24), the worker claim, the TradingView obligation and the Market Intelligence obligation `FOR SHARE` (25 to 27). Every mode equals the mode a
   pre-locking caller used, so there is no upgrade and a caller that pre-locked waits on nothing. After this point every read is of a locked row: under
   `READ COMMITTED` a fresh read; under `SERIALIZABLE` a row changed after the snapshot would already have raised `40001` at its lock, so the snapshot
   value is the latest committed one.
3. Fence equality (`TradingView dispatch fence version is stale or missing`).
4. **Only then** the checks, in this order: PAPER BUY TradingView scope; the **exact worker claim** (obligation, account cycle, generation, dispatch-state
   version, client order ID) and its `WORKER_CLAIMED_FOR_SUBMISSION` event citing it; intent `submitting` and an unreleased `ENTRY_SUBMITTING` claim with no tracked
   position; **no contradictory lifecycle evidence** (`NOT_SENT_EVIDENCE_RECORDED`, `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`,
   `BROKER_DELIVERY_UNCERTAIN`, any prior consumption or unenforced dispatch, any non-compare opportunity event); **no broker evidence**, by
   `external_signal_marked_intent_broker_evidence(intent)`, which finds every `BrokerOrder` and `BrokerActivity` row that the **shared account-scoped key
   of 3.4.6** maps to the intent (the candidate predicates only narrow the scan; membership is decided by the shared function); the authorization and
   its fingerprint; the dispatch state; account, assignment, Subscription, Strategy, ExitProfile, Security and allocation eligibility; no accepted EXIT, no
   pending exit, no open position; the **decision is the latest** for the intent, `ALLOWED`/`DISPATCH_AUTHORIZED`, same client order ID, not within 2 s of its
   expiry; the **frozen Market Intelligence obligation** exists and matches the decision and the account cycle (account, assignment, Subscription,
   Security, Strategy, authorization, fingerprint, policy revision, generation); the MI consumption cites the same intent, client order ID and opportunity;
   the signal **receipt** is open with at least 5 s left (a `NULL` receipt fails closed) and the receipt is not before the activation epochs.
5. Stamp `authorizedAt` and `authorizationDeadlineAt = least(receivedAt + 120 s, authorizedAt + 30 s)`.

The after-insert bump and the self-verifying trigger are unchanged from 3.4.2.

**The lock prelude lives in the database, not the caller (new finding, probe O2).** The MI consumption insert (step 7 of F) runs the existing Market
Intelligence consumption trigger, which takes the **MI authorization** lock (row 19) *before* the TradingView guard reaches the identity rows (10 to
16). A caller that skipped F's step-1 pre-locks therefore held row 19 while waiting for the assignment (row 11), and the real MI revoke service holds the
assignment while waiting for row 19: **probe O2c deadlocked (`40P01`) against the real revoke service**. The correction is structural: the whole prelude is
one function, `external_signal_lock_dispatch_graph`, called by the guard **and** by a `BEFORE INSERT` trigger on the MI consumption that is inert for
unmarked intents (`BrokerDispatchConsumption_a_lock_prelude`; its name sorts before the existing `BrokerDispatchConsumption_validate`). With it, both queue
orders against the real MI revoke complete with no deadlock and a consistent outcome (O2: the pair commits and the revoke applies after it, or the revoke wins and
the pair is refused `BROKER_DISPATCH_AUTHORIZATION_CHANGED`); without it, O2c reproduces the deadlock. F's explicit step-1 locks remain the service contract
and are now an optimization, not a correctness requirement. It also means a mutation of a row F already locked simply waits for F; the interesting race is the
one between F's snapshot and its first lock, which is where the probes below place it.

**Measured** (`c3b2-r5-consumption-section.ts`, direct SQL, **no caller pre-locks**, the **current** fence version supplied in every rejected case; PostgreSQL 16.13 and 17.11):

| Probe | Case | Result |
|---|---|---|
| E0 | Negative control: fence-only guard, committed BrokerOrder, `READ COMMITTED` | pair **committed** (the hazard) |
| E1 × {RC, SER} | Evidence committed before F: BrokerOrder for the intent id; BrokerOrder under **another intent** carrying the marked `clientOrderId` (same account); BrokerActivity for the intent id with no order id; claim events `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`, `BROKER_DELIVERY_UNCERTAIN`; a contradictory `NOT_SENT_EVIDENCE_RECORDED` | all 14 rejected (`BROKER_EVIDENCE_EXISTS` or `CONTRADICTORY_EVIDENCE`); zero MI and zero TradingView consumption rows |
| E2 × {RC, SER} | World state changed between F's snapshot and its locks: kill switch; account `PAUSED`; `tradingBlocked`; assignment entries disabled; signal receipt **200 s old**; signal receipt **`NULL`** (historical); accepted EXIT pending; claim released; intent no longer `submitting`; worker claim of another intent; MI obligation drifted (fingerprint, security); TradingView authorization revoked; dispatch-state version advanced | all 28 rejected: under `READ COMMITTED` by the guard's or the MI trigger's own message, under `SERIALIZABLE` by the guard message or `40001`; zero rows |
| E2b × {RC, SER} | A newer MI decision supersedes the consumed one (seeded with triggers off; its bump modeled for SERIALIZABLE by a fenced intent write) | rejected `TRADINGVIEW_DECISION_SUPERSEDED` (RC) / `40001` (SER) |
| E3 × {RC, SER} × {writer commits, rolls back} | **Evidence in flight during F**: an uncommitted BrokerOrder holds `KEY SHARE` on the intent | F **waits** at the canonical prelude (the intent lock); writer commits → RC refused (the fence moved while F waited, or the evidence check), SER `40001`; writer rolls back → F commits the pair |
| E4 × {RC, SER} | **F commits first**; a writer whose snapshot predates F then writes evidence | pair intact; SER writer `40001`; RC writer records the evidence at a later fence version (post-pair evidence is what a send produces) |
| E5 × {RC, SER} | Success path, direct SQL, no pre-locks | pair commits; `fenceVersion = v`, fence `≥ v+1`; `authorizationDeadlineAt ≤ authorizedAt + 30 s` and `≤ receivedAt + 120 s` |
| E5b | Caller-supplied `authorizedAt` / `authorizationDeadlineAt` | rejected |

The A-series of 3.4.2 to 3.4.4 was re-run unchanged against the complete guard and the canonical F lock sequence (30 checks, section 10.3).

**What this still does not prove.** The decision rows are seeded with triggers off (the real `prepareObligatedBrokerDecision` chain is proof obligation 11.2-4);
two E2 cases are rejected by the production MI trigger before the TradingView guard runs (`BROKER_DISPATCH_INTENT_NOT_EXECUTABLE`), which is defense in depth, not a
gap; the guard's `SERIALIZABLE` correctness for the evidence tables rests on the fence bumps (A6, E3, E4), so every writer of a fenced table must be audited (6.8-H).

### 3.5 Signal freshness, the receipt clock and the authorization deadline **[R4: replaced]**

`D` and `F` are separate so that market evaluation (reads, possibly slow) is not inside the serialized lock window. F
re-checks `clock_timestamp() < dispatchExpiresAt − margin` (proposed 2 s, courtesy only); the MI consumption trigger already
re-checks `clock_timestamp() < dispatchExpiresAt`. On failure F rolls back; the orchestrator may run `D` once more (a later
`dispatchSequence` supersedes the older decision) and retry F **once**, inside the signal bound; otherwise it records a
definite-not-sent refusal.

#### 3.5.1 Why `Signal.createdAt` cannot be the 120-second authority

Read from the migrated catalog and measured (probes B0, B1, B1b, B5):

* `Signal.createdAt` is `timestamp(3) without time zone` (an older table than the `timestamptz(3)` ones) with
  `DEFAULT CURRENT_TIMESTAMP`. The database default converts the instant to the **session's** wall time. Prisma 7 with
  `PrismaPg` supplies its own value from the **application clock**, interpreted as UTC. The two writers therefore disagree
  with each other by the session offset, and `createdAt + interval '120 seconds' > clock_timestamp()` implicitly casts the
  naive timestamp using the **session `TimeZone`**.
* Measured on the real `Signal` table with a receipt exactly 200 s old and `createdAt` written the way Prisma writes it
  (UTC wall time):

| Session time zone | Legacy `createdAt` comparison says the 200 s-old signal is fresh? | `receivedAt` rule says fresh? |
|---|---|---|
| UTC, Asia/Kolkata, Pacific/Kiritimati, Asia/Tokyo | no | no |
| America/New_York, America/Los_Angeles, America/Phoenix, Etc/GMT+12, PST8PDT | **yes (accepted)** | no |

  The same table was obtained with `SET TIME ZONE`, `set_config('TimeZone', …)` and `SET LOCAL` in a transaction; the
  `receivedAt` rule gave the identical answer in all 27 combinations. Startup parameters (`options=-c TimeZone=…`) and
  `ALTER DATABASE … SET TimeZone` gave the same (probe B1c).
* The three current age checks use three clocks: the admission service compares `clock_timestamp()` (database) with a Prisma
  `Date` read from `createdAt` (`validateTradingViewSignalFreshness`), the worker claim compares `Date.now()` (application)
  with the same `Date` (`external-signal-broker-worker.service.ts:83`, `C2_MAX_SIGNAL_AGE_MS`), and the F guard would use
  `clock_timestamp()` against the `timestamp` column. None is wrong in isolation under a UTC application host with a
  synchronized clock; none is correct by construction.
* `interval '1 day'` arithmetic is calendar/session dependent (probe B5: one New York calendar day across the spring-forward
  date differs from 86 400 seconds), so the window is always `make_interval(secs => 120)`.

#### 3.5.2 Design: a database-owned, immutable `Signal.receivedAt timestamptz`

| Property | Mechanism (all probed on the real `Signal` table, B2 to B5) |
|---|---|
| The database, not Prisma or the webhook caller, decides the instant | `BEFORE INSERT` trigger `external_signal_signal_received_at_guard` sets `NEW."receivedAt" := transaction_timestamp()`. The column has **no default** and Prisma's `create` omits it. |
| Callers cannot supply, backdate or advance it | A non-`NULL` value at insert is **rejected** (`Signal.receivedAt is database-owned and cannot be supplied`), for both a past and a future value, under any session zone (B2, B2b). |
| Immutable after insert | `BEFORE UPDATE` rejects any change, including `NULL → value` (a historical row can never be given a receipt) and `value → NULL` (B3). `DELETE` is already forbidden by `external_signal_signal_v2_immutability_guard`. |
| `timestamptz`, direct comparison, no session conversion | The freshness functions compare `receivedAt + make_interval(secs => 120)` with `clock_timestamp()`, both `timestamptz` (B1: 27/27 identical answers). |
| One definition used by every gate | `external_signal_signal_receipt_remaining(signalId) → interval` and `external_signal_signal_receipt_open(signalId, minimumRemaining) → boolean`, both `VOLATILE` (they read `clock_timestamp()`), with the pinned `search_path`. |
| Historical signals fail closed | `receivedAt IS NULL` ⇒ `remaining` is `NULL` ⇒ `open` is `false`. Every future broker authorization (admission, worker claim, F, C3C permit) calls `open`, so a pre-migration signal can never authorize broker work. |
| No accidental freshness by backfill | `ALTER TABLE … ADD COLUMN "receivedAt" timestamptz` **without** a default and without a backfill. Probe B4's negative control: `ADD COLUMN … DEFAULT now()` stamps a 30-day-old row with the migration time and makes it look fresh. |
| `createdAt` is preserved | It stays as the application-written audit and presentation value for every historical and future record. **[R5]** It is no longer an age authority and no longer enters any execution-eligibility comparison: every comparison with an activation epoch was audited and moves to `receivedAt` (3.5.5). |

**Why `transaction_timestamp()` and not `clock_timestamp()`.** The ingestion service writes the signal inside an interactive
Prisma transaction. `transaction_timestamp()` (`now()`) is the start of that transaction, so a lock wait or stall before the
insert makes the receipt **earlier**, never later: it can only shorten the allowed window. `clock_timestamp()` at the insert
would make a signal look younger by the length of any such stall (probe B2: a 2-second sleep before the insert produced a
receipt about 2 s old at read time). `statement_timestamp()` has the same weakness. Neither is influenced by `TimeZone`.

**Migration (future, forward-only, not applied here).**

1. `ALTER TABLE "Signal" ADD COLUMN "receivedAt" timestamptz;` (nullable, no default, no backfill, no rewrite).
2. The guard function and trigger, then `external_signal_signal_receipt_remaining` and `…_open`, each with
   `SET search_path = pg_catalog, public, pg_temp`, added to the regenerated security manifest.
3. Prisma schema: `receivedAt DateTime? @db.Timestamptz(6)` with **no** `@default`, documented as database-owned; the generated
   client's `SignalCreateInput` then lets a caller pass it, which the trigger rejects. A unit test asserts the ingestion
   `tx.signal.create` call never includes the field.
4. Ingestion (`external-signal-ingestion.service.ts`, `tx.signal.create`): unchanged except that downstream code must
   **read** `receivedAt` (it is `NULL` in the object Prisma returns unless selected after insert).
5. Gates switched to the database functions: admission `validateTradingViewSignalFreshness`, the worker claim's JavaScript
   check (`external-signal-broker-worker.service.ts:83`), the replaced TV consumption guard, and C3C's permit guard.
6. No `CHECK ("receivedAt" IS NOT NULL)` is added: historical rows are `NULL` by design, and the insert trigger already
   guarantees a value on every new row.

#### 3.5.3 What the 120-second rule measures, and what it does not

The rule measures **the age of the server's receipt of the webhook delivery**, by the database clock. It does **not** measure
how old the TradingView event is. `signalTime` and `barTime` come from the alert payload and are authenticated only as far
as the webhook credential is (a holder of the URL token can send any value), and delivery may be delayed or retried by
TradingView or the network before the server receives it. A signal generated minutes ago and delivered now has a fresh
`receivedAt`. **No document, log line or UI string may claim external-event freshness.** If an independent bound on event age
is wanted, it must be an additional, only-ever-more-conservative condition: authorize only when the server receipt is within
120 s **and**, where `signalTime` is present, `receivedAt − signalTime` is within a stated skew bound. That condition is
sender-asserted and can only shorten the window; it is a proposal for the owner to decide, not part of this design.

#### 3.5.4 The authorization deadline **[R4: receipt-based]**

The TV consumption gains, in the C3B.2 migration:

| Column | Value |
|---|---|
| `authorizedAt timestamptz NOT NULL` | `clock_timestamp()` in the `BEFORE INSERT` guard. Caller values rejected. |
| `authorizationDeadlineAt timestamptz NOT NULL` | `least(signal."receivedAt" + make_interval(secs => 120), "authorizedAt" + make_interval(secs => 30))`. The 30 s *dispatch window* is a proposed, reviewable constant; it may never exceed the receipt bound. |
| `fenceVersion bigint NOT NULL` | The pre-consumption version (section 3.4.2). |

The guard **refuses to create** a consumption when `external_signal_signal_receipt_open(signalId, minimumSendWindow)` is false
(`NULL` receipt included), with `TRADINGVIEW_ENTRY_SIGNAL_EXPIRED`; the minimum send window is a proposed 5 s. Existing guards
make consumption rows immutable; the migration extends that to the new columns and a test proves it.

**What F guarantees, and what it deliberately does not (unchanged in substance).**

* Guaranteed: no consumption is *created* for an expired or unreceipted signal; every consumption carries a deadline no later
  than receipt + 120 s that the database stamped and nothing can change.
* **Not guaranteed:** that the transaction *commits* before that deadline. Lock waits, WAL flush, a stalled client or
  `SET CONSTRAINTS` games can place the commit later. That is harmless **by construction**: a consumption that commits after
  its deadline is born expired and nothing may act on it (section 3.6); its exposure is handled by the expired-never-sent
  protocol (section 3.6.3).

#### 3.5.5 One database clock for every execution-eligibility comparison (MEDIUM finding) **[R5]**

**Principle.** `Signal.receivedAt timestamptz` is the age authority (3.5.2). Revision 5 extends it to every comparison of a signal instant with an
**activation epoch** (`ExternalSignalExecutionRolloutState.activatedAt`, `ExternalSignalBrokerDispatchState.activatedAt`,
`ExternalSignalEntryExecutionAuthorization.authorizedAt`): the compared values must be `timestamptz` on **both** sides and both must have been written by the
database. Anything else is either session-`TimeZone` dependent or exposed to application-clock skew, and either can extend eligibility.

**What `receivedAt` is, and what it is not.**

| Instant | Written by | Clock | Meaning | Used for |
|---|---|---|---|---|
| `Signal.receivedAt` (`timestamptz`, new) | `BEFORE INSERT` trigger: `transaction_timestamp()` | database | **start of the ingestion transaction.** Not the exact HTTP arrival instant: it is later than the socket read by the request parsing, authentication and lock-wait time before the transaction began, and never later than the insert | the 120-second rule; every comparison with an activation epoch |
| `SignalDelivery.receivedAt` (`timestamp`, existing) | the HTTP handler (`evidence.receivedAt`) | **application** | when the application saw the request; delivery evidence | audit and operator display only; never compared with an epoch or an age limit |
| `Signal.createdAt` (`timestamp`, existing) | Prisma `@default(now())` | **application** (naive UTC wall time) | when the row was written, as the application saw it | presentation and history only; preserved unchanged for every historical and future record |
| `signalTime`, `barTime` | the alert payload | **sender-asserted** | what the sender claims | observational only in this implementation (3.5.3); never an input to eligibility |

A long-open ingestion transaction makes the receipt earlier than the insert and so can only shorten the window, never extend it. The 120-second rule stays mandatory and is evaluated on
the database clock.

**The epoch side is already correct (new finding).** The accepted C1 guards stamp the epochs with `statement_timestamp()`
(`ExternalSignalEntryExecutionAuthorization_guard`: `NEW."authorizedAt" := statement_timestamp()`; both activation guards: `NEW."createdAt" := statement_timestamp()`, which the state
trigger copies into `activatedAt`). Probe **T3** runs the production grant service with the application `Date` made **one hour slow**: `authorizedAt` is current to within 0.02 s,
while an unstamped Prisma `@default(now())` column (`SystemEvent.createdAt`, the control) is 3600 s behind. So no epoch trigger is added; revision 5 does not duplicate a guard that exists.

**The candidate side is not.** Two more application-clock instants are compared with the epochs, and are database-stamped in the migration, **overwritten** at insert (Prisma always supplies one, so
rejecting a supplied value would break it; probe T3b: a supplied value from yesterday or tomorrow ends within a second of the database clock) with `clock_timestamp()`, which is never earlier than the
transaction start that stamps the signal, so any skew can only shrink eligibility. Historical rows are not touched:
`ExternalSignalTradeCycleAccount.createdAt` (`timestamptz`, `external_signal_epoch_created_at_stamp`) and, for **marked intents only**, `OrderIntent.createdAt` (naive UTC wall time, to keep its format).

**The audit.** Every comparison of a signal, account-cycle or intent instant with an epoch or an age, found by a catalog scan of function bodies and a source scan of `src/services` (probe T4; results file
`epochAudit`), and the disposition of each:

| # | Where | Expression today | Types and clock | Exposure | Disposition |
|---|---|---|---|---|---|
| 1 | Admission pre-check, `processProspectiveTradingViewEntries` (`external-signal-entry-admission.service.ts:58`) | `now(app) − signal.createdAt` against `maxAgeMs` | JS `Date` against a naive column; application clock on both sides | skew between writer and reader | **service:** select `external_signal_signal_receipt_open(sig.id)` in the candidate query; no JavaScript age arithmetic; `NULL` receipt ⇒ refuse `ENTRY_SIGNAL_EXPIRED` |
| 2 | Correlation `prospectiveExecution` (`external-signal-correlation.service.ts:24`) | `sig."createdAt" >= state."activatedAt" AND sig."createdAt" >= auth."authorizedAt"` | **naive against `timestamptz`**: implicit cast with the **session `TimeZone`** | TimeZone: probe T1 | **service SQL:** `external_signal_signal_received_since(sig.id, state."activatedAt") AND …(sig.id, auth."authorizedAt")` |
| 3 | TradingView admission lock statement (`market-policy-entry-admission.service.ts:101-102`) | the same two comparisons for `sig`, and `ac."createdAt" >= …` for the account cycle | `sig`: naive against `timestamptz` (implicit cast); `ac`: `timestamptz`, application clock | TimeZone for `sig`; skew for `ac` | **service SQL:** receipt function for `sig`; `ac.createdAt` is database-stamped (above) |
| 3b | Admission freshness read (`market-policy-entry-admission.service.ts:122`) | selects `sig."createdAt"` and `clock_timestamp()`, compares in JavaScript | naive (read as UTC) against the database clock | zone-safe only if the application wrote UTC exactly | **service:** drop the JavaScript comparison; use the receipt function |
| 4 | Frozen obligation guard `external_signal_entry_obligation_guard` (C1 migration `20261029120000`, accepted code) | `x.signal_created_at < state_row."activatedAt" OR x.signal_created_at < x."authorizedAt" OR x.account_cycle_created_at < …` | **naive against `timestamptz`** (implicit cast) for the signal | TimeZone | **migration (`CREATE OR REPLACE`):** `x.signal_received_at IS NULL OR x.signal_received_at < …` |
| 5 | Worker-claim guard `external_signal_broker_worker_claim_guard` (C2 migration `20261030180000`) | `x.signal_created_at AT TIME ZONE 'UTC' < ds."activatedAt"`, `clock_timestamp() − (x.signal_created_at AT TIME ZONE 'UTC') > interval '120 seconds'`, `x.intent_created_at AT TIME ZONE 'UTC' < ds."activatedAt"` | explicit UTC conversion of an application-written naive value | zone-safe, **skew-exposed** (the application clock wrote the value) | **migration:** `x.signal_received_at IS NULL OR …`; the intent comparison relies on the stamped `OrderIntent.createdAt` |
| 6 | Worker claim service check (`external-signal-broker-worker.service.ts:83`) | `Date.now() − obligation.entrySignal.createdAt` against `C2_MAX_SIGNAL_AGE_MS` | application clock on both sides | skew | **service:** remove; the claim guard (row 5) already enforces it on the database clock |
| 7 | The complete consumption guard (new) | `receipt + 120 s − clock_timestamp()`, `receipt < ds.activatedAt`, `receipt < auth.authorizedAt`, `ac.createdAt < …` | `timestamptz` against `timestamptz`, database | none | in the overlay (E2 × signal receipt 200 s old and `NULL`) |
| 8 | C3C permit and expiry guards | `clock_timestamp()` against `authorizationDeadlineAt` | `timestamptz`, database | none | as designed (3.6) |
| 9 | EXIT housekeeping (`external-signal-correlation.service.ts:111`, `signal.createdAt > cutoff`) and operations display (`external-signal-operations.service.ts:32,34`) | JavaScript, `createdAt` | application | not an execution-eligibility decision | **unchanged**; recorded as audited |

**NULL-safe by construction.** A `NULL` receipt makes `receipt < epoch` *unknown*, which a PL/pgSQL `IF` treats as false and so would not raise. Every replaced
guard therefore needs an explicit `IS NULL` branch, as the overlay's consumption guard does (`receipt IS NULL OR …`); a `WHERE` clause that uses `receivedAt >= epoch` excludes a `NULL` row on
its own. Historical signals (`receivedAt IS NULL`) stay ineligible for every new broker authorization (E2: receipt `NULL`; U6: a historical graph with a valid decision and fence) and
remain fully usable for existing C2 recovery (U5). A signal accepted just before the migration and still inside its 120 seconds is ineligible after it: the safe direction, and the only cost.

**Measured** (`c3b2-r5-epoch-section.ts`, PostgreSQL 16.13 and 17.11):

* **T1.** On a real `Signal` row and a real dispatch state, with the epoch placed 30 s after the receipt (the signal truly predates it), `sig.createdAt >= <epoch>` answers *eligible*
  in **15 of 27** zone/setter combinations (`America/New_York`, `America/Los_Angeles`, `America/Phoenix`, `Etc/GMT+12`, `PST8PDT` × `SET TIME ZONE`, `set_config`, `SET LOCAL`), and with the epoch placed
  30 s before the receipt (truly eligible) answers *ineligible* in **3 of 9** zones (`Asia/Kolkata`, `Pacific/Kiritimati`, `Asia/Tokyo`): the error runs in both directions, and the first
  direction extends eligibility. `external_signal_signal_received_since` is correct in all 27 combinations.
* **T2.** A signal with a `NULL` receipt is ineligible for every epoch (even 1970-01-01) and has no open window, while the legacy comparison admits it.
* **T3, T3b.** As above.
* **T4.** The catalog scan finds exactly two database functions that read `Signal.createdAt` for an eligibility decision (rows 4 and 5), and the source scan finds the service lines of rows 1, 2, 3, 3b, 6 and 9.

**Specified changes, not implemented here.** *Migration:* `Signal.receivedAt` and its guard (3.5.2); `external_signal_signal_received_since`; the two stamp triggers above; `CREATE OR REPLACE` of the
obligation guard (row 4) and the worker-claim guard (row 5) to read `receivedAt` with an explicit `IS NULL` branch; the complete consumption guard; manifest regeneration. *Services:* rows 1, 2, 3, 3b, 6. *Tests:* section 9 row 25.

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

`BEFORE INSERT` guard for `SEND_PERMITTED`, run under explicit locks in the section 6.5 order (account identity and
dispatch-state rows **before** the exposure advisory, intent, claim, fence and the consumption row; section 3.6.7):

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
4. the fence version equals the version the terminalizer read under lock;
5. **[R4]** the authoritative absence observation of section 3.6.6 (item 3) exists.

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

#### 3.6.6 The broker-send rule, the authoritative client-order-ID lookup and release evidence **[R4]**

**R-SEND (a requirement on C3C, stated once and binding everywhere).** *Only the process that created `SEND_PERMITTED` and
received acknowledgment of its own successful commit may initiate a POST. A permit discovered on retry, restart or recovery
never grants another send; reconcile instead.*

Enforcement design:

* The permit row carries a random `permitNonce` generated in the creating process's memory and never re-readable by any
  other code path (the table grants no `SELECT` of that column to the runtime role; the adapter holds the value it generated).
  The adapter refuses to run unless it presents a nonce equal to the stored one **and** the permit transaction's `COMMIT`
  returned success on the same connection in the same call.
* **Unknown commit outcome is not acknowledgment.** A connection reset, timeout or driver error after `COMMIT` was sent
  means the permit may or may not exist. That process must not POST; it reads the permit by `orderIntentId` (fresh statement)
  and, whatever it finds, hands the intent to reconciliation (a found permit is "possible delivery", section 3.6.4).
* A permit seen by any other process (the same worker after a restart, a recovery pass, a second worker) is evidence of
  possible delivery and nothing else.

**Authoritative client-order-ID lookup (to be built in C3C, not before; no broker is contacted in C3B.2).**

* *What it is:* a read-only GET of the order by `client_order_id` against the PAPER account's own credentials and the paper
  API host (Alpaca documents a client-order-ID order lookup; the exact endpoint, status codes and error body are to be
  confirmed against the current Alpaca reference when C3C is written). It never creates or changes anything, so it is not
  possible delivery.
* *Evidence record (new table `ExternalSignalBrokerLookupObservation`, immutable, one row per attempt):* `orderIntentId`,
  `consumptionId`, `clientOrderId`, `tradingAccountId`, credential fingerprint, `requestedAt` and `respondedAt` stamped by
  the database, `outcome` ∈ `FOUND` (with `brokerOrderId` and the raw body), `ABSENT_AUTHORITATIVE` (a definitive
  "not found" from the broker for this exact id), `INDETERMINATE` (timeout, 5xx, auth error, rate limit, malformed body), and
  `sinceDeadlineMs`. Only `ABSENT_AUTHORITATIVE` and `FOUND` ever change a decision; `INDETERMINATE` never releases anything.
* *Before every first POST:* permit committed and acknowledged (R-SEND) → lookup → if `FOUND`, link the broker order, advance
  to `BROKER_ORDER_ACTIVE`, **no POST**; if `ABSENT_AUTHORITATIVE`, re-read the deadline and POST at most once; if
  `INDETERMINATE`, **no POST**, the permit stands and reconciliation takes over.

**Evidence required to release expired-never-sent exposure** (all conditions, enforced by the terminalizer's guard of
section 3.6.3, which gains this requirement):

1. `clock_timestamp() ≥ authorizationDeadlineAt` and no `SEND_PERMITTED` row exists (the unique row is the linearization point).
2. No `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`, `BROKER_DELIVERY_UNCERTAIN` event, `BrokerOrder` or
   `BrokerActivity` under the shared identity key (section 3.4.6), claim `ENTRY_SUBMITTING` and unreleased, intent `submitting`,
   fence unchanged since the terminalizer read it under lock.
3. **At least one `ABSENT_AUTHORITATIVE` observation whose `requestedAt` is later than `authorizationDeadlineAt` plus the
   adapter's HTTP timeout plus a stall allowance**, for the same account, credential environment and exact
   `clientOrderId`. (With no permit no compliant adapter sent; the lookup is the backstop against a rogue sender,
   section 3.6.3's residual assumption.)
4. An `INDETERMINATE` or older observation does not satisfy item 3; the terminalizer retries the lookup on its schedule.

Exposure under a **committed permit** is never released by this path. It is released only by `FOUND` + normal order
lifecycle, or by an `ABSENT_AUTHORITATIVE` observation later than `permit.decidedAt + (deadline − decidedAt) + HTTP timeout +
stall allowance` together with operator confirmation during the canary (section 3.6.4).

#### 3.6.7 C3C send-decision lock order (D3) **[R4]**

The permit/withdrawal/expiry transaction `S` uses the same total order as F (section 6.3). In particular, **account identity
and dispatch-state locks come before the exposure advisory, the intent, the claim and the fence**:

1. `S` is not an owner operation, so it takes no `User` lock. It starts at the rollout advisory (row 1), rollout state (2) and
   **dispatch state (3)**.
2. Source, binding, revision, generation, cycle, account cycle (4 to 9), each a single-table statement.
3. **`TradingAccount` `FOR SHARE` (10)** followed by assignment, Subscription, Strategy, ExitProfile, Security and allocation
   (11 to 16), all `FOR SHARE`, and the TradingView authorization (17).
4. Only then the exposure advisory (21), intent (22), claim (23), fence (24) and, last, the consumption / send-decision row (30).

The emergency-stop checks (`status`, `tradingEnabled`, `killSwitchEnabled`, `tradingBlocked`, dispatch state active) read
the rows locked in step 1 and 3 **after all locks are held**; nothing re-locks the account later, so a "later emergency
check" cannot invert the order. A failed check inserts the `WITHDRAWN_NEVER_SENT` row under the same lock set. The
post-commit `clock_timestamp()` re-read and the lookup (section 3.6.6) happen **outside** any transaction. Probes C6a to C6c
show the corrected account lock behavior: a kill-switch or pause `UPDATE` waits for a `FOR SHARE` hold, a pause committed after
a SERIALIZABLE snapshot is `40001`, and a transaction started after the pause reads `PAUSED`.

#### 3.6.8 Sequencing dependency: finalization is not scheduled before the terminalizer exists **[R4]**

A pair that is consumed but never reaches a broker adapter holds its exposure until something proves it was never sent. Until
C3C's expired-never-sent terminalizer (section 3.6.3) exists, **that is a permanent manual reconciliation**. Therefore:

* **C3B.2** delivers the atomic authorization capability **test-only and default-off**: `finalizeTradingViewDispatch` has no
  production caller, no scheduler entry and no importer outside tests (a static test asserts this).
* **C3B.3** delivers scheduler/activation foundation **with finalization disabled**; the scheduler must not call
  `finalizeTradingViewDispatch`.
* **C3C** delivers the send decision (permit, withdrawal), the expired-never-sent terminalizer, the broker adapter with the
  authoritative lookup, and reconciliation.
* **Scheduling finalization is activated only after the complete C3C lifecycle is validated** (section 8).

### 3.7 Alternatives considered for the freshness guarantee, and the selection **[R3]**

| Option | Verdict |
|---|---|
| **A. Deferred constraint trigger at COMMIT (revision 2)** | **Rejected.** `SET CONSTRAINTS ALL IMMEDIATE` before or after the insert runs the check at insert time (probe P3: check ran 2 ms after insert, commit reached 1.5 s later). Any later lock wait or stalled client then delays the commit past the check. A session can always do this; a trigger cannot forbid it. |
| **B. Commit-timestamp tracking (`track_commit_timestamp`)** | **Not selected; not relied on.** It is `off` by default (probe: `SHOW track_commit_timestamp` is `off` on 16.13 and 17.11), changing it needs a restart and is a cluster setting that managed services may not expose, and with it off `pg_xact_commit_timestamp()` errors (probe: "could not get commit timestamp data"). Even when on, the commit timestamp exists only *after* commit, so it can classify a consumption as late post hoc but cannot prevent a late consumption from being durable and valid. It is evidence, not a gate. Any future use requires proof of availability, retention and failover behavior; none is claimed. |
| **C. Immutable deadline + unique send decision (§3.2, §3.6)** | **Selected.** Freshness is moved from "when the transaction commits" (unobservable and unbounded) to "whether a compliant sender may start", which the database linearizes with a unique, nondeferrable row. It needs only `clock_timestamp()`, plain constraints and explicit locks. |
| D. Short renewable lease | Rejected: renewing still needs the same unique linearization and adds a refresh race. |
| E. Make the F commit itself the send marker | Rejected: commit time is uncertain, a crash between commit and send becomes unknowable, and an expired-never-sent proof would be impossible because the marker would already exist. |

**Documented assumptions and limitations of the selection.**

1. All freshness comparisons use the primary's `clock_timestamp()` and the database-owned `Signal."receivedAt"` (section
   3.5), both `timestamptz`. A
   failover to a node with an earlier clock can briefly make an expired deadline look open; the permit's
   uniqueness (the safety property) does not depend on the clock. A clock step is an incident, not a design input.
2. The deadline bounds initiation by a compliant adapter, not broker receipt (§3.6.4).
3. Definite-never-sent is provable only for a compliant adapter that obeys "no marker, no POST" (§3.6.3).
4. The 30 s dispatch window and 2 s/5 s margins are proposals for review, not measured values.

### 3.8 Retry classification and ambiguous outcomes (fail-closed provenance) **[R5]**

**Question.** Hermes observed a Prisma `P2010` whose nested `40001` appeared only in message text. May a retry decision ever rest on text? **No.** The shipped classifier
(`retryableConcurrencyFailure`, `external-signal-broker-worker.service.ts:44`) already refuses it, and the probe below shows why that is the only safe rule: the real adapter
produces *several* error shapes for the same SQLSTATE, and a server-side application error can carry `40001` in its message while having SQLSTATE `P0001`.

**Measured with the production adapter** (`c3b2-r5-retry-classification-probe.ts`; `src/db/prisma.ts` with `PrismaPg`; PostgreSQL 16.13 and 17.11; identical on both; `c3b2-r5-retry-results-pg16.json` / `pg17.json`;
19 cases, 10 retryable, 9 not, **0 misclassified**):

| Path | Error class | Where the SQLSTATE is | `retryableConcurrencyFailure` |
|---|---|---|---|
| `$queryRaw`/`$executeRaw`, server raises `40001` (also trigger-raised, also inside an interactive `Serializable` transaction) | `PrismaClientKnownRequestError` `P2010` | `meta.driverAdapterError.cause.originalCode = '40001'`, `cause.kind = 'TransactionWriteConflict'` | **true** |
| Same, `40P01` (raised, or a **real deadlock** between two interactive transactions) | `P2010` | `cause.originalCode = '40P01'`, `cause.kind = 'postgres'`, plus `severity`, `detail` | **true** |
| Model write (`tx.systemEvent.create`), trigger raises `40001` | `PrismaClientKnownRequestError` **`P2034`** | `meta.driverAdapterError.cause.originalCode = '40001'` | **true** (`P2034` is accepted by class) |
| Model write, trigger raises `40P01` | **top-level `DriverAdapterError`**, no Prisma wrapper | `cause.originalCode = '40P01'` | **true** |
| **Real write-skew serialization failure** between two interactive `Serializable` transactions | top-level `DriverAdapterError`, `message = 'TransactionWriteConflict'` | `cause.originalCode = '40001'`, `cause.kind = 'TransactionWriteConflict'` | **true** |
| Server raises `P0001` whose **message** says `could not serialize access … (SQLSTATE 40001) deadlock detected 40P01` (raw) | `P2010` | `cause.originalCode = 'P0001'`; the message text contains `40001` | **false** |
| The same through a model write | top-level `DriverAdapterError` | `cause.originalCode = 'P0001'` | **false** |
| `23505` unique violation | `P2010`, `cause.kind = 'UniqueConstraintViolation'` | `cause.originalCode = '23505'` | false |
| `55P03` (`lock_timeout`) | `P2010` | `cause.originalCode = '55P03'`, `kind = 'postgres'` | false (see below) |
| `pg_terminate_backend` mid-transaction (`57P01`) | **plain `Error`**: `Client has encountered a connection error and is not queryable` | **none** | false |
| Look-alikes: a plain `Error` naming `40001`; a `P2010` constructed with `40001` only in its message; a `P2010` whose `driverAdapterError.cause` has no `originalCode`; an object with `code: '40001'` that is not a `pg` `DatabaseError` | various | none or forged | **false** (all four) |

**Rules (the classifier already satisfies them; the change is to the tests and to what happens after a refusal to retry).**

1. **Structured provenance only.** A failure is a retryable concurrency conflict only if it is an instance of a *known class* (`PrismaClientKnownRequestError` `P2034`, or `P2010` with a structured code,
   top-level `DriverAdapterError`, `pg` `DatabaseError`) **and** a structured SQLSTATE in `{40001, 40P01}` is found in `meta.driverAdapterError.cause.originalCode`, `meta.code` or `cause.originalCode` (exactly five
   characters, exact match). Message text, `name`, `code` on a foreign object and `error.message` regular expressions never count. The two historical regular expressions in other services
   (`external-signal-execution-authority.service.ts:10`, `/serializ|deadlock|40001|40P01/i` on the message) are **not** the standard for F and must not be reused.
2. **Unavailable provenance fails closed.** If no structured SQLSTATE is present the error is **ambiguous**, not "non-retryable": the code cannot tell a conflict from a lost connection.
3. **Three outcome classes**, decided from the error alone, then confirmed from durable state:

| Class | Members | Action |
|---|---|---|
| `RETRYABLE_CONFLICT` | structured `40001`, `40P01` | new transaction, bounded attempts (3) |
| `NO_EFFECT_REFUSAL` | structured guard refusals (`P0001` with a `TRADINGVIEW_*` code, `23xxx`, `55P03`, `57014`) raised before `COMMIT` was issued | not retried blindly; **re-read** (below), then refuse not-sent or retry once under the signal bound |
| `AMBIGUOUS` | no structured SQLSTATE; connection errors (`08xxx`, `57P01`, `Client has encountered a connection error`); any failure while or after `COMMIT` was sent; unknown classes | **never retried and never released**; **re-read** (below) |

4. **Re-read durable consumption after every non-success, before any retry, refusal or release.** The re-read is a *locked* read: take the exposure advisory lock, then `OrderIntent` and `EntryExposureClaim`
   `FOR UPDATE` (the same rows F holds until its commit is durable), then read the consumption pair by `orderIntentId` in a fresh `READ COMMITTED` statement. Because F's transaction holds those locks until it commits, the
   re-read cannot interleave with an F commit that is still in flight; it waits, or sees the pair. A pair present means the attempt is over: no retry, no release, hand the intent to recovery (matrix rows 7, 8, 14).
   Absent means F did not commit; only then may the orchestrator retry or write the definite not-sent refusal.
5. `55P03` is deliberately not in the retry set (the classifier returns false): a lock timeout means a lock holder is stuck, and the bounded retry would queue behind it again. Section 3.3's "a timeout is a retryable refusal" is
   corrected to *a timeout is a `NO_EFFECT_REFUSAL`: re-read, then at most one retry inside the signal bound*.

**Where the unverifiable shape comes from.** A guard written as `EXCEPTION WHEN others THEN RAISE EXCEPTION 'failed: %', SQLERRM` (or an application re-raise) converts a nested `40001` into `P0001` whose text mentions it. The
adapter faithfully reports `P0001`; treating the text as a conflict would retry a *guard refusal*. This is also why no new guard may wrap a lock or a fenced read in `EXCEPTION WHEN others`: such a block would **swallow** the real
`40001` and let the transaction continue past the conflict (probe I4: none of the new or replaced functions contains one; the same query finds the accepted `external_signal_c2_not_sent_evidence_guard`, whose block wraps only an integer cast, which is its positive control).

**Test plan additions** (section 9, row 30): one unit test per row of the table above, constructed from the *captured* shapes (the results file contains the full objects), the four look-alikes, and an integration test
that forces each shape through the real `Serializable` F path and asserts the class decision **and** that the locked re-read ran before the retry or refusal.

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
| 8 | Process crashes immediately after F **[R3]** | Same as row 7, no send decision and no `ADAPTER_INVOCATION_STARTED` event. | A committed pair is **single-use even with no marker**, and **not proof of broker receipt**. **Until C3C exists no production path can create a pair** (C3B.2 is test-only, C3B.3 does not schedule finalization, section 3.6.8); in a test, stale recovery treats it as `DISPATCH_OUTCOME_UNKNOWN`, retains exposure and never resends. **With C3C**, once `authorizationDeadlineAt` has passed and no send decision exists, the pair is eligible for the expired-never-sent protocol of §3.6.3 (case 11); before the deadline it is left alone so a live worker can take the permit. |
| 9 | Alpaca already has this client order ID | C3C performs the client-order-ID lookup **before** the first POST and again on any ambiguity. | Link `BrokerOrder`, advance claim to `BROKER_ORDER_ACTIVE`, never POST. No new consumption is created or required. |
| 10 | F aborts with a retryable DB error (`40001`/`40P01`) | Nothing durable from F. | Up to three attempts, fresh transaction each (fresh snapshot); then refuse as technical not-sent via the independent `READ COMMITTED` path of R-5. Non-retryable classification fails closed. |
| 11 | **[R3]** Consumed pair, deadline passes before any marker | Consumption exists; no send decision. | C3C-only expired-never-sent terminalization (§3.6.3): unique decision row, evidence class `NOT_SENT_CONSUMED_EXPIRED`, terminal intent, released claim, atomically. Not C2's release. |
| 12 | **[R3]** Permit and expiry race | Two transactions, one unique row. | Whichever inserts first wins; the other blocks, then fails `23505` (probe P2). Permit-first: no terminalization, reconcile. Expiry-first: no send. |
| 13 | **[R3]** Marker committed; crash, stall or declined send | `SEND_PERMITTED` exists. HTTP may or may not have started. | Possible delivery. Exposure retained, no resend, attention episode, reconciliation only (§3.6.4). |
| 14 | **[R4]** Pair committed by a test-only C3B.2 build; no terminalizer exists yet | Pair, fence `v+1`, no send decision. | Not reachable in production (section 3.6.8). Treated as manual-reconciliation exposure until C3C. |
| 15 | **[R4]** Lost acknowledgment of the *permit* commit | The permit may or may not exist. | No POST by that process (R-SEND); read the permit by `orderIntentId` and reconcile (section 3.6.6). |

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
| Only an MI consumption (marked) | impossible: deferred pair check fails the commit (fail-closed even under `SET CONSTRAINTS ALL IMMEDIATE`, §3.7 and probe P3) | n/a | n/a |
| Only a TV consumption | impossible: FK to the MI row | n/a | n/a |

The marked-claim guards forbid releasing a consumed claim through the pre-dispatch path
(`external_signal_exposure_claim_c2_guard`) and deleting any marked claim
(`external_signal_exposure_claim_delete_guard`, C3B.1). Retained exposure is **never** released through
definite-non-send recovery once a consumption exists, except by the single, separately keyed allowance of §3.6.3.

## 5.3 Database invariants C3B.2 adds (new forward-only migration, proposed) **[R3, R5]**

All new or replaced routines restate the trusted `search_path = pg_catalog, public, pg_temp` (C3A function-level
requirement, enforced by the static migration test and the C3B.1 preflight manifest; the manifest must be
regenerated in the same change, from a freshly migrated disposable database, never from the database assessed).

* **`external_signal_broker_consumption_guard`** (replaced, `BEFORE INSERT`, **complete [R5]**): takes the §6 locks **itself** by calling `external_signal_lock_dispatch_graph` (rows 1 to 23, one single-table statement per relation),
  then the fence and the remaining shared rows (24 to 27), so correctness never depends on the caller having pre-locked (R-6) nor on `FOR UPDATE OF a,b,c` ordering (§6.1). Only then does it perform the checks below, **every one of them on locked rows**, and **stamps**
  `authorizedAt` and `authorizationDeadlineAt`. The full structure and its measurements are §3.4.9.
* **`external_signal_dispatch_fence_bump`**, `ExternalSignalDispatchFence`, the consumption `AFTER` self-verification and the
  shared `external_signal_broker_evidence_marked_intents` key (§3.4).
* **`Signal.receivedAt`**, its guard and `external_signal_signal_receipt_remaining` / `…_open` (§3.5).
* **Replaced lock modes [R4]**: `external_signal_broker_worker_claim_guard` takes `ta,tas,sub,sec` `FOR SHARE`; the
  `ExternalSignalEntryExecutionAuthorization` guard takes `FOR SHARE OF tas,ta,s,u` (§6.7). Both keep their other logic.
* **[R5] Added by revision 5:** the fence creation trigger, the migration **backfill** and the fence **insert guard** (§3.4.8); `external_signal_lock_dispatch_graph` and the inert-for-unmarked `BrokerDispatchConsumption_a_lock_prelude` trigger on the MI consumption (§3.4.9, §6.9.2);
  the **account-scoped** key `external_signal_broker_evidence_marked_intents(…, brokerOrderRecordId)`, its reverse `external_signal_marked_intent_broker_evidence`, and the quarantine rebuilt on them with the contradictory and unattributable refusals (§3.4.6);
  `external_signal_signal_received_since` and the candidate-side `createdAt` stamps (§3.5.5), with `CREATE OR REPLACE` of the obligation guard and the worker-claim guard to read `receivedAt` (explicit `IS NULL` branch);
  manifest regeneration, `CRITICAL_TRIGGERS` additions and the trigger-order invariant (§6.9.3).
* **No deferred commit-stage freshness guard.** Revision 2's `external_signal_final_dispatch_commit_guard` is
  **removed from the design**: it cannot provide the property it claimed (§3.7).

Checks in the consumption guard:

1. **Signal still fresh at authorization [R4]**: `external_signal_signal_receipt_open(signalId, minimum send window)` (database `receivedAt`, section 3.5; a `NULL` receipt fails closed);
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
   `BrokerOrder`, `BrokerActivity` **under the shared, account-scoped identity key of §3.4.6 [R4, R5]** (not `orderIntentId` alone; evaluated after all locks, §3.4.9) or
   `NOT_SENT/ADAPTER_INVOCATION_STARTED/DISPATCH_OUTCOME/BROKER_DELIVERY_UNCERTAIN` event.
8. **Latest allowed MI decision inside its short window**: `ALLOWED`/`DISPATCH_AUTHORIZED`, highest
   `dispatchSequence` for the intent, `clock_timestamp() < dispatchExpiresAt`.
9. **Identical identities on both records**: `clientOrderId` and `brokerPostOpportunityId` equal on the MI and TV
   consumption rows, and equal to the claim's.
10. **Frozen MI obligation** (§1.1): present, belongs to this intent, identity-equal to the decision and the
    account cycle.
11. **Fence equality [R4]** (§3.4.2): `BEFORE INSERT` requires `NEW.fenceVersion` equal to the locked fence row's `version`; `AFTER INSERT` (after the single bump) requires it to equal `NEW.fenceVersion + 1`.
12. Nothing session-configurable (`current_setting`, GUC) can relax any of these.

Until this migration exists, the service-level checks of §3.3 are the only enforcement for the time, pause, EXIT
and obligation items, which is why C3B.2 is "service + migration", not service alone.

## 6. Lock-acquisition contract **[R4: rewritten]**

### 6.1 Why the order must be explicit

`SELECT … FROM a JOIN b … FOR UPDATE OF a, b, c` does **not** lock in `FROM` or `OF` order: PostgreSQL locks rows as the
plan produces them. Measured on the real worker-claim guard (probe C1): blocked on the assignment row, the guard already
holds `TradingAccount`; blocked on `TradingAccount`, it holds no assignment lock, so its planner order is **TradingAccount
then assignment**. The same shape is used by the admission lock statement (`market-policy-entry-admission.service.ts:108`,
`FOR UPDATE OF ac,c,sr,rr,sig,auth,state,gen,work,ta,tas,sub,sec`) and by the TradingView authorization guard (`FOR UPDATE OF
tas,ta,s,src,b,r,u`). Rule: every TradingView path takes each relation with **one single-table statement, in the order of
6.5**, in the strongest mode any later trigger will request (never an upgrade), so a guard's multi-table statement finds the
rows already held and cannot wait.

### 6.2 Complete per-operation lock matrix

"U" = `FOR UPDATE`, "S" = `FOR SHARE`, "KS" = `FOR KEY SHARE`, "NKU" = a row `UPDATE` that does not change a key. Statements
are in the order PostgreSQL executes them. **Implicit** locks come from triggers and foreign keys; they were extracted from
the migrated catalog (probe C0, 29 triggers) and, where marked *measured*, observed with `pgrowlocks`. "Today"
means the code at `733a426`.

| # | Operation (code) | Isolation | Ordered lock sequence, explicit then implicit |
|---|---|---|---|
| M1 | **MI grant** `grantAssignmentMarketPolicyEnforcementAuthorization` (service `:507`) | SER | `User` S (`assertEnabledOwner :486`) → assignment **U** (`:511`) → enrollment generation U (`:512`) → *insert; BEFORE `AssignmentEnforcementAuthorization_validate`:* assignment U (held) → generation S → **`TradingAccount` S** → `Subscription` S → `Security` S → `StrategyMarketPolicyRevision` S → `User` S → *AFTER:* event and `SystemEvent` inserts (FK KS) |
| M2 | **MI revoke** (`:558`) | SER | `User` S → assignment U → MI authorization U → *UPDATE; BEFORE:* `User` S (revoker) → *AFTER:* event |
| M3 | **MI lapse resolution** (`:589`) | SER | `User` S → assignment U → MI authorization U → *insert; BEFORE:* authorization U (held), `User` S |
| M4 | MI admission resolver `resolveLockedAssignmentMarketPolicyEnforcement` (`:316`), inside the admission transaction | RC | MI runtime rollout S (caller) → `TradingAccount` KS → assignment KS → `Subscription` KS → `Security` KS → latest MI authorization S |
| M5 | MI decision insert (`BrokerDispatchDecision_validate`) | RC | MI runtime rollout S → obligation (read) → MI authorization S → *(proposed AFTER fence bump)* |
| M6 | MI consumption insert (`BrokerDispatchConsumption_validate`) | any | MI authorization S; unlocked reads of assignment, generation, revision, intent, claim; FK KS on decision and intent (*measured* in the pair) |
| M7 | **TradingView admission** lock statement (`market-policy-entry-admission.service.ts:108`) | RC | one planner-ordered statement U on `ac,c,sr,rr,sig,auth,state,gen,work,ta,tas,sub,sec` → M4 → exposure advisory (`entry-exposure:<account>:<security>`) → intent and claim inserts → account-cycle `UPDATE` (*BEFORE `parent_lock`:* cycle U, implicit) |
| M8 | **TradingView worker claim** (`external-signal-broker-worker.service.ts:92-111` + `external_signal_broker_worker_claim_guard`) | SER | rollout advisory → *insert; BEFORE:* advisory (re-entrant) → rollout state U → dispatch state U → one statement U on `i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec` (planner order, TA before assignment: *measured*) → *back in the service:* **exposure advisory (`:103`, after the guard)** → intent/claim updates → event insert (*BEFORE `external_signal_c2_delivery_event_fence`:* claim U via a same-value `UPDATE`) |
| M9 | **TradingView authorization grant** (`external-signal-execution-authority.service.ts:101-129`) | SER | owner read → rollout advisory → rollout state **write** (`SET version=version`) → source U → binding U → TV generation U → **`TradingAccount` U** → assignment U → `Subscription` U → `Security` U → *insert; BEFORE `ExternalSignalEntryExecutionAuthorization_guard`:* advisory, rollout state write, one statement U on `tas,ta,s,src,b,r,`**`u`** (adds the strategy revision and **`User` U**) |
| M10 | TradingView authorization revoke (`:138-151`) | SER | rollout advisory → source U → binding U → authorization U (guard: transition checks only) |
| M11 | Identity-change `UPDATE` of `TradingAccount`, assignment, `Subscription` or `Security` | any | the row (NKU) → *AFTER:* TradingView authorizations U (`ExternalSignalEntryAuthority_*_invalidate`) → MI authorizations U (`*_invalidate_enforcement_authorization_*`; alphabetical trigger order). `Strategy`, `ExitProfile` and `TradingAccountAllocation` have **no triggers**. |
| M12 | EXIT correlation (`external-signal-correlation.service.ts:33,38,109`) | RC | source U → binding U → source cycle U → each account cycle U. Signal ingest of an EXIT also runs `Signal_external_exit_touch_source_cycle`: cycle `UPDATE`. |
| M13 | Any `INSERT`/`UPDATE` of `ExternalSignalTradeCycleAccount` | any | the account-cycle row → *BEFORE `ExternalSignalTradeCycleAccount_parent_lock`:* **parent cycle U (implicit)** → *deferred AFTER `terminal_parent_check`:* cycle U |
| M14 | Entry recovery (`external-signal-entry-recovery.service.ts:54-55`) | RC | cycle U → account cycle U |
| M15 | Stale recovery, refusal | RC / SER | recovery: exposure advisory → `FOR UPDATE OF i` (`entry-dispatch-recovery.service.ts:444,1017,1030,1148`); `refuseAndRelease`: intent U (`worker.service:186`); unclaimed refusal: rollout advisory → `FOR UPDATE OF i,ec` (`:153-160`) |
| M16 | **F** (this design) and M17 **C3C `S`** | SER / RC | rows 0 to 30 of section 6.5, one statement each |

*Measured implicit lock sets (probe C1, C3.1, C4):*

* Current claim guard (fence overlay present): `TradingAccount`, assignment, `Subscription`, `Security`, source, binding, revision,
  rollout generation, rollout state, dispatch state, source cycle, account cycle, TV authorization, intent, claim all **U**;
  obligation KS; worker claim written; fence KS + written.
* Corrected guard after the section 6.5 pre-locks: the same set, but `TradingAccount`, assignment, `Subscription`, `Security`
  are **S** (no upgrade to U).
* The pair (beyond intent, claim, fence): rollout generation KS, **dispatch state U**, TV authorization **U**, obligation KS,
  worker claim KS, decision KS, **MI authorization S**, MI consumption KS + written, TV consumption written.

### 6.3 Hazards found (all reproduced)

| ID | Hazard | Status | Probe |
|---|---|---|---|
| H1 | TradingView takes `TradingAccount` U then the assignment; MI grant takes the assignment U then `TradingAccount` S. Opposite orders on two relations: `40P01`. Affects rev-3 F (**reproduced** with explicit pre-locks and the real MI grant), the current **claim guard** (**reproduced** alone: TV is the victim, MI is granted), the admission statement (same shape, not separately run) and the **TradingView authorization grant** (**reproduced with both real services**, different owners; TV is the victim with `CONCURRENT_AUTHORITY_CHANGE`). | The last two are **accepted C1/C2 code** | C2.1, C2 (current guard), C8a |
| H2 | `ExternalSignalEntryExecutionAuthorization_guard` locks **`User` U after the assignment**; every MI owner operation locks `User` S **first**. Same owner: MI holds `User` and waits for the assignment, TV holds the assignment and waits for `User`. The rev-3 matrix did not contain `User` at all. | **Accepted C1 code** | C8b |
| H3 | `ExternalSignalTradeCycleAccount_parent_lock` locks the parent **cycle after the account-cycle row**; EXIT correlation and entry recovery lock cycle then account cycle. A writer that updates an account cycle without first locking its cycle inverts them. | Existing trigger; **`refuseCandidate` is the violating writer, reproduced [R5]** (6.9.1) | C9, O1 |
| H4 | Planner-ordered multi-table `FOR UPDATE OF` in the claim guard, admission and the authorization guard. | Existing | C1 |
| H5 | The claim transaction takes the exposure advisory **after** the claim guard; recovery takes it before the intent. | Existing (rev-3 6.4, unchanged) | section 6.6 |
| H6 | **[R5]** The MI consumption insert takes the MI authorization lock (row 19) before the TradingView guard reaches the identity rows (10 to 16); a non-pre-locking caller deadlocks with the real MI revoke. | Reproduced; fixed by the lock-prelude function and trigger (6.9.2) | O2c, O2 |

### 6.4 Options evaluated

| Option | Result |
|---|---|
| **A. TradingView takes `TradingAccount`, assignment, `Subscription`, `Security` (and allocation) `FOR SHARE`, takes `User` `FOR SHARE` first, never upgrades.** | **Selected.** A TradingView path never needs exclusion from other readers of these rows, only exclusion from their writers: a pause, kill switch, `enabled=false` or status change is an `UPDATE` (NKU), which conflicts with `FOR SHARE` (probes C6a to C6c). The MI grant's S requests are then compatible with everything TradingView holds on those rows, so no cycle can close on them (probes C3.MI, C3.TV, C5). |
| B. Change the MI services and trigger to lock `TradingAccount` before the assignment | Rejected: edits three MI service transactions **and** the MI authorization trigger, which also serve unmarked PAPER enforcement; large blast radius; the MI trigger order cannot be changed without a migration that touches non-TradingView behavior. |
| C. Take the TV rollout advisory in MI operations | Rejected: changes unmarked behavior and adds global serialization to owner operations. |
| D. Retry on `40P01` only | Rejected as a *fix*: deadlock detection already aborts one side after `deadlock_timeout`; retry stays as defense in depth (the victim is TradingView in every reproduction). |

`FOR KEY SHARE` is **not** sufficient for the identity rows (a non-key `UPDATE` does not conflict with it; section 3.1
item 4); `FOR SHARE` is the smallest mode that preserves pause/kill-switch serialization.

### 6.5 The order, with modes **[R4]**

Top to bottom; nothing may be acquired after a later row. "Mode" is the strongest mode any later trigger in that transaction
requests, so **the pre-lock mode equals the guard's mode** (hidden upgrades are forbidden: C3.1). F = final transaction;
Claim = worker claim transaction; S = C3C permit transaction.

| # | Relation / lock | Mode | Acquired by | Notes |
|---|---|---|---|---|
| 0 | `User` (actor/owner) | S | MI operations (first); **TV authorization grant (moved here)** | F, Claim and S are not owner operations and take no `User` lock. The authorization guard's `u` becomes `FOR SHARE`. |
| 1 | Advisory `external-signal-execution-rollout` | excl. | F, Claim, S, guards (re-entrant), admission, grant, revoke, activate, unclaimed refusal | |
| 2 | `ExternalSignalExecutionRolloutState` id=1 | U | F, Claim, S, TV grant | |
| 3 | `ExternalSignalBrokerDispatchState` id=1 | U | F, Claim, S, consumption guard | |
| 4 | `ExternalSignalSource` | S / U | F, Claim, S, grant, revoke, EXIT | |
| 5 | `StrategySignalBinding` | S / U | same | |
| 6 | `StrategySignalRevision` | S / U | Claim, F | |
| 7 | TV rollout generation | S / U | grant, Claim, F | |
| 8 | `ExternalSignalTradeCycle` | S / U | F, Claim, S, EXIT, entry recovery, **every account-cycle writer (H3)** | Always before row 9. |
| 9 | `ExternalSignalTradeCycleAccount` | S / U | same | |
| 10 | **`TradingAccount`** | **S** | F, Claim, S, admission, TV grant | Was U in rev 3, in the claim guard and in the TV grant. |
| 11 | `TradingAccountSubscription` | **S** | same | MI takes it U, first of its identity rows. |
| 12 | `Subscription` | **S** | same | |
| 13 | `Strategy` | S | F, S | enabled flag validated |
| 14 | `ExitProfile` | S | F, S | |
| 15 | `Security` | **S** | same | |
| 16 | **`TradingAccountAllocation`** | S | F, S | A leaf: no trigger, and `trading-account-allocation.service.ts` takes no other lock. Probe C7: a disable waits for the share hold and is `40001` for a stale snapshot. The assignment's allocation foreign key takes KS on it, compatible with S. |
| 17 | TV authorization | U | F, S, consumption guard, claim guard, revoke, identity triggers | After every identity row, so the identity triggers (M11) agree with it. |
| 18 | MI runtime rollout id=1 | S | F | |
| 19 | Latest MI authorization | S | F, MI consumption trigger | MI revoke takes it U **after** the assignment, consistent with 11 < 19. |
| 20 | MI policy revision, enrollment generation | S | F | |
| 21 | Advisory `entry-exposure:<account>:<security>` | excl. | F, Claim (after the 6.6 fix), S, admission, recovery, release | After identity, before the intent. |
| 22 | `OrderIntent` | U | F, Claim, S | |
| 23 | `EntryExposureClaim` | U | F, Claim, S, event fence | |
| 24 | `ExternalSignalDispatchFence` | U | F, consumption guard, **every fenced writer's AFTER trigger**, S | Last of the guarded rows. |
| 25 | `ExternalSignalBrokerWorkerClaim` | S | F | |
| 26 | `ExternalSignalEntryExecutionObligation` | S | F | |
| 27 | `OrderIntentMarketPolicyEnforcementObligation` | S | F | |
| 28 | Latest MI decision | S | F | |
| 29 | Entry `Signal` | S | F | |
| 30 | Consumption / send-decision rows | U | S | New rows in F. |

**[R5] Rows 1 to 23 are one database function.** `external_signal_lock_dispatch_graph(intent, decision)` takes them, in this order and these modes, and is called by the TradingView consumption guard and by a `BEFORE INSERT` trigger on the Market Intelligence consumption (marked intents only). A caller that pre-locks in the same order and modes (F step 1) blocks on nothing; a caller that does not is still safe (6.9.2, probes O2 and O2c). Rows 24 to 27 are taken by the guard after it.

**Why this is deadlock-free against Market Intelligence (argument, with the probes that cover it).** A cycle between an MI
operation and a TradingView operation needs TradingView to hold something MI requests while requesting something MI holds.
MI's requests are `User` S, `TradingAccount` S, `Subscription` S, `Security` S, the enrollment generation, and (revoke/lapse)
its own authorization U. TradingView now holds `User` at most S, and `TradingAccount`/`Subscription`/`Security` at most S, so
none of those requests can wait on TradingView. MI's U requests are on the **assignment** and its **own authorization**,
both of which MI takes in an order (assignment, then authorization) that TradingView respects (11 < 19). The remaining
exposure is writers of the identity rows (M11), which hold the row (NKU) and then update authorization rows: they conflict
with TradingView's S at the row, before they hold anything TradingView wants. Probes: C3.MI and C3.TV (MI grant, both queue
orders), C5 (MI revoke), C6a to C6c (pause/kill switch), C7 (allocation), C8 (TV grant). This is an argument with these
interleavings measured, not a proof of every pair.

### 6.6 Worker-claim / recovery lock inversion: hazard, fix and prerequisite **[R2, order updated R3/R4]**

The independent audit reproduced a `40P01` between the existing worker claim and stale recovery: the claim transaction takes
the claim guard's intent/identity locks first and the `entry-exposure` advisory lock afterwards (`:103`), while recovery takes
the advisory lock first, then `FOR UPDATE OF i`. Opposite orders on the same intent.

**Corrected claim transaction (the 6.5 order, one contract for Claim, F and S):**

1. rollout advisory (row 1);
2. explicit single-table pre-locks of rows 2 to 20 (identity rows `FOR SHARE`, authorization U);
3. exposure advisory (row 21);
4. the claim insert, whose guard finds rows 2 to 20, the intent and the claim already held;
5. the intent/claim updates and the claim event as today.

Only moving the advisory lock ahead of the insert would put it before the guard's identity locks while admission holds
identity locks and then waits for the advisory lock, hence step 2. This checkpoint does **not** change the worker path (C3B.1
forbids it); the correction and its probes are a hard prerequisite of C3B.2 acceptance.

### 6.7 Required code and migration changes for the lock correction (smallest set)

1. **Claim guard** `external_signal_broker_worker_claim_guard`: `FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec` →
   `FOR UPDATE OF i,ac,c,auth,gen,src,b,rev,ec FOR SHARE OF ta,tas,sub,sec` (probe C3.0: the corrected guard is the real
   guard text with only this change).
2. **TV authorization guard** `ExternalSignalEntryExecutionAuthorization_guard`: `FOR UPDATE OF tas,ta,s,src,b,r,u` →
   `FOR UPDATE OF src,b,r FOR SHARE OF tas,ta,s,u`; **TV grant service**: `User` S first, then `TradingAccount`,
   assignment, `Subscription`, `Security` `FOR SHARE` (source, binding and generation unchanged).
3. **Admission** (`market-policy-entry-admission.service.ts:108`): single-table statements in the 6.5 order; identity rows S.
4. **Writers of `TradingAccountSubscription`/account cycle** (H3): lock the cycle (row 8) before the account cycle (row 9). **[R5] Audited (6.9.1):** `refuseCandidate` must change;
   the other writers are correct; the admission lock statement becomes single-table statements (item 3).
5. **Audit**: any transaction that updates `TradingAccount` and later locks `TradingAccountSubscription` (none is known; the
   allocation, risk and workflow services were not audited in this revision).

### 6.8 Other hazards

* **A. TV rollout advisory (row 1) before the MI rollout row (row 18).** No existing path takes the MI rollout row and then the
  TV advisory (MI transitions take `User` S then the MI rollout). Keep it so and test it.
* **D. Unlocked reads in the MI consumption trigger.** It reads intent and claim unlocked. F's rows 22 and 23 close that for
  TradingView; the MI trigger is unchanged so unmarked behavior is unchanged.
* **E. Authorization revoke vs F.** Same relative order (4 → 5 → 17). No inversion.
* **F. EXIT ingestion.** Correlation does not take the rollout advisory lock; it takes source → binding → cycle → account
  cycle (rows 4, 5, 8, 9). F uses that order, so EXIT and F interleave only at rows 8 to 9. EXIT ingestion also rewrites the
  cycle row (a version change F's SERIALIZABLE lock turns into `40001`).
* **G. Global serialization.** Rows 1 to 3 make TV dispatch single-file, intentional for the canary and why `lock_timeout` is
  mandatory on F.
* **H. Fence writers.** Order sync and other writers of `BrokerOrder`/`BrokerActivity` must lock the intent and claim
  (rows 22 and 23) before the fenced write so the AFTER bump (row 24) comes last; audit and probe every fenced writer. An
  inversion is an aborted transaction, never a bypass.

### 6.9 Account-cycle writers, the refusal inversion, and trigger execution order **[R5]**

#### 6.9.1 `refuseCandidate` and every other account-cycle writer (MEDIUM finding)

`ExternalSignalTradeCycleAccount_parent_lock` (`BEFORE INSERT OR UPDATE`) locks the **parent source cycle** *after* the account-cycle row it fires for. EXIT correlation and entry
recovery lock the cycle first and the account cycle second. A writer that updates an account cycle without first locking its cycle therefore inverts them. Hermes reproduced this for
`refuseCandidate` (`external-signal-entry-admission.service.ts:27-43`): its first statement is `tx.externalSignalTradeCycleAccount.updateMany(…)`, and nothing locks the cycle before it.

**Audit of every writer** (source scan of `src/services`; the only code paths that write `ExternalSignalTradeCycleAccount`):

| Writer | Lock sequence | Verdict |
|---|---|---|
| EXIT correlation (`external-signal-correlation.service.ts:33`, `:38`) | source, binding, **cycle `FOR UPDATE`** (`:33`), then each account cycle `FOR UPDATE` (`:38`) | correct |
| Housekeeping terminalization (`:109`) | **cycle** `FOR UPDATE` (`:109`) before the account cycle | correct |
| Entry correlation `upsert` that creates the account cycle (`:73`) | cycle locked at `:33`; the row is new, so nobody can hold it | correct |
| Entry recovery (`external-signal-entry-recovery.service.ts:54-55`, write `:104`) | **cycle** `FOR UPDATE`, then account cycle `FOR UPDATE`, then the update | correct |
| **`refuseCandidate`** (`external-signal-entry-admission.service.ts:27`) | **account-cycle `UPDATE` first**; the trigger then locks the cycle | **violates the order** |
| TradingView admission (`market-policy-entry-admission.service.ts:108`, write `:133`) | one planner-ordered `FOR UPDATE OF ac,c,sr,rr,sig,auth,state,gen,work,ta,tas,sub,sec` statement, then the update | order **not guaranteed** (H4); fixed by the single-table statements of 6.7-3 |
| `check_external_signal_account_terminal_parent` (deferred trigger) | cycle `FOR UPDATE` after the account row | runs after `parent_lock` has already taken the cycle; consistent |

**Reproduction** (`c3b2-r5-order-section.ts`, probe **O1**; PostgreSQL 16.13 and 17.11, identical): the refusal statement shape against EXIT correlation's order, both queue orders, current and corrected.
The refusal is replayed as the same statement on raw connections because the function is not exported and this revision changes no production code.

| Variant | Queue order | Refusal | EXIT correlation |
|---|---|---|---|
| **current** (update the account cycle; the trigger takes the cycle) | EXIT holds the cycle first | **`40P01` deadlock** (victim) | completes |
| current | refusal first | completes | completes (EXIT queues behind it) |
| **corrected** (`SELECT … FROM "ExternalSignalTradeCycle" … FOR UPDATE`, then the update) | EXIT first | completes after EXIT | completes |
| corrected | refusal first | completes | completes |

The inversion is **order dependent**: the "refusal first" row is clean, which is why ordinary tests do not see it.

**Required contract.** *Every writer of an account cycle locks its parent cycle (row 8) before the account cycle (row 9), with a single-table statement, and only then updates.* For `refuseCandidate`:
inside the existing transaction, before the `updateMany`, `SELECT id FROM "ExternalSignalTradeCycle" WHERE id = ${account.externalSignalTradeCycleId} FOR UPDATE` (the candidate already includes `tradeCycle`),
then `SELECT … FROM "ExternalSignalTradeCycleAccount" WHERE id = … FOR UPDATE`, then the `updateMany`. A static test fails any `externalSignalTradeCycleAccount.(update|updateMany|upsert|create)` or raw `UPDATE "ExternalSignalTradeCycleAccount"` whose enclosing
transaction has no preceding cycle lock. **This correction belongs in the earliest C3B.2 implementation checkpoint (11.5), with H1, H2 and the worker-claim/recovery order of 6.6, because it needs no schema change and its
tests are pure interleavings.** Required tests: both queue orders, both PostgreSQL versions, through the real `processProspectiveTradingViewEntries` (not a replay), against EXIT correlation and entry recovery.

#### 6.9.2 Lock prelude as a database function (new hazard H6)

| ID | Hazard | Status | Probe |
|---|---|---|---|
| H6 | The Market Intelligence consumption insert (F step 7) takes the **MI authorization** lock (row 19) before the TradingView guard reaches the identity rows (10 to 16). A caller that does not pre-lock deadlocks with the real MI revoke (revoke holds the assignment and wants row 19). | **Reproduced** (`40P01`); fixed by `external_signal_lock_dispatch_graph` called by the guard and by the inert-for-unmarked `BrokerDispatchConsumption_a_lock_prelude` trigger | O2c (control), O2 (both queue orders) |

#### 6.9.3 Trigger execution order for the not-sent protection (LOW finding)

The not-sent protection (`external_signal_c2_not_sent_evidence_guard`) is only race-free because `external_signal_c2_delivery_event_fence` runs **first** on `EntryExposureClaimEvent`: the fence takes the
claim row `FOR UPDATE`, so a not-sent insert queued behind an uncommitted `ADAPTER_INVOCATION_STARTED` waits, and the guard then reads the committed contradiction. PostgreSQL fires triggers of the same
timing and event in **name order**, so the protection rests on the two trigger *names* (`…_c2_delivery_fence` < `…_c2_not_sent_guard`), which nothing pinned.

**Measured** (probes I2a to I2e, PostgreSQL 16.13 and 17.11):

| Probe | Result |
|---|---|
| I2a | Catalog regression: the `BEFORE INSERT` row triggers on `EntryExposureClaimEvent`, ordered by `tgname` in the `"C"` collation, are `…_append_only`, **`…_c2_delivery_fence`**, **`…_c2_not_sent_guard`**; both enabled (`O`) and bound to `external_signal_c2_delivery_event_fence` / `external_signal_c2_not_sent_evidence_guard`. |
| I2b | Shipped order: a not-sent insert queued behind an uncommitted `ADAPTER_INVOCATION_STARTED` waits at the claim lock, then is refused `TradingView not-sent evidence contradicts persisted dispatch or broker evidence`. |
| **I2c** | **Control:** the fence trigger renamed to sort after the guard. The same race **commits a `NOT_SENT_EVIDENCE_RECORDED` next to `ADAPTER_INVOCATION_STARTED`**: the guard reads before the claim lock, the lock then opens after the competitor commits. The order check detects the flip. |
| I2d | Trigger-independent alternative: the same flip with **one added statement** at the top of the not-sent guard (`PERFORM 1 FROM "EntryExposureClaim" WHERE id = NEW."claimId" FOR UPDATE`, after its `eventType` early return) is safe again. |
| I2e | Order restored after the controls. |

*Decision.* The catalog regression is the enforcement (it needs no change to the accepted guard). The one-statement alternative (I2d) is **documented, probed, and not adopted in this revision**: it changes accepted C2 code, and the order is
fully pinned by the manifest checks below. It is recommended as a hardening item if Hermes prefers independence from trigger names.

**Security manifest** (`readSecurityCatalog`, `compareWithManifest`, probes I3a to I3h). Against the committed C3B.1 manifest the overlay shows exactly what a migration must regenerate: `external_signal_broker_consumption_guard()` and
`external_signal_broker_evidence_quarantine()` as *changed*, every new function and trigger as *unreviewed*, and nothing missing. With the post-overlay catalog as the reviewed baseline: a **renamed** trigger is reported *missing and unreviewed*;
a **disabled** trigger *changed (`enabled`)*; a trigger **rebound** to another function *changed (`function`)*; an **altered function body** *changed (`bodySha256`)*; restoring each returns zero drift. The manifest does not encode firing
order; it only *implies* it through names. Therefore the preflight gains (a) `CRITICAL_TRIGGERS` entries for every new object (listed by probe I3h) and (b) an explicit **order invariant** (`results.proposedPreflightOrderInvariant`
holds the query): for each listed table the expected relative order of named triggers. Renaming either trigger is already reported (missing and unreviewed); the order invariant additionally covers a *new* trigger added with a name that sorts between them.

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
released as not-sent. **[R5]** The outcome classes and the locked re-read that implements this are defined in §3.8.
C3C adds the single separately keyed release of §3.6.3.

## 8. Sequencing, remaining work and prerequisites **[R4: revised]**

Hermes identified an operational dependency: a consumed pair that never reaches a broker adapter holds its exposure until the
expired-never-sent protocol proves it was never sent, and until C3C builds that terminalizer the only recourse is manual
reconciliation. The roadmap is therefore:

| Step | Content | Broker / production effect |
|---|---|---|
| **C3B.2** | The atomic authorization capability: the section 11.3 migration (fence, receipt clock, lock corrections, replaced consumption guard), `finalizeTradingViewDispatch`, the three MI refactors and the section 9 tests. **Test-only and default-off.** | None. No production caller. A static test asserts that nothing outside tests imports `finalizeTradingViewDispatch`. |
| **C3B.3** | Scheduler and activation *foundation* only: worker scheduling, rollout/activation operations, observability. **Finalization stays disabled**; the scheduler must not call F. | None. |
| **C3C** | The send decision (`SEND_PERMITTED`, `WITHDRAWN_NEVER_SENT`), the **expired-never-sent terminalizer**, the broker adapter, the authoritative client-order-ID lookup and the authoritative reconciliation, per sections 3.6.1 to 3.6.7. | First (PAPER only) broker effect, behind the activation gate. |
| **Activation** | Scheduling finalization is switched on **only after the complete C3C lifecycle has been validated end to end**: pair → permit → lookup → POST → observation, and every non-send path (expiry, withdrawal, stalled worker, lost acknowledgment, declined send) ending in either reconciliation or the terminalizer. | The canary. |

The broker-send rule is unchanged and stated in section 3.6.6 (R-SEND): only the process that created `SEND_PERMITTED` and
received acknowledgment of its own successful commit may initiate a POST; a permit discovered on retry, restart or recovery
never grants another send; reconcile instead.

**Prerequisites to C3B.2 acceptance.**

* **[C3B.2-0 implemented, pending acceptance — section 12]** The section 6.7 lock corrections (claim guard, authorization guard and grant, admission statement, account-cycle writers)
  with their probes re-run against the real services.
* The section 6.6 worker-claim path correction (explicit pre-locks, exposure advisory before the insert) and its probes.
* The C3B.1 migration applied to development by the product owner and the preflight green on the real runtime identity (**applied; 107 migrations current**).
* **[R5]** The section 6.9.1 account-cycle writer contract (`refuseCandidate`) and the checkpoint split of 11.5.3: the lock-order corrections land and are accepted as C3B.2-0 before the table-and-trigger migration (C3B.2-1).

**Before any canary** (unchanged from revision 3 and still required): broker-enabled readiness (`npm run
db:security-preflight -- --mode broker-enabled` green on the real runtime connection); the role cutover with session
draining applied and verified; the section 1.1 obligation checks; a defined global kill procedure; a PAPER rehearsal with the
activation epoch; SELL and LIVE remain disabled. Also retained as documented pre-canary hardening (found by the same audits,
not part of C3B.1):

1. **Function configuration drift**: the manifest pins body, language, volatility and the trusted `search_path`, but not
   other `proconfig` entries such as `statement_timeout`.
2. **PostgreSQL 17 `MAINTAIN` privilege** and the associated denial-of-service exposure through `VACUUM`/`ANALYZE`/`REINDEX`-class
   operations on application tables.
3. **Driver-adapter package class-identity consistency** between the packages that supply the pg adapter and the pg driver, so
   error classes and `instanceof` checks cannot silently diverge.
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
| 13 | **[R4] Fence version protocol** through `prisma.$transaction(…, { isolationLevel: 'Serializable' })` and the pg adapter: success (`v → v+1`, stored `v`), rollback, retry, wrong/stale/`NULL` version, fenced write inside the window, missing bump (probes A1 to A5b, raw `pg` today). | n/a | pair at `v+1`; rolled back at `v` |
| 14 | **[R4] Concurrent release and stale finalizer**: RC, RR and SER releasers and writers × both commit orders × {evidence event, intent update, claim release, `BrokerOrder`, `BrokerActivity` attribution}, each with its negative control (probes A6, A7, A8 today). | stale writer `40001` or already sees the pair | writer waits then is refused |
| 15 | **[R4] Receipt clock**: ingestion through the real service (the field is never supplied, `receivedAt` read back), supplied/advanced/backdated values rejected, immutability, historical `NULL` fails closed at admission, claim, F and C3C, nine time zones × three ways of setting them, `ALTER DATABASE`/startup zones, DST seconds-interval (probes B0 to B5 today, direct SQL). | | |
| 16 | **[R4] Lock matrix**: every row of section 6.2 against every other contested row in both queue orders with the real services, including the TV authorization grant after the section 6.7 fix, admission, the claim, F and S against MI grant, revoke and lapse; zero `40P01` (probes C2 to C9 today). | | |
| 17 | **[R4] Unmarked compatibility**: the existing legacy fill-import, broker-activity synchronization, order-lifecycle and entry-exposure integration suites run unchanged against a database carrying the new triggers; fence tuple counters unchanged (probe D5 today, SQL level). | | |
| 18 | **[R4] EXIT ingestion as a fence**: a SERIALIZABLE F whose snapshot predates an EXIT ingest fails `40001` at the cycle lock. | | |
| 19 | **[R4] Shared identity key**: quarantine, fence, F step 3 and the consumption guard use `external_signal_broker_evidence_marked_intents`; a `BrokerOrder` under another intent with the marked `clientOrderId` is rejected (probes D4 to D4c today). | | |
| 20 | **[R4] Sequencing guards**: no importer of `finalizeTradingViewDispatch` outside tests; the C3B.3 scheduler never calls it; a pair created in a test is reported as manual-reconciliation exposure until C3C. | | |
| 21 | **[R4] Real decision phase**: `prepareObligatedBrokerDecision` with a real frozen obligation, its decision insert's fence bump and lock order versus F (the probes seed the `ALLOWED` decision with triggers off). | | |
| 22 | **[R5] Upgrade and backfill** through the real Prisma migration runner (not `psql`): historical marked intents in claim `ENTRY_PENDING` (intent `received` and `pending`), `ENTRY_SUBMITTING`, `BLOCKED` (held) and released; unmarked intent; open writer (lock timeout, atomic rollback); writer started during the migration; second application; byte-for-byte preservation of ten tables; no manufactured receipt; C2 recovery after the upgrade; historical graph refused final authorization (probes U0 to U9 today, raw `pg` plus the production fixture). | | |
| 23 | **[R5] Complete consumption guard** under direct SQL with **no caller pre-locks**, `READ COMMITTED` and `SERIALIZABLE`: the fence-only negative control; evidence committed before F (BrokerOrder, cross-intent same-`clientOrderId` BrokerOrder, BrokerActivity, four claim-event types); stale world state with the current fence version supplied; superseded decision; **evidence in flight during F** (writer commits and rolls back); **F committing first**; stamps; supplied stamps rejected (probes E0 to E5, A6c today). Each case asserts zero MI and zero TradingView rows and no broker request. | | |
| 24 | **[R5] Account scope**: PAPER and LIVE accounts sharing a `clientOrderId` and broker order ids through BrokerOrder, activity by order id, activity by `brokerOrderRecordId` only, status sync, attribution and retargeting; quarantine enabled and relaxed; contradictory and unattributable rows; the legacy fill-import, broker-activity synchronization and order-lifecycle suites unchanged (probes S0 to S5, D5 today). | | |
| 25 | **[R5] Execution clocks**: ingestion through the real service (receipt read back, never supplied); a deliberately **skewed application `Date`** against admission, correlation, the replaced obligation and claim guards and the complete guard; nine time zones × three setters against every replaced comparison; **`NULL` receipt** at each gate (an explicit `IS NULL` branch, not a bare `<`); account-cycle and marked-intent `createdAt` stamps; the static audit scan of section 3.5.5 fails on a new `Signal.createdAt` comparison (probes T1 to T4 today). | | |
| 26 | **[R5] Refusal and account-cycle lock order** through the real `processProspectiveTradingViewEntries` and `refuseCandidate`, against EXIT correlation and entry recovery, **both queue orders, both PostgreSQL versions**, before and after the fix; a static test that every account-cycle writer locks its cycle first (probe O1 replays the statement today). | | |
| 27 | **[R5] Guard and prelude against Market Intelligence** (real grant, revoke and lapse services) with no caller pre-locks, both queue orders, zero `40P01`; the prelude-disabled control must deadlock (probes O2, O2c today, revoke only). | | |
| 28 | **[R5] Fence INSERT integrity** with a real restricted runtime role created by the C3B.1 role cutover (not `r5_app`): unmarked, version-999 and direct inserts refused, `UPDATE`/`DELETE`/`TRUNCATE` refused, legitimate creation works; the preflight invariant `marked intents without a fence = 0` (probes I1a to I1e today). | | |
| 29 | **[R5] Trigger order**: catalog regression for `EntryExposureClaimEvent` (and every table whose protection depends on trigger names), the flip control, the preflight **order invariant**, manifest detection of renamed, missing, disabled, rebound and altered objects after regeneration (probes I2, I3 today). | | |
| 30 | **[R5] Retry classification**: one unit test per captured adapter shape of section 3.8 (the results files contain the objects), the four look-alikes, the `P0001`-with-`40001`-text shape, a connection loss mid-transaction, and an integration test that forces each shape through the real `Serializable` F path and asserts the class decision **and** that the locked re-read of the consumption ran before any retry, refusal or release. Includes the lost-acknowledgment case of row 9. | | |
| 31 | **[R5] Real Market Intelligence chain** instead of seeded rows: admission under an **active** MI runtime rollout that writes the frozen obligation; `prepareObligatedBrokerDecision` creating the `ALLOWED` decision (its insert's fence bump and lock order versus F, which the seeded decisions of every probe so far skip); `ALLOWED` without an obligation rejected by `BrokerDispatchDecision_obligation_check`; duplicate admission (`obligationId = null` in the return value, obligation present in the database). | | |
| 32 | **[R5] No swallowed conflicts**: a static test that no new or replaced guard contains `EXCEPTION WHEN others`, `serialization_failure` or `deadlock_detected` (probe I4 today, with the accepted not-sent guard as its positive control). | | |

## 10. Disposable-database probe evidence

### 10.1 Primitive probes (revision 3, retained)

[`scripts/design-probes/c3b2-postgres-probes.mjs`](../../scripts/design-probes/c3b2-postgres-probes.mjs) creates and drops a
scratch database on a throwaway server, touches no application schema and issues no broker call. PostgreSQL **16.13** and
**17.11**, identical outcomes:

| Probe | Observation (both versions) | Used for |
|---|---|---|
| P1 | SERIALIZABLE reader sees 0 events; a competitor locks the claim `FOR UPDATE`, inserts an event, commits; the reader's later `UPDATE` of the claim returns **ok** (no `40001`), still sees 0 events, and `xmin` equals its transaction id. | A row "touch" and an `xmin` check do not detect lock-only evidence writers (3.4). |
| P1 (fence) | Same competitor also bumps a fence row; the reader's `SELECT … FOR UPDATE` on the fence raises **`40001`**. | The fence counter works (3.4). |
| P1b | After a `plpgsql` `EXCEPTION` block writes the row, `xmin` ≠ the top-level transaction id. | `xmin` is unreliable under subtransactions. |
| P2 | Unique-index insert of a second decision blocks while the first is uncommitted, then `23505`; if the first rolls back the second succeeds. | Permit versus expiry linearization (3.6.2). |
| P3 | With `SET CONSTRAINTS ALL IMMEDIATE`, a "deferred" check ran 2 ms after the insert; the commit was reached ~1.5 s later after a lock wait. | Deferred triggers are not a commit-time guarantee (3.7). |
| P3 | `track_commit_timestamp = off`; `pg_xact_commit_timestamp()` errors. | Commit-timestamp tracking is not available by default (3.7). |

### 10.2 Real-schema probes (revision 4)

[`scripts/design-probes/c3b2-r4-real-schema-probes.ts`](../../scripts/design-probes/c3b2-r4-real-schema-probes.ts) (with
`c3b2-r4-{fence,receipt,compat,locks}-section.ts` and the overlay
[`c3b2-r4-overlay.sql`](../../scripts/design-probes/c3b2-r4-overlay.sql)) creates a scratch database, replays **all 107
repository migrations** into it, applies the **proposed** fence and receipt objects, and builds real TradingView graphs with
the production fixture and services (`createTradingViewGraphFixture`, the MI policy, enrollment and grant services, the TV
authorization grant service). `fetch` is replaced by a spy that fails the run on any request, and the run reports
`no broker request was attempted`. Run it against a throwaway server only:
`PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r4-real-schema-probes.ts`
(optionally `PROBE_ONLY=fence,receipt,locks,compat`). Recorded results:
[`c3b2-r4-results-pg16.json`](../../scripts/design-probes/c3b2-r4-results-pg16.json) and
[`c3b2-r4-results-pg17.json`](../../scripts/design-probes/c3b2-r4-results-pg17.json).

**Result: 61 checks on PostgreSQL 16.13 and 61 on 17.11, 0 failures on each, no broker request.**

| Group | Checks | What they establish |
|---|---|---|
| setup | 1 | Real graph, worker claim, MI authorization (production services) and seeded `ALLOWED` decision build on the migrated schema. |
| A (fence), 29 | A0, A1, A2, A2b, A3, A4, A5, A5b, A6.0, A6.O1/O2/O3a/O3b × {RC, SER}, A6c, A7.1/A7.2 × {RC, SER}, A7.3 × {RR, SER}, A7.4, A7.4b, A8 | Section 3.4: the rev-3 contradiction (A1), the corrected protocol and its final values (A2, A3, A5), guard and self-verification (A4, A5b), one-shot unique constraints (A2b), lock-only competitors in both orders and isolation levels (A6), concurrent release (A7), and the existing evidence fence (A8). Negative controls A6c and A7.4 demonstrate the hazards. |
| B (receipt), 9 | B0, B1, B1b, B1c, B2, B2b, B3, B4, B5 | Section 3.5: types and defaults, 27 zone/setter combinations identical, legacy comparison wrong in five zones, startup and database-level zones, stamping and rejection, immutability, backfill trap, seconds-only interval. |
| D (compat), 5 | D2, D4, D4b, D4c, D5 | Sections 3.4.6 and 3.4.7: bump counts, the shared key, the quarantine gap, unmarked inertness. |
| C (locks), 16 | C0, C1a, C2.1, C3.0, C3.MI, C3.TV, C3.1, C4, C5, C6a to C6c, C7, C8a, C8b, C9 | Section 6: catalog extraction, measured lock sets, the deadlock reproductions and the corrected order in both queue orders, no hidden upgrade, MI revoke, pause/kill switch, allocation, the two accepted-code inversions and the account-cycle trigger lock. |

*Selected measurements.* Fence after a successful pair: `v=8` read, `8` after the MI insert, `9` after the TV insert and at
commit, `fenceVersion=8` stored; rolled back: `8`. Rev-3 protocol: `supplied 8, current 9`, rejected. Stale releaser (A7.4
control, fence off): evidence, intent block and release **all committed** with the pair intact; with the fence: `40001` at each
step. Lock reproductions: rev-3 pre-locks vs real MI grant, `40P01` for TV in about 1.0 s; current claim guard vs real MI
grant, TV `40P01`, MI granted; TV authorization grant vs MI grant, TV `CONCURRENT_AUTHORITY_CHANGE`; late `User` U vs
MI, MI `CONCURRENT_AUTHORIZATION_CHANGE`; corrected order: both queue orders complete in about 30 ms with zero deadlocks.

**What these probes do not prove (so nothing here is approved on their strength alone):**

* The `ALLOWED` MI decision is **seeded with triggers off** (the repository's own C3A seeds do the same); the real
  `prepareObligatedBrokerDecision` chain and its decision-insert bump are not exercised (test 21).
* MI grant and revoke run through the real services; MI **lapse** and **admission** are source-derived, and the TradingView
  **admission** statement was not run (the claim guard has the same shape).
* The fence was exercised with raw `pg` sessions, not through Prisma's `$transaction({ isolationLevel: 'Serializable' })`
  with the pg driver adapter.
* Unmarked compatibility was exercised with SQL equivalents of the legacy paths, not the services.
* EXIT ingestion's cycle touch is read from the catalog, not probed.
* The overlay's bump function dispatches through `to_jsonb`; the production functions must be typed and plan-checked.

### 10.3 Real-schema probes (revision 5)

Files, all under `scripts/design-probes/`: the proposed migration body [`c3b2-r5-overlay.sql`](../../scripts/design-probes/c3b2-r5-overlay.sql) (disposable, **not** a migration); the harness
[`c3b2-r5-real-schema-probes.ts`](../../scripts/design-probes/c3b2-r5-real-schema-probes.ts) with sections `c3b2-r5-{fence,compat,consumption,scope,epoch,order,integrity}-section.ts`
(the revision-4 receipt section is reused unchanged) and the shared helpers `c3b2-r5-common.ts`; the upgrade script
[`c3b2-r5-upgrade-probes.ts`](../../scripts/design-probes/c3b2-r5-upgrade-probes.ts); and the adapter probe
[`c3b2-r5-retry-classification-probe.ts`](../../scripts/design-probes/c3b2-r5-retry-classification-probe.ts). Each creates and drops a scratch database on a throwaway server, replays **all 107
repository migrations**, and uses the production fixture and services; `fetch` is replaced by a spy that fails the run on any request, and the run reports `no broker request was attempted`.
Revision-4 files are kept unchanged as that revision's evidence, except for one corrected comment (section 10.4).

```
PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r5-real-schema-probes.ts     # 137 checks
PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r5-upgrade-probes.ts          # 11 checks
PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r5-retry-classification-probe.ts  # 19 captured error shapes
```

Recorded results: `c3b2-r5-results-pg16.json` / `pg17.json`, `c3b2-r5-upgrade-results-pg16.json` / `pg17.json`, `c3b2-r5-retry-results-pg16.json` / `pg17.json`.

**Result: PostgreSQL 16.13 (Debian 16.13-1.pgdg13+1) and 17.11 (Debian 17.11-1.pgdg13+2): 137 + 11 checks and 19 classified error shapes on each version, 0 failures, identical outcomes, no broker request.**
(Revision 4's 61 checks are retained as its evidence; the A-series is re-run below against the revision-5 overlay and the complete guard.)

| Group | Checks | What they establish |
|---|---|---|
| setup | 1 | Real graph, worker claim, Market Intelligence authorization (production services), a **real frozen obligation row** and a seeded `ALLOWED` decision citing it, on the migrated schema with the revision-5 overlay. |
| A (fence), 30 | A0, A1, A2, A2b, A3, A4, A5, A5b, A6.0, A6.O1/O2/O3a/O3b × {RC, SER}, **A6c.RC, A6c.SER**, A7.1/A7.2 × {RC, SER}, A7.3 × {RR, SER}, A7.4, A7.4b, A8 | Section 3.4.2 to 3.4.5 re-run with F taking the full canonical lock sequence (rows 1 to 23) and the complete guard. A6c is split (3.4.9). |
| B (receipt), 9 | B0 to B5 (revision-4 section reused) | Section 3.5.2, unchanged by the overlay changes. |
| D (compat), 2 | D5, D2 | Unmarked inertness (zero fence-table writes through the lifecycle, claim, broker order, legacy fill import, activity attribution and delete) and bump counts, re-run against the rewritten key, quarantine and creation trigger. |
| E (consumption), 54 | E0, E1 × 14, E2 × 28, E2b × 2, E3 × 4, E4 × 2, E5 × 2, E5b | Section 3.4.9. |
| S (scope), 9 | S0, S1, S1b, S2, S3, S4, S4b, S4c, S5 | Section 3.4.6. |
| T (epoch), 5 | T1, T2, T3, T3b, T4 | Section 3.5.5. |
| O (order), 6 | O1a, O1b, O1c, O2 × 2, O2c | Section 6.9.1, 6.9.2. |
| I (integrity), 20 | I1a to I1e (6), I2a to I2e (5), I3a to I3h (8), I4 | Section 3.4.8, 6.9.3, 3.8. |
| U (upgrade, own script), 11 | U0 to U9 (U4 has two checks) | Section 3.4.8. |
| Retry (own script), 19 shapes | 10 retryable, 9 not | Section 3.8. |

**Selected measurements.**

* *Backfill:* six historical marked intents in four lifecycle states have six version-1 fences, the unmarked intent none; ten tables byte-identical before and after for the rows that existed; six historical signals keep `receivedAt IS NULL`.
* *Fence-only guard (E0):* a valid-looking pair **commits** next to a committed BrokerOrder. *Complete guard:* the same sequence, with 7 evidence shapes (E1), 14 world-state changes (E2) and a superseded decision (E2b), is refused in **44 of 44** cases across the two isolation levels; evidence in flight is refused or aborted when the writer commits and the pair commits when it rolls back (E3).
* *A6c:* bump trigger disabled → `READ COMMITTED` refused by the evidence check; stale `SERIALIZABLE` **commits** the pair next to the evidence (control).
* *Scope:* a LIVE BrokerOrder, activity by order id, activity by record id and a status sync, all sharing the PAPER `clientOrderId` and order id strings, are accepted with the quarantine **enabled** and move the PAPER fence **zero** times; their PAPER counterparts bump or are refused.
* *Clocks:* `createdAt >= epoch` is wrong in 15 of 27 zone/setter combinations (accepts a pre-epoch signal) and in 3 of 9 (refuses a post-epoch signal); `receivedAt` is right in 27 of 27. The authorization epoch is current to 0.02 s with the application clock an hour slow; an unstamped control column is 3600 s behind.
* *Locks:* the refusal replay deadlocks (`40P01`) in the EXIT-first queue order and not in the refusal-first order; the corrected refusal never deadlocks in either order. The complete guard against the real MI revoke completes in both orders; with the prelude trigger disabled it deadlocks.
* *Trigger order:* the shipped order is race-free; the flipped order commits `NOT_SENT_EVIDENCE_RECORDED` next to `ADAPTER_INVOCATION_STARTED`; the one-statement alternative closes it.

### 10.4 What the revision-5 probes do not prove

* The `ALLOWED` Market Intelligence decision is still **seeded with triggers off** (only the INSERT). Revision 5 seeds the frozen obligation row it must cite, so the guard's obligation checks run on real data, but the production
  `prepareObligatedBrokerDecision` chain, the **decision-insert fence bump** (modeled in E2b by a fenced intent write) and real admission under an active MI rollout remain proof obligation 11.2-4 and test row 31. The revision-4
  harness comment that said the seeded decision "confirms the database does not require an MI obligation" was **wrong and has been removed**: the `CHECK` needs a non-NULL id and the seed skipped the foreign-key triggers; an `ALLOWED` decision is not consumable without a frozen obligation (1.1).
* The refusal inversion (O1) is a **replay of the statement shape** on raw connections, not a call of `refuseCandidate`; the fix is proved by interleaving tests through the real service once it is changed (row 26).
* The restricted role of I1b is a role created by the probe with plain DML grants, not the C3B.1 cutover role.
* The overlay is applied by `psql`/`pg` as one script; the real Prisma migration runner (its own transaction and ordering) is test row 22.
* MI grant and lapse against the new guard were not re-run (revoke, both orders, was). The lock modes the guard takes are the corrected set whose grant interleavings revision 4 measured (C3.0 to C3.TV).
* The overlay's bump function still dispatches through `to_jsonb`; the production functions must be typed and plan-checked (11.2-6).

## 11. Summaries: corrections, remaining proof obligations and recommended C3B.2 scope **[R4, R5]**

Sections 11.1 to 11.4 are the revision-4 summary, retained; **section 11.5 is the revision-5 summary and supersedes 11.3 where they differ** (the checkpoint split).

### 11.1 Statements corrected by this revision

| Earlier statement | Correction |
|---|---|
| Both consumption inserts are in the fence's bump set and the guard checks `fenceVersion` equals the fence (rev 3, 3.4) | Self-defeating (probe A1). Only the TV consumption bumps, once, after its own guard. |
| The current evidence fence never changes the exposure claim row (rev 3, 3.4) | It runs a same-value `UPDATE` of the claim (`lastDiagnosedAt`), which writes a new version. Coverage and gaps are in 3.4.5. |
| One bump per logical event | Not required and not true (probe D2: 3 statements, 4 bumps). Requirement: strictly increasing, never skippable. |
| `Signal.createdAt` plus `clock_timestamp()` bounds the signal at 120 s (rev 3, 3.5) | Session-time-zone dependent and application-clock written; replaced by `Signal.receivedAt` (3.5). |
| `MarketPolicyBrokerDispatchDecision.obligationId` is nullable and nothing requires an obligation (rev 2/3, 1.1) | A `CHECK` requires it for every consumable decision (1.1). |
| The rev-3 lock order is acyclic (rev 3, 6.3) | It omitted `User`, the implicit `parent_lock` trigger and the TV authorization grant; it used `TradingAccount` U (probe C2.1). Replaced by 6.5. |
| Stale recovery treats a pair as `DISPATCH_OUTCOME_UNKNOWN` "until C3C" (rev 3, case 8) | No production path may create a pair before C3C exists (3.6.8). |
| Absence checks keyed on `orderIntentId` are sufficient | They miss activity tied through its `BrokerOrder` and a `BrokerOrder` carrying the marked `clientOrderId` (D4b/D4c). |

### 11.2 Remaining proof obligations

Each is a test or audit that must pass before C3B.2 is accepted. None is claimed by revision 4.

1. Re-run probes C2 to C9 with the **corrected services and migration** (TV grant `User` S first and `FOR SHARE`, admission
   single-table statements, claim path pre-locks, account-cycle writers) instead of the statement replays used here.
2. Run the TradingView **admission** lock statement and MI **lapse** resolution against each other and against MI grant
   and revoke in both queue orders.
3. Audit every transaction that updates `TradingAccount` and later locks the assignment, `Subscription`, `Security` or `User`;
   audit every account-cycle writer for cycle-first ordering (H3).
4. Prove the fence through Prisma `Serializable` interactive transactions and the pg adapter, with the real
   `prepareObligatedBrokerDecision` creating the decision (bump position and lock order versus F).
5. Probe the EXIT-ingest cycle touch as a fence (`40001` at F's cycle lock).
6. Run the existing legacy fill-import, broker-activity synchronization, order-lifecycle and entry-exposure suites against a
   database with the new triggers; measure the added cost on the hot `BrokerOrder`/`BrokerActivity` paths with typed
   functions and the new partial index.
7. Prove `receivedAt` through the real ingestion service (never supplied, read back), at admission, claim, F and the permit,
   with a deliberately skewed application clock, and confirm `transaction_timestamp()` semantics under Prisma's interactive
   transaction (the start of the transaction is the receipt; a long-open transaction only shortens the window).
8. Assert that no runtime role holds `session_replication_role`, trigger-disable or table-owner privilege, and that no role
   can `UPDATE`/`DELETE`/`TRUNCATE` the fence or `UPDATE` `receivedAt` (the preflight must be extended).
9. Decide, with the product owner, whether to add the sender-asserted event-age bound of 3.5.3.
10. Confirm the Alpaca client-order-ID lookup endpoint, status codes, rate limits and duplicate-`client_order_id` behavior
    against the current Alpaca reference (C3C; no broker contact before then).

### 11.3 Recommended C3B.2 implementation scope (test-only, default-off)

**[R5] This scope is delivered in two checkpoints, C3B.2-0 (lock order only) then C3B.2-1 (everything below); see 11.5.3.**

*In scope.* One forward-only migration, regenerated security manifest and preflight, containing: (1) the two lock-mode
corrections of 6.7 (claim guard, TV authorization guard); (2) `Signal.receivedAt` with its guard, immutability, the two
functions and a `Timestamptz(6)` Prisma field; (3) `ExternalSignalDispatchFence`, its create/bump/guard/verify objects, the
shared evidence key function and the partial `clientOrderId` index; (4) the TV consumption columns (`authorizedAt`,
`authorizationDeadlineAt`, `fenceVersion`) and the replaced consumption guard of 5.3, calling the receipt function. Service
changes: the TV grant and admission lock order, the claim path pre-locks of 6.6, the three MI refactors of section 2, the
shared key in the quarantine, and `finalizeTradingViewDispatch` with the F steps of 3.3. Tests: section 9 rows 1 to 21. A
static test that no production code imports F.

*Out of scope (must not appear in C3B.2).* The send-decision table, the terminalizer, the adapter, the lookup, any scheduler
entry or activation, relaxation of the broker-evidence quarantine, `EXIT` or SELL work, LIVE, and any broker call.

### 11.4 What Hermes is asked to review

The fence protocol of 3.4.2 and its alternatives; the receipt clock of 3.5 and the decision on 3.5.3; the lock correction of
6.4 to 6.7, especially the two accepted-code inversions (H1/H2) found by the catalog extraction, which are defects in
already-accepted C1/C2 code and may warrant a separate fix ahead of C3B.2; and the sequencing of section 8.

### 11.5 Revision-5 summary: corrections, remaining proof obligations and the recommended first checkpoint **[R5]**

#### 11.5.1 Statements corrected by revision 5

| Earlier statement | Correction |
|---|---|
| The fence is created by the `OrderIntent` insert trigger (rev 4, 3.4) | Only for intents inserted **after** the migration. Existing marked intents had no fence (HIGH). The migration backfills them at version 1 inside one locked transaction (3.4.8). |
| A correct, current fence version in the TradingView consumption insert authorizes it (rev 4, 3.4.2, 5.3-11) | Necessary, **not sufficient**: evidence that committed before F read the fence is inside the version. The complete guard checks the evidence itself (3.4.9, E0). |
| The shared evidence key is keyed by `orderIntentId`, `clientOrderId`, `brokerOrderId` (rev 4, 3.4.6) | It was not account-scoped: another account's order could bump the PAPER fence or be refused. Every branch now requires the intent's trading account; `NULL` never matches; `brokerOrderRecordId` added (S0 to S5). |
| `createdAt` comparisons "are unchanged by this revision and listed as an audit item" (rev 4, 3.5.2) | Audited (3.5.5): two accepted database functions and five service lines compare `Signal.createdAt` with an epoch or an age, two of them through an implicit `TimeZone` cast. They move to `receivedAt`. |
| Account-cycle writers are an audit item (rev 4, 6.7-4, H3) | Audited: `refuseCandidate` is the one violator, reproduced (O1a); the TradingView admission statement is order-undefined (H4) (6.9.1). |
| F's step-1 pre-locks make the lock order safe (rev 4, 6.5) | Only for callers that pre-lock. The MI consumption trigger takes row 19 before the guard reaches rows 10 to 16, so a non-pre-locking caller deadlocked with the real MI revoke (O2c). The prelude is now a database function (3.4.9, 6.9.2). |
| The not-sent protection is race-free (rev 3 to 4) | Only while one trigger **name** sorts before another (I2c). Pinned by a catalog order regression (6.9.3). |
| "A timeout is a retryable refusal" (rev 4, 3.3) | `55P03` is not a retryable conflict; it is a `NO_EFFECT_REFUSAL` that is re-read and retried at most once (3.8). |
| The probe harness comment: the seeded decision "confirms that the database does not require an MI obligation" (rev 4 harness) | Wrong; removed. The `CHECK` needs a non-NULL id; the seed skipped the FK triggers. Revision 5 seeds a real obligation row. |

#### 11.5.2 Remaining implementation proof obligations

Each is a test or audit that must pass before C3B.2 is accepted. None is claimed by revision 5.

1. Everything in 11.2, with these changes: obligation 3 is closed for `refuseCandidate` and re-opened as the static every-writer test (row 26); obligation 7 uses the receipt functions in rows 1 to 6 of the 3.5.5 audit.
2. **Upgrade through the real Prisma migration runner** against a copy of the persistent development database (not only a scratch one), with the pre- and post-migration invariants of 3.4.8, and the preflight query `marked intents without a fence = 0` (row 22, 28).
3. **Typed** `external_signal_dispatch_fence_bump` / `external_signal_broker_evidence_marked_intents` / `external_signal_marked_intent_broker_evidence` with `EXPLAIN` on the hot `BrokerOrder` and `BrokerActivity` paths, the partial index on `ExternalSignalEntryExecutionObligation ("clientOrderId")`, and an indexed `("tradingAccountId", "brokerOrderId")` and `("tradingAccountId", "clientOrderId")` access for the reverse scan; measure the added cost on unmarked writes.
4. The **real Market Intelligence decision chain** with a frozen obligation produced by real admission under an active MI rollout, including the decision-insert bump (row 31).
5. The replaced obligation guard and worker-claim guard (3.5.5 rows 4 and 5) and the replaced service SQL (rows 1 to 3b, 6), each with an explicit `NULL`-receipt branch, plus the skewed-clock tests (row 25).
6. The `refuseCandidate` fix and the single-table statements of the TradingView admission lock (6.9.1), with both queue orders on both versions against the real services (row 26).
7. MI **grant** and **lapse** against the prelude and the complete guard, both queue orders (row 27); the TradingView authorization grant after the `User`-first correction.
8. Manifest regeneration for every new and replaced function and trigger, the `CRITICAL_TRIGGERS` additions of probe I3h and the **trigger-order invariant** (row 29).
9. The retry classes and the **locked re-read** of 3.8 inside the real F orchestrator, including the lost-acknowledgment case (row 30); unit tests built from the captured shapes.
10. A decision on the optional one-statement lock in the not-sent guard (I2d), and on the sender-asserted event-age bound (3.5.3).
11. Preflight additions: no runtime role may hold `session_replication_role`, `TRIGGER`, table ownership, or `UPDATE`/`DELETE`/`TRUNCATE` on the fence, or `UPDATE` on `receivedAt` (unchanged from 11.2-8).
12. Confirm the Alpaca client-order-ID lookup contract before C3C (unchanged).

#### 11.5.3 Recommended first C3B.2 implementation checkpoint: **C3B.2-0, lock order only**

Split the implementation in two so the part that is pure ordering lands first, with no schema change and no new table:

**C3B.2-0 (no migration of tables or columns; one small function-replacement migration only if the claim and authorization guard modes are changed there).**

1. The **H1/H2 corrections** already in 6.7: claim guard `FOR SHARE OF ta,tas,sub,sec`; TradingView authorization guard `FOR UPDATE OF src,b,r FOR SHARE OF tas,ta,s,u`; the TradingView grant service takes `User` `FOR SHARE` first and the four identity rows `FOR SHARE`.
2. The **worker-claim / recovery order** of 6.6: rollout advisory, explicit single-table pre-locks, exposure advisory, then the claim insert.
3. The **admission lock statement** split into single-table statements in the section 6.5 order (H4).
4. The **`refuseCandidate`** parent-cycle-first fix and the static every-account-cycle-writer test (6.9.1), with the **O1** interleavings through the real service, both queue orders, PostgreSQL 16 and 17.
5. Regression tests: the revision-4 locks section C2 to C9 re-run against the corrected services and migration (11.2-1), MI grant, revoke and lapse against all of the above.

Rationale: these are the only findings that change **already-accepted C1 and C2 behavior**, they are reproduced deadlocks (fail-closed but operationally real once workers run), they have no dependency on the fence, the receipt clock or any new table, and they can be accepted or rejected in isolation. They are also what the fence and the complete guard assume.

**C3B.2-1 (the migration of 3.4.8 and 11.3)**, only after C3B.2-0 is accepted: fence, backfill and insert guard; `Signal.receivedAt` and the receipt and epoch functions; the candidate-side stamps; the replaced obligation and claim guards; the account-scoped key, quarantine and reverse-evidence function; the lock-prelude function and trigger; the consumption columns, the complete guard, the bump and verify triggers; manifest regeneration; then `finalizeTradingViewDispatch` (test-only, default-off) and the service changes of 3.5.5 and 3.8. Sections 2, 8 and 11.3 otherwise stand: no scheduler entry, no adapter, no send decision, no LIVE or SELL, no broker call.

#### 11.5.4 What Hermes is asked to review in revision 5

The migration sequence and its locking argument (3.4.8), including the choice to backfill before any fence trigger exists and the `pg_trigger_depth() >= 2` creation context; the complete guard and the claim that the guard (READ COMMITTED) and the fence (stale SERIALIZABLE) are both required (3.4.9);
the account-scoped key and the two additional quarantine refusals (3.4.6); the finding that the epoch columns are already database-stamped and only the candidate side needs a stamp (3.5.5); the lock prelude as a database function and its MI-consumption trigger (6.9.2); the retry classes and the locked re-read (3.8);
the trigger-order decision (catalog regression adopted, the one-statement alternative documented) (6.9.3); and the split of the first implementation checkpoint (11.5.3).

## 12. C3B.2-0 implementation record (lock-order corrections) and C3B.2-1 prerequisites

### 12.1 What C3B.2-0 changed

C3B.2-0 corrects already-accepted C1/C2 behavior so that every TradingView path takes its rows in the section 6.5 order, in the mode
its guard will request. It adds no table, column, trigger, privilege, dispatch or broker capability, and it is not a design of the fence,
the receipt clock or the paired consumption (those remain C3B.2-1).

**Service transactions changed (four):**

| Transaction | Change |
|---|---|
| Worker claim (`processTradingViewOrderIntentForC2`, SERIALIZABLE) | Rollout advisory → rollout state U → dispatch state U → source U → binding U → revision U → generation U → source cycle U → account cycle U → `TradingAccount`, assignment, `Subscription`, `Security` **FOR SHARE** → authorization U → **exposure advisory** → intent U → exposure claim U → *then* the worker-claim insert. The guard now finds every row held and cannot wait. |
| TradingView grant (`grantExternalSignalEntryExecutionAuthorization`, SERIALIZABLE) | `User` **FOR SHARE first** (the owner stays effective until commit), advisory, rollout state, source, binding, revision, generation, then the four identity rows FOR SHARE. |
| Marked admission (`lockAndValidateTradingViewExecution`, READ COMMITTED) | The single planner-ordered `FOR UPDATE OF ac,c,sr,rr,sig,auth,state,gen,work,ta,tas,sub,sec` is replaced by single-table statements: rollout state, source, binding, revision, generation, cycle, account cycle, then signal, route, run and work, then the identity rows FOR SHARE, then authorization; the validation query that follows holds no lock of its own. Unmarked PAPER/LIVE admission is untouched. |
| `refuseCandidate` (READ COMMITTED) | Locks the parent source cycle, then the account cycle, before the guarded `BLOCKED` transition. No terminalization or claim release was added. |

The primitive is [`external-signal-lock-order.ts`](../../src/services/external-signal-lock-order.ts): one statement per relation, a whitelist of relation names, `FOR UPDATE` or `FOR SHARE`.

**PostgreSQL functions replaced (three), by migration `20261102120000_tradingview_lock_order_corrections`** (rewritten from the installed definition with an asserted `replace`, `search_path = pg_catalog, public, pg_temp` retained, the trusted search-path audit restated):

| Function | Clause |
|---|---|
| `external_signal_broker_worker_claim_guard` | `FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec` → `FOR UPDATE OF i,ac,c,auth,gen,src,b,rev,ec FOR SHARE OF ta,tas,sub,sec` |
| `external_signal_entry_authorization_guard` | `FOR UPDATE OF tas,ta,s,src,b,r,u` → `FOR UPDATE OF src,b,r FOR SHARE OF tas,ta,s,u` |
| `external_signal_entry_obligation_guard` | `FOR UPDATE OF oi,ac,c,sig,sr,rr,auth,gen,ta,tas,sub,sec,src,b,rev` → `… ,src,b,rev FOR SHARE OF ta,tas,sub,sec` |

The third function was **not** in the revision-5 list (6.7). It runs inside admission, after the identity rows are held FOR SHARE; left at `FOR UPDATE` it would *upgrade* them in the guard, so two admissions for different assignments of one account could
deadlock on `TradingAccount`. It is the same hidden-upgrade defect as the claim guard and is corrected the same way. Trigger names, bindings, privileges and signatures are unchanged; three `bodySha256` values changed in the reviewed manifest and nothing else.

### 12.2 Corrected sequence (rows of section 6.5 as implemented)

0 `User` (grant) S → 1 rollout advisory → 2 rollout state U → 3 dispatch state U (claim) → 4 source U → 5 binding U → 6 revision U → 7 generation U → 8 source cycle U → 9 account cycle U → 10 `TradingAccount` S → 11 assignment S → 12 `Subscription` S → 15 `Security` S →
17 authorization U → 21 exposure advisory (claim; admission takes it after the Market Intelligence resolver, as before) → 22 intent U → 23 exposure claim U. Immutable evidence rows (signal, route, run, work) are locked U by admission after row 9.

### 12.3 Evidence

Results are recorded in the C3B.2-0 delivery report (concurrent interleavings on PostgreSQL 16.13 and 17.11 through the real services; control run against the pre-correction code; migration replay and upgrade from the 107-migration baseline; regression suites). The suite is
[`external-signal-lock-order.integration.test.ts`](../../src/db/__tests__/external-signal-lock-order.integration.test.ts). Each scenario parks one side behind a gate lock on a raw connection, starts the other side, confirms the intended lock wait from `pg_stat_activity`, releases the gate, and asserts both durable outcomes and that
`pg_stat_database.deadlocks` did not move (a retrying service would otherwise hide a `40P01`).

Findings that remain after C3B.2-0:

* **Stale recovery versus claim has one reachable order.** Stale-admission recovery selects only `received` intents; the claim requires `pending`. The race is therefore recovery (selected while `received`) queued first, claim second. The opposite order cannot occur for the same intent; post-claim recovery and `refuseAndRelease` are unchanged and were not part of the inversion.
* **The static every-account-cycle-writer test of 6.9.1 is not written.** `refuseCandidate` is fixed and exercised through the real service; the repository-wide static scan remains a C3B.2-1 task.
* **TradingView rollout state and dispatch state are still taken U** (rows 2 and 3) by claim and admission; both are global by design (6.8-G).
* Admission now also locks the source, binding and revision rows `FOR UPDATE` (the obligation guard already did, planner-ordered). This serializes admission with source and binding edits; it adds no new refusal.

### 12.4 C3B.2-1 implementation prerequisites (Hermes revision-5 review)

These are acceptance requirements for the future migration. **None is implemented in C3B.2-0.**

1. **Lock first, do not upgrade later.** The migration takes `ACCESS EXCLUSIVE` on `"Signal"` and on `"ExternalSignalBrokerDispatchConsumption"` at its very start (its first statements, in that order), rather than escalating from a weaker lock after other work. Ingestion, routing, admission and the worker must be drained before it is applied; the operator runbook states the drain and the check that nothing holds a conflicting lock.
2. **Restate the trusted search-path audit** (the `DO` block of the C3A hardening migration, as restated by C3B.1 and C3B.2-0) at the end of the migration, so every new or replaced function is pinned and the audit proves no application function is unpinned.
3. **Reject cross-account `BrokerActivity.brokerOrderRecordId` associations.** A `BrokerActivity` whose `brokerOrderRecordId` points at a `BrokerOrder` of a different trading account than the activity's must be refused by the replaced fence and quarantine logic (the account-scoped evidence key of 3.4.6), with a test that the pairing is rejected and does not bump or release any fence.
4. **Update the fixtures.** The C3A replica-seeded fixtures and the PAPER-authority paired-consumption fixtures must be updated for the fence and the new `fenceVersion` requirement. **All 142 reported failures must be reconciled by test identity**: the acceptance report lists each failing test name before the fixture change, the fixture or expectation that was updated, and its result after; a count alone is not accepted, and no test may be deleted or skipped to reach a green count.
5. **Failed-migration recovery.** If `prisma migrate deploy` fails on this migration, first confirm that the failed migration left **no persistent change** (the objects it creates are absent, the replaced functions still carry their previous `bodySha256`, no trigger was added or dropped, and the fence backfill wrote nothing), and only then run `prisma migrate resolve --rolled-back <migration_name>` and retry. If any persistent change is found, stop and repair forward; do not mark it rolled back.
6. **Atomicity stays Prisma's.** Do not add an explicit `BEGIN`/`COMMIT` to the migration file. Prisma's atomicity of a migration script was independently tested in review (a script that fails midway leaves no change), and a nested wrapper would end the transaction early or hide the failure from the migration history.

## 13. C3B.2-1 implementation record (receipt clock and dispatch-fence foundation)

Migration `20261103120000_tradingview_receipt_clock_dispatch_fence_foundation` (109th). **Inert safety infrastructure:** no production code writes a TradingView consumption, no permit, scheduler or broker call exists, and a static test asserts it. Operator procedure: [`tradingview-c3b2-1-migration-runbook.md`](../production/tradingview-c3b2-1-migration-runbook.md).

### 13.1 What it installs

| Area | Objects |
|---|---|
| Locks (Hermes MEDIUM) | `lock_timeout 15s`; `ACCESS EXCLUSIVE` on `Signal` then `ExternalSignalBrokerDispatchConsumption` first; then one `SHARE ROW EXCLUSIVE` statement over twelve tables in a fixed order. No upgrade anywhere; no `BEGIN`/`COMMIT`. |
| Fence | `ExternalSignalDispatchFence`, its guard (insert only from the creation trigger at version 1; update only trigger-issued +1; no delete/truncate), historical backfill at version 1 before any fence trigger exists, creation trigger, typed bump triggers on the nine fenced tables, post-conditions (zero missing, zero unexpected). |
| Receipt clock | `Signal.receivedAt timestamptz` (no default, no backfill, stamped from `transaction_timestamp()`, supplied value rejected, immutable); `external_signal_signal_receipt_remaining/open/received_since`; database stamps of `ExternalSignalTradeCycleAccount.createdAt` and marked `OrderIntent.createdAt`; the obligation and worker-claim guards rewritten to read `receivedAt` with an explicit `IS NULL` branch. |
| Evidence identity | Shared account-scoped key and its reverse; quarantine rebuilt on it, plus the contradictory-account, unattributable and **cross-account `brokerOrderRecordId`** refusals (Hermes LOW). |
| Consumption | Four columns (`authorizedAt`, `authorizationDeadlineAt`, `fenceVersion`), `external_signal_lock_dispatch_graph`, the Market Intelligence lock-prelude trigger, the complete guard, the post-pair bump and its self-verification. |
| Services | Admission, worker claim and correlation read the database receipt clock; the application-clock subtractions are gone. `createdAt` is unchanged for audit. |
| Preflight | Every new trigger in `CRITICAL_TRIGGERS`, a firing-order invariant (`TRIGGER_ORDER_INVARIANTS`, finding `CRITICAL_TRIGGER_ORDER_UNSAFE`), regenerated manifest (138 functions, 158 triggers), trusted `search_path` restated. |

### 13.2 Differences from the revision-5 overlay

1. **Index claim corrected** (see 3.4.7). Added `BrokerOrder(orderIntentId)`, `BrokerOrder(tradingAccountId, brokerOrderId)`, `ExternalSignalEntryExecutionObligation(clientOrderId)` and a small partial index of marked intents per account. The key and its reverse are PL/pgSQL (cached plans) with a fast exit for accounts that own no marked intent.
2. The fence bump uses typed per-shape trigger functions, not the overlay's `to_jsonb` dispatch.
3. The migration also rewrites the C1 obligation guard and C2 worker-claim guard from their installed definitions with asserted replacements (the overlay only specified them).
4. The cross-account activity link rule (13.1) is new. It rejects a `brokerOrderRecordId` link when both accounts are known and differ, or when the order is marked TradingView evidence (including a NULL account).
5. Fence table privileges: guards run as the invoker, so the runtime role necessarily holds `INSERT/UPDATE/DELETE` on the fence; the guard, not a missing privilege, is the protection (the 3.4.7 sentence that said otherwise is superseded). `TRUNCATE`/`TRIGGER` are not granted and tested.
6. A defect found by the legacy suites during development and fixed before commit: an expression combining `TG_TABLE_NAME` with `NEW."brokerOrderRecordId"` in the shared quarantine function failed at plan time for `BrokerOrder` (57 legacy tests failed). Nested `IF`s now keep field references table-specific.

### 13.3 Decisions retained

Sender-asserted `signalTime`/`barTime` remain observational: the 120-second rule measures server receipt on the database clock, not event age (3.5.3). Development stays observer-only; no runtime-role cutover is performed here.

### 13.4 Evidence

* PostgreSQL 16.13 and 17.11, all gated suites, `--maxWorkers=4`: baseline 4048 tests; final 4155 (107 new). PG16: 4084 passed, 0 failed; PG17: 4152 passed, 0 failed. The remainder in each JSON report (71 and 3) are tests the report writer flagged "pending/still running"; those files were re-run on their own and passed (PG16: 101 + 42; PG17: 143).
* New suites: foundation 43, consumption guard with real Market Intelligence 44, genuine 108-to-109 upgrade through the real Prisma runner 13, unit tests for the trigger-order evaluator, one restricted-role test.
* Fixture reconciliation: [`tradingview-c3b2-1-fixture-reconciliation.md`](tradingview-c3b2-1-fixture-reconciliation.md) lists all 155 tests that failed with the migration applied and no fixture change (153 fixture incompatibilities, 2 inventory expectations), each passing in the final run. Hermes's list of 142 was not available to this checkpoint, so the reconciliation is by this checkpoint's own identities.
* Performance: [`…-performance-pg16.json`](tradingview-c3b2-1-performance-pg16.json) and [`…-pg17.json`](tradingview-c3b2-1-performance-pg17.json). Unmarked broker writes on accounts without marked intents: about +20 µs (BrokerOrder insert 36 to 56 µs). On an account that owns marked intents (the TradingView PAPER account) each broker row costs about 160 µs against 30 µs. The first implementation cost about 480 µs for every unmarked row; the indexes and PL/pgSQL form removed it.

### 13.5 Remaining risks and limits

* Lock inversion potential: a marked path that updates `OrderIntent` and later its claim in one transaction takes the fence before the claim; concurrent claim-first writers could deadlock (`40P01`, fail-closed). The existing concurrency suites show none; C3B.2-2 must keep its explicit lock order.
* The paired-consumption fixtures write raw SQL; the Prisma model requires the three new columns although the database stamps two of them. C3B.2-2 must insert with SQL that omits them.
* Historical signals have `receivedAt NULL` permanently; a signal accepted shortly before migration is refused at admission (safe direction).
* Not applied to persistent development; the new migration needs the drain procedure in the runbook.
