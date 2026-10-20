# PAPER broker-write authority rollout

Do not deploy Phase 3C.4 until the exact Bobby Paper identity and exact reviewed
image pass preflight. The default is fail-closed and otherwise blocks PAPER exits.

## Atomic configuration

Treat `PAPER_BROKER_WRITE_DEPLOYMENT_ROLE`, `PAPER_BROKER_WRITE_AUTHORIZATIONS`, and
`PAPER_BROKER_WRITE_OWNERSHIP` as one reviewed unit. Never stage or approve a partial
change. Every ownership entry requires the expected Alpaca `account_number`.

Observation-only development:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=OBSERVATION_ONLY
PAPER_BROKER_WRITE_AUTHORIZATIONS=[]
PAPER_BROKER_WRITE_OWNERSHIP=[{"tradingAccountId":<Bobby local id>,"role":"OBSERVER","expectedBrokerAccountId":"<Bobby account_number>"}]
```

Production executor:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=PAPER_EXECUTOR
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<Bobby account_number>","keyFingerprint":"sha256:<64 lowercase hex>"}]
PAPER_BROKER_WRITE_OWNERSHIP=[{"tradingAccountId":<Bobby local id>,"role":"EXECUTOR","expectedBrokerAccountId":"<Bobby account_number>"}]
```

Dedicated validation executor:

```text
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=PAPER_EXECUTOR
PAPER_BROKER_WRITE_AUTHORIZATIONS=[{"brokerAccountId":"<validation account_number>","keyFingerprint":"sha256:<validation fingerprint>"}]
PAPER_BROKER_WRITE_OWNERSHIP=[{"tradingAccountId":<Bobby local id>,"role":"OBSERVER","expectedBrokerAccountId":"<Bobby account_number>"},{"tradingAccountId":<validation local id>,"role":"EXECUTOR","expectedBrokerAccountId":"<validation account_number>"}]
```

Never allowlist Bobby Paper in development. Final authorization requires exactly
one matching EXECUTOR declaration, exact resolved account_number and recomputed
key fingerprint, exactly one allowlist pair, and exactly one local PAPER account
with that verified brokerage identity. An OBSERVER identity is unavailable through
every alternate local account. Duplicate identities and ownership contradictions
fail closed. Database identity never grants authority.

Malformed JSON, missing ownership account_numbers, or contradictory configuration
may prevent startup entirely. With schema-valid configuration, readiness failure
keeps reads available, warns, opens attention, and blocks PAPER mutations.

## Strict preflight

The CLI is read-only, worker-free, and broker-call-free. Production GO requires:

```text
npm run paper-broker-write:preflight -- --mode production --expected-trading-account-id <id> --expected-broker-account-number <account_number> --expected-image-revision <full reviewed SHA> --expected-database <database> --expected-database-host <plain address> --expected-database-port <port> --expected-database-user <role>
```

Use `development-validation` only for the validation executor. The default is
`INFORMATIONAL_ONLY` and never substitutes for GO. The CLI compares the embedded
`IMAGE_REVISION`, `current_database()`, `host(inet_server_addr())`,
`inet_server_port()`, and `current_user`; mismatch errors name only the field.
Unix-socket connections can return null address/port and cannot satisfy a TCP
assertion. These properties do not cryptographically attest the database host.

Credential verification is a separate operator action with account-state side
effects. Do not create, verify, replace, or rotate credentials to pass preflight.

## Immutable staging and deployment

Each phase requires separate approval.

1. **Prepare configuration.** Run `umask 077`, copy `.env` to `.env.next`, keep
   mode 600, edit all three PAPER values together, and validate JSON, identities,
   cardinality, and permissions. Do not commit `.env.next`.

2. **Build exact code.** Check out the reviewed commit and require
   `test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"`. Then:

   ```text
   docker build --build-arg IMAGE_REVISION="$REVIEWED_SHA" -t "ai-trader-backend:review-$REVIEWED_SHA" .
   IMAGE_ID=$(docker image inspect "ai-trader-backend:review-$REVIEWED_SHA" --format '{{.Id}}')
   docker image inspect "$IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
   ```

   Require the full label to match. Record the immutable ID (or a registry manifest
   digest verified after pull). A mutable tag is not evidence.

3. **Preflight the staged image.** Compose supplies `DATABASE_URL` under
   `environment`, not the backend `env_file`. Create a restricted temporary file
   without putting the secret in history:

   ```text
   umask 077
   PREFLIGHT_ENV=$(mktemp)
   cp .env.next "$PREFLIGHT_ENV"
   read -rsp 'DATABASE_URL: ' PREFLIGHT_DATABASE_URL
   printf '\nDATABASE_URL=%s\n' "$PREFLIGHT_DATABASE_URL" >> "$PREFLIGHT_ENV"
   unset PREFLIGHT_DATABASE_URL
   test "$(stat -c %a "$PREFLIGHT_ENV")" = 600
   ```

   Enter the Compose-equivalent URL targeting host `postgres`. Never print its raw
   line. `docker run --env-file` does not apply Compose interpolation; use unquoted
   `KEY=value`. Quotes can be preserved as value characters by Docker CLI handling.

   ```text
   docker run --rm --network <production-compose-network> --env-file "$PREFLIGHT_ENV" --entrypoint npm "$IMAGE_ID" run paper-broker-write:preflight -- --mode production --expected-trading-account-id <id> --expected-broker-account-number <account_number> --expected-image-revision "$REVIEWED_SHA" --expected-database <database> --expected-database-host <address> --expected-database-port <port> --expected-database-user <role>
   ```

   Require exit 0, `GO`, one AUTHORIZED asserted account, and empty `unresolved`.
   STOP, INFORMATIONAL_ONLY, warnings, missing/contradictory evidence, enumeration
   failure, duplicate identity, or revision mismatch are not GO. Record sanitized
   output and the image ID. Remove the file with `rm -f -- "$PREFLIGHT_ENV"`, unset
   the variable, verify absence, and confirm the active container/image did not change.

4. **Deploy only after separate approval.** Preserve the prior compatible `.env`
   as a restricted rollback artifact, then atomically replace it with reviewed
   `.env.next`. Set `AI_TRADER_BACKEND_IMAGE` to the preflight-passing ID/digest.
   Review and deploy:

   ```text
   docker compose -f docker-compose.prod.yml -f docker-compose.prod.image.yml config
   docker compose -f docker-compose.prod.yml -f docker-compose.prod.image.yml up -d --no-build backend
   ```

   The override pins `backend.image` and removes `build`; `--no-build` prevents a
   silent rebuild while retaining the existing service, network, dependencies, and
   environment. Verify account readiness plus Alpaca account, positions, and open
   orders with GETs. `/health` alone is not GO. Do not create a test order.

STOP on unreadable exposure, identity/fingerprint mismatch, DENIED/UNKNOWN exposed
accounts, database mismatch, duplicate identity, or any non-GO result. Locally absent
positions may not yet be synchronized from Alpaca, so broker GETs remain mandatory.

## Runtime reconciliation

Startup assesses authority and reconciles attention. A monitored worker runs at
startup and every five minutes, prevents overlap, and records enumeration/per-account
failure as worker-health failure rather than successful zero-account work. DENIED or
UNKNOWN PAPER exit authority fails visibly and opens/observes attention. Fresh
AUTHORIZED evidence, or an explicit OBSERVER after canonical proof of no local
exposure, resolves it authoritatively. Repetition does not duplicate attention rows.

Filled SELL and position-linked filled BUY intents are excluded from unlinked-intent
exposure; the open position still counts once. An undeclared locally exposure-free
account can be resolved with a reviewed OBSERVER declaration only after broker GETs
address synchronization risk.

## Rollback and recovery

Preserve positions, intents, broker orders, entry claims, and delivery-uncertain
evidence in both paths.

**Restore execution:** restore the previously known-good immutable image together
with its compatible three-value configuration. Bobby remains EXECUTOR with the exact
account_number/authorization. Review merged Compose config, deploy through the pinned
override with `--no-build`, then verify broker account, positions, and open orders via
GET before confirming protective-exit authority. Never mix an old image with an
unreviewed new configuration.

**Emergency observation-only:** explicitly approve write suspension and use a valid
unit: `OBSERVATION_ONLY`, `[]` authorizations, and OBSERVER declarations with expected
account_number for every known local PAPER account. Deploy a reviewed pinned image,
verify mutations are blocked, and inspect broker state with GETs. This suspends future
automatic exits and is not operationally equivalent to restoring execution.

Never broaden the allowlist, enable all PAPER accounts, alter global trading state,
rotate credentials, or edit lifecycle evidence as a rollback shortcut.
