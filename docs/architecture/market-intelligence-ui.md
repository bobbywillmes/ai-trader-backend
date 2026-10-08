# Market Intelligence UI

Phase 1 exposes immutable production assessment evidence without adding Market Regime composition or trading authority.

`GET /api/market-data/intelligence/summary` requires `marketData.read`. It reports the latest publication attempt and latest valid assessment independently for TREND_V1, VOLATILITY_V1, BREADTH_V1, PARTICIPATION_V1 and INTRADAY_STRESS_V1. It also reports the version-isolated BREADTH_V2 shadow chain, its measurement evidence, readiness and worker status in a separate section.

`evaluatedAt` is the server observation time. Assessment identities are read in one read-only repeatable-read transaction. The dimensions are published independently, so the response is not a synchronized market snapshot. Breadth V2 readiness is evaluated independently after that identity read and is not represented as transactionally simultaneous with it.

The latest attempt is always current publication evidence, including `UNAVAILABLE` and `FAILED` attempts. The latest valid assessment is historical context only and must never replace the latest attempt. Persisted `validUntil` determines expiration, but an unexpired row does not prove that it covers the latest expected market session. Clients display target, evidence-through and publication timestamps so operators can judge currency without inference.

The UI is read-only. Research outputs, including Trend Lab, never supply production state. Assessment state, evidence/readiness health and future trading authority remain separate concepts. BREADTH_V2 is labeled shadow-only and is not included among the five V1 dimension summaries.
