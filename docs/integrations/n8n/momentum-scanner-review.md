# Momentum Scanner Review Workflow

The Momentum Scanner Review workflow is the n8n side of the review-only momentum scanner pipeline.

It runs the backend scanner pipeline, pulls currently valid pending handoffs, sends Slack review messages, and marks successfully delivered handoffs as `SENT`.

It does not create signals, orders, broker activity, Alpaca calls, or automatic buys.

## 🎯 Purpose

The workflow exists to surface potential momentum candidates in Slack for human review.

It bridges:

```text
Backend Momentum Scanner -> n8n -> Slack review alert -> backend handoff status update
```

## 🧾 Workflow Name

```text
AI Trader - Momentum Scanner Review
```

## 🛡️ Safety Boundaries

The workflow is review-only.

It must not call:

```text
/api/signals/entry
/api/orders
/api/order-intents
/api/broker-activity mutation routes
Alpaca endpoints
```

It must not:

- create entry signals
- create order intents
- submit broker orders
- change trading settings
- enable trading
- buy or sell anything

Slack messages should clearly state that alerts are review-only.

## 🔐 Authentication

The workflow uses signal automation auth, not admin auth.

Every backend HTTP node should send:

```http
signal-key: <AI_TRADER_SIGNAL_API_KEY>
```

Do not use admin session cookies or admin API keys in n8n.

## 🕘 Schedule

Use the stock market clock, not the operator's local timezone.

Set n8n scheduling to:

```text
America/New_York
```

Recommended weekday cron rules:

```cron
0 45 9 * * 1-5
0 */15 10-15 * * 1-5
```

This runs:

```text
9:45 AM ET
10:00 AM ET
10:15 AM ET
...
3:30 PM ET
3:45 PM ET
Monday-Friday
```

This avoids the first 15 minutes after the regular market open and avoids running at or after the regular close.

Accordingly, the documented production workflow is intended for regular hours
only, not premarket or after hours. The backend nevertheless classifies all New
York sessions safely; this hotfix does not modify the hosted n8n schedule.

This schedule does not account for market holidays or early closes. Add a market-calendar gate later if the workflow becomes noisy on non-trading days.

## ⚙️ Config Node

Recommended config fields:

```js
return [
  {
    json: {
      apiBaseUrl: $env.AI_TRADER_API_BASE_URL,
      signalKey: $env.AI_TRADER_SIGNAL_API_KEY,

      minCatalystScore: 60,
      take: 20,
      expiresInHours: 24,

      confirmMaxCandidates: 20,

      maxHandoffs: 20,
      minHandoffScore: 60,
      maxSlackAlertsPerRun: 3,

      slackChannel: $env.AI_TRADER_SLACK_CHANNEL || 'n8n-trading-bot',
      reviewOnly: true,
    },
  },
];
```

Use `signalKey`, not `adminToken`, so the workflow clearly reflects the auth boundary.

## Recommended backend-orchestrated sequence

New workflows should use the shared backend orchestrator for the five core stages:

```text
Manual Trigger / Schedule Trigger
  -> Config
  -> Run Full Momentum Pipeline
  -> Full Run Succeeded Or Partial?
  -> Get Pending Handoffs
  -> Extract Pending Handoffs
  -> Format Slack Message
  -> Send Slack Review Message
  -> Mark Handoff Sent or Failed
```

Add `Run Full Momentum Pipeline` after `Config`:

```http
POST /api/signals/momentum-scanner/run
signal-key: ={{ $('Config').first().json.signalKey }}
Content-Type: application/json
```

JSON body:

```js
={{ {
  source: $('Config').first().json.runSource,
  metadata: {
    workflowName: $('Config').first().json.workflowName,
    executionId: $('Config').first().json.executionId,
    executionMode: $execution.mode,
  },
  minCatalystScore: $('Config').first().json.minCatalystScore,
  candidateTake: $('Config').first().json.take,
  expiresInHours: $('Config').first().json.expiresInHours,
  maxCandidates: $('Config').first().json.confirmMaxCandidates,
  minHandoffScore: $('Config').first().json.minHandoffScore,
} }}
```

The response contains `runId`, `status`, and bounded stage summaries. `SUCCEEDED` means all five core stages completed cleanly. `PARTIAL` means all core stages completed but recoverable item-level failures occurred, such as failed news symbols or price-confirmation errors. `FAILED` contains `failedStage`, `errorCode`, and a safe `errorMessage`; stop before delivery or route to an operator alert.

The backend full run completes before Slack delivery and records `deliveryIncluded: false`. Slack delivery and mark-sent/failed calls remain standalone n8n work and cannot change the completed core-run status. If delivery must be represented inside the same run, retain the explicit-stage workflow below.

Do not also call Start Run, individual core stage routes, or Complete Run in the backend-orchestrated path. That would create duplicate work and more than one run record.

## Advanced explicit-stage sequence

The older explicit-stage workflow remains supported when n8n must own every stage, including delivery.

Explicit sequence:

```text
Manual Trigger / Schedule Trigger
  -> Config
  -> Start Pipeline Run
  -> Run Massive News Worker
  -> Record News Stage
  -> Expire Candidates
  -> Record Expiration Stage
  -> Generate Momentum Candidates
  -> Record Candidate Stage
  -> Confirm Candidate Prices
  -> Record Price Stage
  -> Prepare Scanner Handoffs
  -> Record Handoff Stage
  -> Get Pending Handoffs
  -> Extract Pending Handoffs
  -> Format Slack Message
  -> Send Slack Review Message
  -> Slack Send Succeeded?
      true  -> Mark Handoff Sent
      false -> Mark Handoff Failed
  -> Record Delivery Stage
  -> Complete Pipeline Run

Every stage node's error output must lead to `Record Pipeline Failure`. Do not rely only on an n8n error workflow because a separate error execution cannot reliably read the run ID created inside the failed execution.
```

## Pipeline run context

### Config additions

Add these fields to the existing `Config` Code node:

```js
workflowName: 'AI Trader - Momentum Scanner Review',
executionId: $execution.id,
runSource: $execution.mode === 'manual' ? 'N8N_MANUAL' : 'N8N_SCHEDULED',
```

### Start Pipeline Run

Add an HTTP Request node immediately after `Config`:

```http
POST /api/signals/momentum-scanner/runs
signal-key: ={{ $('Config').first().json.signalKey }}
Content-Type: application/json
```

JSON body:

```js
={{ {
  source: $('Config').first().json.runSource,
  metadata: {
    workflowName: $('Config').first().json.workflowName,
    executionId: $('Config').first().json.executionId,
    executionMode: $execution.mode,
  },
} }}
```

The response contains `runId`. All later run-recording nodes must use this named expression:

```js
{{ $('Start Pipeline Run').first().json.runId }}
```

This is execution-scoped data and does not depend on input item positions. Do not use workflow static data, which can leak a run ID across overlapping executions.

Set `Retry On Fail` off for start-run creation. Retrying this POST could create two run rows. If start creation fails, stop the workflow; there is no run ID to mark failed.

## Stage recording nodes

For every backend stage, add an HTTP Request node immediately after its success output. Use:

```http
PATCH /api/signals/momentum-scanner/runs/{{runId}}/stages/{{stage}}
signal-key: ={{ $('Config').first().json.signalKey }}
Content-Type: application/json
```

The exact nodes and bodies are below. Expressions reference nodes by name so inserting or reordering nodes does not change the contract.

### Record News Stage

URL stage: `NEWS`

```js
={{ {
  status: 'SUCCEEDED',
  result: {
    skipped: $('Run Massive News Worker').first().json.result?.skipped ?? false,
    reason: $('Run Massive News Worker').first().json.result?.reason ?? null,
    dueCursorCount: $('Run Massive News Worker').first().json.result?.dueCursorCount ?? 0,
    pulledSymbols: $('Run Massive News Worker').first().json.result?.pulledSymbols ?? 0,
    successfulSymbols: $('Run Massive News Worker').first().json.result?.successfulSymbols ?? 0,
    failedSymbols: $('Run Massive News Worker').first().json.result?.failedSymbols ?? 0,
    processedArticles: $('Run Massive News Worker').first().json.result?.processedArticles ?? 0,
    upsertedEvents: $('Run Massive News Worker').first().json.result?.upsertedEvents ?? 0,
    upsertedTickerImpacts: $('Run Massive News Worker').first().json.result?.upsertedTickerImpacts ?? 0,
  },
} }}
```

### Expire Candidates

Insert this backend stage before candidate generation:

```http
POST /api/signals/momentum-scanner/expire-candidates
```

Body:

```json
{
  "limit": 500
}
```

### Record Expiration Stage

URL stage: `EXPIRATION`

```js
={{ {
  status: 'SUCCEEDED',
  result: {
    inspected: $('Expire Candidates').first().json.inspected,
    expired: $('Expire Candidates').first().json.expired,
    unchanged: $('Expire Candidates').first().json.unchanged,
    skipped: $('Expire Candidates').first().json.skipped,
    staleRemaining: $('Expire Candidates').first().json.staleRemaining,
    reasonCounts: $('Expire Candidates').first().json.reasonCounts,
  },
} }}
```

If `staleRemaining` is nonzero because the inspection bound was reached, do not report a successful complete run. Route to `Record Pipeline Failure` with stage `EXPIRATION` and code `STALE_CANDIDATES_REMAIN`.

### Record Candidate Stage

URL stage: `CANDIDATE_GENERATION`

```js
={{ {
  status: 'SUCCEEDED',
  result: {
    impactsEvaluated: $('Generate Momentum Candidates').first().json.evaluatedImpacts,
    created: $('Generate Momentum Candidates').first().json.generatedCandidates,
    skipped: $('Generate Momentum Candidates').first().json.skippedCandidates,
    skipCounts: $('Generate Momentum Candidates').first().json.skipCounts,
  },
} }}
```

### Record Price Stage

URL stage: `PRICE_CONFIRMATION`

```js
={{ {
  status: 'SUCCEEDED',
  result: {
    evaluated: $('Confirm Candidate Prices').first().json.evaluated,
    watching: $('Confirm Candidate Prices').first().json.watching,
    entryReady: $('Confirm Candidate Prices').first().json.entryReady,
    blocked: $('Confirm Candidate Prices').first().json.blocked,
    skipped: $('Confirm Candidate Prices').first().json.skipped,
    skipCounts: $('Confirm Candidate Prices').first().json.skipCounts,
    errors: ($('Confirm Candidate Prices').first().json.errors || []).slice(0, 20),
  },
} }}
```

If the response has nonempty `errors`, route to pipeline failure instead of silently recording success.

### Record Handoff Stage

URL stage: `HANDOFF_PREPARATION`

```js
={{ {
  status: 'SUCCEEDED',
  result: {
    prepared: $('Prepare Scanner Handoffs').first().json.prepared,
    skipped: $('Prepare Scanner Handoffs').first().json.skipped,
    skipCounts: $('Prepare Scanner Handoffs').first().json.skipCounts,
  },
} }}
```

Do not send complete candidate or handoff arrays to stage records.

### Record Delivery Stage

After all selected handoffs have reached either `Mark Handoff Sent` or `Mark Handoff Failed`, aggregate delivery counts in a Code node named `Summarize Delivery` and record stage `HANDOFF_DELIVERY`:

```js
={{ {
  status: $('Summarize Delivery').first().json.failed > 0 ? 'FAILED' : 'SUCCEEDED',
  result: {
    attempted: $('Summarize Delivery').first().json.attempted,
    sent: $('Summarize Delivery').first().json.sent,
    failed: $('Summarize Delivery').first().json.failed,
  },
} }}
```

An empty pending queue is a successful delivery stage with all counts zero.

## Complete Pipeline Run

Add an HTTP Request node after delivery aggregation:

```http
POST /api/signals/momentum-scanner/runs/{{ $('Start Pipeline Run').first().json.runId }}/complete
```

Body:

```js
={{ {
  status: $('Summarize Delivery').first().json.failed > 0 ? 'PARTIAL' : 'SUCCEEDED',
} }}
```

The backend rejects successful completion until news, expiration, candidate generation, price confirmation, and handoff preparation summaries exist. Slack failure therefore produces `PARTIAL`; it does not erase successful market evaluation.

## Failure branches

For `Run Massive News Worker`, `Expire Candidates`, `Generate Momentum Candidates`, `Confirm Candidate Prices`, `Prepare Scanner Handoffs`, `Get Pending Handoffs`, Slack, and every mark/record request:

1. Set `On Error` to `Continue (using error output)`.
2. Connect the normal output to the next success node.
3. Connect the error output to a Set node that emits `stage`, `errorCode`, and `errorMessage`.
4. Connect that Set node to the single `Record Pipeline Failure` HTTP node.

`Record Pipeline Failure`:

```http
POST /api/signals/momentum-scanner/runs/{{ $('Start Pipeline Run').first().json.runId }}/fail
```

```js
={{ {
  stage: $json.stage,
  errorCode: $json.errorCode || 'N8N_STAGE_ERROR',
  errorMessage: String($json.errorMessage || 'Momentum scanner stage failed').slice(0, 1000),
} }}
```

Use these stage values: `NEWS`, `EXPIRATION`, `CANDIDATE_GENERATION`, `PRICE_CONFIRMATION`, `HANDOFF_PREPARATION`, or `HANDOFF_DELIVERY`. Never pass headers, credentials, provider payloads, response stacks, or the complete n8n error object.

After `Record Pipeline Failure`, terminate that execution branch. Do not continue to candidate generation, delivery, or completion.

An optional workflow-level Error Trigger may still notify operators about infrastructure failures. It is not the authoritative pipeline failure writer because it cannot safely assume access to `Start Pipeline Run` output from another execution.

## 🌐 Backend Nodes

### Run Massive News Worker

```http
POST /api/signals/momentum-scanner/run-news-worker
```

Body:

```json
{}
```

Purpose:

- runs one Massive news worker cycle
- pulls due source + symbol cursors
- ingests new catalyst events and ticker impacts

### Generate Momentum Candidates

```http
POST /api/signals/momentum-scanner/generate-candidates
```

Body:

```json
{
  "minCatalystScore": 60,
  "take": 20,
  "expiresInHours": 24
}
```

Purpose:

- generates or refreshes momentum candidates from eligible catalyst impacts
- does not call price APIs
- does not create handoffs

### Confirm Candidate Prices

```http
POST /api/signals/momentum-scanner/confirm-prices
```

Body:

```json
{
  "maxCandidates": 20
}
```

Purpose:

- evaluates active candidates with Massive price and aggregate data
- writes price-check history
- updates candidate state and latest scores

### Prepare Scanner Handoffs

```http
POST /api/signals/momentum-scanner/prepare-handoffs
```

Body:

```json
{
  "maxCandidates": 20,
  "minScore": 60
}
```

Purpose:

- creates queue records for eligible `ENTRY_READY` candidates
- cancels stale pending handoffs
- preserves idempotency for already prepared candidates

This node prepares/cancels queue records. It is not the definitive queue read for Slack delivery.

### Get Pending Handoffs

```http
GET /api/signals/momentum-scanner/handoffs?status=PENDING&take=20
```

Purpose:

- fetches the current valid pending queue for n8n
- cancels or excludes stale pending handoffs before returning rows
- should be the source for Slack messages

This is the queue-read step.

### Mark Handoff Sent

```http
POST /api/signals/momentum-scanner/handoffs/:id/mark-sent
```

Body:

```json
{
  "metadata": {
    "workflow": "AI Trader - Momentum Scanner Review",
    "delivery": "slack",
    "channel": "n8n-trading-bot"
  }
}
```

Purpose:

- marks a successfully delivered handoff as `SENT`
- sets `sentAt`
- increments `attempts`
- prevents duplicate sending on later runs

### Mark Handoff Failed

```http
POST /api/signals/momentum-scanner/handoffs/:id/mark-failed
```

Body:

```json
{
  "error": "Slack message failed in n8n Momentum Scanner Review workflow",
  "metadata": {
    "workflow": "AI Trader - Momentum Scanner Review",
    "delivery": "slack"
  }
}
```

Purpose:

- records delivery failure
- marks handoff `FAILED`
- stores a failure reason for review

## 📤 Extract Pending Handoffs Node

Use this node after `Get Pending Handoffs`.

Mode:

```text
Run Once for All Items
```

Code:

```js
const inputItems = $input.all();

let handoffs = [];

for (const item of inputItems) {
  const json = item.json || {};

  if (Array.isArray(json)) {
    handoffs.push(...json);
  } else if (Array.isArray(json.handoffs)) {
    handoffs.push(...json.handoffs);
  } else if (Array.isArray(json.results)) {
    handoffs.push(...json.results);
  } else if (Array.isArray(json.data)) {
    handoffs.push(...json.data);
  } else if (json.id && json.status) {
    handoffs.push(json);
  }
}

const pending = handoffs.filter((handoff) => {
  return handoff.status === 'PENDING';
});

const maxAlertsPerRun = Number($node['Config'].json.maxSlackAlertsPerRun || 3);

return pending.slice(0, maxAlertsPerRun).map((handoff) => {
  const payload = handoff.payload || {};

  return {
    json: {
      handoffId: handoff.id,
      idempotencyKey: handoff.idempotencyKey,
      symbol: handoff.symbol || payload?.candidate?.symbol,
      status: handoff.status,
      payload,
      handoff,
    },
  };
});
```

Why this shape is needed:

- `Get Pending Handoffs` may return one n8n item per handoff.
- It may not return a wrapper object like `{ handoffs: [...] }`.
- This extractor supports both shapes.

## 💬 Slack Message Guidance

Slack messages should include:

- symbol
- review status
- trading allowed: No
- total, catalyst, price, volume, and risk scores
- last price
- previous close
- percent from previous close
- VWAP status
- day volume
- dollar volume
- recent move
- catalyst title/source
- reason
- review-only warning

Example warning:

```text
⚠️ Review only. This workflow does not create signals, orders, or broker activity.
```

## 📬 Handoff Semantics

Use this mental model:

```text
Prepare handoffs
= create/cancel/update queue records

Get pending handoffs
= fetch the current valid queue n8n should send

Mark sent
= remove the delivered handoff from the pending queue
```

Status meanings:

- `PENDING`: queued for delivery, and still eligible if returned by the signal polling route
- `SENT`: Slack delivery succeeded
- `FAILED`: Slack/workflow delivery failed
- `CANCELLED`: candidate cooled off, expired, became blocked, or fell below threshold before delivery
- `ACKNOWLEDGED`: backend status exists but is not currently used by this Slack review workflow

A handoff payload is a snapshot. Candidate state can change later. The backend cancels stale pending handoffs before n8n receives them.

## ✅ Manual Validation Checklist

Before activation, run the workflow manually and confirm:

```text
Run Massive News Worker returns 200
Start Pipeline Run returns one runId
Record News Stage returns 200
Expire Candidates returns 200 and staleRemaining = 0
Record Expiration Stage returns 200
Generate Momentum Candidates returns 200
Record Candidate Stage returns 200
Confirm Candidate Prices returns 200
Record Price Stage returns 200
Prepare Scanner Handoffs returns 200
Record Handoff Stage returns 200
Get Pending Handoffs returns valid current PENDING rows
Slack sends review messages
Mark Handoff Sent returns 200
Record Delivery Stage returns 200
Complete Pipeline Run returns SUCCEEDED
Admin latest-run API shows the same runId and stage summaries
Admin UI shows SENT with sentAt and attempts = 1
Re-running does not resend SENT handoffs
Stale pending handoffs become CANCELLED
```

## 🧯 Troubleshooting

### 401: Admin API key or admin session token required

Cause:

The node is using an admin route by accident.

Wrong:

```text
/api/momentum-scanner/handoffs/:id/mark-sent
```

Correct:

```text
/api/signals/momentum-scanner/handoffs/:id/mark-sent
```

All n8n Momentum Scanner nodes should use:

```text
/api/signals/momentum-scanner/...
```

### 401: Missing or invalid API key

Check that the request header is:

```http
signal-key: <AI_TRADER_SIGNAL_API_KEY>
```

Do not use `ai-trader-api-key` for signal routes.

### Extract node returns no output

Common causes:

- `Get Pending Handoffs` returned individual handoff items instead of a wrapper object.
- The Code node is set to run once per item while returning an array.
- There are no currently valid pending handoffs.

Use `Run Once for All Items` and the extractor code above.

### Slack sends but handoff stays PENDING

Check the `Mark Handoff Sent` node URL.

It must use:

```text
/api/signals/momentum-scanner/handoffs/:id/mark-sent
```

not the admin route.

### Duplicate Slack alerts

Check:

- `Mark Handoff Sent` returns 200
- Admin UI shows `SENT`
- the next run reads from `Get Pending Handoffs`, not `Prepare Scanner Handoffs`
- `Get Pending Handoffs` is filtering `status=PENDING`

### Too many Slack messages

Lower:

```js
maxSlackAlertsPerRun
```

A conservative starting value is `3`.

## 🧭 Future Improvements

Potential future improvements:

- market holiday / early-close gate
- Slack thread grouping
- interactive approve/dismiss buttons
- candidate dismissal endpoint
- better source quality filters
- Benzinga or SEC/EDGAR ingestion
- richer alert formatting
- alert quality tracking

Keep the workflow review-only until the alert quality has been observed across multiple market sessions.
