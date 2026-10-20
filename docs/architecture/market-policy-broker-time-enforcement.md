# Market-Policy Broker-Time Enforcement (Phase 3C.3)

Phase 3C.3 adds the second authoritative Market Intelligence enforcement boundary:
immediately before a genuinely new Alpaca BUY entry POST. Phase 3C.2 decides whether
an enforced PAPER entry may become an `OrderIntent` and freezes an obligation with it.
Phase 3C.3 consumes that obligation. It is not a TradingView integration (4A/4B), it
grants no LIVE authority, and it never gates exits.

Acceptance contract: for an enforced PAPER OrderIntent with a frozen obligation, no
genuinely new broker BUY POST can occur without a fresh, authoritative ALLOWED
broker-time decision on the exact frozen policy revision, using sufficiently current
evidence and the required authorization state. Already-delivered broker orders stay
recoverable and managed despite later market or authorization changes.

A frozen ALLOWED admission is historical authorization evidence. It is not a
permanent broker submission permit.

## 1. Where the guard runs

`submitOrderToBroker` (`src/services/place-order.service.ts`) is the only entry BUY
broker boundary, and the only caller of `prepareEntryBrokerDispatch`
(`src/services/market-policy-broker-dispatch.service.ts`). An architecture test
enforces this. The order is:

1. `requireExecutableEntryExposureClaim`: the exact active claim, intent, account,
   Security, symbol, side and stable client order ID.
2. Stable client-order-ID lookup (`getAlpacaOrderByClientOrderId`).
3. **Existing order found:** account (per-account credentials), client order ID,
   canonical symbol and side are verified. The order is recovered and materialized
   by the existing worker path. There is no market-policy re-gating, no decision and
   no second POST. A mismatch is never guessed: it raises
   `EXISTING_BROKER_ORDER_IDENTITY_MISMATCH` and stays delivery-uncertain.
4. **Confirmed absence:** the boundary also requires that no local dispatch evidence
   exists (a consumed dispatch authorization, a final un-enforced dispatch
   authorization, adapter-dispatch, response, rejection or uncertainty events, or a
   BrokerOrder). A lookup miss alone is never proof that an earlier uncertain
   submission did not reach Alpaca.
5. `prepareEntryBrokerDispatch`: the broker-time decision (section 3). It commits
   before any broker I/O.
6. Best-effort compare-only opportunity capture (unchanged, non-authoritative).
7. `authorizeDispatch`, the last step before the adapter. A frozen obligation
   consumes its ALLOWED decision with a fresh PostgreSQL clock (section 5). An
   un-obligated PAPER entry records its final serialized non-enforced authorization or
   is quarantined (section 5a). LIVE keeps its own write controls in the adapter.
8. Adapter POST.

Stale-submission recovery (`recoverStaleSubmittingIntentsForAccount`) applies the same
exact identity verification before materializing an order it finds by client order ID.
It never consults market policy: delivered orders, fills, positions and protective
exits continue even after the authorization was revoked.

Stable client-order-ID construction is unchanged.

## 2. Delivery classification

`submitOrderToBroker` advances an `EntryBrokerSubmissionBoundary` that the worker
passes in, replacing the old blanket `brokerBoundaryStarted` flag:

| Phase | Meaning | Worker treatment of a failure |
|---|---|---|
| `UNCLASSIFIED` | Claim check, lookup in flight or failed, or prior dispatch evidence | Existing conservative path: `DELIVERY_UNCERTAIN`, claim `UNRESOLVED` |
| `NOT_DISPATCHED` | Absence confirmed, no local dispatch evidence, final authorization not committed | **Definite non-send**: never-submitted checks release the claim; a refusal is recorded, never swallowed |
| `EXISTING_ORDER_FOUND` | An exact broker order exists | Delivered; recovery, never re-sent |
| `DISPATCH_STARTED` | Dispatch record committed (consumption or un-enforced authorization); the adapter may have reached Alpaca | Outcome recorded on the claim, which moves to `UNRESOLVED`; release only by evidence-based recovery (section 5b) |
| `BROKER_RESPONDED` | Alpaca confirmed the order | Existing materialization |

A market-policy refusal (`MarketPolicyBrokerDispatchRefusedError`) can only occur in
`NOT_DISPATCHED`, so it is always a definite non-send. Authoritative denials set the
intent to `blocked` with `MARKET_POLICY_BROKER_TIME:<OUTCOME>:DEFINITELY_NOT_SENT:<reason>:decision=<id>`
and count as healthy domain outcomes. Technical guard failures set `failed` with the
same prefix and count as failures for account health. In both cases the existing
`releaseUnsubmittedEntryExposureClaim` checks decide whether the claim is released,
and those checks also treat a dispatch consumption or an un-enforced dispatch record as
broker evidence. The shared boundary also reads the intent delivery classification and
claim outcome events: `BROKER_REJECTED`, `DELIVERY_UNCERTAIN`, or an unknown outcome
cannot be released merely because no durable dispatch row exists. If a genuine domain
evidence conflict refuses release, the claim moves to `UNRESOLVED` with an
`UNSUBMITTED_RELEASE_REFUSED` event and a system event; the refusal is never
swallowed. A transient database/pool failure or unknown infrastructure failure keeps
the prior recoverable claim state for retry. A refusal-shaped error in any other phase,
or any unclassified exception, is never treated as a definite non-send.

`EntryDispatchRecordedNotSentError` is the one `NOT_DISPATCHED` failure that leaves a
dispatch record behind: the consumption or un-enforced authorization committed, but its
acknowledgement was lost. This attempt never invoked the adapter, yet the record still
prohibits any further POST. The intent becomes `failed` with
`ENTRY_DISPATCH_RECORDED_NOT_SENT:<record>:<id>`, and the claim goes to evidence-based
recovery (section 5b).

## 3. Broker-time decision semantics

### Frozen obligations (enforced regardless of the rollout)

For an intent with an `OrderIntentMarketPolicyEnforcementObligation`, every new
dispatch opportunity requires, in order (the first failing check is the outcome):

| Check | Refusal outcome |
|---|---|
| Intent, claim and request identity equal the obligation; intent `submitting`, claim `ENTRY_SUBMITTING` | `ENTRY_IDENTITY_MISMATCH` |
| Frozen revision is still the Strategy's ACTIVE revision | `POLICY_REVISION_SUPERSEDED` |
| Frozen authorization not `REVOKED` | `AUTHORIZATION_REVOKED` |
| Frozen authorization not `INVALIDATED` (owner lapse opt-out does not apply) | `AUTHORIZATION_INVALIDATED` |
| Frozen authorization is still the assignment's latest | `AUTHORIZATION_SUPERSEDED` |
| Frozen fingerprint and authority version unchanged | `AUTHORIZATION_INEFFECTIVE` |
| Frozen enrollment generation ACTIVE | `ENROLLMENT_GENERATION_INACTIVE` |
| Locked disposition `ENFORCED` (all 3C.2 identity checks) | `AUTHORIZATION_INEFFECTIVE` |
| Current assignment binding equals the obligation | `ENTRY_IDENTITY_MISMATCH` |
| Fresh evaluation of the **frozen** revision | `ALLOWED`, `BLOCKED`, `INSUFFICIENT_EVIDENCE` |

- The `OWNER_REVOKED` and `OWNER_OPTED_OUT` "return to non-enforced behavior"
  semantics govern future admission only, never delivery of an earlier enforced
  obligation.
- A newer policy revision or authorization is never substituted. A decision always
  records the frozen revision and authorization, and PostgreSQL rejects any other.
- The runtime rollout is recorded (`rolloutEnabled`, `rolloutVersion`) but not
  consulted. Deactivation neither erases nor bypasses an obligation.

### Fresh evaluation

`evaluateMarketPolicyRevisionOnCurrentComposition` is shared with 3C.2 admission. It
evaluates the frozen revision's five REQUIRED/IGNORED rules with
`evaluateStrategyMarketEligibility` against the current committed
`MARKET_REGIME_COMPOSITION_V1` (`SUCCEEDED`, `observedAt <= evaluatedAt`, ordered by
`targetAt`, `observedAt`, `id`). It uses exact source identities and algorithm
versions, and rechecks source health and expiry at a PostgreSQL `evaluatedAt`. FAILED
and other-version compositions are never selected. There are no provider calls and
no reuse of shadow decisions, comparison attempts or the admission's ALLOWED. ALLOWED
requires a bounded future `validUntil`. A technical failure fails closed and never
falls back to the admission decision.

### Legacy queued intents (no obligation)

Existing behavior is preserved unless **all** of the following hold: the PAPER
rollout is active, the intent has no obligation, and the assignment's current
disposition requires enforcement (`ENFORCED`, `AUTHORIZATION_INEFFECTIVE` or
`LAPSED`). The intent is then quarantined with an immutable
`LEGACY_UNOBLIGATED_QUARANTINED` decision and set to `blocked`. Its claim is released
only through the never-submitted checks. No ALLOWED admission is invented, and
nothing is deleted. This covers entries queued while the rollout was inactive,
entries queued under `NEVER_AUTHORIZED` before a grant, and entries admitted
concurrently with activation or a grant. A new grant therefore never makes a
previously queued, ungated BUY executable. Never-authorized, owner-revoked and
owner-opted-out assignments keep existing behavior.

This early check runs at preparation, before opportunity capture. It is advisory: the
authoritative decision is the final authorization immediately before the adapter
(section 5a), which re-decides the same disposition under locks.

Delivery-uncertain and already-delivered intents never reach the guard; they stay in
the existing recovery pathway. LIVE accounts are not applicable. SELL orders,
protective orders (including a short-cover BUY), close-position and recovery never
call the guard (architecture test).

## 4. Immutable decision model

`MarketPolicyBrokerDispatchDecision` (+ five `MarketPolicyBrokerDispatchGate` rows
when a composition was evaluated) is separate from the `COMPARE_ONLY` broker
opportunity and comparison evidence, which is unchanged. It records the OrderIntent
and obligation; account, assignment, Subscription, Strategy and canonical Security;
the frozen authorization ID, fingerprint, version and its status at decision time;
the frozen revision and generation; the decision version, `evaluatedAt`,
`validUntil` and `dispatchExpiresAt`; the composition, source-set fingerprint and
health; outcome and reason; the stable client order ID; a per-intent
`dispatchSequence`; the observed rollout state; and a `dispatchDisposition`
(`DISPATCH_AUTHORIZED`, `DEFINITELY_NOT_SENT`, `NOT_SENT_TECHNICAL_FAILURE`).

PostgreSQL enforces:

- Immutability of decisions, gates and consumptions. Decisions are PAPER-only and
  only for entry BUY intents (`order_intent_is_entry_buy`). The per-intent sequence
  must be contiguous.
- CHECKs: ALLOWED ⇔ `DISPATCH_AUTHORIZED`; obligation-bound outcomes carry the full
  V2 identity; ALLOWED carries composition, `validUntil > evaluatedAt`, and
  `evaluatedAt < dispatchExpiresAt <= validUntil`; only TECHNICAL_FAILURE has a
  diagnostic.
- On insert: the exact observed rollout state, evaluation inside the inserting
  transaction (`market_policy_evaluated_in_current_transaction`), and an exact mirror
  of the frozen obligation. For ALLOWED it also requires the frozen authorization
  AUTHORIZED, latest and locked `FOR SHARE`; generation and revision ACTIVE; an
  unchanged assignment binding; a committed composition observed before evaluation;
  unexpired validity; `dispatchExpiresAt = LEAST(validUntil, evaluatedAt + 30s)`; the
  executable claim; and no earlier consumption.
- Deferred, at commit: five gates per evaluated decision, the frozen revision's
  five-dimension REQUIRED/IGNORED contract (`validUntil` = earliest REQUIRED
  expiration), and an unclosed dispatch window.

Denials and quarantines commit before the worker treats the attempt as safely denied.
TECHNICAL_FAILURE decisions are recorded best-effort after the failed transaction
rolled back; losing that evidence never permits a POST. Owner reads:
`listAssignmentMarketPolicyBrokerDispatchDecisions`.

## 5. Dispatch authorization and the linearization point

`MarketPolicyBrokerDispatchConsumption` is inserted as a single-statement transaction
immediately before the adapter call. Its trigger rechecks, with `clock_timestamp()`:

- The decision is ALLOWED and is the latest decision of the intent.
- The frozen authorization (locked `FOR SHARE`) is still AUTHORIZED, latest and
  fingerprint-equal.
- The generation and revision are ACTIVE and the binding is unchanged.
- The intent is `submitting` with an `ENTRY_SUBMITTING` claim.
- The dispatch window is still open.

It then stamps `consumedAt`. Unique indexes allow one consumption per decision **and
per OrderIntent**: once dispatch has started, uncertainty is resolved only by
stable-ID recovery, never by another POST.

The **commit of the consumption is the authorization-to-dispatch linearization
point**. A revocation, invalidation, supersession or newer grant that commits before
it refuses the POST. A revocation that commits after it cannot recall the in-flight
external request. That is the documented residual race: PostgreSQL and Alpaca are not
atomic, and the order then follows normal recovery and management.

If consumption is refused (window expired, authorization changed, superseded), nothing
was sent. The guard re-evaluates exactly once with fresh evidence, appending a new
decision that also closes the refused one (superseded decisions are unconsumable). It
then consumes the fresh ALLOWED decision or refuses. A crashed or abandoned
preparation is never a reusable permission: it expires within 30 seconds, is closed by
any later decision, and is unconsumable once stale-submission recovery fails the
intent.

No transaction is held across Alpaca I/O.

A consumption is evidence that a POST **may** have started. It is never proof of broker
receipt, and it is never deleted, relaxed, cleared or reused. It prohibits another POST
for that OrderIntent permanently, including after a broker lookup miss, a process
restart, or the release of the claim.

## 5a. Final un-obligated dispatch authorization (Hermes MEDIUM-1)

An un-obligated PAPER entry (no frozen obligation) gets a real final authorization in
`authorizeDispatch`, after compare-only opportunity capture and immediately before the
adapter. One short READ COMMITTED transaction:

1. locks the runtime rollout row `FOR SHARE`;
2. resolves and locks the assignment identity and latest authorization in the
   established order (account, assignment, Subscription and Security `FOR KEY SHARE`,
   then the latest authorization `FOR SHARE`; an intent without an assignment locks its
   Security by symbol `FOR KEY SHARE`);
3. takes the `entry-exposure:<account>:<security>` advisory lock;
4. revalidates the exact intent, account, Security, stable client order ID, the
   `ENTRY_SUBMITTING` claim, the absence of an obligation, and the absence of any prior
   dispatch record;
5. re-decides the disposition. If the rollout is active and the disposition requires
   enforcement (`ENFORCED`, `AUTHORIZATION_INEFFECTIVE`, `LAPSED`), it appends a
   `LEGACY_UNOBLIGATED_QUARANTINED` decision with reason
   `UNOBLIGATED_ENTRY_UNDER_<disposition>_AT_FINAL_AUTHORIZATION` and refuses (a
   definite non-send). Otherwise it inserts the immutable
   `MarketPolicyBrokerUnenforcedDispatch` record and commits.

The record's `basis` is `RUNTIME_INACTIVE`, `NEVER_AUTHORIZED`, `OWNER_REVOKED`,
`OWNER_OPTED_OUT` or `NO_ASSIGNMENT`, with the observed rollout state and latest
authorization. Its PostgreSQL trigger re-checks everything independently: PAPER entry
BUY identity, no obligation or consumption, an executable intent and claim, the exact
rollout state (`FOR SHARE`), and the exact latest authorization (`FOR SHARE`). It
refuses the insert with `UNENFORCED_DISPATCH_ENFORCEMENT_REQUIRED` when enforcement now
applies. One record exists per OrderIntent, and records are immutable.

**Linearization point:** the commit of the final authorization. A grant, re-grant or
activation that commits before it quarantines the entry. That covers `NEVER_AUTHORIZED`
becoming `AUTHORIZED`, an inactive rollout becoming active with an effective
authorization, and `OWNER_REVOKED` or `OWNER_OPTED_OUT` followed by a new grant. Grant,
revoke and lapse resolution take the assignment `FOR UPDATE` and so wait behind the
final authorization's `KEY SHARE`; activation takes the rollout `FOR UPDATE` and waits
behind its `FOR SHARE`.

**Residual race:** a grant or activation that commits after the final authorization
cannot recall the subsequent in-flight external POST. The order is then managed
normally. PostgreSQL and Alpaca are not atomic, and no transaction is held across Alpaca
I/O.

Automatic invalidation stays fail-closed (`LAPSED` requires enforcement). Runtime
deactivation and deliberate owner opt-out apply the defined non-enforced semantics.
Already-delivered broker orders are recovered without re-gating. Frozen obligations keep
the single-use consumption. LIVE keeps its existing authorization and broker-write
behavior. Protective exits remain outside the guard.

Like a consumption, the un-enforced record is durable dispatch-start evidence. It is
never proof of receipt, and it permanently prohibits another POST for the intent.

## 5b. Claim recovery after a dispatch record (Hermes HIGH-1)

`src/services/entry-dispatch-recovery.service.ts` owns recovery of EntryExposureClaim
ownership once a dispatch record exists. Dispatch records are a consumption, an
un-enforced dispatch authorization, or best-effort dispatch telemetry. Ordinary
`releaseUnsubmittedEntryExposureClaim` still refuses any such claim.

### Outcome recording

Every failure after a dispatch record is recorded as an immutable
`DISPATCH_OUTCOME_RECORDED` claim event, and the claim moves to `UNRESOLVED`, which is
non-executable and visible. A terminal `failed` intent never hides a stuck
`ENTRY_SUBMITTING` claim. The event carries the classification, HTTP status, source,
client order ID, consumption, decision and un-enforced record IDs, and a
`deliveryProof`. Claim events are append-only at the database boundary. Repeated
observations with unchanged evidence append nothing.

| Case | Classification | Intent | Claim | Release |
|---|---|---|---|---|
| A. Adapter-local guard before `fetch` (`NOT_SENT_BLOCKED`, `NOT_SENT_RETRYABLE`) | `NOT_SENT_LOCAL_*` | `failed` | `UNRESOLVED`, then a verified release is attempted immediately | Automatic after fresh verification |
| B. HTTP rejection with a definitive status (400, 401, 403, 404, 422, 429) | `BROKER_REJECTED` with status | `failed` | `UNRESOLVED` | Automatic, only after a 60 s settle window and fresh verification |
| B'. Any other 4xx (for example 408, 409) | `BROKER_REJECTED` with status | `failed` | `UNRESOLVED` | Never; treated as delivery-uncertain |
| C. 5xx, network, timeout, or unclassified after dispatch | `DELIVERY_UNCERTAIN` | `failed` | `UNRESOLVED` | Never on absence; operator investigation |
| D. Crash between the record and the adapter (stale recovery) | `DISPATCH_OUTCOME_UNKNOWN` | `failed` (`DISPATCH_STARTED_OUTCOME_UNKNOWN`) | `UNRESOLVED` | Never on absence; operator investigation |
| E. Record committed, acknowledgement lost | `NOT_SENT_DISPATCH_RECORD_ACK_LOST` | `failed` (`ENTRY_DISPATCH_RECORDED_NOT_SENT`) | `UNRESOLVED`, then a verified release is attempted immediately | Automatic after fresh verification |

In every case the consumed or recorded intent is never retried as a new POST.
`assertNoLocalEntryDispatchEvidence` and the unique records block it even if an
operator requeues the intent. A record from an earlier attempt never produces a new
classification: only a failure inside this attempt's final authorization (after the
boundary confirmed no prior record) can be a lost acknowledgement.

Cases A and E rely on in-process knowledge that this attempt never sent the request: the
adapter threw before `fetch`, or the record insert never returned. A 4xx is a broker
response, not an adapter-local non-send. It qualifies for release only with a definitive
status, after the settle window, and with full verification, because a 4xx alone does
not prove that no order exists (a duplicate client-order-ID rejection, for example,
implies that one does). The settle window is a minimum before verification counts. It is
never a timeout after which ownership disappears.

### Evidence standard for release

`releaseDispatchedEntryExposureClaim` releases only when all of the following hold:

- **Identity:** the claim, OrderIntent, account, canonical Security and stable client
  order ID match each other, the consumption and its decision, and the un-enforced
  record.
- **Recorded basis:** every recorded outcome is a definite local non-send or a
  definitive, settled rejection. Any uncertain outcome makes absence ambiguous,
  whatever a later lookup returns.
- **Fresh broker verification:** the exact stable client-order-ID lookup finds no order,
  the complete paginated open-BUY inventory for the account and Security is empty
  (incomplete or inconsistent pagination fails), and there is no broker position. An
  order found by client ID routes to the existing terminal broker-order remediation
  (`releaseConfirmedTerminalEntryClaim`), which performs replacement-chain and fill
  reconciliation.
- **Local verification:** the intent is terminal. There is no BrokerOrder or
  BrokerActivity for the intent, no attached or active TrackedPosition, no local
  executable BUY for the account and Security, and no unattributed BUY fill for the
  Security since dispatch started.
- **Final revalidation** under the `entry-exposure:<account>:<security>` advisory lock:
  claim status, intent status, local exposure and the recorded outcomes are unchanged.
  The release is then a compare-and-set to `RELEASED` with reason
  `VERIFIED_DISPATCH_NO_EXPOSURE:<basis>`, plus an immutable
  `RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE` event carrying the full evidence and its
  fingerprint.

The consumption and the un-enforced record are retained unchanged. A release only lets a
later, genuinely new admission with a new client order ID pass normal entry controls.
The original OrderIntent is never reactivated or resent.

Where the APIs cannot conclusively establish absence after a possibly delivered order
(cases B', C and D), the claim is retained. Remediation reports `AMBIGUOUS_ABSENCE` with
investigation guidance. There is no force release, no direct-SQL workaround, and no
time-based expiry of ownership.

### Recovery sweep

`recoverDispatchedEntryClaimsForAccount` runs inside stale-submission recovery under the
account lifecycle-mutation lock. Each tick it takes at most three claims of terminal
intents (oldest `lastDiagnosedAt` first), each at most once per 60 seconds:

- `ENTRY_PENDING` or `ENTRY_SUBMITTING` claims without a dispatch record go through the
  never-submitted release only when recorded evidence explicitly proves a local
  pre-dispatch non-send. Missing rows, terminal status, lookup 404s and elapsed time are
  never proof by themselves.
- Claims with a dispatch record but no recorded outcome (claims from before this
  correction) get an outcome inferred from the intent's recorded block reason.
- `UNRESOLVED` claims with a dispatch record get an evidence-based release attempt.

Every attempt marks the claim diagnosed, so blocked claims rotate instead of starving
others. A blocked attempt appends a `DISPATCH_RECOVERY_RELEASE_BLOCKED` diagnostic only
when the evidence changed. Stale recovery itself recognizes a dispatch record before it
fails a `submitting` intent: a single lookup miss records `DISPATCH_OUTCOME_UNKNOWN` and
retains the claim instead of releasing it as never submitted.

The `submitted_orders` account enumerator independently counts due terminal claims, so
an otherwise idle account remains eligible. Credential checks, the lifecycle-mutation
lock, the three-claim batch, 60-second retry interval and oldest-first ordering remain
unchanged. Readiness reports `systemRecovery=PROCESSED` only after recovery evidence
exists; an unprocessed due or waiting claim is `ELIGIBLE_OR_WAITING`, not `SWEPT`.

## 6. Lock ordering

Preparation uses the 3C.2 admission order in one short READ COMMITTED transaction:

1. `MarketPolicyEnforcementRuntimeRollout` `FOR SHARE` (recorded, not authoritative for obligations)
2. `TradingAccount`, `TradingAccountSubscription`, `Subscription`, `Security` `FOR KEY SHARE`
3. Latest authorization `FOR SHARE`
4. `entry-exposure:<account>:<security>` transaction advisory lock
5. Reads and decision/gate inserts; commit

Revoke, grant, lapse resolution and enrollment disable take the assignment `FOR UPDATE`
first and wait. Revision supersession and the identity triggers update the
authorization and wait at step 3. Rollout changes wait at step 1. Consumption takes only
the authorization `FOR SHARE`, so it cannot invert against these writers. The final
un-obligated authorization uses the same order as preparation. Evidence-based release
takes only the advisory lock, after its broker reads. The account lifecycle-mutation
workflow lock still wraps the whole worker tick.

## 7. Pre-activation inventory and lapse report

`assessMarketPolicyBrokerEnforcementReadiness`
(`src/services/market-policy-broker-readiness.service.ts`) is read-only. It is
available as `npm run market-policy:broker-readiness` (exit code 2 when review is
required) and as `GET /api/market-policy-enforcement/broker-time-readiness`
(SYSTEM_OWNER). It lists every PAPER entry BUY in received, pending, submitting,
broker-active or uncertain states with:

- account, assignment, stable client order ID and status;
- obligation presence and assignment disposition;
- broker delivery classification (`NOT_DISPATCHED`,
  `DISPATCH_IN_PROGRESS_OR_UNCERTAIN`, `DELIVERY_UNCERTAIN`,
  `BROKER_ORDER_DELIVERED`);
- the broker-time treatment it will receive.

It also lists unresolved lapses (Hermes L5), flagging V1 grants invalidated with
`AUTHORITY_BINDING_REAPPROVAL_REQUIRED`. `activationGuard` summarizes what the owner
must review. Liquidation of existing positions is never required.

Terminal intents (`failed`, `blocked`, and similar) whose claims remain unreleased are
always inventoried, with `terminalWithUnreleasedClaim` and the claim, consumption,
decision and un-enforced record IDs. They add the activation reason
`TERMINAL_ENTRIES_WITH_UNRELEASED_CLAIMS`.

The entry-exposure readiness report (`assessEntryExposureReadiness`,
`npm run entry-exposure:readiness`) carries the fail-closed database blocker
`terminalIntentsWithUnreleasedClaims`. Each item lists the account and canonical
Security; the intent and claim IDs and statuses; the consumption ID and dispatch
decision; the stable client order ID; the recorded delivery classification; the release
basis and conclusiveness; the last recovery result; and operator remediation
eligibility (`ELIGIBLE_AFTER_FRESH_VERIFICATION`, `PENDING` or `BLOCKED`) with the
blocker reason. A terminal intent with a held claim never drops out of operator
attention just because stale recovery selects only `submitting` intents.

## 7a. Operator remediation of a dispatched entry

`npm run entry-exposure:remediate -- --claim <id> --actor-user-id <owner>` uses
`src/services/entry-exposure-remediation.service.ts`. A claim whose intent has a dispatch
record and no broker order gets the disposition `DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE`
instead of the old `BROKER_ORDER_NOT_ESTABLISHED` blocker. The preview shows the exact
intent, claim, consumption, decision and un-enforced record identities; the recorded
classification; the local and broker evidence; the conclusiveness (`CONCLUSIVE`,
`PENDING`, `AMBIGUOUS_ABSENCE` or `CONTRADICTED`); every blocker; and investigation
guidance when the evidence is not conclusive.

`--apply --confirm <fingerprint>` requires an enabled SYSTEM_OWNER. It re-runs the fresh
broker verification, requires the exact fingerprint (any change in evidence refuses),
revalidates under the lock, and appends immutable `OPERATOR_REMEDIATION_AUTHORIZED` and
`RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE` events. It applies the same evidence standard as
the automatic sweep, and refuses on any broker position, executable BUY, unaccounted
fill, incomplete pagination, identity mismatch or ambiguous absence.

The existing terminal broker-order and closed adopted-position dispositions are
unchanged, except that the terminal disposition now also refuses a broker order whose
client order ID, symbol or side contradicts the claim. Remediation never places, cancels
or requeues an order, and creates no execution authority.

## 8. Phase 3C.2 follow-up corrections

- **L1:** the deferred admission verify rejects an admitted ALLOWED attempt whose
  `validUntil` passed before commit.
- **L2:** `evaluatedAt` (milliseconds) is compared with
  `date_trunc('milliseconds', transaction_timestamp())` via
  `market_policy_evaluated_in_current_transaction`.
- **L3:** the deferred backstop classifies entries with `order_intent_is_entry_buy`. A
  BUY bound to a tracked position and not declared an entry (protective short cover) is
  exempt; every other BUY still needs an obligation.
- **L4:** `ALLOWED`, `orderIntentCreated = false` evidence is preserved but can never
  back an obligation, and broker-time authority derives only from obligations.
- **L5:** the readiness report's `unresolvedLapses`.
- **L6:** deterministic tests for invalidation before locking, grant versus a legacy
  admission, activation and deactivation versus admission, AUTHORIZATION_INEFFECTIVE,
  BLOCKED signal entries, and FAILED, wrong-version and superseded compositions. An
  admission whose disposition is lapsed or ineffective now records that durable
  rejection even when the request symbol also drifted, instead of a technical failure.

## 9. Tests

`src/db/__tests__/market-policy-broker-time-enforcement.integration.test.ts`
(`RUN_DATABASE_INTEGRITY_TESTS=1`) replays the real migration chain, including a
pre-existing V1 grant, and drives the real order worker into `submitOrderToBroker`
with Alpaca stubbed at the adapter. Its correction block covers the final un-obligated
authorization races (grant, activation, re-grant after revocation or opt-out, and the
post-commit residual race under real lock contention) and post-consumption outcomes
(definitive and non-definitive 4xx, local non-send, uncertain delivery, crash before the
adapter, lost consumption acknowledgement, readiness, fingerprinted remediation and its
refusals, and a new admission after release). Unit coverage lives in
`place-order.service.test.ts` (phase ordering and refusal), `order.worker.test.ts`
(classification and recovery routing), and
`market-policy-broker-dispatch.architecture.test.ts`.
