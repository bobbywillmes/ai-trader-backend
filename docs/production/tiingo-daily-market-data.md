# Tiingo daily Breadth observations

Phase 4 requires an active Tiingo Personal Power or other eligible paid subscription. It stores raw, unadjusted EOD observations for a frozen Breadth revision only. It does not change any Massive consumer or trading behavior. Apply migrations `20260928120000_tiingo_retention_purge` and `20260929120000_tiingo_daily_observation_state` before ingestion.

## Backfill

Preview is the default and makes no provider requests or writes. Choose the revision and bounded dates explicitly:

```powershell
npm.cmd run market-data:tiingo:daily:backfill -- --revision=1 --from=2026-09-01 --through=2026-09-25 --symbols=AAPL,MSFT,BF.B
npm.cmd run market-data:tiingo:daily:backfill -- --revision=1 --from=2026-09-01 --through=2026-09-25 --symbols=AAPL,MSFT,BF.B --apply
```

Inspect preview member integrity, selected securities, Tiingo coverage, other-provider overlaps, and expected request count. Symbols must belong to the revision. One range request per selected Security fetches only accepted eligible bars. Preview each historical chunk before applying it; no research horizon is assumed by ingestion.

For Phase 5A multi-year current-universe historical backcasts, add `--research-history` to both preview and apply. Successful-response gaps are counted as `historicalMissing` without creating operational retry state for possible pre-listing sessions. The run reports `acquisitionMode: RESEARCH_HISTORY`; ordinary backfills and the scheduled worker report `OPERATIONAL` and keep the per-session retry lifecycle. `--research-history` and `--retry-terminal` cannot be combined. See `docs/development/breadth-v2-research.md`.

An expected bar absent from a successful, valid response gets durable state for that Security and session date. The first empty observation schedules a retry in 1 hour; subsequent empty observations schedule 4 hours and 24 hours. A fourth empty observation becomes `NO_EOD_COVERAGE` and stops automatic requests for that pair. This never marks the whole ticker unsupported: later sessions are requested normally. Preview reports planned requests, deferred retries, and terminal gaps without writing or calling Tiingo. To deliberately probe terminal history, add `--retry-terminal` to the preview command, inspect it, then add `--apply`. An empty manual probe remains terminal; an accepted bar resolves the state. Bars remain absent until Tiingo supplies them; Phase 4 creates no synthetic or carried-forward data.

Rare historical gaps remain visible to operators. Phase 5 will decide how BREADTH_V2 handles real observations across them; this acquisition process does not change BREADTH_V1/V2 calculation policy.

Tiingo uses hyphens for one-letter share classes; canonical Security symbols retain dots. Each accepted row is raw `UNADJUSTED`, with its positive split factor and actual receipt time. Non-unit factors also create immutable `MarketSplitEvent` evidence. EOD rows do not create strict no-split coverage intervals. Existing Massive bars cannot be replaced. Identical Tiingo evidence is idempotent; differing evidence is a conflict for operator review.

## Daily sync and status

The separately monitored `tiingo_daily_market_data_sync` worker starts unconditionally and reads the latest applicable frozen Breadth revision. This is an explicitly accepted deployment behavior: when a revision exists, the worker may call Tiingo and persist observation-universe evidence even while the five-symbol canonical daily and Intraday Stress Tiingo cutovers remain unset. It does not activate either canonical cutover, enable the separately default-disabled BREADTH_V2 publisher, or grant trading authority. Production deployments therefore require valid `TIINGO_API_TOKEN` credentials before application workers start.

Today's session is accepted after **20:15 America/New_York**, including early closes; historical dates are immediately eligible. The worker requests never-attempted missing members for the latest eligible session and older due retries. `GET /api/market-data/tiingo-daily/status` requires `MARKET_DATA_READ` and reports the latest session's Tiingo presence, all missing members, untracked missing members, retrying and due retries, terminal no-EOD coverage, and other-provider collisions. Scheduled empty observations and known terminal gaps are normal coverage state, not worker failures. Actual provider failures, conflicts, and canonical collisions fail worker health. Manual and worker ingestion plus purge share one PostgreSQL advisory lock, so only one ingestion or purge run proceeds globally. Within each run, symbol acquisition uses bounded concurrency, with eight active jobs by default, configured by `TIINGO_MAX_CONCURRENCY`. Transient 429, 5xx and transport failures retry at most three times with capped delay; malformed data and canonical conflicts do not advance the missing-observation lifecycle. Actual provider failures use a separate hourly outage gate.

## Retention purge

If the paid subscription ends or is downgraded without separate written retention rights, preview and then explicitly purge:

```powershell
npm.cmd run market-data:tiingo:purge
npm.cmd run market-data:tiingo:purge -- --apply --confirm=DELETE-TIINGO-DATA
```

Apply deletes only Tiingo MarketBars, MarketSplitEvents, any Tiingo MarketSplitCoverage, and TiingoDailyObservationState rows. Preview reports all four counts. It sets a durable ingestion pause in the same transaction. Massive evidence, universes, Securities and trading records remain intact. Normal SQL still rejects immutable evidence UPDATE/DELETE. The trigger permits only Tiingo DELETE with the transaction-local maintenance flag set by the dedicated purge service. After a new eligible paid plan is verified, an operator can explicitly resume with `npm.cmd run market-data:tiingo:purge -- --resume --confirm=PAID-TIINGO-PLAN-ACTIVE`.

Database purge alone is insufficient under Tiingo retention terms. Remove Tiingo data from local artifacts, archives and backups under operator control. This ingestion path creates no raw provider-body cache or log. Keep the worker paused until rights are restored.
