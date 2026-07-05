# Catalyst News Foundation

Phase 1 added backend storage and manual ingestion for market catalysts and
news.

Phase 2 added an optional backend worker for polling Massive reference news for
watched stock symbols.

Phase 3 adds backend-only `MomentumCandidate` storage and candidate generation
from existing catalyst ticker impacts. At the time it was added, it did not add
n8n triggers, admin UI pages, price or volume confirmation, final scoring,
broker behavior, or trading behavior.

Phase 4 adds backend-only manual price and volume confirmation for existing
`MomentumCandidate` rows. At the time it was added, it did not add n8n
triggers, Slack alerts, signal creation, trade creation, broker/order behavior,
admin UI pages, or automatic buying.

Phase 5 adds backend-to-n8n scanner handoff plumbing for review-only momentum
candidate payloads. It does not add signal creation, trade creation,
broker/order behavior, automatic webhook pushing, or automatic buying.

The admin UI now includes a `Momentum Scanner` page for manual review and
testing of the backend pipeline. The page is visibility and operator testing
only; it does not create signals, orders, broker activity, n8n workflow changes,
or automatic buying behavior.

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

`MomentumCandidatePriceCheck` stores append-only price/volume confirmation
history:

- linked `MomentumCandidate`
- symbol and observed timestamp
- last price, previous close, percent move from previous close
- intraday high/low and distance from high
- session VWAP and above-VWAP flag
- day volume, dollar volume, relative volume placeholder
- recent move and recent volume
- price action, volume, risk, and total confirmation scores
- confirmed flag, decision, blocked reason
- raw Massive payload and metadata

`MomentumCandidate` remains the latest summary table. Phase 4 updates its
`priceActionScore`, `volumeScore`, `riskScore`, `totalScore`,
`lastEvaluatedAt`, `state`, `blockedReason`, and `rawSnapshot` from the most
recent manual confirmation run while preserving detailed check history in
`MomentumCandidatePriceCheck`.

`MomentumScannerHandoff` stores scanner-review handoff audit records:

- linked `MomentumCandidate`
- symbol
- handoff status
- payload version and prepared payload
- prepared, sent, acknowledged, and failed timestamps
- attempts and last error
- idempotency key
- metadata

The handoff table is the audit source for whether a candidate has been prepared
or sent to a scanner-review workflow. `MomentumCandidate` remains the candidate
summary table and is not used as the delivery ledger.

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
now a review-only Admin UI page for this pipeline; Phase 3 itself only added
the backend endpoints and storage.

## Phase 4 Price And Volume Confirmation

Price confirmation answers whether an existing catalyst-backed candidate has
enough market confirmation to keep watching or mark as entry-ready for a future
handoff phase. It is manual and backend-only.

The confirmation service evaluates active candidates in these states:

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
- builds a normalized price confirmation snapshot
- writes a new `MomentumCandidatePriceCheck`
- updates the candidate latest summary fields and state

The Massive helper normalizes:

- last price
- previous close
- percent move from previous close
- intraday high and low
- distance from high
- session VWAP and above-VWAP status
- day volume and dollar volume
- recent move and recent volume

Relative volume is intentionally left null in Phase 4 unless a reliable
historical-volume baseline is added later.

### Phase 4 Scoring

Scoring is deliberately simple and adjustable.

`priceActionScore` is 0-100:

- `+25` when percent from previous close is at least 2%
- `+25` when price is above session VWAP
- `+25` when price is within 1.5% of intraday high
- `+25` when the recent move is positive

`volumeScore` is 0-100:

- `+30` when day volume is positive
- `+30` when dollar volume meets `MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME`
- `+20` when recent volume is positive
- `+20` when relative volume is at least 2, when available

`riskScore` is a risk quality score, not a penalty:

- `+25` when last price is at least `MOMENTUM_CONFIRMATION_MIN_PRICE`
- `+25` when percent from previous close is not overextended above 15%
- `+25` when price is not more than 6% above VWAP
- `+25` as a neutral timing placeholder

Phase 4 does not call a regular-hours timing helper. It therefore does not
enforce the first-30-minutes-after-open entry-ready rule yet.

The weighted score is:

```text
round(catalystScore * 0.45 + priceActionScore * 0.30 + volumeScore * 0.20 + riskScore * 0.05)
```

### Phase 4 State Transitions

Default thresholds:

```text
MOMENTUM_CONFIRMATION_WATCHING_THRESHOLD=60
MOMENTUM_CONFIRMATION_ENTRY_READY_THRESHOLD=80
```

State rules:

- hard blocks set `ENTRY_BLOCKED`
- score at or above the entry-ready threshold sets `ENTRY_READY`
- score at or above the watching threshold sets `WATCHING`
- lower scores keep `DISCOVERED` candidates discovered and move other active
  candidates back to `WATCHING`

Hard blocks:

- expired candidate
- missing last price
- missing previous close or percent move from previous close
- price below `MOMENTUM_CONFIRMATION_MIN_PRICE`
- percent from previous close above `MOMENTUM_CONFIRMATION_MAX_PCT_FROM_PREV_CLOSE`
- stale or empty aggregate data

`ENTRY_READY` is only a review state in Phase 4. It does not create a signal,
trade, order intent, broker order, n8n webhook, or alert.

### Phase 4 Admin Endpoints

Protected admin endpoints:

```http
POST /api/momentum-candidates/:id/confirm-price
POST /api/momentum-candidates/confirm-prices
GET /api/momentum-candidates/:id/price-checks
```

Single-candidate confirmation returns the updated candidate and latest price
check.

Batch confirmation evaluates a bounded active-candidate batch and returns:

```text
evaluated
entryReady
watching
blocked
skipped
errors
```

Optional batch fields:

```text
maxCandidates
state
minCatalystScore
now
recentWindowMinutes
lookbackMinutes
```

The price-check history endpoint returns recent checks newest first.

## Phase 5 Momentum Scanner Handoffs

Phase 5 prepares `MomentumCandidate` rows for n8n scanner review after catalyst
generation and price confirmation have already marked a candidate
`ENTRY_READY`.

The backend exposes a protected handoff queue. n8n pulls scanner-ready payloads
from the backend and can post back delivery state. The backend does not push to
n8n automatically in Phase 5. Pull-based handoff keeps retry ownership,
idempotency, and workflow scheduling in n8n while preserving a durable backend
audit trail.

### Phase 5 Readiness

Default settings:

```text
MOMENTUM_HANDOFF_MIN_SCORE=80
MOMENTUM_HANDOFF_MAX_CANDIDATES=10
MOMENTUM_HANDOFF_PAYLOAD_VERSION=v1
```

A candidate is eligible when:

- `state = ENTRY_READY`
- `expiresAt` is null or in the future
- `totalScore` is at or above the configured handoff score threshold
- `blockedReason` is null
- no active `PENDING`, `SENT`, or `ACKNOWLEDGED` scanner handoff already exists
  for the candidate unless `force = true`

Batch preparation is bounded by `MOMENTUM_HANDOFF_MAX_CANDIDATES` unless a
smaller request limit is supplied.

### Phase 5 Payload

Payloads use version `v1` by default and are shaped for n8n scanner review:

```text
type = momentum_candidate.ready
version = v1
idempotencyKey = momentum-candidate:<candidateId>:v1
```

The payload includes:

- candidate id, symbol, state, scores, reason, and timestamps
- catalyst event and ticker-impact summary when available
- latest price confirmation check by observed and created timestamp
- review guidance with `recommendedAction = REVIEW_ONLY`
- `tradingAllowed = false`

The payload intentionally excludes:

- broker credentials
- secrets
- raw vendor payload blobs
- raw model output blobs
- signal, order, or broker objects

### Phase 5 Idempotency

Handoff creation is idempotent by:

```text
momentum-candidate:<candidateId>:<payloadVersion>
```

Re-running prepare for the same candidate and payload version returns the
existing handoff. When `force = true`, the same handoff row is refreshed back to
`PENDING`; a duplicate row is not created for the same idempotency key.

### Phase 5 Statuses

`MomentumScannerHandoffStatus` values:

```text
PENDING
SENT
ACKNOWLEDGED
FAILED
CANCELLED
```

Status behavior:

- `PENDING` means the payload is prepared and ready for n8n review pickup.
- `SENT` means n8n or an operator marked the payload as received/sent onward.
- `ACKNOWLEDGED` means the scanner-review workflow accepted the handoff.
- `FAILED` stores `failedAt` and `lastError` for delivery or workflow failure.
- `CANCELLED` is reserved for future operator cancellation behavior.

Marking a handoff sent increments `attempts` and sets `sentAt`.

### Phase 5 Admin Endpoints

Protected admin endpoints:

```http
GET /api/momentum-scanner/handoffs
GET /api/momentum-scanner/handoffs/:id
POST /api/momentum-scanner/handoffs/prepare
POST /api/momentum-scanner/handoffs/:id/mark-sent
POST /api/momentum-scanner/handoffs/:id/acknowledge
POST /api/momentum-scanner/handoffs/:id/mark-failed
```

`POST /api/momentum-scanner/handoffs/prepare` prepares either a bounded batch or
one specific candidate when `candidateId` is supplied.

Optional prepare fields:

```text
candidateId
maxCandidates
minScore
force
now
payloadVersion
```

The prepare response includes:

```text
prepared
skipped
handoffs
skippedReasons
```

List filters:

```text
candidateId
symbol
status
limit
```

`mark-sent`, `acknowledge`, and `mark-failed` accept optional `now` and
`metadata`. `mark-failed` requires an `error` message.

## Momentum Scanner Admin UI

The Admin UI exposes a review-only `Momentum Scanner` page at:

```text
/momentum-scanner
```

The page is intended for operator smoke testing and inspection of the catalyst
news momentum pipeline. It is deliberately not a trading console.

Manual testing sequence:

1. Run Massive news worker.
2. Review recent `CatalystEvent` rows and ticker impacts.
3. Generate `MomentumCandidate` rows from catalyst impacts.
4. Review candidate state and scores.
5. Confirm candidate prices.
6. Review latest and historical price-confirmation results.
7. Prepare scanner handoffs.
8. Review `MomentumScannerHandoff` payloads and delivery status.

The page shows:

- review-only status badges
- manual pipeline action buttons
- catalyst event overview and details
- momentum candidate overview and details
- price-check history for selected candidates
- scanner handoff overview and payload details
- summary counts for recent events, candidates, entry-ready candidates,
  blocked candidates, and handoffs

The page intentionally does not include:

- trading buttons
- signal creation controls
- order creation controls
- broker or Alpaca actions
- n8n workflow editing
- automatic buying behavior
- handoff mark-sent, acknowledge, or failed controls

Those delivery-state endpoints remain backend/admin API capabilities for future
workflow testing, but the UI currently keeps the handoff detail drawer view-only.

### Phase 5 Explicit Deferrals

Phase 5 remains review-only. It does not add:

- n8n workflow import or configuration
- backend outbound webhook pushing
- Slack alerts directly from the backend
- signal creation
- trading subscriptions
- order intents
- broker orders
- Alpaca calls
- paper or live trading behavior
- automatic buying

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

The following remain intentionally out of scope after Phase 5:

- n8n workflow import and configuration
- automatic backend-to-n8n webhook pushing
- Slack alerts
- final momentum scoring
- final relative-volume model
- final regular-hours entry timing model
- signal creation
- trading decisions or order behavior
