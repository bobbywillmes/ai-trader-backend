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
- Bobby Paper can continue to use legacy Alpaca env credentials when no
  `ACTIVE` account-scoped credential exists.
