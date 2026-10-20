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
authorization are deliberately separate and both are required by the final guard. `PAPER_BROKER_WRITE_OWNERSHIP` declares
which local application account is expected to execute or observe; its local ID
is readiness evidence only and never grants a broker write. The unchanged final
write guard first requires the resolved local account's matching `EXECUTOR`
declaration, then authorizes only the decrypted credential's exact Alpaca
`account_number` plus recomputed API-key fingerprint. An OBSERVER or undeclared
account is denied even if an identity was accidentally allowlisted.

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
environment. Production GO requires explicit account and PostgreSQL target assertions:

```text
npm run paper-broker-write:preflight -- --mode production --expected-trading-account-id <id> --expected-broker-account-number <Alpaca account_number> --expected-database <database_name> --expected-database-host <inet_server_addr> --expected-database-port <port> --expected-database-user <role>
```

Use `--mode development-validation` with the same assertions for a dedicated
development validation executor. The default `--mode inspect` is explicitly
`INFORMATIONAL_ONLY` and can never print GO. Production mode refuses to run unless
`NODE_ENV=production`; both execution modes verify `current_database()`, the server
address and port reported by PostgreSQL, and `current_user`, and require
the asserted account to return `AUTHORIZED`. The command is read-only: it neither
verifies credentials nor calls broker
write endpoints; `brokerApiBehavior=NOT_INVOKED_BY_PREFLIGHT_CODE_PATH` describes
the implementation rather than claiming a measured broker-call count. These checks
substantially strengthen target identity but do not cryptographically attest the
server; operators must obtain the expected values from the deployment's reviewed
database configuration. Credential verification is a separate operator decision. The
supported verification workflow calls Alpaca GET account evidence and deliberately
places the local account in `PAUSED`, disables trading, and enables the kill switch;
credential create/replace similarly moves it to `NEEDS_CREDENTIALS`. Do not use
verification merely to fill a missing `brokerAccountId`; review those operational
side effects and obtain owner authorization first.

## Safe staged-image preflight and production sequence

1. Check out the reviewed commit and build without changing the active Compose project:
   `docker build --label org.opencontainers.image.revision=e01e25a -t ai-trader-preflight:e01e25a .`.
2. Record the immutable local image ID with
   `docker image inspect ai-trader-preflight:e01e25a --format '{{.Id}}'`; use that
   exact ID (or a registry digest after a separately authorized push) below.
3. Read existing verified production identity evidence without changing it and
   validate the exact Alpaca `account_number`, recomputed API-key fingerprint,
   explicit `EXECUTOR` ownership, and reviewed database target values.
4. Run a disposable one-off container, never `docker compose up`:
   `docker run --rm --network <production-compose-network> --env-file <reviewed-production-env-file> --entrypoint npm <immutable-image-id> run paper-broker-write:preflight -- --mode production --expected-trading-account-id <id> --expected-broker-account-number <account_number> --expected-database <database> --expected-database-host <server-address> --expected-database-port <port> --expected-database-user <role>`.
   This launches only the CLI entrypoint, does not start the server or workers, has
   no published ports or Docker socket, and cannot replace/recreate the running container.
5. Capture sanitized stdout plus exit status. Require per-account `AUTHORIZED`,
   explicit `EXECUTOR`, exact account_number/fingerprint agreement, aggregate `GO`,
   and an empty `unresolved` array. `INFORMATIONAL_ONLY`, warnings, or STOP are not GO.
6. Verify the one-off container was removed and the active Compose container/image
   IDs are unchanged. Leave production otherwise untouched.
7. Independently review the planned deployment and obtain owner authorization.
8. Deploy the immutable reviewed image only after authorization; do not change global trading or accounts.
9. Verify running account-specific readiness plus broker GET observations. A
   syntactically valid `/health` configuration alone is not production readiness.
10. Watch the first subsequent normal protective-exit lifecycle. Do not initiate a
   test order.

STOP if ownership is undeclared/contradictory; an authorization resolves to zero
or multiple accounts; account enumeration is incomplete; any relevant lifecycle
exposure is unreadable; the `account_number` is null or mismatched; the active credential cannot be
decrypted, its recomputed fingerprint differs from storage or configuration, a
required exposed account is DENIED/UNKNOWN, the database is unreadable, or the
preflight reports STOP. Do not broaden the allowlist or reverify automatically.

Production startup remains live and preserves reads/reconciliation when readiness
is missing, but records a `paper_executor_coverage` warning and opens or
observes one deduplicated ERROR `PAPER_EXECUTOR_AUTHORITY_MISMATCH` attention per
affected account. Exit evaluation also fails visibly instead of reporting a
successful skip. Only a fresh account-aware `AUTHORIZED` verification resolves
that attention authoritatively; editing the allowlist alone does not resolve it.
Repeated startup and five-minute reconciliation checks preserve the history without
creating duplicate attention rows. Fresh AUTHORIZED evidence resolves a mismatch
without restart. Changing an exposed account to OBSERVER never resolves the incident.
After canonical lifecycle queries prove no exposure remains, an explicit OBSERVER
declaration provides auditable transfer/retirement evidence and permits authoritative
resolution. If exposure remains, restore valid executor authority or complete the
normal broker/lifecycle transfer under independent operator review; do not manually
dismiss the AUTHORITATIVE_ONLY attention.

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
