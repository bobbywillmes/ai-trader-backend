# Account Risk Settings Audit

This audit documents the current runtime trading settings after the account-scoped trading account work. It is intentionally design-only: no settings are removed, no Prisma schema changes are made, and no trading behavior changes are implied by this document.

The current system has two safety layers that partially overlap:

- Global runtime settings in the generic `Setting` table.
- Account-scoped trading records through `TradingAccount`, `TradingAccountAllocation`, and `TradingAccountSubscription`.

The global settings still protect the whole backend today. Before live trading expands beyond a single account, account-specific limits should become first-class and the global limits should remain only emergency/system-level caps.

## Current State Summary

Runtime settings are loaded by `getRuntimeTradingConfig()` in `src/services/config.service.ts`. Values are stored as key/value strings in the Prisma `Setting` table and are updated through the admin Settings API. Missing settings fall back to conservative defaults in code.

The risk gate currently evaluates:

```text
global runtime controls
-> security/subscription/strategy/exit-profile gates
-> account-subscription sizing gates
-> broker account checks
-> global entry exposure limits
```

The account-scoped model now also includes:

- `TradingAccount.environment` as `PAPER` or `LIVE`.
- Account-level `tradingEnabled` and `killSwitchEnabled`.
- Account-owned encrypted broker credentials.
- `TradingAccountAllocation` buckets with configured but not-yet-enforced notional and position limits.
- `TradingAccountSubscription` entry/exit gates and account-specific sizing.

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

Recommended future account-level risk settings:

```text
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
```

These can either be added directly to `TradingAccount` or placed in a related `TradingAccountRiskSettings` model. A related model is cleaner if the settings need audit history, separate permissions, or future per-asset-class variants.

### TradingAccountAllocation

`TradingAccountAllocation` already stores:

```text
maxAllocatedNotional
maxOpenPositions
maxPositionNotional
```

These are configured but not enforced yet. They should become allocation-bucket limits after account-level risk checks pass and before account-subscription sizing is accepted for broker submission.

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

## Recommended Future Evaluation Order

The long-term risk gate should evaluate controls in this order:

```text
global emergency controls
-> TradingAccount environment/status/trading controls
-> TradingAccount account-level risk limits
-> TradingAccountAllocation bucket limits
-> TradingAccountSubscription gates and sizing guardrails
-> broker account checks and broker submission
```

Global controls should answer, "May this backend trade at all right now?"

Account controls should answer, "May this account trade right now, and within what account-level limits?"

Allocation controls should answer, "May this strategy bucket consume more of its reserved risk budget?"

Subscription controls should answer, "May this account subscription enter this specific position, and at what size?"

## Migration Phases

### Phase A - Visibility And Copy Cleanup

Clarify Settings UI and docs that the current global Entry Risk Limits are emergency/global caps. Do not remove fields and do not change save behavior.

Also clarify that allocation limits are configured but not enforced yet.

### Phase B - Account-Scoped Risk Settings Schema

Add account-level fields or a related `TradingAccountRiskSettings` model for:

```text
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
```

Backfill carefully with conservative values. Avoid casual historical data backfills because trading records are audit-sensitive.

### Phase C - Risk Gate Uses TradingAccount Limits

Update the risk gate to load the resolved `TradingAccount` and evaluate account-specific limits using account-scoped usage. Keep global settings as emergency ceilings during this phase.

Expected order:

```text
global tradingEnabled / killSwitchEnabled / session guard
-> account status / tradingEnabled / killSwitchEnabled / environment
-> account-level risk settings
-> existing subscription and broker checks
```

### Phase D - Allocation Bucket Enforcement

Enforce:

```text
TradingAccountAllocation.maxAllocatedNotional
TradingAccountAllocation.maxOpenPositions
TradingAccountAllocation.maxPositionNotional
```

Allocation checks should use the account subscription's `allocationId`. If a subscription has no allocation, define whether it belongs to an implicit default bucket or only account-level limits apply.

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
- Allocation limits are visible/configurable but not enforced. Operators should not assume bucket limits currently block orders.
- Account-level `tradingEnabled` and `killSwitchEnabled` exist, but the current audit target confirms global settings still carry important enforcement paths. Account-specific enforcement must be verified before live multi-account use.
- The order worker rechecks the entry session guard before broker submission. Any future risk-order refactor should preserve worker-time safety checks for pending intents.
- Startup safety should remain conservative: production should not accidentally restart into live trading without explicit live-trading environment overrides.

## What Not To Remove Yet

Do not remove or hide these until their account-scoped replacements are implemented, tested, documented, and visible:

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
