# External signal ingestion — Phase 1

Phase 1 records recognized external strategy events. **It cannot trade.** Neither
`ENTRY_LONG` nor `EXIT_LONG` invokes entry evaluation, subscriptions, risk gates,
order creation, broker APIs, position tracking, or exit evaluation. The existing
n8n `/api/signals` trading contract remains separate and unchanged.

```text
POST webhook -> token authentication -> validation / normalization / binding
             -> atomic Signal + terminal SignalDelivery -> STOP
```

## Configuration and evidence

| Model | Purpose | Mutation policy |
| --- | --- | --- |
| ExternalSignalSource | Named origin, provider label, enabled flag, hashed URL credential | Rename, enable/disable, rotate credential |
| StrategySignalBinding | Source/key identity mapped to an existing Strategy and required revision | Change only enabled or expectedRevision |
| SignalDelivery | Terminal known-source request evidence | Insert/read only |
| Signal | Canonical account-independent strategy event | Insert/read only |

Provider labels are `TRADINGVIEW`, `TRENDSPIDER`, and `GENERIC_WEBHOOK`; all use the
same envelope and `URL_TOKEN` authentication. There are no provider adapters.
Source/key uniqueness prevents silent rebinding. No deletion endpoints exist.
New binding keys are normalized on owner API/UI creation: trim, lowercase, replace
whitespace runs with `-`, and collapse repeated `-`. The result must be 1–200 ASCII
letters, digits, hyphens, or underscores; other characters are rejected, not removed.
For example, `  ETF  -- Mean_Reversion  ` becomes `etf-mean_reversion`. The creation
form previews the exact key to use in webhook envelopes. Two inputs that normalize
to the same key for one source collide with HTTP 409. Existing keys are not migrated
or editable, and webhook lookup retains its prior exact-key semantics.
All new foreign keys restrict deletion and identity updates. Existing Strategies
and Securities are referenced, never created from webhook input. Their trading
eligibility/enabled flags are not signal-ingestion policy.

Signal preserves source, binding, Strategy, Security, canonical symbol, revision,
and event content directly. Configuration changes never rewrite prior evidence.
Application immutability is enforced by insert/read-only service paths and APIs;
this migration does not install database update/delete prohibition triggers.
Privileged direct SQL must continue to respect audit-sensitive history.

## Canonical Signal Envelope v1

```json
{
  "schemaVersion": 1,
  "externalStrategyKey": "etf_mean_reversion",
  "strategyRevision": "2026-09-07.1",
  "event": "ENTRY_LONG",
  "symbol": "QQQ",
  "timeframe": "15m",
  "signalTime": "2026-09-07T15:45:00Z",
  "barTime": "2026-09-07T15:30:00Z",
  "eventKey": "mr1:QQQ:15m:20260907T1530:ENTRY_LONG:2026-09-07.1",
  "metadata": { "triggerPrice": 600.25, "rsi": 28.4 }
}
```

Only `barTime` and `metadata` are optional. Unknown top-level fields are rejected,
including account IDs and execution instructions. Only `ENTRY_LONG` and
`EXIT_LONG` are supported. Symbol is trimmed, uppercased and resolved against
`Security.symbol`; unknown symbols are rejected.

Canonical timeframes: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w`.
Explicit aliases are accepted: `1 minute`, `5 minutes`, `15 minutes`, `30 minutes`,
`60m`, `1 hour`, `240m`, `4 hours`, `1 day`, `1 week`. Bare numeric values such as
`60`, uppercase `1M`, and other ambiguous/provider-specific values are rejected.

Timestamps must be valid ISO calendar timestamps with `Z` or a numeric offset,
at most millisecond precision, and at or after the Unix epoch. They normalize to
UTC. `barTime` must not exceed `signalTime`; `signalTime` may not be more than
five minutes ahead of receipt (clock-skew allowance). There is **no age/staleness
rejection**: old legitimate events remain historical evidence. `receivedAt` is
the server receipt time and is stored on the delivery separately.

Metadata must be a JSON object of at most 4,096 UTF-8 bytes. Request JSON nesting
is limited to 16 levels. Metadata is descriptive only; even keys such as quantity
or account ID inside metadata cannot cause execution. Credential-bearing content
is rejected anywhere in the envelope and scrubbed from delivery evidence.

## Authentication and transport

`POST /api/external-signals/:token` requires no human session or legacy signal key.
Tokens contain 32 cryptographically random bytes encoded as base64url; only their
SHA-256 hashes are stored. Creation/rotation responses return `{ source, token }`
with `Cache-Control: no-store`. Store that credential securely at the sender.
Rotation invalidates the old token, including requests still reading their body.

Unknown or malformed tokens return 401 and create no SignalDelivery. Known disabled
sources create rejected deliveries. Authentication precedes body processing;
configuration is checked again in the persistence transaction.

The endpoint accepts only uncompressed UTF-8 `application/json` (optionally
`charset=utf-8`), at most 65,536 bytes. A streaming SHA-256 covers the exact body
bytes, including whitespace, for complete requests. Oversized requests are hashed
while drained, with no retained body. Body reception has a 10-second deadline;
aborted/incomplete transport yields an operational failure, not a fabricated
complete-body hash or terminal delivery.

Parseable bounded JSON is recursively redacted for common secret fields and
credential patterns, including known source token/hash values. Invalid JSON,
unsupported content types, and oversized body text are omitted from evidence.
Headers are not stored; only the recognized normalized content type is retained.
Request IDs are server-generated UUIDs, not caller-provided strings.

Application request logs redact the entire ingress URL suffix, including queries,
for success, rejection, malformed paths and unsupported methods. Errors never log
raw ingress parser/database exceptions. The checked-in Caddyfile does not enable
access logging. Any added proxy, tunnel, APM or access logging must also redact URL
credentials. HTTPS terminates at the deployment boundary. No shared application
ingress rate limiter currently exists; no parallel limiter is introduced here.

## Idempotency and rejection

The sender must reuse one deterministic `eventKey` for retries. Uniqueness on
`(signalSourceId, externalEventKey)` is the final database concurrency guard.

| Request | Evidence | HTTP |
| --- | --- | --- |
| New valid event key | New Signal and NORMALIZED Delivery in one transaction | 201 |
| Existing key, identical normalized content | DUPLICATE Delivery linked to original Signal | 200 |
| Existing key, different normalized content | REJECTED / EVENT_KEY_CONFLICT, no accepted Signal link | 400 |
| Known-source invalid request | REJECTED Delivery, no Signal | 400 (413 if oversized) |
| Unknown credential | No durable delivery | 401 |
| Unexpected processing/database failure | Sanitized error event when storage is available | 503 |

Canonical hashing covers all accepted Signal content, resolved IDs, UTC timestamps
and metadata with recursively sorted JSON keys. JSON field ordering, safe timeframe
aliases, symbol casing and equivalent timestamp offsets cannot change the hash.
Missing metadata/barTime normalize to null. A losing concurrent insert rolls back
and compares the winning row in a new transaction. Delivery insertion failure also
rolls back the new Signal. Retries still need an enabled source/binding and the
current expected revision; a revision change does not grandfather old retries.

Rejection codes are `SOURCE_DISABLED`, `INVALID_CONTENT_TYPE`, `INVALID_JSON`,
`PAYLOAD_TOO_LARGE`, `UNSUPPORTED_SCHEMA_VERSION`, `INVALID_ENVELOPE`,
`UNKNOWN_STRATEGY_BINDING`, `STRATEGY_BINDING_DISABLED`,
`STRATEGY_REVISION_MISMATCH`, `UNKNOWN_SYMBOL`, `INVALID_EVENT`,
`INVALID_TIMEFRAME`, `INVALID_TIMESTAMP`, and `EVENT_KEY_CONFLICT`.
Structured details contain safe field/reason information. Public rejection responses
only expose a generic error and requestId; owners inspect the delivery for details.
New rejections include concise diagnostic context: catalog/binding lookup reasons,
the binding ID for a revision mismatch, supported event/schema/timeframe values,
validation issue codes, body limits, and timestamp ordering/skew reasons. Event-key
conflicts identify the existing Signal ID and differing canonical field names.
Details intentionally do not copy free-form payload/configuration values, credentials,
hashes, authorization headers, or parser messages. When no meaningful detail exists,
SQL null is stored rather than `{}`. The delivery drawer omits null/empty rejection details,
including older empty objects; previously persisted evidence is never rewritten.

There are no normal-success SystemEvents. Conflicts emit
`external_signal_event_key_conflict` with WARNING severity. Unexpected failures emit
`external_signal_processing_failed` with ERROR severity. Configuration transactions
emit `external_signal_source_created`, `external_signal_source_updated`,
`external_signal_source_credential_rotated`, `strategy_signal_binding_created`, or
`strategy_signal_binding_updated`, with actor attribution and changed fields but no
credentials. Updates include enable/disable and expected-revision changes.

## Owner console

SYSTEM_OWNER users can open **System → External Signals** at
`/system/external-signals`. OPERATOR and ACCOUNT_USER cannot see the navigation
item or access the route directly. This is a global system page with no trading
account scope selector.

The four tabs separate mutable configuration from immutable evidence:

- **Sources:** create, inspect, rename, enable/disable, or rotate a webhook token.
  Enable/disable and rotation require confirmation. Creation and rotation open a
  one-time credential dialog with Copy Token and Copy Webhook URL actions. The URL
  follows `VITE_API_BASE_URL`, falling back to the current origin. Closing the
  dialog clears the plaintext; the normal source view can never reveal it. Lost
  tokens must be rotated, and rotation invalidates the old credential immediately.
- **Strategy Bindings:** select an existing source and Strategy, then supply the
  external key and expected revision. Editing allows only revision/enabled changes,
  with acknowledgment that future acceptance changes. Existing identity fields are
  read-only. Strategy names link to their normal detail page.
- **Signals:** filter and page through canonical events, then open a read-only
  detail drawer with metadata JSON, identifiers, timestamps, event key, and hash.
  “View related deliveries” opens the delivery list filtered to that Signal.
- **Deliveries:** filter by source, processing status, rejection code, linked
  Signal, and received-time bounds. Details show redacted payload/rejection JSON,
  raw hash, size, and timestamps. Normalized/duplicate deliveries link to their
  Signal. A rejected delivery with no Signal is displayed as not normalized.

Tabs (`section`), applied filters, `page`, `pageSize`, and selected detail (`detail`)
are URL-authoritative. Example bookmarks:

```text
/system/external-signals?section=signals&symbol=QQQ&event=ENTRY_LONG&pageSize=50
/system/external-signals?section=signals&detail=42
/system/external-signals?section=deliveries&signalId=42
```

Apply filters to commit draft fields to the URL. Filters and section changes reset
the page while preserving page size. Back/Forward and refresh restore the view.
Date controls use the browser's local time and send UTC ISO bounds. Desktop views
use the shared data table; compact/mobile views use record cards and detail drawers.
Long technical values wrap in details and support copying; JSON is formatted.

The UI lives in `apps/web/src/features/externalSignals/` with feature-local HTTP
DTOs, API clients, TanStack Query hooks, URL helpers, Mantine components and CSS
modules. It reuses the existing Strategy catalog and loads all source catalog pages.
Configuration mutations invalidate only the relevant source/binding queries.
Plaintext webhook credentials are passed directly into transient dialog state and
are not returned as mutation data, used as mutation variables, or written to query
data, storage, URLs, or logs. Credential mutations also reset when the dialog closes.
The console exposes no execution, replay, Signal/Delivery edit or deletion actions.

## Owner APIs and a test sender

All management/read APIs live under `/api/external-signal-admin` and require
SYSTEM_OWNER via the existing admin API key or owner session bearer token.

| Method | Suffix | Behavior |
| --- | --- | --- |
| GET | /sources, /bindings, /deliveries, /signals | Paginated lists |
| GET | /sources/:id, /bindings/:id, /deliveries/:id, /signals/:id | Read one |
| POST | /sources | name, provider, optional enabled |
| PATCH | /sources/:id | name and/or enabled |
| POST | /sources/:id/rotate-token | Return replacement token once |
| POST | /bindings | signalSourceId, strategyId, externalStrategyKey, expectedRevision, optional enabled |
| PATCH | /bindings/:id | expectedRevision and/or enabled |

Lists return the plural resource key plus
`pagination: { page, pageSize, total, totalPages }`; defaults are page 1 and size 25,
maximum size 100, sorted by descending ID. Sources filter by `signalSourceId`;
bindings by `signalSourceId`/`strategyId`. Deliveries filter by `signalSourceId`,
`signalId`, `status`, `rejectionCode`, `from`, `to` (receivedAt). Signals filter by
`signalSourceId`, `strategyId`, `securityId`, `symbol`, `event`, `timeframe`, `from`,
`to` (signalTime). Date bounds are inclusive, offset-bearing ISO timestamps.

Example using shell variables (or equivalent Postman environment variables):

```sh
# Set BASE_URL and ADMIN_API_KEY for your test environment.
curl "$BASE_URL/api/external-signal-admin/sources" \
  -H "ai-trader-api-key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  --data '{"name":"Phase 1 test","provider":"GENERIC_WEBHOOK"}'

# Use the returned source ID and an existing Strategy ID. QQQ must already exist.
curl "$BASE_URL/api/external-signal-admin/bindings" \
  -H "ai-trader-api-key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  --data '{"signalSourceId":1,"strategyId":1,"externalStrategyKey":"etf_mean_reversion","expectedRevision":"2026-09-07.1"}'

# Set TEST_WEBHOOK_TOKEN to the one-time token; save the example envelope above as signal.json.
curl "$BASE_URL/api/external-signals/$TEST_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @signal.json

# Repeat exactly: expect DUPLICATE. Change metadata with the same key: expect rejection.
curl "$BASE_URL/api/external-signal-admin/deliveries?signalSourceId=1&pageSize=25" \
  -H "ai-trader-api-key: $ADMIN_API_KEY"
```

A future TradingView or TrendSpider sender supplies its strategy identity/revision,
maps provider event names to ENTRY_LONG/EXIT_LONG, maps intervals to the canonical
vocabulary, supplies actual observation/event timestamps, and emits a deterministic
key. Provider alert IDs may form part of that key if stable across retries. No
provider identity or execution authority is inferred from metadata.

## Deployment and verification

Apply `20260907120000_external_signal_ingestion` through the normal Prisma migration
deployment workflow and regenerate the Prisma client before starting this backend.
The migration is additive; there is no backfill, historical rewrite or trading
configuration change. The owner console additionally requires building and deploying
`apps/web` using the normal frontend deployment workflow; it requires no further
backend changes or migrations.

Run `npm run check`, `npm test`, `npm run build`, `npx prisma validate`, and
`git diff --check`. There is no separate backend lint script. Real database tests:

```powershell
$env:RUN_DATABASE_INTEGRITY_TESTS = '1'
npm.cmd test -- src/db/__tests__/external-signal-ingestion.integration.test.ts
```

These tests create/drop a random isolated PostgreSQL schema, apply the actual new
migration, and exercise concurrent duplicate/conflicting requests, atomic rollback,
restrictive foreign keys, and ingestion in a schema with no trading tables.
Frontend verification from `apps/web`: `npm test`, `npm run lint`, and
`npm run build`. Tests cover owner-only access, configuration workflows, one-time
credential cleanup/cache boundaries, evidence-only actions, formatted JSON,
URL navigation/filters/pagination, API-origin handling, and narrow-screen cards.
Future phases own subscription fan-out, strategy eligibility, market regime,
staleness policy, entry decisions, sizing, risk evaluation and paper/live execution.
