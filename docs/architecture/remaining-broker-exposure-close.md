# Remaining Broker Exposure Close

This stacked feature adds a narrow, operator-initiated recovery path for a canonical long lifecycle after one or more attributed exit fills have already reduced Alpaca exposure. It depends on `feat/exit-submission-safety` and must not merge before that parent passes its regular-session Paper verification and merges to `main`.

## Safety equation

Corrective execution is eligible only when durable broker activities prove, with exact decimal arithmetic:

```text
tracked quantity = attributed sell-fill quantity + expected remainder
expected remainder = Alpaca held quantity = Alpaca available quantity > 0
```

Broker activities qualify only when they are account-scoped, unique Alpaca `FILL` rows durably linked to the same `TrackedPosition`. Their raw broker JSON supplies the original decimal quantity string. Unlinked external fills, malformed quantities, zero prior fills, over-attribution, shorts, absent positions, reserved shares, and unexplained broker excess or deficit all fail closed. The workflow never derives attribution from symbol/time proximity or arithmetic difference alone.

## Preview and execution

`GET /api/operational-attention/:id/remaining-exposure-close-preview` is available to users with Operational Attention read access within their account scope. It returns sanitized lifecycle, broker, active-order, regular-session, deployment, and authorization conclusions with a 30-second evidence fingerprint.

`POST /api/operational-attention/:id/remaining-exposure-close` is System Owner only. The request contains only the attention revision and preview fingerprint. Under the account-scoped `EXIT_SUBMISSION` lock, the server recovers the deterministic attempt first, then re-fetches all lifecycle and broker evidence, checks preview freshness, verifies the regular session and final Live `RISK_REDUCING` authorization, creates the server-derived `OrderIntent`, and submits market/DAY `sell_to_close` for the complete verified remainder.

Attempt IDs include the attention episode, tracked position, and evidence revision. Retries recover the same attempt. A partial fill that later cancels must first be imported and attributed, materially revise the attention evidence, and produce a new preview; the new revision produces a distinct client order ID. Active or delivery-uncertain attempts block another submission. No order is automatically canceled, replaced, or retried.

## Lifecycle integrity

Submission, acceptance, and partial fills do not resolve the attention episode. Resolution occurs only after the broker position is absent, the position sync closes the local lifecycle, all sell fills are attributed, their exact total equals the immutable canonical tracked quantity, and no corrective order remains active. Broker zero with incomplete attribution stays visible as a lifecycle discrepancy.

Trade-cycle realized P&L and return remain `null` until a closed lifecycle has complete attributed close quantity. Once complete, average exit price uses every attributed exit fill, including prior and corrective fills. `TrackedPosition.qty`, fill prices, closure timestamps, and realized P&L are never manufactured or rewritten to match Alpaca.

## Explicit exclusions

This is not a generic flatten control. It does not close unexplained excess, cover shorts, accept browser quantity, support partial operator-selected exits or extended hours, bypass verification, cancel conflicting orders, or grant Live authority. Live writes require production `PRODUCTION_EXECUTOR`, deployment risk-reducing policy, current account credentials, and effective `RISK_REDUCING` approval. Development Live views are observation-only.
