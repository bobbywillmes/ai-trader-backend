# Live Entry Arming

```text
EFFECTIVE ENTRY APPROVAL != ARMED ENTRY AUTHORITY
ACTIVE != ENTRY ARMED
```

A new Live position requires deployment permission, effective RISK_REDUCING and ENTRY approvals, an active immutable `LiveEntryArming` bound to those exact approval revisions, the exact armed `rsp_dip_core` assignment, permissive account latches, and runtime risk/session eligibility.

## First-canary lifecycle

- `ACTIVE · ENTRY DISARMED`: latches closed; no active binding.
- `ACTIVE · ENTRY STAGED`: only `rsp_dip_core` is entry-enabled; latches closed.
- `ACTIVE · ENTRIES ARMED`: a PASSED/CURRENT post-grant assessment was consumed by explicit ARM.
- Consumed, expired, revoked, stale, or mismatched authority returns locally to disarmed posture.

Arming rows are never overwritten. Termination rows preserve `DISARMED`, `INVALIDATED`, `EXPIRED`, and `CONSUMED` history. Replacement approval revisions cannot inherit old arming.

## One-shot boundary

Immediately before a Live new-entry POST, the system reloads the submitting intent, assignment, account, approvals, arming, credentials, and fingerprints. Local rejection does not consume authority. An authorized outbound attempt persists `CONSUMED`, closes latches, clears the active binding, and disables entries before POST. Broker rejection, timeout, ambiguity, or process failure cannot make the arming reusable; stable `client_order_id` recovery must not issue another POST.

## Locking

ARM acquires `ORDER_LIFECYCLE` before `OPERATIONAL_STATE`, then uses a serializable account-row transaction. DISARM commits safer latches first, then drains `ORDER_LIFECYCLE`. Drain timeout never rolls back local risk reduction and produces attention evidence. After a successful drain, no old send section remains active.

## Session and sizing

ENTRY expiry must fall within and not exceed the intended regular U.S. session returned by Alpaca clock/calendar infrastructure. Outside regular hours, the next regular session is used. Quantity-based market sizing uses an estimated price: `$1,000` is a configured risk ceiling, not an absolute fill-notional guarantee.

## Defense layers

The final broker boundary is authoritative. Startup validation and a periodic local monitor also disarm expiry, approval/revision changes, fingerprint or credential changes, assignment mutation, deployment-policy/role changes, and loss of RISK_REDUCING authority.
