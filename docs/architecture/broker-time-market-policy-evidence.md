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

There is deliberately no caller from `submitOrder`, `submitOrderToBroker`, pending-order processing, recovery, risk, sizing, exits, or Alpaca adapters. Phase 3B.3B must explicitly integrate the capture boundary and event writers after owner review; none of this evidence authorizes enforcement.
