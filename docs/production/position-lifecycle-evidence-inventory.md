# Position Lifecycle Evidence Inventory

Phase 1C.0 is a disconnected, read-only inventory of persisted `TrackedPosition`
evidence. Its classifications are shadow diagnostics. They grant no account authority,
position ownership, exit eligibility, repair permission, or broker-write capability.

## V1 classification contract

- `COMPLETE_LOCAL_ORDER_CHAIN` requires exactly one reconciled, terminal BUY intent and
  one terminal broker order; consistent broker/mode/account/Security/symbol/side and
  stable order identities; frozen Subscription and assignment identity; final
  cumulative quantity with zero remaining quantity; exactly one durable dispatch and
  matching adapter marker; and a consistent, terminal claim lifecycle. A link created
  by `historical_order_lifecycle_repair` is reported as insufficient original-origin
  proof. Multiple entries or retries that V1 cannot reconcile remain unknown.
- SELL intents from `close-position`, `exit-evaluator`, and
  `remaining-exposure-close` are exit evidence only when source, long-position
  direction, chronology, and a direct evidence link all agree. They remain visible in
  the report but do not invalidate the BUY chain. Unclassified or unrelated intents
  are never silently accepted as exits, and exit fills are never counted as entry
  fills.
- `POSITIVE_EXTERNAL_ORIGIN` requires independently verified external-origin evidence.
  Existing provenance decisions are currently reported as `UNVERIFIED`, so an
  unsupported `BROKER_EXTERNAL` row remains unresolved.
- `UNKNOWN_INCOMPLETE_LINEAGE` covers missing, partial, multiple-but-unreconciled, or
  otherwise insufficient evidence. Symbol, timing, quantity, enabled Subscription,
  repair/adoption history, and current broker position quantity are not proof.
- `CONTRADICTORY_EVIDENCE` takes precedence when explicit identities disagree.

The report includes local database IDs but hashes broker order, client order, activity,
and fill order identities. Broker account identifiers are masked. Raw broker JSON,
credentials, connection strings, and decrypted secrets are never selected.

## Transaction and query boundary

`runPositionLifecycleEvidenceInventory` opens one
`REPEATABLE READ READ ONLY` transaction, verifies the exact database/host/port/user,
role posture, and transaction mode, then reads positions in keyset-ordered batches.
Each bounded batch bulk-loads related intents, orders, fills, dispatch records, claims,
attribution, provenance, and attention. The query layer receives only the transaction
client and imports no lifecycle, repair, recovery, broker, or mutation service.

Persistent execution is disabled. The repository has no independently managed,
positive development-tier database marker; a process environment allowlist, database
name, `NODE_ENV`, or PAPER/LIVE account contents cannot supply that proof. Development
may legitimately contain both PAPER and LIVE account rows.

The disposable harness verifies exact connection identity and reports tier
`DISPOSABLE_TEST`. Future persistent acceptance requires an infrastructure-managed
development identity that production cannot self-assert, plus a dedicated credential
whose session and effective role match, whose read-only default is set at role or
database scope, and which cannot acquire write power. The verifier inventories all
application-schema relations for INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and
TRIGGER; relation/schema/database ownership; schema CREATE; elevated role attributes;
built-in write roles; and direct or NOINHERIT membership escalation. A read-only
transaction and a non-escalatable credential are separate mandatory controls.

## Output and review

Every historical position is included, including closed and account-unattributed rows.
Aggregates are grouped by database tier, account environment, broker, and position
status. Classification counts are exclusive; reason and readiness counts overlap.
Open/closing positions with an exit state but without complete V1 local proof are
marked `LEGACY_EXIT_CONTINUITY_REVIEW_REQUIRED`. A recorded continuity assertion is
currently untrusted and adds `LEGACY_EXIT_CONTINUITY_RECORDED_UNVERIFIED`; it neither
emits `...REVIEWED` nor suppresses aggregate review counts. Existing exit state or
protective orders never establish entry ownership, and the inventory changes none of
them.
