# Account Risk Settings

This document describes the account-scoped risk settings layer that now sits beside the existing global runtime settings.

The system has two active safety layers that intentionally overlap:

- Global runtime settings in the generic `Setting` table.
- Account-scoped risk settings in `TradingAccountRiskSettings`, plus account-scoped trading records through `TradingAccount`, `TradingAccountAllocation`, and `TradingAccountSubscription`.

Global settings still protect the whole backend and remain the emergency/system-level caps. Account risk settings add per-`TradingAccount` entry caps without removing or weakening the global layer.

## Current State Summary

Runtime settings are loaded by `getRuntimeTradingConfig()` in `src/services/config.service.ts`. Values are stored as key/value strings in the Prisma `Setting` table and are updated through the admin Settings API. Missing settings fall back to conservative defaults in code.

The entry flow currently evaluates:

```text
global runtime controls
-> security/subscription/strategy/exit-profile gates
-> broker account checks
-> global entry exposure limits
-> TradingAccountRiskSettings account exposure limits
-> TradingAccountAllocation bucket limits
-> TradingAccountSubscription sizing/gates
```

Runtime account-subscription sizing happens before the risk gate for account-scoped subscription entry orders. For `MAX_NOTIONAL`, the backend calculates whole-share quantity from backend-owned market data, stores the sizing snapshot on the `OrderIntent`, and passes the estimated notional into the risk gate as risk context. Broker submission remains a quantity order.

The account-scoped model now also includes:

- `TradingAccount.environment` as `PAPER` or `LIVE`.
- Account-level `tradingEnabled` and `killSwitchEnabled`.
- Account-owned encrypted broker credentials.
- `TradingAccountRiskSettings` for account-level entry caps.
- `TradingAccountAllocation` buckets with enforced notional and position limits for assigned account subscriptions.
- `TradingAccountSubscription` entry/exit gates and account-specific sizing.

The authoritative configured-capital hierarchy is:

```text
TradingAccount.maxDeployableNotional
-> enabled TradingAccountAllocation.maxAllocatedNotional budgets
-> enabled, entry-enabled TradingAccountSubscription.reservedNotional reservations
```

Enabled allocations require complete total, open-position, and per-position
limits. Active entry subscriptions require an enabled same-account allocation
and reserved capital. Their reservations cannot exceed either the allocation
per-position ceiling individually or its total budget in aggregate.

Admin writes construct candidate hierarchy state and validate it inside the
same serializable database transaction used for persistence. Conflicts return
all relevant structured violations. Dormant or entries-disabled legacy
subscriptions may remain unassigned while they are corrected.

Important paper/live design constraint: paper and live trading should not be treated as one either/or global mode long term. They should be independently controllable account lanes, such as paper trading enabled while live trading remains disabled.

## Current Global Settings Fields

The global Settings page currently exposes these trading controls:

```text
tradingEnabled
paperMode
killSwitchEnabled
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
maxSubscriptionOpenNotional
entrySessionGuardEnabled
entryStartMinutesAfterOpen
entryCutoffMinutesBeforeClose
failClosedOnMarketClockError
```

The same runtime config object also includes reconciliation worker settings, but those are outside this account risk audit.

## Usage Audit

| Setting | Stored In | Read By | UI Surfaces | Current Role | Future Owner | Emergency Cap Today | Before Live Trading |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tradingEnabled` | `Setting.key=tradingEnabled`; defaults false in `config.service.ts` | `risk-gate.service.ts`, `startup-check.service.ts`, system/bootstrap status services, trade-cycle snapshots | Settings page edits it; dashboard/status types display it; entry decisions may record it | Global master switch for automated trading requests | Keep global as system master switch; also use existing `TradingAccount.tradingEnabled` as account control | Yes | Keep global disabled-by-default guard. Ensure account-level enablement is evaluated per account before broker submission. |
| `killSwitchEnabled` | `Setting.key=killSwitchEnabled`; defaults false globally | `risk-gate.service.ts`, startup/status/snapshot flows | Settings page edits it; dashboard/status and entry decisions display it | Global entry-only pause | Keep global as emergency entry kill switch; also use existing `TradingAccount.killSwitchEnabled` as account control | Yes | Preserve as global emergency stop. Add account-specific kill-switch enforcement before live accounts can trade independently. |
| `paperMode` | `Setting.key=paperMode`; defaults true | `risk-gate.service.ts`, `startup-check.service.ts`, `broker-activity.service.ts`, `tracked-position-subscription-resolution.service.ts`, snapshots/status | Settings page edits it; dashboard/status and entry decisions display it | Global expected Alpaca mode and startup safety check | Deprecate later after `TradingAccount.environment` fully replaces mode checks | Partly; it prevents global paper/live mismatch today | Do not remove yet. Replace broker resolver, startup checks, snapshots, status, and tests with account-environment-aware checks first. Paper and live must remain separately controllable lanes. |
| `maxDailyEntryOrders` | `Setting.key=maxDailyEntryOrders`; defaults 5 | `risk-gate.service.ts`, risk status, snapshots | Settings page edits it; dashboard/status types display it | Global daily entry order count cap | Move primary limit to `TradingAccount` or `TradingAccountRiskSettings`; optionally retain global emergency ceiling | Yes | Add account-level daily order cap and evaluate it by `tradingAccountId`. Keep global as backend-wide ceiling during migration. |
| `maxDailyEntryNotional` | `Setting.key=maxDailyEntryNotional`; defaults 10000 | `risk-gate.service.ts`, risk status, snapshots | Settings page edits it; dashboard/status types display it | Global daily entry notional cap | Move primary limit to account risk settings; optionally retain global emergency ceiling | Yes | Add account-level daily notional cap using account-scoped usage. Preserve global cap as an operator override. |
| `maxOpenPositions` | `Setting.key=maxOpenPositions`; defaults 5 | `risk-gate.service.ts`, risk status, snapshots | Settings page edits it; dashboard/status types display it | Global open/closing tracked-position count cap | Move primary limit to account risk settings; allocation buckets also have their own `maxOpenPositions` | Yes | Enforce account-level position count first, then allocation-level position count when an account subscription is assigned to a bucket. |
| `maxTotalOpenNotional` | `Setting.key=maxTotalOpenNotional`; defaults 25000 | `risk-gate.service.ts`, risk status, snapshots | Settings page edits it; dashboard/status types display it | Global open notional cap | Move primary limit to account risk settings; allocation buckets should enforce bucket notional | Yes | Evaluate account total exposure by `tradingAccountId`. Keep global cap as maximum aggregate exposure during transition. |
| `maxSymbolOpenNotional` | `Setting.key=maxSymbolOpenNotional`; defaults 5000 | `risk-gate.service.ts`, snapshots | Settings page edits it; dashboard/status types display it | Global per-entry symbol notional cap | Move primary limit to account risk settings; may also be supported as subscription or strategy-specific override later | Yes | Add account-level per-symbol/per-position cap. Clarify whether this is intended to cap one entry, total symbol exposure, or both. |
| `maxSubscriptionOpenNotional` | `Setting.key=maxSubscriptionOpenNotional`; defaults 5000 | `risk-gate.service.ts`, snapshots | Settings page edits it; dashboard/status types display it | Global per-subscription entry cap when `subscriptionId` exists | Mostly superseded by `TradingAccountSubscription.maxPositionNotional` and `maxQty` | Yes | Prefer account-subscription sizing and guardrails. Retain only as temporary global emergency ceiling or remove after all account-subscription limits are enforced and visible. |
| `entrySessionGuardEnabled` | `Setting.key=entrySessionGuardEnabled`; defaults false | `entry-session-guard.service.ts`, `risk-gate.service.ts`, `order.worker.ts`, risk status/snapshots | Settings page edits it; risk/status surfaces display it | Global regular-session entry policy | Keep global | Yes | Keep as a backend-wide policy unless there is a strong reason to allow account-specific market-session policies. |
| `entryStartMinutesAfterOpen` | `Setting.key=entryStartMinutesAfterOpen`; defaults 15 | `entry-session-guard.service.ts`, `risk-gate.service.ts`, `order.worker.ts`, risk status/snapshots | Settings page edits it | Global opening buffer | Keep global | Yes | Keep global. Validate that worker-time recheck continues using the same policy. |
| `entryCutoffMinutesBeforeClose` | `Setting.key=entryCutoffMinutesBeforeClose`; defaults 30; null disables close buffer | `entry-session-guard.service.ts`, `risk-gate.service.ts`, `order.worker.ts`, risk status/snapshots | Settings page edits it | Global pre-close entry cutoff | Keep global | Yes | Keep global. Preserve null behavior for disabling only the close buffer. |
| `failClosedOnMarketClockError` | `Setting.key=failClosedOnMarketClockError`; defaults true | `entry-session-guard.service.ts`, risk status/snapshots | Settings page edits it | Global error posture for market session uncertainty | Keep global | Yes | Keep fail-closed as default production posture. Only relax intentionally for degraded paper testing. |

## Related Account-Scoped Controls

### TradingAccountRiskSettings

`TradingAccountRiskSettings` stores the first-class account-level risk caps:

```text
enabled
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
maxSubscriptionOpenNotional
notes
```

The Admin UI exposes these controls on the Trading Account detail page under Account Risk Controls. The API is:

```http
GET   /api/trading-accounts/:id/risk-settings
PATCH /api/trading-accounts/:id/risk-settings
```

`enabled=false` skips only account-specific risk caps. Global settings still apply.

If no risk settings row exists, the runtime risk gate skips account-specific caps and keeps global caps active. The admin GET endpoint creates a default row for an existing account so operators can configure it.

### TradingAccount

`TradingAccount` already owns:

```text
environment
tradingEnabled
killSwitchEnabled
estimatedTradingCapital
status
tradingBlocked
```

Account-level `tradingEnabled` and `killSwitchEnabled` remain account safety fields, but this branch does not change their runtime enforcement semantics.

### TradingAccountAllocation

`TradingAccountAllocation` already stores:

```text
maxAllocatedNotional
maxOpenPositions
maxPositionNotional
```

These are enforced as allocation-bucket limits for new entries assigned through `TradingAccountSubscription.allocationId`. Unassigned account subscriptions skip allocation-specific checks and continue to rely on global, account, and subscription controls.

### TradingAccountSubscription

`TradingAccountSubscription` already owns the most specific entry configuration:

```text
enabled
entriesEnabled
exitsEnabled
sizingType
fixedQty
maxPositionNotional
minPositionNotional
maxQty
```

These should remain subscription-scoped. Runtime entry sizing already uses account-subscription rows instead of legacy subscription sizing fields.

## Account Readiness / Risk Health

The backend exposes a read-only Trading Account risk health diagnostic:

```http
GET /api/trading-accounts/:id/risk-health
```

This endpoint answers a broader account-level question than entry risk preview:

```text
Is this TradingAccount configured safely and intentionally for new entries?
```

It does not enforce policy, create orders, submit to Alpaca, change broker credentials, change allocation behavior, or mutate trading records. Runtime order behavior remains owned by the risk gate, order worker, broker adapters, and existing account-subscription sizing path.

Risk health returns:

```text
READY
READY_WITH_WARNINGS
BLOCKED
```

with separate blocker, warning, and informational checks. `PAPER` accounts are advisory and warning-oriented. `LIVE` accounts are deliberately stricter and should be difficult to mark ready accidentally.

Capital readiness uses broker-synced account data as capital truth:

```text
lastPortfolioValue
lastEquity, only as broker-derived fallback
lastCash
lastBuyingPower
lastBrokerSyncAt
```

`estimatedTradingCapital` is returned only as planning context. It is not treated as trustworthy capital for readiness checks and should not be used to pass capital coverage checks. Broker portfolio value is considered stale when `lastBrokerSyncAt` is older than 24 hours. Missing or stale broker value is a warning for `PAPER` and a blocker for `LIVE`.

The health report includes three planned exposure views:

```text
allocationBudgetTotal
  = sum(enabled TradingAccountAllocation.maxAllocatedNotional)

activeSubscriptionBudgetTotal
  = sum enabled + entry-enabled account-subscription planned position budgets

maxSimultaneousAllocationExposure
  = sum each enabled allocation's largest active assigned subscription budgets,
    capped by allocation.maxOpenPositions when configured
```

For `MAX_NOTIONAL`, the active subscription budget uses `maxPositionNotional`. For `FIXED_QTY`, the budget estimate is `fixedQty * latestPrice` using backend-owned market data. Missing latest price is a warning for `PAPER` and a blocker for `LIVE`.

The readiness diagnostic also highlights unassigned active subscriptions, active subscriptions assigned to disabled allocations, missing allocation caps, missing live account risk caps, global trading/kill-switch state, credential state, broker metadata sync, and unresolved open-position attribution.

## Runtime Evaluation Order

The current risk gate evaluates controls in this order:

```text
global emergency controls
-> security, subscription, strategy, and exit-profile gates
-> broker account checks and paperMode broker-mode match
-> entry session guard
-> one active tracked position per symbol guard
-> global entry exposure limits
-> TradingAccountRiskSettings account exposure limits
-> TradingAccountAllocation allocation exposure limits
```

Global controls should answer, "May this backend trade at all right now?"

Account risk controls should answer, "May this account enter within account-level limits?"

Allocation controls should answer, "May this strategy bucket consume more of its reserved risk budget?"

Subscription controls should answer, "May this account subscription enter this specific position, and at what size?" Runtime sizing and account-subscription gates are evaluated before broker submission. Allocation checks use the resolved account subscription and the new order's estimated notional.

## Migration Phases

### Phase A - Visibility And Copy Cleanup

Clarify Settings UI and docs that the current global Entry Risk Limits are emergency/global caps. Do not remove fields and do not change save behavior.

Also clarify that allocation limits are enforced only for new entries assigned to the allocation.

### Phase B - Account-Scoped Risk Settings Schema

Implemented with the related `TradingAccountRiskSettings` model for:

```text
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
maxSubscriptionOpenNotional
```

The repeatable `scripts/bootstrap-trading-account-risk-settings.ts` transition
script reports missing routine account limits for every Trading Account. It is a
dry run by default; `--apply` creates missing settings rows and fills only null
`maxDailyEntryOrders`, `maxDailyEntryNotional`, `maxOpenPositions`, and
`maxSymbolOpenNotional` values from the current legacy global fallbacks. It
does not overwrite configured values or change account, allocation,
subscription, reservation, credential, or broker metadata.

### Phase C - Risk Gate Uses TradingAccount Limits

Implemented. The risk gate loads account risk settings for the resolved trading account and evaluates account-specific limits using account-scoped usage. Global settings remain emergency ceilings.

Implemented account block rules:

```text
account_max_daily_entry_orders_exceeded
account_max_daily_entry_notional_exceeded
account_max_open_positions_exceeded
account_max_total_open_notional_exceeded
account_max_symbol_open_notional_exceeded
account_max_subscription_open_notional_exceeded
```

### Phase D - Allocation Bucket Enforcement

Implemented. The risk gate evaluates allocation checks after global and account risk caps have passed.

Enforced allocation fields:

```text
TradingAccountAllocation.maxAllocatedNotional
TradingAccountAllocation.maxOpenPositions
TradingAccountAllocation.maxPositionNotional
```

Allocation checks should use the account subscription's `allocationId`. If a subscription has no allocation, define whether it belongs to an implicit default bucket or only account-level limits apply.

Unassigned account subscriptions skip allocation checks in the current implementation.

Implemented allocation block rules:

```text
allocation_disabled
allocation_max_position_notional_exceeded
allocation_max_open_positions_exceeded
allocation_max_allocated_notional_exceeded
```

### Phase E - paperMode Deprecation And Removal

Remove or hide global `paperMode` only after confirming `TradingAccount.environment` fully replaces it in:

```text
broker resolver
startup checks
production safety checks
settings UI
dashboard/status responses
entry decisions
trade-cycle config snapshots
broker activity ingestion
tracked-position subscription recovery
tests
docs
```

Do not replace global `paperMode` with one global live/paper toggle. The long-term target is separate account-level paper and live controls.

## Risks And Safety Notes

- `paperMode` is still used by startup checks and broker-mode mismatch checks. Removing it early could weaken live-trading safeguards.
- `maxSubscriptionOpenNotional` overlaps with `TradingAccountSubscription.maxPositionNotional`, but it is still enforced globally today. Removing it early could increase allowed entry size.
- Allocation limits apply only to new entries assigned to that allocation. Unassigned account subscriptions are not failed closed by allocation checks.
- Account-level `tradingEnabled` and `killSwitchEnabled` exist, but global settings still carry important enforcement paths. Account-specific enforcement must be verified before live multi-account use.
- The order worker rechecks the entry session guard before broker submission. Any future risk-order refactor should preserve worker-time safety checks for pending intents.
- Startup safety should remain conservative: production should not accidentally restart into live trading without explicit live-trading environment overrides.

## What Not To Remove Yet

Do not remove or hide these global settings. They remain backend-wide emergency caps even though account-scoped caps now exist:

```text
paperMode
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
maxSubscriptionOpenNotional
```

Do not remove global emergency controls:

```text
tradingEnabled
killSwitchEnabled
entrySessionGuardEnabled
entryStartMinutesAfterOpen
entryCutoffMinutesBeforeClose
failClosedOnMarketClockError
```

These remain useful as system-level safety controls even after account-scoped risk settings are added.
