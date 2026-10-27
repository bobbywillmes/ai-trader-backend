# PAPER Position Lifecycle Observer Authority

Status: Phase 0 contract and inventory, Phase 1A additive provenance schema, and
Phase 1B verified account-scoped lifecycle authority with Phase 1B.1 grant hardening
and shadow diagnostics. Phase 1C.0 adds a disconnected, transaction-enforced read-only
historical evidence inventory; see `docs/production/position-lifecycle-evidence-inventory.md`.
No runtime enforcement, position synchronization change, historical repair, or exit
behavior change is implemented.

## Phase 1B verified lifecycle authority

`src/services/lifecycle-authority.service.ts` is the disconnected Phase 1B/1B.1 authority
module. It is not imported by a lifecycle worker, order path, reconciliation path, or
broker mutation boundary. It assesses one account as `EXECUTOR`, `OBSERVER`, `UNKNOWN`,
or `DENIED`, projects operation-scoped shadow permissions, and may issue an opaque
process-local grant for future guarded-service integration. A shadow permission is a
diagnostic statement only; it is not trading authority in Phase 1B.

PAPER verification requires one explicit account ownership declaration, a deployment
role consistent with that declaration, exact agreement among declared, stored, and
fresh broker-returned Alpaca account identities, an active verified credential whose
decrypted key matches its stored fingerprint, and one non-contradictory local account
mapping. Executor verification additionally requires the existing exact PAPER
broker-write account/fingerprint authorization. The final broker-write boundary is
unchanged and must independently authorize every PAPER mutation.

`PAPER_EXECUTOR` deployments may contain explicitly declared executor and observer
accounts. An observer remains limited to observer operations and cannot inherit the
deployment's executor capability. `OBSERVATION_ONLY` deployments may contain only
observer declarations; an executor declaration there is denied.

LIVE accounts return `LIVE_POLICY_INDEPENDENT`. They are not passed through a
PAPER-only throwing authorization path and receive no lifecycle grant from this
module. Existing LIVE approval, arming, protective/risk-reducing, and final-write
controls remain authoritative.

The operation families are `OBSERVE`, `POSITION_CREATE`,
`POSITION_MARKET_REFRESH`, `POSITION_LIFECYCLE_TRANSITION`, `LOCAL_ORDER_ADOPT`,
`SUBSCRIPTION_ATTRIBUTION`, `EXIT_STATE_MUTATION`, `ENTRY_CLAIM_MUTATION`,
`RECONCILIATION_REPAIR`, and `BROKER_EXIT_WRITE`. Verified observers are projected
only the first three observation-safe operations. Verified executors are projected
all families, but durable position provenance remains an independent prerequisite
for future strategy-owned mutations and the PAPER write boundary remains an
independent prerequisite for a broker write.

Internal verdicts, assessments, grants, caches, and revocation generations live only
in process memory. Internal verdicts are immutable; every returned diagnostic is a
deeply frozen detached copy and is never consulted as authorization state. Grant
issuance and validation independently apply the role/operation policy.

Grant time comes only from the process clock. Callers cannot provide an issuance or
validation time. A caller may request a shorter positive finite TTL, but grants expire
after at most five minutes. Grants store issuance and expiration time, validation
checks both the absolute expiration and maximum duration, and once an expiration or
backward-clock condition is observed that grant can never become valid again.

Each grant captures account-scoped and process-global monotonic revocation
generations. Account or global invalidation increments a generation as well as
clearing cached verdicts, so previously issued grants are revoked immediately within
that process. A failed or contradictory forced broker verification, or a negative
reassessment replacing verified state, increments the account generation. Each
asynchronous assessment captures its starting generations; an older successful
assessment cannot cache or issue authority after a newer invalidation.

Grant validation rereads account identity, supported broker/environment, credential status, verification,
fingerprint, update revision, local mapping uniqueness, and the startup-loaded
ownership/authorization configuration immediately before the intended protected
transaction. It also rechecks the exact declaration role, deployment compatibility,
operation policy, and captured revocation generations. The configuration revision
includes broker and environment. These checks detect database credential rotation,
revocation, identity change, and mapping conflict without another nested Alpaca GET.
The fresh broker GET occurs when an assessment is minted or forced to refresh.

Environment ownership and authorization declarations are parsed once at process
startup. Changing environment variables outside the process cannot be detected by a
running process; restart is required and inherently destroys all cached assessments
and grants. Therefore Phase 1B does not claim immediate invalidation for external
environment changes.

Revocation generations are process-local. In a multi-process deployment, invalidating
one process does not notify another process; each process retains its own TTL and
database/configuration validation. Distributed revocation or persistent capabilities
are intentionally outside Phase 1B.1.

Future enforcement integration must acquire the existing account-scoped
`LIFECYCLE_MUTATION` lock, resolve one operation grant, and validate it immediately
before each protected transaction. Lock acquisition never grants authority, and the
grant never replaces the lock. Nested services may reuse only the exact account and
operation capability. Phase 1B deliberately does not wire this contract into those
services.

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

## Phase 1A durable provenance schema

Phase 1A applies the following additive shape:

```prisma
enum PositionLifecycleCreationAuthority { EXECUTOR OBSERVER }
enum PositionLifecycleOrigin { LOCAL_ORDER_CHAIN BROKER_EXTERNAL UNKNOWN }
enum PositionLifecycleOwnership { LOCAL_LIFECYCLE_OWNED NOT_LOCALLY_OWNED UNKNOWN }
enum PositionLifecycleDecisionActorType { SYSTEM USER }

model TrackedPosition {
  lifecycleAuthorityAtCreation PositionLifecycleCreationAuthority?
}

model PositionLifecycleProvenanceDecision {
  id                             Int @id @default(autoincrement())
  trackedPositionId              Int
  tradingAccountId               Int
  origin                         PositionLifecycleOrigin
  ownership                      PositionLifecycleOwnership
  legacyExitContinuityAuthorized Boolean @default(false)
  classifierVersion              String
  evidenceFingerprint            String
  evidenceJson                   Json
  actorType                      PositionLifecycleDecisionActorType
  actorUserId                    Int?
  supersedesDecisionId           Int? @unique
  decidedAt                      DateTime @default(now())
}
```

Creation authority is nullable, has no default, and is immutable even from null to a
value. Existing records therefore stay unclassified and cannot inherit the current
deployment role. Origin, ownership, and continuity are stored only in append-only
decisions; there is no mutable current-decision pointer or duplicate effective state
on `TrackedPosition`.

PostgreSQL enforces exact position/account identity, coherent origin/ownership pairs,
typed actor identity, reviewed-user-only legacy continuity, one root decision, one
successor per decision, and same-position linear supersession. It owns `decidedAt` and
rejects update/delete. The effective decision is the only row in the chain without a
successor.

The backstop is a pair of ordinary PostgreSQL triggers plus check, foreign-key,
partial-unique, and unique constraints. These protect all normal application, worker,
route, and script sessions, including direct Prisma and SQL writes. PostgreSQL
superusers, roles allowed to disable triggers, table owners performing DDL, and
sessions deliberately using replication-role bypass can defeat a trigger. Production
application credentials must not have those privileges; migration/owner credentials
remain separately controlled and are used only for reviewed deployment migrations.
Phase 1B must retain that role separation when it adds mutation authority.

`recordPositionLifecycleProvenanceDecision` is the controlled Phase 1A append path. It
locks the exact position, finds the single chain head, calculates a canonical SHA-256
fingerprint, and appends under a serializable transaction. It is not called by any
runtime lifecycle workflow in Phase 1A.

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
2. Phase 1A adds only the nullable creation evidence, append-only decision table,
   controlled disconnected append service, migration backstops, and tests.
3. A later reviewed phase may deploy the additive schema with all existing exits
   unchanged. Record creation
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

## Enforcement blockers retained after Phase 1B

Phase 1B assessments must not treat the Phase 1A provenance table as trusted proof of
local ownership. Independent review must resolve all of the following before any
provenance-based enforcement cutover:

- Remove PostgreSQL superuser, trigger-bypass, and other owner-equivalent privileges
  from production application credentials; keep migration authority separate.
- Prevent broadly privileged INSERT roles from fabricating provenance decisions,
  preferably through a database-enforced restricted append boundary.
- Strengthen evidence fingerprint canonicalization and add deterministic verification
  of stored evidence, rather than trusting an application-produced hash alone.
- Define strict reviewed-actor eligibility and explicit revocation semantics for
  `LEGACY_EXIT_CONTINUITY`.
- Define a durable, atomic capture-start boundary for new-position creation authority.
- Inventory legacy active positions with missing account attribution before coverage
  can be measured.
- Expand database-bypass and concurrent append/mutation tests for the selected
  enforcement backstop.

Recommended Phase 1C scope is evidence collection, readiness reporting, and the
database/security design needed to close these blockers. It should record creation
authority only at a proven atomic creation boundary, measure legacy coverage without
repairing records, define reviewed continuity/revocation, and prove application-role
and concurrency backstops. It should remain shadow-only and stop for review before
any lifecycle service consumes a grant as enforcement authority.

Phase 1C.0.1 keeps persistent inventory disabled because the repository has no
independently managed positive development-database identity. Its corrected V1 reader
separates verified closing SELL evidence from the entry BUY chain, fails closed on
nonterminal or identity-inconsistent execution/claim evidence, treats repair-derived
position links as insufficient origin proof, and never accepts an unverified recorded
continuity decision as completed review. See the production inventory runbook for the
reader-credential and future infrastructure identity contract.

Operational Attention is deployment-authority-aware without changing underlying
evidence. A fresh `VERIFIED_OBSERVER` assessment prevents new action-required episodes
for missing position attribution or entry-claim ownership and resolves matching open
episodes as observer-inapplicable. The resolution records that the condition remains
observed and that neither executor authority nor lifecycle ownership was restored.
System Events and diagnostic findings remain append-preserved. Any failed, UNKNOWN, or
DENIED authority assessment fails safe, while unrelated reconciliation inconsistencies
continue to project normally.

## Mixed-version and rollback assessment

The migration is expand-only: one nullable no-default column, new enum types, a new
table, indexes, constraints, and triggers. Older replicas omit the new column and do
not access the new table, so their existing inserts and updates continue to work.
There is no trigger that changes lifecycle, claim, exit-state, assignment, or exit
configuration values. New replicas must not depend on provenance until every replica
understands it and a separately reviewed cutover occurs.

Prisma has no automatic down migration. Routine rollback is application rollback:
older code can run against the expanded database. Dropping the table, column, types,
or trigger would destroy audit evidence and is therefore a separate destructive,
reviewed operation allowed only if no provenance decisions have been recorded (or an
approved evidence export/retention plan exists). Rolling schema backward while newer
writers remain active is prohibited. Integration coverage verifies old-shape writes,
nullable/no-default legacy behavior, and unchanged production-style exit records.
