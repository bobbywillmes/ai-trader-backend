# Account Entry-Risk Ownership

Phase 2A makes each `TradingAccount` the owner of routine numerical entry
limits while retaining legacy global numerical settings as temporary
compatibility fallbacks.

## Runtime hierarchy

```text
Global system controls
-> Trading Account controls
-> TradingAccountAllocation controls
-> TradingAccountSubscription controls
```

The following controls remain global and apply to every account:

```text
tradingEnabled
killSwitchEnabled
paperMode compatibility
entrySessionGuardEnabled
entryStartMinutesAfterOpen
entryCutoffMinutesBeforeClose
failClosedOnMarketClockError
```

The global numerical settings remain stored and editable, but they are no
longer independently enforced when an account-owned value is configured.

## Effective routine limits

The central resolver in
`src/services/trading-account-entry-risk-limits.service.ts` resolves these
fields independently:

```text
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxSymbolOpenNotional
```

For each field:

1. Use the `TradingAccountRiskSettings` value when the row exists, is enabled,
   and the field is non-null.
2. Otherwise use the matching global `Setting` value.

Diagnostics identify the selected source as `ACCOUNT` or
`LEGACY_GLOBAL_FALLBACK`. An account value replaces its matching global value;
the runtime does not enforce both or take the lower value. When account risk
settings are disabled, all four routine fields use legacy fallbacks.

## Authoritative exposure ownership

`TradingAccount.maxDeployableNotional` is the total account entry-exposure
ceiling. For normal resolved account-subscription entries, neither account nor
global `maxTotalOpenNotional` competes with it.

```text
currentAccountExposure
  = active/closing TrackedPosition exposure
  + unmaterialized pending buy OrderIntent exposure

projectedAccountExposure
  = currentAccountExposure
  + proposed entry notional
```

The entry is blocked when projected exposure exceeds
`maxDeployableNotional`. Missing deployable capital fails closed for new
entries without affecting exits.

For resolved account subscriptions, `reservedNotional`,
`maxPositionNotional`, `maxQty`, and sizing configuration are authoritative.
Account and global `maxSubscriptionOpenNotional` remain stored but do not
compete with those controls. Total/subscription legacy limits remain only for a
genuine entry path that cannot resolve a `TradingAccountSubscription`.

## OrderIntent accounting

Daily activity and pending exposure deliberately use different lifecycle
rules.

Daily entry activity counts accepted buy intents created during the applicable
New York trading date, including entries that later filled. Queries use the
half-open UTC interval corresponding to the `America/New_York` local date:

```text
createdAt >= New York local midnight converted to UTC
createdAt < following New York local midnight converted to UTC
```

The boundary uses timezone-aware conversion and therefore follows EST and EDT.

Pending exposure counts exposure-bearing buy intents whose
`trackedPositionId` is still null. Rejected, cancelled, blocked, failed, and
other non-exposure terminal states are excluded. A filled intent linked to an
active position is represented only by that position and is not double-counted.

Pending entries also consume account position slots and same-symbol exposure.
The worker excludes the intent it is currently rechecking so it does not count
the proposed order twice.

## Runtime evaluation order

For buy-side entries, the risk gate evaluates:

```text
global system controls
-> security/subscription/strategy/exit-profile eligibility
-> broker account and paperMode compatibility
-> global entry-session policy
-> one-active-position-per-symbol rule
-> resolved account routine limits and projected deployable exposure
-> allocation limits
-> account-subscription reservation and sizing limits
```

Runtime account-subscription sizing occurs before risk evaluation. FIXED_QTY
and MAX_NOTIONAL entries both carry an estimated proposed notional. The backend
does not silently clamp quantity or notional.

The order worker repeats the complete entry-risk evaluation immediately before
broker submission. Sell-side exits, close-position operations, protective
orders, synchronization, and reconciliation do not pass through entry-only
limits.

## Capital hierarchy

The Phase 1 hierarchy remains active beneath the account layer:

```text
TradingAccount.maxDeployableNotional
-> enabled TradingAccountAllocation.maxAllocatedNotional
-> enabled, entry-enabled TradingAccountSubscription.reservedNotional
```

Enabled allocations require complete total, open-position, and per-position
limits. Entry-enabled subscriptions require an enabled same-account allocation
and reserved capital. Allocation and reservation enforcement is independent of
the effective account routine limits.

## Diagnostics and audit records

The risk-settings API, live risk details, entry-risk preview, and Risk Health
use the central effective-limit structure. They expose selected values, sources,
and superseded-field context.

Risk Health reports missing or disabled account settings, fallback fields,
missing deployable capital, current exposure above deployable capital, and
superseded fields that remain populated. Fallback use is a warning for PAPER
and a readiness blocker for LIVE.

The latest risk evaluation is stored in the existing `OrderIntent.rawRequestJson`
snapshot. Trade-cycle configuration snapshot schema version 2 records effective
account limits and sources. Entry-decision runtime snapshots remain the
upstream signal payload and are not changed, preserving the n8n contract.

## Safe bootstrap

The repeatable transition script is dry-run by default:

```bash
npx tsx scripts/bootstrap-trading-account-risk-settings.ts
npx tsx scripts/bootstrap-trading-account-risk-settings.ts --apply
```

It reports every account and field that would be populated. Apply mode creates
missing settings rows and fills only null routine fields from current global
fallback values. It never overwrites non-null values or changes
`maxDeployableNotional`, allocations, subscriptions, reservations, entry
toggles, credentials, account status, or broker metadata.

## Phase 2B boundary

Phase 2A does not remove global numerical `Setting` rows, config fields, or the
superseded `TradingAccountRiskSettings` columns. The Settings UI labels them as
legacy fallbacks or superseded compatibility fields. Their deletion and final
fallback removal belong to Phase 2B after this ownership transition is proven.
