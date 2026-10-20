# PAPER broker-write authority rollout

This is a coordinated configuration migration. Do not deploy Phase 3C.4 to the
production executor until its exact Bobby Paper identity has been prepared. The
code default is fail-closed and would otherwise block production protective exits.

## Configuration

Observation-only development:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=OBSERVATION_ONLY
PAPER_BROKER_WRITE_AUTHORIZATIONS=[]
PAPER_BROKER_WRITE_OWNERSHIP=[{"tradingAccountId":<Bobby Paper local id>,"role":"OBSERVER"}]
```

Production executor (replace placeholders with values already verified for Bobby
Paper; do not paste API keys or secrets):

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=PAPER_EXECUTOR
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<verified Alpaca account_number>","keyFingerprint":"sha256:<64 lowercase hex characters>"}]
PAPER_BROKER_WRITE_OWNERSHIP=[{"tradingAccountId":<Bobby Paper local id>,"role":"EXECUTOR","expectedBrokerAccountId":"<verified Alpaca account_number>"}]
```

Dedicated validation executor:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=PAPER_EXECUTOR
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<validation Alpaca account_number>","keyFingerprint":"sha256:<validation key fingerprint>"}]
PAPER_BROKER_WRITE_OWNERSHIP=[{"tradingAccountId":<Bobby Paper local id>,"role":"OBSERVER"},{"tradingAccountId":<validation local id>,"role":"EXECUTOR","expectedBrokerAccountId":"<validation Alpaca account_number>"}]
```

Never include Bobby Paper in the development validation allowlist. Ownership and
authorization are deliberately separate. `PAPER_BROKER_WRITE_OWNERSHIP` declares
which local application account is expected to execute or observe; its local ID
is readiness evidence only and never grants a broker write. The unchanged final
write guard authorizes only the decrypted credential's exact Alpaca
`account_number` plus recomputed API-key fingerprint.

`TradingAccount.brokerAccountId` is the Alpaca `account_number`; it is not the
Alpaca account UUID. A null value is missing identity evidence and cannot be
authorized.

Startup rejects malformed JSON, unknown roles, duplicate identity pairs,
authorizations in observation mode, and executor mode with an empty allowlist.
It also rejects one fingerprint assigned to multiple accounts or multiple active
fingerprints assigned to one account. It also rejects duplicate local ownership
or duplicate expected-executor `account_number` declarations. Public `GET /health`
is cheap liveness/configuration information and deliberately reports account-aware
executor coverage as `UNKNOWN`; HTTP 200 is never GO evidence. Authenticated
`GET /api/trading-accounts/:id/paper-broker-write-authority` reports sanitized
account-specific evidence. Neither response exposes identity pairs or secrets.

Run preflight from the staged executor host against the intended database and
environment. Production GO requires all three assertions:

```text
npm run paper-broker-write:preflight -- --mode production --expected-trading-account-id <id> --expected-broker-account-number <Alpaca account_number> --expected-database <database_name>
```

Use `--mode development-validation` with the same assertions for a dedicated
development validation executor. The default `--mode inspect` is explicitly
`INFORMATIONAL_ONLY` and can never print GO. Production mode refuses to run unless
`NODE_ENV=production`; both execution modes verify `current_database()` and require
the asserted account to return `AUTHORIZED`. The command is read-only: it neither
verifies credentials nor calls broker
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
4. Run the exact production preflight above. Require verdict `GO`, the asserted
   per-account result `AUTHORIZED`, the asserted Alpaca `account_number`, and
   `brokerCallsMade: 0`.
5. Independently review the planned deployment and obtain owner authorization.
6. Deploy only after that authorization; do not change global trading or accounts.
7. Verify running account-specific readiness plus broker GET observations. A
   syntactically valid `/health` configuration alone is not production readiness.
8. Watch the first subsequent normal protective-exit lifecycle. Do not initiate a
   test order.

STOP if ownership is undeclared/contradictory; an authorization resolves to zero
or multiple accounts; account enumeration is incomplete; any relevant lifecycle
exposure is unreadable; the `account_number` is null or mismatched; the active credential cannot be
decrypted, its recomputed fingerprint differs from storage or configuration, a
required exposed account is DENIED/UNKNOWN, the database is unreadable, or the
preflight reports STOP. Do not broaden the allowlist or reverify automatically.

Production startup remains live and preserves reads/reconciliation when readiness
is missing, but records a failing `paper_executor_coverage` check and opens or
observes one deduplicated ERROR `PAPER_EXECUTOR_AUTHORITY_MISMATCH` attention per
affected account. Exit evaluation also fails visibly instead of reporting a
successful skip. Only a fresh account-aware `AUTHORIZED` verification resolves
that attention authoritatively; editing the allowlist alone does not resolve it.
Repeated startup and worker checks preserve the history without creating duplicate
attention rows.

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
