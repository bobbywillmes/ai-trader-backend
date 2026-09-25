# PARTICIPATION_V1 Phase 2: authoritative publication service

Implemented locally on `feat/market-regime-expansion`. **Zero trading authority.**
No Participation worker, HTTP routes/controllers, scheduling, WorkerHealth entry,
shutdown wiring, UI, OperationalAttention or trading consumer is added. The Phase 1
classifier and normalization helpers are unchanged. No schema change or migration.

## Service and transaction boundary

`src/services/participation-assessment.service.ts` exports:

- `publishParticipationAssessments({ db?, now?, clock?, fetchSplits? })` returning
  `{ published, attempts, suppressed, notDue, blocked }`.
- `latestParticipationV1Assessment(db?)`, returning independent `latestAttempt`
  and `latestValid` rows.
- `listParticipationV1Assessments(limit, beforeId?, db?)` and
  `getParticipationV1Assessment(id, db?)`; detail returns HTTP-style 404 when absent.
  These are service helpers, not HTTP endpoints.

Every query is scoped to PARTICIPATION / PARTICIPATION_V1, evidence schema 1 on
publication. The transaction obtains `pg_try_advisory_xact_lock` before any state,
calendar or market-data read. Lock identity is SHA-256 of
`ai-trader:participation-v1-publication`, first eight bytes as signed big-endian
64-bit integer: **-4058854190904592049**. Contention throws HTTP-style 409.
Interactive transaction timeout is 240,000 ms; maxWait is 5,000 ms.
All assessment/event writes and publication reads use the transaction client.
Counters are returned only after commit. P2002 recovery occurs after rollback and
suppresses only when an exact identity/target committed VALID winner exists.

## Targets, calendar and bootstrap

Invocation `now` is copied once before I/O. Targets are full regular sessions only:
16:00 ET close, due inclusively at 16:30 ET. Early closes, holidays and weekends
create no target. A fresh identity chooses the latest due full session regardless
of bar availability, inserts at most one attempt, then returns. Missing latest
evidence pins that exact target; no older calculable bootstrap fallback or warmup
assessment replay exists.

An existing earliest unresolved target after the latest VALID predecessor wins.
Otherwise select the next full session. Recovery can publish up to 20 chronological
targets in one invocation, stopping at the first non-VALID result. Once a failed fresh
bootstrap attempt exists, a later invocation is no longer a fresh bootstrap: it recovers the
pinned target first and then continues bounded chronological catch-up in that same invocation. Original
targetAt is reused on retry; retrospective CLOSED/EARLY_CLOSE identity conflicts
throw for operator review before idle/notDue handling.

`participation-publication-calendar.ts` plans exactly the prior 20 full dates.
Missing bars never cause older replacement dates. Persisted calendar exceptions
are runtime authority; reviewed 2021-2026 closures/early closes are checked for
missing/conflicting semantic values. Names and audit metadata do not affect math.
The publisher never seeds calendars or uses the research overlay. Unknown target
identity throws without fabricating a row. A known target with unusable baseline
or next-session calendar records FAILED/CALENDAR_EVIDENCE_UNAVAILABLE. Exhaustion
of supported baseline history is distinct from missing MarketBar observations.

VALID dataThroughAt equals targetAt. Persisted validUntil is the next FULL session's
close plus 30 minutes, computed independently in ET across DST. Friday -> Monday
early close -> Tuesday full therefore expires Tuesday 16:30 ET, exclusively.
Readers receive immutable cutoffs and never recalculate them. An assessment is
current only after publication and while `now < validUntil`; a delayed successful
catch-up row can already be stale. Calendar maintenance beyond 2026 remains an
operator prerequisite, not an assumption of future coverage.

## Evidence and calculation

Explicitly load SPY/QQQ/DIA/IWM/RSP Securities and stored DAY_1 / MASSIVE /
UNADJUSTED MarketBars for the 21 expected dates. Require 105 observations, exact
Security mapping and Eastern-midnight timestamps, unique slots/IDs, and finite
representable nonnegative volumes. Missing slots identify symbol, date and
TARGET/BASELINE role; missing catalog identities use SECURITY role. Corruption
fails as CALCULATION_FAILED. No daily-bar fetch, fallback, or MarketBar write exists.

Plan the bounded catch-up range, then fetch strict splits once per symbol for the
run, only when earlier dependencies permit calculation. Five requests run in
parallel with `Promise.allSettled`; all work settles before transaction completion.
A shared 120-second deadline covers every symbol/page and combines with the existing
30-second HTTP request timeout. Each page checks cancellation. Injected fetchers
must honor the supplied AbortSignal and settle. There are no automatic retries,
detached tasks or process-global negative caches. Deadline and controlled parser,
pagination and request failure categories are stored without URLs or exception prose.

Per-target evidence slices the run's split results to that target's baseline-through-
target interval. Later splits never enter earlier hashes, evidence or calculations.
Evidence requestedFrom/requestedThrough describe this target-specific validated
coverage, even when transport acquired a larger catch-up interval. Apply the Phase 1
helper's `rawVolume / product(splitFrom/splitTo)` for
`barDate < executionDate <= targetDate`. Successful empty split results are complete
evidence. Unit OHLC prevents price direction from entering Participation.

Call `calculateParticipationV1` with the exact dates and all five normalized volume
series. No predecessor state, 40-session baseline, hysteresis or confirmation input.
Every VALID rawState equals effectiveState. Agreement/minimum/maximum/range remain
diagnostics only. Provider daily aggregate volume is not strictly reconstructed
regular-hours volume; ETF activity is not total underlying-stock participation.

Outcome precedence: calendar -> invalid stored input -> missing data -> insufficient
baseline/zero median -> split failure -> arithmetic/calculation -> VALID.
MISSING_MARKET_DATA and INSUFFICIENT_HISTORY are UNAVAILABLE; calendar, split and
calculation failures are FAILED. Every non-VALID row has null states, dataThroughAt
and validUntil, with explicit reason and diagnostics. No neutral fallback exists.

Evidence JSON contains version/definition, target/due/cutoff, exact baseline dates,
reviewed calendar bounds and semantic exception snapshot, five instrument records
with all 105 raw decimal strings/MarketBar IDs/normalized volumes/factors, per-symbol
split coverage/events and median/RVOL, panel diagnostics, and non-authoritative
lineage. A top-level `bootstrap` boolean is true only for the first successful
authoritative row (no VALID predecessor) and false otherwise. That row also includes
baseline-only initialization:
20 baseline sessions, 105 inputs, zero replayed/published historical assessments.
Missing evidence uses null, never NaN/Infinity. Receipt/audit times are retained
where useful but excluded from hashes.

SHA-256 canonicalInputHash uses fixed symbol/date/event order and semantic inputs:
version, frozen definition, target, expected dates, calendar, Security/MarketBar IDs,
canonical decimal volumes, target-specific split events and normalization semantics.
It excludes clocks, receivedAt, fetch timestamps, predecessor state and later targets.
attemptFingerprint additionally covers status/reason, target/cutoff, predecessor ID
and stable missing/failure details. Identical non-VALID evidence is rechecked but
suppressed without a new row/event; changed evidence/category inserts max-attempt+1.
Recovered VALID always inserts a new immutable attempt.

## Lineage and transactional events

previousAssessmentId references only the same dimension/version's latest strictly
earlier VALID row. Validate these semantics explicitly. Failed attempts never become
predecessors. Prior evidence is not parsed for calculation; prior state is used only
for event context. Evidence states `calculationAuthority:false`.

One event per inserted row, precedence:

1. `participation_assessment_blocked` / WARNING for new non-VALID attempts.
2. `participation_assessment_bootstrap` / INFO for first successful publication.
3. `participation_assessment_recovered` / INFO for same-target recovery.
4. `participation_assessment_transition` / INFO for changed ordinary VALID state.

Unchanged ordinary VALID, notDue and suppressed failures emit no event. Sanitized
payloads include assessment/session/attempt/reason, predecessor, previous/current
states and recovered attempt ID. Event failure rolls back the assessment too.

## Validation and database isolation

- Focused Participation publisher/calendar/calculation, Massive client and existing
  Trend/Volatility/Breadth service tests: **19 files / 438 tests passed**.
- `npm.cmd run check` and `npm.cmd run build`: passed.
- `npm.cmd test`: **198 files passed; 2,223 tests passed**, 10 opt-in database files /
  181 tests skipped. Intermittent unrelated flakes were observed under parallel load and
  are reported rather than hidden: one `Worker exited unexpectedly` error (197 files
  passed, no identified file; three subsequent serial runs were clean) and one run with
  two `Lifecycle mutation is already in progress` failures in `order.worker.test.ts` and
  `broker-activity.service.test.ts` (both pass in isolation; the next full run was clean).
  Neither area is touched by this phase; HEAD without these changes ran clean twice.
- Actual `RUN_DATABASE_INTEGRITY_TESTS=1` serial run of `src/db/__tests__`:
  **11 files / 186 tests passed**, including the 10 new real PostgreSQL publisher tests.
- `git diff --check`: passed.

The new integration harness refuses non-local hosts, connects administratively to
`postgres`, creates a UUID-named `participation_publication_*` database, verifies
`current_database()`, and injects only clients pointed at that database. It replays
all 71 migrations, including restored Intraday Stress, and drops the database afterward.
Existing integrity suites similarly replay into their own random disposable DBs.
No publisher ran against the persistent development DB. No persistent migration,
reset, migrate resolve, live Massive request, broker call or production access occurred.

Real tests cover all four states, immutable rows, one VALID per target, pinned
bootstrap/continuation, retries and predecessor chains, exact freshness/early-close
exclusion, two independent Prisma clients, event rollback, terminated backend lock
release and successful subsequent publication. Snapshots assert unchanged
OrderIntent, BrokerOrder, BrokerActivity, TrackedPosition, PositionExitState, Signal,
SignalDelivery, SignalEvaluation, EntryDecision, CurrentMarketState, Strategy,
Subscription, TradingAccountSubscription, OperationalAttention and MarketBar rows.

## Files and Phase 3 handoff

Production: `src/services/participation-assessment.service.ts`,
`src/services/participation-publication-calendar.ts`, and the optional cancellation
argument in `src/integrations/massive/evidence.client.ts`.
Tests: matching service/calendar tests, `participation-publication.integration.test.ts`,
HTTP cancellation coverage in `evidence.client.test.ts`, and the Phase 1 pure-boundary
test updated to permit an independent publisher while retaining its purity check.
Documentation: this handoff, a forward link in Phase 1, and the AGENTS.md posture.

No known Phase 2 implementation blocker remains. Phase 3 should add permissioned
owner-run/read HTTP endpoints, a monitored global worker with bounded scheduling,
failure/suppression health semantics, and explicit shutdown/drain behavior. Preserve
service cancellation bounds and do not start automatic publication until persisted
calendar coverage, five catalog identities, exact baseline acquisition and Massive
entitlement are reviewed. Owner manual persistent-local acceptance remains separate.
UI, policy/composition, trading authority and account scope remain outside this phase.

Update: Phase 3A later added the owner-run/read HTTP surface ([Phase 3A](participation-v1-phase3a.md)) and Phase 3B the monitored worker ([Phase 3B](participation-v1-phase3b.md)).
