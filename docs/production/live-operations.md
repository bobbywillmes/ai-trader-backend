# Live Operations

`/live-operations` is a read-only operational view for accessible Live trading accounts. It answers whether current exposure is being observed and managed safely without granting authority or initiating broker actions.

## Separate state domains

- Historical ceremony evidence remains immutable in Live Entry Acceptance runs on the account Readiness tab. A completed canary is historical proof, not current health.
- Operational health is continuously derived from tracked exposure, attribution, exit state, reconciliation, and account-scoped worker evidence.
- Authorization remains explicit in Live write approvals and entry arming. Missing `RISK_REDUCING` authority is `NOT_AUTHORIZED`; it becomes action-requiring only when a risk-reducing action is waiting. A disarmed entry posture after a completed canary is healthy.

Trading Account pages continue to own identity, configuration, credentials, allocations, subscriptions, memberships, and risk limits. Readiness owns assessments, approvals, entry arming, and acceptance history. Live Operations owns current exposure and monitoring conclusions. Open Positions and Reconciliation retain complete records.

## Status and freshness semantics

Operational health uses `HEALTHY`, `DEGRADED`, `ACTION_REQUIRED`, and `UNKNOWN`. Capability uses `READY`, `NOT_AUTHORIZED`, `BLOCKED`, and `NOT_APPLICABLE`. Evidence is `CURRENT`, `STALE`, or `EXPIRED` using the existing worker timing definitions. Stale evidence is never presented as healthy. Worker and reconciliation failures become more severe when Live exposure exists.

The overview never blends account conclusions: it reports counts and worst severity while retaining an independent snapshot and next action for every account. It does not aggregate dollar P&L.

## Exit-path audit limitations

Exit evaluation is exposure-driven and continues when account trading is disabled. The kill switch and account trading flag gate entries, not risk-reducing evaluation. Live risk-reducing writes are finally gated in the Alpaca client by production mode, `PRODUCTION_EXECUTOR`, `ALLOW_LIVE_RISK_REDUCING_WRITES`, and effective `RISK_REDUCING` approval. A due decision can therefore create durable local submitting/failed state before final authorization refuses delivery; later polling and broker lookup recovery reconsider it.

Stable client order IDs, serializable claims, and delivery-uncertainty classifications reduce duplicate submission risk. Every new equity sell now crosses the shared account-scoped `EXIT_SUBMISSION` lock and recovers the stable client ID before inspecting quantity. It then requires an exact full-position match among local intended quantity, Alpaca-held `qty`, and Alpaca `qty_available`, rejects unrelated active sell reservations, rechecks final Live risk-reducing authorization, and submits `position_intent=sell_to_close`. Missing or ambiguous broker evidence fails closed; quantity is never clamped and an available residual is never sold.

A block during recovery or verification occurs before broker delivery: the
OrderIntent becomes non-pending, the tracked position returns to `open`, and no
delivery-uncertain event is emitted. Repeated active reservations refresh one
account/position condition episode even though each attempt has its own intent
evidence. Authoritative reconciliation may resolve the episode after fresh
position and open-order reads prove the reservation is gone, but cancellation or
resolution never submits another sell. The external untracked-order warning
remains immutable historical evidence.

Local development is structurally observation-only for Live writes because authorization requires production mode and the production-executor role. Database-backed per-account locks coordinate this application, but the application cannot prove that no separate external Live writer exists. Live Operations therefore reports configured deployment policy and never claims exclusive writer ownership.

If Alpaca reports a short equity position, AI Trader blocks further sell automation,
does not normalize the short into a managed long, and does not automatically buy
to cover. Reconciliation and position observation open or refresh account-scoped
authoritative-only Operational Attention with sanitized broker side and quantity
evidence. Resolve the broker condition externally and confirm it through a complete
authoritative reconciliation. The separate **Close remaining broker position**
workflow is deferred and is not available from Operational Attention.

No database model or continuously persisted “Live Operations assessment” is used; the read model is derived on request from existing durable evidence.

## Environment authority and health scope

Every response identifies the application environment and deployment role as separate sanitized facts. Only `NODE_ENV=production` together with `PRODUCTION_EXECUTOR` is the authoritative Live executor. Production observer processes remain observers, and non-production processes do not become authoritative based on browser location or frontend build mode. Live-entry and risk-reducing policy conclusions expose only derived `ALLOWED` or `OBSERVATION_ONLY` states; secrets and credential configuration are never returned.

Health is scoped to the current environment. An observation-only view reports its local database, workers, and broker-read evidence, but it does not certify production-executor health.

An externally originated Live position can be observed locally without the production-owned OrderIntent, BrokerOrder, assignment, subscription, or frozen entry-time configuration. In an observer, that causal chain is presented as `EXPECTED_OBSERVATION_LIMITATION`: lifecycle evidence is `UNAVAILABLE_LOCALLY`, exit capability is `OBSERVATION_ONLY`, reconciliation is `NOT_AUTHORITATIVE`, and production health is `UNKNOWN_FROM_THIS_ENVIRONMENT`. The raw reconciliation diagnostic remains available, but no local repair is recommended.

This contextual exception is narrow. Broker-read failure, invalid read credentials, stale synchronization, broker/local quantity disagreement, cross-account inconsistency, and unrelated worker failures retain degraded or action-required severity. The same missing attribution, configuration snapshot, or exit profile remains `ACTION_REQUIRED` in the authoritative production executor; observation semantics do not weaken production safety behavior.
