# TradingView Phase 4A.2C3B.2: final-dispatch transaction contract

Status: **design, revision 4, for review. Nothing in this document is implemented.** C3B.1 (`733a426`) is accepted and
broker-inert; it adds no consumption writer, scheduler entry, broker adapter call or POST. Implementation of C3B.2 waits
for review of this contract. No broker call is authorized in any checkpoint covered by this document.

Revision 2 corrected the first draft after an independent PostgreSQL 16/17 audit. Revision 3 removed the false claim that a
deferred constraint trigger is a commit-time guarantee and introduced the dispatch fence. Revision 4 corrects revision 3
after a third audit (16.15 and 17.5) that reproduced three design contradictions, and resolves five precision findings.
Every claim below that says "probe" was executed against a **real migrated schema** (all 107 repository migrations plus the
proposed overlay) on **PostgreSQL 16.13 and 17.11** with identical results (61 checks each, section 10).

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

Correction notes in this document are marked **[R2]**, **[R3]** or **[R4]**. File references are to the current repository.
Baseline: `733a426` (C3A + C3B.1). The proposed objects exist only in the disposable overlay
[`scripts/design-probes/c3b2-r4-overlay.sql`](../../scripts/design-probes/c3b2-r4-overlay.sql); they are not migrations.

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

The service-level checks in steps 2–5 give legible errors; the database guard of §5.3 is the authority.

If F aborts for any reason it leaves no consumption, and the intent remains `submitting` with an unreleased
`ENTRY_SUBMITTING` claim: the C2/C3A "stranded worker claim" state that recovery already handles (§7).

### 3.4 The dispatch fence: a concrete, enforceable mechanism **[R4: version protocol redesigned]**

**Problem (unchanged from revision 3).** F runs SERIALIZABLE, so its validation reads use a snapshot taken before its lock
waits (section 3.1 items 1, 2, 7). The dangerous competitor writes *evidence* (a `BrokerOrder`, a newer decision, an event)
after that snapshot, possibly while only **locking** the intent and claim, so neither a row "touch" nor an `xmin` comparison
sees it. `xmin` is rejected on evidence (disposable probes P1/P1b, PG 16.13/17.11): it is satisfied while a lock-only
competitor's evidence is invisible, is false after a subtransaction write, and compares a 32-bit `xid` with a 64-bit `xid8`.

**Mechanism.** A database-maintained counter, `ExternalSignalDispatchFence(orderIntentId PK, version bigint)`, created at
version `1` by the `OrderIntent` insert trigger for a marked intent and incremented only by `AFTER ROW` triggers on the fenced
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

#### 3.4.6 Fenced writes, bump semantics and the shared evidence key (D2, D4) **[R4]**

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

**One identity key (D4).** A broker row belongs to a marked intent when **any** of these hold: its `orderIntentId`; its
`clientOrderId` equals the frozen `ExternalSignalEntryExecutionObligation.clientOrderId`; for activity, its `orderId` equals the
`brokerOrderId` of a same-account `BrokerOrder` that belongs to the intent by `orderIntentId` or by `clientOrderId`. One SQL
function, `external_signal_broker_evidence_marked_intents(orderIntentId, clientOrderId, brokerOrderId, accountId)`, returns the
marked intents and is used by **all four** consumers: the fence triggers, the TV consumption guard's "no `BrokerOrder`/
`BrokerActivity`" check (section 5.3 item 7), F's step 3 and the broker-evidence quarantine. Both old and new values of an
`UPDATE` are resolved, so `updateMany` attribution to the intent and a move away from it both bump (probe D4: five shapes,
one bump each).

Probe D4b/D4c found that the current checks are keyed inconsistently: an absence check on `"orderIntentId" = X` finds
**0** rows for an activity tied only through its `BrokerOrder` and for a `BrokerOrder` under another intent that carries the
marked `clientOrderId`, and the existing quarantine (`external_signal_broker_evidence_quarantine`, `NEW."orderIntentId"` only)
**accepted** that second row. `BrokerOrder.orderIntentId` is `NOT NULL`, so the first gap exists for `BrokerActivity` today and
both appear once C3C relaxes the quarantine. **Requirement:** the quarantine is relaxed only in the same migration that makes
the quarantine, the fence and the absence checks all call the shared key. Activity with no `BrokerOrder` row and no intent cannot be tied to
an intent by any database key; only the authoritative client-order-ID lookup (section 3.6.6) covers it.

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
* **Lock position.** The fence is the last lock a writer takes (row 24, section 6.5): the bump runs after the intent/claim
  write. Order sync and any `updateMany` over several rows must visit intents in ascending id, or accept `40P01` as fail-closed
  noise.
* **No bypass for a runtime role:** no `UPDATE`/`DELETE`/`TRUNCATE` privilege on the fence, no `session_replication_role`,
  no `ALTER TABLE … DISABLE TRIGGER` (table owner). The tests of section 9 that disable triggers (A5b, A6c, A7.4) do so only
  in the disposable database as the owner, as controls.

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
| `createdAt` is preserved | It stays as the application-written audit value and keeps its other uses (activation-epoch comparisons, history); it is no longer an age authority. Existing comparisons of `createdAt` with activation timestamps are unchanged by this revision and listed as an audit item in section 11. |

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

## 5.3 Database invariants C3B.2 adds (new forward-only migration, proposed) **[R3]**

All new or replaced routines restate the trusted `search_path = pg_catalog, public, pg_temp` (C3A function-level
requirement, enforced by the static migration test and the C3B.1 preflight manifest; the manifest must be
regenerated in the same change, from a freshly migrated disposable database, never from the database assessed).

* **`external_signal_broker_consumption_guard`** (replaced, `BEFORE INSERT`): takes the §6 locks **itself**, in
  explicit single-table statements in canonical order, so correctness never depends on the caller having
  pre-locked (R-6) nor on `FOR UPDATE OF a,b,c` ordering (§6.1). It performs the checks below and **stamps**
  `authorizedAt` and `authorizationDeadlineAt`.
* **`external_signal_dispatch_fence_bump`**, `ExternalSignalDispatchFence`, the consumption `AFTER` self-verification and the
  shared `external_signal_broker_evidence_marked_intents` key (§3.4).
* **`Signal.receivedAt`**, its guard and `external_signal_signal_receipt_remaining` / `…_open` (§3.5).
* **Replaced lock modes [R4]**: `external_signal_broker_worker_claim_guard` takes `ta,tas,sub,sec` `FOR SHARE`; the
  `ExternalSignalEntryExecutionAuthorization` guard takes `FOR SHARE OF tas,ta,s,u` (§6.7). Both keep their other logic.
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
   `BrokerOrder`, `BrokerActivity` **under the shared identity key of §3.4.6 [R4]** (not `orderIntentId` alone) or
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
| H3 | `ExternalSignalTradeCycleAccount_parent_lock` locks the parent **cycle after the account-cycle row**; EXIT correlation and entry recovery lock cycle then account cycle. A writer that updates an account cycle without first locking its cycle inverts them. | Existing trigger | C9 |
| H4 | Planner-ordered multi-table `FOR UPDATE OF` in the claim guard, admission and the authorization guard. | Existing | C1 |
| H5 | The claim transaction takes the exposure advisory **after** the claim guard; recovery takes it before the intent. | Existing (rev-3 6.4, unchanged) | section 6.6 |

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
4. **Writers of `TradingAccountSubscription`/account cycle** (H3): lock the cycle (row 8) before the account cycle (row 9);
   an audit of every account-cycle writer is a proof obligation.
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

* The section 6.7 lock corrections (claim guard, authorization guard and grant, admission statement, account-cycle writers)
  with their probes re-run against the real services.
* The section 6.6 worker-claim path correction (explicit pre-locks, exposure advisory before the insert) and its probes.
* The C3B.1 migration applied to development by the product owner and the preflight green on the real runtime identity.

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

## 11. Revision-4 summary: corrections, remaining proof obligations and recommended C3B.2 scope **[R4]**

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
