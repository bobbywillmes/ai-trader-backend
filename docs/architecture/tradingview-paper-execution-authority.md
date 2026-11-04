# TradingView PAPER execution authority

## Phase 4A.2B admission boundary

`ENTRY_EXECUTION_PROSPECTIVE` is a prospective-only account-cycle state. Correlation
selects it only when the ENTRY Signal, account cycle, active EXECUTE generation and
exact assignment authorization all share the same post-activation epoch. SHADOW
rollout state is independent and historical SHADOW/BLOCKED/terminal cycles cannot
transition into it.

The coordinator consumes only completed correlation work and passes a typed frozen
TradingView context to `submitOrder`. The shared admission transaction validates the
source cycle and direct accepted-EXIT absence, locks execution authority, requires
effective Market Intelligence enforcement, acquires the existing exposure claim,
and atomically writes the marked `received` intent, Market Intelligence attempt and
obligation, TradingView obligation, and account-cycle link. The deterministic client
order ID and claim owner key make retries recover the same intent; a provenance
collision is a conflict.

Lock order is: Signal source, binding, source cycle and account cycle during
correlation; execution rollout serialization and exact authorization during
admission; then the existing Market Intelligence rollout, account, assignment,
Subscription, Security and authorization order; finally the account/security entry
exposure advisory lock. Direct EXIT Signal evidence is checked again in the atomic
transaction. Serializable correlation retries `40001` through its bounded durable
work attempts. No broker I/O occurs in either transaction.

Risk evaluation remains after atomic intent admission. Allowed intents use the normal
`received -> pending` transition. Denied or failed evaluations use the established
definite-non-send claim release rules; a replay of a still-`received` marked intent
continues evaluation rather than treating creation alone as completion.

The Phase 4A.2A PostgreSQL quarantine remains authoritative: a marked intent cannot
transition to `submitting`. Phase 4A.2B adds no broker-time authorization, consumption
record, adapter call, fallback or LIVE authority.
## Phase 4A.2A boundary

Phase 4A.2A establishes independently controlled authority and provenance only. It does not create an admission worker, call `submitOrder`, create an `OrderIntent`, authorize broker dispatch, execute EXIT signals, or grant LIVE authority.

Authority requires an immutable ENTRY/EXECUTE generation, a SYSTEM_OWNER activation event, an exact PAPER assignment authorization, post-epoch evidence, and atomic OrderIntent origin plus obligation evidence. Creation alone is inert. No earlier SHADOW signal, reservation, source cycle, or account cycle satisfies these requirements.

## Rollout and epoch semantics

Historical SHADOW generations remain unchanged. Correlation explicitly selects only SHADOW generations, so an EXECUTE generation cannot alter evidence behavior. The database-owned singleton `ExternalSignalExecutionRolloutState` defines current activation, version, and epoch; activation events are immutable audit history. ACTIVATE and DEACTIVATE serialize on that state, and DEACTIVATE clears it before invalidating effective authorizations. State changes are applied only by the nested AFTER trigger of the matching latest append-only activation event; a caller-provided custom setting cannot authorize a direct state update. A later generation requires its own activation and new exact authorizations. EXIT EXECUTE generations and LIVE authorizations are database-rejected.

## Exact authorization

`ExternalSignalEntryExecutionAuthorization` is append-preserving. Identity, timestamps, and fingerprints are database-controlled. Only AUTHORIZED to REVOKED or INVALIDATED is allowed; terminal rows cannot be restored or deleted. Reauthorization creates a later sequence and cannot apply to signals or account cycles predating its `authorizedAt`.

The database validates PAPER environment, account holder, assignment mirrors, Subscription, Security, TradingView source, binding Strategy, ACTIVE TRADE_ELIGIBLE revision, and active rollout. Owner grants include expected revision and Security IDs to reject stale-screen approval. Identity changes invalidate effective authority. Fingerprints use canonical JSONB encoding, UTC-independent epoch microseconds, and SHA-256.

## Provenance and dispatch quarantine

`OrderIntent.externalSignalAccountCycleId` independently identifies TradingView origin even if obligation evidence is missing or damaged. It is insert-only: neither legacy rows nor marked rows can be relabeled. `ExternalSignalEntryExecutionObligation` freezes the source cycle, ENTRY Signal, route, account cycle, rollout epoch, authorization, client order ID, and fingerprints.

A deferred constraint requires a matching obligation in the same transaction as every marked OrderIntent. Obligation insertion requires `received` status, `ENTRY_INTENT_CREATED`, exact source/binding/revision/account/assignment/Subscription/Security/symbol identity, no accepted EXIT, nonterminal cycles, post-epoch evidence, and currently active authorization. The obligation is immutable.

Every accepted v2 `EXIT_LONG`, including a direct SQL insert, updates the owning source-cycle row in the same transaction. This creates a new MVCC row version without changing Signal identity. An admission transaction that later locks that cycle therefore either sees the EXIT under READ COMMITTED or aborts under SERIALIZABLE if its snapshot predates the EXIT. Ingress continues to lock source before binding and source cycle; the trigger only updates the already-locked cycle on the normal path.

The legacy order worker selects only intents with a null origin marker. Independently, PostgreSQL rejects every marked transition into `submitting` and direct marked inserts outside `received`. Marked intents may still move to `blocked` or `failed`. No marked TradingView intent can reach today's broker path.

The existing stale-admission sweep also reconciles a marked account cycle after it has failed the
intent and the shared claim-release path has committed definite non-send evidence. It requires the
exact immutable execution obligation and account-cycle origin, a released matching claim, both
not-sent and release evidence, and no adapter, dispatch, broker-order, broker-activity, or position
evidence. It then records `TERMINAL_NO_EXPOSURE` without changing the immutable links, and closes the
source cycle only when every account cycle independently has no-exposure proof. Missing or
conflicting evidence remains nonterminal and opens Operational Attention. This reconciliation is
idempotent so a crash after claim release is repaired by the next normal recovery tick.

The 120-second signal-age limit is rechecked with PostgreSQL's current clock after admission locks
have been acquired. The coordinator's selection-time check is only an optimization; a signal that
expires while waiting for serialization is permanently refused before intent creation.

### Carry-forward acceptance register

The following Hermes LOW findings remain open and must be explicitly revisited before broker
activation: signal timestamp immutability; frozen execution-generation consistency; the deadlock
involving assignment-less entries; complete broker-progress state validation; accurate Market
Intelligence admission source/result evidence; and `EXIT_PENDING` cycles with proven no exposure.
They are not resolved by Phase 4A.2B final acceptance corrections.

## SHADOW and EXECUTE independence

SHADOW generations and decisions retain their evidence meaning permanently. An enabled SHADOW generation is not an execution prerequisite, and a SHADOW BLOCKED decision neither grants nor denies execution authority. Phase 4A.2B must derive execution eligibility independently from frozen route/correlation identity, the execution epoch, and exact PAPER authorization. Historical `BLOCKED`, terminal, `EXIT_PENDING`, SHADOW-reserved, and pre-epoch account cycles are never promotion candidates.

The intended 4A.2B state path is a new prospective execution-admission state entered only from a nonterminal frozen ENTRY route after the execution epoch, followed by `ENTRY_INTENT_CREATED` only in the transaction that successfully creates the claim, marked `received` OrderIntent, and obligation. That migration must add the prospective state and narrow transition rules; it must not reinterpret `ENTRY_ADMISSION_PENDING` or `ENTRY_SHADOW_ALLOWED`, because those are historical SHADOW evidence. Failure before intent creation must end in an explicit blocked/no-exposure state. Accepted EXIT must preempt the prospective state, while terminal-to-active and historical-to-executable transitions remain prohibited.

The existing `ExternalSignalTradeCycleAccount_shadow_links_check` still requires `entryOrderIntentId` and `trackedPositionId` to remain null. Phase 4A.2B must replace that constraint only in the migration that atomically wires legitimate OrderIntent linkage. TrackedPosition linkage belongs to a later fill/lifecycle checkpoint and must not be enabled prematurely.

## Lock-order protocol

| Path | Acquisition order |
| --- | --- |
| v2 ingress | source -> binding -> source cycle parent -> account cycle writers |
| correlation | work lease -> source -> binding -> source cycle -> account cycle |
| rollout transition | execution advisory lock -> rollout state -> actor -> generation -> activation event -> nested state apply -> authorization invalidation |
| grant | execution advisory lock -> rollout state validation -> source -> binding/revision -> generation -> account -> assignment -> Subscription -> Security -> authorization |
| revoke | execution advisory lock -> rollout state validation -> source -> binding -> authorization |
| obligation | execution advisory lock -> rollout state validation -> intent/cycles/signal/route/authorization and exact identity rows |
| MI admission | runtime rollout -> account -> assignment -> Subscription -> Security -> MI authorization -> entry-exposure advisory lock |
| MI broker dispatch | account/assignment identity and frozen MI authorization -> decision/consumption |
| identity invalidation trigger | already-locked changed identity row -> affected authorization; never the execution advisory/state lock |

Every rollout consumer acquires the advisory lock and then performs a no-op update of the singleton state before other execution locks. The update is also a stale-snapshot fence: a SERIALIZABLE transaction whose snapshot predates a rollout transition aborts rather than validating obsolete authority. Trigger-driven identity invalidation deliberately does not acquire the state lock, avoiding identity-row/state inversion; grants revalidate the identity after waiting. Controlled grant/deactivation and stale-obligation probes verify this protocol.

The future combined admission order remains unapproved. Phase 4A.2B must reconcile cycle locks with the complete Market Intelligence admission transaction before adding locks or calling `admitEntryOrderIntent`; any required reversal needs architecture review.

## Remaining checkpoints

Phase 4A.2B must add admission coordination, fresh authorization/epoch validation, existing risk/sizing admission, and atomic marker/obligation/claim/OrderIntent creation. Phase 4A.2C must replace the temporary deny-all dispatch quarantine with database-validated one-shot broker authorization and evidence consumption. Market Intelligence and PAPER broker-write authority remain independent mandatory boundaries.

## Phase 4A.2C1 broker-dispatch safety foundation

Phase 4A.2C1 adds schema and database enforcement only. `ExternalSignalBrokerDispatchState`
is a separate singleton that is inserted disabled at version 1. A SYSTEM_OWNER can append an
ACTIVATE event only for the exact currently active, enabled ENTRY/EXECUTE generation. The database
owns the event timestamp and next version. DEACTIVATE clears the current generation while retaining
the immutable event chain. Both operations take the existing
`external-signal-execution-rollout` advisory lock and lock execution state before dispatch state.
No activation event is inserted by the migration. Deactivating the active ENTRY execution
generation automatically appends the matching dispatch DEACTIVATE event in the same transaction;
reactivating ENTRY never reactivates dispatch.

The dispatch activation timestamp is a strict, independent epoch. The obligation's frozen
`executionEpochAt` must instead equal the current ENTRY activation timestamp. A worker claim
requires the Signal, account cycle, execution obligation and OrderIntent to have been created at or
after dispatch activation, and requires the frozen account-cycle generation, obligation generation,
authorization generation and both active singletons to agree. Timestamp-without-time-zone Signal
and OrderIntent evidence is interpreted explicitly as UTC. Activation therefore never drains an
older accepted or quarantined backlog. Deactivation takes the same locks that claim/consumption
validation takes and fences an uncommitted authorization before it can commit.

`ExternalSignalBrokerWorkerClaim` is one-per-intent and freezes the exact obligation, account cycle,
execution generation, dispatch-state version and client order ID. PostgreSQL supplies its timestamp
and canonical SHA-256 fingerprint. Its guard also revalidates executable PAPER account and assignment
state, exact source/binding/revision/route/Subscription/Strategy/Security identity, direct EXIT
absence, `ENTRY_INTENT_CREATED`, an unreleased `ENTRY_PENDING` exposure claim, and absence of any
prior dispatch or broker evidence. C1 deliberately provides no application caller and does not add
the `pending -> submitting` exception. The complete marked-intent status allowlist remains
`received`, `pending`, `blocked`, and `failed`; all broker-progress statuses, broker-order evidence,
position linkage and broker sync timestamps are rejected.

`ExternalSignalBrokerDispatchConsumption` is the TradingView half of the future final-dispatch
linearization point. It freezes the worker claim, execution obligation and authorization, generation,
dispatch version, client order ID, broker opportunity and exact
`MarketPolicyBrokerDispatchConsumption`. Deferred constraints require both halves at transaction
commit. A marked intent cannot commit a lone Market Intelligence consumption and can never use
`MarketPolicyBrokerUnenforcedDispatch`. Both records are immutable. Legacy unmarked PAPER and LIVE
paths retain their existing behavior.
The TradingView consumption locks its exact execution authorization. This serializes it against
revoke/invalidate; a SERIALIZABLE stale snapshot aborts, while READ COMMITTED re-reads and fails
closed. The execution-rollout advisory lock remains the outer serialization protocol.

### Required 4A.2C2 transaction

The future worker must use one database transaction and this lock order:

1. Take `external-signal-execution-rollout`, then lock execution rollout state, dispatch state and
   the exact execution generation.
2. Lock source, binding, source cycle and account cycle, followed by the frozen TradingView
   authorization and obligation.
3. Follow the existing Market Intelligence order without modification: runtime rollout,
   TradingAccount, assignment, Subscription, Security, latest/frozen authorization and revision.
4. Take the existing account/security entry-exposure advisory lock and lock the existing
   `EntryExposureClaim` plus its event history boundary.
5. Revalidate post-dispatch-epoch freshness and identity, insert the worker claim, transition only
   `pending -> submitting`, and append the existing claim transition event atomically.

The final-dispatch transaction must again take the rollout/identity locks in that order, create the
Market Intelligence decision as today, then insert its consumption and the matching TradingView
consumption in the same transaction. The pair must commit immediately before the adapter. No session
variable or application boolean is an authority input.

Direct EXIT ingestion does not acquire these locks; its Signal insert updates the source-cycle MVCC
row. C2 must retain the current READ COMMITTED re-read/SERIALIZABLE conflict behavior after locking
the source cycle. Trigger-driven assignment/authorization invalidation locks catalog rows and then
updates authorizations, so C2 must never take those identities in reverse order. Assignment-less
legacy order paths remain outside TradingView eligibility and must continue through their current
Market Intelligence behavior.

### Rollout, rollback, and deferred lifecycle work

Deploy C1 first and leave dispatch state disabled. Deploy C2 code while the state remains disabled,
run readiness checks, then append a deliberate owner activation only for a newly activated execution
generation. To roll back, append DEACTIVATE first and wait for in-flight database transactions to
drain before deploying older code. Never remove the C1 pairing or quarantine triggers during a code
rollback. This ordering means an old worker cannot claim marked intents and old dispatch code cannot
commit a lone Market Intelligence consumption.

Before C3 activation, later checkpoints must implement broker-time 120-second freshness, validated
adapter markers and broker-progress transitions, unattributed broker-exposure handling, and
existing-order recovery when Alpaca has the client ID but local TradingView dispatch provenance is
absent. C2's claim-time freshness and pre-dispatch recovery do not grant any of those capabilities.

## Phase 4A.2C2 controlled worker ownership

C2 adds a typed, single-intent worker entrypoint but deliberately does not schedule it from the
account worker. The ordinary `processPendingOrdersForAccount` query continues to exclude every
intent with an external-signal account-cycle marker. This is the runtime C2 non-execution barrier;
activating the dispatch-state singleton alone cannot select a marked intent.

The controlled claim transaction takes the external-signal execution advisory lock first. The C2
claim guard then locks execution and dispatch singleton state followed by the mutable OrderIntent,
source cycle, account cycle, authorization, generation, account, assignment, Subscription,
Security, source, binding, revision and exposure claim rows. Immutable obligation, Signal, route
and routing-run evidence is snapshot-validated without unnecessarily locking those rows. This
preserves source-cycle serialization with accepted EXIT, authorization fencing with revoke or
invalidate, and catalog fencing against concurrent disablement or identity changes. The
immutable worker-claim insert runs the guard and establishes those identity locks before the
account/security exposure advisory lock is acquired. The exposure lock is then reacquired by the
shared release path. Existing Market
Intelligence admission uses the same account/assignment identity ordering and legacy execution does
not take the external-signal execution lock, so no reverse acquisition edge is introduced. In the
same SERIALIZABLE transaction the
application changes `pending` to `submitting`, changes the existing claim from `ENTRY_PENDING` to
`ENTRY_SUBMITTING`, and appends `WORKER_CLAIMED_FOR_SUBMISSION`. Database triggers require the
immutable worker claim for both state changes. A rollback at any point removes all four writes.

C2 uses the frozen account-cycle assignment identity and centralized `evaluateOrderRisk` with the current intent
excluded from exposure accounting. It never re-sizes the admitted order. A denial records the
ordinary risk evidence and durable pre-dispatch not-sent evidence before the shared claim-release
path runs. An allowed result is handled identically with the explicit
`TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE` refusal. Thus C2 ownership never reaches
`submitOrderToBroker`, Market Intelligence dispatch consumption, an adapter marker, a broker POST,
or SELL generation, and does not leave a permanently submitting intent.

The normal stale-submitting scheduler recognizes the immutable C2 claim. A claim with the C2 marker
protocol and no consumption, adapter invocation, broker evidence or contradictory outcome is proven
not sent, terminalized and released through the shared recovery path. Possible-delivery or
contradictory evidence retains ownership and creates one active Operational Attention episode;
repeated ticks update that episode rather than emitting repetitive SystemEvents. Allocation,
credential and catalog readiness are checked before ownership where possible, while the claim guard
rechecks mutable authority under the transaction locks. PostgreSQL applies the 120-second maximum
age to the immutable entry Signal with `clock_timestamp()` after lock waits.

Once paired final-dispatch consumption exists, database guards prohibit returning the intent to
any other status or moving the exposure claim into any other lifecycle state. This remains true when
no adapter marker exists: consumption itself means delivery may have started, but it does not prove
any broker status. C3 may replace this complete quarantine only with narrowly validated,
broker-evidence-backed transitions and adapter-marker capability; C2 must not manufacture either.
Both consumption rows and the worker claim remain immutable and unique.

### C2 correction and C3 carry-forward boundary

Pre-claim refusal is an ownership-fenced transaction, not a conclusion drawn from the candidate
read. Under the execution advisory lock it locks the still-pending intent and its unreleased
`ENTRY_PENDING` claim, verifies that no worker claim exists, commits the terminal status and only
then appends the unclaimed refusal evidence. A lost conditional transition rolls the evidence back
and is classified as a lost race; it never calls release. Claimed not-sent evidence must follow the
database-owned `WORKER_CLAIMED_FOR_SUBMISSION` event, name the exact immutable worker claim, and come
from an authorized C2 producer. Release additionally requires a terminal non-dispatch intent and
the absence of consumption, adapter, broker-opportunity, broker, unresolved-delivery or position
evidence. Historical pre-claim evidence cannot release a later claimed lifecycle.

The following work remains explicitly carried forward and is not completed by C2:

- Cancel and terminalize pre-dispatch-epoch backlog without making it claimable.
- Resolve Operational Attention only after authoritative recovery establishes the outcome.
- Recheck the broker-time 120-second freshness boundary.
- Reconcile an exact existing broker order and unattributed broker exposure without guessing.
- Commit the Market Intelligence and TradingView consumptions together in C3.
- Add the broker adapter boundary and only validated broker/position lifecycle transitions.
- Revalidate the current `submitting` intent and active exposure claim immediately before dispatch.
- Harden the production application database role to least privilege; superuser-style privileges are
  not an acceptable broker-system defense boundary. This checkpoint adds no role migration.
- Reconcile broker evidence discovered after an earlier verified release through an authoritative
  Operational Attention workflow; ordinary C2 processing must neither discard it nor reopen ownership.
- Audit every C3 dispatch and broker-evidence writer for the same claim-row serialization protocol
  before any adapter capability is enabled.

C2 remains inert: its typed entrypoint is unscheduled, the ordinary worker excludes marked intents,
and it creates neither final-dispatch consumption, adapter invocation, broker mutation, SELL, nor
LIVE TradingView execution.

## Phase 4A.2C3A dispatch safety hardening

C3A closes the five safety findings carried from C2 acceptance. It is inert. It adds no broker
capability, final-dispatch consumption, adapter invocation, scheduled TradingView execution, SELL or
LIVE path. `processPendingOrdersForAccount` still excludes every marked intent, the typed entrypoint
has no caller, and the `TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE` refusal remains the only allowed
outcome. Migration `20261031120000_tradingview_dispatch_safety_hardening` is forward-only and replaces
trigger functions. It adds no table or column, so the Prisma schema and DBML are unchanged.

### Cross-isolation linearization

Evidence and release linearize on the `EntryExposureClaim` row version. C2's `SELECT ... FOR UPDATE`
serialized the writers but left the tuple unchanged, so a REPEATABLE READ or SERIALIZABLE release with
an older snapshot committed without seeing the evidence. Writing any of the five delivery event types
for a marked claim now also runs a value-preserving `UPDATE` of that claim, which creates a new tuple
version without changing status, timestamps or diagnostics and without appending an event.

| First to commit | Second transaction at READ COMMITTED | Second transaction at REPEATABLE READ or SERIALIZABLE |
| --- | --- | --- |
| Evidence | Release re-reads, and its guard refuses (`P0001`) | Release fails (`40001`) |
| Release | Evidence re-reads `releasedAt` and refuses (`P0001`) | Evidence fails (`40001`) |

A dedicated version column was not needed. No existing `EntryExposureClaim` trigger suppresses
redundant updates or reacts to a no-op. The only other fact a stale reader could rely on, ownership
uniqueness, is untouched. The guard also now refuses any release of a marked claim with possible-delivery
evidence, with or without a worker claim. C2 enforced that only for `ENTRY_SUBMITTING` claims with a
worker claim, so an unclaimed marked claim could commit both records even in one transaction.

The acceptance matrix runs 3 event types, 4 interleavings and 5 isolation pairs (event/release: RC/RC,
RC/RR, RC/SER, SER/RC, SER/SER), for 60 cases. It also runs the other 4 pairs (48 cases). The same harness
against a database stopped at C2 finds exactly the 12 contradictions in the required 60.

### Legacy lock-order compatibility

The fence reads the origin before locking and returns immediately for an unmarked claim, which restores
the foreign-key `FOR KEY SHARE` that ordinary PAPER/LIVE event writers had before C2. This removes the
deadlock between an event-then-intent writer and an intent-then-event writer. Reading the origin without a
lock leaves no time-of-check gap: the OrderIntent marker is insert-only, and the claim guard now forbids
moving a claim onto or off a marked intent and freezes a marked claim's account, Security, owner key and
timestamps.

Lock order remains execution, then identity, then exposure. The fence takes a claim row only in
transactions that already follow that order or take no earlier lock. `refuseAndRelease` now locks the
intent before writing its evidence, matching the worker-claim guard's intent-before-claim order.

### Stale-admission clock and age authority

A marked admission is eligible only when, under its row lock in the serialized recovery transaction,
both facts have passed `STALE_ADMISSION_THRESHOLD_MS` (15 minutes) by the PostgreSQL clock:

- `EntryExposureClaim.acquiredAt`: how long the claim has been held.
- `OrderIntent.updatedAt`: when the admission last showed activity.

`external_signal_stale_admission_elapsed` is the one age rule. It interprets the
timestamp-without-time-zone value as UTC, so the result does not depend on the session zone or its DST
rules. `OrderIntent.updatedAt` is `@updatedAt`: the Prisma Client fills it from the application's clock
(UTC wall time) on each write it issues. It is not a PostgreSQL-clock value, and a raw SQL write leaves it
unchanged unless the statement sets it. That is why an application clock that runs ahead defers recovery
below instead of being trusted. `EntryExposureClaim.acquiredAt` is the database-stamped fact. Application selection is advisory and also filters on both facts. If the recovery transaction
finds either fact younger, including because an application clock runs ahead, it defers to a later tick
with no diagnostic or error. Unmarked claims keep their existing intent-age behavior.

The not-sent trigger gives a narrower guarantee. Terminalizing has already rewritten `updatedAt` in the
same transaction, so the trigger can prove only the claim's age; intent inactivity is decided by the
recovery transaction. Non-send itself rests on structure, not on the age or on JSON: the claim never
left `ENTRY_PENDING`, the state the broker boundary refuses, and no contradictory evidence exists.
JSON `source`, `producer` and `proof` select a rule but authorize nothing. Backdating is closed at
both ends: PostgreSQL stamps a marked claim's `acquiredAt` at insert, and the guard makes it immutable.

### Delivery uncertainty and terminal integrity

A marked claim with `ADAPTER_INVOCATION_STARTED`, `DISPATCH_OUTCOME_RECORDED`,
`BROKER_DELIVERY_UNCERTAIN`, a paired consumption, a broker order or activity, or an attached position
keeps its exposure, is never classified definitely not sent, and has exactly one active
`TRADINGVIEW_C2_WORKER_RECOVERY_REQUIRED` attention with `AUTHORITATIVE_ONLY` resolution. This applies to
any intent status. The scheduler picks an account up only for a first report, changed evidence or the
60-second refresh. A repeat refreshes the episode without a new SystemEvent, and new evidence adds one
`material_changed` event. The terminal sweep classifies these claims as `OPERATOR_INVESTIGATION`, so it
infers no outcome, performs no broker read and attempts no release. Nothing resolves the episode because
a local BrokerOrder or marker is absent. An account without usable credentials is not processed, so its
episode is not opened until credentials return; the claim stays held and the account reports
`credentials_unavailable_with_exposure`.

`blocked` and `failed` are both final for a marked intent. Neither can become the other or become
executable, and the status, `blockReason` and risk evidence that made it terminal are immutable,
whether or not a worker claim or not-sent event exists. The first terminal transition is authoritative.

### Database least-privilege design

Observed runtime: the development role `trader` is `SUPERUSER`, `CREATEROLE`, `CREATEDB` and
`BYPASSRLS`, and it owns every application object. `docker-compose.prod.yml` configures the same bootstrap
user as the production `DATABASE_URL`; the live production role was not inspected in this checkpoint.

**Pre-canary blocker:** a superuser or table owner can run `ALTER TABLE ... DISABLE TRIGGER` or set
`session_replication_role`, so no trigger in this document is a defense boundary against that identity
until cutover is complete. This must be closed before any broker-enabled canary.

| Identity | Used by | Authority |
| --- | --- | --- |
| Bootstrap superuser | Break-glass administration; runs the ownership transfer and TEMPORARY revocation | Everything; no application or deployment credential |
| `ai_trader_migrator` | `prisma migrate deploy` only; runs the grants script | Owns the schema, may create trusted extensions; holds TEMPORARY explicitly; no superuser attribute |
| `ai_trader_app` | Backend and workers | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, sequence use, PUBLIC function execution; owns nothing, cannot read `_prisma_migrations`, **holds no TEMPORARY privilege** |

`docs/database/least-privilege-cutover.sql` (ownership transfer), `docs/database/least-privilege-grants.sql`
(application grants) and `docs/database/least-privilege-temporary-revocation.sql` (database-level TEMPORARY
revocation) hold the three steps, each with a different required identity (below). Trigger functions run as the invoker, so the application needs read
access to every table they consult. `DELETE` stays because services use it today; narrowing it per table
is possible later but is not needed for trigger integrity, because the evidence tables refuse it in
triggers. Runtime source issues no DDL. `src/dev` and `scripts` tools and `src/db/seed.ts` are not runtime
and should use the migrator or a dedicated role.

PostgreSQL grants TEMPORARY on every database to PUBLIC, so the application role can create temporary
tables unless that is revoked at the database level. Runtime source issues no temporary-table DDL (the
workers use Prisma and `pg` queries only; sorts and hashes spill to temporary files, which need no
privilege), so the runtime does not need the privilege. `REVOKE ... ON DATABASE` is not schema DML: it
needs a superuser or the database owner, and the schema migrator can run it only if it owns the database.

Cutover, for a future maintenance window, not performed in C3A. Each script names the identity it needs:

1. Back up the database and confirm no broker-enabled execution is active.
2. As a **superuser**, create both roles with separately generated secrets.
3. **Stop or drain every application writer** (backend, workers, scheduled and pooled clients, ad-hoc `psql`
   sessions of the old identity). A session that survives keeps whatever it created before the change.
4. As a **superuser** (the ownership transfer reassigns objects the migrator does not own, so it cannot
   run as the migrator), run `least-privilege-cutover.sql`.
5. As `ai_trader_migrator`, run `least-privilege-grants.sql`.
6. As a **superuser or the database owner**, connected to the target database taken from the deployment
   environment, apply the **membership and TEMPORARY corrections**: revoke every role membership of
   `ai_trader_app`, then run `least-privilege-temporary-revocation.sql`. It revokes TEMPORARY from PUBLIC and
   from `ai_trader_app`, keeps it for `ai_trader_migrator`, and fails (changing nothing) if any role membership
   remains or any direct grant still gives `ai_trader_app` TEMPORARY. Grant TEMPORARY by name to any other
   identity that needs it; none is assumed. Also confirm no TRUNCATE, TRIGGER or CREATE privilege reaches
   `ai_trader_app` (the broker-enabled preflight checks all three, including through PUBLIC and ownership).
7. **Terminate all existing application sessions**, even though the backend is stopped (`pg_terminate_backend`,
   shown in the script header). A revocation does not drop objects already created: a temporary table that
   shadows an application relation, or a role that was `SET` before a membership was removed, lives in that
   session until it ends. PostgreSQL checks TEMPORARY on every new creation, so an old session cannot create more,
   but it keeps what it made.
8. Point `prisma migrate deploy` at the migrator URL and confirm that no migration is pending.
9. **Reconnect using the final restricted runtime identity.** Set the backend's `DATABASE_URL` to the
   `ai_trader_app` login (the only connection configuration the broker-enabled preflight accepts), with
   broker-capable operations still **off**.
10. **Run broker-enabled readiness against that identity before restoring broker-capable operations:**
    `npm run db:security-preflight -- --mode broker-enabled`. It must exit 0 and report
    `brokerReadinessAuthorized: true` with `sessionUser = currentUser = ai_trader_app`. Only then start the
    workers, and confirm they run, a hostile `DISABLE TRIGGER`, `TRUNCATE` and `CREATE TEMP TABLE` are denied,
    the catalog audit above returns no rows, and no permission errors appear.

Rollback of step 6 needs a superuser or the owner: `GRANT TEMPORARY ON DATABASE <name> TO PUBLIC`.

Rollback of the credential: stop the backend, restore the previous `DATABASE_URL`, and start it. Superuser access still
works against migrator-owned objects, and the roles and ownership can stay in place, so rollback needs no
schema change. Retire the broad credential only after a soak period.

### Trusted name resolution (temporary-table shadowing)

The application role may create temporary tables by default, and the temporary schema is searched before
every other schema unless a path says otherwise. Without a pinned path, an empty temporary table named
`OrderIntent`, `EntryExposureClaimEvent` or `ExternalSignalBrokerWorkerClaim` is read in place of the real
relation inside a trigger. This was reproduced against the first C3A commit with the restricted role: a
claim with `BROKER_DELIVERY_UNCERTAIN` was released (shadow `OrderIntent`), and a worker-owned
`submitting` intent was reset to `pending` (shadow event and worker-claim tables).

Two independent layers close it:

1. **Function-level path (the migration).** Every application function and procedure, SQL as well as
   PL/pgSQL, is altered with `SET search_path = pg_catalog, <its schema>, pg_temp`, which is
   `pg_catalog, public, pg_temp` in every deployed database. A function-level setting applies to the whole
   call, including nested calls, and overrides any session `SET search_path`, so safety does not depend
   on the caller. `pg_temp` is listed explicitly and last. The migration pins 116 functions (112
   PL/pgSQL, 4 SQL) and keeps ownership, arguments, privileges and trigger bindings. It adds no SECURITY
   DEFINER. Before changing a function it inspects any existing `search_path`; none exist today, and a
   different one stops the migration for review. It finishes by failing if any function in the schema
   remains unpinned. Extension members and C routines are outside the audit.
2. **No TEMPORARY privilege for the runtime (the cutover).**
   `docs/database/least-privilege-temporary-revocation.sql`. See the cutover below.

`CREATE OR REPLACE FUNCTION` discards function settings, so a later migration that replaces a function must
include the `SET search_path` clause (or repeat the audit block), and an unpinned function is a test
failure: the restricted-role suite runs the catalog audit (every application function in `pg_proc` must
carry exactly the trusted setting in `proconfig`) and requires zero rows. The same suite proves, with the
actual `ai_trader_app` role, that both attacks fail with TEMPORARY available (default, `pg_temp`-first and
`pg_temp`-only session paths, and with every application relation shadowed), that unpinning the two guards
makes both attacks succeed (negative control), and that with TEMPORARY revoked and the guards unpinned the
release is still rejected because no shadow can be created.

### Checkpoint boundary

- **C3A (this checkpoint):** database linearization, legacy lock compatibility, error classification,
  stale-admission authority, terminal integrity, uncertainty attention, and the role design. Inert.
- **C3B:** the final-dispatch transaction committing paired consumptions, broker-time 120-second
  freshness, revalidating the current `submitting` intent and active claim, and a default-off adapter
  boundary with validated markers. Every new evidence writer must use the claim-row protocol above.
- **C3C:** authoritative broker-evidence reconciliation, exact existing-order and unattributed-exposure
  handling, post-release discovery, the only release path for possible-delivery claims, and resolving
  Operational Attention from that authoritative outcome.

### C3A carry-forward items (LOW, still open)

None of these is resolved by the security correction, and none needs broker dispatch to be implemented now.

- **Before C3B:** an account that lost usable credentials while holding uncertain exposure reports
  `credentials_unavailable_with_exposure` but opens no Operational Attention, because the account is not
  processed without credentials. Attention must not depend on broker credentials.
- **Before C3B:** retry classification must not trust a lookalike error object. It should accept only a
  genuine PostgreSQL error (class, SQLSTATE and driver shape together) before C3B relies on it.
- **Before any broker-enabled execution:** the application role can `DELETE` an unclaimed TradingView
  exposure claim, which would erase a held exposure. A deletion guard for marked claims is required.
- **Review:** decide whether more than one attention for the same underlying uncertainty episode should
  be merged.
- **C3B lock-order constraints (explicit):** execution, then identity, then exposure; the intent row before
  its claim row; every new evidence writer follows the claim-row protocol; and every new or replaced
  function carries the trusted `search_path`.

### Remaining pre-canary conditions

The carry-forward register above stays open apart from the C3A items described in this section, and the
least-privilege entry remains open until the production cutover is done (including TEMPORARY revocation
and the drain). In addition:

- Complete the least-privilege cutover and confirm the live production role.
- Confirm a single writer for each PAPER broker account before any broker-enabled canary.
- Apply this migration to persistent databases only after independent acceptance.

## Phase 4A.2C3B.1 security prerequisites (broker-inert)

Forward-only migration `20261101120000_tradingview_marked_exposure_claim_delete_protection` adds
`external_signal_exposure_claim_delete_guard` / `EntryExposureClaim_external_signal_delete_guard`: a
TradingView-marked `EntryExposureClaim` can never be deleted, claimed or not, with or without events. Unmarked
PAPER/LIVE claims and the one-unreleased-claim-per-symbol partial unique index are untouched, and there is no
bypass setting. The applied C3A migration is unchanged.

Other C3B.1 changes: the TEMPORARY-revocation script rejects every role membership of the runtime role
(including `INHERIT FALSE, SET TRUE`); a read-only database security preflight
(`npm run db:security-preflight -- --mode <mode>`, `docs/database/README.md`) with development-observation and
broker-enabled levels, corrected after audit: strict argument parsing, runtime-connection identity binding,
TRUNCATE/TRIGGER/CREATE privilege audit, and trigger/function integrity against a reviewed manifest; delivery-uncertainty attention is observed for accounts with unusable credentials (no broker request,
ownership retained, never auto-resolved); and the retry classifier recognizes only genuine Prisma
`PrismaClientKnownRequestError` (P2034, P2010 wrapping 40001/40P01), `DriverAdapterError` and node-postgres
`DatabaseError` instances by class identity, so a constructed lookalike is refused. Class identity holds only
while a single copy of each class is loaded; a duplicate copy fails closed (not retried).

The final-dispatch transaction for C3B.2 is specified in
`docs/architecture/tradingview-c3b2-final-dispatch-transaction.md` and is not implemented.

## Deployment and rollback floor

The foundation migration is forward-only once EXECUTE generations, activation history, authorizations, or marked intents exist. Rolling application code back before Phase 4A.2A would remove recognition and quarantine of marked intents and is unsafe without a separately reviewed compatibility fix. This checkpoint does not apply or activate the migration.

The corrected, pre-persistence C1 migration SHA-256 is
`f76f0c9d0d3b2f2b6194148f803d7625ea65def92897a7892574c92b34a6ea33`. This checksum is valid only
under the acceptance condition that every earlier C1 migration body remained unapplied to all
persistent databases; an environment that applied an earlier checksum requires a separately
reviewed forward correction rather than checksum replacement.

## C3B.3-1 Operations projection limits and carry-forward prerequisites

The owner-only execution-lifecycle projection is diagnostic and read-only. It reports
current lifecycle state ahead of retained historical worker-claim evidence, calculates
unresolved authoritative-reconciliation truth independently from bounded display
history, and marks every capped collection with returned, total and truncated counts.
Its observation time precedes several independent reads, so the response is explicitly
point-in-time evidence whose readiness can change after observation; it is not an atomic
snapshot and must not acquire global execution locks to appear atomic.

Before C3C changes the marked-intent quarantine, canonical broker-evidence attribution
must associate account-scoped evidence through direct OrderIntent links, client order ID,
BrokerOrder identity and broker order ID, and must report contradictory-account matches.
Until then the projection labels broker evidence `DIRECT_LINKED_EVIDENCE_ONLY_PRE_C3C`;
absence of those direct links is never proof of non-delivery. C3C must also provide an
indexed plan for the complete Operational Attention association paths.

C3B.3-2 must replace the legacy Operations UI's blanket SHADOW-only wording. The existing
`shadowOnly` and `actualExecutionAuthority` fields remain unchanged for compatibility in
C3B.3-1; clients must eventually distinguish historical SHADOW correlation, configured
execution authority, active C2 ownership, committed authorization and unavailable broker
execution. Credential readiness, and the individual account/assignment readiness
components, are likewise not represented by the current aggregate `accountOperational`
field and remain explicit follow-up work.
