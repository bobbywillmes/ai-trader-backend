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
- Strategy is disabled.
- Exit profile is disabled.
- Symbol already has an open or closing tracked position.
- Daily entry order limit has been reached.
- Daily entry notional limit would be exceeded.
- Maximum open position count would be exceeded.
- Total open notional limit would be exceeded.
- Per-symbol exposure limit would be exceeded.
- Per-subscription exposure limit would be exceeded.

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

Runtime risk settings are stored in the `Setting` table and managed from the admin UI Settings page.

Current runtime risk settings:

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
```

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
- Paper/live mode setting
- Alpaca account `tradingBlocked` check
- Broker mode matching
- Zod schema validation
- Security enable/disable checks
- Subscription enable/disable checks
- Strategy enable/disable checks
- Exit profile enable/disable checks
- Daily entry order limit
- Daily entry notional limit
- Max open position limit
- Total open notional limit
- Per-symbol exposure limit
- Per-subscription exposure limit
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