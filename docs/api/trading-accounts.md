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

## Manage Allocation Buckets

Allocation buckets group account-scoped subscription sizing limits. They are
admin configuration records only; they do not change runtime order sizing until
the sizing runtime is switched in a later phase.

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

## Manage Account Subscriptions

Account subscriptions attach a trading account to an existing legacy
`Subscription` and store account-specific sizing configuration. These records
are for future account-scoped sizing management only; current runtime order
sizing and the n8n signal request/response contract remain unchanged.

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
- submit or replace Alpaca API-key credentials
- verify credentials and refresh broker metadata
- revoke credentials when account-scoped broker access should be disabled

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
- Allocation and account-subscription APIs configure future account-scoped
  sizing data only. They do not change order worker behavior or the n8n signal
  contract in this phase.
- Bobby Paper can continue to use legacy Alpaca env credentials when no
  `ACTIVE` account-scoped credential exists.
