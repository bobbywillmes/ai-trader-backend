# PARTICIPATION_V1 Phase 1 foundation

Implemented on `feat/market-regime-expansion`. No Participation publisher, assessment
creation service, worker, endpoint, UI, policy or trading consumer exists. Zero
trading authority is retained. The production design remains the Phase 2 handoff;
its statements about missing prerequisites describe the pre-Phase-1 inspection.

## Pure API

`src/services/participation-v1.definition.ts` exports:

- `PARTICIPATION_ALGORITHM_VERSION = 'PARTICIPATION_V1'`
- `PARTICIPATION_PUBLICATION_EVIDENCE_VERSION = 1`
- Fixed `PARTICIPATION_SYMBOLS`, `ParticipationSymbol`, `PARTICIPATION_STATES`,
  `ParticipationState`, baseline length 20, thresholds and diagnostic cut points.
- `classifyParticipation(value)` and `participationStates(value)`; raw/effective
  equality is stateless, with no prior-state input.

`src/services/participation-v1-calculation.ts` exports:

- `calculateParticipationV1({ targetDate, baselineDates, observations })`: callers
  supply exactly twenty ascending, unique expected full-session dates before the
  target. Per-symbol observations contain only dates and normalized volumes.
  The calculator never searches for replacement observations. It returns either
  `available:true` with five instruments and panel diagnostics, or `available:false`
  with precise symbol/date diagnostics. These are pure results, not DB statuses.
- `participationMedian` and `participationPanel`: finite nonnegative numeric inputs,
  exact median-of-20 / median-of-five, and diagnostic minimum/maximum/range/agreement.
- `validateParticipationSplits` and `normalizeParticipationVolumes`: reject duplicate
  IDs/dates and malformed ratios; reuse `normalizeSplits` with unit OHLC and return
  volumes plus normalization factors on the target-date share basis. Raw inputs
  remain unchanged. Splits on excluded early-close dates still affect earlier bars.

Research shares the production panel, vocabulary, thresholds, classifier and
agreement cut points. Its forty-session control and historical artifacts remain
research-only. The production dependency closure has no database, provider,
environment, clock-now, worker or trading dependency.

`isFullMarketSession(date, persistedExceptions)` delegates to `marketSession`,
requires the normal 09:30-16:00 session and excludes every EARLY_CLOSE exception,
including one configured with a 16:00 close. Weekends/CLOSED dates are excluded.
General DAY_1 eligibility remains unchanged and accepts eligible early-close bars.
The future caller still owns exact calendar-window planning and reviewed coverage
preflight; Phase 1 adds no publication scheduling or validity logic.

## Evidence and calendar

`MARKET_DAILY_EVIDENCE_SYMBOLS` / `DailyEvidenceSymbol` cover exactly SPY, QQQ, DIA,
IWM, RSP. `TREND_SYMBOLS` remains SPY/RSP, asserted in regression tests. Daily ingest,
backfill, sync and status use the shared acquisition identity. Retry/checkpoint and
bounded per-symbol gap work remain unchanged; status additionally exposes actual
370-calendar-day historical gaps independently of the checkpoint. Acquisition
requires existing Securities and remains Massive-only, unadjusted, insert-only.

`fetchStrictSplitEvidence` validates every page and rejects duplicate IDs or
execution dates before the map can discard them, including across pages. It retains
id/symbol/date/from/to/priceFactor and distinguishes empty success from failed or
incomplete requests. Strict transport failures are sanitized. Legacy split callers
retain their identical-ID deduplication contract. Daily validation is preserved.

The shared bootstrap now contains 59 closures plus 12 early closes, all at 780 ET
minutes: 2021-11-26; 2022-11-25; 2023-07-03, 2023-11-24; 2024-07-03, 2024-11-29,
2024-12-24; 2025-07-03, 2025-11-28, 2025-12-24; 2026-11-27, 2026-12-24.
These are the existing reviewed research dates, with the same NYSE release sources.
`verifiedCalendarRows` drives the full bootstrap; closure-only compatibility exports
preserve existing consumers. Preview is still the default. Explicit `--apply`
skips equivalent rows, locks the table and performs zero writes on any conflict.
No workers seed calendar configuration and the horizon remains 2021-2026.

All five symbols already exist in `src/db/securities.json`, used by the normal
`src/db/seed.ts` catalog upserts. No seed changes or subscriptions were added.
Actual deployed catalog presence and provider entitlement remain manual checks.
Do not rerun the broad seed merely to provision market evidence: it also provisions
other application configuration. Missing catalog entries can be created explicitly
through the existing Securities workflow.

## Database and deployment

Migration `20260920120000_participation_v1_assessment_constraints` changes only two
CHECK constraints. Every Participation status requires sessionDate. Non-null states
are accepted only for PARTICIPATION_V1, in QUIET/NORMAL/ACTIVE/INTENSE, with raw equal
to effective. The existing terminal constraint still requires null states and a
reason for non-VALID rows. Existing Trend/Volatility/Breadth/Intraday Stress arms are preserved.
All other attempt, evidence-version, time, uniqueness, predecessor and immutability
invariants remain intact. Incompatible old evidence fails closed; there is no data
repair. No Prisma schema, generated client, DBML, table or column change is needed.

The migration was applied only by disposable local PostgreSQL replay tests, not to
the application or production database. No live Massive requests were made.
Before activation: deploy the migration, preview/review/apply calendar bootstrap,
verify five catalog rows and provider access, and explicitly backfill the exact
required full-session history. Healthy sync does not certify pre-checkpoint warmup.
Five-symbol latency and worker-health observations remain manual acceptance; see
the acquisition budget notes in `docs/architecture/market-data-trend.md`.

## Validation

- Focused nine-file foundation/research regression run: 118 passed.
- `npm.cmd run check`: passed.
- `npm.cmd run build`: passed; no UI build required.
- `npm.cmd test -- --no-file-parallelism --reporter=verbose`: 196 files passed,
  2,161 tests passed; 9 opt-in integrity files / 163 tests skipped in this normal run.
- Actual `RUN_DATABASE_INTEGRITY_TESTS=1` run against localhost: Participation,
  Volatility, market-data and Breadth disposable database suites all passed:
  4 files, 102 tests. Includes full migration replay, no Prisma drift, state/session
  checks, preserved dimension states, immutable rows, unique VALID attempts,
  predecessor constraints and incompatible historical evidence rejection.
- `git diff --check`: passed.

The initial default parallel full run had one Breadth advisory-lock collision.
The first serial attempt had an unexpected Vitest fork exit. A subsequent complete
serial run passed without failures or unhandled errors; neither issue required
unrelated application changes. Logs are local under `node_modules/.cache/`.

## Changed files by concern

- Pure: `src/services/participation-v1.definition.ts`,
  `participation-v1-calculation.ts`, `participation-v1-calculation.test.ts`,
  `market-calendar.ts`; `src/dev/participation-calculation.ts`,
  `participation-classification.ts`.
- Acquisition: `src/services/market-daily-evidence.definition.ts`,
  `market-daily-evidence.test.ts`, `market-bar-ingestion.service.ts`,
  `trend-lab.config.ts`; `src/integrations/massive/evidence.client.ts`,
  `evidence.strict-splits.test.ts`; `src/workers/worker-health.definitions.ts`;
  `docs/architecture/market-data-trend.md`.
- Calendar: `src/services/market-calendar-bootstrap.definition.ts`,
  `market-calendar-bootstrap.service.ts`, `market-calendar-bootstrap.service.test.ts`;
  `src/dev/intraday-stress-calendar.ts` (shared list import only);
  `src/db/__tests__/volatility.integration.test.ts`;
  `docs/development/volatility-v1-acceptance.md`.
- Constraints/handoff: migration above; `src/db/__tests__/participation.integration.test.ts`;
  `AGENTS.md`; this document.

Stop at Phase 1. Publisher implementation and its activation acceptance remain
separate work; no code in this phase can publish a Participation assessment.

## Migration-history correction

The parallel Intraday Stress branch had already supplied the persistent local
DB with `20260919120000_intraday_stress_v1_assessment_constraints`. Its exact tracked
migration is now restored here, without implementation code. The still-pending
Participation migration preserves its session-date requirement and independent
NORMAL/ELEVATED/HIGH/SEVERE raw/effective state vocabulary, including the existing
absence of an algorithm-version restriction for Intraday Stress.

Replay tests assert Intraday Stress immediately precedes Participation and validate
both dimensions after the complete chain. This correction does not apply either
migration to the persistent database or modify its migration ledger. Before the
owner applies Participation, migrate status should recognize Intraday Stress as
applied and report only Participation as pending (assuming no other local changes).

Correction validation: restored working file and staged blob match the source
branch byte-for-byte (SHA-256
`e755ecfbd6e04ceb970396ba8068817723bca13de9f841ca9ff14061460d450f`).
Check/build passed; 32 focused foundation tests and 110 actual disposable PostgreSQL
integrity tests passed. Complete serial backend run passed 2,161 tests (171 opt-in
tests skipped); an initial unexpected Vitest fork exit required one full rerun.
Read-only `prisma migrate status` confirmed 71 migrations with only Participation
pending. No persistent migration application, reset or resolve was performed.
