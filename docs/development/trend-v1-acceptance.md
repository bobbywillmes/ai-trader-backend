# TREND_V1 local acceptance

Use the existing local owner login/session cookie in Postman or your HTTP client.
Base URL: `http://localhost:3000`. No new UI or collection authentication convention
is required. The worker starts with the backend and may publish before a manual
request; inspect latest first. Do not reset immutable assessment history to repeat
bootstrap: use an isolated migrated test database for a fresh bootstrap.

1. `GET /api/market-data/status` inspects stored SPY/RSP counts and date coverage.
   Both instruments need at least 60 usable aligned daily sessions. More available
   history is replayed. If needed, use the existing owner backfill in bounded ranges:
   `POST /api/market-data/backfill` with `{"from":"2026-01-01","to":"2026-09-16"}`
   (adjust dates to today). Configure current holidays/early closes through the
   existing calendar routes. Massive credentials are required for split evidence,
   even when all daily bars are already stored.
2. `GET /api/market-data/trend-assessments/latest` returns latestAttempt and latestValid.
3. `POST /api/market-data/trend-assessments/run`, with `{}` or no body, runs publication.
   On a fresh complete dataset expect `published: 1`, `attempts: 1`, `blocked: null`.
   A missing later session adds an UNAVAILABLE attempt and stops catch-up there.
4. `GET /api/market-data/trend-assessments?limit=20`, then
   `GET /api/market-data/trend-assessments/<id>`. Inspect sessionDate/targetAt,
   rawState/effectiveState, previousAssessmentId, evidenceJson.thresholdsPercentagePoints,
   spy/rsp, transition, provenance and historicalReplay. A bootstrap has
   `bootstrap: true` and `previousAssessmentId: null`; replay dates are not rows.
5. Repeat POST. If current, expect `published: 0`, `notDue: true`. If blocked on
   unchanged evidence, expect `attempts: 0`, `suppressed: true`, and the same blocked
   reason. A later complete session publishes once and links to the prior VALID row.
6. Inspect System Status worker health or the existing `GET /api/system-status` API
   for `trend_assessment_publication`. A manual call itself does not manufacture a
   worker tick; startup/15-minute monitored runs update WorkerHealthState.
7. In an isolated acceptance database, compare trading tables before/after. The
   integrity tests below do this for OrderIntent, BrokerOrder, BrokerActivity,
   TrackedPosition, Subscription, Signal, SignalDelivery, SignalEvaluation and
   CurrentMarketState. The publisher writes only assessments and associated SystemEvents;
   the monitored wrapper additionally persists worker health. Other concurrently
   running application workers may independently modify their own tables.

Useful read-only SQL (Prisma Studio or your normal PostgreSQL client):

```sql
SELECT s.symbol, count(*) AS bars, min(b."barStartAt"), max(b."barStartAt")
FROM "MarketBar" b JOIN "Security" s ON s.id = b."securityId"
WHERE s.symbol IN ('SPY','RSP') AND b.timeframe = 'DAY_1'
GROUP BY s.symbol;

SELECT id, "sessionDate", "targetAt", attempt, status, "reasonCode",
       "rawState", "effectiveState", "previousAssessmentId", "dataThroughAt", "validUntil"
FROM "MarketRegimeDimensionAssessment"
WHERE dimension = 'TREND' AND "algorithmVersion" = 'TREND_V1'
ORDER BY "targetAt", attempt;

SELECT "targetAt", count(*) FROM "MarketRegimeDimensionAssessment"
WHERE dimension = 'TREND' AND "algorithmVersion" = 'TREND_V1' AND status = 'VALID'
GROUP BY "targetAt" HAVING count(*) > 1;
-- Expected: zero rows.

SELECT * FROM "WorkerHealthState" WHERE "key" = 'trend_assessment_publication';
```

Repeatable real-database acceptance uses randomly named disposable databases,
replays all existing migrations, and never rewrites local authoritative history:

```powershell
$env:RUN_DATABASE_INTEGRITY_TESTS='1'
npm.cmd exec vitest run src/db/__tests__/market-data.integration.test.ts
```

The tests exercise two concurrent publishers, one bootstrap, chronological missing
Tuesday/recovered Tuesday/Wednesday, duplicate suppression, immutable rows, one VALID
per target, same-version predecessor enforcement, and absence of trading writes.
Local DATABASE_URL must allow creating/dropping these isolated databases.

No migration, schema change, frontend build, historical assessment backfill, or
trading configuration change is needed for deployment. Calendar maintenance and
working Massive split access are required. Publication becomes operational at the
first startup/manual run. VOLATILITY_V1 now has its own
[publication acceptance](volatility-v1-acceptance.md); regime consumers remain future work.
