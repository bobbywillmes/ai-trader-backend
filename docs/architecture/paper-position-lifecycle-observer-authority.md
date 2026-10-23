# PAPER Position Lifecycle Observer Authority

Status: Phase 0 contract and inventory. No runtime enforcement, schema migration,
position synchronization change, historical repair, or exit behavior change is
implemented by this phase.

## Contract

Account authority and position ownership are independent.

- **Current account authority** answers whether this deployment may perform a named
  operation for one exact brokerage account now. Its outcomes are `EXECUTOR`,
  `OBSERVER`, `UNKNOWN`, or `DENIED`.
- **Durable position provenance** answers how a particular exposure entered the
  account and whether AI Trader owns strategy-managed lifecycle actions for it.
- `lifecycleAuthorityAtCreation=EXECUTOR` records the deployment role at creation.
  It is useful evidence, but never proves trade origin, Subscription identity, exit
  configuration, or strategy ownership.
- Broker reads may create or refresh an observation record. They never establish
  local ownership, including when the deployment is an executor.
- A role transition never promotes an observer-created position. Authority to
  mutate it requires durable provenance recorded independently of its creation role.

### Ownership evidence

Authoritative local lifecycle ownership requires all of the following:

1. Exact `TradingAccount`, broker, environment, broker account identity, Security,
   and long-side exposure identity are consistent and non-contradictory.
2. A locally originated entry chain links one stable `OrderIntent` through broker
   order/fill evidence to the position. Stable client-order identity or an exact
   broker order ID must make the link deterministic; symbol/time/quantity similarity
   alone is insufficient.
3. The originating OrderIntent freezes the exact `Subscription` and
   `TradingAccountSubscription`. Those identities, not current catalog guesses,
   supply strategy-managed exit ownership and configuration.
4. Durable provenance records the classification, evidence IDs, classifier version,
   and timestamp. Contradictory or incomplete evidence produces `UNKNOWN`, never an
   inferred owner.
5. The current operation-specific account grant is valid when a mutation executes.
   Position provenance without current authority is not executable; current authority
   without position provenance does not grant strategy ownership.

A broker-discovered position without originating local OrderIntent evidence is
`BROKER_EXTERNAL` (or `UNKNOWN` when evidence conflicts). It may be stored with its
Security and account for observation, but has null Subscription/assignment, no
invented exit profile/config snapshot, and no strategy-managed exits. Protective or
owner emergency policy, if later authorized, must be a separate explicit policy and
must not rewrite origin.

`PositionExitState.exitManagementModeSnapshot=BACKEND_MANAGED` is not sufficient
ownership evidence for legacy or broker-discovered records. Until migration makes the
new provenance authoritative, existing exit behavior remains unchanged.

## Operation-specific account grants

Phase 1 should introduce an in-process grant manager for account-scoped operation
families: `OBSERVE`, `POSITION_CREATE`, `POSITION_MARKET_REFRESH`,
`POSITION_LIFECYCLE_TRANSITION`, `EXIT_STATE_MUTATION`, `ATTRIBUTION_REPAIR`, and
`BROKER_EXIT_WRITE`.

A grant is minted only after a fresh Alpaca identity GET verifies the exact expected
account number and after the decrypted credential fingerprint, stored credential
fingerprint, deployment declaration, environment, and local unique account mapping
agree. Recommended lifetime is five minutes, bounded by the credential/configuration
revision and process lifetime. Grants are memory-only and fail closed on restart.

Every internal lifecycle workflow acquires the existing account
`LIFECYCLE_MUTATION` advisory lock, then resolves or refreshes the grant once. All
protected service mutations receive an opaque workflow capability carrying account,
operation, expiry, identity fingerprint, and configuration revision. Nested services
reuse that capability; they do not perform repeated Alpaca identity GETs. A capability
cannot be constructed outside the authority module and is revalidated immediately
before each protected transaction.

Invalidate cached grants immediately when credentials are changed, disabled,
reverified, decrypted fingerprint differs, account identity/configuration changes,
deployment ownership configuration changes, the account mapping becomes non-unique,
or verification returns unknown/contradictory identity. Invalidation does not wait
for TTL expiry. Lock acquisition never creates authority, and a grant never replaces
the account workflow lock.

Final broker writes continue through the existing shared Alpaca PAPER boundary. They
must perform the existing exact account/credential/deployment authorization again at
the final write boundary; a lifecycle grant cannot authorize `fetch`. LIVE write
approval, arming, and deployment safeguards remain unchanged and independently
governed.

## Historical classification and minimal adoption

Retrospective classification must not rewrite `createdAt`, claim the current process
created a position, or set `lifecycleAuthorityAtCreation`. The minimum durable adoption
evidence is one append-preserving decision containing:

- tracked position and account identity;
- classification (`LOCAL_ORDER_CHAIN`, `BROKER_EXTERNAL`, `UNKNOWN`, or `DENIED`);
- exact supporting OrderIntent, BrokerOrder, BrokerActivity, Subscription, and
  assignment IDs when applicable;
- classifier/version and evidence fingerprint;
- decision time and actor/workflow;
- contradictions/reason codes; and
- the resulting allowed lifecycle operation set.

Existing immutable `BrokerActivity`, `SystemEvent`, OrderIntent/BrokerOrder linkage,
`EntryExposureClaimEvent`, lifecycle repair cases/actions, and config snapshots are
enough to compute and audit a narrowly scoped classification for many legacy
positions. Phase 1 should therefore add a typed provenance/adoption decision, not a
general-purpose mutation workflow. Reuse the existing reviewed lifecycle-repair path
only when exact links must be corrected. Introduce broader adoption tooling only if a
measured set of production records cannot be classified from immutable evidence.

Rollout must classify and authorize every currently managed production position
before enforcement reaches exit paths. Legacy positions with legitimate existing
exits receive an explicit `LEGACY_EXIT_CONTINUITY` adoption decision derived from
reviewed evidence; enforcement remains shadow-only until coverage is complete. No
existing production exit is disabled during this rollout.

## Writer and caller inventory

The executable direct-writer allowlist lives in
`src/architecture/position-lifecycle-mutation-inventory.ts`. It covers:

| Writer | Mutation responsibility | Entrypoints/callers |
| --- | --- | --- |
| `position-tracking.service.ts` | Broker-GET discovery, create, refresh, close, ownership snapshot and late attribution | scheduled position loop, startup interval, manual compatibility wrapper, Live acceptance workflow |
| `position-exit-state.service.ts` | Lazy create/reset, unlock, trail status, attention and close projection | position sync, exit evaluator, trailing submission, protective-order sync, broker activity, reconciliation |
| `close-position.service.ts` | Open-to-closing claim and safe reopen | automated exit evaluator; owner `DELETE /api/positions/:id` and scoped account route |
| `trailing-stop-exit.service.ts` | Protective submission claim | exit evaluator |
| `lifecycle-repair.service.ts` | Approved attribution/config/exit-state repair | owner lifecycle-repair Apply API |
| `tracked-position-attribution-repair.service.ts` | Legacy reviewed attribution repair | `scripts/repair-tracked-position-attribution.ts` |
| `tracked-position-subscription-resolution.service.ts` | Local-origin ownership propagation | position sync and attribution recovery |
| `trade-cycle-config-snapshot.service.ts` | Immutable config snapshot | position sync and local-origin recovery |
| `stale-close-intent-recovery.service.ts` | Deterministic close-intent recovery | reconciliation (including nominal dry runs today) |
| `order.worker.ts` | Exit failure reopen | scheduled order worker |
| `bootstrap-default-trading-account.ts` | Legacy bulk account attribution | operator script |
| acceptance fixture | isolated direct position construction | lifecycle-repair acceptance harness only |

Related ownership-producing writers that do not directly mutate the two protected
models remain inside the future boundary: OrderIntent/BrokerOrder/BrokerActivity and
EntryDecision position-link propagation, EntryExposureClaim attachment/release,
config snapshots, lifecycle repair decisions, and ownership/audit SystemEvents.
Routes and workers must call guarded services; importing Prisma does not grant an
exception. Database constraints/triggers should backstop protected fields so a script
or missed code path cannot bypass service checks.

The current reconciliation `persistEvents=false`/`persistAttention=false` path is not
strictly dry: it can release closed-position entry claims and invoke stale close-intent
recovery before persistence flags are applied. Phase 1 must split observation from
repair and prove strict dry mode performs zero writes. Phase 0 intentionally preserves
this behavior.

## Proposed schema (not applied)

Proposed additive types and fields:

```prisma
enum PositionLifecycleCreationAuthority { EXECUTOR OBSERVER UNKNOWN DENIED }
enum PositionLifecycleOrigin { LOCAL_ORDER_CHAIN BROKER_EXTERNAL LEGACY_EXIT_CONTINUITY UNKNOWN DENIED }
enum PositionLifecycleOwnershipStatus { OWNED OBSERVED REVIEW_REQUIRED DENIED }

model TrackedPosition {
  lifecycleAuthorityAtCreation PositionLifecycleCreationAuthority?
  lifecycleOrigin              PositionLifecycleOrigin?
  lifecycleOwnershipStatus     PositionLifecycleOwnershipStatus?
  lifecycleProvenanceDecisionId Int? @unique
}

model PositionLifecycleProvenanceDecision {
  id Int @id @default(autoincrement())
  trackedPositionId Int
  tradingAccountId Int
  classification PositionLifecycleOrigin
  ownershipStatus PositionLifecycleOwnershipStatus
  classifierVersion String
  evidenceFingerprint String
  evidenceJson Json
  allowedOperationsJson Json
  decidedAt DateTime @default(now())
  actorUserId Int?
  predecessorDecisionId Int?
}
```

The decision is append-preserving; a later decision supersedes but never edits prior
evidence. PostgreSQL constraints must require account/position consistency, prevent
owned classification without exact local-order evidence IDs, and prevent provenance
changes through ordinary updates. Account grants remain ephemeral because their
freshness is operational; durable verification/audit events may reference grant IDs
without turning an expired grant into authority.

## Acceptance matrix

| Current account result | Durable provenance | Local observation mutations | Strategy lifecycle mutations | Final PAPER broker exit | LIVE |
| --- | --- | --- | --- | --- | --- |
| EXECUTOR | exact local origin / reviewed legacy continuity | allowed with `OBSERVE` grant | allowed only for listed operation grant | existing final PAPER authorization still required | not applicable |
| EXECUTOR | external or unknown | allowed | denied; no Subscription/exit invention | denied unless a separate explicit emergency/protective policy authorizes it | not applicable |
| OBSERVER | any | broker reads and observer-safe records only | denied | denied | not applicable |
| UNKNOWN | any | fail closed except non-owning diagnostic evidence | denied | denied | not applicable |
| DENIED | any | no protected lifecycle mutation | denied | denied | not applicable |
| independently governed LIVE | exact local origin | existing LIVE observation rules | existing LIVE lifecycle rules | not a PAPER grant | unchanged LIVE deployment role, approval, arming, and final-write safeguards |

## Deployment sequence

1. Merge Phase 0 documentation and inventory test only.
2. In Phase 1, add schema/migration and generated DBML, provenance classifier, grant
   manager, guarded repository/service boundary, database backstop, and strict-dry
   reconciliation tests. Keep enforcement shadow-only.
3. Deploy additive schema with all existing exits unchanged. Record creation
   authority/provenance for new observations; collect legacy classification coverage.
4. Review contradictions and mint explicit legacy-continuity decisions for legitimate
   production exits. Do not run a broad historical repair.
5. Enable mutation enforcement for observer accounts first, then executor observation
   mutations, and finally owned executor lifecycle mutations after coverage/readiness
   gates pass. Stop for review between stages.
6. Broker-write enforcement remains at the existing shared Alpaca boundary throughout.
   No production-to-development lifecycle replication is introduced.

## Decisions reserved for Phase 1 review

- Confirm the five-minute grant TTL (or choose a shorter operational value) and the
  exact configuration-revision signal used for immediate invalidation.
- Choose the PostgreSQL backstop shape: restricted mutation stored procedures,
  transaction-local capability context plus triggers, or an equivalently bypass-proof
  repository role. Application-only guards are not acceptable.
- Decide whether broker-external exposure supports a separately authorized owner
  emergency close in the first enforcement release or remains observation-only.
- Measure legacy production evidence coverage before deciding whether a single
  append-only provenance decision table is sufficient or a narrowly scoped reviewed
  adoption action is also required.
