# Broker-Time Market-Policy Evidence (Phase 3B.3A)

Phase 3B.3A adds a broker-stage observational boundary without connecting it to order submission. `OrderIntentBrokerPostOpportunity` means only that the application identified a genuinely new BUY POST opportunity; it does not assert that an adapter was called or Alpaca received an order.

## Frozen identity

The explicit capture service anchors one opportunity in a single PostgreSQL statement snapshot. It reads the exact immutable Phase 3B intent coverage, freezes the original enrollment generation and bound policy revision, and selects the latest committed successful `MARKET_REGIME_COMPOSITION_V1` ordered by target, observation, and ID. `opportunityAt` is database-generated and later freshness evaluation uses that instant. Publication time is never used as a proxy for commit visibility.

Applicability is derived only from frozen coverage and account environment: PAPER `ACTIVE_EXACT` and `SUPERSEDED_COMPARE_ONLY` are applicable; LIVE, unenrolled, unknown, and legacy coverage are explicitly non-applicable. Current enrollment is never queried. Opportunity rows, comparison attempts, gates, and events are immutable and PostgreSQL fixes authority to `COMPARE_ONLY` with `tradingEffect=NONE`.

## Comparison and events

The independent broker comparison worker uses mutable delivery rows for bounded three-attempt leasing and recovery. Exact compositions reuse Phase 2D calculation semantics and complete with five gates. `NONE_VISIBLE` completes as `INSUFFICIENT_EVIDENCE` / `NO_COMPOSITION_VISIBLE` with zero gates under a narrow deferred constraint. Technical failures remain retry evidence and cannot create duplicate completed outcomes.

The append-only event vocabulary separates capture, adapter dispatch, broker confirmation or rejection, delivery uncertainty, definite non-send/deferment, recovery results, and missing observation. Phase 3B.3A writes only `OPPORTUNITY_CAPTURED`; adapter and recovery writers are reserved for later phases. Delivery certainty is not broker order status.

## Rollout and boundary

`OrderIntentBrokerOpportunityCaptureRollout` and `OrderIntentBrokerComparisonRollout` are separate singleton controls, both inserted disabled. PostgreSQL owns their effective epochs and disable timestamps. The process-level `ORDER_INTENT_BROKER_COMPARISON_WORKER_ENABLED` flag is also false by default. Existing intent-time rollout rows are unchanged.

The Phase 3B.3A foundation initially had no live-path caller. None of this evidence authorizes enforcement.

## Phase 3B.3B boundary integration

Phase 3B.3B calls the best-effort capture helper only inside `submitOrderToBroker`, after the stable-client-ID lookup has confirmed absence and immediately before a genuinely new BUY entry adapter dispatch. A successful or inconclusive lookup never captures. Exit and protective-order adapters remain outside this path. Every later POST attempt receives a new per-intent sequence; an abandoned pre-POST anchor is never reused.

Broker-boundary evidence uses a dedicated PrismaPg client backed by a two-connection `pg.Pool` by default (`BROKER_OBSERVATION_POOL_MAX`). The pool has a finite 50 ms acquisition and connection-establishment timeout and is owned and closed by Prisma during graceful shutdown. Prisma reserves a larger 100 ms acquisition window so node-postgres completes timeout cleanup before Prisma can return an acquisition failure. Each backend process adds the configured number of potential PostgreSQL connections; for example, three backend processes at the default add six broker-observation connections in addition to their other pools.

The synchronous pre-POST observation path has one monotonic 250 ms budget shared by opportunity capture, an independently supportable missing-observation fallback, and dispatch evidence. Each operation reserves the pool acquisition bound and derives shorter Prisma transaction, PostgreSQL statement and lock timeouts from the remaining cumulative budget. Work is skipped when insufficient time remains. The code awaits transaction failure and rollback rather than racing or abandoning database promises, so failed work cannot later commit after broker execution continues. Broker authorization, lookup and adapter execution remain outside this optional evidence deadline.

Post-response evidence uses a separate shared 250 ms budget for response and materialization events. Rejection and uncertainty evidence gets its own bounded budget, and persistence failure never replaces the original Alpaca error. Observation failures are logged and swallowed, while the original payload, broker error instance, delivery classification, OrderIntent transitions, and recovery decisions remain unchanged.

The boundary records adapter dispatch (which does not claim broker receipt), confirmed responses, materialized orders, explicit rejection, local non-send/deferment, and uncertain delivery. Stale-submission recovery records found, confirmed absent, or inconclusive lookup results against the latest frozen opportunity. A confirmed absence preserves existing requeue behavior; the next POST gets a fresh opportunity. Comparison remains asynchronous and separately disabled.

Both database rollout rows are disabled on migration. Activation is deliberate and ordered:

```sql
UPDATE "OrderIntentBrokerOpportunityCaptureRollout" SET enabled=true WHERE id=1;
UPDATE "OrderIntentBrokerComparisonRollout" SET enabled=true WHERE id=1;
```

The comparison scheduler additionally requires `ORDER_INTENT_BROKER_COMPARISON_WORKER_ENABLED=true` and a process restart. Capture can be enabled independently for observation-first rollout. Disable either database row with `SET enabled=false`; PostgreSQL records the interval endpoint. No setting grants enforcement authority.

## Phase 3C.3 authoritative boundary

This compare-only evidence remains `COMPARE_ONLY` / `tradingEffect=NONE` and is never
consulted for a broker decision. The separate authoritative broker-time guard
(`docs/architecture/market-policy-broker-time-enforcement.md`) prepares its decision
after the confirmed-absence lookup and before this capture, and consumes its single-use
dispatch authorization after the capture and before `ADAPTER_DISPATCH_REACHED`. A
consumption may cite the captured opportunity. Loss of this telemetry never changes the
authoritative outcome.

## Phase 3B.4A read boundary

`GET /api/order-intents/history` provides SQL-paginated summaries under explicit
trading-account membership scope. `GET
/api/order-intents/:orderIntentId/operational-evidence` returns the frozen intent and
broker comparison evidence for one authorized account. The legacy owner-only
`/api/order-intents` routes retain their existing behavior.

The detail read paginates broker opportunities and broker events, bounds comparison
attempts, and never calls a provider or reconstructs evidence from current state.
Account Users receive outcomes, observed states, health, reasons and historical
identities but not allowed-state policy rules or source-set fingerprints. Operators
receive those technical fields within membership scope. Raw evidence JSON requires
SYSTEM_OWNER and is capped per value. Every response keeps `COMPARE_ONLY` and
`tradingEffect=NONE` explicit; a broker order found without a new POST opportunity is
labelled as a lifecycle-derived presentation state rather than an immutable event.
