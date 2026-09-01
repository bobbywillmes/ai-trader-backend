# Remaining Broker Exposure Close

This stacked feature adds a narrow, operator-initiated recovery path for a canonical long lifecycle after one or more attributed exit fills have already reduced Alpaca exposure. It depends on `feat/exit-submission-safety` and must not merge before that parent passes its regular-session Paper verification and merges to `main`.

## Safety equation

Corrective execution is eligible only when durable broker activities prove, with exact decimal arithmetic:

```text
tracked quantity = attributed sell-fill quantity + expected remainder
expected remainder = Alpaca held quantity = Alpaca available quantity > 0
```

Broker activities qualify only when they are account-scoped, unique Alpaca `FILL` rows durably linked to the same `TrackedPosition`. Their raw broker JSON supplies the original decimal quantity string. Unlinked external fills, malformed quantities, zero prior fills, over-attribution, shorts, absent positions, reserved shares, and unexplained broker excess or deficit all fail closed. The workflow never derives attribution from symbol/time proximity or arithmetic difference alone.

Activity identity is `broker + mode + activityId`. Repeated identical copies are counted once; duplicate identities with conflicting individual quantities fail closed. Only individual activity `qty` participates in the equation. Cumulative `cumQty` and `leavesQty` may prove broker-order completion elsewhere, but are never summed as individual lifecycle fills.

## Preview and execution

`GET /api/operational-attention/:id/remaining-exposure-close-preview` is available to users with Operational Attention read access within their account scope. It returns sanitized lifecycle, broker, active-order, regular-session, deployment, and authorization conclusions with a 30-second evidence fingerprint.

`POST /api/operational-attention/:id/remaining-exposure-close` is System Owner only. The request contains only the attention revision and preview fingerprint. Under the account-scoped `EXIT_SUBMISSION` lock, the server recovers the deterministic attempt first, then re-fetches all lifecycle and broker evidence, checks preview freshness, verifies the regular session and final Live `RISK_REDUCING` authorization, creates the server-derived `OrderIntent`, and submits market/DAY `sell_to_close` for the complete verified remainder.

Attempt IDs include the attention episode, tracked position, and evidence revision. Retries recover the same attempt. A partial fill that later cancels must first be imported and attributed, materially revise the attention evidence, and produce a new preview; the new revision produces a distinct client order ID. Active or delivery-uncertain attempts block another submission. No order is automatically canceled, replaced, or retried.

## Lifecycle integrity

Submission, acceptance, and partial fills do not resolve the attention episode. Resolution occurs only after the broker position is absent, the position sync closes the local lifecycle, all sell fills are attributed, their exact total equals the immutable canonical tracked quantity, and no corrective order remains active. Broker zero with incomplete attribution stays visible as a lifecycle discrepancy.

Trade-cycle realized P&L and return remain `null` until a closed lifecycle has complete attributed close quantity. Once complete, average exit price uses every attributed exit fill, including prior and corrective fills. `TrackedPosition.qty`, fill prices, closure timestamps, and realized P&L are never manufactured or rewritten to match Alpaca.

## Explicit exclusions

This is not a generic flatten control. It does not close unexplained excess, cover shorts, accept browser quantity, support partial operator-selected exits or extended hours, bypass verification, cancel conflicting orders, or grant Live authority. Live writes require production `PRODUCTION_EXECUTOR`, deployment risk-reducing policy, current account credentials, and effective `RISK_REDUCING` approval. Development Live views are observation-only.

## Safe verification

There is no deterministic real Paper exercise for this state. It requires a naturally occurring partial fill from an AI Trader-owned close order, durable import of each individual fill, cancellation or terminalization of the unfilled remainder, and exact agreement with the remaining long broker position. An Alpaca-console sell is external evidence and must remain ineligible; intentionally seeking a market partial fill is unpredictable and unsafe.

Broker-mocked integration tests and isolated test databases are therefore authoritative. Manual UI verification should use existing local fixtures or test mocks to inspect eligible, blocked, expired, rejected, uncertain, recovered, and responsive states without enabling trading or changing stored lifecycle evidence. In real operation the panel becomes eligible only after the canonical partial-close condition occurs naturally and reconciliation opens an unresolved, account-scoped exit-verification episode.

## Historical stale-order diagnostic

The reconciliation message “terminal lifecycle evidence but remains nonterminal locally” refers specifically to a nonterminal local `BrokerOrder` status. `FULL_FILL_LOCAL_EVIDENCE` means its linked activity stream contains a terminal cumulative fill marker; it does not mutate the historical row during the read-only diagnostic. Current activity ingestion terminalizes the linked `BrokerOrder` and `OrderIntent`, but old activity outside the normal overlap window can retain legacy status.

`POSITION_LINK_MISSING` means no existing position link was present and no unique entry-position candidate satisfied account, broker, symbol, subscription, assignment, quantity, price, and five-second completion-time tolerances. For full local fill evidence, `brokerLookup: null` is intentional: the diagnostic already has terminal evidence and reserves bounded broker lookups for candidates lacking it.

This warning does not create OperationalAttention because stale historical order status is not an actionable reconciliation projection rule and its severity is `WARN`. A duplicate finding event inside the deduplication window is correctly counted as skipped. The stale BUY row is not an active broker reservation and does not by itself affect verified exits, corrective eligibility, close-fill attribution, trade-cycle P/L, or broker open-order checks. It does keep reconciliation health visibly non-clean and should be handled, if desired, as a separate reviewed historical lifecycle-repair task rather than automatic remediation in this workflow.
