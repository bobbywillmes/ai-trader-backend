# Live-entry-arming manual acceptance harness

This harness runs the real backend, frontend, authorization services, order worker, and Prisma schema against a disposable local database. It replaces the process-global `fetch` transport for the exact Alpaca calls and the single Massive RSP latest-price snapshot required by this ceremony. Those requests are answered in memory. Every other hostname, Massive endpoint or symbol, and unrelated outbound request is denied; no accepted request reaches the network.

The harness is deliberately outside `src/`, requires an explicit sentinel, refuses any database except `ai_trader_live_entry_acceptance`, and binds its control API to `127.0.0.1`. It is not a production runtime mode.

At startup, the guarded harness sets only the isolated database's global `tradingEnabled=true` and `killSwitchEnabled=false` runtime controls. The real risk gate requires these global emergency controls in addition to the synthetic account's arming latches. This adjustment requires the exact harness sentinel, internal entrypoint marker, acceptance database name, and loopback UI origin; ordinary production startup cannot activate it. The legacy global `paperMode` setting is left unchanged because broker routing is owned by `TradingAccount.environment`.

## Prerequisites and environment

Start the repository's local PostgreSQL container. In a fresh PowerShell window at the repository root, set synthetic process-local values (do not edit `.env`):

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
$env:ALLOW_LIVE_RISK_REDUCING_WRITES='true'
$env:ALLOW_LIVE_TRADING='true'
$env:ALLOW_TRADING_ENABLED_ON_START='true'
$env:MASSIVE_NEWS_WORKER_ENABLED='false'
$env:MANUAL_ACCEPTANCE_HARNESS='I_UNDERSTAND_THIS_IS_SYNTHETIC'
$env:MANUAL_ACCEPTANCE_CONTROL_TOKEN='local-control-token-acceptance'
```

On this Windows/Docker Desktop environment, use `127.0.0.1` rather than `localhost`. Node resolves `localhost` to `::1` first here, which can cause PostgreSQL connection resets through Docker's IPv6 published listener.

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

The current fixture intentionally begins at `ACTIVE / ENTRY DISARMED` with an
effective bootstrapped `RISK_REDUCING` approval. It supports the real browser UI
and real application HTTP/services from durable run creation onward, but it does
not currently exercise PAUSED activation or the initial RISK_REDUCING grant.

1. On the account readiness tab, confirm `ACTIVE · ENTRY DISARMED`, deployment permission enabled, effective `RISK_REDUCING`, missing `ENTRY`, no staged canary, and closed account latches.
2. Start a durable acceptance run in **Live Entry Acceptance**. Confirm the run remains in Setup until its staged-assignment prerequisite is satisfied.
3. Enter a reason and click **Stage RSP canary**. Confirm only `rsp_dip_core` has entries enabled, exits remain enabled, the account is still `ACTIVE` with `tradingEnabled=false` and `killSwitchEnabled=true`, and the UI reads `ACTIVE · ENTRY STAGED`.
4. Run `LIVE_ENTRY_ARMING` readiness. Confirm `BLOCKED`, `prerequisitesForEntryGrantPassed=true`, and ENTRY authorization is the only blocker.
5. In Live write authorization, grant ENTRY. Use a future expiration before the displayed synthetic session close and type `APPROVE LIVE ENTRY`. Confirm revision 1, immutable history, effective RISK_REDUCING, unchanged account latches, and zero POSTs.
6. Run `LIVE_ENTRY_ARMING` again. Confirm `PASSED / CURRENT`, the exact account, ENTRY revision, RSP assignment, fingerprints, estimated quantity/notional, and the one-entry/$1,000 controls.
7. Type `ARM LIVE ENTRIES` and click **ARM LIVE ENTRIES**. Confirm `ACTIVE · ENTRIES ARMED`, permissive latches, an active immutable arming bound to the run and exact assignment, and zero POSTs.
8. Generate the execution preview. Confirm LIVE, the synthetic account and RSP assignment, BUY, exact quantity, MARKET / DAY, reference price/notional, arming expiration, and the one-shot consumption warning. Type `BUY RSP` and submit through the UI.

   The harness returns a deterministic accepted broker order without a fill. The run must remain in Verification rather than falsely reporting CANARY COMPLETE. Use `/state` to confirm one acceptance-linked OrderIntent, one run-bound consumed arming, and exactly one POST.

   The legacy direct-signal control remains available for lower-level arming regression checks:

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3101/entry -Headers @{Authorization='Bearer local-control-token-acceptance'}
   ```

   Confirm `postCount` is 1, the OrderIntent/BrokerOrder exists, and the arming has a `CONSUMED` termination with order-intent/client-order evidence.
9. Force the same real worker path to retry that intent only for the legacy direct-signal regression:

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3101/retry-consumed -Headers @{Authorization='Bearer local-control-token-acceptance'}
   ```

   Confirm local rejection/audit evidence and `postCount` remains 1.
10. In the UI click **DISARM LIVE ENTRIES**. Confirm `ACTIVE · ENTRY DISARMED`, closed latches, no active arming, disabled entry assignments, ineffective ENTRY, preserved RISK_REDUCING, and no additional POST.

At any time inspect the complete in-memory transport ledger and isolated account evidence:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3101/state -Headers @{Authorization='Bearer local-control-token-acceptance'} | ConvertTo-Json -Depth 12
```

Stop both processes with Ctrl+C. Repeat the reset/migrate/seed/fixture sequence for a pristine ceremony. The ordinary `ai_trader` database is never opened by the harness processes.

## Failure ceremonies

Run each on a freshly armed fixture and inspect `/state` before and after. Approval expiry can use a short same-session expiry. Approval replacement uses the normal ENTRY grant UI after disarming/re-staging; the prior arm must not transfer. Assignment mutation uses the Subscriptions tab. Credential re-verification uses the Credentials UI and the in-memory `/v2/account` response. Deployment-policy mismatch is best covered by stopping the harness, setting `ALLOW_LIVE_TRADING=false`, and restarting; startup/monitor/final authorization must fail closed. After each mutation, call `/retry-consumed` or allow the two-second arming monitor tick, then confirm closed latches, an immutable invalidation/expiry termination, preserved RISK_REDUCING where designed, and unchanged mock POST count.

The initial RISK_REDUCING grant is fixture bootstrap data with an immutable decision row. All ceremony operations after reset—including canary staging, ENTRY grant, readiness, arm, entry authorization/consumption, retry rejection, and disarm—use real application services or HTTP/UI routes.

## Pre-activation coverage gap

The production prerequisite order before the supported harness starting point is:

1. Safely PAUSED account with entries disarmed.
2. Current `LIVE_ACTIVATION` assessment used as RISK_REDUCING grant evidence.
3. Effective `RISK_REDUCING` approval.
4. A new passing `LIVE_ACTIVATION` assessment with that approval effective.
5. Activation to `ACTIVE` while trading remains disabled and the kill switch remains enabled.

The smallest safe enhancement for exercising those steps is a second guarded
fixture/profile for the same isolated database. It should leave the account
PAUSED without a bootstrapped approval and start the harness with
`ALLOW_LIVE_TRADING=false`; after activation, the harness must be stopped and
restarted explicitly in its existing entry-enabled profile. This preserves the
real deployment-policy boundaries and avoids any runtime fake-broker switch or
in-process policy toggle. Until that profile exists, use the current harness for
the browser-driven post-activation ceremony and automated tests for the
pre-activation graph.
