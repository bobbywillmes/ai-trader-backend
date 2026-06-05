# n8n Integration

This doc covers how n8n connects to the AI Trader backend — the proof-of-concept workflow that was tested, how to expose the local backend to n8n via ngrok during development, and how the production n8n workflow is configured for dry-run operation.

---

## ✔️ Proof of Concept

The backend has been successfully tested with a small n8n proof-of-concept workflow that sends trading signals into the Node API and reads current open positions back from the backend.

This confirms that n8n can communicate with the local development backend through a public ngrok tunnel, using signal-level authentication that will later be used in production.

### What Was Tested

The proof-of-concept workflow includes:

1. Manual trigger node
2. Setup node storing backend URL and API key
3. Code node building a sample entry signal payload
4. HTTP Request node sending the signal to `POST /api/signals/entry`
5. Response parser node normalizing success/failure responses
6. HTTP Request node reading open tracked positions from `GET /api/tracked-positions/open`
7. Response parser node for open position results

### Local Development Tunnel

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

### Signal-Level API Access

The n8n workflow uses the signal-level API key. This allows n8n to perform only signal/client-level actions, such as sending entry signals and reading current open positions.

Admin-level actions remain protected and are not exposed to the n8n signal workflow.

---

## 🏭 Production n8n Workflow

The hosted n8n workflow should use the production backend base URL:

```
https://srv1700402.hstgr.cloud
```

n8n should use the signal API key only:

```
ai-trader-api-key: AI_TRADER_SIGNAL_API_KEY
```

n8n should not use the admin API key.

n8n should not talk directly to Alpaca.

The lean ETF watcher production dry-run should remain configured as:

```
DRY_RUN=true
FORCE_MARKET_OPEN_FOR_TESTING=false
```

Expected dry-run behavior:

```
n8n gets ETF watch context from backend
n8n pulls ETF snapshots
n8n decision engine evaluates candidates
n8n posts diary events to backend
backend stores Market Diary events
admin UI displays Market Diary results
no live order is submitted
```

Before enabling any real paper-order workflow, confirm the dry-run system has behaved correctly across multiple market sessions.

---

## ➡️ Signal API

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
    "source": "n8n-ai-trader"
  },
  "order": {
    "ok": true,
    "intentId": 25,
    "status": "pending"
  }
}
```

### Open Positions

```http
GET /api/tracked-positions/open
```

Returns active tracked positions. Accessible with the signal API key.
