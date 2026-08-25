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

Stable client order IDs, serializable claims, account workflow locks, exact client-ID broker recovery, and delivery-uncertainty classifications reduce duplicate submission risk. However, market and trailing exits currently size from local `TrackedPosition.qty` and do not clamp against a fresh broker-held quantity immediately before submission. Correcting that is separate write-path work.

Local development is structurally observation-only for Live writes because authorization requires production mode and the production-executor role. Database-backed per-account locks coordinate this application, but the application cannot prove that no separate external Live writer exists. Live Operations therefore reports configured deployment policy and never claims exclusive writer ownership.

No database model or continuously persisted “Live Operations assessment” is used; the read model is derived on request from existing durable evidence.
