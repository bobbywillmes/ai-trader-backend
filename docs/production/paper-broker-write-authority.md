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
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<verified Alpaca account id>","keyFingerprint":"sha256:<64 lowercase hex characters>"}]
```

Dedicated validation executor:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=PAPER_EXECUTOR
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<validation Alpaca account id>","keyFingerprint":"sha256:<validation key fingerprint>"}]
```

Never include Bobby Paper in the development validation allowlist. Authorization
is not based on local `TradingAccount.id`, so recreating a row does not grant it.

Startup rejects malformed JSON, unknown roles, duplicate identity pairs,
authorizations in observation mode, and executor mode with an empty allowlist.
`GET /health` exposes the role, configured identity count, readiness and a
secret-free message. It never returns account identifiers or fingerprints.

## Safe production sequence

1. From existing verified database evidence, compare Bobby Paper's stored
   `brokerAccountId` and active credential `keyFingerprint` with the intended
   production secret-manager values. Do not rotate credentials.
2. Add both new variables to production configuration before deploying the new
   image. Keep development explicitly observation-only.
3. Deploy normally without changing global trading, account state, positions or
   intents.
4. Confirm `/health` reports `PAPER_EXECUTOR`, one configured identity and
   `ready=true`.
5. Perform read-only account, open-position and open-order checks. Confirm the
   resolved production account still has the exact authorized identity pair.
6. Confirm existing exit workers are healthy. Do not create a test broker write as
   part of this rollout; the five existing positions retain normal lifecycle
   management and their next legitimate protective action will cross the guard.

An exact identity mismatch returns `NOT_SENT_BLOCKED` before network dispatch.
Reads continue, but every PAPER POST/PATCH/DELETE remains blocked. Treat this as a
configuration/credential ownership incident; do not broaden the allowlist.

## Rollback and recovery

If identity preparation cannot be completed, do not deploy the Phase 3C.4 image.
If the new image is running and production writes are blocked, preserve all local
lifecycle evidence, restore the previously deployed image/configuration, verify
read-only broker state, then correct the exact identity pair before retrying.
Changing to `OBSERVATION_ONLY` is a deliberate emergency write stop, not a recovery
that restores exits. Never resolve a mismatch by enabling all PAPER accounts,
changing global `tradingEnabled`, activating an account, rotating credentials, or
editing existing positions/intents.
