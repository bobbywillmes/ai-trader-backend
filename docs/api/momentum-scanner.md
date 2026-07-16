# Momentum Scanner API

All endpoints are review-only. Signal routes require only the configured `signal-key`; Admin routes require system-owner access. Do not send API keys, headers, stack traces, or raw provider responses in pipeline result summaries.

## Workflow routes

```text
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

The owner-only manual expiration compatibility route is:

```text
POST /api/momentum-candidates/expire-stale
```

See [Momentum Scanner Review Workflow](../integrations/n8n/momentum-scanner-review.md) for exact n8n nodes, expressions, request bodies, connection changes, and failure routing.
