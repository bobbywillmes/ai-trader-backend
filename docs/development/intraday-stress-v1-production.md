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
  `fetchDailyEvidence` but against `/v2/aggs/ticker/{symbol}/range/15/minute/{from}/{to}` (a new
  `etMinutesOfDay` helper was added to `market-calendar.ts` to support alignment checks; no
  parallel calendar logic was introduced). `adjusted=false` is required exactly like the daily
  client. **Extended-hours filtering**: Massive's aggregate endpoint returns pre-market and
  after-hours 15-minute aggregates alongside the regular session (observed in research: 47,545
  extended-hours SPY bars, 11,772 RSP) — that is normal provider evidence, not corruption, so
  bars outside the fixed 09:30-16:00 ET window are silently ignored rather than failing the whole
  response. Only bars *inside* that window are required to align exactly to the 09:30 ET
  15-minute grid; a malformed/misaligned regular-session bar still fails closed.
- `syncMinuteBars` added to `market-bar-ingestion.service.ts`: bounded, session-local — it only
  ever requests **today's** regular session (at most 26 bars/symbol), under an independent
  advisory lock (`market-minute-data-lock.service.ts`, key `ai-trader:market-minute-evidence`,
  separate from the DAY_1 sync lock) so it never contends with daily sync. A network call is
  skipped entirely whenever nothing eligible is missing. Historical intraday backfill is out of
  scope by design: replay only ever needs to reconstruct the *current* session.
- Worker `market_minute_evidence_sync` polls every 30 seconds (`market-minute-data.worker.ts`),
  comfortably inside the 5-minute MINUTE_15 grace window without high-frequency provider use.
  Continued absence of an eligible, expected regular-session bar (`missing > 0`) is surfaced as a
  worker-health **failure**, not idle work — existing worker-health failure-threshold/transition
  dedup conventions (no per-tick `SystemEvent` spam) apply unchanged.
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
- **Fail-closed reason codes**: `CALENDAR_EVIDENCE_UNAVAILABLE` (verified NYSE closures or early
  closes missing/conflicting in the DB in the recent window, **or** the due target's session
  falls outside `VERIFIED_NYSE_CLOSURES`'s verified `from`/`to` horizon — see below),
  `PRIOR_ATR_UNAVAILABLE` (no prior-session ATR14 baseline),
  `SPLIT_EVIDENCE_UNAVAILABLE` (Massive split fetch/validation failure while computing a fresh
  baseline), `MISSING_INTRADAY_EVIDENCE` (missing/invalid/duplicate bar, missing reference, or
  incomplete session prefix), `ROLLING_CONTINUITY_FAILURE` (rolling window broken after
  warm-up), `CALCULATION_FAILED` (predecessor evidence decode failure or an unexpected
  calculation error).
- **Attempts**: a target can be retried (its evidence grace has elapsed but the process keeps
  polling every 2 minutes until the *next* target's own grace elapses); identical repeated
  failures at the same stuck target are suppressed (`suppressed: true`) without any extra
  network/DB work, mirroring VOLATILITY_V1's fingerprint suppression.
- **Validity / never-expired publication — two distinct currentness checks**: `validUntil` = next
  expected target's due time + 5-minute grace, *except* the final actionable target of a session,
  whose `validUntil` is capped at session close — it never remains "current" into the next
  session's pre-open hours.
  1. **Selection-time check** (`latestActionableTarget`): a target must be **both**
     evidence-grace-elapsed **and** `now < validUntil` before it is even considered publishable.
     An expired target (evidence grace elapsed but its own currentness window has already
     closed — e.g. a prior session's final target once session close has passed, whether or not
     it was ever published) is never selected; the service returns `notDue` instead.
  2. **Final write-boundary revalidation** (immediately before the authoritative insert, after
     `completedAt = clock()`): selection happens near the start of the invocation, but baseline
     computation, split/bar fetching, and in-memory replay all take real time. If that work is
     slow enough that the *selected* target's `validUntil` closes before the row would actually be
     written (e.g. publication starts at 15:59:55 for a target whose `validUntil` is 16:00:00 and
     finishes at 16:00:03), the completed computation is discarded entirely — **no row is
     inserted at all**, VALID or otherwise, and the service returns `notDue`. This is independent
     of and does not weaken check 1.
  Together these guarantee no newly inserted VALID row can ever have `completedAt >= validUntil`
  (test-verified, including deliberately-differing `now`/`clock()` race scenarios).
- Locking (`pg_try_advisory_xact_lock`, key `ai-trader:intraday-stress-v1-publication`),
  `SystemEvent` emission (`intraday_stress_assessment_blocked/bootstrap/session_start/recovered/
  transition`), and the P2002 idempotency fallback all mirror VOLATILITY_V1 exactly.

`evidenceJson` includes: the frozen definition; per-instrument OHLC, reference price, all
shock/rolling/drawdown/acute values and ratios, component states, absolute-HIGH triggers,
acute/session collapse triggered+reason, instrument raw state; market raw state; session/replay/
baseline provenance; full hysteresis transition (`previousEffectiveState`, `confirmationAfter`,
`transitioned`, `reason`, `predecessorAssessmentId`); calendar/grace/`validUntil`/
`nextExpectedTargetAt`; `missingClosures`/`missingEarlyCloses`; `attemptFingerprint`;
`reasonCode`. Never full Massive raw responses.

**Compact replay trail**: when a gap is replayed in-memory (see above), `evidenceJson.replay.trail`
records one compact entry per replayed target (`index`, `targetAt`, `rawState`, `effectiveState`,
`confirmationAfter`, `transitioned`, `reason`) — bounded to at most one session's worth (≤25) —
so a reconstructed effective state after downtime is auditable without duplicating full OHLC
evidence for every skipped target; immutable `MarketBar` remains the raw source of truth.

## Verified calendar authority (CLOSED and EARLY_CLOSE)

`src/services/market-calendar-bootstrap.definition.ts` (`VERIFIED_NYSE_CLOSURES`) now carries
both verified full-day closures (`closedDates`) and verified 1:00 PM early closes
(`earlyCloseDates`, `closeTimeMinutesEt = 780`) for 2021-2026, sourced from the same NYSE Holiday
and Early Closings Calendar press releases already cited for the closures. This was previously
duplicated only in the research-only `src/dev/intraday-stress-calendar.ts`, which now imports and
reuses the production list instead of maintaining a silently divergent copy.
`market-calendar-bootstrap.service.ts`'s `verifiedClosureRows`/`bootstrapMarketCalendar` treat
both kinds generically: preview/apply, idempotent skip of already-equivalent rows, and **zero
writes** if any existing row conflicts on type or close time (an operator's mutable configuration
is never silently overwritten) — unchanged behavior, now covering 71 verified rows (59 closures +
12 early closes) instead of 59. Bootstrap remains explicit/operator-invoked; no migration was
needed (this is application data, not schema).

INTRADAY_STRESS_V1's own calendar-coverage check (`CALENDAR_EVIDENCE_UNAVAILABLE`) was extended
to require verified **early-close** coverage in the recent window, not just full-day closures: a
missing or conflicting `EARLY_CLOSE`/780 row for a verified date fails closed exactly like a
missing verified closure, because an unconfigured/misconfigured early close would otherwise make
`marketSession`/`barEligibility` treat that date as a full 16:00 session — corrupting this
session-boundary-sensitive dimension's actionable-target count and validity window.

### Verified calendar authority horizon

`VERIFIED_NYSE_CLOSURES` declares an explicit `from`/`to` range (currently `2021-01-01` to
`2026-12-31`) — the span it actually verifies, not an unbounded assumption. A due target whose
`sessionDate` falls **outside** that range fails closed with `CALENDAR_EVIDENCE_UNAVAILABLE`
(`status` cannot become `VALID`) rather than silently treating an unverified future (or
pre-2021) date as an ordinary session — this is exactly the "silent ordinary-weekday drift" risk
an unbounded assumption would otherwise create. `evidenceJson.calendarAuthority` records
`{from, to, withinAuthority}` for every attempt, including this one, for audit.

This was implemented as an additional condition alongside the existing missing-closure/
missing-early-close checks (same reasonCode, same fail-closed attempt-row shape) rather than by
making `latestActionableTarget` skip out-of-horizon dates outright: the latter would have made
the horizon boundary silently invisible (a permanent, unexplained `notDue`), whereas an explicit
`FAILED` attempt with `reasonCode=CALENDAR_EVIDENCE_UNAVAILABLE` and
`calendarAuthority.withinAuthority=false` is directly observable via the API and worker health,
and reuses the same immutable-attempt/fingerprint-suppression machinery as every other
calendar-evidence failure.

The static verified list is **not** extended automatically — no inferred federal holidays, no
dynamic runtime calendar fetch. It is extended only through the existing explicit
bootstrap/review process, by adding officially published NYSE dates to
`VERIFIED_NYSE_CLOSURES` and re-running `npm run calendar:bootstrap -- --apply`. **Operational
note**: extending `from`/`to` through the officially published 2027/2028 NYSE holiday and
early-closing calendar before this dimension's horizon is reached is a low-risk, mechanical
follow-up recommended for a future change — it was intentionally *not* done as part of this
correction, which is scoped to the fail-closed horizon invariant itself.

## Worker

`intraday_stress_assessment_publication` runs on startup and every 2 minutes — bounded enough to
publish promptly within the 5-minute evidence grace without high-frequency polling, and
deliberately not copied from the daily dimensions' 15-minute cadence. No trading side effects.

## Startup / replay behavior

Replay establishes **calculation state only** — it never creates retroactive authoritative
history, and an already-expired target is never newly published, regardless of whether it was
ever published at all:

- **Before 09:45** (no target due yet, e.g. process starts early or overnight): no target of
  today's session has had its evidence grace elapse yet, and every target from a prior session is
  already expired (its `validUntil` closed with that session). Result: `notDue`. It does **not**
  fall back to publishing yesterday's leftover final target.
- **During an active session**: resumes from the current due target (the latest one that is both
  grace-elapsed and not yet expired); any gap since the last published target is replayed
  in-memory only (see above) to reconstruct calculation state, never retroactively persisted.
- **After regular-session close** (including the moment of close itself, `now >= 16:00 ET`): the
  final actionable target's `validUntil` equals session close, so once `now` reaches it the target
  is expired and no longer publishable — even if it was never successfully published during the
  session. Result: `notDue` until the next session's first target becomes due; **no new expired
  VALID row is ever created**.
- **Next trading day before its own first target is due** (e.g. before ~09:50 ET): the prior
  session's targets are all expired; today's first target's grace has not elapsed yet either.
  Result: `notDue`.
- **CLOSED session**: `latestActionableTarget` skips it entirely (no session, no targets); it
  cannot yield a currently-valid target, since crossing a session boundary always expires the
  prior session's remaining targets.
- **EARLY_CLOSE session**: actionable target count and the final target's `validUntil` (the
  actual early close time, e.g. 13:00 ET) both respect the shortened session automatically via the
  shared calendar and the verified early-close bootstrap (see below).

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

## Provider freshness acceptance requirement

The frozen 5-minute MINUTE_15 evidence grace is **not** altered or relaxed by this
implementation, and the algorithm is not adjusted to accommodate delayed market data. This
implies an explicit, unrelaxable production acceptance prerequisite:

> **Massive SPY/RSP MINUTE_15 evidence must become available within `targetAt + 5 minutes`.**

If the configured Massive subscription is entitled only to delayed data (e.g. a 15-minute-delayed
plan), this prerequisite is **not** satisfied, and INTRADAY_STRESS_V1 must **not** be considered
operationally accepted for any future safety/eligibility use — even though it has no trading
authority today, its assessments would otherwise silently describe stale conditions as "right
now." This is a subscription/observation fact to be verified against the live account, not
something to infer from historical entitlement in code.

**How to observe actual end-to-end latency during a live regular session:**

1. Note a target's `targetAt` (from `GET /api/market-data/intraday-stress-assessments/latest`, or
   compute it as the next `openAt + n*15min`).
2. Poll Massive directly (or watch `market_minute_evidence_sync`'s effect) for the first response
   that actually contains the bar covering `[targetAt - 15min, targetAt)` — record that wall-clock
   time as first-provider-availability.
3. Compare against the resulting `MarketBar.receivedAt` (when the backend actually stored it) —
   this is the ingestion-side latency.
4. Compare the published assessment's `completedAt` against `targetAt` — this is total
   grace-consumed latency; it must stay under 5 minutes for the target to have been "on time"
   (`status=VALID` rather than a grace-driven gap or an evidence-failure `blocked` result).
5. Compare `completedAt` against `validUntil` — confirms the row was inserted well inside its own
   currentness window (this is also test-verified for every VALID row, see below).

If step 2 consistently lands 15+ minutes after `targetAt`, the subscription is delayed and this
dimension is not meeting its own freshness contract regardless of what gets published.

## Manual acceptance plan

1. `npx prisma migrate deploy && npx prisma generate`.
2. Confirm SPY/RSP `Security` rows and recent DAY_1 history already exist (reused from
   Trend/Volatility acceptance).
3. `npm run calendar:bootstrap` (preview), confirm `conflicts.length === 0` and `wouldInsert`
   includes the 12 verified early closes, then `npm run calendar:bootstrap -- --apply`. This is
   application data, not schema — no migration is involved.
4. Verify the provider-freshness prerequisite above against the live Massive subscription before
   proceeding — do not accept this dimension on a delayed-data plan.
5. Start the backend; confirm `market_minute_evidence_sync` begins filling today's MINUTE_15
   bars (`GET /api/market-data/status` or `SystemEvent`/worker-health inspection).
6. Wait for at least one 15-minute target's evidence grace to elapse, or
   `POST /api/market-data/intraday-stress-assessments/run` once bars exist.
7. `GET /api/market-data/intraday-stress-assessments/latest` — verify `dimension=INTRADAY_STRESS`,
   `algorithmVersion=INTRADAY_STRESS_V1`, `evidenceSchemaVersion=1`, `status=VALID`,
   `rawState`/`effectiveState` in `{NORMAL,ELEVATED,HIGH,SEVERE}`, full per-instrument evidence,
   `session.bootstrap=true`, `baseline.frozenForSession=true`, `completedAt < validUntil`.
8. Immediately re-run — expect a clean `notDue` result, no duplicate row.
9. Fifteen minutes later (next target), re-run — confirm a new row with
   `previousAssessmentId` pointing to the first, `session.sameSession=true`,
   `baseline.provenance.reused=true`.
10. `GET /api/market-data/trend-assessments/latest`, `/volatility-assessments/latest`, and
    `/breadth-assessments/latest` — confirm all three unchanged.
11. Inspect System Events / worker health for `intraday_stress_assessment_publication` and
    `market_minute_evidence_sync`.
12. After regular-session close, confirm a run returns `notDue` and does **not** publish a new
    row for the (now expired) final target.

## Validation recorded for this change

- Focused tests: `intraday-stress-calculation.test.ts` (28), `intraday-stress-v1.definition.test.ts` (1),
  `intraday-stress-assessment.service.test.ts` (30, including the never-expired-publication,
  same-session-gap-replay, early-close-calendar-coverage, final-write-boundary-revalidation, and
  calendar-authority-horizon corrections), `intraday-stress-assessment.worker.test.ts` (4),
  `market-minute-data.worker.test.ts` (5, including the missing-eligible-bar-is-a-failure
  correction), `evidence.client.test.ts` (17, including the extended-hours-filtering correction),
  and `market-calendar-bootstrap.service.test.ts` (3, covering the verified early-close
  additions) — 88 tests total across these 7 files.
- `src/db/__tests__/intraday-stress.integration.test.ts` (16 tests) against a real ephemeral
  Postgres database: migration replay with **no Prisma schema drift**, state-vocabulary
  acceptance/rejection, sessionDate requirement, immutability/uniqueness/predecessor-FK
  enforcement, real concurrent-publisher lock contention (`409`), and confirmation that a
  multi-target gap advances without retroactively persisting the skipped targets — all while
  leaving Trend/trading tables byte-identical. (Its two `now`-in-the-past scenarios now
  explicitly pin `clock()` to the simulated `now`, exactly like the unit tests — otherwise the
  final write-boundary revalidation would correctly, but unhelpfully for the test, discard the
  computation against the real wall clock.) The full `RUN_DATABASE_INTEGRITY_TESTS=1` suite
  (10 files, 155 tests, including Trend/Volatility/Breadth) also passes unchanged, confirming the
  verified-calendar and INTRADAY_STRESS corrections introduced no schema drift and no migration
  was needed for the calendar bootstrap changes (application data, not schema).
- `npm run check` (TypeScript), `npm run build`, `npx prisma validate`, `npx prisma generate`:
  all clean.
- Full backend suite (`npm test`): 195 test files passed, 2137 tests passed, 150 skipped
  (pre-existing DB-integrity suites gated behind `RUN_DATABASE_INTEGRITY_TESTS=1`, which were
  also run separately and pass), 0 failed.

## Confirmed

No trading effect: no `StrategyMarketRegimePolicy`, no overall Market Regime composition, no
`SignalEvaluation`/`EntryDecision`/`OrderIntent` change. TREND_V1, VOLATILITY_V1, and BREADTH_V1
are untouched. No Alpaca market-data fallback anywhere in ingestion. No historical authoritative
INTRADAY_STRESS row is ever backfilled — only the current due target is ever published, and only
when it is not already expired at selection time **or** at the final write boundary. No VALID
INTRADAY_STRESS_V1 assessment is ever published for a session outside `VERIFIED_NYSE_CLOSURES`'s
verified calendar-authority horizon.
