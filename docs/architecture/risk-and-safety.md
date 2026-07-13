# Risk & Safety

This doc covers the centralized entry-risk gate, the `tradingEnabled` vs `killSwitchEnabled` control model, runtime risk settings, and the full list of safety controls that protect the system from unintended order execution.

---

## 🛡 Production Safety Layer

The backend includes a centralized entry-risk gate that sits between signal/order creation and broker submission.

The risk gate answers one question:

```text
Even if this signal is valid, is the system allowed to enter this trade right now?
```

Entry orders are blocked when any of the following conditions apply:

- Global automated trading is disabled.
- Kill switch is active.
- Broker account is trading blocked.
- Runtime broker mode does not match the connected Alpaca mode.
- Security is disabled.
- Subscription is disabled.
- Account subscription is missing, disabled, or disabled for entries.
- Strategy is disabled.
- Exit profile is disabled.
- Account-subscription sizing is invalid, cannot resolve a required latest
  price, or calculates less than one whole share.
- Regular-session entry guard blocks the entry because the market is closed,
  the opening buffer is active, the pre-close cutoff is active, or session data
  is unavailable while fail-closed behavior is enabled.
- Symbol already has an open or closing tracked position.
- Daily entry order limit has been reached.
- Daily entry notional limit would be exceeded.
- Maximum open position count would be exceeded.
- Total open notional limit would be exceeded.
- Per-symbol exposure limit would be exceeded.
- Per-subscription exposure limit would be exceeded.
- Account daily entry order limit has been reached.
- Account daily entry notional limit would be exceeded.
- Account maximum open position count would be exceeded.
- Account total open notional limit would be exceeded.
- Account symbol exposure limit would be exceeded.
- Account subscription exposure limit would be exceeded.
- Trading account max deployable notional is missing.
- An enabled, entry-enabled account subscription is unassigned or lacks a
  reservation.
- The assigned allocation has incomplete required limits.
- Proposed entry notional exceeds the account-subscription reservation.
- Assigned allocation bucket is disabled.
- Assigned allocation per-position notional limit would be exceeded.
- Assigned allocation maximum open position count would be exceeded.
- Assigned allocation allocated notional limit would be exceeded.

Account capital hierarchy checks fail closed without silently clamping sizing.
For `FIXED_QTY`, the calculated proposed order notional is compared with
`reservedNotional`. These checks remain entry-only: sell-side exits, protective
order work, broker synchronization, reconciliation, and position closure remain
available when entry configuration is invalid.

### Trading Enabled vs Kill Switch

`tradingEnabled` is the global master switch for automated order submission.

When `tradingEnabled = false`, the backend broadly rejects automated trading requests even if securities, subscriptions, strategies, and exit profiles are enabled.

`killSwitchEnabled` is an entry-only pause.

When `killSwitchEnabled = true`, the system stays online for monitoring, syncing, position tracking, exit workflows, reports, and admin visibility, but new buy-side entries are blocked.

This gives two levels of production control:

```text
Trading Enabled Off
  = broad automated trading shutdown

Kill Switch On
  = stop opening new positions, but keep the system awake
```

### Entry Risk Settings

Global runtime risk settings are stored in the `Setting` table and managed from the admin UI Settings page. These settings remain backend-wide emergency caps.

Global runtime risk settings:

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

Account-scoped risk settings are stored in `TradingAccountRiskSettings` and managed on the Trading Account detail page under Account Risk Controls.

Account risk settings:

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

When `TradingAccountRiskSettings.enabled=false`, only account-specific caps are skipped. Global emergency caps still apply. If an account has no risk settings row yet, the runtime risk gate also skips account-specific caps while keeping global caps active.

Allocation bucket risk settings are stored in `TradingAccountAllocation` and apply to new entries whose `TradingAccountSubscription` is assigned to that allocation. Unassigned account subscriptions skip allocation-specific checks. Allocation checks run after global and account caps, and before broker submission, using the new order's estimated notional.

### Regular-session entry guard

The backend can independently enforce a regular-session-only window for new
entries. n8n may still decide when to send a signal, but the backend is the
authority for whether a new entry may proceed.

The guard applies only to new buy-side entry orders. Exit orders, protective
sells, trailing-stop orders, reconciliation activity, and other non-entry
orders bypass this session-window restriction and continue through their
existing safety checks.

Runtime settings:

```text
entrySessionGuardEnabled=false
entryStartMinutesAfterOpen=15
entryCutoffMinutesBeforeClose=30
failClosedOnMarketClockError=true
```

`entryCutoffMinutesBeforeClose = null` disables only the pre-close buffer. No
Prisma migration is expected for these settings because the existing `Setting`
model stores generic key/value runtime settings.

When enabled, the backend uses Alpaca Trading API `/v2/clock` and `/v2/calendar`
for the relevant trading date. The calendar response supplies the actual regular
session open and close, including holidays and early closes. The implementation
does not hardcode regular-session times, UTC offsets, or holiday lists.

The `/v2/clock` response is the primary session source. The backend stores the
normalized clock payload in the generic `Setting` table as
`alpacaMarketClockCache`, including Alpaca `timestamp`, `is_open`, `next_open`,
`next_close`, and local fetch time. That cache is reused until its `next_close`
is stale, which lets status pages show values such as the next Monday open after
a Friday holiday close without repeatedly calling Alpaca. Calendar lookup is
reserved for recovery cases where the backend starts mid-session and clock alone
does not identify the current session open needed for the opening buffer.

Boundary behavior:

- Entry is allowed at the exact opening-buffer boundary.
- Entry is blocked at the exact closing-buffer boundary.
- A zero opening buffer permits entries at the regular-session open.
- A zero close buffer permits entries until the regular-session close.
- A null close buffer removes the pre-close cutoff.
- If the calculated allowed start is at or after the calculated cutoff, entries
  are blocked with `entry_window_unavailable`.

Expected signal-time HTTP behavior:

- `409` for policy blocks such as market closed, active opening buffer, active
  close buffer, or invalid/unavailable entry window.
- `503` when Alpaca session information cannot be verified and
  `failClosedOnMarketClockError = true`.

When `failClosedOnMarketClockError = false`, the entry may continue with
structured degraded warning details. The backend does not pretend session
verification succeeded, and risk/system status exposes the degraded state.

The guard is enforced twice:

1. Signal-time risk evaluation checks the session window before entry exposure
   limits are finalized.
2. The order worker rechecks the same policy after claiming a pending
   `OrderIntent` and immediately before broker submission. If the worker-time
   recheck blocks, the intent is marked `blocked`, no Alpaca order is submitted,
   and a structured `SystemEvent` is written.

### Entry risk preview

Admins can use `POST /api/trading-accounts/:id/entry-risk-preview` to dry-run
account-subscription sizing and entry-risk decisions by `subscriptionKey`.

The preview endpoint is diagnostic only. It resolves the same account
subscription sizing inputs and centralized risk checks used for real entries,
but it does not create `OrderIntent`, `BrokerOrder`, `TrackedPosition`,
`EntryDecision`, or `SystemEvent` records, and it never submits to Alpaca.

By default, preview ignores market/session timing as a blocker so admins can
inspect deeper sizing, account, allocation, and subscription risk layers while
markets are closed. Session state may still be returned as informational
context showing whether a real entry would be blocked now.

### Trading account risk health

Admins can use `GET /api/trading-accounts/:id/risk-health` to review whether a
TradingAccount appears ready for new entries at the account configuration
level.

Risk health is diagnostic only. It does not change runtime enforcement, create
`OrderIntent` records, submit broker orders, call Alpaca order endpoints, or
change n8n payload behavior. The real entry path remains:

```text
global emergency controls
-> global entry risk caps
-> TradingAccount risk controls
-> TradingAccountAllocation bucket limits
-> TradingAccountSubscription sizing/gates
-> broker execution
```

The health check has different expectations for `PAPER` and `LIVE` accounts.
Paper accounts can be ready with warnings for incomplete planning information.
Live accounts are stricter: missing or stale broker portfolio value, missing
live risk caps, unassigned active subscriptions, disabled allocation
assignments, and planned exposure above broker portfolio value are blockers.

Broker-synced capital is the primary source for health checks:

```text
lastPortfolioValue
lastEquity, only as broker-derived fallback
lastCash
lastBuyingPower
lastBrokerSyncAt
```

`estimatedTradingCapital` is displayed only as planning context and is not used
to pass capital coverage checks. Broker value is stale after 24 hours. Missing
or stale broker value is a warning for paper accounts and a blocker for live
accounts.

Planned exposure diagnostics include allocation budget total, active
subscription budget total, and maximum simultaneous allocation exposure under
current allocation open-position caps. These numbers are visibility aids for
operator review and do not replace risk-gate enforcement.

### Exit attention states

The backend records explicit exit attention states for protective trailing-stop failures.

`PositionExitState` can mark `attentionRequired` when a protective trailing-stop order submission fails, is rejected, is canceled, or expires. These states are surfaced in the Open Positions admin page so operator intervention is visible while the tracked position remains open.

Attention states are separate from the normal lifecycle `status`: `status` describes where the exit lifecycle is, while `attentionRequired` indicates that the operator should review the position.

---

## 🛡 Current Safety Controls

The backend currently protects trading and configuration changes with:

- API key authentication
- Admin login sessions
- Separate signal-level and admin-level access
- Runtime `tradingEnabled` setting
- Runtime `killSwitchEnabled` setting
- Runtime regular-session entry guard
- Paper/live mode setting
- Account-scoped risk settings
- Trading account risk health diagnostics
- Alpaca account `tradingBlocked` check
- Broker mode matching
- Zod schema validation
- Security enable/disable checks
- Subscription enable/disable checks
- Account-subscription entry gates and runtime sizing validation
- Strategy enable/disable checks
- Exit profile enable/disable checks
- Daily entry order limit
- Daily entry notional limit
- Max open position limit
- Total open notional limit
- Per-symbol exposure limit
- Per-subscription exposure limit
- Account daily entry order limit
- Account daily entry notional limit
- Account max open position limit
- Account total open notional limit
- Account symbol open notional limit
- Account subscription open notional limit
- Allocation disabled block
- Allocation max position notional limit
- Allocation max open position limit
- Allocation max allocated notional limit
- Backend-generated stable `clientOrderId`
- Atomic order worker claim: `pending → submitting`
- Duplicate broker order protection
- Open/closing position guard for entry signals
- Atomic tracked-position lifecycle transitions
- Order intent audit logging
- Broker order audit logging
- Broker activity/fill import
- Account snapshot audit logging
- System event logging

The intended production separation is:

```text
n8n / automation
  → signal API key
  → signal routes only

Admin UI / Postman
  → admin login session or admin API key
  → full management routes
```

This prevents automation clients from accidentally changing strategy configuration, subscription sizing, exit rules, or global trading settings.

### Reconciliation checks

The backend includes reconciliation flows for comparing local tracked-position state against broker state.

Reconciliation currently compares:

- active `TrackedPosition` records
- related `PositionExitState` records
- broker open positions
- broker open orders

The Admin UI exposes manual reconciliation under **System → Reconciliation**.

Two manual execution modes are supported:

- **Dry run** — returns findings only and does not mutate data.
- **Persist events + attention** — creates `SystemEvent` records and applies exit attention states for critical tracked-position findings.

Reconciliation is intentionally observational first. It detects mismatches and surfaces them for operator review rather than automatically changing positions or submitting/canceling broker orders.

### Scheduled reconciliation worker

The backend also includes an optional scheduled reconciliation worker.

The worker is controlled by database-backed runtime settings:

- reconciliationWorkerEnabled
- reconciliationWorkerIntervalMinutes

The worker is disabled by default. When enabled, it runs reconciliation on the configured interval, persists reconciliation `SystemEvent` records, and applies exit attention states for critical tracked-position findings.

Reconciliation events are de-duplicated within a recent time window so a persistent mismatch does not create repeated identical system events.

Manual reconciliation should be used first when validating broker/backend state. The scheduled worker should only be enabled after a clean manual dry run and when automatic monitoring is intentionally desired.
