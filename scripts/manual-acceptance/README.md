# Live-entry acceptance manual harness

This harness runs the real backend, browser UI, authorization services, workers,
and Prisma schema against the disposable `ai_trader_live_entry_acceptance`
database. It intercepts the exact Alpaca and Massive requests needed by the
ceremony in memory. Every unexpected hostname, route, method, symbol, or request
fails closed; no accepted request reaches the network.

The harness lives outside `src/`, requires an explicit sentinel and entrypoint,
accepts only the exact disposable database and loopback UI origin, and is not a
production runtime broker mode.

## Environment

Start the repository PostgreSQL container. In a fresh PowerShell window at the
repository root, set these process-local values without editing `.env`:

```powershell
$env:DATABASE_URL='postgresql://trader:traderpass@127.0.0.1:5432/ai_trader_live_entry_acceptance'
$env:NODE_ENV='production'
$env:PORT='3000'
$env:CORS_ALLOWED_ORIGINS='http://localhost:5173'
$env:ALPACA_API_KEY='synthetic-global-key'
$env:ALPACA_API_SECRET='synthetic-global-secret'
$env:ALPACA_BASE_URL='https://paper-api.alpaca.markets'
$env:MASSIVE_API_KEY='synthetic-massive-key'
$env:AI_TRADER_SIGNAL_API_KEY='synthetic-signal-key-acceptance'
$env:AI_TRADER_ADMIN_API_KEY='synthetic-admin-key-acceptance'
$env:TRADING_CREDENTIAL_ENCRYPTION_KEY='AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
$env:TRADING_CREDENTIAL_ENCRYPTION_KEY_ID='manual-acceptance-v1'
$env:LIVE_WRITE_DEPLOYMENT_ROLE='PRODUCTION_EXECUTOR'
$env:ALLOW_TRADING_ENABLED_ON_START='true'
$env:MASSIVE_NEWS_WORKER_ENABLED='false'
$env:MANUAL_ACCEPTANCE_HARNESS='I_UNDERSTAND_THIS_IS_SYNTHETIC'
$env:MANUAL_ACCEPTANCE_CONTROL_TOKEN='local-control-token-acceptance'
```

Do not set `ALLOW_LIVE_TRADING` for this rehearsal. The guarded server commands
set the exact activation or entry policy before importing the application. Both
profiles enable risk-reducing writes; only the explicit entry profile enables
Live entry writes.

Use `127.0.0.1` rather than `localhost` for PostgreSQL on Windows/Docker Desktop
because Node may resolve `localhost` to the Docker IPv6 listener first.

## Reset and activation-profile start

Resetting can target only the exactly named disposable database. Run:

```powershell
npm.cmd run acceptance:live-entry:reset
npx.cmd prisma migrate deploy
npx.cmd tsx src/db/seed.ts
npm.cmd run acceptance:live-entry:fixture:paused
npm.cmd run acceptance:live-entry:server:activation
```

The last command stays running. In a second PowerShell window, start the UI:

```powershell
Set-Location apps/web
npm.cmd run dev
```

Open `http://localhost:5173` and log in with:

- Email: `owner@live-entry-acceptance.invalid`
- Password: `Synthetic-Acceptance-Only-2026!`
- Account: `Synthetic Live Acceptance`

## Complete browser ceremony

The PAUSED fixture contains no approval, arming, intent, or acceptance run. All
steps below use the browser UI; no SQL, control endpoint, curl, or Postman action
is part of the rehearsal.

### Activation profile

1. Confirm `PAUSED · ENTRY DISARMED`, missing `RISK_REDUCING` and `ENTRY`, disabled account trading, enabled kill switch, and no staged canary.
2. Start a durable run in **Live Entry Acceptance**. Record its run ID and confirm phase `SETUP`.
3. Run Live Activation readiness. Confirm it is current and blocked by missing `RISK_REDUCING` authority rather than an entry-write policy.
4. In **Live Write Authorization**, grant `RISK_REDUCING` using that assessment and type `APPROVE LIVE RISK_REDUCING`.
5. Run Live Activation readiness again. Confirm `PASSED / CURRENT`.
6. In **Activate Live account**, enter a reason, type `ACTIVATE LIVE ACCOUNT`, and activate. Confirm `ACTIVE · ENTRY DISARMED`, trading disabled, kill switch enabled, and the same acceptance run still in `SETUP`.

Stop only the backend/harness process with Ctrl+C. Do not reset, migrate, seed,
or rerun the fixture. In the same PowerShell window, restart against the same
database and environment:

```powershell
npm.cmd run acceptance:live-entry:server:entry
```

Refresh the browser. The durable run ID and effective `RISK_REDUCING` approval
must be unchanged. The new process intentionally has a different readiness
policy fingerprint, so use fresh entry-profile readiness evidence.

### Entry profile

7. Enter a reason and click **Stage RSP canary**. Confirm only `rsp_dip_core` allows entries, exits remain enabled, and the account stays `ACTIVE / entry-disarmed`.
8. Run Live Entry Arming readiness. Confirm it is current and blocked by missing `ENTRY` authorization, with the deployment entry policy enabled.
9. Grant `ENTRY`; choose a future expiration within the displayed synthetic regular session and type `APPROVE LIVE ENTRY`.
10. Run Live Entry Arming readiness again. Confirm `PASSED / CURRENT` with the exact approval revisions, assignment, sizing, and fingerprints.
11. Enter an arming reason, type `ARM LIVE ENTRIES`, and arm. Confirm the arming is bound to the same durable run and no broker POST has occurred.
12. Generate the preview. Review LIVE, account, assignment, BUY RSP, exact quantity, MARKET / DAY, price/notional, expiration, and one-shot consumption warning.
13. Type `BUY RSP` and submit. The normal worker sends exactly one intercepted POST. The mock then exposes one deterministic full fill and matching RSP broker position through the exact read routes used by verification.
14. Wait for OrderIntent and BrokerOrder evidence to appear, then click **Refresh authoritative verification**. If a worker poll reports not-yet-due, wait briefly and refresh verification again; verification performs reads only and never resubmits.
15. Confirm `CANARY COMPLETE`, filled OrderIntent/BrokerOrder, correctly attributed TrackedPosition and exit lifecycle, consumed arming, no active arming, disabled account trading, enabled kill switch, disabled assignment entries, and no reconciliation discrepancy.

Stop the backend and UI with Ctrl+C. Repeat the complete reset/migrate/seed/
paused-fixture sequence for another pristine ceremony. Never rerun the fixture
between the two server profiles because the durable run must survive the restart.

## Profiles and legacy regression controls

- `server:activation` forces `ALLOW_LIVE_RISK_REDUCING_WRITES=true` and `ALLOW_LIVE_TRADING=false` inside the guarded harness process.
- `server:entry` forces both permissions true inside a newly started guarded harness process.
- `fixture:paused` is the complete-ceremony fixture.
- The legacy `acceptance:live-entry:fixture` command still bootstraps ACTIVE plus `RISK_REDUCING` for lower-level post-activation regression work.

The loopback control API remains available for automated and lower-level harness
diagnostics, but it is not used by the complete browser ceremony.
