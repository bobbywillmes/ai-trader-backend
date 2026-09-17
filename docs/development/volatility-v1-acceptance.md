# VOLATILITY_V1 deployment and local acceptance

The frozen production version adopts the [calibrated definition](volatility-calibration.md)
without tuning. It publishes immutable dimension evidence and has no trading effect.
The research report remains historical calibration evidence, not production settings.

## Prepare before starting the new backend

```powershell
npx.cmd prisma migrate deploy
npx.cmd prisma generate
npm.cmd run calendar:bootstrap
npm.cmd run calendar:bootstrap -- --apply
npm.cmd run build
```

The new forward migration is `20260917120000_volatility_v1_assessment_constraints`.
It replaces only `RegimeDimension_states_check` (adding Volatility's four states)
and `RegimeDimension_terminal_check` (requiring sessionDate for Volatility as well
as Trend). It leaves the original foundation migration, existing rows, immutable
triggers, attempt identity, partial VALID uniqueness and restrictive predecessor
FK untouched. Prisma schema comments document the SQL invariants; client/DBML
generation is unchanged structurally.

Calendar bootstrap previews by default. `--apply` explicitly inserts all 59 verified
2021–2026 full-day NYSE closures from the previously reviewed research list, including
2025-01-09. Sources are checked in with the dates; there is no network access or
runtime scraping. A table lock excludes concurrent UI writes during preflight and
insert. Any conflict returns `applied:false`, `inserted:0`, conflict details and a
nonzero CLI exit code. Every date is checked before any insert. Equivalent means
the same CLOSED/null-close semantics and canonical name (ignoring capitalization
and whitespace). Different names are conservatively reported for operator review.
No existing row is updated or deleted. Resolve disagreements explicitly through
the owner/operator calendar workflow; do not blindly rename or replace rows.

Early-close entries are not seeded. They remain operator-maintained and are valid
sessions; their configured ET close time is respected. Without an early-close
entry, daily completion conservatively uses the regular 16:00 close. Maintain
future CLOSED/EARLY_CLOSE dates in the existing Market Calendar UI, especially
before 2027. The publisher requires known verified closures covering its history
and next-session horizon to exist in the DB; otherwise it records a terminal
`CALENDAR_EVIDENCE_UNAVAILABLE` attempt and avoids split requests. It never seeds
calendar configuration itself. There is no generic calendar platform.

## Definition and publication

SPY and RSP DAY_1 bars must be MASSIVE/UNADJUSTED. Existing split normalization
multiplies pre-execution OHLC by splitFrom/splitTo through the target date, entirely
in calculation. No dividends, raw-bar updates, provider payload copies or Alpaca
fallback. Required Massive split lookup failure produces a terminal FAILED attempt.

- RV10/RV20: `ln(close/previousClose)`, sample standard deviation with `N-1`,
  annualized by `sqrt(252)*100`. Boundaries are 12, 20 and 30.
- TR: `max(high-low, abs(high-previousClose), abs(low-previousClose))`.
- ATR14: mean of the first 14 TRs (15 bars), then `(priorATR*13+TR)/14`.
  ATR14Pct is `ATR14/close*100`, with boundaries 1.00, 1.50 and 2.50.
- States are LOW=0, NORMAL=1, HIGH=2, EXTREME=3. Lower bounds are inclusive,
  upper bounds exclusive. Classify unrounded values. Instrument raw severity is
  the median of its three measurements; market raw severity is max(SPY,RSP).
- Both instruments need 21 consecutive usable expected sessions. Missing expected
  bars restart the affected instrument's metrics. CLOSED dates are not sessions;
  EARLY_CLOSE dates are. An incomplete instrument makes the market UNAVAILABLE.
- Worsening jumps immediately to raw, including multiple levels. Recovery needs
  two supporting VALID assessments and moves exactly one level, then resets.
  Lower raw states also support the next target; equal raw/effective resets.
  Unavailable evidence pauses effective state and confirmation.

The production envelope is VOLATILITY_V1 / evidence schema 1. The calibrated
constants remain frozen; future formula or threshold changes require a new version.
There are no mutable settings or additional research profiles.

The publisher uses Trend's transaction-scoped PostgreSQL advisory-lock pattern,
with a distinct global Volatility key, and database uniqueness as final protection.
All reads, continuation selection and writes share the locked transaction. Startup
and monitored 15-minute ticks use the same publisher as manual runs. No account
coordination or broker worker is invoked. The exhaustive worker-key backoff map has
an unused global-worker entry solely to retain TypeScript exhaustiveness.

Bootstrap internally replays expected sessions across retained history and publishes
only the latest calculable common eligible session. It does not insert historical
replay rows. Processing timestamps reflect actual processing. Later due dates are
handled chronologically, at most 20 per invocation, linking actual prior VALID
VOLATILITY_V1 rows. Persisted predecessor evidence owns hysteresis continuation;
an unrelated dimension/version cannot become the predecessor. The first unresolved
target stops catch-up. Failed bootstrap targets are pinned for retry. Changed
evidence can produce another immutable attempt; identical failure fingerprints are
suppressed. A retry never modifies old evidence or skips the unresolved session.

Eligibility is session close + 30 minutes. targetAt/dataThroughAt identify the
usable session-close boundary, including early closes. validUntil freezes the next
expected session close + 30 minutes across weekends and holidays. Later reads do
not mutate status to STALE: current usability is derived as VALID with current time
before validUntil, while latestAttempt exposes unresolved later targets. Past
validUntil/calendar evidence is not rewritten after operator calendar edits.

Full detail includes the exact definition; Security IDs/symbol snapshots; ordered
MarketBar IDs, counts, ranges and canonical input hash; split events and applied
factor ranges; all instrument values/states, ATR raw value and severities; max-severity
market explanation; predecessor/recovery counts/target/reason; session close, grace,
next expected session, relevant calendar exceptions and frozen validity timestamps.

## Postman acceptance

Use the existing SYSTEM_OWNER login/session cookie. Base URL:
`http://localhost:3000`. Reads also permit OPERATOR through MARKET_DATA_READ.
Startup may publish before the manual call; never reset immutable history to
repeat bootstrap. Use an isolated migrated test database for a fresh chain.

1. Preview/apply calendar bootstrap above; confirm conflicts is empty. Repeating
   apply should insert zero and skip all 59 dates.
2. Save `GET /api/market-data/trend-assessments/latest` and its history as a baseline.
3. `POST /api/market-data/volatility-assessments/run` with `{}` or no body.
   No date, profile or threshold override is accepted. Expected on a fresh complete
   store: `published:1`, `attempts:1`, `blocked:null`.
4. `GET /api/market-data/volatility-assessments/latest` returns latestAttempt and
   latestValid. Verify VOLATILITY / VOLATILITY_V1 / schema 1, status VALID,
   latest eligible sessionDate, plausible raw/effective state and next close+grace.
5. `GET /api/market-data/volatility-assessments?limit=20` (optional `beforeId` cursor;
   limit 1–100) and `GET /api/market-data/volatility-assessments/<id>` return immutable
   attempts/full evidence. Inspect SPY/RSP, definition, provenance, transition and
   calendar fields. Bootstrap has null previousAssessmentId.
6. Immediately POST again: `published:0`, `attempts:0`, `notDue:true`, `blocked:null`
   if no new session is due. Persistent unresolved evidence instead returns the
   blocked reason with suppression and no new attempt.
7. Confirm the Trend baseline is unchanged. Inspect system worker health for
   `volatility_assessment_publication`; manual calls do not manufacture worker ticks.
8. After a later session closes and clears grace, confirm its new VALID row links
   to the prior actual VOLATILITY_V1 VALID row. No PUT/DELETE routes exist.

## Recorded local acceptance, 2026-09-17

All 68 migrations applied; local schema drift check returned no difference.
Calendar: first apply **59 inserted / 0 skipped / 0 conflicts**; rerun
**0 inserted / 59 skipped / 0 conflicts**. No operator row was overwritten.

Service-only acceptance (without starting other application workers) published
one authoritative bootstrap, ID **5**, for **2026-09-16**, raw/effective **LOW/LOW**,
null predecessor. targetAt/dataThroughAt = `2026-09-16T20:00:00.000Z`;
validUntil = `2026-09-17T20:30:00.000Z`. Actual processing began at
`2026-09-17T16:01:58.997Z` and completed at `2026-09-17T16:01:59.367Z`.
An immediate rerun returned zero attempts/publications and notDue true.

Replay reproduced the full calibration baseline and tail: SPY RV10 9.948244,
RV20 8.647161, ATR14Pct 0.867734; RSP RV10 10.925469, RV20 10.080636,
ATR14Pct 0.903270. All six measurements were LOW. Exact hashes of the two existing
Trend rows and all stored MarketBars were unchanged before/after publication;
Signal, SignalEvaluation, EntryDecision, OrderIntent, BrokerOrder and TrackedPosition
counts also remained unchanged. No server/trading workers were started for this check.
HTTP permissions/pagination/manual runs and monitored-worker behavior are tested
automatically; owner-cookie Postman review and the next real session remain operator
acceptance items.

## Validation recorded for this change

- 56 new tests: publisher continuation/attempts/calendar failure, frozen definition,
  calendar bootstrap, API permissions/pagination, monitored worker, and real PostgreSQL
  dimension vocabulary/immutability/uniqueness/predecessor/concurrency checks.
- Focused Volatility, Trend, calendar, market-data and Massive evidence regressions:
  **277 passed across 20 files**, with database tests enabled.
- Full backend suite with **all DB-gated integrity tests enabled: 1,921 passed
  across 179 files, zero skipped**. All 68 migrations replayed from zero in the
  disposable integration databases; the new suite also checks Prisma schema drift.
- An initial parallel full-suite run hit existing order-worker lifecycle-lock
  contention. Those 34 tests passed independently; the entire suite passed with
  `--no-file-parallelism`. No assertions were weakened and no thread-pool fallback
  was required; no fork-worker crash was observed in this pass.
- `npm run check`, `npm run build`, `prisma validate`, `prisma generate` and
  `git diff --check` passed. Regenerated DBML has no content changes because the
  migration changes SQL CHECK constraints, not Prisma model structure.
- Local `prisma migrate deploy` applied only the new migration; local
  `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
  --exit-code` reported no difference.

Repeat the comprehensive suite with isolated disposable database creation allowed:

```powershell
$env:RUN_DATABASE_INTEGRITY_TESTS='1'
npx.cmd vitest run --no-file-parallelism
```

No frontend files changed or frontend validation was required. No Strategy policy,
SignalEvaluation/routing/authority, EntryDecision, OrderIntent, BrokerOrder,
TrackedPosition, exit ownership, CurrentMarketState or Market Diary behavior changed.
The original Trend publisher/worker and pure Volatility formulas are unchanged.
