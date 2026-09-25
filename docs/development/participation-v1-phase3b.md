# PARTICIPATION_V1 Phase 3B: monitored automatic publication

Implemented locally on `feat/market-regime-expansion`. **Zero trading authority.** No UI,
StrategyMarketRegimePolicy, regime composition, SignalEvaluation, EntryDecision,
OrderIntent, OperationalAttention or account scope was added. The worker is global and
account-independent, makes no broker/Alpaca call and performs no trading write.
Phase 1 timing is unchanged: `targetAt` = full-session 16:00 ET, `dueAt` = 16:30 ET.

## Calendar bootstrap semantics

`planCalendarBootstrap` now treats a row as semantically equal when `sessionDate`, `type`
and `closeTimeMinutesEt` match, because those are exactly what runtime Participation
calendar authority reads. A differing descriptive `name` is **not** a conflict and is
never overwritten by `--apply`. Wrong type or wrong close time remains a hard conflict and
still means zero writes. Missing rows are `wouldInsert`. The 71 reviewed rows (59 closures
+ 12 early closes) are recognized even if legacy names differ.

## Worker

`src/workers/participation-assessment.worker.ts` exports
`runParticipationAssessmentWorker({ signal? })`, calling `publishParticipationAssessments`.

| Service result | Worker outcome |
|---|---|
| `blocked` (even if `suppressed`, even after partial catch-up) | **throws** `PARTICIPATION_V1 <sessionDate>: <reasonCode>` |
| `notDue` | `skipped / not_due` |
| HTTP 409 lock contention | `skipped / already_running` |
| `published > 0` | `success`, `workSucceeded: true` |
| otherwise | `idle`, `workSucceeded: false` |
| shutdown abort / other errors | propagated (never skip/idle/success) |

A persistent evidence gap therefore stays unhealthy: repeated identical suppressed attempts
still fail each tick and increment `consecutiveFailures`; the next successful tick resets
health through the existing registry. Publisher SystemEvents (blocked/bootstrap/recovered/
transition) remain publisher-owned; WorkerHealth transition events remain WorkerHealth-owned.
The worker never inspects assessment states.

## WorkerHealth definition

`participation_assessment_publication`, "Daily Participation assessment", informational,
enabled by default, `PARTICIPATION_ASSESSMENT_WORKER_INTERVAL_MS = 900_000` (15 minutes),
`maxRunDurationMs = 240_000` (the publisher transaction ceiling), standard thresholds
(startup grace 45 min, delayed after 37.5 min, stale after 75 min).

## Scheduling and startup ordering

`src/workers/participation-assessment.scheduler.ts`:

- `createParticipationScheduler({ run, intervalMs?, startupGate?, startupGateTimeoutMs? })`
  returns `{ start(), stop(drainTimeoutMs?), running, inFlight }`.
- `createMonitoredParticipationScheduler(registry, extra?)` composes it with
  `registry.runMonitoredWorker('participation_assessment_publication', ...)`.
- `start()` schedules a tracked startup tick and a retained 15-minute interval; a repeated
  `start()` is a no-op. At most one local tick is in flight (local overlap is skipped; the
  DB advisory lock remains authoritative across processes).
- `stop()` prevents new ticks, clears the interval, aborts the in-flight tick, awaits its
  settlement (bounded) and resolves `true` if drained. A drained scheduler can restart.

Startup ordering in `server.ts`: the daily MarketBar sync (`market_daily_evidence_sync`)
startup tick is started first, and the Participation startup tick waits for it for at most
120 seconds (and is skipped if shutdown begins first). This is only a head start:
Participation never calls the sync, consumes stored MarketBars only, and the sync failing
or being slow does not block it. Recurring ticks are independent. There is no startup
bypass: typical startup results are `not_due` (weekend, before cutoff, already published),
bounded catch-up, a worker failure for unresolved evidence, or `already_running`.

## External cancellation

`publishParticipationAssessments({ signal? })` combines the optional shutdown signal with
the internal 120-second dependency deadline using `AbortSignal.any`. The signal is checked
before the transaction, after the lock, per target, after split settlement and before each
insert. Shutdown abort **propagates and rolls back**; it never stores
`FAILED / SPLIT_EVIDENCE_UNAVAILABLE`, because process termination is infrastructure, not
market evidence, and the next process retries safely. In contrast, ordinary provider
failure or the internal deadline (with or without an unaborted external signal) still
records `FAILED / SPLIT_EVIDENCE_UNAVAILABLE` with `PUBLICATION_DEADLINE`/category codes.
All five split requests settle before the transaction completes; no detached work remains.
`massiveEvidenceGet` already honors the signal, so in-flight Massive HTTP stops promptly.

## Shutdown

On SIGINT/SIGTERM the server first calls `participationScheduler.stop()` (15-second bound;
warns if not drained), then stops WorkerHealth persistence and proceeds with the existing
pool/HTTP teardown. An aborted in-flight tick is recorded by WorkerHealth as an interrupted
(failed) tick; the state is flushed at shutdown and clears on the next successful tick.

## Post-3B manual acceptance (operator)

Assessment #16 (2026-09-18, ACTIVE, bootstrap) already exists. Today is Sunday.

1. Start the backend (`npm run dev`). No Participation row is created by startup.
2. Inspect WorkerHealth: `participation_assessment_publication` is registered; after the
   startup tick its last outcome is `skipped / not_due`, zero consecutive failures.
3. Confirm no duplicate 2026-09-18 assessment row and no new `participation_assessment_*`
   SystemEvent (`GET /api/market-data/participation-assessments/latest`).
4. Graceful shutdown: send Ctrl+C. Logs show shutdown; no Participation transaction or lock
   remains (`pg_locks` advisory rows for the dev DB are empty). Confirm assessment/event
   counts are unchanged.
5. Restart: same `not_due` result; still one 2026-09-18 row.
6. Before Monday 16:30 ET there must be no 2026-09-21 row. At/after 16:30 ET Monday the
   next tick (up to 15 minutes later) may publish it automatically if the daily MarketBar
   sync has stored all five symbols' bars. Otherwise the worker fails, an immutable blocked
   attempt and one `participation_assessment_blocked` event are created (later identical
   ticks are suppressed but still fail), and the same target recovers to VALID (with a
   `participation_assessment_recovered` event) once evidence exists.
7. Observe real provider timing operationally; do not extend the frozen 30-minute grace.

## Validation

Recorded in the commit message and final report: `npm.cmd run check`, `npm.cmd run build`,
focused worker/scheduler/cancellation/calendar tests, full `npm.cmd test`, and the opt-in
disposable PostgreSQL suites including the graceful-cancellation test. The persistent
`ai_trader` database and live Massive were not used for automated validation.
