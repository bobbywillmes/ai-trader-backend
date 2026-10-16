# PARTICIPATION_V1 production publication

`PARTICIPATION_V1` publishes immutable, account-independent market-regime evidence describing whether trading activity is quiet, normal, active, or intense across SPY, QQQ, DIA, IWM, and RSP. It has **zero trading authority**: it does not change Strategy policy, Signal evaluation, entry decisions, orders, positions, or exits.

Historical calibration and its limitations are preserved in [the research record](../development/research/participation/research.md) and [calibration results](../development/research/participation/calibration-results.md). Those reports support this frozen definition but are not mutable runtime configuration.

## Frozen definition

For each panel symbol, production divides the split-normalized target `DAY_1` volume by the median of the exact previous 20 eligible, completed `FULL` sessions. The target is excluded from its baseline. The market measurement is the median of all five RVOL20 values.

| Effective state | Panel median RVOL20 |
| --- | ---: |
| `QUIET` | `< 0.75` |
| `NORMAL` | `>= 0.75` and `< 1.25` |
| `ACTIVE` | `>= 1.25` and `< 1.50` |
| `INTENSE` | `>= 1.50` |

`rawState` equals `effectiveState`. V1 has no hysteresis, confirmation, recovery delay, transition restriction, price-direction input, or agreement gate. The research-only 40-session control does not enter publication.

All five target values and all 20 named baseline sessions per symbol are required. Closed dates and weekends are excluded. Early-close sessions are deliberately ineligible; persisted, reviewed `MarketCalendarException` evidence must identify them. Production reads canonical daily evidence across the configured provider-authority segments and requires deadline-bounded persisted split evidence. It does not infer coverage from bars and does not fall back to another provider.

The version identity is `PARTICIPATION_V1` with publication evidence schema version 1. Changing symbols, baseline length, thresholds, session eligibility, state vocabulary, or split semantics requires a deliberate algorithm-version change.

## Publication lifecycle

`publishParticipationAssessments` runs inside its own PostgreSQL transaction advisory lock. If another publisher owns the lock, the call returns without competing for the same target.

On an empty chain, bootstrap selects exactly the latest due eligible full session. Once a predecessor exists, publication advances strictly chronologically. A call processes at most 20 targets. An unresolved target is recorded as an immutable failed attempt and pins the chain; later targets are not skipped.

Every attempt freezes:

- algorithm and evidence versions;
- target session, target time, due time, and predecessor identity;
- exact calendar evidence;
- the five symbols and 20 named baseline dates;
- canonical bar and provider provenance;
- split events and coverage used for normalization;
- per-symbol target volume, baseline median, and RVOL;
- final panel median, raw/effective state, status, and bounded reason codes.

Attempts are append-only. Successful retry creates a later attempt rather than mutating failure history. Predecessors provide lineage only; they do not influence the state calculation. Transactional System Events record significant publication outcomes without granting trading authority.

## API and authorization

Routes are mounted under `/api/market-data/participation-assessments`:

- `GET /latest` returns the latest assessment.
- `GET /` lists immutable attempts with validated pagination/filter inputs.
- `GET /:id` returns one attempt and its frozen evidence.
- `POST /run` invokes the publisher manually.

Read routes require `market_data.read`. Manual publication requires System Owner access. Reads are account-independent. A successful publication response means an attempt was stored; consumers must still inspect status and current `validUntil` semantics.

## Worker and monitoring

The `participation_assessment_publication` worker runs on the shared monitored 15-minute schedule. It is account-independent and informational. The scheduler supports abort and drain during shutdown and prevents overlapping local ticks; the database advisory lock protects against multiple processes.

Expected blocked evidence is represented by the immutable attempt and bounded System Event. Unexpected worker errors update worker health and are not allowed to terminate unrelated workers. Monitoring publication health must not be translated into a trading decision.

## Operator acceptance

Before manual acceptance:

1. Apply and review required market-calendar exceptions using `npm.cmd run calendar:bootstrap -- --apply` where appropriate.
2. Verify canonical daily bars and strict split coverage for all five symbols and the required session window.
3. Use an isolated acceptance database when testing first publication, retries, concurrency, or immutability.

Then:

1. Read `/api/market-data/status` and confirm daily evidence coverage.
2. As a System Owner, `POST /api/market-data/participation-assessments/run`.
3. Inspect the returned attempt, exact baseline dates, five RVOL values, state, provider segments, split evidence, and `validUntil`.
4. Repeat the run. With no later due target, expect no duplicate assessment.
5. Inspect list/detail routes and worker health.
6. In the isolated database, exercise two concurrent publishers and confirm only one attempt owns a target/attempt identity.
7. Confirm invalid or incomplete calendar, bar, split, or arithmetic evidence produces a bounded failed attempt and prevents later publication.
8. Compare trading tables before and after; no `Signal`, `SignalEvaluation`, `EntryDecision`, `OrderIntent`, `BrokerOrder`, `TrackedPosition`, or exit state may change.

## Validation

The implementation is primarily defined by:

- `src/services/participation-v1.definition.ts`
- `src/services/participation-v1-calculation.ts`
- `src/services/participation-publication-calendar.ts`
- `src/services/participation-assessment.service.ts`
- `src/controllers/participation-assessment.controller.ts`
- `src/workers/participation-assessment.worker.ts`
- `src/routes/market-data.routes.ts`

Run the targeted unit, route, worker, and PostgreSQL integration tests before the full backend check, test, and build. Automated tests must not contact market-data providers.
