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

## 🔁 Node Sequence

Recommended sequence:

```text
Manual Trigger / Schedule Trigger
  -> Config
  -> Run Massive News Worker
  -> Generate Momentum Candidates
  -> Confirm Candidate Prices
  -> Prepare Scanner Handoffs
  -> Get Pending Handoffs
  -> Extract Pending Handoffs
  -> Format Slack Message
  -> Send Slack Review Message
  -> Slack Send Succeeded?
      true  -> Mark Handoff Sent
      false -> Mark Handoff Failed
```

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
Generate Momentum Candidates returns 200
Confirm Candidate Prices returns 200
Prepare Scanner Handoffs returns 200
Get Pending Handoffs returns valid current PENDING rows
Slack sends review messages
Mark Handoff Sent returns 200
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
