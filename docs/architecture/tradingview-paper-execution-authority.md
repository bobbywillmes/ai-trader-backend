# TradingView PAPER execution authority

## Phase 4A.2A boundary

Phase 4A.2A establishes independently controlled authority and provenance only. It does not create an admission worker, call `submitOrder`, create an `OrderIntent`, authorize broker dispatch, execute EXIT signals, or grant LIVE authority.

Authority requires an immutable ENTRY/EXECUTE generation, a SYSTEM_OWNER activation event, an exact PAPER assignment authorization, post-epoch evidence, and atomic OrderIntent origin plus obligation evidence. Creation alone is inert. No earlier SHADOW signal, reservation, source cycle, or account cycle satisfies these requirements.

## Rollout and epoch semantics

Historical SHADOW generations remain unchanged. Correlation explicitly selects only SHADOW generations, so an EXECUTE generation cannot alter evidence behavior. The database-owned singleton `ExternalSignalExecutionRolloutState` defines current activation, version, and epoch; activation events are immutable audit history. ACTIVATE and DEACTIVATE serialize on that state, and DEACTIVATE clears it before invalidating effective authorizations. A later generation requires its own activation and new exact authorizations. EXIT EXECUTE generations and LIVE authorizations are database-rejected.

## Exact authorization

`ExternalSignalEntryExecutionAuthorization` is append-preserving. Identity, timestamps, and fingerprints are database-controlled. Only AUTHORIZED to REVOKED or INVALIDATED is allowed; terminal rows cannot be restored or deleted. Reauthorization creates a later sequence and cannot apply to signals or account cycles predating its `authorizedAt`.

The database validates PAPER environment, account holder, assignment mirrors, Subscription, Security, TradingView source, binding Strategy, ACTIVE TRADE_ELIGIBLE revision, and active rollout. Owner grants include expected revision and Security IDs to reject stale-screen approval. Identity changes invalidate effective authority. Fingerprints use canonical JSONB encoding, UTC-independent epoch microseconds, and SHA-256.

## Provenance and dispatch quarantine

`OrderIntent.externalSignalAccountCycleId` independently identifies TradingView origin even if obligation evidence is missing or damaged. It is insert-only: neither legacy rows nor marked rows can be relabeled. `ExternalSignalEntryExecutionObligation` freezes the source cycle, ENTRY Signal, route, account cycle, rollout epoch, authorization, client order ID, and fingerprints.

A deferred constraint requires a matching obligation in the same transaction as every marked OrderIntent. Obligation insertion requires `received` status, `ENTRY_INTENT_CREATED`, exact source/binding/revision/account/assignment/Subscription/Security/symbol identity, no accepted EXIT, nonterminal cycles, post-epoch evidence, and currently active authorization. The obligation is immutable.

The legacy order worker selects only intents with a null origin marker. Independently, PostgreSQL rejects every marked transition into `submitting` and direct marked inserts outside `received`. Marked intents may still move to `blocked` or `failed`. No marked TradingView intent can reach today's broker path.

## SHADOW and EXECUTE independence

SHADOW generations and decisions retain their evidence meaning permanently. An enabled SHADOW generation is not an execution prerequisite, and a SHADOW BLOCKED decision neither grants nor denies execution authority. Phase 4A.2B must derive execution eligibility independently from frozen route/correlation identity, the execution epoch, and exact PAPER authorization. `ENTRY_INTENT_CREATED` is the distinct post-admission account-cycle state; timestamp and obligation guards prevent historical or pre-epoch cycles from being promoted.

The existing `ExternalSignalTradeCycleAccount_shadow_links_check` still requires `entryOrderIntentId` and `trackedPositionId` to remain null. Phase 4A.2B must replace that constraint only in the migration that atomically wires legitimate OrderIntent linkage. TrackedPosition linkage belongs to a later fill/lifecycle checkpoint and must not be enabled prematurely.

## Lock-order protocol

| Path | Acquisition order |
| --- | --- |
| v2 ingress | source -> binding -> source cycle parent -> account cycle writers |
| correlation | work lease -> source -> binding -> source cycle -> account cycle |
| rollout transition | execution advisory lock -> rollout state -> actor -> generation -> activation event -> authorization invalidation |
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

## Deployment and rollback floor

The foundation migration is forward-only once EXECUTE generations, activation history, authorizations, or marked intents exist. Rolling application code back before Phase 4A.2A would remove recognition and quarantine of marked intents and is unsafe without a separately reviewed compatibility fix. This checkpoint does not apply or activate the migration.
