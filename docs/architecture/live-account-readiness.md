# Live Trading Account readiness

Phase 5A persists immutable completed readiness assessments as capability and
posture evidence. It does not activate accounts, repair lifecycle records,
replace credential verification, synchronize broker state, or authorize a
write.

## Execution and safety

A dedicated PostgreSQL advisory-lock family is scoped by Trading Account ID and
held on one database session through local inspection, broker reads, snapshot
capture, diagnostic reconciliation, persistence, and audit recording. Lock
contention does not create an assessment. No mutable `RUNNING` row is used.

Accounts without usable credentials still receive useful local gate results and
a `BLOCKED` assessment. No Alpaca client is constructed in that path. When
credentials are usable, the service uses only existing account-scoped
`LIFECYCLE_READ` adapters, records a fresh account snapshot, observes positions
and open orders, and runs reconciliation as a pure comparison. It does not
persist reconciliation events, attention changes, cursor changes, ownership
repairs, or lifecycle transitions.

Assessment JSON stores safe stage, gate, blocker, warning, reconciliation, and
evidence summaries. It excludes plaintext or encrypted credentials,
authorization headers, and broad raw broker responses. A safe SystemEvent
records the assessment ID, outcome, stage counts, actor, expiration, and
fingerprint prefixes.

## Stages and validity

Stages are `CREDENTIALS_CONFIGURED`, `CREDENTIALS_VERIFIED`,
`READ_ONLY_READY`, `CONFIGURATION_READY`, `RISK_REDUCING_READY`,
`ACTIVATION_READY`, and `ENTRY_READY`. `LIVE_ACTIVATION` overall status follows
`ACTIVATION_READY`; entry posture remains separately disarmed.

Three deterministic SHA-256 fingerprints cover readiness configuration, safe
credential metadata, and the effective `ALLOW_LIVE_TRADING` and
`ALLOW_LIVE_RISK_REDUCING_WRITES` policy values. Historical rows never change.
Reads compare current fingerprints and report `CURRENT`, `STALE`, or `EXPIRED`
plus configuration, credential, and policy stale reasons. Expiration (five
minutes) takes display precedence. Credential verification freshness is 15
minutes and readiness never updates `verifiedAt`.

## Explicit Phase 5A exclusions

Live activation, account-scoped write approval, risk-reducing authorization,
lifecycle exercises, credential entry, assignment provisioning, order entry,
order cancellation, position closing, protective orders, and the first Live
entry remain future work.
