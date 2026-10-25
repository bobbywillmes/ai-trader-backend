# Position Lifecycle Evidence Inventory

Phase 1C.0 is a disconnected, read-only inventory of persisted `TrackedPosition`
evidence. Its classifications are shadow diagnostics. They grant no account authority,
position ownership, exit eligibility, repair permission, or broker-write capability.

## V1 classification contract

- `COMPLETE_LOCAL_ORDER_CHAIN` requires exactly one reconciled, terminal BUY intent and
  one terminal broker order; consistent broker/mode/account/Security/symbol/side and
  stable order identities; frozen Subscription and assignment identity; and an
  unambiguous transaction-time-ordered fill history. Every fill must have positive
  incremental quantity, cumulative and remaining quantity, reconcile to intended
  quantity, advance by its confirmed increment, and precede exactly one final fill
  that occurs last. Comparisons use a conservative tolerance of the greater of
  `1e-9` shares or one part per billion of intended quantity. Missing quantities or
  chronology are incomplete; impossible arithmetic, negative remaining quantity,
  overfill, duplicate execution identity, or a non-final-last history is contradictory.
  COMPLETE also requires exactly one durable dispatch and one adapter marker whose
  nonempty `orderIntentId` and `clientOrderId` agree with the intent, dispatch, and
  broker order; and a consistent, terminal claim lifecycle. A link created
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

Missing frozen Subscription or assignment values on historical intents are reported
as incomplete and are not compared to later position attribution. Only two present,
incompatible identities contradict. Extra position-linked BUY fills without an intent,
active entry ownership/execution/lifecycle attention, and nonterminal claims block
COMPLETE. Position-linked SELL fills remain closing evidence rather than unexplained
entries.

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
whose session and effective role match, whose effective PostgreSQL configuration makes
`default_transaction_read_only=on` durable at role/database scope, and which cannot
acquire write power. Session-only `SET` is insufficient. The verifier requires a LOGIN
role with no explicit memberships at all and inventories every relation in the public
application schema for table- and column-level INSERT, UPDATE, DELETE, TRUNCATE,
REFERENCES and TRIGGER; relation/schema/database ownership; database/schema CREATE;
elevated role attributes; and server-file/program capabilities. A read-only
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
