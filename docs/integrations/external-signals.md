# External signal ingestion - Phase 1

External Signals are immutable, account-independent strategy evidence. **They cannot
trade.** Neither ENTRY_LONG nor EXIT_LONG invokes evaluation, subscription matching,
risk gates, entry decisions, order intents, brokers or position/exit pipelines.
The existing n8n `/api/signals` trading pipeline remains separate.

## Operator workflow

1. Create an ExternalSignalSource, for example TradingView Production.
2. Copy its stable webhook URL from source detail.
3. Create a StrategySignalBinding by selecting an existing source and Strategy and
   entering a stable algorithm key. AI Trader automatically creates ACTIVE Revision 1.
4. Configure the external strategy with the key and backend-assigned revision.
5. Send the minimal JSON payload below to the source URL.
6. AI Trader authenticates, resolves the binding and Security, normalizes the event,
   derives its fingerprint, and stores Signal/Delivery evidence. Processing stops there.

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

AI Trader may later combine resolved Strategy and Security to find backend-owned
Subscriptions. This phase implements no Subscription linkage or trading authority.

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

Identity, revision numbers and notes are fixed. Only status/timestamps advance.
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
| POST | /bindings/:id/revisions | Optional changeNote; prepare next backend-assigned number |
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
