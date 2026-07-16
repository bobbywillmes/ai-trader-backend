# Momentum Decision Engine Audit

This audit records the behavior on `feat/momentum-decision-engine` before pipeline-run persistence or scoring changes. It is the baseline for the later implementation commits. The scanner remains research and review infrastructure; none of the routes below create signals, orders, broker activity, or Alpaca requests.

## Current pipeline

The documented n8n sequence is:

```text
Run news worker
-> Generate candidates
-> Confirm candidate prices
-> Prepare scanner handoffs
-> Fetch pending handoffs
-> Send Slack review
-> Mark each handoff sent or failed
```

There is no full-run record or run identifier. Each HTTP request is independently observable, so a later failure can leave valid output from earlier stages without a durable statement that the overall attempt was partial or failed.

### Run news worker

- Reads or creates `NewsPullCursor` rows, selects bounded due Massive cursors, and calls Massive once per selected symbol.
- Upserts `CatalystEvent` and `CatalystTickerImpact` records through the ingestion service, then records per-cursor success or error.
- Returns seeded/due/pulled/successful/failed symbol counts plus article, event, and impact counts. It returns `{ skipped: true, reason: already_running }` for an overlapping in-process tick.
- Cursor selection is bounded by `MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN`. Provider and ingestion failures are isolated per symbol; the stage can return HTTP 200 with `failedSymbols > 0`.
- Event/impact ingestion is upsert-based and cursor progress makes normal repeats idempotent. A process failure can leave earlier symbols committed and later symbols unprocessed.
- Candidate expiration does not occur.

### Generate candidates

- Reads recent positive, unblocked `CatalystTickerImpact` rows at or above the catalyst threshold, with their event and security/universe membership. The query is bounded to 500.
- Reads unexpired active candidates for eligible securities to suppress duplicates.
- Upserts one `MomentumCandidate` per `(symbol, catalystImpactId)`. New candidates start `DISCOVERED`, with catalyst score copied to total score and price, volume, and risk fields set to zero.
- Returns evaluated/generated/skipped counts, per-impact skip details, and reasons: `UNKNOWN_SECURITY`, `OUTSIDE_RESEARCH_UNIVERSE`, `UNIVERSE_DISABLED`, `DUPLICATE_ACTIVE_CANDIDATE`, and `STALE_CATALYST`.
- The database unique constraint makes the same impact idempotent, but an upsert refresh resets its market component scores to zero. Candidate writes are per impact rather than one transaction, so a later exception can leave earlier candidates committed.
- Expired-by-time candidates are excluded from duplicate suppression, but their stored state is not changed to `EXPIRED`.

### Confirm candidate prices

- Reads bounded candidates in active states, ordered by stored total score and age, including universe and subscription context.
- Configuration eligibility is evaluated before any provider request. Missing/disabled universe membership, disabled price scanning, missing security, inactive/expired state, and subscription/strategy/account ineligibility all skip price evaluation.
- For selected eligible candidates it calls Massive snapshot/minute aggregates, derives a snapshot, creates a `MomentumCandidatePriceCheck`, and updates the candidate's component scores, total, state, block reason, latest observation snapshot, and metadata.
- Returns evaluated, entry-ready, watching, blocked, skipped, skip counts, errors, and detailed results. Per-candidate exceptions are caught, so HTTP 200 can contain errors.
- Repetition is not idempotent at the history level: every successful evaluation creates another check. Candidate latest fields converge for identical market data, but `rawSnapshot`, metadata, and timestamps are updated.
- Candidate-check creation and candidate update are separate writes without a transaction. Failure after check creation can leave a check that is not reflected by candidate latest fields.
- A time-expired candidate is skipped by eligibility before `getHardBlockReason` can return `CANDIDATE_EXPIRED`; its state therefore remains active. No expiration operation runs here.

### Prepare scanner handoffs

- First scans a bounded set of pending handoffs and cancels those whose candidate is no longer eligible, ready, current, or above the handoff threshold.
- Reads bounded `ENTRY_READY`, unblocked, unexpired candidates above the score threshold, including the latest check and configuration context.
- Creates a `MomentumScannerHandoff` containing a review-only snapshot, or reuses the unique versioned idempotency key. Without `force`, an existing handoff is returned rather than duplicated.
- Returns prepared/skipped counts, skip counts/details, and handoff records. Configuration eligibility still controls handoff creation, which is appropriate for delivery eligibility but must not rewrite the market decision.
- Cancellation and preparation are row-by-row operations. A later exception can leave earlier cancellations/preparations committed.
- It does not expire candidates; it only cancels stale pending handoffs.

### Fetch pending handoffs

- Cancels a bounded set of stale pending rows, then lists bounded `PENDING` handoffs and filters again for current eligibility.
- This queue read is repeatable and does not mutate eligible handoffs, but stale cancellation is a mutation and can be partial if a row update fails.
- It returns an array, which the documented n8n extractor normalizes before Slack delivery.

### Deliver and mark sent or failed

- Slack delivery is external to this repository. n8n posts to `mark-sent` after success or `mark-failed` after failure.
- `mark-sent` sets `SENT`, `sentAt`, clears the error, and increments attempts. It does not guard the current status, so duplicate callbacks increment attempts again.
- `mark-failed` sets `FAILED`, `failedAt`, and a sanitized error, but does not increment attempts. Metadata supplied by n8n replaces existing metadata in both operations.
- A Slack or callback failure can leave a handoff `PENDING`; there is no run-level partial/failure record.

## Existing expiration behavior

`expireStaleMomentumCandidates` performs one unbounded `updateMany`: every active-state candidate with `expiresAt <= now` becomes `EXPIRED`, and `lastEvaluatedAt` becomes `now`. The exact boundary is inclusive and reruns are state-idempotent.

It is exposed only as the owner-protected admin route `POST /api/momentum-candidates/expire-stale`. It is not called by generation, price confirmation, handoff preparation, the signal workflow, or a worker. It returns only `expired` and `asOf`, with no inspected/unchanged/reason counts or bounded IDs.

The helper itself is independent of subscriptions and strategies. The operational defect is that normal pipeline execution never invokes it, while price confirmation skips stale candidates through configuration eligibility.

## Dashboard semantics

- `activeCandidates` counts all rows in `DISCOVERED`, `WATCHING`, `ENTRY_READY`, or `ENTRY_BLOCKED`, without an `expiresAt` predicate. It therefore includes stale active-state rows.
- `entryReadyCandidates` and `blockedCandidates` likewise count states without excluding stale rows.
- `staleCandidatesAwaitingExpiration` inspects at most 1,000 active-state candidates and counts eligibility results containing `CANDIDATE_EXPIRED`. The response exposes truncation flags, so the count is explicitly bounded.
- `recentCandidateActivity` means `lastEvaluatedAt` or `updatedAt` within the previous 24 hours, ordered by those fields. Expiration currently changes `lastEvaluatedAt`, so an admin expiration appears as recent candidate activity.
- Historical `EXPIRED` rows are not active and are not included in the stale-awaiting-expiration diagnostic. There is no `expiredDuringLatestRun` because no pipeline run exists.
- Scanner health exposes separate inferred timestamps for latest cursor pull, candidate evaluation, and price check. None represents completion of the full workflow.

Target terminology for later commits:

- `activeCandidates`: active-state and not past `expiresAt`.
- `staleCandidatesAwaitingExpiration`: active-state and `expiresAt <= asOf`.
- `expiredDuringLatestRun`: count recorded by the expiration stage of the latest attempted run.
- `historicalExpiredCandidates`: stored `EXPIRED` rows, reported separately from active configuration diagnostics.

## Current scoring formulas

All stored component fields are integers. Candidate generation treats an unevaluated component as numeric zero, so the schema and current UI cannot distinguish unavailable from a genuine zero score.

### Catalyst score

The candidate copies `CatalystTickerImpact.totalCatalystScore`. The upstream score is additive, not normalized:

- Relevance: 10, 20, 30, or 35 points according to ticker text and provider insight presence.
- Actionability: 0 without an insight, 5 for a neutral insight, or 10 for a positive/negative insight.
- Freshness: 0 without `publishedAt`; otherwise 20 through 24 hours, 15 through 72 hours, 10 through seven days, or 5 when older.
- Source quality: 25 for named wire/SEC sources, 20 for Benzinga/Dow Jones/Reuters, otherwise 10.

The practical formula range is 10-90 for a timestamped ticker mention and can be 0 only through stored/default data outside the normal builder. Candidate discovery defaults to a minimum of 60. Catalyst therefore does **not** share the confirmation components' full 0-100 attainable range, even though the total formula treats the fields as comparable percentages.

### Price-action score

The current score is 0-100 in 25-point steps:

- `+25` when percent from previous close is at least 2%.
- `+25` when last price is above derived/stored session VWAP.
- `+25` when price is no more than 1.5% below the intraday high.
- `+25` when the recent-window move is positive.

Missing inputs simply forfeit points. Below VWAP, a fade, or a negative recent move are not independent hard blocks.

### Volume score

The current score is 0-100:

- `+30` when cumulative day volume exists and is positive.
- `+30` when last price times cumulative day volume meets `MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME` (default $5,000,000).
- `+20` when summed volume in the recent window exists and is positive.
- `+20` when `relativeVolume >= 2`.

The snapshot builder always sets `relativeVolume` to null. Consequently, normal production checks can score at most 80, and an displayed score of 80 with RVOL unavailable means only positive day volume, sufficient dollar volume, and positive recent volume. No volume acceleration or historical baseline is currently calculated. The honest current metric is a liquidity/volume-presence score, not RVOL.

### Risk score

Despite its name, higher means better setup quality. The score is 0-100 in 25-point steps:

- `+25` when price is at least the configured minimum (default $5).
- `+25` when percent from previous close is at most 15%.
- `+25` when extension above VWAP is at most 6%.
- `+25` unconditionally; timing is currently neutral because no market-hours helper is used.

This is not account risk and does not inspect buying power, allocations, entry limits, or reservations. The UI label `Risk` is directionally ambiguous and should become `Setup quality` while the stored/API field remains compatible.

### Confirmation and candidate total

```text
round(catalyst * 0.45 + priceAction * 0.30 + volume * 0.20 + risk * 0.05)
```

After a price check, this value is stored in both `MomentumCandidatePriceCheck.totalConfirmationScore` and `MomentumCandidate.totalScore`. Thus candidate total is recalculated after confirmation and replaces the initial catalyst-only total.

For catalyst 85, price 75, volume 80, and risk/setup quality 100:

```text
round(85*.45 + 75*.30 + 80*.20 + 100*.05) = round(81.75) = 82
```

A result of 92 cannot come from the current formula for those inputs. The existing test/example that produces 92 uses catalyst 90, price 100, volume 80, and risk/setup quality 100. The confirmation components reach 0-100, while the catalyst builder reaches at most 90; neither this mismatch nor the formula version is persisted authoritatively.

### Hard blocks and decisions

Only the first matching hard block is stored: expired candidate, missing last price, missing previous close, price below minimum, percent move above the configured maximum (default 20%), or absence of both recent and day volume.

With no block, total at or above the entry-ready threshold (default 80) yields `ENTRY_READY`; total at or above the watching threshold (default 60) yields `WATCHING`; a lower score leaves a new candidate `DISCOVERED` and maps any other current active state to `WATCHING`. Any block yields `ENTRY_BLOCKED`, including missing data and expiration.

The check's string decision is the block code, `ENTRY_READY`, or `PRICE_CONFIRMED`. There is no explicit stored `WATCHING` decision, list of blocks, structured reasons, data-completeness result, or scoring version field. Metadata contains only `simple_weighted_catalyst_price_volume_risk_v1`.

## State transitions and lifecycle defects

The enum supports `DISCOVERED`, `WATCHING`, `ENTRY_READY`, `ENTRY_BLOCKED`, `EXPIRED`, and `DISMISSED`, but the implementation does not enforce a transition graph.

- Generation creates `DISCOVERED` and may refresh the same candidate's scores without changing its state.
- Confirmation may move any eligible active state to blocked, ready, watching, or discovered according to the current result. Thus `ENTRY_READY` can regress, and `ENTRY_BLOCKED` can recover.
- Configuration ineligibility currently skips evaluation, so it usually does not overwrite market state. However, it also prevents research-only candidates from ever acquiring market observations.
- Expiration through the admin helper is terminal in practice because confirmation selects active states only. No generic transition guard prevents another direct write.
- An expired-by-time candidate that is never manually expired remains in an active enum state indefinitely.

The many active candidates with zero price/volume/risk scores follow directly from generation defaults plus configuration-gated confirmation. Disabled/missing subscriptions, strategies, universe price scanning, or other operational eligibility cause the candidate to be skipped, leaving its initial zeros and `DISCOVERED` state. Stale candidates are also skipped rather than transitioned.

## Stored observations and explanations

Each successful price check stores derived scalar observations, component scores, total, one decision string, one blocked reason, the raw provider payload, and sparse metadata. The candidate stores the same latest scores and a `rawSnapshot.latestPriceConfirmation` copy.

There is no authoritative structured record of scoring inputs, component reasons, multiple hard blocks, data completeness, formal ranges, or formula version. Provider raw payload is therefore more detailed than the engine explanation, while candidate metadata can be overwritten by later operations. Historical rows are not reliably distinguishable by scoring behavior beyond the optional metadata string.

## Architectural decisions and open questions

The following decisions should govern the next focused changes:

1. Run expiration before generation. This removes stale active rows before duplicate suppression and gives one deterministic lifecycle boundary per run.
2. Move expiration into a dedicated bounded service and keep the existing admin route as a compatibility adapter. Add the signal-key route without alternate auth.
3. Add a run model with summarized JSON stages; do not store raw candidate arrays, request headers, provider payloads, or stack traces. Treat an old `RUNNING` row as effectively abandoned at read time after a documented timeout, with no new worker.
4. Treat market evaluation through handoff preparation as the decision pipeline. Slack delivery failure should make a completed attempt `PARTIAL`, not erase successful market work.
5. Preserve `riskScore` in storage/API for compatibility but define it as setup quality everywhere user-facing. A broad rename is not justified in this branch.
6. Add nullable scoring version/input/explanation fields to price checks. Existing rows remain legacy/unversioned; do not rescore them.
7. Defer true time-of-day RVOL unless the Massive historical-intraday request and caching cost prove small during implementation. V2 must otherwise name the metric `volumeIntensity` and keep `relativeVolume` null.
8. Separate market decision from operational eligibility. Subscription and strategy status may govern provider work and handoff delivery, but must not be encoded as a market hard block.

One product-level uncertainty remains before scoring implementation: whether research-only candidates are allowed to consume Massive price calls. The goal says observations should drive state independently of trade eligibility, which suggests removing subscription/strategy checks from market confirmation while retaining universe and price-scanning controls. That changes provider-call volume and should be confirmed before the scoring behavior commit.

## Proposed focused commit sequence

1. `docs(momentum): audit pipeline lifecycle and scoring`
2. `feat(database): add momentum pipeline runs and scoring versions`
3. `feat(momentum): add first-class stale candidate expiration`
4. `feat(momentum): add pipeline run tracking APIs`
5. `feat(momentum): version and explain confirmation scoring`
6. `feat(momentum): formalize price volume and setup scoring`
7. `feat(momentum): separate market decisions from operational eligibility`
8. `feat(web): show momentum pipeline run observability`
9. `feat(web): show versioned momentum decisions`
10. `docs(momentum): document pipeline and n8n integration`

Schema migration and scoring behavior remain separate. Every step requires focused validation and review before commit.
