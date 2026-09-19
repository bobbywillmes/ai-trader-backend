# INTRADAY_STRESS_V1 production and local acceptance

The frozen production definition adopts the accepted research algorithm (Candidate B plus the
current-close acute-collapse and fixed absolute-HIGH safeguard clarification), but reimplements
it independently in `src/services/intraday-stress-calculation.ts` under its own frozen names
(`INTRADAY_STRESS_*`). Production code never imports the research modules under
`src/dev/intraday-stress-*`, and never references research-only vocabulary (`Candidate B`,
`classifyCurrentCollapse`, `absoluteHigh` flag). This phase ends at authoritative immutable
INTRADAY_STRESS assessments: there is **no trading effect** — no `StrategyMarketRegimePolicy`,
no overall Market Regime composition, no `SignalEvaluation`, `EntryDecision`, or `OrderIntent`
change. The research report remains historical calibration evidence, not production history:

- [Intraday Stress Calibration](intraday-stress-calibration.md)

## Purpose and scope

INTRADAY_STRESS answers exactly one question: "is the broad U.S. equity market experiencing
acute regular-session instability right now?", where "right now" means as of the most recently
completed, authoritative 15-minute SPY/RSP bar — never a live tick during the 5-minute evidence
grace. It is not Trend, not background daily Volatility, not Breadth, not a prediction, and
carries no overnight/premarket evidence in V1.

## Architecture inspected and reused

- **MarketBar / calendar**: `MarketBarTimeframe.MINUTE_15` and `COMPLETION_GRACE_MINUTES.MINUTE_15
  = 5` already existed in `src/services/market-calendar.ts`, pre-provisioned for this dimension;
  `barEligibility('MINUTE_15', ...)` is reused unchanged. `MarketRegimeDimension.INTRADAY_STRESS`
  already existed in the enum, also pre-provisioned.
- **ATR baseline**: reuses `trueRange`, `wilderAtr`, and `instrumentMeasurements` from
  `src/services/volatility-calculation.ts` verbatim (same Wilder semantics as VOLATILITY_V1) —
  INTRADAY_STRESS never reads a VOLATILITY_V1 assessment row as input, only the same underlying
  DAY_1 `MarketBar` evidence.
- **Split normalization**: reuses `normalizeSplits` from `src/services/trend-calculation.ts` for
  the daily ATR history exactly like VOLATILITY_V1. Intraday MINUTE_15 bars within the session
  being evaluated are never split-normalized, because a split's `executionDate` can only affect
  bars strictly before it and no split can be dated inside the still-forming current session —
  the factor is structurally always 1.0 for same-session bars (documented in
  `intraday-stress-assessment.service.ts`).
- **Assessment shape**: reuses the same `MarketRegimeDimensionAssessment` table, advisory-lock
  pattern (`pg_try_advisory_xact_lock`, SHA-256 namespaced key), immutable-attempt semantics,
  fail-closed `reasonCode` vocabulary, and `SystemEvent`/worker-health conventions as
  TREND_V1/VOLATILITY_V1/BREADTH_V1. Unlike BREADTH_V1, no separate "observation" table is
  needed: MINUTE_15 `MarketBar` rows are already the right granularity of immutable, replayable
  raw evidence, so the assessment service reads them directly (closer to the VOLATILITY_V1
  shape).

## Production MINUTE_15 ingestion (new)

Production did **not** previously ingest MINUTE_15 SPY/RSP evidence continuously; only DAY_1 was
synced (`market-bar-ingestion.service.ts` → `syncDailyBars`). The minimum required extension:

- `fetchMinuteEvidence` added to `src/integrations/massive/evidence.client.ts`, mirroring
  `fetchDailyEvidence` but against `/v2/aggs/ticker/{symbol}/range/15/minute/{from}/{to}`, with
  every bar validated to align to the fixed 09:30-16:00 ET regular-session 15-minute grid (a new
  `etMinutesOfDay` helper was added to `market-calendar.ts` to support this check; no parallel
  calendar logic was introduced). `adjusted=false` is required exactly like the daily client.
- `syncMinuteBars` added to `market-bar-ingestion.service.ts`: bounded, session-local — it only
  ever requests **today's** regular session (at most 26 bars/symbol), under an independent
  advisory lock (`market-minute-data-lock.service.ts`, key `ai-trader:market-minute-evidence`,
  separate from the DAY_1 sync lock) so it never contends with daily sync. A network call is
  skipped entirely whenever nothing eligible is missing. Historical intraday backfill is out of
  scope by design: replay only ever needs to reconstruct the *current* session.
- Worker `market_minute_evidence_sync` polls every 30 seconds (`market-minute-data.worker.ts`),
  comfortably inside the 5-minute MINUTE_15 grace window without high-frequency provider use.
- Massive only. No Alpaca fallback exists anywhere in the bar-ingestion pipeline (confirmed by
  the existing `uses no Alpaca provider dependency` test, extended to cover the new files).
- Existing DAY_1 SPY/RSP evidence is reused unchanged for the ATR14 baseline; no parallel
  authority was created.

## Frozen calculation (`src/services/intraday-stress-calculation.ts`)

Pure, no database/HTTP/clock dependency. `measureIntradaySession(date, bars, priorAtr14Pct,
exceptions)` recomputes the full session's evidence fresh from raw `MarketBar`-shaped input for
every call (never chained incrementally), mirroring how VOLATILITY_V1 recomputes ATR from full
daily history rather than an incremental running state. The bar ending exactly at session close
is structurally excluded — only `count - 1` actionable targets are ever produced (25 for a full
day, 13 for a 09:30-13:00 early close).

Per target: `shockPct`/`shockAtrRatio` (reference = session open for the first target, else the
previous contiguous 15m close), `downsideExcursionPct` (intrabar, immutable, explanatory only),
`realizedMovement60Pct`/`AtrRatio` (exact four-return RMS, `NOT_APPLICABLE_SESSION_WARMUP` for
the first three targets — warm-up never invalidates an otherwise-valid target),
`sessionDrawdownPct`/`AtrRatio` (peak-to-current from session open), and
`acuteCloseDownsidePct`/`AtrRatio` (current-close downside from the interval's own reference
price). Frozen thresholds:

| Measure | NORMAL | ELEVATED | HIGH |
| --- | --- | --- | --- |
| Shock (ATR ratio) | `< 0.40` | `>= 0.40 and < 0.70` | `>= 0.70` |
| Rolling 60m (ATR ratio) | `< 0.45` | `>= 0.45 and < 0.80` | `>= 0.80` |
| Session drawdown (ATR ratio) | `< 1.00` | `>= 1.00 and < 1.75` | `>= 1.75` |

`instrumentGeneralState = worst(shock, rolling-when-applicable, drawdown)`, upgraded to at least
HIGH if `acuteCloseDownsidePct >= 1%` or `sessionDrawdownPct >= 2.5%` (safeguards; they cannot
create SEVERE by themselves). SEVERE is structurally distinct and current-downside-only — a
recovered intrabar low never creates it:

```
acuteCollapse   = (acuteCloseDownsideAtrRatio >= 1.20 AND acuteCloseDownsidePct >= 2%) OR acuteCloseDownsidePct >= 3%
sessionCollapse = (sessionDrawdownAtrRatio    >= 2.50 AND sessionDrawdownPct    >= 2.5%) OR sessionDrawdownPct >= 4%
instrumentRawState = SEVERE if (acuteCollapse OR sessionCollapse) else instrumentGeneralState
marketRawState = worse(SPY, RSP)   -- either instrument SEVERE is sufficient; no averaging/voting
```

`advanceIntradayStress` implements the two-confirmation hysteresis: worsening is immediate (may
jump directly to any worse state); recovery requires two consecutive supporting VALID
assessments below the current effective state, then improves exactly one level and resets;
equal-to-effective holds and resets; **missing/unavailable evidence pauses (holds) the effective
state and resets the pending recovery confirmation to zero** — a gap never carries partial
recovery progress forward, matching the frozen research `recover()` semantics exactly (verified
against its own recorded test vectors). There is no cross-session hysteresis: callers must
bootstrap fresh (`{effectiveState: null, confirmation: 0}`) for the first target of a new
session.

## Publisher (`src/services/intraday-stress-assessment.service.ts`)

`dimension=INTRADAY_STRESS`, `algorithmVersion=INTRADAY_STRESS_V1`, `evidenceSchemaVersion=1`,
`sessionDate` required (extended into `RegimeDimension_terminal_check`). Unlike the daily
dimensions' one-target-per-session cadence, INTRADAY_STRESS has ~25 targets per session, so its
catch-up shape is deliberately different from VOLATILITY_V1's block-and-retry-the-same-date
loop:

- **At most one row is persisted per invocation**: the current due 15-minute target
  (`latestActionableTarget`, walking backward through recent sessions for the most recent target
  whose 5-minute grace has elapsed).
- If the predecessor (last VALID assessment) is more than one target behind, the intervening
  targets are **replayed in-memory only** — recomputed from raw `MarketBar` evidence purely to
  correctly step the hysteresis chain (worsen/hold/recover/reset) — and never persisted.
  INTRADAY_STRESS never writes retroactive authoritative rows for stale targets merely because
  the process started late or missed a window; `evidenceJson.replay` records
  `fromIndex`/`throughIndex`/`replayedCount` for audit.
- **The prior-session ATR14 baseline is frozen per session**: computed fresh only when the
  predecessor is from a different (or no) session, then reused verbatim (read from the
  predecessor's own evidence, not recomputed) for every later target in that same session —
  this also means no repeated Massive split-evidence network calls within a session.
  `evidenceJson.baseline.provenance.reused` records which happened.
- **No cross-session hysteresis**: when the due target's session differs from the predecessor's,
  history bootstraps fresh from `{null, 0}` and replay starts at index 1 of the new session,
  exactly matching "the first valid assessment of a new session establishes that session's
  effective state from its raw state."
- **Fail-closed reason codes**: `CALENDAR_EVIDENCE_UNAVAILABLE` (verified NYSE closures missing
  from the DB in the recent window), `PRIOR_ATR_UNAVAILABLE` (no prior-session ATR14 baseline),
  `SPLIT_EVIDENCE_UNAVAILABLE` (Massive split fetch/validation failure while computing a fresh
  baseline), `MISSING_INTRADAY_EVIDENCE` (missing/invalid/duplicate bar, missing reference, or
  incomplete session prefix), `ROLLING_CONTINUITY_FAILURE` (rolling window broken after
  warm-up), `CALCULATION_FAILED` (predecessor evidence decode failure or an unexpected
  calculation error).
- **Attempts**: a target can be retried (its evidence grace has elapsed but the process keeps
  polling every 2 minutes until the *next* target's own grace elapses); identical repeated
  failures at the same stuck target are suppressed (`suppressed: true`) without any extra
  network/DB work, mirroring VOLATILITY_V1's fingerprint suppression.
- **Validity**: `validUntil` = next expected target's due time + 5-minute grace, *except* the
  final actionable target of a session, whose `validUntil` is capped at session close — it never
  remains "current" into the next session's pre-open hours.
- Locking (`pg_try_advisory_xact_lock`, key `ai-trader:intraday-stress-v1-publication`),
  `SystemEvent` emission (`intraday_stress_assessment_blocked/bootstrap/session_start/recovered/
  transition`), and the P2002 idempotency fallback all mirror VOLATILITY_V1 exactly.

`evidenceJson` includes: the frozen definition; per-instrument OHLC, reference price, all
shock/rolling/drawdown/acute values and ratios, component states, absolute-HIGH triggers,
acute/session collapse triggered+reason, instrument raw state; market raw state; session/replay/
baseline provenance; full hysteresis transition (`previousEffectiveState`, `confirmationAfter`,
`transitioned`, `reason`, `predecessorAssessmentId`); calendar/grace/`validUntil`/
`nextExpectedTargetAt`; `attemptFingerprint`; `reasonCode`. Never full Massive raw responses.

## Worker

`intraday_stress_assessment_publication` runs on startup and every 2 minutes — bounded enough to
publish promptly within the 5-minute evidence grace without high-frequency polling, and
deliberately not copied from the daily dimensions' 15-minute cadence. No trading side effects.

## Startup / replay behavior

- **Before 09:45** (no target due yet): `latestActionableTarget` finds nothing yet due today;
  falls back to the most recent target of a prior session (or `notDue` if already current).
- **During an active session**: resumes from the current due target; any gap since the last
  published target is replayed in-memory only (see above), never retroactively persisted.
- **After regular-session close**: the final actionable target (or an earlier one if evidence
  was never available) remains the latest publishable target until the next session's first
  target becomes due.
- **CLOSED session**: `latestActionableTarget` skips it entirely (no session, no targets).
- **EARLY_CLOSE session**: actionable target count and the final target's `validUntil` both
  respect the shortened session automatically via the shared calendar.

## Schema / migration

`prisma/migrations/20260919120000_intraday_stress_v1_assessment_constraints/` extends the two
existing `MarketRegimeDimensionAssessment` CHECK constraints only:
`RegimeDimension_terminal_check` (adds `INTRADAY_STRESS` to the sessionDate-required dimension
list) and `RegimeDimension_states_check` (adds `INTRADAY_STRESS` with vocabulary `NORMAL`,
`ELEVATED`, `HIGH`, `SEVERE`). No new tables. `MarketRegimeDimension.INTRADAY_STRESS` and
`MarketBarTimeframe.MINUTE_15` already existed in the schema; TREND/VOLATILITY/BREADTH rows,
triggers, attempt identity, partial-VALID uniqueness, and predecessor FK are untouched.

## API

```
GET  /api/market-data/intraday-stress-assessments/latest
GET  /api/market-data/intraday-stress-assessments
GET  /api/market-data/intraday-stress-assessments/:id
POST /api/market-data/intraday-stress-assessments/run   (SYSTEM_OWNER; respects eligibility, not force)
```

Auth/pagination/error style matches the existing Trend/Volatility/Breadth routes exactly
(`PlatformPermission.MARKET_DATA_READ` for reads, `requireSystemOwnerAccess` for `run`).

## Manual acceptance plan

1. `npx prisma migrate deploy && npx prisma generate`.
2. Confirm SPY/RSP `Security` rows and recent DAY_1 history already exist (reused from
   Trend/Volatility acceptance).
3. Start the backend; confirm `market_minute_evidence_sync` begins filling today's MINUTE_15
   bars (`GET /api/market-data/status` or `SystemEvent`/worker-health inspection).
4. Wait for at least one 15-minute target's evidence grace to elapse, or
   `POST /api/market-data/intraday-stress-assessments/run` once bars exist.
5. `GET /api/market-data/intraday-stress-assessments/latest` — verify `dimension=INTRADAY_STRESS`,
   `algorithmVersion=INTRADAY_STRESS_V1`, `evidenceSchemaVersion=1`, `status=VALID`,
   `rawState`/`effectiveState` in `{NORMAL,ELEVATED,HIGH,SEVERE}`, full per-instrument evidence,
   `session.bootstrap=true`, `baseline.frozenForSession=true`.
6. Immediately re-run — expect a clean `notDue` result, no duplicate row.
7. Fifteen minutes later (next target), re-run — confirm a new row with
   `previousAssessmentId` pointing to the first, `session.sameSession=true`,
   `baseline.provenance.reused=true`.
8. `GET /api/market-data/trend-assessments/latest`, `/volatility-assessments/latest`, and
   `/breadth-assessments/latest` — confirm all three unchanged.
9. Inspect System Events / worker health for `intraday_stress_assessment_publication` and
   `market_minute_evidence_sync`.

## Validation recorded for this change

- Focused tests: `intraday-stress-calculation.test.ts` (28), `intraday-stress-v1.definition.test.ts` (1),
  `intraday-stress-assessment.service.test.ts` (16), `intraday-stress-assessment.worker.test.ts` (4),
  `market-minute-data.worker.test.ts` (3), plus `evidence.client.test.ts` MINUTE_15 additions (3).
- `src/db/__tests__/intraday-stress.integration.test.ts` (16 tests) against a real ephemeral
  Postgres database: migration replay with **no Prisma schema drift**, state-vocabulary
  acceptance/rejection, sessionDate requirement, immutability/uniqueness/predecessor-FK
  enforcement, real concurrent-publisher lock contention (`409`), and confirmation that a
  multi-target gap advances without retroactively persisting the skipped targets — all while
  leaving Trend/trading tables byte-identical.
- `npm run check` (TypeScript), `npm run build`, `npx prisma validate`, `npx prisma generate`:
  all clean.
- Full backend suite (`npm test`): 195 test files passed, 2120 tests passed, 150 skipped
  (pre-existing DB-integrity suites gated behind `RUN_DATABASE_INTEGRITY_TESTS=1`, which were
  also run separately and pass), 0 failed.

## Confirmed

No trading effect: no `StrategyMarketRegimePolicy`, no overall Market Regime composition, no
`SignalEvaluation`/`EntryDecision`/`OrderIntent` change. TREND_V1, VOLATILITY_V1, and BREADTH_V1
are untouched. No Alpaca market-data fallback anywhere in ingestion. No historical authoritative
INTRADAY_STRESS row is ever backfilled — only the current due target is ever published.
