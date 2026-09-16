# Market data and Trend calibration

## Authority and evidence

Massive is the market-data authority. Alpaca remains the brokerage, account and
execution authority. There is no Alpaca fallback in market-data ingestion or Trend.
MarketBar records unadjusted provider OHLCV as first accepted after completion.
Database triggers reject updates/deletes; overlap inserts do nothing. There is no
automatic historical comparison, correction or revision process. Closed intervals
can still receive late vendor corrections: accepted observations are not a claim
that the vendor will never subsequently change its history.

MarketCalendarException is small mutable operator configuration. Weekends are
closed; normal sessions are 09:30–16:00 America/New_York. Operators maintain holiday
closures and early closes using https://www.nyse.com/trade/hours-calendars.
There is no automatic holiday import. Daily eligibility begins 30 minutes after
the expected close; regular-session 15-minute eligibility begins five minutes
after interval end. These are code constants, not editable settings.

Historical backfill accepts valid returned daily observations without demanding
decades of manual holiday entries. Current operational gaps use the maintained
calendar. A closed session, an interval not yet eligible and an eligible missing
bar are distinct. Missing bars are never synthesized.

## Assessment foundation

MarketRegimeDimensionAssessment is an immutable terminal evidence contract.
It has six dimension names, but only Trend's UP/NEUTRAL/DOWN vocabulary is defined.
UNAVAILABLE/FAILED rows have null states; missing data is never NEUTRAL. Attempts
are unique per dimension/version/target/attempt, and at most one VALID result may
exist per dimension/version/target. A previous assessment must share dimension and
algorithm version. Research profiles never insert into this table.

## Calibration boundary

Trend is daily, based on SPY and RSP confirmation. Calibration runs three frozen
research candidates (TIGHT, MIDDLE, LOOSE), never an authoritative TREND_V1.
The pure calculator consumes split-normalized data. Split events come from Massive
as bounded research inputs and are returned in lab evidence, without a corporate
action table. Raw MarketBars remain unadjusted.

Hysteresis steps one state immediately on deterioration and requires two supporting
valid sessions per recovery step. Missing sessions pause confirmation. Each
independent candidate rebuilds its own state. Future intraday refreshes cannot
advance daily hysteresis.

CurrentMarketState and Market Diary retain their narrative/n8n purpose. There is
no Market Regime trading gate, strategy policy, overall regime calculation or
execution integration. Next: operator review of the Trend Lab and selection of
one profile. Only after that review will selected thresholds be frozen under a
production identifier such as TREND_V1 and immutable assessments be published.

## Research inputs and evidence

Research defaults live in `src/services/trend-lab.config.ts`: display history starts
at 2012-01-01 and backfill includes 550 calendar days of pre-roll (2010-06-30).
At least 250 earlier sessions are recommended. The initial UI displays the last
three calendar years so operators with shorter entitlements can begin inspection.
The code never substitutes synthetic historical data when Massive denies access.

Daily bars use Massive custom aggregates with `adjusted=false`, including on
pagination requests. Each page's ticker, adjustment flag, timestamp and OHLCV are
validated. Any malformed observation rejects that fetched range before insertion.
OHLC uses Decimal(24,10), volume Decimal(30,6); unrepresentable values are rejected
rather than silently rounded. Duplicate rows within a response must agree; overlap
with previously stored data is simply conflict-do-nothing, without comparison.

Split events are read from `/stocks/v1/splits`, bounded by the loaded history and
research end date. Earlier OHLC is multiplied by the product of `split_from /
split_to` for splits after that bar and through the research end. Volume is divided
by that factor. Vendor cumulative factors are intentionally not used because they
can include events beyond the chosen research end. No dividend adjustment is made.
If split evidence cannot be obtained, the lab fails visibly rather than calculating
on potentially discontinuous prices. There is no persistent split cache.

The calculator has no HTTP or database dependency. It receives normalized bars in
unique chronological session order. EMA seeds with the first N-session SMA, then
uses alpha=2/(N+1). The minimum is 60 sessions: EMA50 plus its ten-session slope.
An absent expected instrument observation invalidates that date and restarts that
instrument's EMA seed; it does not fabricate a close or turn a multi-session slope
into a single-session slope. Hysteresis pauses through the resulting unavailable
period. Recovered data is replayed chronologically from the same input floor.

Historical expected dates are the union of observed SPY/RSP dates. Operational
expected sessions are also included from the persisted synchronization start date.
Dates missing from both historical instruments cannot be distinguished from
historical holidays without calendar entries; the UI says so. Unknown historical
coverage is not included in valid/unavailable-day statistics.

### Frozen candidate deadbands (percentage points)

| Measurement | TIGHT | MIDDLE | LOOSE |
| --- | ---: | ---: | ---: |
| Close vs EMA10 | 0.10 | 0.20 | 0.30 |
| EMA10 three-session slope per session | 0.02 | 0.05 | 0.08 |
| Five-session return | 0.30 | 0.60 | 1.00 |
| Close vs EMA20 | 0.15 | 0.30 | 0.50 |
| EMA20 five-session slope per session | 0.02 | 0.04 | 0.07 |
| EMA10 vs EMA20 | 0.10 | 0.20 | 0.35 |
| Close vs EMA50 | 0.25 | 0.50 | 0.75 |
| EMA50 ten-session slope per session | 0.01 | 0.03 | 0.05 |
| EMA20 vs EMA50 | 0.15 | 0.30 | 0.50 |

Ratios are `(a/b-1)*100`; slopes divide this ratio change by their session count.
Equality with either deadband boundary is neutral. Two of three positive/negative
measurements produce UP/DOWN for a horizon. Medium and structural agreement wins;
a direction paired with NEUTRAL requires short-horizon agreement. Opposing medium
and structural states produce NEUTRAL. SPY and RSP must agree UP or DOWN; all other
market combinations produce NEUTRAL.

Effective states are ordered DOWN < NEUTRAL < UP. Bootstrap uses the first valid
raw state. Deterioration moves exactly one step immediately. Recovery needs two
valid sessions supporting at least the next better state; after each recovery
step its counter resets. Equality resets confirmation. Unavailable observations
neither advance nor reset it. Candidates replay independently on every new dataset.

Returned evidence includes every measurement, threshold, sign, horizon state,
instrument state, raw/effective market state, predecessor and confirmation counts,
and an explanation. Source metadata contains exact ordered MarketBar IDs; chart
bars retain IDs and normalization factors. Split dates/ratios remain inspectable.
The same versioned daily evidence structure can later be persisted by a separate
approved production publisher. The current application has no such publisher.

## Operations and APIs

The global `market_daily_evidence_sync` worker checks every minute. A PostgreSQL
session advisory lock spans scheduled/manual ingestion, and canonical uniqueness
remains the final insertion guard. It is separate from account workflow locks.
The `marketDailyEvidenceSync` Setting records its operational start date, retry
time and last result; it is synchronization bookkeeping, not algorithm settings.
It retains the original floor across restarts and checks interior missing eligible
dates, not just the latest bar. Provider retries are bounded to hourly; a pending
daily completion cutoff can shorten the next check. Each run attempts at most 20
missing dates per symbol. An eligible missing response is visible as a failure.
Calendar maintenance is required for current/future holidays; an unentered holiday
will intentionally appear as a missing weekday until the operator configures it.

Calendar writes and research reads require SYSTEM_OWNER or OPERATOR permissions
(`marketCalendar.write`, `marketData.read`). Backfill requires SYSTEM_OWNER.
ACCOUNT_USER has neither permission.

| Endpoint | Behavior |
| --- | --- |
| GET `/api/market-data/calendar?year=2026` | List that year's exceptions |
| POST `/api/market-data/calendar` | Create exception |
| PUT `/api/market-data/calendar/:id` | Replace mutable exception fields |
| DELETE `/api/market-data/calendar/:id` | Remove exception |
| GET `/api/market-data/status` | Stored coverage, current gaps, retry status and recent backfill events |
| POST `/api/market-data/backfill` | `{from,to}`, up to 370 calendar days, both SPY/RSP |
| GET `/api/market-data/trend-lab?from=...&to=...&refresh=true` | Candidate summaries, chart series, timeline and dataset identity |
| GET `/api/market-data/trend-lab/day?datasetId=...&profile=MIDDLE&date=...` | Exact per-date explanation from that research snapshot |

The server holds at most two research snapshots for ten minutes; at most two range
calculations may be in flight. Refresh explicitly rebuilds inputs. Date inspection
never silently changes datasets; expired/evicted snapshots return 410. These caches
are transient research results, not authoritative assessment persistence.

The UI lives at `/system/market-calendar` and `/system/trend-lab`. Date range,
profile, instrument and selected evidence date are URL-backed. Calendar forms show
Eastern times; Trend charts use daily business dates, EMA10/20/50 and effective-state
transition markers. Detailed evidence is shown for both instruments.

Statistics use effective states on known valid sessions in the displayed range.
Transitions include actual transitions on the first displayed session, if any.
Annualized frequency uses 252 valid sessions; per-year counts are also returned.
Run durations count valid sessions and pause on unavailable dates. First/last runs
are included and may be censored by the display boundaries. No P&L is calculated
and no profile is selected automatically.

Local research helpers (require existing SPY/RSP Securities):

```powershell
npx.cmd tsx scripts/market-data-backfill.ts
npx.cmd tsx scripts/market-data-backfill.ts 2021-09-16 2026-09-15
npx.cmd tsx scripts/trend-lab-report.ts 2023-01-01 2026-09-15
```

The CLI backfill is restricted to a local database and reports failed ranges while
continuing other chunks. Owner UI backfill stops at an error and can resume with a
supported range. Successful chunks and prior evidence are retained. Initial
validation on 2026-09-16 found the configured Massive entitlement supported only
2021-09-16 onward, not the requested 10–15-year history. No calendar exceptions
were automatically seeded and no existing trading records were changed.

## Migration and validation

Apply `20260915120000_market_data_trend_foundation` before starting this version.
It is additive and contains no historical trading-data backfill. Prisma generates
the DBML alongside the client. SQL contains OHLCV/calendar checks, restrictive FKs,
immutable UPDATE/DELETE triggers and the partial VALID-assessment unique index.
The predecessor FK has an explicit Prisma map matching its PostgreSQL identifier.

The PostgreSQL integrity suite replays every migration into a disposable database
because an existing migration explicitly references `public`. It also exercises
concurrent real ingestion and immutability. Run it using:

```powershell
$env:RUN_DATABASE_INTEGRITY_TESTS='1'
npx.cmd vitest run src/db/__tests__/market-data.integration.test.ts
```
