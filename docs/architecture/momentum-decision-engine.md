# Momentum Decision Engine and Pipeline Observability

This document describes the versioned, review-only Momentum Scanner implemented on `feat/momentum-decision-engine`. The pre-change findings remain in [Momentum Decision Engine Audit](momentum-decision-engine-audit.md).

## Pipeline lifecycle

The backend-orchestrated core sequence is:

```text
Create pipeline run
-> Run news worker
-> Expire stale candidates
-> Generate candidates
-> Confirm prices
-> Prepare handoffs
-> Complete pipeline run
```

`POST /api/signals/momentum-scanner/run` and owner-only `POST /api/momentum-scanner/pipeline/run` call the same orchestrator with `N8N_*` and `ADMIN_MANUAL` sources respectively. Recoverable item-level failures complete the core run as `PARTIAL`; thrown stage failures record the failed stage and finish `FAILED`. Backend orchestration ends at handoff preparation. n8n review delivery remains post-run unless n8n uses the supported explicit start/stage/complete contract.

Standalone stage routes and UI buttons do not create run records. They are diagnostic controls, not full pipeline executions.

Expiration runs before generation so stale active rows cannot suppress a replacement candidate. It examines a bounded active set, expires candidates at the inclusive `expiresAt <= asOf` boundary, preserves all related history, and is idempotent. `activeCandidates` are candidates in active enum states; `staleCandidatesAwaitingExpiration` are active candidates already past `expiresAt`; historical `EXPIRED` rows are not active problems. A successful workflow should normally leave `staleCandidatesAwaitingExpiration` at zero; a positive `staleRemaining` means the bounded stage should run again or its operational limit should be reviewed.

## Durable runs

`MomentumPipelineRun` represents the full workflow rather than an inferred activity timestamp. It stores source, status, timestamps, current/error stage, safe failure fields, and bounded JSON summaries for news, expiration, candidate generation, price confirmation, handoff preparation, and delivery.

Statuses mean:

- `RUNNING`: started within the last 30 minutes and not completed.
- `SUCCEEDED`: every required market-evaluation stage completed.
- `PARTIAL`: required stages completed but a non-core delivery outcome failed or was incomplete.
- `FAILED`: the decision pipeline failed at a recorded stage.
- `ABANDONED`: a `RUNNING` row is more than 30 minutes old. This is a read-time interpretation and needs no cleanup worker.

Overview displays the latest attempted run. Scanner Pipeline separately displays the current run, latest attempt, latest successful run, recent history, and stage summaries. Timestamps are labeled in New York time. Individually clicked manual controls do not create a false full-run record.

## Versioned confirmation model

New checks use `momentum_confirmation_v5`. Every check stores `scoringVersion`, the inputs that actually existed, component scores, formal ranges, reasons, hard blocks, data completeness, and the final decision. Historical null versions remain `Legacy / unversioned`; no historical rows are rescored.

Score direction is consistent:

- higher catalyst score means stronger catalyst relevance (formal maximum 90);
- higher price-action score means stronger price confirmation (0-100);
- higher volume score means stronger volume confirmation (0-100; current attainable maximum 90);
- higher setup-quality score means a cleaner market setup (0-100).

Setup quality remains stored in `riskScore` for compatibility. It is not account risk and never evaluates buying power, allocations, reservations, subscriptions, or central risk-gate decisions.

The candidate total is:

```text
round(catalyst * 0.45 + priceAction * 0.30 + volume * 0.20 + setupQuality * 0.05)
```

Its formal maximum is 96 because catalyst has a maximum of 90. The pure decision layer clamps component inputs, deduplicates hard blocks, requires complete observations for `ENTRY_READY`, maps incomplete current observations to `WATCHING`, maps market hard blocks to `ENTRY_BLOCKED`, and preserves `EXPIRED` and `DISMISSED` terminal states. The decision is stable (`WATCHING`, `ENTRY_READY`, `ENTRY_BLOCKED`, `EXPIRED`, or `DISMISSED`); specific causes remain in `hardBlocks` and `blockedReason`.

Price scoring rewards orderly positive continuation above VWAP and near the intraday high, and separately records deductions and hard blocks for missing, stale, faded, negative, or excessively extended observations.

Volume scoring uses the honestly named `VOLUME_INTENSITY_V1`: recent-window volume divided by cumulative day volume, combined with day/recent volume and dollar liquidity. `relativeVolume` remains null because no historical time-of-day baseline is implemented. True RVOL is explicitly deferred; it must not be displayed or scored as though available.

## Market decision versus eligibility

Candidate state is a stored market decision. Research, subscription, price-confirmation, and handoff eligibility are separate operational concepts. Disabling a subscription does not rewrite an existing `ENTRY_READY` market decision. Account risk remains owned by the central risk gate and is outside this research pipeline.

Research APIs expose `evaluated: false` and nullable price, volume, and setup scores when no price check exists. A genuine evaluated zero remains numeric zero. The UI renders the former as `Not evaluated`.

## Deployment and smoke test

The production-safe migration adds nullable scoring fields and the run table/enums without rewriting historical decisions. Deployment order:

1. Back up the production database.
2. Pull the completed commit on the production host.
3. Run the production Prisma migration before starting code that writes pipeline runs.
4. Regenerate/build through the normal production container flow.
5. Update the hosted n8n workflow using [Momentum Scanner Review Workflow](../integrations/n8n/momentum-scanner-review.md).
6. Verify health, owner-only run APIs, and the web UI.

Smoke-test a review-only workflow twice. Confirm one run ID is reused across its stages, expiration precedes generation, the second run is idempotent, latest attempt and latest success are distinct when appropriate, new checks show v5 explanations, and no signal, order intent, broker activity, or Alpaca submission is created.

## Deferred scope

True time-of-day RVOL, hosted n8n mutation by Codex, historical rescoring, orders, broker submissions, account-risk changes, candidate outcome analytics, and automated parameter optimization remain deferred.
