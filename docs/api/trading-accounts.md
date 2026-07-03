# Trading Account Admin API

The trading account admin API is for backend admin clients only. It is not part
of the n8n signal contract.

All routes are mounted under:

```text
/api/trading-accounts
```

They require the normal admin auth path:

```text
AI_TRADER_ADMIN_API_KEY
or an admin session bearer token
```

## Safe Account Responses

Trading account responses include operational account fields and a credential
summary. They never include decrypted credentials or ciphertext columns.

Balance and exposure summary fields include:

```text
lastCash
lastBuyingPower
lastEquity
lastPortfolioValue
totalOpenPositionNotional
```

`totalOpenPositionNotional` is derived from open/closing tracked positions for
the trading account using the same market-value-with-cost-basis-fallback
exposure convention used by runtime risk checks.

Credential summary fields:

```text
exists
status
authType
keyFingerprint
verifiedAt
lastUsedAt
lastFailedAt
revokedAt
```

## Read Accounts

List accounts:

```http
GET /api/trading-accounts
```

Read one account:

```http
GET /api/trading-accounts/:id
```

## Update Safe Account Fields

```http
PATCH /api/trading-accounts/:id
```

Allowed fields:

```text
displayName
estimatedTradingCapital
status
tradingEnabled
killSwitchEnabled
pausedReason
notes
```

Identity fields such as `broker` and `environment` are intentionally rejected
by this generic update endpoint.

## Manage Account Risk Settings

Account risk settings are per-`TradingAccount` entry caps. Global Settings still
act as backend-wide emergency caps. Allocation bucket limits are configured
separately and enforced for assigned new entries after account caps pass.

Read account risk settings:

```http
GET /api/trading-accounts/:id/risk-settings
```

If the account exists and no risk settings row exists yet, the backend creates a
default row with `enabled=true` and null caps.

Response envelope:

```json
{
  "riskSettings": {
    "id": 1,
    "tradingAccountId": 1,
    "enabled": true,
    "maxDailyEntryOrders": 5,
    "maxDailyEntryNotional": 10000,
    "maxOpenPositions": 5,
    "maxTotalOpenNotional": 25000,
    "maxSymbolOpenNotional": 5000,
    "maxSubscriptionOpenNotional": 5000,
    "notes": null,
    "createdAt": "2026-07-02T00:00:00.000Z",
    "updatedAt": "2026-07-02T00:00:00.000Z"
  }
}
```

Update account risk settings:

```http
PATCH /api/trading-accounts/:id/risk-settings
```

Allowed update fields:

```text
enabled
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
maxSubscriptionOpenNotional
notes
```

Validation:

```text
enabled must be boolean
count limits must be positive integers or null
notional limits must be positive numbers or null
notes may be string or null
```

`enabled=false` skips only account-specific risk caps. Global emergency caps
still apply.

## Preview Entry Risk

Entry risk preview is an admin-only dry-run endpoint for checking account
subscription sizing and risk decisions without creating trading records or
submitting broker orders. It is intended for diagnostics and off-hours risk
tuning.

```http
POST /api/trading-accounts/:id/entry-risk-preview
```

Payload:

```json
{
  "subscriptionKey": "dia_dip_core"
}
```

Optional payload:

```json
{
  "subscriptionKey": "dia_dip_core",
  "ignoreSession": true
}
```

`ignoreSession` defaults to `true`. When true, market/session timing does not
block the preview result. The endpoint may still return session state as
informational context so admins can see whether a real entry would be blocked
right now by market closed, opening buffer, pre-close cutoff, or unavailable
session data.

The endpoint resolves:

```text
TradingAccount
-> Subscription by subscriptionKey
-> TradingAccountSubscription
-> runtime account-subscription sizing
-> centralized risk gate
```

It returns `ok=false` with sizing/risk details when a layer would block. It
does not create or mutate:

```text
OrderIntent
BrokerOrder
TrackedPosition
EntryDecision
SystemEvent
```

It also never submits to Alpaca.

Response envelope:

```json
{
  "preview": {
    "ok": false,
    "wouldSubmitIfSessionAllowed": false,
    "tradingAccount": {
      "id": 1,
      "displayName": "Bobby Paper",
      "broker": "ALPACA",
      "environment": "PAPER",
      "status": "ACTIVE"
    },
    "subscription": {
      "id": 10,
      "key": "dia_dip_core",
      "symbol": "DIA",
      "enabled": true
    },
    "accountSubscription": {
      "id": 20,
      "enabled": true,
      "entriesEnabled": true,
      "exitsEnabled": true,
      "allocationId": 7,
      "sizingType": "MAX_NOTIONAL"
    },
    "allocation": {
      "id": 7,
      "key": "core_etf",
      "name": "Core ETF",
      "enabled": true,
      "maxAllocatedNotional": 10000,
      "maxOpenPositions": 3,
      "maxPositionNotional": 2000
    },
    "sizing": {
      "ok": true,
      "code": null,
      "sizingType": "MAX_NOTIONAL",
      "fixedQty": null,
      "maxPositionNotional": 1500,
      "minPositionNotional": null,
      "maxQty": null,
      "latestPrice": 475,
      "latestPriceAt": "2026-07-02T20:00:00.000Z",
      "latestPriceSource": "lastTrade",
      "calculatedQty": 3,
      "estimatedNotional": 1425
    },
    "risk": {
      "ok": false,
      "code": "allocation_max_open_positions_exceeded",
      "layer": "allocation",
      "message": "Allocation maximum open position limit reached.",
      "details": {}
    },
    "session": {
      "checked": true,
      "marketOpen": false,
      "entryWindowOpen": false,
      "wouldBlockRealEntryNow": true,
      "code": "market_closed",
      "message": "Regular market is closed. New entries are blocked."
    },
    "wouldCreateOrderIntent": false,
    "wouldSubmitBrokerOrder": false
  }
}
```

## Manage Allocation Buckets

Allocation buckets group account-scoped subscription sizing limits. They are
admin configuration records for organizing account subscriptions. Runtime entry
sizing uses the account subscription row, and allocation bucket risk checks
apply to new entries assigned through `TradingAccountSubscription.allocationId`.

List allocations for one trading account:

```http
GET /api/trading-accounts/:id/allocations
```

Response envelope:

```json
{
  "allocations": [
    {
      "id": 1,
      "tradingAccountId": 1,
      "key": "momentum",
      "name": "Momentum",
      "description": null,
      "enabled": true,
      "maxAllocatedNotional": 10000,
      "maxOpenPositions": 4,
      "maxPositionNotional": 2500,
      "notes": null,
      "createdAt": "2026-06-30T00:00:00.000Z",
      "updatedAt": "2026-06-30T00:00:00.000Z",
      "accountSubscriptionCount": 2
    }
  ]
}
```

Create an allocation:

```http
POST /api/trading-accounts/:id/allocations
```

Payload:

```json
{
  "key": "momentum",
  "name": "Momentum",
  "description": "Momentum strategy allocation bucket",
  "enabled": true,
  "maxAllocatedNotional": 10000,
  "maxOpenPositions": 4,
  "maxPositionNotional": 2500,
  "notes": null
}
```

Update an allocation:

```http
PATCH /api/trading-accounts/:id/allocations/:allocationId
```

Allowed update fields:

```text
key
name
description
enabled
maxAllocatedNotional
maxOpenPositions
maxPositionNotional
notes
```

Allocation keys are trimmed, lowercased, and must contain only letters,
numbers, hyphens, and underscores. Duplicate keys within the same trading
account return `409`.

Use `enabled=false` to disable an allocation. Hard delete is intentionally not
available.

Runtime allocation enforcement:

```text
Global emergency caps apply first.
TradingAccountRiskSettings account caps apply next.
TradingAccountAllocation caps apply for assigned account subscriptions.
TradingAccountSubscription sizing and gates still control final entry
eligibility and quantity.
Unassigned account subscriptions skip allocation checks.
```

Allocation block rules:

```text
allocation_disabled
allocation_max_position_notional_exceeded
allocation_max_open_positions_exceeded
allocation_max_allocated_notional_exceeded
```

`maxPositionNotional` caps the estimated notional of the new position.
`maxOpenPositions` counts open/closing tracked positions assigned to account
subscriptions in the same allocation. `maxAllocatedNotional` projects open
tracked-position exposure plus pending/submitted/filled entry order intent
exposure for the allocation plus the new order's estimated notional.

## Manage Account Subscriptions

Account subscriptions attach a trading account to an existing legacy
`Subscription` and store account-specific sizing configuration. Runtime entry
order sizing now uses `TradingAccountSubscription` as the source of truth. The
legacy `Subscription.sizingType` / `Subscription.sizingValue` fields still
exist, but they are no longer the source of truth for new entry sizing. The n8n
signal request/response contract remains unchanged.

At entry signal time, the backend resolves:

```text
TradingAccount + Subscription
-> TradingAccountSubscription
-> enabled / entriesEnabled gates
-> sizingType / fixedQty / maxPositionNotional
-> backend-owned latest price when required
-> whole-share quantity
```

If the account subscription is missing or disabled for entries, the entry is
rejected before an `OrderIntent` is created. The backend does not fall back to
legacy `Subscription.sizingType` / `Subscription.sizingValue` for new entry
orders.

List account subscriptions:

```http
GET /api/trading-accounts/:id/account-subscriptions
```

Read one account subscription:

```http
GET /api/trading-accounts/:id/account-subscriptions/:accountSubscriptionId
```

Response envelope:

```json
{
  "accountSubscription": {
    "id": 1,
    "tradingAccountId": 1,
    "subscriptionId": 10,
    "allocationId": 1,
    "enabled": true,
    "entriesEnabled": true,
    "exitsEnabled": true,
    "sizingType": "FIXED_QTY",
    "fixedQty": 1,
    "maxPositionNotional": null,
    "minPositionNotional": null,
    "maxQty": null,
    "notes": null,
    "createdAt": "2026-06-30T00:00:00.000Z",
    "updatedAt": "2026-06-30T00:00:00.000Z",
    "subscription": {
      "id": 10,
      "key": "spy-swing",
      "symbol": "SPY",
      "enabled": true,
      "strategy": {
        "id": 2,
        "key": "swing",
        "name": "Swing"
      },
      "exitProfile": {
        "id": 3,
        "key": "standard",
        "name": "Standard"
      }
    },
    "allocation": {
      "id": 1,
      "key": "momentum",
      "name": "Momentum",
      "enabled": true
    }
  }
}
```

Create an account subscription:

```http
POST /api/trading-accounts/:id/account-subscriptions
```

Payload:

```json
{
  "subscriptionId": 10,
  "allocationId": 1,
  "enabled": true,
  "entriesEnabled": true,
  "exitsEnabled": true,
  "sizingType": "FIXED_QTY",
  "fixedQty": 1,
  "minPositionNotional": null,
  "maxQty": null,
  "notes": null
}
```

Update an account subscription:

```http
PATCH /api/trading-accounts/:id/account-subscriptions/:accountSubscriptionId
```

Allowed update fields:

```text
allocationId
enabled
entriesEnabled
exitsEnabled
sizingType
fixedQty
maxPositionNotional
minPositionNotional
maxQty
notes
```

The generic update endpoint does not allow changing `id`, `tradingAccountId`,
or `subscriptionId`.

Sizing validation:

```text
FIXED_QTY requires fixedQty > 0
MAX_NOTIONAL requires maxPositionNotional > 0
minPositionNotional must be >= 0 when present
maxQty must be > 0 when present
```

When switching `sizingType`, the opposite sizing field is normalized to `null`.
For example, switching to `FIXED_QTY` clears `maxPositionNotional`, and
switching to `MAX_NOTIONAL` clears `fixedQty`.

`allocationId`, when present, must belong to the same trading account.
Duplicate `tradingAccountId + subscriptionId` rows return `409`.

## Upsert Broker Credentials

```http
PUT /api/trading-accounts/:id/credentials
```

Payload:

```json
{
  "authType": "API_KEY",
  "apiKey": "plaintext-api-key-from-admin-form",
  "apiSecret": "plaintext-api-secret-from-admin-form"
}
```

The backend encrypts the submitted key and secret before storage, stores a
non-secret API-key fingerprint, marks the credential `NEEDS_VERIFICATION`, and
clears prior verification failure or revocation metadata.

Do not log plaintext submitted credentials.

## Verify Broker Credentials

```http
POST /api/trading-accounts/:id/credentials/verify
```

Verification calls the Alpaca account endpoint through the account-scoped
resolver. During verification only, the resolver may use credentials in
`NEEDS_VERIFICATION`, `INVALID`, or `ACTIVE` state. Normal runtime broker calls
continue to require `ACTIVE` account-scoped credentials, with the existing
Bobby Paper legacy env fallback still intact.

On success, the backend:

```text
sets credential status to ACTIVE
sets verifiedAt
clears lastFailedAt and revokedAt
syncs broker account metadata and balances
moves NEEDS_CREDENTIALS or ERROR accounts to PAUSED
keeps tradingEnabled=false
keeps killSwitchEnabled=true
```

On failure, the backend:

```text
sets credential status to INVALID
sets lastFailedAt
sets account status to ERROR
keeps tradingEnabled=false
keeps killSwitchEnabled=true
returns a sanitized error message
```

## Revoke Broker Credentials

```http
POST /api/trading-accounts/:id/credentials/revoke
```

Revocation does not delete the credential row. It marks the credential
`REVOKED`, sets `revokedAt`, disables trading for the account, enables the
account kill switch, and moves the account to `NEEDS_CREDENTIALS`.

## Admin UI Workflow

The Admin UI exposes trading accounts under:

```text
Trading -> Trading Accounts
```

Use the list page to review account scope, broker environment, safety posture,
broker balance snapshots, and credential status.

Use the detail page to:

- inspect account summary and broker metadata
- edit only safe mutable account fields
- edit account-level risk controls
- manage account allocation buckets under `Sizing & Allocations`
- review account subscriptions under `Sizing & Allocations`
- edit account-subscription allocation, activation switches, sizing type,
  sizing values, optional limits, and notes
- submit or replace Alpaca API-key credentials
- verify credentials and refresh broker metadata
- revoke credentials when account-scoped broker access should be disabled

The account subscriptions table defaults to active account subscriptions so
accounts with many historical or disabled rows stay readable. Admins can switch
the status filter to all or disabled rows, and can also filter by search text,
sizing type, or allocation bucket.

Account-subscription sizing changes in the Admin UI are configuration
changes for runtime entry orders. Setting an account subscription to
`MAX_NOTIONAL` causes new entry orders to calculate whole-share quantity from
the backend-owned latest price. Existing market order behavior is unchanged:
`MAX_NOTIONAL` is a sizing estimate and cap based on the latest price, not a
guarantee that the final market fill notional will match the estimate exactly.
Allocation bucket limits are enforced for new entries assigned to that
allocation. For `MAX_NOTIONAL`, the broker order remains quantity-based while
risk checks use the backend-estimated notional.

## Account Subscription Market Context

Market context endpoints provide backend-owned price data for account
subscription budget configuration and preview the same latest-price source used
by runtime `MAX_NOTIONAL` entry sizing. They do not change order-worker
behavior, broker submissions, or the n8n signal contract.

List market context for account subscriptions:

```http
GET /api/trading-accounts/:id/account-subscriptions/market-context
```

Supported query parameters:

```text
status=active|all|disabled
symbols=SPY,QQQ,DIA
```

`status` defaults to `active`. `symbols` is optional and filters the account's
account subscriptions by symbol after loading account-scoped rows.

Response envelope:

```json
{
  "tradingAccountId": 1,
  "generatedAt": "2026-06-30T00:00:00.000Z",
  "items": [
    {
      "accountSubscriptionId": 1,
      "subscriptionId": 10,
      "symbol": "DIA",
      "subscriptionKey": "dia-swing",
      "latestPrice": 522.67,
      "latestPriceAt": "2026-06-30T20:00:00.000Z",
      "latestPriceSource": "lastTrade",
      "week52High": 545.1,
      "week52Low": 410.25,
      "week52HighAt": "2026-06-20",
      "week52LowAt": "2025-08-05",
      "sizingType": "MAX_NOTIONAL",
      "fixedQty": null,
      "maxPositionNotional": 1000,
      "minPositionNotional": null,
      "maxQty": null,
      "estimatedQty": 1,
      "estimatedNotional": 522.67,
      "nextShareQty": 2,
      "nextShareNotional": 1045.34,
      "dollarsToNextShare": 45.34,
      "warnings": []
    }
  ]
}
```

Budget preview rules are whole-share only:

```text
MAX_NOTIONAL estimatedQty = floor(maxPositionNotional / latestPrice)
MAX_NOTIONAL estimatedNotional = estimatedQty * latestPrice
MAX_NOTIONAL nextShareQty = estimatedQty + 1
MAX_NOTIONAL nextShareNotional = nextShareQty * latestPrice
MAX_NOTIONAL dollarsToNextShare = max(0, nextShareNotional - maxPositionNotional)

FIXED_QTY estimatedQty = fixedQty
FIXED_QTY estimatedNotional = fixedQty * latestPrice
```

When the latest price is unavailable, estimated quantity and notional values are
`null` and `warnings` includes:

```text
Latest price unavailable.
```

When a `MAX_NOTIONAL` budget is below the latest price, `warnings` includes:

```text
Budget is below the latest price; calculated quantity would be 0.
```

Read daily price history for one account subscription:

```http
GET /api/trading-accounts/:id/account-subscriptions/:accountSubscriptionId/price-history?range=1y
```

Supported ranges:

```text
3m
6m
1y
```

The default range is `1y`. The endpoint returns daily candles intended for
budget-setting charts, plus latest close and 52-week high/low summary values.

Response envelope:

```json
{
  "tradingAccountId": 1,
  "accountSubscriptionId": 1,
  "subscriptionId": 10,
  "symbol": "DIA",
  "range": "1y",
  "generatedAt": "2026-06-30T00:00:00.000Z",
  "candles": [
    {
      "date": "2026-06-30",
      "open": 520.1,
      "high": 525.5,
      "low": 519.75,
      "close": 522.67,
      "volume": 1234567
    }
  ],
  "summary": {
    "latestClose": 522.67,
    "latestCloseAt": "2026-06-30",
    "week52High": 545.1,
    "week52Low": 410.25
  }
}
```

Credential inputs are intentionally never prefilled. After credentials are
saved, the UI clears the submitted key and secret and displays only the safe
credential summary returned by the backend.

Credential verification does not enable trading or disable the kill switch.
Those safety controls must be changed separately through the safe account
settings form.

## Safety Notes

- No route returns decrypted credentials.
- No route returns encrypted credential payloads.
- n8n should continue to use signal APIs only and should not use broker
  credentials.
- Account-subscription APIs configure runtime entry sizing. Allocation bucket
  limits are enforced only for new entries assigned to that allocation.
- Account-subscription runtime sizing does not change order worker behavior or
  the n8n signal contract.
- Bobby Paper can continue to use legacy Alpaca env credentials when no
  `ACTIVE` account-scoped credential exists.
