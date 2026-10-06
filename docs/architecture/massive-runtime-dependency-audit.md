# Remaining Massive runtime dependencies (Phase 9A freeze)

| Callsite | Massive operation | Classification | Phase 9A authority |
| --- | --- | --- | --- |
| `momentum-price-confirmation.service.ts` | Snapshot and adjusted, extended-hours one-minute aggregates via `getTickerPriceConfirmationMarketData` | RESEARCH_DECISION | Massive; session VWAP remains required |
| `momentum-market-chart.service.ts` | `getTickerAggregateBars`, `getTickerDailyCandles` | DISPLAY_ONLY | Massive |
| `account-subscription-market-context.service.ts` | `getTickerLatestPrice`, `getTickerDailyCandles` | ADMIN_ESTIMATE | Massive |
| `account-subscription-runtime-sizing.service.ts` | Shared trading reference-price policy | TRADING_CRITICAL | Tiingo consolidated `TIINGO_TNGO_LAST`; every rejection fails sizing, no fallback |
| `trading-account-risk-health.service.ts` | Shared trading reference-price policy for `FIXED_QTY` | TRADING_CRITICAL | Tiingo consolidated `TIINGO_TNGO_LAST`; outside-session non-evaluability is informational, in-session failures retain environment severity, no fallback |
| `dashboard.controller.ts` | `getIndexPerformance`, `getIndexIntraday` | DISPLAY_ONLY | Massive |
| Massive News worker and catalyst ingestion | Reference news | DISABLED_RUNTIME | Disabled by default; separate retirement decision |
| BREADTH_V1 observation and bootstrap | Grouped bars and point-in-time universe | LEGACY/RESEARCH | Unchanged; BREADTH_V2 shadow independent |
| `src/dev/` and research scripts | Provider references and cached studies | LEGACY/RESEARCH | Not production authority |
| Manual split/bootstrap tools | Split history | LEGACY/RESEARCH | Operator tools only |
| Phase 7A/8 pre-cutover acquisition | SPY/RSP minute, five-symbol daily | LEGACY/RESEARCH | Explicit session-date Massive authority before each independent cutover |

This table originated as the Phase 9A freeze and records later accepted cutovers in place. Runtime sizing and Risk Health now share the Tiingo-only trading-price service selected in Phase 9B.4B; the remaining listed Massive consumers keep their prior authority. The Massive adapter and its adjusted daily candle semantics remain intact. Phase 8 raw `MarketBar` DAY_1 evidence cannot replace arbitrary-symbol adjusted chart history. There is no realtime provider fallback or general-purpose provider selector.

