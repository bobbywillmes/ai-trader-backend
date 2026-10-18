# Market-Policy Pre-Intent Enforcement (Phase 3C.2)

Phase 3C.2 makes the first authoritative Market Intelligence decision before a new
BUY `OrderIntent` is created. It applies only to an explicitly authorized PAPER
assignment, and only while a separate, default-disabled PAPER runtime rollout is
active. It does not implement broker-time enforcement (Phase 3C.3), executable
TradingView entry routing (4A), or exit execution (4B), and it grants no LIVE
authority.

Acceptance contract: an explicitly authorized PAPER assignment, under an explicitly
activated runtime rollout, cannot create a new BUY OrderIntent unless its exact bound
Market Intelligence policy evaluates `ALLOWED` on current, trustworthy evidence. A
blocked or uncertain enforced request produces durable evidence and no OrderIntent.
An accepted request atomically freezes the exact authorization and policy obligation.

## 1. Security-bound authority (Hermes M1)

Phase 3C.1 grants bound account, assignment, Strategy, revision, generation, and
holder, but not the tradable instrument, and the assignment invalidation trigger was
column-scoped (`AFTER UPDATE OF "tradingAccountId", "routingStrategyId"`). Two
sequences therefore kept a grant effective after its instrument changed:

1. `UPDATE "TradingAccountSubscription" SET "subscriptionId" = <other>` — the
   `routingStrategyId`/`routingSecurityId` mirrors are re-derived by the BEFORE
   trigger, which a column-scoped trigger never sees.
2. `UPDATE "Subscription" SET "securityId" = <other>` — the composite foreign key
   cascades a new `routingSecurityId` into the assignment.

Resolution:

- New authority version `PAPER_MARKET_POLICY_ENFORCEMENT_V2` binds the exact
  `subscriptionId`, canonical `securityId`, and `securitySymbol`. A CHECK makes the
  binding mandatory for V2 and absent for historical V1 rows. New V1 inserts are
  rejected.
- The V2 fingerprint covers the binding. Its canonical serialization is implemented
  twice, in `enforcementAuthorizationFingerprint()` and in the PostgreSQL function
  `enforcement_authorization_fingerprint_v2`, and must stay byte-identical.
- Invalidation triggers are now row-level `AFTER UPDATE` triggers whose `WHEN`
  clauses compare the final row image, so direct updates, BEFORE-trigger
  derivation, and FK cascades all invalidate:
  - `TradingAccountSubscription`: account or Strategy change
    (`ASSIGNMENT_IDENTITY_CHANGED`), Subscription or routing Security change
    (`ASSIGNMENT_SUBSCRIPTION_CHANGED`).
  - `Subscription`: id, Strategy, Security, or symbol change
    (`SUBSCRIPTION_IDENTITY_CHANGED`).
  - `Security`: id or symbol change (`SECURITY_IDENTITY_CHANGED`).
- A grant also requires the Subscription symbol, routing Security, and canonical
  Security to agree (`SECURITY_IDENTITY_INCONSISTENT`). A redirected assignment can
  be authorized again only by a new explicit grant, which binds the new instrument.
- Existing V1 grants are never reinterpreted as Security-bound. The migration
  invalidates every effective V1 grant with `AUTHORITY_BINDING_REAPPROVAL_REQUIRED`
  (source `MIGRATION`), writing the normal immutable INVALIDATE event. Under the
  lapse contract these require reauthorization or an explicit owner opt-out.

### Authorization hardening

- PostgreSQL recomputes and verifies the fingerprint on every grant, so an arbitrary
  application-supplied fingerprint is never accepted as evidence.
- PostgreSQL stamps `authorizedAt`/`createdAt`, `revokedAt`, `invalidatedAt`,
  lapse `resolvedAt`, and rollout `changedAt`. Application-supplied timestamps are
  overwritten.
- Enabled-SYSTEM_OWNER checks lock the actor row `FOR SHARE` in the service and in
  the trigger. A concurrent disable or demotion waits for an in-flight grant or
  revoke. A grant committed before its granter is disabled stays historically valid.
- Every invalidation records `invalidationSource` (`ENROLLMENT_GENERATION_TRIGGER`,
  `POLICY_REVISION_TRIGGER`, `ACCOUNT_HOLDER_TRIGGER`, `ASSIGNMENT_TRIGGER`,
  `SUBSCRIPTION_TRIGGER`, `SECURITY_TRIGGER`, `MIGRATION`) and before/after evidence.
  The actor is recorded where authoritative (enrollment disable). Events carry the
  same provenance.
- Invalidation writes a `MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_INVALIDATED`
  System Event (WARNING) from the trigger in its own subtransaction. A System Event
  failure is swallowed: the immutable authorization event remains authoritative and
  the trading gate never depends on System Event delivery.

## 2. Lapse semantics (Hermes M3)

An assignment's enforcement disposition is derived from its latest authorization
row (by id) and an optional immutable owner lapse resolution:

| Latest authorization | Disposition | Entry behavior while the rollout is active |
|---|---|---|
| none | `NEVER_AUTHORIZED` | Existing behavior |
| `AUTHORIZED`, validates | `ENFORCED` | Market-policy enforced |
| `AUTHORIZED`, no longer validates | `AUTHORIZATION_INEFFECTIVE` | Fail closed |
| `INVALIDATED`, unresolved | `LAPSED` | Fail closed |
| `INVALIDATED`, owner resolved | `OWNER_OPTED_OUT` | Explicitly non-enforced |
| `REVOKED` | `OWNER_REVOKED` | Explicitly non-enforced |
| any, account not PAPER | `NOT_APPLICABLE_LIVE` | Existing behavior |

While the rollout is inactive every disposition keeps existing behavior.

- Explicit owner revocation is a deliberate return to non-enforced behavior. The UI,
  the System Event, and the immutable REVOKE event provenance
  (`EXPLICIT_RETURN_TO_NON_ENFORCED_BEHAVIOR`) state this.
- Every automatic invalidation, including enrollment disable, fails closed. A
  previously authorized assignment never silently becomes ungated because its policy
  revision, Security, holder, or enrollment identity changed. To keep enforcement
  through an intentional reconfiguration, revoke first.
- An invalidated grant is not a dead end. The SYSTEM_OWNER action `resolve-lapse`
  records an immutable `AssignmentMarketPolicyEnforcementLapseResolution`
  (`RESTORE_NON_ENFORCED`, reason, actor, PostgreSQL time) for the assignment's
  latest INVALIDATED authorization. It never restores authority and never changes a
  frozen obligation. Re-enrollment plus a new grant restores enforcement instead.
- A historical grant is not proof that enforcement must remain active forever.

## 3. Runtime rollout

`MarketPolicyEnforcementRuntimeRollout` is a PAPER-only singleton created disabled
(version 0). Activation and deactivation are separate SYSTEM_OWNER actions that
toggle state, advance the version by exactly one, and require a reason. PostgreSQL
rejects every other change, rejects deletes, and writes an immutable
`MarketPolicyEnforcementRuntimeRolloutEvent` per change. Activation is never
inferred from ACTIVE enrollments or AUTHORIZED grants.

| Operation | Method and path | Access |
|---|---|---|
| Status | `GET /api/market-policy-enforcement/runtime-rollout` | Admin boundary |
| Events | `GET /api/market-policy-enforcement/runtime-rollout/events` | SYSTEM_OWNER |
| Activate | `POST /api/market-policy-enforcement/runtime-rollout/activate` `{ expectedVersion, reason, confirmPaperOnlyTradingEffect: true }` | SYSTEM_OWNER |
| Deactivate | `POST /api/market-policy-enforcement/runtime-rollout/deactivate` (same body) | SYSTEM_OWNER |

Conflicts return 409 with `STALE_ROLLOUT_VERSION`, `ROLLOUT_ALREADY_ACTIVE`, or
`ROLLOUT_ALREADY_INACTIVE`. Status also appears in `GET /api/system-status` under
`trading.marketPolicyEnforcement` and in every authorization read as
`runtimeEnforcement`. Deactivation restores existing behavior immediately and
never alters frozen obligations.

## 4. Pre-intent admission lifecycle

`admitEntryOrderIntent()` (`src/services/market-policy-entry-admission.service.ts`)
is the single shared boundary through which `submitOrder` creates every BUY entry
OrderIntent, for both the API branch and the live acceptance branch. All BUY
producers (the order API, n8n subscription signals, lifecycle exercises, and live
acceptance) inherit it through `submitOrder`. An architecture test asserts that nothing else acquires
an entry claim or creates an entry intent.

Inside one READ COMMITTED transaction:

1. Run caller preparation (live acceptance run claiming).
2. Lock the rollout row `FOR SHARE`. If inactive, run the Phase 3C.0 claim admission
   unchanged.
3. Resolve the exact disposition with `resolveLockedAssignmentMarketPolicyEnforcement`
   under row locks (section 7). Non-enforced dispositions run the unchanged
   Phase 3C.0 admission.
4. Take the entry-exposure advisory lock and recover an existing lifecycle for the
   stable owner key (`entry:<account>:<clientOrderId>`) without a new decision.
5. `LAPSED` and `AUTHORIZATION_INEFFECTIVE` record a rejected attempt and stop.
6. Read the current committed composition: `MARKET_REGIME_COMPOSITION_V1`,
   `SUCCEEDED`, `observedAt <= evaluatedAt`, ordered by `targetAt`, `observedAt`,
   `id` descending (the Phase 3B capture order). `evaluatedAt` is PostgreSQL
   `clock_timestamp()` truncated to milliseconds. No provider calls are made.
7. Evaluate the exact bound revision with `evaluateStrategyMarketEligibility`: the
   five-dimension REQUIRED/IGNORED contract, required-source health, algorithm
   version, `VALID` status, and expiration rechecked at `evaluatedAt`. DEGRADED
   vectors are acceptable when every REQUIRED gate passes. Persisted shadow
   decisions are never read or written.
8. Missing composition (`NO_COMPOSITION`), an incomplete source vector
   (`COMPOSITION_INCOMPLETE`), and an ALLOWED result without a bounded future
   validity (`REQUIRED_EVIDENCE_VALIDITY_UNBOUNDED`) become `INSUFFICIENT_EVIDENCE`.
9. Non-ALLOWED outcomes persist the attempt and its five gates, commit, and only then
   raise the rejection.
10. ALLOWED acquires the EntryExposureClaim, creates the OrderIntent, persists the
    ALLOWED attempt and gates, and freezes the obligation, all in the same
    transaction.

After commit, the ordinary risk gate still runs. `ALLOWED` never bypasses account
limits, assignment state, LIVE/PAPER boundaries, or broker authorization. A
risk-blocked intent is marked `blocked`, its claim is released, and its obligation
remains as immutable history.

### Outcomes and codes

| Outcome | HTTP | `details.code` |
|---|---|---|
| ALLOWED | intent created | `marketPolicyEnforcement` on the result |
| BLOCKED | 403 | `MARKET_POLICY_BLOCKED` |
| INSUFFICIENT_EVIDENCE | 403 | `MARKET_POLICY_INSUFFICIENT_EVIDENCE` |
| AUTHORIZATION_LAPSED | 403 | `MARKET_POLICY_ENFORCEMENT_LAPSED` |
| AUTHORIZATION_INEFFECTIVE | 403 | `MARKET_POLICY_AUTHORIZATION_INEFFECTIVE` |
| Technical failure | 503 | `MARKET_POLICY_ENFORCEMENT_TECHNICAL_FAILURE` |

Rejection details include `attemptId`, `outcome`, `reasonCode`, the gates, and
`orderIntentCreated: false`. Signal entry records preserve these codes verbatim.
A technical failure rolls the whole admission back, records a `TECHNICAL_FAILURE`
attempt best-effort in a separate transaction (with stage and diagnostic), emits an
ERROR System Event, and fails closed. Evidence delivery failure never weakens the
gate. SELL orders, protective exits, and lifecycle reconciliation are never gated.

## 5. Immutable admission attempts

`MarketPolicyEnforcementAdmissionAttempt` (with five
`MarketPolicyEnforcementAdmissionGate` rows when a composition was evaluated) is
authoritative evidence, separate from the `COMPARE_ONLY` / `tradingEffect=NONE`
shadow and comparison tables, which are unchanged. It records request and
idempotency identity, account and assignment, Subscription and canonical Security,
Strategy, bound revision, enrollment generation, authorization ID, fingerprint and
version, composition ID, version, source-set fingerprint and health, `evaluatedAt`
and `validUntil`, outcome and reason, evaluator, admission and authority versions,
the rollout version (foreign key to its rollout event), and whether an OrderIntent
was created (`admissionResultCode`). ALLOWED attempts that lose the claim race are
recorded best-effort with `orderIntentCreated = false` and the claim conflict code.

PostgreSQL enforces:

- Immutability of attempts and gates, PAPER-only accounts, and outcome-shape CHECKs.
- On insert: the exact active rollout version; `evaluatedAt` within 60 seconds of
  PostgreSQL time; a mirror of the latest authorization of the assignment.
  `ENFORCED` outcomes also require an AUTHORIZED V2 grant whose binding equals the
  current assignment, an ACTIVE generation, an ACTIVE revision, and a committed
  composition observed before evaluation. An ALLOWED attempt must still be fresh,
  and an admitted attempt must match its OrderIntent and be evaluated in the same
  transaction.
- At commit (deferred): exactly five gates for an evaluated attempt. For ALLOWED,
  every REQUIRED rule of the bound revision must have passed on an AVAILABLE,
  `VALID`, unexpired composition source with an allowed effective state, and
  `validUntil` must equal the earliest required expiration. A forged ALLOWED is
  rejected even when the application is wrong.
- `GET .../enforcement-authorization/admission-attempts` (SYSTEM_OWNER) lists
  recent attempts with gates and obligations.

## 6. Frozen per-intent obligation

`OrderIntentMarketPolicyEnforcementObligation` is created with the ALLOWED attempt,
the OrderIntent, and the EntryExposureClaim in one transaction. It freezes the
authorization ID and fingerprint, authority, admission and evaluator versions,
enrollment generation, revision, Subscription and Security, composition and
source-set fingerprint, evaluation and validity times, rollout version, and a
frozen context. It is a durable per-intent obligation, not a pointer to the current
policy. PostgreSQL requires it to mirror its exact ALLOWED attempt, makes it
immutable, and requires its claim at commit.

A deferred OrderIntent backstop rejects, while the rollout is active, any PAPER BUY
intent whose assignment is enforced and that lacks an obligation for the current
authorization, and any PAPER BUY intent for a lapsed assignment. Never-authorized,
revoked, owner-resolved, LIVE, SELL, and rollout-inactive intents are unaffected.
Later revocation or invalidation never erases or weakens an obligation. Phase 3C.3
will consume it before genuinely new BUY broker submissions. The pending-order
worker, idempotency lookup, and broker POST boundary are unchanged in 3C.2.

## 7. Transaction and lock ordering

Entry admission, in order:

1. `MarketPolicyEnforcementRuntimeRollout` `FOR SHARE`
2. `TradingAccount` `FOR KEY SHARE`
3. `TradingAccountSubscription` `FOR KEY SHARE`
4. `Subscription` `FOR KEY SHARE`
5. `Security` `FOR KEY SHARE`
6. Latest authorization of the assignment `FOR SHARE`
7. `entry-exposure:<account>:<security>` transaction advisory lock
8. Inserts: OrderIntent, EntryExposureClaim, attempt, gates, obligation

Why this is deadlock-free against the other writers:

- Grant, revoke, lapse resolution, and enrollment disable take the assignment
  `FOR UPDATE` before anything else on the authorization. That conflicts with step 3,
  so they serialize at the assignment row.
- Holder and environment changes (a unique key on `TradingAccount`), Subscription
  identity changes, and Security symbol changes take key-level `FOR UPDATE` locks.
  These conflict with steps 2, 4, and 5, which admission takes before step 6. The
  writer either waits for admission to commit, or admission waits for the writer and
  then reads the invalidated row.
- Revision supersession and direct-SQL disable or revoke update the authorization
  row and wait on step 6. Admission needs only FK `KEY SHARE` on those rows, which
  does not conflict with their `NO KEY UPDATE` locks.
- Rollout activation locks the rollout row `FOR UPDATE` and waits for in-flight
  admissions.
- No other path takes the entry-exposure advisory lock before an authorization lock.

Revocation or invalidation therefore cannot commit between the authoritative
decision and OrderIntent creation. If an invalidation commits first, admission
re-reads the terminal row under READ COMMITTED and fails closed. Grant, revoke, and
lapse resolution remain SERIALIZABLE, and a serialization failure maps to 409
`CONCURRENT_AUTHORIZATION_CHANGE`.

## 8. Tests

`src/db/__tests__/market-policy-pre-intent-enforcement.integration.test.ts`
(`RUN_DATABASE_INTEGRITY_TESTS=1`) replays the real migration chain with a
pre-existing V1 grant and covers:

- V1 reapproval, default-disabled rollout, and owner-only versioned activation.
- Missing composition, BLOCKED, missing or expired REQUIRED sources with healthy
  IGNORED dimensions, DEGRADED-but-passing ALLOWED, and technical failure.
- A forged ALLOWED rejected by PostgreSQL, the risk gate after ALLOWED,
  stable-key retries, and competing Strategies for one Security.
- Revoke and invalidation blocked behind a paused in-flight admission.
- Lapse fail-closed and owner opt-out, explicit-revocation non-enforcement, and
  both M1 sequences plus Security symbol changes.
- Fingerprint and timestamp integrity, grant versus granter disable, revision and
  holder races, and revoke versus invalidate.
- Supersession preserving frozen obligations, LIVE non-applicability, compare-only
  immutability, and deactivation preserving obligations.
