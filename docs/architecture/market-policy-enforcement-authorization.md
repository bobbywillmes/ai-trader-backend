# Market-Policy Enforcement Authorization (Phase 3C.1, amended by 3C.2)

Phase 3C.1 lets a SYSTEM_OWNER explicitly grant and revoke PAPER market-policy
enforcement authority for one exact ACTIVE assignment enrollment generation.

Phase 3C.2 makes that authority consumable. Grants now bind the exact Subscription
and canonical Security (`PAPER_MARKET_POLICY_ENFORCEMENT_V2`). Entry admission reads
authority under row locks and enforces it only while the separate, default-disabled
PAPER runtime rollout is active. Owner revocation and automatic invalidation have
explicit, distinct consequences. See
`docs/architecture/market-policy-pre-intent-enforcement.md` for the Security
binding, lapse semantics, rollout, admission lifecycle, frozen obligations, and lock
ordering. The sections below describe the original 3C.1 record model, with 3C.2
amendments noted inline.

## Decision: a separate append-preserving record

The Phase 3A generation fields `enforcementAuthorityVersion` and
`enforcementAuthorizedAt` stay permanently null, and their null-only constraint is
retained. One mutable field pair on the generation cannot represent revocation,
invalidation, or reauthorization without rewriting history.

Authority lives in two new tables:

- `AssignmentMarketPolicyEnforcementAuthorization`: one row per grant. The grant
  identity is immutable. The status may move once from `AUTHORIZED` to `REVOKED`
  (by an owner) or `INVALIDATED` (by a configuration change). Terminal rows are
  immutable and rows are never deleted.
- `AssignmentMarketPolicyEnforcementAuthorizationEvent`: an immutable audit event
  that PostgreSQL writes for every `GRANT`, `REVOKE`, and `INVALIDATE`, including
  direct SQL and cascaded invalidations. Each event mirrors the exact bound identity
  and the original `authorizationId`.

Each grant binds: TradingAccount, TradingAccountSubscription, Strategy,
StrategyMarketPolicyRevision, enrollment and generation, the generation
configuration fingerprint, the account holder, `authorityVersion =
PAPER_MARKET_POLICY_ENFORCEMENT_V1`, `environment = PAPER`, the authorizing
SYSTEM_OWNER, the timestamp, and a reason. A per-generation `authorizationSequence`
and a unique `authorizationFingerprint` give every reauthorization a distinct audit
identity.

## PostgreSQL integrity

- CHECK constraints require PAPER, the V1 authority version, well-formed
  fingerprints, non-blank reasons, and lifecycle-consistent actor, timestamp, and
  reason fields.
- Partial unique indexes allow at most one `AUTHORIZED` row per generation and per
  assignment.
- An insert trigger requires an ACTIVE generation whose identity matches exactly, a
  PAPER account with the unchanged holder, matching assignment account and Strategy,
  the Strategy's ACTIVE revision, an enabled SYSTEM_OWNER authorizer, and a
  contiguous sequence. It takes share locks on the generation, account, assignment,
  and revision rows so grants serialize against concurrent configuration changes.
- An update trigger allows only `AUTHORIZED -> REVOKED | INVALIDATED`, keeps grant
  evidence immutable, and requires an enabled SYSTEM_OWNER revoker. Deletes are
  rejected.
- Cascading triggers invalidate an effective grant, without deleting it, when:
  - its generation is DISABLED (`ENROLLMENT_DISABLED`, actor = disabling owner)
  - its policy revision leaves ACTIVE (`POLICY_REVISION_SUPERSEDED`)
  - the account holder changes (`ACCOUNT_HOLDER_CHANGED`)
  - the assignment account or routing Strategy changes (`ASSIGNMENT_IDENTITY_CHANGED`)
  - 3C.2: the assignment Subscription or routing Security changes, including
    BEFORE-trigger derivation and FK cascades (`ASSIGNMENT_SUBSCRIPTION_CHANGED`);
    the Subscription identity changes (`SUBSCRIPTION_IDENTITY_CHANGED`); the
    canonical Security symbol changes (`SECURITY_IDENTITY_CHANGED`); or an effective
    V1 grant is migrated (`AUTHORITY_BINDING_REAPPROVAL_REQUIRED`)
- Moving an account away from PAPER is rejected while it has an effective grant.
  The Phase 3A trigger independently rejects PAPER-to-LIVE while a PREPARED or
  ACTIVE generation exists.

Restoring the original holder or configuration never restores an invalidated grant.
Authority returns only through a new explicit grant.

The migration creates no authorization rows, so existing ACTIVE generations remain
`NOT_AUTHORIZED`. Compare-only coverage and broker evidence tables and constraints
are not altered.

## When authorization is effective

3C.2: entry admission uses the transactional, row-locked
`resolveLockedAssignmentMarketPolicyEnforcement(tx, accountSubscriptionId)`, which
also validates the Security binding and recomputes the V2 fingerprint. The unlocked
resolver below remains for informational reads only.

`resolveAssignmentMarketPolicyEnforcementAuthority(accountSubscriptionId)` is the
read boundary for Phase 3C.2. It returns `authorized: true` only when all of these
hold:

1. An `AUTHORIZED` row exists for the exact assignment.
2. Its generation is still ACTIVE and its identity (configuration fingerprint,
   policy revision, holder, Strategy) matches the row.
3. The account is PAPER and its holder equals the bound holder.
4. The assignment's account and routing Strategy equal the bound identity.
5. The bound revision is the Strategy's ACTIVE revision and validly describes all
   five dimensions.
6. The recomputed generation configuration fingerprint equals the stored one.

Otherwise it returns explicit reasons. The resolver is read-only and has no caller
in any trading path in Phase 3C.1.

## Relationship to enrollment

Enrollment (`PREPARED -> ACTIVE -> DISABLED`) remains configuration only, and its
lifecycle, triggers, and fingerprint are unchanged. Authorization is a separate
layer on top of an ACTIVE generation:

| Enrollment | Authorization states available |
|---|---|
| PREPARED | `NOT_AUTHORIZED` only |
| ACTIVE | `NOT_AUTHORIZED`, `AUTHORIZED`, `REVOKED`, `INVALIDATED` |
| DISABLED | historical `REVOKED` / `INVALIDATED` only |

Re-enrollment creates a new generation, which starts `NOT_AUTHORIZED`.

## Preview and eligibility

The preview is a read-only GET. It reports the exact identity, configuration
validity, `eligibleToAuthorize`, and coded blocking reasons:
`ACCOUNT_NOT_PAPER`, `ENROLLMENT_GENERATION_REQUIRED`, `ENROLLMENT_NOT_ACTIVE`,
`ASSIGNMENT_IDENTITY_MISMATCH`, `ACCOUNT_OWNERSHIP_CHANGED`,
`ACTIVE_POLICY_REQUIRED`, `POLICY_REVISION_SUPERSEDED`,
`POLICY_CONFIGURATION_INVALID`, `CONFIGURATION_FINGERPRINT_MISMATCH`, and
`AUTHORIZATION_ALREADY_EFFECTIVE`.

The latest persisted shadow eligibility decision is shown as an informational market
observation with `requiredForAuthorization: false`. `BLOCKED` and
`INSUFFICIENT_EVIDENCE` never block authorization. Operational posture (strategy,
assignment, entries, account status, kill switch) is shown separately with
`affectsAuthorizationValidity: false`. The preview never invokes the evaluator and
writes no decisions, audit rows, authorizations, or System Events.

## API and RBAC

The base path is
`/api/trading-accounts/:id/account-subscriptions/:accountSubscriptionId/market-policy-enrollment/enforcement-authorization`.

| Operation | Method and path | Access |
|---|---|---|
| Current state | `GET` base | Account members with `SUBSCRIPTION_READ`, role-projected |
| Preview | `GET` base`/preview?generationId=` | Account members with `SUBSCRIPTION_READ`, role-projected |
| History | `GET` base`/history` | SYSTEM_OWNER |
| Grant | `POST` base`/grant` `{ generationId, expectedConfigurationFingerprint, expectedPolicyRevisionId, reason }` | SYSTEM_OWNER |
| Revoke | `POST` base`/revoke` `{ authorizationId, reason }` | SYSTEM_OWNER |

The routes enforce SYSTEM_OWNER, and the service re-checks for an enabled
SYSTEM_OWNER inside the transaction. PostgreSQL checks it a third time.

Grant and revoke run in SERIALIZABLE transactions with row locks. Failures return
409 with a `details.code`:

- Stale browser state: `STALE_CONFIGURATION` or `STALE_POLICY_REVISION`.
- Duplicate or concurrent grants: `AUTHORIZATION_ALREADY_EFFECTIVE` or
  `CONCURRENT_AUTHORIZATION_CHANGE`.
- Repeated revocation: `AUTHORIZATION_ALREADY_REVOKED` or
  `AUTHORIZATION_ALREADY_INVALIDATED`. No new event is written.
- Ineligible configuration: the first blocking code, plus every blocking reason.

A wrong generation or assignment returns 404. Owner responses carry actors, reasons,
and fingerprints. Operators and Account Users receive status, sequence, revision,
and timestamps only.

Grant and revoke also write `MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_GRANTED` and
`..._REVOKED` System Events. Since 3C.2 their `runtimeEnforcementActive` reflects the
actual rollout (3C.1 always reported `false`) and
`tradingEffect: NONE`.

## Web UI

The Market Policy enrollment panel now contains an "Enforcement authorization"
section. It shows the authorization state badge, `PAPER ONLY`, and `RUNTIME
ENFORCEMENT NOT ACTIVE`, the exact identity table, configuration validity,
eligibility, blocking reasons, the informational market observation, and operational
posture.

SYSTEM_OWNERs get:

- A grant dialog that shows the exact identity and fingerprint and requires a reason
  plus an explicit confirmation checkbox.
- A revoke dialog that requires a reason.
- The immutable authorization history.

Conflicts show the coded error, and the preview is refetched. Non-owners see a
read-only view with no history request.

## Future-phase contract (3C.2 implemented the pre-intent items; see the 3C.2 document)

- Unenrolled or unauthorized assignments retain existing behavior.
- Phase 3C.2 will require synchronous market-policy evaluation only when
  `resolveAssignmentMarketPolicyEnforcementAuthority` returns `authorized: true`.
- Rejected pre-intent attempts will record immutable evidence and create no
  OrderIntent.
- Accepted entries will atomically freeze the exact `authorizationId` and
  `authorizationFingerprint` with their OrderIntent. Later revocation or
  invalidation must not erase or bypass an already-frozen obligation.
- Broker-time reauthorization happens in Phase 3C.3, before a genuinely new BUY
  POST (`docs/architecture/market-policy-broker-time-enforcement.md`). Stable
  client-order-ID recovery remains authoritative.
