# Historical split bootstrap for authoritative assessments

Phase 2 moves TREND_V1, VOLATILITY_V1, PARTICIPATION_V1, and the INTRADAY_STRESS_V1 daily ATR baseline to persisted `MarketSplitEvent` evidence. No market bar ingestion or provider authority changes here. The bootstrap uses the strict Massive split endpoint only when an operator invokes the command. Publishers make no split provider requests.

## Required range and representation

The command takes each of the five production daily evidence symbols (`SPY`, `QQQ`, `DIA`, `IWM`, `RSP`) from its first accepted Massive `DAY_1` MarketBar through the selected date (today by default). This covers Trend and Volatility's persisted `inputFrom`, Participation's rolling 20-full-session baseline, and Intraday Stress's 400-calendar-day prior ATR window plus its current session. On the local production-like database inspected on 2026-09-25, SPY/RSP begin **2021-09-16** and QQQ/DIA/IWM begin **2025-01-02**; the latest accepted bars were 2026-09-24. The default through date on that day is **2026-09-25**, including the current Intraday Stress session. The command derives starts from the target database rather than hard-coding those dates.

The strict Massive response provides `splitFrom`, `splitTo`, and `priceFactor = splitFrom / splitTo`. The canonical `MarketSplitEvent.splitFactor` stores the inverse, `splitTo / splitFrom` (new shares per old share), to match the Tiingo daily factor convention. A 1-for-2 provider ratio yields canonical 2 and calculation price factor 0.5; a 10-for-1 reverse ratio yields canonical 0.1 and calculation price factor 10. The persisted decimal has ten fractional digits, so the bootstrap rejects a ratio that cannot be represented within its stated tolerance. Publisher evidence uses the persisted event ID and canonical factor, then reconstructs the calculation ratio as its inverse.

`MarketSplitCoverage` is immutable proof that a strict provider request completed over a date interval, even if it found zero events. The shared reader requires complete daily coverage and rejects corrupt or mixed-provider rows. This is necessary because absence of a split event alone cannot distinguish no split from an unqueried range.

## Operator procedure

Apply both Phase 0/1 and Phase 2 migrations before running the command. Keep the existing Massive credential available. Perform preview, review all five ranges and pending counts, then explicitly apply:

```powershell
npm.cmd run splits:bootstrap -- --through=2026-09-25
npm.cmd run splits:bootstrap -- --through=2026-09-25 --apply
npm.cmd run splits:bootstrap -- --through=2026-09-25
```

Omit `--through` to cover the current Eastern date. Preview makes no evidence writes. Apply acquires a transaction advisory lock and inserts canonical events and all five coverage records atomically. Repeating an identical apply is a no-op. Any mismatched existing event, missing returned event, duplicate provider identity/date, invalid ratio, or conflicting coverage aborts the whole transaction. Neither event nor coverage is rewritten.

Verify with read-only SQL:

```sql
SELECT s.symbol, c."fromDate", c."throughDate", c.provider
FROM "MarketSplitCoverage" c JOIN "Security" s ON s.id=c."securityId"
WHERE s.symbol IN ('SPY','QQQ','DIA','IWM','RSP') ORDER BY s.symbol,c."fromDate";

SELECT s.symbol,e."executionDate",e."splitFactor",e.provider,e.provenance
FROM "MarketSplitEvent" e JOIN "Security" s ON s.id=e."securityId"
WHERE s.symbol IN ('SPY','QQQ','DIA','IWM','RSP') ORDER BY s.symbol,e."executionDate";
```

The local persisted assessment evidence inspected on 2026-09-25 contained no split events for these symbols through 2026-09-24. A prior local Massive research cache showed empty split responses through 2026-09-18. These observations are advisory, not a substitute for a successful strict bootstrap preview; the actual expected canonical count is the preview's per-symbol `providerEvents`. The local preview attempt on 2026-09-25 failed at the Massive request boundary, so no bootstrap was applied to that database.

## Rollout and ongoing coverage

Run successful preview/apply before starting this Phase 2 publisher code. Without coverage, affected publishers fail closed with `SPLIT_EVIDENCE_UNAVAILABLE`. Intraday Stress requires coverage through its current session, even when the latest daily bar is yesterday's. After the selected through date, rerun the explicit bootstrap for each new session until a later phase adds durable split acquisition alongside new daily evidence. Otherwise assessment publication will intentionally stop at the uncovered date. Do not treat a zero event count as proof of coverage without the corresponding coverage rows.

The additive `splitEvidenceSource: MARKET_SPLIT_EVENT` marker identifies new assessment evidence and participates in its canonical hash where that hash includes source provenance. `evidenceSchemaVersion` remains 1 because the existing split arrays and continuation fields keep their structure; the marker is optional for older immutable assessments. Historical assessment rows and their hashes are never rewritten.
