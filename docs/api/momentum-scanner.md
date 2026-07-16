# Momentum Scanner API

All endpoints are review-only. Signal routes require only the configured `signal-key`; Admin routes require system-owner access. Do not send API keys, headers, stack traces, or raw provider responses in pipeline result summaries.

## Workflow routes

```text
POST  /api/signals/momentum-scanner/run
POST  /api/signals/momentum-scanner/runs
PATCH /api/signals/momentum-scanner/runs/:runId/stages/:stage
POST  /api/signals/momentum-scanner/runs/:runId/complete
POST  /api/signals/momentum-scanner/runs/:runId/fail
POST  /api/signals/momentum-scanner/run-news-worker
POST  /api/signals/momentum-scanner/expire-candidates
POST  /api/signals/momentum-scanner/generate-candidates
POST  /api/signals/momentum-scanner/confirm-prices
POST  /api/signals/momentum-scanner/prepare-handoffs
GET   /api/signals/momentum-scanner/handoffs
POST  /api/signals/momentum-scanner/handoffs/:id/mark-sent
POST  /api/signals/momentum-scanner/handoffs/:id/mark-failed
```

`POST /api/signals/momentum-scanner/run` executes the five core stages through handoff preparation and creates exactly one durable run with source `N8N_SCHEDULED` or `N8N_MANUAL`. Recoverable per-item failures produce `PARTIAL`; a thrown stage failure produces a durable `FAILED` result with the failed stage and safe error. Slack delivery is not included.

The owner-authenticated equivalent is:

```text
POST /api/momentum-scanner/pipeline/run
```

It uses the same orchestrator with source fixed to `ADMIN_MANUAL`. Standalone stage routes execute only their named stage and do not create, update, or complete a pipeline run.

Start accepts `source` (`N8N_SCHEDULED`, `N8N_MANUAL`, or `ADMIN_MANUAL`) and optional bounded metadata. Stage names are `NEWS`, `EXPIRATION`, `CANDIDATE_GENERATION`, `PRICE_CONFIRMATION`, `HANDOFF_PREPARATION`, and `HANDOFF_DELIVERY`. A stage update accepts `status: SUCCEEDED | FAILED` and a bounded result summary. Completion requires the five decision stages through handoff preparation; delivery failure may complete as `PARTIAL`. Failure requires a stage, normalized error code, and safe message.

Expiration returns `inspected`, `expired`, `unchanged`, `skipped`, `staleRemaining`, bounded candidate IDs, truncation state, reason counts, and `asOf`.

## Owner read routes

```text
GET /api/momentum-scanner/research/pipeline-runs/latest
GET /api/momentum-scanner/research/pipeline-runs
GET /api/momentum-scanner/research/pipeline-runs/:runId
```

Latest returns `latestAttempt`, `latestSuccessful`, and a non-abandoned `currentRun`. List supports bounded `page`, `pageSize`, `status`, `source`, `from`, and `to` filters and sorts newest first. Run responses include effective status, duration, stage summaries, and safe errors.

Candidate research routes serialize each price check's nullable `scoringVersion`, `scoringInputs`, and `scoreExplanation`. Candidate rows include `evaluated`; price, volume, and risk/setup scores are null when unevaluated and retain numeric zero after a genuine zero-scoring evaluation.

The owner-only standalone expiration route is:

```text
POST /api/momentum-candidates/expire-stale
```

See [Momentum Scanner Review Workflow](../integrations/n8n/momentum-scanner-review.md) for exact n8n nodes, expressions, request bodies, connection changes, and failure routing.
