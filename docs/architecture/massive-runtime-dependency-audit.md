# Remaining Massive runtime dependencies (Phase 9A freeze)

| Callsite | Massive operation | Classification | Phase 9A authority |
| --- | --- | --- | --- |
| `momentum-price-confirmation.service.ts` | Snapshot and adjusted, extended-hours one-minute aggregates via `getTickerPriceConfirmationMarketData` | RESEARCH_DECISION | Massive; session VWAP remains required |
| `momentum-market-chart.service.ts` | `getTickerAggregateBars`, `getTickerDailyCandles` | DISPLAY_ONLY | Massive |
| `account-subscription-market-context.service.ts` | `getTickerLatestPrice`, `getTickerDailyCandles` | ADMIN_ESTIMATE | Massive |
| `account-subscription-runtime-sizing.service.ts` | `getTickerLatestPrice` | TRADING_CRITICAL | Massive; missing positive price still fails sizing |
| `trading-account-risk-health.service.ts` | `getTickerLatestPrice` | TRADING_CRITICAL | Massive; missing positive price still fails readiness |
| `dashboard.controller.ts` | `getIndexPerformance`, `getIndexIntraday` | DISPLAY_ONLY | Massive |
| Massive News worker and catalyst ingestion | Reference news | DISABLED_RUNTIME | Disabled by default; separate retirement decision |
| BREADTH_V1 observation and bootstrap | Grouped bars and point-in-time universe | LEGACY/RESEARCH | Unchanged; BREADTH_V2 shadow independent |
| `src/dev/` and research scripts | Provider references and cached studies | LEGACY/RESEARCH | Not production authority |
| Manual split/bootstrap tools | Split history | LEGACY/RESEARCH | Operator tools only |
| Phase 7A/8 pre-cutover acquisition | SPY/RSP minute, five-symbol daily | LEGACY/RESEARCH | Explicit session-date Massive authority before each independent cutover |

The six direct-data production consumers import `live-market-data.service.ts`. That entrypoint remains statically Massive-backed in Phase 9A. The Massive adapter and its adjusted daily candle semantics remain intact. Phase 8 raw `MarketBar` DAY_1 evidence cannot replace arbitrary-symbol adjusted chart history. There is no realtime provider fallback, cutover option, or trading-price selector.

