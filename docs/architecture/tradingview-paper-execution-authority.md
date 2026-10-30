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

Before activation, later checkpoints must implement: terminalization of pre-epoch pending intents;
definite-non-send claim release; proven-no-exposure `EXIT_PENDING` reconciliation; broker-time
120-second freshness; Operational Attention resolution; unattributed broker-exposure handling;
accurate Market Intelligence request-source/result labels; and existing-order recovery when Alpaca
has the client ID but local TradingView dispatch provenance is absent.

## Deployment and rollback floor

The foundation migration is forward-only once EXECUTE generations, activation history, authorizations, or marked intents exist. Rolling application code back before Phase 4A.2A would remove recognition and quarantine of marked intents and is unsafe without a separately reviewed compatibility fix. This checkpoint does not apply or activate the migration.

The corrected, pre-persistence C1 migration SHA-256 is
`f76f0c9d0d3b2f2b6194148f803d7625ea65def92897a7892574c92b34a6ea33`. This checksum is valid only
under the acceptance condition that every earlier C1 migration body remained unapplied to all
persistent databases; an environment that applied an earlier checksum requires a separately
reviewed forward correction rather than checksum replacement.
