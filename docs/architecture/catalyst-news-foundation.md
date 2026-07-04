# Catalyst News Foundation

Phase 1 added backend storage and manual ingestion for market catalysts and
news.

Phase 2 added an optional backend worker for polling Massive reference news for
watched stock symbols.

Phase 3 adds backend-only `MomentumCandidate` storage and candidate generation
from existing catalyst ticker impacts. It does not add n8n triggers, admin UI
pages, price or volume confirmation, final scoring, broker behavior, or trading
behavior.

## Purpose

The catalyst foundation gives the backend a durable place to store market news
from multiple sources before that data is used by future scanner, ranking, or
review workflows.

Initial ingestion supports Massive `/v2/reference/news` payloads through a
protected admin endpoint:

```http
POST /api/catalyst-events/ingest/massive-news
```

Phase 2 can also pull Massive news through the disabled-by-default worker. A
protected admin endpoint can run one worker cycle manually for testing:

```http
POST /api/catalyst-events/workers/massive-news/run-once
```

The payload is stored as `CatalystEvent` records with related
`CatalystTickerImpact` rows. Events dedupe on:

```text
CatalystSource.MASSIVE_NEWS + article.id
```

The list and detail endpoints expose stored events with ticker impacts:

```http
GET /api/catalyst-events
GET /api/catalyst-events/:id
```

Supported list filters include `symbol`, `source`, `eventType`, `eventTier`,
and `limit`.

## Data Model

`CatalystEvent` stores source-level article data:

- source and source external id
- source URL, publisher, and author
- title, summary, excerpt, and language
- published and received timestamps
- catalyst type, tier, sentiment, and confidence placeholders
- raw source payload and metadata

`CatalystTickerImpact` stores per-symbol context:

- symbol
- sentiment and sentiment reasoning
- simple Phase 1 scores
- primary/company/market/sector flags
- catalyst role and blocked reason placeholders
- raw source insight and metadata

`NewsPullCursor` stores future worker state:

- source and symbol
- enabled flag and priority
- pull interval
- last pulled and last published timestamps
- last source cursor
- error counters and metadata

`MomentumCandidate` stores catalyst-backed momentum opportunities for operator
review:

- symbol and candidate state
- optional links to `CatalystEvent` and `CatalystTickerImpact`
- catalyst, price action, volume, risk, and total scores
- reason and blocked reason fields
- discovered, evaluated, and expiration timestamps
- raw snapshot and metadata

Phase 3 candidate scoring is intentionally simple. `catalystScore` is copied
from `CatalystTickerImpact.totalCatalystScore`; `totalScore` currently equals
`catalystScore`; `priceActionScore`, `volumeScore`, and `riskScore` remain `0`
until a later confirmation phase.

## Phase 2 Massive News Worker

The Massive news worker polls `/v2/reference/news` for watched stock symbols and
passes the raw Massive payload into the same `ingestMassiveNewsPayload` service
used by manual ingestion.

The worker is registered as `massive_news_ingestion` in worker health and is
informational. It is disabled by default and must be enabled explicitly with:

```text
MASSIVE_NEWS_WORKER_ENABLED=true
```

Other worker settings:

```text
MASSIVE_NEWS_WORKER_INTERVAL_MS=60000
MASSIVE_NEWS_LOOKBACK_MINUTES=240
MASSIVE_NEWS_LIMIT_PER_SYMBOL=50
MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN=5
```

Each run:

- ensures watched `NewsPullCursor` rows for `CatalystSource.MASSIVE_NEWS`
- selects enabled due cursors
- bounds work by `MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN`
- uses `lastPublishedAt` when present
- otherwise falls back to `now - MASSIVE_NEWS_LOOKBACK_MINUTES`
- requests Massive news sorted by `published_utc` ascending
- ingests returned articles through the existing catalyst ingestion service
- updates cursor success or error state per symbol

The worker is idempotent because article storage dedupes on
`CatalystSource.MASSIVE_NEWS + article.id` and ticker impacts upsert by
`catalystEventId + symbol`.

## News Pull Cursor Behavior

A cursor is due when:

- `enabled = true`
- `lastPulledAt` is null, or the configured `pullIntervalMin` has elapsed

Due cursors are ordered by:

- `priority` descending
- `lastPulledAt` ascending with nulls first
- `symbol` ascending as a stable tie-breaker

After a successful pull:

- `lastPulledAt` is set to the run timestamp
- `lastPublishedAt` is updated to the newest returned article timestamp when
  articles are returned
- `consecutiveErrors` is reset to `0`
- `lastError` is cleared

After a failed per-symbol pull:

- `consecutiveErrors` increments
- `lastError` stores a concise message
- `lastPulledAt` is left unchanged

Ensuring cursors creates missing rows but does not re-enable an existing cursor
that an operator has disabled.

## Initial Watched Symbols

The worker seeds a small static stock watch universe:

```text
AAPL, AMZN, GOOG, GOOGL, META, MSFT, NVDA, TSLA, AMD, MU, DELL, AVGO, PLTR, SOFI, SNOW
```

It also includes:

- symbols from open or closing tracked positions
- symbols from enabled stock subscriptions

ETFs are not included by default unless they appear through open/closing
tracked positions. Enabled subscription expansion is limited to `AssetType.STOCK`.

## Phase 1 Scoring

Scoring is intentionally simple. The ingestion service currently assigns basic
source quality, freshness, relevance, and actionability scores so records are
usable for review and early sorting.

The final momentum scoring algorithm is deferred.

## Phase 3 Momentum Candidates

Momentum candidates identify catalyst-backed symbols that may deserve follow-up
review. They are generated only from existing `CatalystTickerImpact` rows and do
not call n8n, create signals, create trades, submit orders, or interact with the
broker.

Generation starts conservatively:

- only `CatalystSentiment.POSITIVE` impacts are eligible
- `totalCatalystScore` must meet the configured threshold
- symbol must be present
- `CatalystTickerRole.TANGENTIAL_MENTION` is skipped
- impacts with `blockedReason` are skipped

Generation is idempotent by upserting candidates on `symbol + catalystImpactId`.
Re-running generation refreshes the candidate score snapshot and expiration
timestamp instead of creating duplicate candidates for the same catalyst impact.

Candidates default to expiring after 24 hours. Expiration marks stale active
records as `EXPIRED`; records are not deleted.

Protected admin endpoints:

```http
GET /api/momentum-candidates
GET /api/momentum-candidates/:id
POST /api/momentum-candidates/generate-from-catalysts
POST /api/momentum-candidates/expire-stale
```

These endpoints are for backend verification and review workflows only. There is
no admin UI page in Phase 3.

## Future Sources

The schema is source-flexible. Planned or reserved sources include:

- `MASSIVE_BENZINGA`
- `SEC_EDGAR`
- `COMPANY_IR`
- `MANUAL`

Future ingestion should keep raw source payloads intact, avoid guessing
ambiguous ticker attribution, and prefer explicit source identifiers for
dedupe.

## Deferred Work

The following remain intentionally out of scope after Phase 3:

- n8n webhook triggers
- price and volume confirmation
- admin UI pages
- final momentum scoring
- automated candidate handoff
- trading decisions or order behavior
