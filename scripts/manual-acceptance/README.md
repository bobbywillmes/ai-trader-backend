# Live-entry-arming manual acceptance harness

This harness runs the real backend, frontend, authorization services, order worker, and Prisma schema against a disposable local database. It replaces only the process-global Alpaca `fetch` transport. The replacement accepts the two exact Alpaca HTTPS hostnames, answers them in memory, and throws for every other outbound `fetch`; no accepted request reaches the network.

The harness is deliberately outside `src/`, requires an explicit sentinel, refuses any database except `ai_trader_live_entry_acceptance`, and binds its control API to `127.0.0.1`. It is not a production runtime mode.

## Prerequisites and environment

Start the repository's local PostgreSQL container. In a fresh PowerShell window at the repository root, set synthetic process-local values (do not edit `.env`):

```powershell
$env:DATABASE_URL='postgresql://trader:traderpass@localhost:5432/ai_trader_live_entry_acceptance'
$env:NODE_ENV='production'
$env:PORT='3000'
$env:CORS_ALLOWED_ORIGINS='https://manual-acceptance.invalid'
$env:ALPACA_API_KEY='synthetic-global-key'
$env:ALPACA_API_SECRET='synthetic-global-secret'
$env:ALPACA_BASE_URL='https://paper-api.alpaca.markets'
$env:MASSIVE_API_KEY='synthetic-massive-key'
$env:AI_TRADER_SIGNAL_API_KEY='synthetic-signal-key-acceptance'
$env:AI_TRADER_ADMIN_API_KEY='synthetic-admin-key-acceptance'
$env:TRADING_CREDENTIAL_ENCRYPTION_KEY='AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
$env:TRADING_CREDENTIAL_ENCRYPTION_KEY_ID='manual-acceptance-v1'
$env:LIVE_WRITE_DEPLOYMENT_ROLE='PRODUCTION_EXECUTOR'
$env:ALLOW_LIVE_RISK_REDUCING_WRITES='true'
$env:ALLOW_LIVE_TRADING='true'
$env:ALLOW_TRADING_ENABLED_ON_START='true'
$env:MASSIVE_NEWS_WORKER_ENABLED='false'
$env:MANUAL_ACCEPTANCE_HARNESS='I_UNDERSTAND_THIS_IS_SYNTHETIC'
$env:MANUAL_ACCEPTANCE_CONTROL_TOKEN='local-control-token-acceptance'
```

## Reset and start

Resetting terminates connections only to the exactly named disposable database, drops it, and recreates it. It cannot target the ordinary development database because the reset script checks the URL path first.

```powershell
npm.cmd run acceptance:live-entry:reset
npx.cmd prisma migrate deploy
npx.cmd tsx src/db/seed.ts
npm.cmd run acceptance:live-entry:fixture
npm.cmd run acceptance:live-entry:server
```

In a second PowerShell window, start the actual UI. Its existing `/api` proxy points to the isolated backend on port 3000:

```powershell
Set-Location apps/web
npm.cmd run dev
```

Open `http://localhost:5173` and log in with:

- Email: `owner@live-entry-acceptance.invalid`
- Password: `Synthetic-Acceptance-Only-2026!`
- Account: `Synthetic Live Acceptance`

## Ceremony

1. On the account readiness tab, confirm `ACTIVE · ENTRY DISARMED`, deployment permission enabled, effective `RISK_REDUCING`, missing `ENTRY`, no staged canary, and closed account latches.
2. Enter a reason and click **Stage RSP canary**. Confirm only `rsp_dip_core` has entries enabled, exits remain enabled, the account is still `ACTIVE` with `tradingEnabled=false` and `killSwitchEnabled=true`, and the UI reads `ACTIVE · ENTRY STAGED`.
3. Run `LIVE_ENTRY_ARMING` readiness. Confirm `BLOCKED`, `prerequisitesForEntryGrantPassed=true`, and ENTRY authorization is the only blocker.
4. In Live write authorization, grant ENTRY. Use a future expiration before the displayed synthetic session close and type `APPROVE LIVE ENTRY`. Confirm revision 1, immutable history, effective RISK_REDUCING, unchanged account latches, and zero POSTs.
5. Run `LIVE_ENTRY_ARMING` again. Confirm `PASSED / CURRENT`, the exact account, ENTRY revision, RSP assignment, fingerprints, estimated quantity/notional, and the one-entry/$1,000 controls.
6. Enter a reason, type `ARM LIVE ENTRIES`, and click **ARM LIVE ENTRIES**. Confirm `ACTIVE · ENTRIES ARMED`, permissive latches, an active immutable arming bound to the exact approval and assignment, and zero POSTs.
7. Trigger one legitimate synthetic signal and the real order worker:

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3101/entry -Headers @{Authorization='Bearer local-control-token-acceptance'}
   ```

   Confirm `postCount` is 1, the OrderIntent/BrokerOrder exists, and the arming has a `CONSUMED` termination with order-intent/client-order evidence.
8. Force the same real worker path to retry that intent:

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3101/retry-consumed -Headers @{Authorization='Bearer local-control-token-acceptance'}
   ```

   Confirm local rejection/audit evidence and `postCount` remains 1.
9. In the UI click **DISARM LIVE ENTRIES**. Confirm `ACTIVE · ENTRY DISARMED`, closed latches, no active arming, disabled entry assignments, ineffective ENTRY, preserved RISK_REDUCING, and no additional POST.

At any time inspect the complete in-memory transport ledger and isolated account evidence:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3101/state -Headers @{Authorization='Bearer local-control-token-acceptance'} | ConvertTo-Json -Depth 12
```

Stop both processes with Ctrl+C. Repeat the reset/migrate/seed/fixture sequence for a pristine ceremony. The ordinary `ai_trader` database is never opened by the harness processes.

## Failure ceremonies

Run each on a freshly armed fixture and inspect `/state` before and after. Approval expiry can use a short same-session expiry. Approval replacement uses the normal ENTRY grant UI after disarming/re-staging; the prior arm must not transfer. Assignment mutation uses the Subscriptions tab. Credential re-verification uses the Credentials UI and the in-memory `/v2/account` response. Deployment-policy mismatch is best covered by stopping the harness, setting `ALLOW_LIVE_TRADING=false`, and restarting; startup/monitor/final authorization must fail closed. After each mutation, call `/retry-consumed` or allow the two-second arming monitor tick, then confirm closed latches, an immutable invalidation/expiry termination, preserved RISK_REDUCING where designed, and unchanged mock POST count.

The initial RISK_REDUCING grant is fixture bootstrap data with an immutable decision row. All ceremony operations after reset—including canary staging, ENTRY grant, readiness, arm, entry authorization/consumption, retry rejection, and disarm—use real application services or HTTP/UI routes.
