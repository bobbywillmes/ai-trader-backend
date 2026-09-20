# PARTICIPATION_V1 Phase 3A: operator API and manual acceptance

Implemented locally on `feat/market-regime-expansion`. **Zero trading authority.**
Phase 3A exposes the frozen Phase 2 publisher through the existing market-data router
only. There is **no worker, scheduler, `setInterval`, startup publication, WorkerHealth
key, shutdown wiring, UI, OperationalAttention, policy, composition or trading
consumer**. Starting the backend never publishes a Participation assessment. The only
production caller of `publishParticipationAssessments` is the owner-run controller
(enforced by `src/routes/participation-assessments.routes.test.ts`).

## Endpoints (all under `/api/market-data`, behind the existing `requireAdminAccess`)

| Method / path | Authorization | Behavior |
|---|---|---|
| `GET /participation-assessments/latest` | `MARKET_DATA_READ` | `{ latestAttempt, latestValid }`, independent |
| `GET /participation-assessments` | `MARKET_DATA_READ` | id-descending list |
| `GET /participation-assessments/:id` | `MARKET_DATA_READ` | detail; 404 for missing/other dimension/version |
| `POST /participation-assessments/run` | `SYSTEM_OWNER` only | runs the exact Phase 2 publisher |

Validation: list accepts only `limit` (integer 1-100, default 20) and `beforeId`
(positive market id); unknown query fields are 400. Detail requires a positive id.
Run accepts an absent body or `{}`; any other field or non-object is 400. There is no
way to choose a date, symbol, state, threshold, 4-of-5 mode, skip an unresolved
target, bypass calendar authority, or disable split validation.

Responses: latest never synthesizes a mutable "current" row and never mutates
freshness; a newer blocked attempt stays visible beside an older VALID row. Run returns
the service result unchanged (`published, attempts, suppressed, notDue, blocked`). Lock
contention is HTTP 409. An unresolved attempt-uniqueness collision (P2002 with no
committed VALID winner) is a Participation-specific 409 rather than the generic
calendar-exception message. Calendar-authority failures with no trustworthy target are
ordinary errors, not fabricated blocked rows; provider bodies/credentials are never
returned.

## Readiness: existing endpoints are sufficient

No new readiness helper was added; a second source of truth would risk diverging from
the publisher. Existing tooling covers the prerequisites:

- Calendar: `npm run calendar:bootstrap` (preview, no writes) and `-- --apply`. Reports
  `wouldInsert`, `skipped`, `conflicts`. Reviewed definition currently:
  **59 closures + 12 early closes = 71 rows**, horizon 2021-01-01..2026-12-31.
- Securities and MarketBar coverage: `GET /api/market-data/status` reports, for each of
  SPY/QQQ/DIA/IWM/RSP, `securityId` (null if the Security is absent), count,
  earliest/latest and `historicalMissing`/missing dates for DAY_1 / MASSIVE / UNADJUSTED.
  `historicalMissing` covers a 370-day window, so ignore dates before the range you
  deliberately backfilled; only the target and its exact prior 20 full sessions matter.
- Backfill: `POST /api/market-data/backfill` with `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`
  (owner only, max 370 days).
- Provider/split access cannot be pre-verified read-only. The first run is the real
  acceptance of Massive credentials and split entitlement; failure fails closed as
  `FAILED / SPLIT_EVIDENCE_UNAVAILABLE` and is retried on the same target.

## Manual acceptance procedure (operator only; never automated)

Do not run these from Codex/CI. Use a `SYSTEM_OWNER` session for writes.

1. **Safety.** Confirm branch `feat/market-regime-expansion` and a clean tree; confirm a
   fresh dev-DB backup; `npx prisma migrate status` must report up to date (71 migrations).
2. **Calendar preview.** `npm run calendar:bootstrap`. Record `wouldInsert`, `skipped`,
   `conflicts`. Any conflict: **STOP** and resolve deliberately.
3. **Calendar apply.** Only after review: `npm run calendar:bootstrap -- --apply`. Re-run the
   preview: expect zero conflicts, `wouldInsert: 0`, `skipped: 71` (59 + 12).
4. **Securities.** Verify SPY, QQQ, DIA, IWM, RSP exist (status shows non-null
   `securityId`). Create no TradingAccountSubscription.
5. **Status.** `GET /api/market-data/status`; confirm all five symbols; note actual gaps.
6. **Bounded backfill.** `POST /api/market-data/backfill` with a range covering the latest due
   full session plus its 20 prior full sessions with pre-roll (about 45-60 calendar
   days back). Do not fetch years.
7. **Re-check coverage.** From status, verify every expected date is present for all five
   symbols (not merely the sync checkpoint). Early-close/holiday dates are not expected.
8. **First run.** `POST /api/market-data/participation-assessments/run` with `{}`. This is
   the first persistent-local authoritative publication.
9. **Inspect result.** Expect `published: 1, attempts: 1, blocked: null` (VALID bootstrap)
   or a deliberate fail-closed result. Never "fix" a block by skipping the target;
   repair evidence and re-run (same target is retried).
10. **Latest.** `GET .../latest`: verify `dimension`, `algorithmVersion`, `sessionDate`,
    `targetAt`, `validUntil`, `rawState == effectiveState`, `evidenceJson.bootstrap == true`.
11. **evidenceJson.** Verify 5 instruments in SPY, QQQ, DIA, IWM, RSP order; 20 baseline
    observations each (105 inputs with targets); exact baseline dates; raw volume
    strings; normalized volumes and split evidence; `medianVolume20`, `rvol20`,
    `panelMedianRvol`, thresholds/diagnostics; `lineage.calculationAuthority == false`;
    baseline-only `initialization`; `canonicalInputHash`, `attemptFingerprint`.
    Independently recompute one ETF's median/RVOL and the five-value panel median.
12. **Event.** Expect one `participation_assessment_bootstrap` SystemEvent.
13. **Idempotent rerun.** POST again: no duplicate row and no second bootstrap event
    (`notDue` or another idempotent result appropriate to the time).
14. **Zero authority.** Confirm no new orders, broker activity, EntryDecision,
    SignalEvaluation, position or trading-setting changes, and no broker call.
15. **Record evidence.** Log assessment/event IDs, session/target dates, state, hashes,
    coverage and any provider limitation here or in a private acceptance log.

## Validation

`npm.cmd run check`, `npm.cmd run build` and the full `npm.cmd test` pass (200 files /
2,263 tests, 10 opt-in database files skipped), plus focused route, mounted-auth and
manual-only boundary tests. Intermittent unrelated Vitest failures (a worker exit and
`order.worker.test.ts`) were seen under parallel load and did not reproduce in three
serial reruns. The publisher was not run against the persistent development database
and no live Massive request was made.

## Remaining (Phase 3B and later)

Monitored bounded worker, WorkerHealth registration, failure/suppression health
semantics, startup/shutdown drain, and any UI/policy/composition remain unstarted.
