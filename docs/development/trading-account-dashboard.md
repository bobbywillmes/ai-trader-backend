# Trading Account-scoped Dashboard

Dashboard uses the Phase 1 URL-backed `TradingAccountScopeProvider`. The sidebar selector and the wider in-page selector both call the same `setScope()` function, so `?account=all` and `?account=<TradingAccount.id>` are authoritative and browser history updates both controls.

## Selected account

`GET /api/trading-accounts/:id/dashboard` requires account access and `reports.read`. It orchestrates broker account, position, order, and operational entry-readiness reads for exactly the authorized Trading Account. Missing or unusable credentials skip broker calls and return identity, credential and account-owned safety state with unavailable financial data. Independent broker failures are returned as partial failures instead of turning unknown values into zeroes.

Operational entry readiness is distinct from stored LIVE activation readiness. It uses the selected account's `tradingEnabled`, `killSwitchEnabled`, broker state, current usage, effective entry limits, and entry-session decision. Legacy global emergency controls remain separate system blockers; they do not change the account's PAPER/LIVE identity.

Selected-account data polls every 10 seconds and is fresh in the query cache for 5 seconds. Broker observations include an observation timestamp.

## All Trading Accounts

`GET /api/dashboard/accounts-overview` is limited to SYSTEM_OWNER and OPERATOR admin-console roles. SYSTEM_OWNER sees all accounts; OPERATOR sees membership-authorized accounts. The server derives access from authenticated context and never accepts client-supplied account IDs.

ALL is database-only. It uses Trading Accounts, credential metadata, latest account snapshots, tracked positions, and nonterminal broker orders, and performs no broker fan-out. Rows keep PAPER/LIVE identity and financial snapshots separate. Summary values are counts only; portfolio value, equity, cash, buying power, day P/L, returns, and deployable capital are never aggregated across accounts or holders. Snapshots older than 15 minutes are marked stale.

## Market context and compatibility

ETF Market Pulse remains an independent shared query and renders in selected and ALL modes. Account errors do not hide market context, and market errors do not hide account data.

Dashboard no longer consumes `GET /api/bootstrap`. That endpoint and its response remain available for compatibility, but it is deprecated for Dashboard use because it retains legacy default-account semantics.
