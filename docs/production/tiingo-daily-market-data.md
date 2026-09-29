# Tiingo daily Breadth observations

Phase 4 requires an active Tiingo Personal Power or other eligible paid subscription. It stores raw, unadjusted EOD observations for a frozen Breadth revision only. It does not change any Massive consumer or trading behavior. Apply migration `20260928120000_tiingo_retention_purge` before ingestion.

## Backfill

Preview is the default and makes no provider requests or writes. Choose the revision and bounded dates explicitly:

```powershell
npm.cmd run market-data:tiingo:daily:backfill -- --revision=1 --from=2026-09-01 --through=2026-09-25 --symbols=AAPL,MSFT,BF.B
npm.cmd run market-data:tiingo:daily:backfill -- --revision=1 --from=2026-09-01 --through=2026-09-25 --symbols=AAPL,MSFT,BF.B --apply
```

Inspect preview member integrity, selected securities, Tiingo coverage, other-provider overlaps, and expected request count. Symbols must belong to the revision. One range request per selected Security fetches only accepted eligible bars. The full 2,881-symbol historical run is deliberately deferred until small-symbol acceptance and one full eligible daily session have been reviewed. No research horizon is assumed.

Tiingo uses hyphens for one-letter share classes; canonical Security symbols retain dots. Each accepted row is raw `UNADJUSTED`, with its positive split factor and actual receipt time. Non-unit factors also create immutable `MarketSplitEvent` evidence. EOD rows do not create strict no-split coverage intervals. Existing Massive bars cannot be replaced. Identical Tiingo evidence is idempotent; differing evidence is a conflict for operator review.

## Daily sync and status

The separately monitored `tiingo_daily_market_data_sync` worker reads the latest applicable frozen Breadth revision. Today's session is accepted after **20:15 America/New_York**, including early closes; historical dates are immediately eligible. It requests only missing members for the latest eligible session, retries incomplete coverage no more than hourly across restarts, and leaves missing bars missing. `GET /api/market-data/tiingo-daily/status` requires `MARKET_DATA_READ` and reports revision, counts, latest eligible session, timing version, paused state and last run. Worker health and bounded `SystemEvent` summaries show failures, conflicts, retries and throttling. Manual and worker ingestion plus purge share one PostgreSQL advisory lock, so only one run proceeds globally. Within that run, symbol acquisition uses bounded concurrency, with eight active jobs by default, configured by `TIINGO_MAX_CONCURRENCY`. Transient 429, 5xx and transport failures retry at most three times with capped delay; malformed data and canonical conflicts do not retry.

## Retention purge

If the paid subscription ends or is downgraded without separate written retention rights, preview and then explicitly purge:

```powershell
npm.cmd run market-data:tiingo:purge
npm.cmd run market-data:tiingo:purge -- --apply --confirm=DELETE-TIINGO-DATA
```

Apply deletes only Tiingo MarketBars, MarketSplitEvents, and any Tiingo MarketSplitCoverage. It sets a durable ingestion pause in the same transaction. Massive evidence, universes, Securities and trading records remain intact. Normal SQL still rejects immutable evidence UPDATE/DELETE. The trigger permits only Tiingo DELETE with the transaction-local maintenance flag set by the dedicated purge service. After a new eligible paid plan is verified, an operator can explicitly resume with `npm.cmd run market-data:tiingo:purge -- --resume --confirm=PAID-TIINGO-PLAN-ACTIVE`.

Database purge alone is insufficient under Tiingo retention terms. Remove Tiingo data from local artifacts, archives and backups under operator control. This ingestion path creates no raw provider-body cache or log. Keep the worker paused until rights are restored.
