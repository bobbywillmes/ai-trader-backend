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

The CLI is read-only, worker-free, and broker-call-free. It reads the build-owned
`/app/.image-revision` file; `IMAGE_REVISION` from an env file is never image evidence.
Production GO requires:

```text
npm run paper-broker-write:preflight -- --mode production --expected-trading-account-id <id> --expected-broker-account-number <account_number> --expected-image-revision <full reviewed SHA> --expected-database <database> --expected-database-host <plain address> --expected-database-port <port> --expected-database-user <role>
```

Use `development-validation` only for the validation executor. The default is
`INFORMATIONAL_ONLY` and never substitutes for GO. The CLI compares the embedded
image revision, `current_database()`, `host(inet_server_addr())`,
`inet_server_port()`, and `current_user`; mismatch errors name only the field.
Unix-socket connections can return null address/port and cannot satisfy a TCP
assertion. These properties do not cryptographically attest the database host.

Credential verification is a separate operator action with account-state side
effects. Do not create, verify, replace, or rotate credentials to pass preflight.

The expected database host is PostgreSQL's server address as observed from the
backend connection, not the Compose service name. Obtain it without credentials:

```text
docker compose -f docker-compose.prod.yml exec postgres sh -lc 'hostname -i'
```

Confirm the selected address equals a read-only `host(inet_server_addr())` result.
A recreated PostgreSQL container may receive a different Compose-network address, so
recompute and reapprove it immediately before final preflight. Never print
`DATABASE_URL`, passwords, or env-file contents to discover the address.

## Approved release gates

Each gate requires separate recorded owner approval. Passing one gate does not approve
the next. The migration inventory and compatibility analysis are in
`docs/production/phase-3c4-release-readiness.md`.

1. **Read-only preparation.** Capture the running backend's container ID and immutable
   image ID as `PREV_IMAGE_ID`. Check out the reviewed commit, set `REVIEWED_SHA` to
   its full Git SHA, and require `test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"`.
   Build once, capture the immutable image ID, and verify both forms of revision
   evidence before any command uses `IMAGE_ID`:

   ```text
   docker build --build-arg IMAGE_REVISION="$REVIEWED_SHA" -t "ai-trader-backend:review-$REVIEWED_SHA" .
   IMAGE_ID=$(docker image inspect "ai-trader-backend:review-$REVIEWED_SHA" --format '{{.Id}}')
   test -n "$IMAGE_ID"
   test "$(docker image inspect "$IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$REVIEWED_SHA"
   test "$(docker run --rm --entrypoint sh "$IMAGE_ID" -c 'cat /app/.image-revision')" = "$REVIEWED_SHA"
   ```

   Record `REVIEWED_SHA`, `IMAGE_ID`, `PREV_IMAGE_ID`, and the running container ID
   in the sanitized release record. All later gates must use this exact `IMAGE_ID`;
   never rebuild or resolve the mutable review tag again. Create a mode-600 temporary
   migration-status env file outside the Git worktree, containing only the approved
   production `DATABASE_URL`:

   ```text
   umask 077
   MIGRATION_STATUS_ENV=$(mktemp /tmp/ai-trader-migration-status.XXXXXX)
   read -rsp 'DATABASE_URL: ' MIGRATION_STATUS_DATABASE_URL
   printf 'DATABASE_URL=%s\n' "$MIGRATION_STATUS_DATABASE_URL" > "$MIGRATION_STATUS_ENV"
   unset MIGRATION_STATUS_DATABASE_URL
   test "$(stat -c %a "$MIGRATION_STATUS_ENV")" = 600
   docker run --rm --network <production-compose-network> --env-file "$MIGRATION_STATUS_ENV" --entrypoint npx "$IMAGE_ID" prisma migrate status
   rm -f -- "$MIGRATION_STATUS_ENV"
   test ! -e "$MIGRATION_STATUS_ENV"
   unset MIGRATION_STATUS_ENV
   ```

   Use the Compose-equivalent URL targeting host `postgres`; do not print the env file
   or `DATABASE_URL`. Run only `prisma migrate status` against production and inspect
   the asserted database identity. Do not run `migrate deploy`. Save a restricted
   rollback copy of the current `.env`, its checksum, mode, and association with
   `PREV_IMAGE_ID`. Run `umask 077`, copy `.env` to `.env.next`, keep
   mode 600, edit all three PAPER values together, and validate JSON, identities,
   cardinality, and permissions. Remove any `IMAGE_REVISION` assignment from both
   files; it is not operator configuration. Do not commit either restricted file.

   Require status exit zero, verify removal of the temporary file, and confirm that
   the production backend container and image did not change.

2. **Schema compatibility acceptance.** Reverify the recorded `IMAGE_ID` revision
   label and `/app/.image-revision`, without rebuilding. Execute the isolated migration
   and old-code compatibility procedure in the release-readiness document with this
   exact image. Its database, credentials, environment file, and network must be
   isolated from production and must have no route to a broker. Production is
   untouched in this gate.

3. **Migration approval.** Require the backup, quiet-window, lock, rollback, operator-
   approval, exact-image execution, and post-migration evidence specified in the
   release-readiness document. Run migration status/deploy from `IMAGE_ID`, never a
   mutable tag or host checkout, using the separately prepared restricted production
   migration env file and production Compose network. This is the only gate that may
   run production `prisma migrate deploy`; preparation and preflight must not. This
   gate changes only schema; it does not deploy the application or grant PAPER
   execution. Stop on any nonzero or partial result.

   Prepare the restricted input, run the approved migration, and remove the input:

   ```text
   umask 077
   MIGRATION_ENV=$(mktemp /tmp/ai-trader-migration.XXXXXX)
   read -rsp 'DATABASE_URL: ' MIGRATION_DATABASE_URL
   printf 'DATABASE_URL=%s\n' "$MIGRATION_DATABASE_URL" > "$MIGRATION_ENV"
   unset MIGRATION_DATABASE_URL
   test "$(stat -c %a "$MIGRATION_ENV")" = 600
   docker run --rm --network <production-compose-network> --env-file "$MIGRATION_ENV" --entrypoint npx "$IMAGE_ID" prisma migrate status
   docker run --rm --network <production-compose-network> --env-file "$MIGRATION_ENV" --entrypoint npx "$IMAGE_ID" prisma migrate deploy
   docker run --rm --network <production-compose-network> --env-file "$MIGRATION_ENV" --entrypoint npx "$IMAGE_ID" prisma migrate status
   rm -f -- "$MIGRATION_ENV"
   test ! -e "$MIGRATION_ENV"
   unset MIGRATION_ENV
   ```

   Enter the approved Compose-equivalent production URL targeting host `postgres`.
   Do not print it or add unrelated credentials. Secured retention requires an
   explicit exception; otherwise deletion is mandatory.

4. **Final PAPER authority preflight.** Begin only after the seven migrations are
   confirmed present on the actual production schema. Compose supplies `DATABASE_URL` under
   `environment`, not the backend `env_file`. Create a restricted temporary file
   without putting the secret in history:

   ```text
   umask 077
   PREFLIGHT_ENV=$(mktemp)
   cp .env.next "$PREFLIGHT_ENV"
   sed -i '/^[[:space:]]*IMAGE_REVISION=/d' "$PREFLIGHT_ENV"
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

5. **Application deployment.** Requires a separate owner approval after GO. Confirm
   the restricted rollback env copy and `PREV_IMAGE_ID` are still available, then
   atomically replace `.env` with reviewed `.env.next`. Set
   `AI_TRADER_BACKEND_IMAGE` to the exact preflight-passing `IMAGE_ID`. Resolve Compose
   only into a mode-600 temporary file outside the Git worktree. The resolved file is
   secret-bearing: never print it, redirect it into the repository, attach it to a
   ticket, or retain it as an ordinary review artifact.

   ```text
   umask 077
   COMPOSE_REVIEW=$(mktemp /tmp/ai-trader-compose.XXXXXX)
   docker compose -f docker-compose.prod.yml -f docker-compose.prod.image.yml config --format json > "$COMPOSE_REVIEW"
   test "$(stat -c %a "$COMPOSE_REVIEW")" = 600
   test "${COMPOSE_REVIEW#/tmp/}" != "$COMPOSE_REVIEW"
   # Inspect the restricted file locally without copying or printing its contents.
   # Verify backend.image == IMAGE_ID, backend.build is absent, the expected database
   # target/network is selected, and backend dependency behavior is unchanged.
   # Record only those assertions and non-secret IDs in a sanitized record.
   rm -f -- "$COMPOSE_REVIEW"
   test ! -e "$COMPOSE_REVIEW"
   unset COMPOSE_REVIEW
   docker compose -f docker-compose.prod.yml -f docker-compose.prod.image.yml up -d --no-build --no-deps backend
   docker inspect ai-trader-prod-backend --format '{{.Image}}'
   ```

   `/tmp` must be outside the Git worktree; stop if it is not. If
   policy requires retention, move the file to an approved encrypted secret store
   with restricted access and retention instead of keeping it locally. The sanitized
   record may state the effective backend image ID, absence of `backend.build`,
   database target, network, dependency result, reviewer, and time, but must contain
   no environment values, credential-derived checksums, or credentials.

   The inspected running image ID must equal the preflighted `IMAGE_ID`. The override pins
   `backend.image` and removes `build`; `--no-build --no-deps` prevents a silent build
   or dependency recreation during this backend-only deployment. Verify account
   readiness plus Alpaca account, positions, and open orders with GETs. `/health`
   alone is not GO. Do not create a test order.

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

An OBSERVER identity mismatch means the local account does not resolve to the exact
expected brokerage `account_number`, is duplicated, or cannot be enumerated. Diagnose
the configured local ID, stored broker identity, and read-only enumeration evidence;
do not change the role to EXECUTOR, add an allowlist entry, or treat observation as
execution authority. Correcting observer metadata remains a separately reviewed
configuration change.

Filled SELL and position-linked filled BUY intents are excluded from unlinked-intent
exposure; the open position still counts once. An undeclared locally exposure-free
account can be resolved with a reviewed OBSERVER declaration only after broker GETs
address synchronization risk.

## Rollback and recovery

Preserve positions, intents, broker orders, entry claims, and delivery-uncertain
evidence in both paths.

**Restore execution:** set `AI_TRADER_BACKEND_IMAGE="$PREV_IMAGE_ID"`, restore the
restricted rollback environment copy only after verifying its checksum and schema
compatibility, and review the resolved Compose file. Deploy backend only with
`--no-build --no-deps`, inspect the running container's `.Image`, and require it to
equal `PREV_IMAGE_ID`. Verify broker account, positions, and open orders via GET before
confirming protective-exit authority. Never mix an old image with unreviewed new
configuration.

Application rollback does not reverse Prisma migrations. Restoring a previous image
is unsafe when that image cannot tolerate the migrated schema, when newer code has
written claims/consumptions/un-enforced-dispatch evidence whose safety meaning it does
not preserve, or when its configuration parser cannot accept the rollback environment.
In those cases keep writes suspended and perform a reviewed forward repair. Database
rollback means restoring a pre-migration backup; it can discard post-backup broker and
lifecycle evidence and requires a separate incident decision and reconciliation. Never
drop the seven migrations or delete their evidence as part of an image rollback.

**Emergency observation-only:** explicitly approve write suspension and use a valid
unit: `OBSERVATION_ONLY`, `[]` authorizations, and OBSERVER declarations with expected
account_number for every known local PAPER account. Deploy a reviewed pinned image,
verify mutations are blocked, and inspect broker state with GETs. This suspends future
automatic exits and is not operationally equivalent to restoring execution.

Never broaden the allowlist, enable all PAPER accounts, alter global trading state,
rotate credentials, or edit lifecycle evidence as a rollback shortcut.
