# PAPER broker-write deployment authority

Phase 3C.4 adds a final, deployment-owned authority boundary for Alpaca PAPER
writes. It is intentionally independent of entry policy, lifecycle policy and
Market Intelligence.

## Boundaries

- Global `tradingEnabled` and the account status/kill switch are entry controls.
  They do not prove that a deployment owns a broker account and do not authorize
  protective, close or cancellation writes.
- LIVE writes retain their existing deployment role, environment flags, approval,
  arming and risk controls.
- PAPER writes require this deployment to be a `PAPER_EXECUTOR`, require the
  resolved local TradingAccount to have exactly one `EXECUTOR` ownership declaration whose
  expected broker account matches, and require an exact environment allowlist match
  on both the verified Alpaca `account_number`
  (not the account UUID)
  and the active API-key fingerprint.
- A `TradingAccount.id`, account activation, credential availability, or a mutable
  application setting never grants PAPER broker-write authority. Ownership and the
  identity allowlist are independent deny-only requirements; neither grants authority alone.
- Every ownership declaration includes the expected Alpaca `account_number`. An
  identity declared `OBSERVER` is excluded from execution through every other local
  account. Duplicate verified brokerage identities across local PAPER accounts and
  OBSERVER/EXECUTOR contradictions are unresolved and fail closed.

The check runs in `alpacaRequestForAccount` after account-scoped credentials are
resolved and before request preparation, usage accounting or `fetch`. Its final
database lookup verifies that exactly one local PAPER account carries the resolved
brokerage identity. A lookup failure blocks the write. This adds one identity read
to each PAPER mutation; it is not raced or abandoned, never grants authority, and
preserves the exact account/fingerprint checks. It covers
all broker mutations: entry order creation, verified market closes, protective
trailing-stop creation, individual order cancellation and cancel-all. Reads of
accounts, positions, orders, activities, clock and calendar remain available.

Actual HTTP method is authoritative. POST, PATCH and DELETE requests must declare
`critical_write`, a write operation class and a method-matching endpoint. Metadata
cannot recast a mutation as a read.

## Identity and refusal semantics

Credential verification reads Alpaca's account response and stores
`TradingAccount.brokerAccountId`; credential storage computes the non-secret
`keyFingerprint`. An authorization binds both values. Missing evidence, a changed
key, a different broker account, an observation-only role, or no exact allowlist
match fails closed.

Local refusal raises `BrokerWriteDeliveryError` with `NOT_SENT_BLOCKED`. Because it
occurs before `fetch`, entry dispatch records it as definite local non-delivery and
does not create a submitted broker order. Verified-exit and protective-order flows
preserve their existing durable failure/attention evidence and do not reinterpret
the refusal as `DELIVERY_UNCERTAIN`.

Production owns Bobby Paper. Development observes and reconciles Bobby Paper but
must use `OBSERVATION_ONLY`. A future development validation executor may allowlist
only a separately verified validation brokerage identity; Bobby Paper remains
blocked on that deployment.

Readiness exposure is deliberately conservative. Open/closing positions,
nonterminal broker orders, unresolved intents, unlinked filled BUY intents and active
entry claims count. A filled SELL does not; a filled BUY already linked to a tracked
position is represented by that position instead of being double-counted. Broker
positions not yet synchronized locally remain a residual risk, so operator broker
GET verification is required before deployment and after recovery.
