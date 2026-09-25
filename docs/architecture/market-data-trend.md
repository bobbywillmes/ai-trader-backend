# Market data, calibration and daily dimension publication

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
It has six dimension names. TREND supports UP/NEUTRAL/DOWN and VOLATILITY supports
LOW/NORMAL/HIGH/EXTREME; both daily dimensions require sessionDate in PostgreSQL.
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
execution integration. TIGHT was selected as the calibration basis for production
TREND_V1. Production thresholds are independently frozen in
`src/services/trend-v1.definition.ts`; editing research profiles cannot alter them.
VOLATILITY_V1 is also authoritative, without trading consumers. BREADTH_V1 remains
future work; Strategy gating and overall composition are not implemented.

## Authoritative daily TREND_V1

`trend-assessment.service.ts` publishes only TREND / TREND_V1. Its independent
definition uses percentage-point deadbands, in measurement order:
`0.10, 0.02, 0.30; 0.15, 0.02, 0.10; 0.25, 0.01, 0.15`.
The pure core takes explicit thresholds; the research wrapper maps profile names.
The authoritative evidence envelope starts at version 1, scoped by algorithmVersion;
the existing research evidence version and historical research labels stay unchanged.

Bootstrap loads stored Massive SPY/RSP DAY_1 history, obtains split evidence,
normalizes in memory, and replays the existing daily state machine. Only the latest
calculable common eligible session is published, with null previousAssessmentId.
No historical replay rows become authoritative. Bootstrap evidence states replay
start, session count and data-through boundary. If a later expected session is
already eligible but missing, the same run records the first gap and stops.
If no session has sufficient warm-up, an UNAVAILABLE attempt records that condition.
A failed initial attempt pins its session for retry instead of moving bootstrap
past an unresolved target.

After bootstrap, each session must resolve VALID before the next is processed.
Missing bars or insufficient history produce UNAVAILABLE; split integration or
validation failures produce FAILED / SPLIT_EVIDENCE_UNAVAILABLE; calculation or
predecessor decoding failures produce FAILED / CALCULATION_FAILED. Missing bars
use MISSING_MARKET_DATA and insufficient warm-up uses INSUFFICIENT_HISTORY.
Neither non-valid status has raw/effective classifications. A Tuesday gap blocks
Wednesday even if all Wednesday inputs are present. A later Tuesday VALID attempt
then becomes Wednesday's predecessor. Predecessor effective state and confirmation
come from immutable evidence, never a new replay of the predecessor's hysteresis.
The bootstrap input floor and operational session floor are carried forward.

targetAt is the ET session close (including early closes), not worker time.
dataThroughAt equals that close for VALID rows; completedAt is actual completion.
validUntil snapshots the next expected session close plus the existing DAY_1
30-minute grace. Next-session date, close and relevant calendar exception are in
evidence. Later calendar edits do not rewrite this snapshot. Retried attempted
sessions preserve their original targetAt even if the configured close changes.

Each run owns a PostgreSQL transaction-scoped advisory lock from predecessor read
through insertion and SystemEvent writes. Lock loss rolls back writes on the same
connection. The existing DB partial unique index remains the final VALID guard.
A run handles at most 20 sessions, with a four-minute transaction timeout; subsequent
runs continue catch-up. Concurrent callers receive 409 and workers report
already_running. A uniqueness race is idempotent only after verifying a VALID winner.

Attempts are append-only. A SHA-256 attempt fingerprint covers reason/status,
algorithm/evidence version, source presence and canonical inputs, predecessor,
and timing contract. Identical non-valid attempts do not insert another row or
event. Every run retries split retrieval when applicable, so provider recovery can
produce VALID without changing MarketBars. A changed input/reason creates the next
attempt. Future bars beyond a blocked target do not defeat duplicate suppression.

VALID evidence contains named thresholds, timing, Security IDs/symbols, input
range/counts and endpoint bar IDs, a canonical hash of ordered inputs/session dates
and splits, exact split events and price factors, normalization semantics,
SPY/RSP EMAs and nine classified measurements, three horizon votes, instrument
states/reasons, market raw state/reason, and the complete hysteresis transition.
Raw bars and provider response bodies are not copied into evidence. Immutable bars
remain available for provenance inspection. Historical replay uses observed session
dates because the calendar does not reconstruct decades of missing holidays;
operational publication requires every expected session from bootstrap onward.

The `trend_assessment_publication` worker runs at startup and every 15 minutes,
independently of ingestion and accounts. It is not_due when current through the
latest eligible boundary. Unresolved attempts remain visible as failed worker
health even when their duplicate rows are suppressed. The existing health registry
persists WorkerHealthState. Publication emits events only for bootstrap, transitions,
new blocked attempts, and recovery; no idle-tick or Market Diary events are added.

Read operations use MARKET_DATA_READ (SYSTEM_OWNER / OPERATOR); manual publication
requires SYSTEM_OWNER. Routes under `/api/market-data`:

| Method | Route | Result |
| --- | --- | --- |
| GET | `/trend-assessments/latest` | latestAttempt and latestValid, so gaps remain visible |
| GET | `/trend-assessments?limit=20&beforeId=123` | Recent attempts, descending insertion ID; limit 1–100 |
| GET | `/trend-assessments/:id` | Full immutable evidence |
| POST | `/trend-assessments/run` | Run/catch up, empty body; counts, suppression and blocked reason |

There are no update/delete routes or profile/date overrides. No migration is needed.
See [local acceptance](../development/trend-v1-acceptance.md).

## Authoritative daily VOLATILITY_V1

VOLATILITY_V1 uses the unchanged calibrated pure classifier: sample RV10/RV20
of daily log returns, annualized by sqrt(252)*100, and Wilder ATR14/close*100.
RV boundaries are 12/20/30; ATR percentage boundaries are 1.00/1.50/2.50. Bounds
are lower-inclusive and upper-exclusive. LOW/NORMAL/HIGH/EXTREME have severities
0/1/2/3. Each instrument takes the median severity; market raw takes max(SPY,RSP).
Warm-up requires 21 consecutive usable sessions for each instrument. Missing
expected sessions restart only the affected metrics. Unlike Trend deterioration,
Volatility worsening jumps immediately to raw; recovery takes two valid supporting
sessions per single downward severity step. Missing evidence pauses confirmation.

The publisher follows the existing Trend transaction/attempt pattern without a
shared speculative regime framework or changed Trend state machine. It internally
replays all expected historical sessions, creates one bootstrap VALID row with no
predecessor, and continues chronologically from actual prior VOLATILITY_V1 VALID
rows. Missing/failed evidence pins the first unresolved target and stops catch-up;
identical failure fingerprints suppress duplicate attempts. At most 20 targets
are handled per invocation. The separate global advisory transaction lock protects
manual/worker races; PostgreSQL uniqueness remains final protection.

The static previously verified closure data now has an explicit insert-only
operator bootstrap command, `npm run calendar:bootstrap -- --apply`. Preview is
the default. All 59 known 2021–2026 CLOSED dates, including 2025-01-09, are checked
under a table lock. Equivalent entries skip; any type/close/canonical-name conflict
aborts all writes and is reported. There are no network calls, calendar deletions,
silent operator overwrites, early-close seeding or automatic worker imports.
The research runner still uses the same dates in memory; production calculations
use persisted configuration. Missing known closure coverage blocks publication
with CALENDAR_EVIDENCE_UNAVAILABLE. Future years remain owner-maintained.

Only completed MASSIVE/UNADJUSTED SPY/RSP DAY_1 bars are loaded. Normalization uses
the unchanged Massive split semantics in memory. Eligibility is close+30 minutes;
targetAt and dataThroughAt identify that session's input close, and validUntil
freezes next expected close+30 minutes, respecting weekends, holidays and early
closes. Freshness is derived at read/use time, never by updating historical status.

The version-1 evidence envelope contains the complete frozen definition, exact
ordered MarketBar IDs and Security snapshots, date ranges/counts/hash, split events
and normalization factors, three measurement values/states/severities per symbol,
raw ATR, instrument and market reasons, persisted predecessor and hysteresis, and
calendar/close/grace/validity evidence. Raw provider responses are not persisted.

The monitored `volatility_assessment_publication` worker runs at startup and every
15 minutes, account-independently. Current runs return zero publications/attempts
and notDue true before any Massive requests. New terminal failures remain visible
in worker health even if repeated identical attempts are suppressed. Writes are
limited to dimension assessments/SystemEvents and monitored worker health; there
is still no Strategy, SignalEvaluation, composition, entry or exit consumer.

| Method | Route under `/api/market-data` | Access/result |
| --- | --- | --- |
| GET | `/volatility-assessments/latest` | MARKET_DATA_READ; latestAttempt/latestValid |
| GET | `/volatility-assessments?limit=20&beforeId=123` | MARKET_DATA_READ; descending ID cursor, limit 1–100 |
| GET | `/volatility-assessments/:id` | MARKET_DATA_READ; full immutable evidence |
| POST | `/volatility-assessments/run` | SYSTEM_OWNER; empty body; published/attempts/suppressed/notDue/blocked |

Deploy the additive constraint migration
`20260917120000_volatility_v1_assessment_constraints`, then explicitly bootstrap
the calendar before starting the new worker. No historical evidence is rewritten.
See [Volatility acceptance and recorded local results](../development/volatility-v1-acceptance.md).

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
approved production publisher. Authoritative publishers are separate from research execution.

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
| POST `/api/market-data/backfill` | `{from,to}`, up to 370 calendar days, all SPY/QQQ/DIA/IWM/RSP |
| GET `/api/market-data/trend-lab?from=...&to=...` | Candidate summaries, chart series, timeline and dataset identity |
| GET `/api/market-data/trend-lab/day?datasetId=...&profile=MIDDLE&date=...&from=...&to=...` | Exact per-date explanation from that research snapshot |

The server holds at most two research snapshots for ten minutes; at most two range
calculations may be in flight. Refresh explicitly rebuilds inputs. Date inspection
never silently changes datasets; expired/evicted snapshots are rebuilt using the
requested from/to range. Day evidence is returned only when the rebuilt datasetId
matches; changed evidence returns 409 and requires explicit research refresh.
Unknown dates in a verified dataset return 404. These caches
are transient research results, not authoritative assessment persistence.

Normal loads reuse the server snapshot. Only the explicit Refresh research action
sends refresh=true, replaces the range query, and invalidates its date-detail queries.

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

### Participation Phase 1 daily acquisition expansion

The account-independent acquisition panel is `MARKET_DAILY_EVIDENCE_SYMBOLS`
(SPY, QQQ, DIA, IWM, RSP); `TREND_SYMBOLS` remains exactly SPY/RSP.
Daily backfill, sync and status cover all five. Existing catalog rows are required;
the canonical `src/db/securities.json` already defines them. No subscriptions are
created by acquisition. Stored bars remain insert-only Massive DAY_1 UNADJUSTED.

Status retains operational gaps from the persisted checkpoint and additionally
returns each symbol's `coverageFrom` and `historicalMissing` over the last 370
calendar days. Counts/earliest/latest describe actual matching stored evidence.
A successful sync says nothing about pre-checkpoint warmup; explicitly backfill
missing history. Historical gaps use persisted calendar configuration, not a
reviewed calendar overlay, and are not Participation window certification.

Sync retains its hourly retry gate and maximum 20 missing-date requests per symbol
per tick (up to 100 for five symbols). Transport timeouts remain 30 seconds per
request, pagination remains bounded, and the existing running/advisory guards
prevent overlapping ticks. The three-minute worker-health threshold remains an
operational warning, not a total invocation deadline; slow provider/backlog work
can exceed it. Acceptance must observe five-symbol provider latency/entitlement.
The strict split path is `fetchStrictSplitEvidence`; legacy split callers retain
identical-ID deduplication. The account-independent Participation publisher is
documented in `docs/development/participation-v1-phase2.md` and has no trading consumer.
