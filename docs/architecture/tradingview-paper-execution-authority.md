# TradingView PAPER execution authority

## Phase 4A.2A boundary

Phase 4A.2A establishes independently controlled authority and provenance only. It does not create an admission worker, call `submitOrder`, create an `OrderIntent`, authorize broker dispatch, execute EXIT signals, or grant LIVE authority.

Authority requires an immutable ENTRY/EXECUTE generation, a SYSTEM_OWNER activation event, an exact PAPER assignment authorization, a post-epoch ENTRY signal and account cycle, and an atomic OrderIntent origin marker plus immutable obligation. Creation alone is inert. No earlier SHADOW signal, route, reservation, source cycle, or account cycle satisfies these requirements. An enabled Subscription and a SHADOW decision are evidence, never authority.

## Rollout and epoch semantics

Historical SHADOW generations remain unchanged. Correlation explicitly selects only SHADOW generations, so an EXECUTE generation cannot alter evidence behavior. The latest activation event defines global state; an ACTIVATE event's backend-controlled timestamp is the epoch. DEACTIVATE makes execution inactive and invalidates effective authorizations for that generation. A later generation requires its own activation and new exact authorizations. EXIT EXECUTE generations and LIVE authorizations are database-rejected.

## Exact authorization

`ExternalSignalEntryExecutionAuthorization` is append-preserving. Identity, timestamps, and fingerprints are database-controlled. Only AUTHORIZED to REVOKED or INVALIDATED is allowed; terminal rows cannot be restored or deleted. Reauthorization creates a later sequence and cannot apply to signals or account cycles predating its `authorizedAt`.

The database validates PAPER environment, account holder, assignment mirrors, Subscription, Security, TradingView source, binding Strategy, ACTIVE TRADE_ELIGIBLE revision, and active rollout. Identity changes invalidate effective authority. Revocation blocks future admission; Phase 4A.2C must recheck it before uncommitted dispatch.

## Provenance and legacy fail-closed behavior

`OrderIntent.externalSignalAccountCycleId` independently identifies TradingView origin even if obligation evidence is missing or damaged. `ExternalSignalEntryExecutionObligation` freezes the source cycle, ENTRY Signal, route, account cycle, rollout epoch, authorization, and fingerprints. A deferred constraint requires a matching obligation in the same transaction as every marked OrderIntent. Obligation insertion verifies post-epoch/post-authorization acceptance and the obligation is immutable.

The legacy order worker selects only intents with a null origin marker. No marked TradingView intent can reach today's broker path before the later explicit dispatch guard exists.

## Lock-order audit

| Path | Acquisition order |
| --- | --- |
| v2 ingress | source → binding → source cycle parent → account cycle writers |
| correlation | work lease → source → binding → source cycle → account cycle |
| rollout | execution-rollout advisory lock → generation → activation event |
| grant | source → binding/revision → rollout → account → assignment → Subscription → Security → authorization |
| revoke | source → binding → authorization |
| MI admission | runtime rollout → account → assignment → Subscription → Security → MI authorization → entry-exposure advisory lock |
| MI broker dispatch | account/assignment identity and frozen MI authorization → decision/consumption |
| invalidation triggers | changed identity row → affected external authorizations |

Correlation and grant share source-before-binding order. Grant and Market Intelligence share account-before-assignment-before-Subscription-before-Security order; existing Market Intelligence paths do not later acquire source/binding. Rollout activation takes no account/source locks. No contradictory cycle was found, and existing shared order was not changed.

The future admission order remains unapproved. Phase 4A.2B must reconcile cycle locks with the complete Market Intelligence admission transaction before adding locks or calling `admitEntryOrderIntent`; any required reversal needs architecture review.

## Remaining checkpoints

Phase 4A.2B must add admission coordination, fresh authorization/epoch validation, existing risk/sizing admission, and atomic marker/obligation/claim/OrderIntent creation. Phase 4A.2C must add broker-time authorization for the frozen external obligation and evidence consumption before the adapter. Market Intelligence and PAPER broker-write authority remain independent mandatory boundaries.
