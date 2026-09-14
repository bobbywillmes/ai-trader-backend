# External signal ingestion, authority, routing, and evaluation

External Signals are immutable, account-independent strategy evidence. **They cannot
trade.** Backend-owned revision authority may permit deterministic subscription routing.
ENTRY_LONG and EXIT_LONG now produce bounded evaluation evidence, never risk gates, entry decisions,
order intents, brokers or position/exit pipelines.
The existing n8n `/api/signals` trading pipeline remains separate.

## Operator workflow

1. Create an ExternalSignalSource, for example TradingView Production.
2. Copy its stable webhook URL from source detail.
3. Create a StrategySignalBinding by selecting an existing source and Strategy and
   entering a stable algorithm key. AI Trader automatically creates ACTIVE Revision 1.
4. Configure the external strategy with the key and backend-assigned revision.
5. Send the minimal JSON payload below to the source URL.
6. AI Trader authenticates, resolves the binding and Security, normalizes the event,
   derives its fingerprint, and atomically stores Signal/Delivery and terminal routing
   evidence. New routes proceed to bounded evaluation; EVIDENCE_ONLY records a stopped run.

One source URL serves many strategies. All TradingView strategies may eventually use
one TradingView Production URL; provider labels do not select an adapter. URLs can
remain unchanged for years. Regenerate only to deliberately invalidate a compromised
or otherwise obsolete URL, then update **every** external alert using the old URL.

## Identity and evidence

| Concept | Meaning |
| --- | --- |
| ExternalSignalSource | Configured origin with one stable capability URL |
| externalStrategyKey | Stable algorithm identity, independent of account, subscription, risk profile and revision |
| StrategySignalBinding | Fixed source/key/Strategy mapping; only enabled can be patched |
| StrategySignalRevision | Backend-assigned deployed version, numbered 1, 2, 3... per binding |
| eventFingerprint | Backend-generated logical strategy-event identity |
| requestId | Backend-generated identity of an individual delivery |
| schemaVersion | Internal historical contract evidence; always 1 for new Signals |
| Signal | Recognized canonical strategy event; insert/read only |
| SignalDelivery | Terminal transport/processing evidence; insert/read only |

Use broad keys such as `momentum-stock`, `mean-reversion-etf`,
`trend-following-stock`, or `dip-reversion-etf`. A symbol is appropriate only for a
strategy that is genuinely symbol-specific. Creation trims/lowercases keys, replaces
whitespace runs with hyphens, and collapses repeated hyphens. Only ASCII letters,
digits, hyphens and underscores are allowed (1-200 characters). The UI previews the
result. Keys that normalize identically for one source collide with HTTP 409.
Existing source/key/Strategy identity cannot be reassigned or deleted through APIs.

AI Trader combines resolved Strategy and Security to find backend-owned account
assignments only when the accepting revision permits routing. External providers
never select Conservative/Core/Aggressive variants. This phase has zero trading authority.

## Minimal provider contract

```json
{
  "externalStrategyKey": "momentum-stock",
  "strategyRevision": 2,
  "event": "ENTRY_LONG",
  "symbol": "AAPL",
  "timeframe": "15m",
  "signalTime": "2026-09-10T15:30:00Z",
  "barTime": "2026-09-10T15:15:00Z",
  "metadata": {
    "rsi": 28.4
  }
}
```

Required: externalStrategyKey, strategyRevision, event, symbol, timeframe, signalTime.
Optional: barTime and metadata. The strict pre-release contract rejects supplied
`eventKey` and `schemaVersion` as unknown fields (INVALID_ENVELOPE). There is no
compatibility mode or v2 route. The backend stores Signal.schemaVersion = 1.

Revision must be a positive JSON integer, not a string, and match the binding's
ACTIVE revision. Events are ENTRY_LONG or EXIT_LONG. Symbols resolve to existing
Securities; ingress never creates Securities or Strategies. Symbols are normalized
to uppercase. Canonical timeframes are 1m, 5m, 15m, 30m, 1h, 4h, 1d and 1w.
Supported explicit aliases such as `60m` or `1 hour` normalize to `1h`; ambiguous
values such as `60` are rejected.

Timestamps must be valid offset-bearing ISO dates, at/after the Unix epoch, with at
most millisecond precision. signalTime is the sender's event time; barTime is the
associated observation time; receivedAt belongs to the delivery. barTime cannot
follow signalTime, and signalTime permits at most five minutes of future clock skew.
There is no trading-staleness rejection; delayed valid events remain useful evidence.

Metadata is optional descriptive JSON (at most 4096 bytes) with zero execution
authority. No top-level account, subscription, allocation, sizing or execution fields
are accepted. Nothing in metadata can select an account, size an order or bypass risk.

## Stable webhook capabilities and security

`POST /api/external-signals/<webhookKey>` authenticates by capability possession,
not by human session. Keys contain 256 random bits, encoded as 43 base64url characters.
Only SYSTEM_OWNER can retrieve a key through `GET /api/external-signal-admin/sources/:id/webhook`.
It returns `{ webhookKey }` with Cache-Control: no-store. Ordinary source DTOs,
creation and regeneration responses exclude the key, ciphertext and lookup hash.
The UI constructs the URL using VITE_API_BASE_URL/current-origin conventions.

Keys are encrypted using the existing AES-256-GCM credential utility, with the
existing TRADING_CREDENTIAL_ENCRYPTION_KEY and TRADING_CREDENTIAL_ENCRYPTION_KEY_ID
configuration. A SHA-256 hash supports lookup without decrypting on ingress. This
allows owner retrieval without plaintext database storage, but requires preserving
the encryption key with database backups. Losing it prevents URL retrieval; explicit
regeneration with a valid encryption configuration is the recovery mechanism.
No new secrets service, provider adapter or broker dependency is introduced.

The URL is still a credential. Do not publish it or include it in payloads, logs,
SystemEvents or diagnostics. The frontend keeps it only in transient component
state, never query/mutation data, localStorage, sessionStorage or browser search state.
Source detail retrieves it again whenever reopened; there is no one-time ceremony.
Application logging redacts the entire ingress suffix, including query strings and
encoded/case variants. Configure deployment proxy/access logging equivalently.
HTTPS is required at the deployment boundary.

Regeneration changes only source credential configuration and emits a sanitized
`external_signal_source_webhook_regenerated` event. The source row lock orders
regeneration against in-flight acceptance; after regeneration commits, the old key
cannot normalize another Signal. Unknown/malformed keys return 401 without durable
Delivery rows. Known disabled sources record SOURCE_DISABLED rejections.

Ingress accepts bounded JSON bodies (64 KiB), UTF-8, without compression, and bounds
body-reading time. Raw hashes cover exact received bytes. Forensic payload JSON is
recursively scrubbed for credential fields/patterns and known key/hash values.
Malformed/oversized content is represented by an omission marker, not raw text.

## Fingerprints, retries and conflicts

The backend SHA-256 hashes the repository's deterministic sorted-key canonical JSON
serialization of:

```text
signalSourceId
strategySignalBindingId
strategySignalRevisionId
securityId
event
timeframe
eventOccurrenceTime = normalized barTime, otherwise normalized signalTime
```

Metadata, receivedAt, requestId and raw JSON field ordering do not participate in
identity. The complete accepted canonical content, including metadata and both event
timestamps, separately participates in canonicalPayloadHash.

Creation and retry comparison use one explicit payload projection: schemaVersion,
externalStrategyKey, strategyRevision, event, symbol, timeframe, signalTime, barTime
and metadata. Event timestamps normalize to ISO strings. Database IDs, relation IDs,
eventFingerprint and createdAt are excluded. Existing Signals are projected using
the same function before comparison, since older stored hashes included storage
fields. Those historical hashes and rows remain untouched; no backfill is required.
A punctuation change inside metadata is changed content and correctly conflicts.

| Delivery | Outcome |
| --- | --- |
| New fingerprint | One Signal plus linked NORMALIZED Delivery, in one transaction |
| Same fingerprint and canonical content | DUPLICATE Delivery linked to the existing Signal |
| Same fingerprint, different canonical content | REJECTED / EVENT_FINGERPRINT_CONFLICT; original Signal unchanged |

Thus changed metadata or signalTime on the same bar conflicts; a different bar,
event, timeframe, Security or active revision represents a different identity.
With no barTime, signalTime determines identity. Indistinguishable same-direction
events on the same bar cannot be split with arbitrary UUIDs/counters. Intrabar
sequencing would require a deliberate future contract change.

Database uniqueness on (signalSourceId, eventFingerprint) is the final concurrency
guard. A unique-constraint race rolls back and retries comparison in a fresh
transaction. No successful Signal can be committed without normalized Delivery evidence.
Conflicts emit WARNING `external_signal_event_fingerprint_conflict`; rejection details
include existingSignalId, eventFingerprint, differing field names and a safe reason.
They never include source keys or arbitrary rejected values. Normal success creates
no noisy SystemEvent. Unexpected failures emit `external_signal_processing_failed`.
Public rejection responses expose only a generic error and requestId.

## Revision deployment lifecycle

Binding creation atomically creates ACTIVE Revision 1. Prepare assigns max historical
revision + 1 as PREPARED; only one candidate is permitted. Configure the external
sender, then activate with explicit confirmation. Activation retires the old ACTIVE
revision immediately. Old-revision deliveries, including retries, fail closed with
STRATEGY_REVISION_MISMATCH and active/received integer details. Historical Signals
are never rewritten. Abandoning PREPARED retires it without activation and consumes
its number permanently. Retired revisions cannot be reactivated.

Identity, revision numbers and notes are fixed. Authority may change only while
PREPARED; activation freezes it permanently. Status/timestamps follow the lifecycle.
Optional notes are bounded to 500 characters and must contain no credentials.
Binding locks serialize revision changes and ingress; partial unique indexes prevent
competing ACTIVE/PREPARED rows. Composite Signal foreign keys tie numeric revision,
binding and revision-row identity together.

Revision actions emit `strategy_signal_revision_prepared`,
`strategy_signal_revision_activated` and `strategy_signal_revision_retired` with IDs
and numbers, never notes or credentials, in the same transaction.

Copy signal configuration remains deliberately tiny:

```json
{
  "externalStrategyKey": "momentum-stock",
  "strategyRevision": 2
}
```

## Owner APIs and console

SYSTEM_OWNER uses **System > External Signals**, `/system/external-signals`.
OPERATOR and ACCOUNT_USER cannot access it. Sections, filters, pagination and detail
state are URL-backed; there is no account selector. Sources and bindings are
configuration; Signals and Deliveries are immutable read-only evidence. Source
creation opens detail with the retrievable URL. Signals show fingerprints, hashes,
revision identity and formatted metadata. Deliveries show status, linked Signal,
redacted payload and useful rejection details; null/empty details are omitted.

Paths below are relative to `/api/external-signal-admin`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /sources, /bindings, /signals, /deliveries | Paginated/filterable lists |
| GET | /sources/:id, /bindings/:id, /signals/:id, /deliveries/:id | Read configuration/evidence |
| POST | /sources | name, provider, optional enabled; returns safe source DTO |
| PATCH | /sources/:id | name and/or enabled |
| GET | /sources/:id/webhook | Retrieve stable owner-only capability |
| POST | /sources/:id/regenerate-webhook | Deliberately invalidate URL; returns safe source DTO |
| POST | /bindings | source ID, Strategy ID, externalStrategyKey, optional enabled |
| PATCH | /bindings/:id | enabled only |
| GET | /bindings/:id/revisions | Newest-first history |
| POST | /bindings/:id/revisions | Optional changeNote, authorityMode, confirmTradeEligible; prepare next number, inheriting active authority by default |
| PATCH | /bindings/:id/revisions/:revisionId/authority | PREPARED only; authorityMode and deliberate confirmTradeEligible for promotion |
| POST | /bindings/:id/revisions/:revisionId/activate | Activate PREPARED |
| POST | /bindings/:id/revisions/:revisionId/retire | Abandon PREPARED |

All management routes require existing SYSTEM_OWNER authorization and return no-store.
No destructive or evidence-write APIs exist. The old rotate-token route is removed.
Lists return the resource plural plus pagination {page,pageSize,total,totalPages}.
Defaults: page 1, pageSize 25; max pageSize 100. Signal filters include source, Strategy,
Security/symbol, event, timeframe and from/to signalTime. Delivery filters include
source, status, rejectionCode, signalId and from/to receivedAt. Binding filters include
source and Strategy. Filter changes reset page while retaining pageSize.

For curl/Postman, create a test source and binding via the owner console/API, ensure
AAPL exists, save the example payload as signal.json and copy the source URL:

```bash
# Use a test source URL from the owner detail; do not paste it into shared logs.
curl "$TEST_SOURCE_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  --data-binary @signal.json
```

Set strategyRevision to the test binding's ACTIVE integer. A future TradingView or
TrendSpider sender maps its algorithm key, deployed revision, symbol, event, timeframe
and times into this same envelope. Neither provider needs event IDs or schema versions.

## Additive migration and historical compatibility

Do not rewrite applied migrations. `20260910120000_external_signal_provider_contract`
invalidates existing non-recoverable source hashes and adds encrypted-key storage.
It preserves source IDs, bindings, revisions, Signals and Deliveries. Existing local
URLs **stop working**. With the existing encryption environment configured, run:

```bash
npx prisma migrate deploy
npx prisma generate
npx tsx scripts/provision-external-signal-webhooks.ts
```

Provisioning generates/encrypts new random keys for migrated sources, emits only
sanitized provisioning events, and prints counts, not credentials. It is idempotent.
First owner retrieval also provisions a missing key under a row lock, so interrupted
provisioning fails closed and is recoverable. New source creation provisions eagerly.
Stop the old backend before migration and restart updated backend/UI together.
Retrieve the new URLs and update every local external alert. No old URL is recoverable.

Historical externalEventKey values remain unchanged; their eventFingerprint is null.
They do not participate in new fingerprint deduplication; no retroactive identity is invented.
New Signals have a generated fingerprint and null externalEventKey. Existing numeric
revision links remain intact. Earlier string labels remain legacyStrategyRevision
with null numeric relationships, as established by the prior additive migration.
No hashes, payloads or timestamps are rewritten. Legacy EVENT_KEY_CONFLICT and
UNSUPPORTED_SCHEMA_VERSION enum values remain readable/filterable for old Deliveries;
new ingress emits fingerprint conflicts and INVALID_ENVELOPE for supplied schemaVersion.

Validation covers full backend/frontend suites, PostgreSQL isolated migration,
concurrency, rollback, regeneration and history checks, type/build/lint checks,
Prisma validation/generation/drift and git diff --check. Database tests use
RUN_DATABASE_INTEGRITY_TESTS=1 and disposable schemas, never trading tables.


## Backend-owned signal authority

`SignalAuthorityMode` belongs to **StrategySignalRevision**, never the binding or
sender metadata. Revision 1 and every revision present before the authority migration
are `EVIDENCE_ONLY`. Preparing a revision inherits the ACTIVE revision's authority,
not the most recent abandoned candidate's authority. A prepared candidate can be
changed repeatedly, including downgrades. ACTIVE and RETIRED authority is immutable
in both the service and PostgreSQL; frozen revisions cannot be reopened.

| Authority | Current behavior |
| --- | --- |
| EVIDENCE_ONLY | Persist a STOPPED run with EVIDENCE_ONLY_AUTHORITY and zero routes |
| EVALUATION_ONLY | Resolve assignments, persist routes and bounded per-route evaluations, stop |
| TRADE_ELIGIBLE | Same evaluation behavior with separate historical authority, stop before execution |

In System -> External Signals -> binding detail, prepare a revision, review inherited
authority, optionally change it, configure the sender, and activate. Promoting to
TRADE_ELIGIBLE requires explicit UI acknowledgment and `confirmTradeEligible: true`
in the authority write API. The activation UI also requires acknowledgment for a
TRADE_ELIGIBLE candidate. The warning explains possible future trading after additional
gates and that the current implementation cannot trade. Activation freezes authority;
a later downgrade or promotion requires another prepared revision.

Authority writes and activation use the existing binding lock and transactional,
sanitized SystemEvents. `strategy_signal_revision_authority_changed` includes old/new
modes, binding/revision IDs and actor identity; activation records the frozen mode.
Notes, credentials and provider metadata are not copied into these audits. An audit
failure rolls back the authority change. Historical Signals use their exact revision,
including after retirement. Legacy Signals without numeric revisions fail closed with
`LEGACY_REVISION_NO_AUTHORITY`; current binding authority is never inferred for them.

## Deterministic assignment invariant

For each TradingAccount + Strategy + Security, at most one
**enabled TradingAccountSubscription** may exist. `enabled` is the existing master
assignment switch. Disabled historical alternatives coexist, and different accounts
can select different Subscription variants. The existing account/subscription unique
key remains in effect.

The schema adds `routingStrategyId` and `routingSecurityId` identity mirrors to
TradingAccountSubscription. A BEFORE trigger derives them from Subscription for every
insert/update, ignoring caller values. Their zero defaults are insertion placeholders
for existing Prisma callers; no zero identity is persisted. A composite foreign key
back to Subscription(id, strategyId, securityId) guarantees consistency, including
catalog identity changes via ON UPDATE CASCADE. A partial unique index on
(account, mirrored Strategy, mirrored Security) WHERE enabled enforces the invariant
under concurrency. This avoids a join-dependent check trigger with snapshot races,
while retaining existing Subscription and assignment management boundaries.

The invariant applies even if the catalog Subscription is disabled, so re-enabling
catalog configuration cannot reveal ambiguous enabled assignments. Routing additionally
requires Subscription.enabled. Account operational status, allocation state,
entriesEnabled, exitsEnabled, Strategy enablement, risk settings, broker credentials,
and position state are intentionally not routing filters: they are later evaluation
or execution gates. Being routed never establishes readiness or permission to enter.

Migration `20260913120000_signal_authority_routing` checks existing data under table
locks and fails atomically with an explicit conflict message. It never deletes or
reassigns configuration. Diagnose conflicts before deployment with:

```sql
SELECT a."tradingAccountId", s."strategyId", s."securityId",
       array_agg(a.id ORDER BY a.id) AS "assignmentIds"
FROM "TradingAccountSubscription" a
JOIN "Subscription" s ON s.id = a."subscriptionId"
WHERE a.enabled
GROUP BY a."tradingAccountId", s."strategyId", s."securityId"
HAVING count(*) > 1;
```

An operator must deliberately disable conflicting assignments before retrying.
Deploy the migration before the updated backend. No historical Signals or Deliveries
are rewritten. All existing revisions receive EVIDENCE_ONLY, including test bindings.
DBML is regenerated with Prisma; custom triggers, checks, and partial indexes are
maintained in SQL migrations and documented here.

## Immutable routing evidence and retry semantics

`SignalRoutingRun` has a unique signalId, frozen authority, terminal STOPPED/COMPLETED
status, timestamps, routeCount, and optional stopReason. `SignalRoute` records the
account ID, TradingAccountSubscription ID, Subscription ID and immutable target labels
plus Strategy/Security identity in targetSnapshot. Labels describe routing time;
management links open current configuration. There is no ELIGIBLE/BLOCKED state,
market regime, buying power, risk assessment, or entry decision on a route.

The independently callable `routeSignal` service wraps a transaction. Ingress calls
`routeSignalInTransaction` after normalization in the same transaction as Signal and
SignalDelivery creation. No worker or queue is needed. A Signal row lock serializes
concurrent callers, a unique run per Signal prevents duplicate runs, and a unique
account per run prevents duplicate account fan-out. A single matching query defines
the configuration snapshot. Any ambiguous account result fails closed.

The terminal run and all routes commit together. PostgreSQL prevents updating or
deleting either evidence model; deferred count checks prevent partial or later
appended fan-out. Route foreign keys preserve referenced assignments. Failed routing
rolls back the whole ingress transaction and returns the existing sanitized processing
failure response; it never reports success with partial routes. Retry the same delivery
or call the domain service after resolving the failure. A committed run is returned
unchanged even if assignment configuration has since changed.

Existing Signals are not bulk-routed by migration or a UI action. Detail shows them
as not processed until an explicit domain-service retry (or an accepted duplicate
webhook for that exact revision) creates their first result. Their original revision
is still authoritative. Zero matching assignments yields COMPLETED with zero routes;
that result is also final. No update/delete/re-route management API is exposed.

Signal detail displays the exact revision, authority, terminal result, reason, route
count and historical account -> assignment -> subscription -> Strategy -> Security chain.
Filters, pagination and detail navigation remain URL-authoritative. Routing evidence
is owner-only and read-only.

## Permanent rapid-fire TradingView harness

`external-signal-pipeline-test` remains a normal TradingView Dev binding. Its operator
may prepare an EVALUATION_ONLY revision and activate it to test TradingView -> Delivery
-> Signal -> authority -> immutable routes. Keep its source capability URL and update the
alert's numeric revision deliberately. No special case for this key exists in code.
`metadata.testMode`, comments, provider labels and other sender fields confer no
permission. Revision authority is the control; all current modes stop after evidence,
before trading. No broker credentials or live-trading flags need to change.

## Verification of the routing boundary

The PostgreSQL suite exercises migration conflict failure/backfill, concurrent enabled
assignment conflicts, catalog identity cascades, authority inheritance/freeze/audit
rollback, historical revision authority, both routable modes, zero routes, concurrent
retries, immutable snapshots and route insertion rollback. It runs real ingress and
routing for ENTRY_LONG and EXIT_LONG in an isolated schema **without** OrderIntent,
BrokerOrder or BrokerActivity tables. Position tables supply read-only evaluation context.
A dependency-boundary test
also limits routing imports and database capabilities so broker/entry/exit services
cannot be introduced unnoticed. UI tests cover inheritance, prepared-only controls,
deliberate promotion and activation confirmation, read-only targets and links.

## Exit ownership and position snapshots

`Subscription.exitManagementMode` is mutable catalog configuration:

| Mode | Normal strategy exit timing |
| --- | --- |
| BACKEND_MANAGED | Existing backend ExitProfile evaluation owns strategy exits (default). External EXIT_LONG is deliberately informational. |
| EXTERNAL_SIGNAL | Applicable external signals own normal strategy exit timing. This phase records evidence and does not execute those exits. |

The position synchronizer resolves originating context before creating a position.
The creation transaction inserts `PositionExitState.exitManagementModeSnapshot`
and `exitOwnershipProvenance` (account, assignment, subscription, strategy, security
IDs and resolution source) together with the TrackedPosition. Verified local order
or exact broker attribution can establish originating ownership; an unresolved or
unique-observer fallback position remains BACKEND_MANAGED. Later attribution recovery,
configuration snapshot hydration and lifecycle repair cannot promote its ownership.
The normal recovery helpers use BACKEND_MANAGED if lifecycle evidence is missing.

Changing Subscription mode affects future positions only. Existing snapshots and
origin evidence are protected against updates and standalone deletion in PostgreSQL.
Backend-owned positions keep their behavior even after their Subscription switches
to EXTERNAL_SIGNAL, and externally owned positions retain ownership after the reverse
change. Position details display the persisted ownership snapshot.

External ownership suppresses normal take-profit and target-triggered trailing-stop
activation. Existing configured protective stop-loss behavior remains available.
Protective-order synchronization still runs before strategy evaluation. Operator
closes, emergency risk reduction, reconciliation, recovery, verified broker quantities,
short prevention and account serialization retain their existing safety paths.
EXTERNAL_SIGNAL is not a prohibition against reducing risk.

## Per-route evaluation evidence, version 1

Each new `SignalRoute` records `evaluationVersion = 1`. A unique `signalRouteId`
identifies its authoritative `SignalEvaluation`. Account/subscription identity and
historical authority are inherited through immutable route/run/signal/revision
relations rather than copied into potentially conflicting columns.

Evaluation stores the event, ENTRY/EXIT intent, RISK_INCREASING/RISK_REDUCING
classification, processing status, optional domain outcome and reason, timestamps,
version, prospective entry ownership or matched position/exit-state IDs and ownership.
`SignalEvaluationGate` records unique contiguous sequences, gate keys, results,
bounded allowlisted evidence (maximum 4096 bytes), reasons and evaluation timestamps.
PostgreSQL prevents edits/deletes and enforces complete gate counts at commit,
including prevention of later appended gates.

Processing is synchronous and terminal-only: COMPLETED or FAILED. No committed
IN_PROGRESS row is needed for this bounded version. FAILED has no domain outcome;
structural/system problems emit sanitized SystemEvent diagnostics. COMPLETED has:

| Outcome | Meaning |
| --- | --- |
| ELIGIBLE | Applicable candidate for a future pipeline; not order approval or execution permission. |
| BLOCKED | A current assignment control prevents applicability. |
| NO_ACTION | Valid event requires no action, such as no matching position or a backend-owned external exit. |

Authority is not a gate. EVALUATION_ONLY + ELIGIBLE is expected, as is
TRADE_ELIGIBLE + ELIGIBLE. Neither authorizes anything in this phase. Historical
revision authority can never increase through later configuration edits; a future
execution boundary must revalidate current safety controls, which may revoke
actionability even for historical TRADE_ELIGIBLE evidence.

ENTRY_LONG gates: ROUTE_TARGET integrity → SUBSCRIPTION_ACTIVE (`enabled`) →
ALLOW_NEW_ENTRIES (`entriesEnabled`) → ENTRY_APPLICABILITY. Passing yields ELIGIBLE
and records the current prospective exit mode without creating a position.

EXIT_LONG gates: ROUTE_TARGET → SUBSCRIPTION_ACTIVE → ALLOW_EXIT_MANAGEMENT
(`exitsEnabled`) → MATCHING_POSITION → EXIT_MANAGEMENT_MODE. Position matching
requires the same account, originating assignment, subscription and security, long
side and open status. No symbol-only match is used. Multiple matches are FAILED /
AMBIGUOUS_MATCHING_POSITIONS; no match is NO_ACTION / NO_MATCHING_OPEN_POSITION.
Missing exit evidence is FAILED. BACKEND_MANAGED is deliberately NO_ACTION /
EXTERNAL_EXIT_NOT_APPLICABLE with no alarming event. EXTERNAL_SIGNAL additionally
requires frozen origin IDs to match, so later mutable strategy changes cannot
redirect a historical position; it then yields ELIGIBLE and stops.

`signal-evaluation.service.ts` provides a callable transaction boundary and a
transaction-scoped evaluator. Route locks serialize retries and concurrent callers.
Ingress evaluates only newly normalized routes, using per-route savepoints to retain
Signal/Delivery/routing evidence when evaluation processing fails. If the database
cannot persist even the sanitized failure, the transaction fails rather than claiming
success. Committed failures are terminal and are not silently re-evaluated later.

Existing routes keep null evaluationVersion. Migration, duplicate delivery handling
and explicit evaluator calls do not evaluate them using current configuration.
The UI labels them “Not evaluated — predates SignalEvaluation.” No worker, bulk
backfill or mutation API exists. Route-only domain-service calls remain independently
testable; versioned routes may subsequently be evaluated explicitly.

System → External Signals shows each target's read-only evaluation, separate authority,
classification, status/outcome/reason, ordered gates and bounded evidence, timestamps,
prospective ownership or position snapshot. Existing URL navigation remains authoritative.

Migration `20260914120000_signal_evaluation_exit_ownership` defaults all existing
Subscriptions and PositionExitStates to BACKEND_MANAGED and creates missing lifecycle
rows for existing positions with that same safe ownership. It does not evaluate old
routes or alter trading permissions. Deploy the migration before the backend/UI.

No Market Regime, freshness thresholds, sizing, buying-power, exposure, daily-entry,
broker-readiness or other pipeline risk gates are introduced. No OrderIntent, broker
submission, sell activity or position/exit-state mutation may originate from evaluation.
Future entry/exit handoffs must use the existing authoritative safety pipelines;
those handoffs are intentionally absent here.
