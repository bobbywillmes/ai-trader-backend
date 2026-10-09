# Strategy Market Eligibility V1

`STRATEGY_MARKET_ELIGIBILITY_V1` records immutable, strategy-specific interpretations of the five-source `MARKET_REGIME_COMPOSITION_V1` evidence vector. It is strictly `SHADOW_ONLY`: an `ALLOWED` outcome is not permission to route a signal, pass risk, size a position, or submit an order.

Database integrity is defense in depth. Evaluated decisions with a policy and composition must commit exactly five ordered authoritative gates whose requirements and allowed states match the referenced policy revision and whose source identity matches the referenced composition. `NO_ACTIVE_POLICY` and `NO_COMPOSITION` are the only zero-gate forms. Route attempts must match the route's Signal strategy and, when completed, a decision whose context identity names that exact route. Migration `20261010180000_phase2_integrity_corrections` validates existing rows before installing these deferred checks and performs no historical backfill or repair.

## Semantics

Every evaluation pins the active `StrategyMarketPolicyRevision`, applicable `MarketRegimeAssessment`, deterministic context, evaluator version, strategy catalog enablement, and five snapshotted rule gates. `IGNORED` gates never affect the result. A required unavailable, failed, stale, invalid, missing, or expired source produces `INSUFFICIENT_EVIDENCE`; a healthy state outside the policy allow-list produces `BLOCKED`. Insufficient evidence takes precedence over blocked, then all remaining required gates must pass for `ALLOWED`.

Composition `DEGRADED` status is not itself disqualifying. Eligibility is based only on required gates. Source expiration is recomputed at evaluation time, and decision validity cannot exceed the earliest required passing source expiration.

No active policy is an on-demand `INSUFFICIENT_EVIDENCE / NO_ACTIVE_POLICY` result. The scheduler evaluates only strategies with active policies (including disabled catalog strategies), preventing repetitive no-policy evidence rows.

## Identity, concurrency, and history

The decision fingerprint includes strategy, exact policy revision, exact composition, context identity, evaluator version, outcome, and canonical gate evidence. Unchanged polling reuses the same row. Expiration-driven health changes, a new composition/source attempt, or a newly activated policy changes that identity and produces a new row. Serializable evaluation plus the unique fingerprint resolves concurrent triggers safely.

Database triggers reject updates and deletes of decisions and gates. Foreign keys preserve exact policy, composition, and dimension-assessment relationships. Historical outcomes remain immutable; APIs separately report whether the latest recorded result is currently applicable, expired, policy-superseded, or composition-superseded.

## Worker and APIs

The independently monitored `strategy_market_eligibility_shadow` worker runs at startup and every five minutes as bounded recovery. It reads stored policy/composition evidence only. It does not import or call signal, routing, risk, sizing, account, broker, order, or position services.

Read-only endpoints use existing `MARKET_DATA_READ` and `STRATEGY_READ` boundaries:

- `/api/market-data/strategy-eligibility/current`
- `/api/market-data/strategy-eligibility/decisions`
- `/api/market-data/strategy-eligibility/decisions/:decisionId`
- `/api/strategies/:id/market-eligibility/current`
- `/api/strategies/:id/market-eligibility/decisions`
- `/api/strategies/:id/market-eligibility/decisions/:decisionId`

Phase 2E may consume this evidence from signal evaluation. Phase 2D itself has no trading consumer.
