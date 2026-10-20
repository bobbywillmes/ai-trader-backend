# PAPER broker-write authority rollout

This is a coordinated configuration migration. Do not deploy Phase 3C.4 to the
production executor until its exact Bobby Paper identity has been prepared. The
code default is fail-closed and would otherwise block production protective exits.

## Configuration

Observation-only development:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=OBSERVATION_ONLY
PAPER_BROKER_WRITE_AUTHORIZATIONS=[]
```

Production executor (replace placeholders with values already verified for Bobby
Paper; do not paste API keys or secrets):

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=PAPER_EXECUTOR
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<verified Alpaca account_number>","keyFingerprint":"sha256:<64 lowercase hex characters>"}]
```

Dedicated validation executor:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=PAPER_EXECUTOR
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<validation Alpaca account_number>","keyFingerprint":"sha256:<validation key fingerprint>"}]
```

Never include Bobby Paper in the development validation allowlist. Authorization
is not based on local `TradingAccount.id`, so recreating a row does not grant it.

`TradingAccount.brokerAccountId` is the Alpaca `account_number`; it is not the
Alpaca account UUID. A null value is missing identity evidence and cannot be
authorized.

Startup rejects malformed JSON, unknown roles, duplicate identity pairs,
authorizations in observation mode, and executor mode with an empty allowlist.
It also rejects one fingerprint assigned to multiple accounts or multiple active
fingerprints assigned to one account. `GET /health` separately reports syntactic
configuration validity and verified executor coverage without identifiers or
fingerprints. Authenticated
`GET /api/trading-accounts/:id/paper-broker-write-authority` reports sanitized
account-specific evidence. Neither response exposes identity pairs or secrets.

Run `npm run paper-broker-write:preflight` against the intended database and staged
environment. It is read-only: it neither verifies credentials nor calls broker
write endpoints. Credential verification is a separate operator decision. The
supported verification workflow calls Alpaca GET account evidence and deliberately
places the local account in `PAUSED`, disables trading, and enables the kill switch;
credential create/replace similarly moves it to `NEEDS_CREDENTIALS`. Do not use
verification merely to fill a missing `brokerAccountId`; review those operational
side effects and obtain owner authorization first.

## Safe production sequence

1. Read existing verified production identity evidence without changing it.
2. Validate the exact Alpaca `account_number` and recomputed API-key fingerprint.
3. Stage the new environment configuration; keep development observation-only.
4. Run `npm run paper-broker-write:preflight` with that configuration against the
   intended production database without modifying it.
5. Independently review the planned deployment and obtain owner authorization.
6. Deploy only after that authorization; do not change global trading or accounts.
7. Verify running account-specific readiness plus broker GET observations. A
   syntactically valid `/health` configuration alone is not production readiness.
8. Watch the first subsequent normal protective-exit lifecycle. Do not initiate a
   test order.

STOP if the account_number is null or mismatched, the active credential cannot be
decrypted, its recomputed fingerprint differs from storage or configuration, a
required exposed account is DENIED/UNKNOWN, the database is unreadable, or the
preflight reports NOT READY. Do not broaden the allowlist or reverify automatically.

An exact identity mismatch returns `NOT_SENT_BLOCKED` before network dispatch.
Reads continue, but every PAPER POST/PATCH/DELETE remains blocked. Treat this as a
configuration/credential ownership incident; do not broaden the allowlist.

## Rollback and recovery

If identity preparation cannot be completed, do not deploy the Phase 3C.4 image.
If the new image is running and production writes are blocked, preserve all local
lifecycle evidence, switch the deployment to the explicit observation-only
configuration (or restore the previously reviewed image/configuration), keep reads
and reconciliation available, verify broker state with GETs, and independently
review the exact identity correction before retrying.
Changing to `OBSERVATION_ONLY` is a deliberate emergency write stop, not a recovery
that restores exits. Never resolve a mismatch by enabling all PAPER accounts,
changing global `tradingEnabled`, activating an account, rotating credentials, or
editing existing positions/intents.
