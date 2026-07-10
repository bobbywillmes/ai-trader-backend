# Momentum Scanner Architecture

The Momentum Scanner is a review-only market/news pipeline. It collects catalyst-style news, scores ticker-specific impacts, checks whether price and volume confirm the catalyst, and prepares durable handoffs for n8n to review in Slack.

This document describes the current system state. It is not a phase log.

## 🎯 Purpose

The scanner is designed to help identify stocks with possible short-term momentum after a catalyst appears in the market/news flow.

The current foundation supports:

- Massive news ingestion
- source-level catalyst storage
- per-ticker catalyst impact scoring
- momentum candidate generation
- price and volume confirmation
- handoff queue records for n8n
- review-only Slack alerts through n8n
- Admin UI inspection and manual smoke testing

The system is intentionally conservative. It surfaces review candidates; it does not trade them.

## 🛡️ Safety Boundaries

The Momentum Scanner is review-only.

It does **not**:

- create entry signals
- create order intents
- submit broker orders
- call Alpaca for order placement
- create broker activity
- change trading settings
- enable paper or live trading
- automatically buy or sell anything

The Admin UI pipeline controls are smoke-test controls only.

The n8n Momentum Scanner workflow uses the signal automation route group and the `signal-key` header. It does not use admin credentials.

## 🧭 Pipeline Overview

```text
NewsPullCursor
  -> Massive news worker
  -> CatalystEvent
  -> CatalystTickerImpact
  -> MomentumCandidate
  -> MomentumCandidatePriceCheck
  -> MomentumScannerHandoff
  -> n8n Momentum Scanner Review
  -> Slack review alert
  -> mark handoff SENT / FAILED
```

High-level flow:

1. `NewsPullCursor` tells the news worker which source + symbol pairs are due.
2. The Massive news worker pulls recent news for due symbols.
3. News articles are normalized into `CatalystEvent` rows.
4. Per-symbol article insights become `CatalystTickerImpact` rows.
5. Strong positive impacts generate or refresh `MomentumCandidate` rows.
6. Price confirmation checks Massive market data and writes `MomentumCandidatePriceCheck` history.
7. Candidates that remain strong enough become `ENTRY_READY`.
8. `ENTRY_READY` candidates can be prepared as `MomentumScannerHandoff` queue records.
9. n8n pulls currently valid `PENDING` handoffs, sends Slack review alerts, and marks successful deliveries as `SENT`.

## 🧱 Data Model Roles

### `MomentumUniverseMember`

`MomentumUniverseMember` is the explicit, database-backed research universe for the Momentum Scanner.

It answers:

```text
Should the Momentum Scanner actively research this Security?
```

Each member has a unique relation to `Security` and stores independent controls for overall membership, news coverage, price scanning, polling priority, pull interval, reason, and operator notes.

This model is intentionally separate from `Subscription`. A subscription answers whether a configured strategy exists through which a security can be traded. Universe membership answers whether the scanner should research it. A security can therefore be researched without any subscription, and adding universe membership does not make it tradable.

### `NewsPullCursor`

`NewsPullCursor` is internal worker state. It is not a catalyst, candidate, or review artifact.

It answers:

```text
For this source + symbol, when should the worker pull news again, and where did it leave off?
```

It tracks:

- source
- symbol
- enabled flag
- priority
- pull interval
- last pulled timestamp
- last published timestamp
- last source cursor
- consecutive error count
- last error
- metadata

This keeps source-specific polling state out of `Security` and out of the catalyst/candidate domain chain.

`NewsPullCursor` is not the owner of research membership. Universe synchronization creates, enables, updates, or disables the required cursor rows while preserving ordinary polling progress, source checkpoints, and error state.

### `CatalystEvent`

`CatalystEvent` stores a normalized source-level news/catalyst record.

It includes:

- source and external source id
- source URL
- publisher and author
- title, summary, body excerpt, and language
- published and received timestamps
- catalyst type, tier, sentiment, and confidence placeholders
- duplicate tracking
- raw source payload
- metadata

Massive news articles dedupe on:

```text
CatalystSource.MASSIVE_NEWS + article.id
```

### `CatalystTickerImpact`

`CatalystTickerImpact` stores per-symbol interpretation of a catalyst event.

It includes:

- symbol
- sentiment
- catalyst role
- sentiment reasoning
- freshness, relevance, actionability, source-quality, and total catalyst scores
- primary/company/market/sector flags
- blocked reason placeholders
- raw insight
- metadata

This table is the bridge between source-level news and symbol-level momentum review.

### `MomentumCandidate`

`MomentumCandidate` stores the current review summary for one catalyst-backed momentum opportunity.

It includes:

- symbol
- candidate state
- optional links to `CatalystEvent` and `CatalystTickerImpact`
- catalyst, price action, volume, risk, and total scores
- reason and blocked reason
- discovered, evaluated, and expiration timestamps
- latest raw snapshot
- metadata

This is a summary table. It reflects the latest candidate state, not every historical evaluation.

### `MomentumCandidatePriceCheck`

`MomentumCandidatePriceCheck` stores append-only price and volume confirmation history.

It includes:

- linked candidate
- symbol
- observed timestamp
- last price
- previous close
- percent move from previous close
- intraday high and low
- distance from high
- session VWAP and above-VWAP flag
- day volume and dollar volume
- relative-volume placeholder
- recent move and recent volume
- price action, volume, risk, and total confirmation scores
- confirmed flag
- decision and blocked reason
- raw Massive payload
- metadata

Each confirmation creates a history row. The related `MomentumCandidate` stores only the latest summary fields.

### `MomentumScannerHandoff`

`MomentumScannerHandoff` is the durable review/delivery queue for n8n.

It includes:

- linked `MomentumCandidate`
- symbol
- handoff status
- payload version
- prepared payload snapshot
- prepared, sent, acknowledged, and failed timestamps
- attempts
- last error
- idempotency key
- metadata

The payload is a point-in-time snapshot. Current candidate eligibility is still checked before delivery to prevent stale alerts.

## 📰 Massive News Ingestion

The Massive news worker pulls `/v2/reference/news` for watched stock symbols and sends the raw Massive response through the same ingestion service used by manual ingestion.

The worker:

- ensures watched `NewsPullCursor` rows for `CatalystSource.MASSIVE_NEWS`
- selects enabled due cursors
- bounds work by max symbols per run
- uses `lastPublishedAt` when available
- otherwise falls back to a configured lookback window
- requests Massive news sorted by `published_utc` ascending
- ingests returned articles into `CatalystEvent` and `CatalystTickerImpact`
- updates cursor success/error state per symbol

The worker is idempotent because article storage dedupes on source + external id, and ticker impacts upsert by catalyst event + symbol.

### Worker Settings

```text
MASSIVE_NEWS_WORKER_ENABLED=false
MASSIVE_NEWS_WORKER_INTERVAL_MS=60000
MASSIVE_NEWS_LOOKBACK_MINUTES=240
MASSIVE_NEWS_LIMIT_PER_SYMBOL=50
MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN=5
```

The worker can also be run manually through admin or signal automation routes.

### Research Universe And Operational Coverage

The normal research universe comes from enabled `MomentumUniverseMember` rows whose `newsEnabled` flag is also enabled. Symbols are resolved through the related `Security`; there is no hard-coded application ticker list.

Cursor synchronization combines three coverage sources:

- explicit database universe membership, which is the canonical permanent research universe
- enabled stock subscriptions, retained as derived runtime coverage for compatibility with existing scanner behavior
- open or closing tracked positions, retained as temporary operational coverage even without explicit membership

Subscription-derived and position-derived coverage do not create hidden `MomentumUniverseMember` rows. When sources overlap, synchronization creates only one source/symbol cursor and uses the highest priority and shortest required pull interval. Disabling or removing explicit membership disables its managed cursor only when no subscription or open/closing position still requires coverage.

Synchronization updates cursor enablement, priority, interval, and coverage metadata. It does not reset `lastPulledAt`, `lastPublishedAt`, `lastSourceCursor`, `consecutiveErrors`, or `lastError`. Cursors that are no longer covered are disabled rather than deleted.

The original 15-symbol application list was migrated as `IMPORTED` universe membership:

```text
AAPL, AMZN, GOOG, GOOGL, META, MSFT, NVDA, TSLA,
AMD, MU, DELL, AVGO, PLTR, SOFI, SNOW
```

The migration reuses existing `Security` records. `SOFI` and `SNOW`, which were absent from the repository security seed, are inserted idempotently before membership is created. The development seed mirrors this initialization for new databases.

## 🔎 Catalyst Events and Ticker Impacts

Catalyst ingestion stores the article once and creates one impact row per symbol found in the source payload.

Early scoring is intentionally simple. It gives records enough structure for review and sorting, but it is not the final momentum model.

Current scoring fields include:

- source quality
- freshness
- relevance
- actionability
- total catalyst score

Only positive and sufficiently scored impacts are eligible for candidate generation.

## 🚀 Momentum Candidates

Momentum candidates are generated from existing `CatalystTickerImpact` rows.

Generation is conservative:

- impact sentiment must be positive
- total catalyst score must meet the configured threshold
- symbol must be present
- tangential mentions are skipped
- blocked impacts are skipped

Generation is idempotent by:

```text
symbol + catalystImpactId
```

Re-running generation refreshes the candidate snapshot and expiration timestamp instead of creating duplicate candidates for the same symbol/catalyst impact.

Candidates default to expiring after 24 hours. Expiration marks stale active records as `EXPIRED`; records are not deleted.

Candidate states include:

```text
DISCOVERED
WATCHING
ENTRY_READY
ENTRY_BLOCKED
EXPIRED
DISMISSED
```

`ENTRY_READY` is still review-only. It does not create a signal, trade, order intent, broker order, n8n webhook, or automatic alert by itself.

## 📈 Price and Volume Confirmation

Price confirmation checks whether a candidate has enough market confirmation to keep watching or prepare for review.

The service evaluates active candidates in these states:

```text
DISCOVERED
WATCHING
ENTRY_READY
ENTRY_BLOCKED
```

It skips terminal candidates:

```text
EXPIRED
DISMISSED
```

Each confirmation run:

- fetches a Massive ticker snapshot
- fetches current-day one-minute aggregates for the configured lookback window
- normalizes price and volume data
- writes a `MomentumCandidatePriceCheck` history row
- updates the latest summary fields on `MomentumCandidate`

### Confirmation Snapshot Fields

The Massive price helper normalizes:

- last price
- previous close
- percent move from previous close
- intraday high and low
- distance from high
- session VWAP
- above-VWAP status
- day volume
- dollar volume
- recent move
- recent volume
- relative-volume placeholder

Relative volume remains basic until the system has a reliable historical-volume baseline.

### Confirmation Scoring

Scoring is simple and adjustable.

`priceActionScore` is 0-100:

- +25 when percent from previous close is at least 2%
- +25 when price is above session VWAP
- +25 when price is within 1.5% of intraday high
- +25 when the recent move is positive

`volumeScore` is 0-100:

- +30 when day volume is positive
- +30 when dollar volume meets `MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME`
- +20 when recent volume is positive
- +20 when relative volume is at least 2, when available

`riskScore` is a quality score:

- +25 when last price is at least `MOMENTUM_CONFIRMATION_MIN_PRICE`
- +25 when percent from previous close is not overextended above 15%
- +25 when price is not more than 6% above VWAP
- +25 as a neutral timing placeholder

Weighted total score:

```text
round(catalystScore * 0.45 + priceActionScore * 0.30 + volumeScore * 0.20 + riskScore * 0.05)
```

### Confirmation State Transitions

Default thresholds:

```text
MOMENTUM_CONFIRMATION_WATCHING_THRESHOLD=60
MOMENTUM_CONFIRMATION_ENTRY_READY_THRESHOLD=80
```

State rules:

- hard blocks set `ENTRY_BLOCKED`
- score at or above entry-ready threshold sets `ENTRY_READY`
- score at or above watching threshold sets `WATCHING`
- lower scores keep discovered candidates discovered and move other active candidates back to `WATCHING`

Hard blocks include:

- expired candidate
- missing last price
- missing previous close or percent move from previous close
- price below `MOMENTUM_CONFIRMATION_MIN_PRICE`
- percent from previous close above `MOMENTUM_CONFIRMATION_MAX_PCT_FROM_PREV_CLOSE`
- stale or empty aggregate data

The current model does not yet enforce a first-30-minutes-after-open entry-ready rule.

## 📬 Scanner Handoffs

Scanner handoffs are durable queue records for n8n review.

A candidate is eligible for handoff when:

- candidate state is `ENTRY_READY`
- candidate is not expired
- candidate total score meets the configured handoff threshold
- candidate has no blocked reason
- no active handoff already exists for the candidate and payload version, unless `force` is used

Default handoff settings:

```text
MOMENTUM_HANDOFF_MIN_SCORE=80
MOMENTUM_HANDOFF_MAX_CANDIDATES=10
MOMENTUM_HANDOFF_PAYLOAD_VERSION=v1
```

### Handoff Payload

Payload version `v1` includes:

- candidate id, symbol, state, scores, reason, and timestamps
- catalyst event summary
- ticker impact summary
- latest price confirmation summary
- review guidance
- `recommendedAction = REVIEW_ONLY`
- `tradingAllowed = false`

Payloads intentionally exclude:

- broker credentials
- secrets
- raw vendor blobs
- raw model output blobs
- signal objects
- order objects
- broker objects

### Handoff Statuses

```text
PENDING
SENT
ACKNOWLEDGED
FAILED
CANCELLED
```

Status behavior:

- `PENDING` means the handoff is prepared for delivery, but it is deliverable only while the current candidate remains eligible.
- `SENT` means n8n/Slack delivery succeeded and the workflow marked the handoff sent.
- `ACKNOWLEDGED` exists in the backend model but is not currently used by the Slack review workflow.
- `FAILED` stores delivery/workflow failure details.
- `CANCELLED` means a stale pending handoff was invalidated before delivery.

A pending handoff is cancelled when the current candidate:

- is no longer `ENTRY_READY`
- expires
- becomes blocked
- falls below the handoff score threshold
- cannot be found

The backend cancels stale pending handoffs before preparing new handoffs and before the n8n polling route returns pending handoffs.

This prevents old point-in-time payload snapshots from being delivered after the underlying candidate has cooled off or become invalid.

## 🧑‍💻 Admin UI

The Admin UI exposes a review-only page at:

```text
/momentum-scanner
```

The page is for operator smoke testing and inspection.

It shows:

- review-only status badges
- manual pipeline action buttons
- catalyst event overview and details
- momentum candidate overview and details
- price-check history
- scanner handoff overview and payload details
- summary counts for recent events, candidates, entry-ready candidates, blocked candidates, and handoffs

The page intentionally does not include:

- trading buttons
- signal creation controls
- order creation controls
- broker or Alpaca actions
- n8n workflow editing
- automatic buying behavior
- handoff mark-sent, acknowledge, or failed controls

Manual testing sequence:

1. Run Massive news worker.
2. Review catalyst events and ticker impacts.
3. Generate momentum candidates.
4. Confirm candidate prices.
5. Prepare scanner handoffs.
6. Review handoff queue state.

Universe management is available at:

```text
/momentum-scanner/universe
```

Admin owners can search and filter membership, add an existing `Security`, enable or disable membership, independently control news and price scanning, edit priority/pull interval/notes, inspect related subscription count and cursor health, or explicitly remove membership. Disabling is the preferred routine operation; hard deletion removes only the research membership. Neither operation changes subscriptions, risk-gate behavior, orders, or broker activity.

## 🔌 API Routes

### Admin Routes

Admin routes require admin auth.

Catalyst events:

```http
GET /api/catalyst-events
GET /api/catalyst-events/:id
POST /api/catalyst-events/ingest/massive-news
POST /api/catalyst-events/workers/massive-news/run-once
```

Momentum candidates:

```http
GET /api/momentum-candidates
GET /api/momentum-candidates/:id
POST /api/momentum-candidates/generate-from-catalysts
POST /api/momentum-candidates/expire-stale
POST /api/momentum-candidates/:id/confirm-price
POST /api/momentum-candidates/confirm-prices
GET /api/momentum-candidates/:id/price-checks
```

Scanner handoffs:

```http
GET /api/momentum-scanner/handoffs
GET /api/momentum-scanner/handoffs/:id
POST /api/momentum-scanner/handoffs/prepare
POST /api/momentum-scanner/handoffs/:id/mark-sent
POST /api/momentum-scanner/handoffs/:id/acknowledge
POST /api/momentum-scanner/handoffs/:id/mark-failed
```

Momentum research universe:

```http
GET /api/momentum-scanner/universe
POST /api/momentum-scanner/universe
PATCH /api/momentum-scanner/universe/:id
DELETE /api/momentum-scanner/universe/:id
```

Universe routes require admin authentication and owner access. Creation accepts only an existing `Security` id and rejects duplicate membership.

### Signal / n8n Routes

n8n uses the existing signal automation route group:

```text
/api/signals
```

Signal automation routes require:

```http
signal-key: <AI_TRADER_SIGNAL_API_KEY>
```

Momentum Scanner signal routes:

```http
POST /api/signals/momentum-scanner/run-news-worker
POST /api/signals/momentum-scanner/generate-candidates
POST /api/signals/momentum-scanner/confirm-prices
POST /api/signals/momentum-scanner/prepare-handoffs
GET /api/signals/momentum-scanner/handoffs
POST /api/signals/momentum-scanner/handoffs/:id/mark-sent
POST /api/signals/momentum-scanner/handoffs/:id/mark-failed
```

These are review-only automation routes. They do not create entry signals, order intents, broker orders, Alpaca calls, broker activity, paper trading, live trading, or automatic buying.

## ⚙️ Configuration

Relevant environment variables include:

```text
MASSIVE_NEWS_WORKER_ENABLED
MASSIVE_NEWS_WORKER_INTERVAL_MS
MASSIVE_NEWS_LOOKBACK_MINUTES
MASSIVE_NEWS_LIMIT_PER_SYMBOL
MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN

MOMENTUM_CONFIRMATION_WATCHING_THRESHOLD
MOMENTUM_CONFIRMATION_ENTRY_READY_THRESHOLD
MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME
MOMENTUM_CONFIRMATION_MIN_PRICE
MOMENTUM_CONFIRMATION_MAX_PCT_FROM_PREV_CLOSE

MOMENTUM_HANDOFF_MIN_SCORE
MOMENTUM_HANDOFF_MAX_CANDIDATES
MOMENTUM_HANDOFF_PAYLOAD_VERSION

AI_TRADER_SIGNAL_API_KEY
```

## ⚠️ Current Limitations

Known limitations:

- Massive news quality is noisy and includes many broad Motley Fool-style articles.
- Source quality scoring is still basic.
- Catalyst classification is not final.
- Relative volume does not yet use a robust historical baseline.
- Regular-hours timing rules are not fully modeled in the confirmation service.
- There is no final momentum entry scoring model.
- There is no momentum exit strategy.
- There is no buy/sell automation.
- There is no SEC/EDGAR ingestion yet.
- There is no Benzinga ingestion yet.
- n8n schedule timing does not yet account for market holidays or early closes beyond normal weekday scheduling.
- Universe management does not discover arbitrary new securities; securities must already exist.
- This foundation does not include symbol research pages, charts, catalyst timelines, candidate evaluation history, scoring-version history, forward-return analysis, or MFE/MAE analysis.

## 🧭 Future Work

Likely next phases:

- improve source quality filtering
- add Benzinga or another higher-signal news source
- add SEC/EDGAR watcher
- add relative-volume baselines
- improve catalyst type/tier classification
- add candidate dismissal/review actions
- tune scoring thresholds after observing alerts
- design a momentum-specific exit strategy
- add holiday and early-close awareness
- consider future signal/order integration only after a review period
- add dedicated symbol research and candidate analysis surfaces after the universe workflow has operational history

Any future trading integration should remain behind explicit safety gates and should not be added until review-only alerts have been evaluated across multiple market sessions.
