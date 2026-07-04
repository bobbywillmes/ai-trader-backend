# Catalyst News Foundation

Phase 1 adds backend storage and manual ingestion for market catalysts and news.
It does not add automated polling, n8n triggers, admin UI pages, candidate
generation, or trading behavior.

## Purpose

The catalyst foundation gives the backend a durable place to store market news
from multiple sources before that data is used by future scanner, ranking, or
review workflows.

Initial ingestion supports Massive `/v2/reference/news` payloads through a
protected admin endpoint:

```http
POST /api/catalyst-events/ingest/massive-news
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

## Phase 1 Scoring

Scoring is intentionally simple. The ingestion service currently assigns basic
source quality, freshness, relevance, and actionability scores so records are
usable for review and early sorting.

The final momentum scoring algorithm is deferred.

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

The following are intentionally out of scope for Phase 1:

- scheduled news workers
- n8n webhook triggers
- `MomentumCandidate`
- admin UI pages
- final momentum scoring
- trading decisions or order behavior
