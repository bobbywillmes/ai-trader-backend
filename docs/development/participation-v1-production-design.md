# PARTICIPATION_V1 production publication design

Design only, 2026-09-20, for `feat/market-regime-expansion`. No publisher, worker,
route, migration, UI, or trading integration is implemented by this document.
Research commits: `d94175d5ac977104ce8cd40af0b6780114a2bd2d` and
`b13187aeb6fa4572e11e6fb8cbe26d0508eb8c8c`.

**PARTICIPATION_V1 has ZERO trading authority.** Publication is account-independent
evidence only. It must not enter StrategyMarketRegimePolicy, overall regime
composition, SignalEvaluation, EntryDecision, OrderIntent, strategy eligibility,
position management, or entry/exit behavior.

## 1. Frozen algorithm and versioning

Question: “How broadly elevated or subdued is trading activity across a deliberately
diverse panel of major U.S. equity index ETFs?”

Use five equal normalized sensors in fixed order: SPY, QQQ, DIA, IWM, RSP.
For each ETF, divide normalized target daily volume by the median of the exact
previous 20 eligible completed FULL-session normalized volumes. Exclude the target
from its baseline. The market measurement is the median of all five RVOL20 values.

| State | Panel median RVOL |
| --- | --- |
| QUIET | < 0.75 |
| NORMAL | >= 0.75 and < 1.25 |
| ACTIVE | >= 1.25 and < 1.50 |
| INTENSE | >= 1.50 |

`rawState == effectiveState`. No hysteresis, confirmation, recovery delay,
transition restriction, agreement gate, price direction, or prior-state input.
Direct QUIET -> INTENSE and INTENSE -> QUIET are valid. Memory consists only of
the rolling volume baseline. The median of 20 averages the sorted tenth and
eleventh values; the panel median is the third sorted value. Compare unrounded
values with thresholds. Zero target volume is valid with a positive baseline;
zero median baseline cannot produce an RVOL.

Proposed constants: `PARTICIPATION_ALGORITHM_VERSION = 'PARTICIPATION_V1'` and
`PARTICIPATION_PUBLICATION_EVIDENCE_VERSION = 1`, consistent with Volatility's
string algorithm/integer evidence versions. Freeze the panel, baseline length,
thresholds, eligible-session rules, vocabulary, and split normalization semantics
in a production definition. Semantic changes require deliberate algorithm version
evolution; evidence layout changes require evidence version evolution. Neither is
an operator-tunable setting. No 40-session calculation or field enters production.

The [frozen research](participation-v1-calibration-results.md) has 1,224 valid
panel20 observations: QUIET 160 (13.071895%), NORMAL 803 (65.604575%), ACTIVE 164
(13.398693%), INTENSE 97 (7.924837%). These are regression evidence, not production
distribution targets. Early historical coverage gaps before late 2021 have no
assigned cause. Provider daily aggregate volume is not strictly reconstructed
09:30–16:00 volume; retain this explicit V1 limitation.

## 2. Architecture inspected and reuse decisions

Paths below are relative to the repository root. Actual code and migration SQL,
rather than older summaries, establish current capabilities.

| Inspected source | Finding / recommendation |
| --- | --- |
| `prisma/schema.prisma`; migrations `20260915120000_market_data_trend_foundation`, `20260917120000_volatility_v1_assessment_constraints`, `20260918120000_add_market_breadth_observation` | Reuse immutable assessment model, attempt identity, partial VALID uniqueness, composite predecessor FK, and immutable MarketBar. PARTICIPATION enum already exists. |
| `src/services/trend-assessment.service.ts` | Reuse publication lineage, transaction lock, terminal attempts, deduplicated blocked events, and read APIs. Do not copy EMA replay, observed-date bootstrap calendar, or recovery continuation. |
| `src/services/volatility-assessment.service.ts`, `volatility-v1.definition.ts` | Closest publication scaffold: explicit expected dates, calendar preflight, per-target grace guard, bounded catch-up and split evidence. Do not copy ATR/return windows or hysteresis. |
| `src/services/breadth-v1-assessment.service.ts`, `src/workers/breadth-assessment.worker.ts` | Production Breadth exists here. It uses stored MarketBreadthObservation and stateful replay, with an explicit observation bootstrap prerequisite. Participation needs neither its observation table/artifact nor ingestion inside its publication worker. |
| `src/dev/intraday-stress-*` and local `main` tree | Research implementation only; no production Intraday Stress publisher found on either inspected tree. No branch merge or fetch performed. |
| `src/services/market-bar-ingestion.service.ts`, `trend-lab.config.ts`, `src/integrations/massive/evidence.client.ts` | Daily acquisition, backfill, status and client types are currently tied to SPY/RSP. Separate shared daily-evidence identity from Trend's panel before adding the other three sensors. |
| `src/services/trend-calculation.ts`, `src/dev/participation-calculation.ts`, `participation-research-data.ts` | Reuse split-volume formula and frozen pure math; preserve strict Participation split validation. Keep disk-cache/research adapters out of production. |
| `src/services/market-calendar.ts`, `market-calendar.service.ts`, `market-calendar-bootstrap.*`, `src/dev/intraday-stress-calendar.ts` | Existing ET calendar and DAY_1 grace suffice. Shared production bootstrap currently seeds closures only; early closes are present in research configuration but are not automatically persisted. |
| `src/workers/*assessment.worker.ts`, `market-data.worker.ts`, `worker-health.definitions.ts`; `src/services/worker-health.service.ts`; `src/app/server.ts` | Daily publishers run every 15 minutes, monitored globally. Daily ingestion ticks each minute with a persisted hourly retry gate. |
| `src/routes/market-data.routes.ts`, `src/controllers/volatility-assessment.controller.ts`, `src/app/app.ts` | Reuse admin mount, MARKET_DATA_READ reads, owner-only manual run, strict validation and pagination. |
| Publisher `systemEvent.create` calls; `src/services/worker-operational-attention.service.ts` | Assessment events are transactional. Account-worker OperationalAttention is not a reason to add account-scoped attention to Participation. |
| `src/services/volatility-assessment.service.test.ts`, `src/db/__tests__/market-data.integration.test.ts`, `volatility.integration.test.ts`, route and worker tests | Reuse real PostgreSQL concurrency/immutability coverage, boundary-clock injection, suppressed-failure health checks, and trading-table invariance assertions. |

Participation is simpler: one target needs only 21 full dates × five ETFs. It does
not need the entire stored history, predecessor evidence decoding, a transition
engine, replay confirmation state, or a new derived-observation table.

## 3. Target and currentness semantics

Use `marketSession`, `etDate`, `etInstant`, `addDays`, persisted
MarketCalendarException, and `COMPLETION_GRACE_MINUTES.DAY_1` (currently 30).
A Participation full session has open 570 and close 960 ET minutes and is not an
EARLY_CLOSE exception. Weekend/CLOSED dates have no session. Do not change general
DAY_1 eligibility: other dimensions legitimately consume early-close daily bars.
Add a small full-session selector over the shared calendar, not another calendar.

For full session D:

- `sessionDate = D` as a SQL DATE; use the existing UTC date-only representation.
- `targetAt = etInstant(D, 960)` (16:00 America/New_York), never bar midnight or
  publication time.
- `dueAt = targetAt + 30 minutes`; D is due iff the invocation's frozen `now >= dueAt`.
- For VALID, `dataThroughAt = targetAt`: evidence through that completed daily
  session, not receipt time and not an assertion of strict regular-hours volume.
- Let N be the next eligible FULL session after D. `validUntil = N.closeAt + 30
  minutes`, frozen into the row at publication. The freshness endpoint is exclusive:
  at `now == validUntil`, D is stale, whether or not N's evidence has arrived.
- A returned latest VALID row is current only after it was published and before
  its persisted validUntil. A delayed catch-up result may already be stale when
  inserted; VALID describes successful calculation, not guaranteed currentness.

| Calendar sequence | Result for D's VALID assessment |
| --- | --- |
| Monday full -> Tuesday full | Monday 16:00 target, publish no earlier than 16:30; expires Tuesday 16:30 ET. |
| Friday full -> Monday full | Friday remains current over weekend until Monday 16:30 ET. |
| Friday full -> Monday CLOSED -> Tuesday full | Friday expires Tuesday 16:30 ET. |
| Friday full -> Monday EARLY_CLOSE -> Tuesday full | Friday remains current all Monday, then expires Tuesday 16:30 ET. No Monday Participation row. |
| Consecutive holidays/early closes | Continue to the next FULL date, then use its close plus grace. |

Use ET instants independently for each date across DST; never add a fixed 24 or
72 hours to derive the next cutoff. Search bounded calendar horizons (370 days for
next/latest targets); inability to establish a next full date is calendar failure,
not indefinite validity. Freeze invocation `now` before selection and recheck each
selected target against that same instant before inserting. A run begun just
before 16:30 must not include that day's target even if I/O crosses 16:30.

Early closes produce no assessment of any status solely for being shorter. They
are explicitly recorded as excluded calendar dates, not missing bars. An older
unresolved full target may still be retried on an early-close day or weekend.

### Calendar prerequisite and edits

Production reads persisted exceptions only. The present shared closure bootstrap
covers 2021–2026 but omits EARLY_CLOSE rows. Before activation, extend the reviewed
shared calendar bootstrap/verification definition to include the existing reviewed
early-close evidence, with operator-applied conflict detection. Do not import the
research calendar as a runtime overlay or let workers seed configuration.

Preflight the baseline-through-next-full interval against that reviewed coverage,
including missing/conflicting known closures and early closes. Persist the applied
exception snapshot and verified coverage bounds. A horizon beyond reviewed coverage
requires calendar maintenance; absence of an exception is not proof of coverage.
Use FAILED/CALENDAR_EVIDENCE_UNAVAILABLE for a known full target with unusable
calendar evidence. If no trustworthy full target identity can be established,
fail the run/health check without inventing an assessment date (especially without
inserting an early-close target). This is an activation prerequisite, not a new
calendar model or schema.

Calendar changes are prospective configuration. Do not recalculate persisted
validUntil on reads. Reuse original targetAt for retries. An edit that reclassifies
an already-attempted full target as closed/early-close must block operator-visible
progression, never erase/rekey/skip that target or calculate it as a full day.
Validate before ordinary notDue returns. Resolve the calendar conflict explicitly;
do not rewrite assessment history. Unexpected retrospective calendar corrections
can leave published freshness based on the old snapshot: disclose this operational
limitation, and require review rather than silently altering immutable evidence.

## 4. Stored evidence dependencies and daily ingestion

The code does **not** guarantee daily Participation coverage today:

| ETF | Existing daily sync/backfill/status panel |
| --- | --- |
| SPY | Included through TREND_SYMBOLS; actual DB coverage still needs checking. |
| QQQ | Not included. |
| DIA | Not included. |
| IWM | Not included. |
| RSP | Included through TREND_SYMBOLS; actual DB coverage still needs checking. |

This finding is static inspection, not a claim about live Security rows, MarketBar
contents, credentials or provider entitlements. No database or provider was queried.
Trading subscriptions do not control this global daily evidence feed. It is a
hard-coded acquisition panel, not account subscription configuration.

Implementation should introduce a shared daily-evidence symbol type/panel covering
all five; adapt daily ingestion/backfill/status and the strict Massive daily/split
client to that type. Keep `TrendSymbol`/`TREND_SYMBOLS` limited to SPY/RSP and leave
the research adapter isolated. Existing Security rows for all five are mandatory;
provision missing catalog entries explicitly. Do not create trading subscriptions.
Verify Massive entitlement for each requested history range during acceptance.

Consume only stored `MarketBar` with `DAY_1`, `MASSIVE`, `UNADJUSTED`, matching
Security and Eastern-midnight barStartAt. Never fetch daily bars from the publisher,
fall back to Alpaca, silently use adjusted bars, or rewrite accepted OHLCV. Existing
insert-only backfill is the acquisition path. The MarketBar unique identity is
Security/timeframe/barStartAt; provider/adjustment filters should remain explicit
in publisher and coverage queries even though only one of each exists today.

Daily sync's `marketDailyEvidenceSync` checkpoint starts at initialization day and
retains its floor. Adding three symbols does not create the prior 20-session
baseline automatically; backfill the exact required dates explicitly before
activation. Existing backfill is bounded to 370 calendar days per request. Preserve
unfinished gaps and bounded per-symbol work when generalizing it. Keep early-close
DAY_1 ingestion for other consumers, while Participation excludes those dates.

Missing ingestion is visible through the checkpoint's lastResult, status gap lists,
backfill events, and thrown sync errors. `market_daily_evidence_sync` already has
global informational worker health, but currently describes/covers SPY/RSP only.
Expand its panel description/status coverage and verify timeout budgets for five
symbols. Its one-minute scheduler does not mean provider calls every minute: a
persisted one-hour retry interval is shortened to an upcoming completion cutoff.
A healthy sync cannot certify pre-checkpoint bootstrap coverage; the publisher
independently validates its exact window. An ingestion/publication race after
16:30 may create an unavailable attempt; later ingestion plus retry resolves it.

## 5. Exact baseline and split evidence

First enumerate the exact prior 20 FULL dates using the shared persisted calendar,
then look up all five bars for each date plus the target (105 observations).
Never choose the last 20 *present* bars. Missing an expected full date does not
permit a 21st older substitute. Save intentionally excluded early-close dates
separately from missing expected dates. A bounded backward search must either
establish 20 dates within reviewed coverage or report insufficient/calendar history.

Use the existing split endpoint `/stocks/v1/splits` and safe transport/pagination,
after broadening its production symbol boundary. For one target D, fetch each
ETF over the inclusive interval `[oldestRequiredBaselineDate, D]`. Events on the
first date cannot affect that date's bar but retaining them makes the fetch range
explicit. Apply only events with `bar.date < executionDate <= D`.

For a bounded catch-up run, plan at most 20 due targets up front. Fetch once per
ETF over `[oldestBaselineDateOfFirstTarget, lastPlannedTargetDate]`; cache validated
results in that invocation, and slice to each target's interval. No process-global
negative cache or research disk-cache dependency. Retry fetch failures on a later
invocation; successful empty results are evidence of no events in that range,
whereas a failed/incomplete fetch must never become `[]`.

Validate every page, symbol, ID, execution date, requested range, finite positive
splitFrom/splitTo/priceFactor and ratio consistency (existing tolerance < 1e-12).
Reject duplicate IDs and duplicate execution dates as ambiguous per frozen research.
The existing client deduplicates identical IDs before returning them: preserve
raw duplicate detection for Participation at the parsing boundary, rather than
assuming returned-array validation can detect duplicates already discarded. Avoid
silently changing other clients' accepted contract while adding this strict path.
Invalid pagination, incomplete response, mismatched identity, malformed/conflicting
events or timeout means FAILED/SPLIT_EVIDENCE_UNAVAILABLE. Store sanitized failure
category and affected symbols; never provider URLs, credentials or arbitrary bodies.

For each bar, `priceFactorProduct = product(splitFrom / splitTo)` over applicable
events, and `normalizedVolume = rawVolume / priceFactorProduct`. Reuse
`normalizeSplits` with unit OHLC, as research does, so price direction is not an
input. Check finite positive factors and finite nonnegative normalized volumes;
zero denominator/nonfinite RVOL cannot classify. `normalizationThrough = D` for
each target, never the newest catch-up date. Target volume normally has factor 1.
Splits on an excluded early-close date still normalize earlier full-session bars.

Research normalizes to its report end; expressing target and all baseline values
on the target-date share basis preserves their ratio because later splits multiply
both sides by the same constant. Test parity, including threshold-adjacent fixtures;
this changes audit basis, not V1 formula. Persist the normalized inputs, exact
validated split events, fetch range, per-bar factors and normalizationThrough.

## 6. Publisher state machine and bootstrap

Proposed `publishParticipationAssessments` follows the Volatility service boundary
with injected DB, frozen `now`, audit clock and split client for testing.

1. Begin an interactive transaction; acquire a nonblocking transaction advisory
   lock before reading publication state. Load the calendar snapshot and scoped
   latest VALID predecessor (`PARTICIPATION`, `PARTICIPATION_V1`).
2. Find the earliest unresolved attempted target after that predecessor and its
   highest attempt. Pending identity wins over new target selection. Detect
   contradictory lineage/calendar state rather than skipping it.
3. If pending exists, retry it. Otherwise, after bootstrap choose exactly the next
   FULL target after the predecessor. On a fresh identity with no attempts, choose
   the latest due FULL target from the calendar, independently of available bars.
4. If selected target is not due, return notDue before bar/split work. Snapshot
   expected dates, check calendar, then load stored observations and validate splits.
5. Calculate all five RVOLs and panel state, or assemble a terminal unavailable/failed
   result. Read the highest attempt for this target, compute fingerprints, and
   suppress an identical non-VALID attempt without concealing blocked status.
6. Insert attempt `max(attempt) + 1` and its meaningful SystemEvent atomically.
   A failure blocks this and all later targets. A VALID result becomes predecessor.
7. Fresh bootstrap returns after its one assessment. Normal continuation/recovery
   may process up to 20 chronological targets; stop on the first unresolved one.
   More backlog is continued by the next invocation.

**Bootstrap recommendation:** load the current target plus exactly 20 prior full
dates. No state replay is necessary; record baseline initialization provenance.
Publish only that current authoritative result. Never create warm-up assessments.
On complete evidence it is the latest eligible, calculable full target. On missing
current/baseline evidence, insert a failed/unavailable attempt for the latest due
target and pin it. Do not search backward to publish an older convenient VALID
result while suppressing a known missing current target.

This deliberately narrows Trend/Volatility/Breadth's “latest calculable historical
bootstrap then catch up” fallback to honor the explicit missing-target requirement.
It does not change the classifier. Their replay establishes recursive calculation
state; Participation only needs its exact current window. Internal historical
comparison may be useful for acceptance but grants no authority to replayed dates.
If first bootstrap is pinned across several days, repair and publish that same
target first (possibly already stale), then catch up in order. No new bootstrap
selection occurs after an attempt exists.

### Terminal outcomes

| Condition | Status / reason | Evidence and action |
| --- | --- | --- |
| No new due FULL target | No row; notDue | No bar/split requests or events. |
| Early close only | No row | Excluded date, never an unavailable shortened-session result. |
| Missing Security, target bar, or a specific required baseline bar within the supported calendar | UNAVAILABLE / MISSING_MARKET_DATA | Identify symbol, date and TARGET/BASELINE/SECURITY role; stop progression. |
| Fewer than 20 eligible baseline dates within supported history, with trustworthy target calendar | UNAVAILABLE / INSUFFICIENT_HISTORY | Include expected/available window counts and supported lower bound. Do not call an ordinary missing bar insufficient history. |
| Valid volumes but median baseline is zero | UNAVAILABLE / INSUFFICIENT_HISTORY | Detail ZERO_MEDIAN_BASELINE; no RVOL or neutral state. |
| Required split request fails or split evidence is invalid | FAILED / SPLIT_EVIDENCE_UNAVAILABLE | Distinguish request failure from malformed/conflicting evidence in details. |
| Required calendar evidence unavailable/conflicting | FAILED / CALENDAR_EVIDENCE_UNAVAILABLE when target identity is established | Otherwise fail run without fabricated target; operator repair required. |
| Duplicate/invalid bar mapping, invalid numeric conversion, nonfinite arithmetic or unexpected calculation exception | FAILED / CALCULATION_FAILED | Sanitized stable detail; never partial panel. |
| All dependencies and calculations valid | VALID / null | Both states equal; dataThroughAt and validUntil populated. |

All non-VALID rows have null rawState/effectiveState/dataThroughAt/validUntil.
Evidence can retain partial inputs and proposed next cutoff but never an effective
fallback state. Use deterministic primary-reason precedence: calendar, invalid
stored inputs, missing expected data, insufficient/zero baseline history, split
evidence, arithmetic failure. Record all safely observable missing items; do not
fetch unnecessary splits when earlier checks already block calculation. Provider
daily acquisition failure remains ingestion health evidence; absence in the
publisher is a coverage fact and does not prove why the bar is missing.

## 7. Immutable predecessor semantics

`previousAssessmentId` points to the latest earlier VALID assessment of the same
dimension/version, or null for all pre-bootstrap attempts. Failed attempts remain
accessible by target and attempt; they do not become the VALID chain's predecessor.
Retries of a blocked target therefore point to the same earlier VALID row.

Validate predecessor identity, VALID status and strictly earlier target. The FK
enforces dimension/version, not chronological order or VALID status; enforce the
latter in service/tests. Prior raw/effective state may be read solely to describe
a SystemEvent state change. It must never enter the pure calculator, initialize a
state machine, or require decoding predecessor confirmation/evidence fields.
Persist `lineage.calculationAuthority = false`. Predecessor state changes in test
fixtures must leave current calculated evidence and state unchanged.

## 8. Evidence JSON recommendation

Embed all 100 baseline observations plus five target observations. This is a small,
bounded daily payload and makes a VALID result independently recalculable. IDs,
ranges or hashes alone cannot show normalized values or prove which missing dates
were omitted. Avoid duplicate OHLC arrays, raw provider responses and whole-history
replay dumps. Reuse a single ordered 20-date baseline plan across the five sensors;
each baseline array uses the same indices and must have length 20.

Proposed shape (types/placeholders, not literal persisted JSON):

```typescript
{
  algorithmVersion: 'PARTICIPATION_V1', evidenceSchemaVersion: 1,
  definition: {
    symbols: ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'], baselineSessions: 20,
    aggregation: 'median-of-five-rvol20', thresholds: [0.75, 1.25, 1.50],
    states: ['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE'],
    hysteresis: false, diagnosticsAffectClassification: false
  },
  sessionDate, targetAt, dataThroughAt, validUntil, completedAt,
  calendar: {
    timezone: 'America/New_York', openMinutes: 570, closeMinutes: 960,
    graceMinutes: 30, dueAt, verifiedCoverage: { from, through },
    baselineSessionDates: [/* exact 20 full dates, ascending */],
    excludedEarlyCloseDates: [/* within baseline-to-next-target interval */],
    exceptions: [/* relevant persisted row identities and semantic values */],
    nextEligibleFullSession: { sessionDate, closeAt, dueAt }
  },
  provenance: {
    provider: 'MASSIVE', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED',
    normalizationThrough: sessionDate,
    adjustmentSemantics: 'Volume divided by explicit split price-factor product; no dividend adjustment',
    volumeScope: 'Provider daily aggregate; not reconstructed regular-hours volume',
    canonicalInputHash
  },
  instruments: [/* fixed panel order */ {
    symbol, securityId,
    target: { marketBarId, sessionDate, barStartAt, rawVolume,
              normalizedVolume, priceFactorProduct, receivedAt },
    baseline: [/* 20 items aligned to calendar.baselineSessionDates */ {
      marketBarId, rawVolume, normalizedVolume, priceFactorProduct
    }],
    medianVolume20, rvol20, dataThroughAt,
    splitEvidence: {
      requestedFrom, requestedThrough, fetchedAt, complete: true,
      events: [/* id, symbol, executionDate, splitFrom, splitTo, priceFactor */]
    }
  }],
  panel: {
    rvol20BySymbol: { SPY, QQQ, DIA, IWM, RSP }, panelMedianRvol,
    rawState, effectiveState,
    diagnostics: {
      agreement: { le070, le080, ge100, ge125, ge150, ge200 },
      minimumRvol, maximumRvol, range, affectsClassification: false
    }
  },
  lineage: { previousAssessmentId, calculationAuthority: false },
  bootstrap: true | false,
  initialization: { /* first successful publication only */
    mode: 'baseline-only', baselineFrom, baselineThrough,
    eligibleBaselineSessionCount: 20, inputBarCount: 105,
    replayedAssessmentCount: 0, publishedHistoricalAssessmentCount: 0
  },
  reasonCode: null | reason,
  missingEvidence: [/* { symbol, sessionDate, role, detailCode } */],
  failures: [/* stable, sanitized dependency/calculation details */],
  attemptFingerprint
}
```

Persist raw Prisma decimals as canonical decimal strings; calculated normalized
values/factors/RVOL as finite numbers using the frozen numeric method. Preserve
zero distinctly from null. For non-VALID evidence, retain expected baseline slots
with null identities/values for absence, omit incomplete panel classification,
mark split completeness/failure explicitly and keep row states null. No NaN/Infinity
serialization. Hash the canonical inputs before serialization loses numeric detail.

Canonical SHA-256 input hashing follows existing dimensions but specifies stable
ordering: fixed panel order, ascending baseline dates, split events by date/ID,
calendar exceptions by date, fixed field order and decimal-string normalization.
Include semantic definition/version, target and expected-date plan, relevant
calendar values, source IDs/raw volumes and relevant split events. Exclude fetch
times, received-at metadata and run clocks from identity hashing. Per-target hashes
exclude cached events beyond that target, so batching does not change identity.
The panel RVOL map repeats only five numbers for readability; baseline dates and
OHLC are not duplicated for each sensor. Raw/effective states repeat DB columns
for a self-contained evidence export and must be checked for consistency.

## 9. Idempotency, transaction and connection model

Use `PARTICIPATION_PUBLICATION_LOCK_KEY` derived exactly as other dimensions:
SHA-256 of `ai-trader:participation-v1-publication`, first signed 64-bit big-endian
integer. Lock with `pg_try_advisory_xact_lock`; one global dimension/version lock,
no account lock and no session-lock connection management.

All publication selection, attempt reads, bar/calendar reads, inserts and events
use the transaction client. Load calendar/bar evidence once for the planned batch
and calculate from those captured arrays. A concurrent ingestion commit is either
present in that read or recovered on the next run; never combine changing reads
to silently replace baseline dates. Split fetches may occur inside the transaction,
as in existing publishers, but bound the entire fetch phase with cancellation and
a run deadline, not just per-request timeouts. Five first pages may be fetched in
parallel. Stop pagination/retries within the budget. Reuse the 240-second transaction
timeout and 5-second maxWait as ceilings, reserving time to write failure evidence;
do not allow 20 pages × 30 seconds to outlive the transaction budget.

Lock contention returns HTTP 409; worker treats it as already_running. Attempts
start at 1 and increment under the lock for the same dimension/version/target.
Reuse a prior targetAt after calendar edits; never create a second identity for
the same previously attempted date. Final guards are the existing attempt unique
index and partial one-VALID-per-target unique index.

On P2002, roll back, then verify a committed VALID winner for the exact identity
before treating the outcome as idempotently suppressed. An attempt collision
without such a winner is an error, not success. Transaction rollback also removes
any earlier batch inserts/events; return counters for committed work only. The
next run resumes at the earliest still-unresolved target.

`attemptFingerprint` covers input hash, status, reason and stable failure details,
missing slots, targetAt, proposed validUntil, versions and predecessor ID. Exclude
audit timestamps and transient error prose. An identical latest non-VALID attempt
is suppressed after dependencies are rechecked, returning `blocked` nonetheless.
Changed inputs or failure categories produce later immutable attempts. A recovered
VALID result is never suppressed just because the raw bar hash is unchanged.

Database/connection failure may prevent persisting any assessment: propagate it to
worker health; never claim a durable attempt. Transaction-scoped locks release on
commit, rollback or connection loss. Shutdown must stop new ticks, cancel/bound
split calls and drain or roll back in-flight publication before disconnecting the
DB. No delayed task may write using a released transaction. Test actual connection
loss and subsequent reacquisition in an isolated PostgreSQL database.

The current server shutdown has a five-second wait for health/pool cleanup and
then exits; it does not demonstrate draining a four-minute assessment transaction.
Do not assume adding another setInterval supplies graceful publication shutdown.
Wire explicit cancellation/stop-scheduling for this worker, or prove bounded process
termination rolls back its transaction and the next process resumes safely. This
is an implementation acceptance requirement, not a reason for session-level locks.

## 10. Worker and health

Use a global informational `participation_assessment_publication` worker on startup
and every 15 minutes, matching existing daily dimensions. At 16:30 ET the target
becomes due; the first regular tick at/after that instant checks it (up to one
cadence later). The 30-minute grace is an evidence eligibility rule, not a promise
that Massive has delivered every bar. Manual owner run can check sooner after due.

Before due or already current: cheap calendar/lineage checks and notDue, no provider
or bar scans, no attempt/event. Weekends, holidays and early closes do not create
new targets; still retry an older blockage or catch up after downtime. A 15-minute
retry cadence is sufficient and aligns with current publisher conventions; no
second-level polling or independent cron/calendar is needed.

Register with WorkerHealthRegistry and existing server scheduling. Use existing
threshold derivation: 15-minute expected interval, 45-minute startup grace,
37.5-minute delayed threshold, 75-minute stale threshold and 240-second max run.
Heartbeat health is distinct from assessment freshness. notDue -> skipped/not_due;
lock contention -> skipped/already_running; published -> success/workSucceeded;
blocked (including suppressed attempts) -> failure. Do not convert persistent
missing data into healthy idle ticks. Use existing failure fingerprint logging and
recovery behavior. Update exhaustive WorkerKey maps, including the global placeholder
in `trading-account-workflow-runner.service.ts`, without adding account coordination.
Do not connect this worker to OperationalAttention.

## 11. SystemEvent behavior

Use `entityType = 'market_regime_assessment'`, assessment ID as entityId, with
assessmentId, sessionDate, attempt, reasonCode, previousAssessmentId and relevant
previous/current state in sanitized payload. Insert event and assessment together.

| Event | Severity | When |
| --- | --- | --- |
| participation_assessment_bootstrap | INFO | First successful authoritative row; include initialization provenance summary. |
| participation_assessment_blocked | WARNING | A new terminal non-VALID attempt is actually inserted. |
| participation_assessment_recovered | INFO | Same target becomes VALID after a non-VALID attempt. |
| participation_assessment_transition | INFO | Ordinary valid continuation changes state versus earlier VALID predecessor. |

Use one event per inserted row, precedence blocked, bootstrap, recovered,
transition. Bootstrap after failed first attempts includes recoveredFromAttemptId;
recovery payload also reports any state change. No INFO event for unchanged valid
state, no event for notDue, duplicate suppression or an excluded early close.
Direction of a Participation state change is activity level only, not market price
direction. Infrastructure failures without a row use existing worker health/logging.

## 12. HTTP/API surface (no UI)

Under existing `/api/market-data` authenticated/admin mount:

| Method/path suffix | Authorization / behavior |
| --- | --- |
| GET `/participation-assessments/latest` | MARKET_DATA_READ; `{ latestAttempt, latestValid }`, independently queried, null if none. Do not hide a newer blocked attempt behind old VALID evidence. |
| GET `/participation-assessments` | MARKET_DATA_READ; ID-descending cursor list, strict limit 1–100/default 20 and optional positive beforeId. |
| GET `/participation-assessments/:id` | MARKET_DATA_READ; positive ID, fixed dimension/version scope; 404 for absent or other-dimension row. |
| POST `/participation-assessments/run` | SYSTEM_OWNER only; strict empty body, no dates, profiles, state overrides, symbols or force-skip. Invoke same publisher as worker. |

Follow thin existing controllers and `marketController` error mapping. Register
`latest` before `:id`. Manual result mirrors `{ published, attempts, suppressed,
notDue, blocked }`; blocked evidence is a normal structured publisher result,
not a hidden neutral assessment. HTTP 409 is lock contention. Readers evaluate
freshness from immutable validUntil; never mutate rows or extend freshness when
the next target fails. Owner/operator reads and account-user/anonymous denial
must be tested. No PUT/DELETE, account scoping or UI changes.

## 13. Database/migration requirements

No new enum, table, column, relation, mutable current pointer or observation store
is needed. Existing states are strings, and reasonCode is free text. Current SQL
whitelists TREND, VOLATILITY and BREADTH states by **dimension**, not algorithmVersion;
it does not yet permit any non-null PARTICIPATION state. SessionDate currently is
required for those three daily dimensions only.

Recommend **one SQL constraint-only migration**, with two existing checks extended:

1. `RegimeDimension_states_check`: retain existing arms unchanged; add an arm for
   dimension PARTICIPATION AND algorithmVersion PARTICIPATION_V1, both states in
   QUIET/NORMAL/ACTIVE/INTENSE AND rawState = effectiveState. This makes future
   Participation state semantics a deliberate version/constraint decision.
2. `RegimeDimension_terminal_check`: add PARTICIPATION to dimensions requiring
   sessionDate for every status. Preserve all existing terminal checks.

Thus the recommendation is not *only* a state-whitelist extension: the daily
sessionDate requirement also needs an extension. A whitelist-only migration could
permit inserts but would omit the daily invariant. No Prisma structural schema
change or generated DBML model change is expected; update stale descriptive comments
when implementing and inspect generated artifacts if client generation is run.
Never run prisma format. No migration is created in this design phase.

Retain `RegimeDimension_attempt_key` (dimension/version/targetAt/attempt), partial
`RegimeDimension_valid_key`, composite predecessor FK, not-self check and immutable
trigger unchanged. They already preserve attempts and one VALID target. SQL does
not enforce correct ET targetAt, close-plus-grace eligibility, FULL-only dates,
chronological predecessor VALID status, or evidence/column equality: service and
integration tests own those rules. Do not introduce a calendar-dependent DB check.

Before applying the future migration, inspect existing PARTICIPATION rows (including
non-VALID rows that the old schema permits) for sessionDate and identity compliance.
If incompatible rows exist, stop for audit review; do not delete/backfill them to
make a migration pass. Validate migration replay from empty DB and against the
current migration chain; preserve Trend/Volatility/Breadth constraint behavior.

## 14. Production test plan

Tests listed here are future implementation requirements, not claims of passing
production Participation tests today.

| Area | Required cases and assertions |
| --- | --- |
| Frozen math | Just below, exactly at, and just above 0.75/1.25/1.50; median-of-20 and median-of-five; equal sensor weighting; target excluded; no rounded threshold comparison. |
| State independence | rawState == effectiveState always; direct QUIET -> INTENSE and reverse; all possible predecessor states produce identical current result; no confirmation/recovery fields or 40-session dependency. |
| Input completeness | Missing each of five target bars, missing Security, one baseline bar, entire all-five baseline date absent; no 4-of-5 output and no older replacement; explicit TARGET/BASELINE diagnostics. |
| Numeric validity | Zero target accepted; zero baseline unavailable; negative/nonfinite/duplicate evidence fails; decimal serialization deterministic and calculation never serializes NaN/Infinity. |
| Calendar exclusion | Early close not a target for any status; early-close bars absent or present do not affect baseline; expected 20 dates identical across ETFs; holiday/weekend exclusions. |
| Currentness | Friday -> Monday early close -> Tuesday full expires Tuesday 16:30 ET; ordinary next full session, weekend, holiday chains, DST, consecutive early closes; at-cutoff stale; no read-time rewrite after calendar edit. |
| Calendar failure | Missing reviewed early-close or holiday row; conflicting exception; coverage exhaustion; invalidated pending target cannot be skipped/rekeyed; no trustworthy target means no fabricated row. |
| Boundary race | Frozen now at 16:29:59.999, exactly 16:30 and after; fetch crosses due boundary; next target not inserted prematurely; concurrent calendar edit does not mix snapshots. |
| Bootstrap | 105 complete observations -> one authoritative latest-due row and explicit provenance; no historical assessment replay; missing current/baseline evidence -> pinned current attempt, no backward fallback; subsequent recovery retains target identity. |
| Continuation | Earliest unresolved target blocks newer complete targets; identical retry suppressed but blocked; changed missing slots produce attempt 2; repaired retry VALID; attempts unchanged afterward; max 20 catch-up then resume correctly. |
| Splits | Forward/reverse/multiple splits, events on target and excluded early-close dates, exact boundary range, raw bars unchanged, target-date basis, report-end RVOL parity, one fetch per ETF/run, no post-target event contamination. |
| Split failure | Failed request distinct from successful empty result; malformed ratio/date/symbol; duplicate IDs including across pages and duplicate dates; incomplete/unsafe pagination; deadline expiry; no silent adjusted/raw fallback. |
| Fingerprints | Stable across clocks, fetch timestamps and batch size; changes for relevant inputs/calendar/failure category; recovered split availability is retried despite unchanged bars; no repeated blocked event for identical evidence. |
| PostgreSQL integrity | Full migration replay/drift; all four states; raw/effective inequality rejected for V1; all statuses require sessionDate; preserved other-dimension states; update/delete rejected; one VALID per target; unique positive attempts; composite FK cross-version/dimension and self-link rejection. |
| Real concurrency | Two independent publishers/connections; loser 409 before reads; one winner; P2002 with VALID winner suppressed, collision without winner propagated; rollback counters correct; dropped connection releases lock and later run resumes. |
| Lineage | Latest earlier VALID same version only; retries share predecessor; failed attempts remain; malformed prior confirmation evidence irrelevant; event comparison does not enter calculation/hash of mathematical inputs. |
| Events | Bootstrap, changed state, blockage and recovery with precedence; unchanged day silent; no events on notDue/suppression; transaction failure leaves no assessment event. |
| Worker | 15-minute cadence, startup run, notDue/lock skip, success, suppressed blockage stays failing, health persistence/recovery, deadline and shutdown behavior; no account-worker or attention writes. |
| Acquisition | Five-symbol daily sync/backfill/status; Trend retains two-symbol panel; initial checkpoint does not falsely certify warmup; all immutable insert paths preserve existing data; missing ingestion visible; provider filters and credential sanitization. |
| HTTP | Mounted authentication/admin guard, owner/operator reads, owner-only run, anonymous/account-user denial, strict body/query, invalid IDs/limits, detail scoping, cursor ordering, latestAttempt plus stale latestValid, no mutation routes. |
| Zero authority | Snapshot trading/evaluation/policy/current-regime/position tables before/after bootstrap, retries and catch-up; assert byte-for-byte unchanged. Dependency tests forbid broker calls or entry/exit service invocation. No UI integration. |

Use pure fixtures and injected clocks first, service mocks second, then real
PostgreSQL tests with the existing isolated-database harness. Real database tests
must actually run with `RUN_DATABASE_INTEGRITY_TESTS=1` and a disposable local DB;
a skipped suite is not concurrency validation. Implementation checks:
`npm.cmd run check`, `npm.cmd test`, `npm.cmd run build`, plus those database suites.
No web build is needed without UI changes.

## 15. Local/manual acceptance before deployment

1. Use a disposable local database, all migrations and conservative trading posture.
   Record before-snapshots of trading/evaluation tables and existing dimension rows.
2. Dry-run the shared calendar bootstrap with closures AND early closes over baseline
   through next target; review conflicts, then explicitly apply in that local DB.
   Confirm reviewed coverage reaches the next validity cutoff.
3. Check all five Securities and Massive access. Through the generalized acquisition
   layer, backfill at least the exact current full target plus prior 20 full dates.
   Inspect market-data status and query exact expected coverage; preserve raw IDs.
4. Run pure production calculations against frozen research fixtures/reference
   evidence where available. Reproduce 1,224-state reference distribution on that
   same dataset, allowing neither threshold tuning nor assumptions that freshly
   fetched provider data must equal the frozen cache. Reconcile any source changes.
5. Owner manual publication after due: verify exactly one bootstrap row, 105 inputs,
   split provenance, hash, raw == effective, correct next FULL cutoff and event.
   Recalculate every median/RVOL from exported evidence independently.
6. Rerun: no new row/event. Exercise missing-bar and split-failure fixtures in fresh
   isolated target scenarios; insert missing bars via ingestion (never delete immutable
   production evidence), retry and verify same-target attempt 2 before any next date.
7. Run two clients concurrently; inspect lock contention and uniqueness. Exercise
   clock-controlled weekend/holiday/early-close/boundary cases through test injection,
   not a production API time override.
8. Observe worker health failure/suppression/recovery, API permissions, and both latest
   fields during a stale gap. Confirm all trading snapshots and other dimensions
   unchanged and no broker calls.
9. Record commands/results, calendar coverage, data IDs, hashes, example assessments,
   permission checks and any entitlement/coverage limitation in acceptance notes.

## 16. Deployment sequencing and implementation order

1. Implement frozen pure Participation definition/calculator and full-session helpers
   with tests; separate reusable production math from research-only 40-session tooling.
2. Generalize shared daily/split evidence types and daily ingestion/status/backfill to
   the five-symbol acquisition panel without expanding Trend's calculation panel.
   Add strict Participation split parsing. Extend the shared reviewed calendar
   bootstrap/preflight to early closes and test conflict-only/no-write behavior.
3. Create the one constraint-only migration and PostgreSQL integrity tests. Preflight
   existing rows; no automatic data cleanup or schema formatting.
4. Implement publisher, bounded dependencies, evidence validator/hash and lineage,
   then real concurrency/retry/zero-authority tests.
5. Add owner/read endpoints and monitored worker wiring, including shutdown handling.
   Complete backend checks and local/manual acceptance; no UI work.
6. Deploy prerequisites before automatic publication: migration, reviewed persisted
   calendar, all five Security identities, required history acquisition, then
   publisher/worker activation. Use staged releases or explicit disabled worker
   startup while preparing evidence; do not rely on worker ordering to bootstrap.
7. On the production host use `docker-compose.prod.yml`, migration-before-worker
   rollout, rebuild/restart and health/API/evidence checks. Existing conservative
   trading settings remain unchanged. No execution gate or trading feature is enabled.

Only local design documentation is committed in this phase. Push, production access,
migration execution and all implementation remain separate future work. If rollout
fails later, disable Participation scheduling and retain immutable rows/events;
do not roll back by deleting evidence or narrowing CHECKs over existing valid rows.

## 17. Blockers and open operational checks

The frozen algorithm fits this model without a semantic change. Production readiness
is blocked by known, concrete prerequisites:

- Daily ingestion and strict evidence client types currently cover SPY/RSP only.
- Production calendar bootstrap omits early closes; shared persisted coverage must
  be completed and reviewed, including future-horizon maintenance beyond 2026.
- Assessment state and sessionDate CHECK constraints do not yet support this daily
  dimension as designed.
- Existing split response deduplication must not erase Participation's required
  duplicate-evidence rejection.
- Actual database history/catalog availability and Massive entitlement are unverified.

The latest-due bootstrap policy is an explicit recommendation resolving the tension
between “latest calculable” fallback and “do not skip missing expected targets.”
It prioritizes the latter and preserves a single current bootstrap when ready.
It needs review as publication policy, but does not alter frozen calculation semantics.
Unexpected retrospective calendar changes require operational review; this design
does not introduce mutable validity or retroactive authoritative corrections.

**PARTICIPATION_V1 has ZERO trading authority.** The future implementation is
publication infrastructure only; this deliverable is its design only.
