# n8n Integration

This doc covers the shared n8n → AI Trader backend contract.

For the Momentum Scanner review workflow specifically, see:

- [Momentum Scanner Review Workflow](n8n/momentum-scanner-review.md)

## ✅ Current Integration Principles

n8n is an automation client, not an admin user.

n8n should:

- use signal-level authentication
- call only `/api/signals/...` routes unless a specific exception is intentionally designed
- avoid admin API keys and admin session cookies
- avoid direct broker or Alpaca calls
- avoid creating orders except through explicitly approved signal workflows

Admin routes remain admin-only.

## 🔐 Signal-Level API Access

Signal routes are mounted under:

```text
/api/signals
```

Signal routes require:

```http
signal-key: <AI_TRADER_SIGNAL_API_KEY>
```

Do not use `ai-trader-api-key` for signal routes.

Admin routes use admin auth and are separate from n8n signal automation routes.

## 🧪 Local Development Tunnel

During local development, the backend can be exposed to n8n through ngrok.

Required environment variables:

```env
NGROK_AUTHTOKEN=your_ngrok_authtoken_here
NGROK_DOMAIN=your_ngrok_dev_domain_here
```

Start the tunnel:

```bash
npm run dev:tunnel
```

A normal local development session often uses two terminals:

```bash
npm run dev
npm run dev:tunnel
```

The ngrok URL is then used by n8n as the backend base URL.

## 🚢 Production n8n Base URL

The hosted n8n workflow should use the production backend base URL:

```text
https://srv1700402.hstgr.cloud
```

n8n should use the signal API key only:

```http
signal-key: <AI_TRADER_SIGNAL_API_KEY>
```

n8n should not use the admin API key.

n8n should not talk directly to Alpaca.

## 📈 Lean ETF Watcher

The Lean ETF Watcher workflow sends review/decision context and, when enabled, entry signals to the backend signal route group.

Production dry-run settings should remain conservative while testing:

```text
DRY_RUN=true
FORCE_MARKET_OPEN_FOR_TESTING=false
```

Expected dry-run behavior:

```text
n8n gets ETF watch context from backend
n8n pulls ETF snapshots
n8n decision engine evaluates candidates
n8n posts diary events to backend
backend stores Market Diary events
Admin UI displays Market Diary results
no live order is submitted
```

Before enabling any real paper-order workflow, confirm the dry-run system has behaved correctly across multiple market sessions.

## ➡️ Signal API

### Entry Decision Snapshot

```http
POST /api/signals/entry-decisions
```

Records a durable snapshot for an ETF decision engine evaluation.

n8n should use this endpoint for meaningful decisions, including skipped or idle opportunities that should remain analyzable without creating an order.

The backend uses `decisionKey` for idempotency. Re-sending the same decision key returns the existing decision instead of creating a duplicate.

Repeated unchanged idle decisions may be accepted but skipped according to the backend persistence policy.

Admin/operator review is available through:

```http
GET /api/entry-decisions
GET /api/entry-decisions/:id
```

Example request:

```json
{
  "decisionKey": "n8n:etf-watch:spy_dip_core:2026-06-25T15:00Z",
  "evaluatedAt": "2026-06-25T15:00:00.000Z",
  "source": "n8n-ai-trader",
  "symbol": "SPY",
  "subscriptionKey": "spy_dip_core",
  "decisionState": "idle",
  "decisionReason": "above_dip_threshold",
  "signalEligible": false,
  "signalCreated": false,
  "signalBlocked": false,
  "currentPrice": 540.12,
  "previousClose": 542.5,
  "dipPercent": -0.44,
  "dipThresholdPercent": -1,
  "allowOrderSignals": true,
  "dryRun": true,
  "paperMode": true,
  "rawDecisionJson": {
    "engineVersion": "etf-watch-v1",
    "candidateRank": 1
  }
}
```

Example persisted response:

```json
{
  "ok": true,
  "decision": {
    "persisted": true,
    "skipped": false,
    "duplicate": false,
    "persistenceReason": "initial_state",
    "id": 101,
    "decisionKey": "n8n:etf-watch:spy_dip_core:2026-06-25T15:00Z"
  }
}
```

### Entry Signal

```http
POST /api/signals/entry
```

Primary endpoint for n8n-driven entry signals.

Instead of n8n sending full order instructions, it sends a subscription key and signal metadata. The backend resolves the subscription, validates the request, determines sizing, creates an order intent, and submits the order asynchronously.

Example request:

```json
{
  "subscriptionKey": "spy_dip_core",
  "decisionKey": "n8n:etf-watch:spy_dip_core:2026-06-25T15:00Z",
  "reason": "SPY dip signal triggered",
  "source": "n8n-ai-trader",
  "confidence": "high",
  "runId": "n8n-run-001",
  "metadata": {
    "macroRegime": "risk_on",
    "trigger": "dip_bounce"
  }
}
```

Example response:

```json
{
  "ok": true,
  "signal": {
    "subscriptionKey": "spy_dip_core",
    "signalType": "entry",
    "source": "n8n-ai-trader",
    "decisionKey": "n8n:etf-watch:spy_dip_core:2026-06-25T15:00Z"
  },
  "order": {
    "ok": true,
    "intentId": 25,
    "status": "pending",
    "entryDecisionKey": "n8n:etf-watch:spy_dip_core:2026-06-25T15:00Z"
  }
}
```

### ETF Watch Context

```http
GET /api/signals/etf-watch/context
```

Returns backend-owned ETF watch context for n8n decision logic.

### Market State

```http
GET /api/signals/market-state/current
POST /api/signals/market-state/current
```

Allows n8n to read and update current market-state context through signal-level authentication.

### Market Diary Events

```http
GET /api/signals/market-diary/events
POST /api/signals/market-diary/events
```

Allows n8n to persist market diary events without admin credentials.

### Open Positions

```http
GET /api/signals/tracked-positions/open
```

Returns active tracked positions through signal-level authentication.

## 🚀 Momentum Scanner Review Routes

The Momentum Scanner uses review-only signal automation routes:

```http
POST /api/signals/momentum-scanner/run-news-worker
POST /api/signals/momentum-scanner/generate-candidates
POST /api/signals/momentum-scanner/confirm-prices
POST /api/signals/momentum-scanner/prepare-handoffs
GET /api/signals/momentum-scanner/handoffs
POST /api/signals/momentum-scanner/handoffs/:id/mark-sent
POST /api/signals/momentum-scanner/handoffs/:id/mark-failed
```

These routes are not entry-signal routes. They support the review-only Slack workflow and must not create orders or broker activity.

See the dedicated workflow doc:

- [Momentum Scanner Review Workflow](n8n/momentum-scanner-review.md)
