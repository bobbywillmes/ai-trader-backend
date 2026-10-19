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
   exists (a consumed dispatch authorization, adapter-dispatch, response, rejection or
   uncertainty events, or a BrokerOrder). A lookup miss alone is never proof that an
   earlier uncertain submission did not reach Alpaca.
5. `prepareEntryBrokerDispatch`: the broker-time decision (section 3). It commits
   before any broker I/O.
6. Best-effort compare-only opportunity capture (unchanged, non-authoritative).
7. `authorizeDispatch`: single-use consumption of the ALLOWED decision with a fresh
   PostgreSQL clock (section 5). This is the last step before the adapter.
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
| `NOT_DISPATCHED` | Absence confirmed, no local dispatch evidence, authorization not consumed | **Definite non-send**: never-submitted checks release the claim |
| `EXISTING_ORDER_FOUND` | An exact broker order exists | Delivered; recovery, never re-sent |
| `DISPATCH_STARTED` | Authorization consumed; the adapter may have reached Alpaca | Existing classification (uncertain, rejected, not sent) |
| `BROKER_RESPONDED` | Alpaca confirmed the order | Existing materialization |

A market-policy refusal (`MarketPolicyBrokerDispatchRefusedError`) can only occur in
`NOT_DISPATCHED`, so it is always a definite non-send. Authoritative denials set the
intent to `blocked` with `MARKET_POLICY_BROKER_TIME:<OUTCOME>:DEFINITELY_NOT_SENT:<reason>:decision=<id>`
and count as healthy domain outcomes. Technical guard failures set `failed` with the
same prefix and count as failures for account health. In both cases the existing
`releaseUnsubmittedEntryExposureClaim` checks decide whether the claim is released,
and those checks now also treat a dispatch consumption as broker evidence. A refusal-shaped
error in any other phase, or any unclassified exception, is never treated as a
definite non-send.

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
the authorization `FOR SHARE`, so it cannot invert against these writers. The account
lifecycle-mutation workflow lock still wraps the whole worker tick.

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
with Alpaca stubbed at the adapter. Unit coverage lives in
`place-order.service.test.ts` (phase ordering and refusal), `order.worker.test.ts`
(classification), and `market-policy-broker-dispatch.architecture.test.ts`.
