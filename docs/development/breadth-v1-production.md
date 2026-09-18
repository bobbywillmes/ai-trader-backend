# BREADTH_V1 production and local acceptance

The frozen production definition adopts the research-accepted STRUCTURAL_V3 classifier plus
the mild-deterioration confirmation hysteresis, but reimplements it independently in
`src/services/breadth-v1-calculation.ts` under its own frozen names (`BREADTH_V1_*`). Production
code never imports the research modules under `src/dev/breadth-*` or `src/services/breadth-calculation.ts`,
and never references research profile names (`STRUCTURAL_V3`, `MILD`, `CANDIDATE_*`). This
phase ends at authoritative immutable BREADTH assessments: there is **no trading effect** —
no `StrategyMarketRegimePolicy`, no overall Market Regime composition, no `SignalEvaluation`,
`EntryDecision`, or `OrderIntent` change. The research reports remain historical calibration
evidence, not production settings:

- [Breadth Calibration Results](breadth-calibration-results.md)
- [Breadth Threshold Comparison](breadth-threshold-comparison.md)
- [Breadth Distribution Diagnostic](breadth-distribution-diagnostic.md)
- [Breadth Structural Candidate](breadth-structural-v3-results.md)
- [Breadth Hysteresis Experiment](breadth-hysteresis-confirmation-results.md)

## Purpose and scope

Breadth answers exactly one question: "how much of the U.S. common-stock market is
participating directionally?" It is provider-agnostic evidence about the market, computed
from Massive only — never Alpaca, never a fallback provider. It is explicitly **not** SPY vs
RSP (that is Volatility's instrument pair), not volume participation, not leadership/
concentration, not new-high/new-low breadth, and not moving-average breadth; those remain
separate future dimensions (`PARTICIPATION`, `LEADERSHIP`, already reserved in the
`MarketRegimeDimension` enum but unimplemented).

## Universe and Massive endpoints

Point-in-time common-stock universe, frozen as `BREADTH_UNIVERSE_V1`:

```
GET /v3/reference/tickers?locale=us&market=stocks&type=CS&active=true&date=T&limit=1000
```

Cursor-paginated deterministically; never uses today's active universe for a prior date.
Grouped daily source, Massive-adjusted:

```
GET /v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true
```

## Daily observation

For session `T`, with `P` the immediately previous expected session (Market Calendar
authority; CLOSED dates and weekends skipped, EARLY_CLOSE sessions valid): a ticker
participates only if it is in the point-in-time universe for `T` and has a valid close on
both `T` and `P` — no carrying forward stale closes, no backward search past `P`.

```
advancingCount / decliningCount / unchangedCount  (close[T] vs close[P])
directionalCount = advancingCount + decliningCount   (unchanged excluded)
advanceShare = advancingCount / directionalCount
netBreadth   = (advancingCount - decliningCount) / directionalCount
```

If `directionalCount == 0`, there is **no fabricated row** — see below.

## Immutable `MarketBreadthObservation`

Added by migration `20260918120000_add_market_breadth_observation`, alongside the existing
shared `reject_market_evidence_mutation()` trigger (DB rejects `UPDATE`/`DELETE`). One row per
`(provider, universeDefinitionVersion, sessionDate)`. A row exists **only when
`directionalCount > 0`** — there is no "unavailable" placeholder row, mirroring `MarketBar`:
absence of a row for an expected session is itself the unavailable signal the BREADTH_V1
publisher reacts to (`MISSING_MARKET_DATA`). Core counts/share fields are real columns
(`universeCount`, `currentBarCount`, `priorBarCount`, `advancingCount`, `decliningCount`,
`unchangedCount`, `directionalCount`, `excludedCount`, `advanceShare`, `netBreadth`); provider
identity, `canonicalInputHash`, and provenance-linking metadata are stored alongside.
`evidenceJson` carries supporting provenance (universe/grouped hashes), never full Massive
payloads or thousands of ticker rows.

The same migration extends `RegimeDimension_states_check` with BREADTH's `POSITIVE`/`MIXED`/
`NEGATIVE` vocabulary and `RegimeDimension_terminal_check`'s sessionDate-required dimension
list to include `BREADTH`, without touching TREND's or VOLATILITY's existing rows, triggers,
attempt identity, partial-VALID uniqueness, or predecessor FK.

## Historical bootstrap artifact

`prisma/bootstrap/breadth-v1-bootstrap-artifact.json` (checked in) contains exactly the
derived per-session facts a `MarketBreadthObservation` row needs — no raw per-ticker evidence,
no classifier/effective-state output. Generated deterministically, with **zero provider
calls**, directly from the accepted research disk cache:

```powershell
npm.cmd run generate:breadth-v1-bootstrap-artifact
```

Current artifact: **1,252 rows, 2021-09-16..2026-09-16**, `canonicalArtifactHash`
`41347fa98195f9338b7f38598ac2220fa4e25975cbdeb831b63a95349d585507`. Regenerating against the
same cache reproduces this exact hash. The generator (`src/dev/breadth-v1-bootstrap-artifact-generator.ts`)
STOPs if the required cache is missing rather than fetching anything, and never fabricates a
row for a resolved provider failure or a zero-directional session.

The artifact's top-level `from`/`through` (`2021-09-16..2026-09-16`) describe the **requested
research-cache range** the generator scanned, not the range of rows actually produced. Sessions
inside that range with no usable evidence — including the known entitlement-gap sessions at the
very start of the cache — are correctly **not** written as fabricated rows; the generator skips
them (`continue`), so `rowCount` (1,252) is smaller than the full calendar span implied by
`from..through`. Concretely, `rows[0].sessionDate` is **`2021-09-21`**, not `2021-09-16`. At
runtime, the BREADTH_V1 publisher never reads the artifact's `from` field for provenance — its
`evidenceJson.provenance.inputFrom` is derived from the earliest **persisted**
`MarketBreadthObservation.sessionDate`, which is this same `2021-09-21`, correctly reflecting the
first actually usable historical observation rather than the requested cache boundary.

## Bootstrap import

```powershell
npm.cmd run breadth:bootstrap                # preview: no writes
npm.cmd run breadth:bootstrap -- --apply      # inserts missing rows only
```

Preview validates the artifact's own shape, its top-level `canonicalArtifactHash`, and every
row's `canonicalInputHash`, then classifies each row against the database: insert, exact
existing match, or conflict. Apply runs inside one transaction under an exclusive advisory
lock (`breadth-observation-lock.service.ts`, independent from the SPY/RSP `market-daily-evidence`
lock), inserts only missing rows, **fails closed on any conflicting existing row** (writes
nothing at all), and never updates or deletes. Rerunning after a successful apply is a full
no-op. This imports raw/derived market evidence only — it never writes
`MarketRegimeDimensionAssessment`; historical authoritative BREADTH assessments are never
backfilled.

## Live ingestion

`src/services/breadth-observation-ingestion.service.ts` fetches only what a due session needs
(`grouped T`, `grouped P`, `universe T`; `P`'s grouped response is cached in-run and reused as
the next session's boundary). At most **5 missing sessions per invocation** — a bounded,
conservative catch-up. If `MarketBreadthObservation` has never been bootstrapped
(`count === 0`), it returns `bootstrapRequired: true` and fetches nothing; it never infers a
five-year fetch. A zero-directional session or any provider failure blocks that session (no
fabricated row) rather than being silently skipped.

## Frozen BREADTH_V1 classifier

`breadth1` = current `advanceShare`; `breadth5`/`breadth20` = arithmetic mean of the latest 5/20
consecutive valid sessions including `T`. No EMA, no weighting, no cumulative A/D line. A
missing expected session breaks continuity; CLOSED/weekends do not; EARLY_CLOSE is valid.

| Horizon | NEGATIVE | MIXED | POSITIVE |
| --- | --- | --- | --- |
| 1d | `<= 0.44` | `> 0.44 and < 0.54` | `>= 0.54` |
| 5d | `<= 0.46` | `> 0.46 and < 0.52` | `>= 0.52` |
| 20d | `<= 0.47` | `> 0.47 and < 0.51` | `>= 0.51` |

Raw aggregation: 5d and 20d are structural breadth. Identical states win outright; opposite
states are `MIXED`; one directional + one `MIXED` requires 1d to confirm the same direction
(otherwise `MIXED`); both `MIXED` is `MIXED`. 1d alone can never create a directional raw state.

## Frozen hysteresis (two independent counters)

`recoveryConfirmation` and `mildDeteriorationConfirmation` are never conflated.

- **POSITIVE**: raw `POSITIVE` holds and resets both counters. Raw `MIXED` holds for one
  supporting assessment (`mildDeteriorationConfirmation = 1`); a second consecutive raw
  `MIXED` confirms the drop to `MIXED`. Raw `NEGATIVE` is never mild — immediate one-level drop
  to `MIXED`, no confirmation delay.
- **MIXED**: raw `NEGATIVE` drops to `NEGATIVE` immediately. Raw `MIXED` holds and resets. Raw
  `POSITIVE` requires two consecutive supporting assessments to recover to `POSITIVE`.
- **NEGATIVE**: raw `NEGATIVE` holds and resets. Raw `MIXED` or `POSITIVE` both support recovery
  to `MIXED` only — two consecutive supporting assessments, never straight to `POSITIVE`.
- **UNAVAILABLE** evidence pauses both counters: no increment, no reset, no transition.

A direct one-assessment `POSITIVE -> NEGATIVE` (or `NEGATIVE -> POSITIVE`) transition is
structurally impossible.

## Accepted-research regression

`src/services/breadth-v1-calculation.regression.test.ts` replays the checked-in bootstrap
artifact through the independent production calculator and asserts the terminal (2026-09-16)
and a mid-history checkpoint (2026-09-02) exactly match the frozen accepted research result
(`rawState`, `effectiveState`, `recoveryConfirmationAfter`, `mildDeteriorationConfirmationAfter`).
`src/db/__tests__/breadth.integration.test.ts` additionally runs the *real* bootstrap import
and publisher against a real ephemeral Postgres database and confirms the same terminal
result end to end.

## Publisher

`src/services/breadth-v1-assessment.service.ts` mirrors TREND_V1/VOLATILITY_V1 orchestration:
`dimension=BREADTH`, `algorithmVersion=BREADTH_V1`, `evidenceSchemaVersion=1`, daily only,
`targetAt` = expected session close, eligibility = close + 30-minute grace. Historical replay
establishes today's calculation state; it never creates retroactive authoritative history —
bootstrap publishes exactly one current assessment, picking the latest calculable session
rather than losing a usable bootstrap to a recent gap. Continuation reads the persisted
predecessor's evidence (`recoveryConfirmationAfter`, `mildDeteriorationConfirmationAfter`,
`effectiveState`, `provenance.inputFrom`) rather than recomputing hysteresis from scratch, and
never skips an unresolved due target — chronological catch-up stops at the first
`UNAVAILABLE`/`FAILED` target. Uses `pg_try_advisory_xact_lock`, immutable attempts, and
identical-failure suppression exactly like Volatility. If `MarketBreadthObservation` has zero
rows, publication reports `bootstrapRequired: true` rather than crashing or fabricating.

`evidenceJson` includes: the frozen definition (thresholds, aggregation/hysteresis rules);
breadth1/5/20 values, states, and contributing `MarketBreadthObservation` ids; the raw
aggregation path and `rawState`; full hysteresis detail (`recoveryConfirmationBefore/After`,
`mildDeteriorationConfirmationBefore/After`, `transitioned`, `reason`,
`predecessorAssessmentId`); calendar (`expectedSessionClose`, `graceMinutes`, `graceCutoff`,
`calendarException`, `nextExpectedSession`, `validUntil`); provenance (current observation id,
input range, canonical replay hash); and, for bootstrap, `historicalReplay` (start,
sessionCount, explanation). Never full Massive raw responses.

## Worker

`breadth_assessment_publication` runs on startup and every 15 minutes: ensures due live
observation ingestion, then runs the publisher. Throws a clear `BREADTH_BOOTSTRAP_REQUIRED`
error (visible via worker health as a failing tick) rather than inferring a historical fetch
if `MarketBreadthObservation` is empty. Massive only; never Alpaca.

## API

```
GET  /api/market-data/breadth-assessments/latest
GET  /api/market-data/breadth-assessments
GET  /api/market-data/breadth-assessments/:id
POST /api/market-data/breadth-assessments/run        (SYSTEM_OWNER; respects eligibility, not force)
GET  /api/market-data/breadth-observations/latest
GET  /api/market-data/breadth-observations
GET  /api/market-data/breadth-observations/:id
POST /api/market-data/breadth-observations/run        (SYSTEM_OWNER; bounded live ingestion, never historical bootstrap)
```

Auth/pagination/error style matches the existing Trend/Volatility/market-data routes exactly
(`PlatformPermission.MARKET_DATA_READ` for reads, `requireSystemOwnerAccess` for the two `run`
endpoints).

## Manual acceptance plan

1. `npx prisma migrate deploy && npx prisma generate`.
2. `npm run breadth:bootstrap` (preview) — inspect `canonicalArtifactHash`, `from`/`through`,
   `inserts`, `existingMatches`, `conflicts`.
3. Confirm `conflicts.length === 0`.
4. `npm run breadth:bootstrap -- --apply`.
5. Rerun the same command; confirm `inserted: 0` (fully idempotent).
6. `GET /api/market-data/breadth-observations/latest` — verify stored counts/share/
   `evidenceJson`/provenance.
7. `POST /api/market-data/breadth-observations/run` — if nothing new is due, confirm a clean
   no-op/`notDue` result.
8. `POST /api/market-data/breadth-assessments/run`.
9. `GET /api/market-data/breadth-assessments/latest` — verify `dimension=BREADTH`,
   `algorithmVersion=BREADTH_V1`, `evidenceSchemaVersion=1`, `status=VALID`,
   `breadth1`/`breadth5`/`breadth20` values/states, `rawState`, `effectiveState`, both
   hysteresis counters, observation provenance, `dataThroughAt`, `validUntil`,
   `evidenceJson.bootstrap=true`.
10. Confirm the bootstrap terminal state matches the accepted research replay (see above).
11. Immediately `POST /api/market-data/breadth-assessments/run` again — expect a clean
    no-op/`notDue` result, no duplicate row.
12. `GET /api/market-data/trend-assessments/latest` and
    `/api/market-data/volatility-assessments/latest` — confirm both unchanged.
13. Inspect System Events / worker health for `breadth_assessment_publication`.
14. On the next completed eligible market session: confirm a new live observation is created,
    a BREADTH_V1 continuation row is created with `previousAssessmentId` pointing to the
    bootstrap row, `evidenceJson.bootstrap=false`, no cross-dimension predecessor, and no
    duplicate rows.

## Confirmed

No schema change beyond the one new migration described above. No authoritative BREADTH row
is backfilled historically — only the current bootstrap assessment is published. No trading
effect: no `StrategyMarketRegimePolicy`, no overall Market Regime composition, no
`SignalEvaluation`/`EntryDecision`/`OrderIntent` change. TREND_V1 and VOLATILITY_V1 are
untouched.
