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

## Current Ownership And Eligibility Audit

This section records the behavior found before the security-ownership and
eligibility work began. It is deliberately descriptive: behavior listed here
as a gap is not a statement of the intended final design.

### Identity

`Security` already has a globally unique normalized symbol and is the identity
used by subscriptions and universe membership. The momentum pipeline does not
currently carry that identity through its stored records:

- `CatalystTickerImpact` stores only `symbol`.
- `MomentumCandidate` stores only `symbol`.
- `MomentumCandidatePriceCheck` derives its opportunity from the candidate but
  also stores only a symbol snapshot.
- `MomentumScannerHandoff` derives its opportunity from the candidate but also
  stores only a symbol and payload snapshot.

Candidate and research queries consequently recover `Security`, universe, and
subscription context by matching symbol strings. Candidate creation does not
require a matching `Security`.

The target ownership boundary is:

```text
Security                 owns instrument identity
MomentumUniverseMember   owns persistent research inclusion
Subscription             owns strategy eligibility
TradingAccountSubscription owns account assignment for entry-capable use
```

Impact, candidate, price-check, and handoff symbol fields may remain as
immutable or denormalized historical snapshots. They are not intended to remain
the authoritative identity for active opportunities.

### News Research Eligibility

Normal configured research coverage currently includes three sources:

- enabled universe members with `newsEnabled = true`
- every enabled stock subscription, regardless of strategy
- open or closing positions

Subscription-derived coverage does not create a `MomentumUniverseMember`, but
it does keep news cursors enabled. This means subscription ownership currently
expands news research beyond the explicit universe.

The intended boundary is that normal persistent research requires an enabled,
news-enabled universe member. Temporary open/closing-position coverage may
remain for operational safety, but a subscription must not silently become
persistent research membership.

### Candidate Discovery Eligibility

Candidate generation currently selects recent positive ticker impacts meeting
the catalyst threshold. It also rejects blank symbols, blocked impacts, and
tangential mentions. It does not require:

- a matching `Security`
- an enabled `Security`
- universe membership
- enabled universe membership
- a momentum subscription

Every qualifying impact can therefore create a candidate outside the research
universe. The unique constraint is `symbol + catalystImpactId`, so separate
impacts for the same symbol can create multiple simultaneously active
candidates. Rerunning generation for the same impact refreshes the candidate's
expiration timestamp.

Ticker impacts must continue to be retained even when their symbols are
unknown or outside the universe. The intended discovery boundary is narrower:
only a valid `Security` with enabled universe membership may become a new active
candidate, and only one active opportunity per security may exist at a time.

### Price-Confirmation Eligibility

Bulk price confirmation currently queries a bounded number of candidates in
`DISCOVERED`, `WATCHING`, `ENTRY_READY`, or `ENTRY_BLOCKED`, ordered by score and
discovery time. It then requests market data before checking any research or
subscription configuration.

It does not currently require a valid security, enabled universe membership,
`priceScanningEnabled`, or a momentum-specific subscription. Terminal
`EXPIRED` and `DISMISSED` candidates are skipped, while an elapsed `expiresAt`
is handled only after market data has been fetched and scored.

The intended selection boundary requires all configuration and expiration
checks before any market-data request. Momentum subscription eligibility must
use stable strategy keys classified as the `MOMENTUM_CONTINUATION` family;
generic stock subscriptions and the `quick_test_momentum` system-test strategy
do not qualify.

### Handoff Eligibility

Handoff preparation currently requires `ENTRY_READY`, an unelapsed expiration,
the configured score threshold, no `blockedReason`, and no conflicting active
handoff unless forced. It does not check security identity, universe state,
price-scanning state, momentum strategy ownership, account assignment, or
allocation state.

A handoff is a stored review payload and never an order. The intended handoff
boundary additionally requires current research and momentum-subscription
eligibility plus an enabled entry-capable `TradingAccountSubscription`, an
eligible trading account, and an enabled allocation when one is assigned. This
is configuration readiness, not a duplicate of the central risk gate.

### Candidate Lifecycle And Expiration

The current candidate states are:

| State | Active today | Terminal | Price checked today | Handoff capable |
| --- | --- | --- | --- | --- |
| `DISCOVERED` | Yes | No | Yes | No |
| `WATCHING` | Yes | No | Yes | No |
| `ENTRY_READY` | Yes | No | Yes | Yes, subject to current checks |
| `ENTRY_BLOCKED` | Yes | No | Yes | No |
| `EXPIRED` | No | Yes | No | No |
| `DISMISSED` | No | Yes | No | No |

The active-state list is currently duplicated in candidate generation,
price-confirmation, and research services. Research counts test state only and
do not exclude candidates whose `expiresAt` has elapsed.

Candidates default to a 24-hour expiration, but expiration is enforced as a
state transition only when the owner-only `expire-stale` endpoint is explicitly
called. There is no scheduled expiration worker. Old `DISCOVERED` rows may
therefore remain visible as active indefinitely, and regeneration can extend
the opportunity by refreshing `expiresAt`.

The intended lifecycle uses one shared state helper. Elapsed candidates are
ineligible immediately at query time, even before reconciliation persists the
`EXPIRED` state. The initial deterministic lifetime remains 24 hours from the
stable discovery timestamp; repeated processing must not extend it. This branch
does not introduce market-session expiration rules.

### Observed Dashboard Symptoms

The research dashboard can show substantially more active candidates than
universe members because candidate discovery is not universe-bounded, multiple
active candidates can exist per symbol, and elapsed candidates remain counted
until explicit expiration runs.

Candidates commonly show a catalyst score such as 80 with zero price-action,
volume, and risk scores because creation copies the catalyst score into the
candidate and initializes the deferred confirmation components to zero. Those
rows have not completed a successful price-confirmation evaluation.

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

- nullable canonical `Security` relation when exactly one normalized match exists
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

- nullable canonical `Security` relation for historical compatibility
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

Cursor synchronization combines two coverage sources:

- explicit database universe membership, which is the canonical permanent research universe
- open or closing tracked positions, retained as temporary operational coverage even without explicit membership

Subscriptions do not expand news-research coverage. Position-derived coverage does not create hidden `MomentumUniverseMember` rows. When sources overlap, synchronization creates only one source/symbol cursor and uses the highest priority and shortest required pull interval. Disabling or removing explicit membership disables its managed cursor unless an open or closing position still requires temporary coverage.

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
- the impact must resolve to exactly one existing `Security`
- the security must have enabled `MomentumUniverseMember` membership
- tangential mentions are skipped
- blocked impacts are skipped
- no unexpired active candidate may already exist for the security

Generation is idempotent by:

```text
symbol + catalystImpactId
```

The impact-level unique key remains for historical idempotency, while discovery also prevents more than one unexpired active candidate per security. Re-running generation does not extend an existing opportunity's expiration timestamp.

Impacts for unknown, ambiguous, out-of-universe, or disabled-universe symbols remain stored. Candidate generation skips them with structured reason codes rather than deleting catalyst history or creating securities implicitly.

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

The Admin UI exposes a review-only Momentum Research section under the existing
route family:

```text
/momentum-scanner
/momentum-scanner/candidates
/momentum-scanner/candidates/:candidateId
/momentum-scanner/catalysts
/momentum-scanner/symbols/:symbol
/momentum-scanner/universe
/momentum-scanner/pipeline
```

Shared compact navigation links Overview, Candidates, Catalysts, Research
Universe, and Scanner Pipeline. Deep candidate and symbol pages retain that
navigation without adding another sidebar section.

### Momentum Research Dashboard

`/momentum-scanner` is the default destination. It summarizes active,
entry-ready, and blocked candidates; catalyst events received during the
previous 24 hours; prepared handoffs; enabled universe membership; top active
candidates; recently evaluated or updated candidates; and cursor-derived health.

There is no candidate transition-audit model. The dashboard therefore labels
recent records as recently updated candidates instead of claiming a complete
transition history.

### Candidate Research

`/momentum-scanner/candidates` provides database-backed pagination and filters
for symbol, state, minimum score, catalyst type, readiness, discovery date, and
safe sorting. It does not fetch the full candidate table for client filtering.

`/momentum-scanner/candidates/:candidateId` is a read-only case file with the
candidate state and timestamps, raw stored score components, linked catalyst and
ticker reasoning, chronological price checks, prepared handoffs, and related
Security/universe/subscription context. The UI does not invent score denominators
because the schema does not formally persist a maximum for every component.

### Catalyst Browsing

`/momentum-scanner/catalysts` supports database-backed symbol/headline,
publisher, source, type, tier, sentiment, publication-date, and sort filters.
Impacted symbols and candidate relationships are rendered as links rather than
raw arrays.

### Symbol Research

`/momentum-scanner/symbols/:symbol` aggregates stored scanner context for an
existing `Security`. Explicit universe membership, news and price-scanning
configuration, cursor state, subscription availability, open positions, and
candidate state remain separate concepts. The page shows stored score reasoning,
catalyst history, price checks, handoffs, and candidate history without claiming
trade outcomes.

### Research Universe

Universe management remains at `/momentum-scanner/universe`. Owners can manage
explicit membership and inspect subscription and cursor context. Disabling or
deleting membership does not change subscriptions, risk behavior, orders, or
broker activity.

### Scanner Pipeline

The original smoke-test and raw inspection page is preserved at
`/momentum-scanner/pipeline`. It retains manual news ingestion, candidate
generation, price confirmation, handoff preparation, raw record inspection, and
existing warnings. Research pages do not duplicate those controls.

The manual test sequence remains: run the Massive news worker, inspect catalyst
impacts, generate candidates, confirm prices, prepare handoffs, and inspect the
handoff queue.

No Momentum Research page includes trading buttons, signal or order creation,
broker actions, n8n editing, or automatic buying behavior.

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

Momentum research views:

```http
GET /api/momentum-scanner/research/overview
GET /api/momentum-scanner/research/candidates
GET /api/momentum-scanner/research/candidates/:candidateId
GET /api/momentum-scanner/research/catalysts
GET /api/momentum-scanner/research/symbols/:symbol
```

Research routes require admin authentication and owner access and are read-only.
List routes use paginated database queries, validated filters, and safe sort
whitelists. Detail routes aggregate bounded existing records and omit large
catalyst ingestion payloads by default.

The overview returns its time-window boundaries. Recent catalysts and recent
candidate activity both cover the previous 24 hours. Active candidate counts use
`DISCOVERED`, `WATCHING`, `ENTRY_READY`, and `ENTRY_BLOCKED`.

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
- Research pages visualize stored candidates, catalysts, price checks, handoffs,
  universe membership, cursors, subscriptions, and positions. They do not add
  OHLC storage, live chart fetching, or decision behavior.
- Full candlestick and volume charts remain deferred because the application
  does not store the required OHLC history and this phase does not add large
  aggregate market-data requests.
- There is no candidate state-transition audit, `MomentumCandidateEvaluation`,
  scoring-version history, forward-return analysis, outcome grading, or MFE/MAE
  analysis.

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
- add candidate evaluation snapshots and a state-transition audit when the
  operational value justifies new persistence
- add forward-return, MFE/MAE, and candidate outcome analysis after evaluation
  records and scoring versions are defined
- consider stored OHLC data and charts as a separate market-data design rather
  than coupling chart fetching to page loads

Any future trading integration should remain behind explicit safety gates and should not be added until review-only alerts have been evaluated across multiple market sessions.
