# Web console TradingAccount scope

The Admin Console has a first-class, URL-authoritative TradingAccount scope for account-filterable operational pages. Account selection affects presentation and API filtering; it never changes the identity of an account-specific route or authorizes data the user cannot otherwise access.

## URL and selection authority

`?account=all` selects the authorized aggregate view. `?account=<TradingAccount.id>` selects one authorized account. The shell selector and any in-page selector use the same scope provider and update browser history consistently. Missing or invalid values are resolved only according to the scope provider's explicit authorization rules, never by silently borrowing a legacy default account.

Pages own only their declared query parameters. Filter and pagination updates clone the current query string and preserve account scope and unrelated parameters. Links into other operational pages carry the current account query when that page supports shared scope.

## Page modes

- `ACCOUNT_FILTERABLE` pages, including Dashboard, positions, orders, Trade History, Entry Decisions, System Events, and Reports, send either `ALL` or one explicit account identity in their query keys and API requests.
- `ACCOUNT_SPECIFIC` pages, including TradingAccount detail and `/trading-accounts/:id/reconciliation`, take resource identity from the path. A dormant `account` query value may be preserved for later navigation but never selects the current resource.
- System pages do not become account-filtered merely because an `account` query parameter is present.

Authorization is enforced by the backend after resolving the requested account set. System Owners may use authorized aggregate views. Account Users see only accounts granted by membership and only routes permitted to their role. Historical `tradingAccountId = null` records remain explicitly `Legacy / Unattributed`; they are not inferred from current configuration.

## Dashboard ownership

For a selected account, Dashboard uses that account's broker snapshot, persisted configuration, risk usage, effective entry limits, entry-session decision, positions, orders, and current operational evidence. It does not recompute financial or readiness values in the browser.

The all-accounts view aggregates only data returned for the caller's authorized account set and retains each record's PAPER/LIVE and TradingAccount identity. Readiness is distinct from stored activation: it reflects current trading enablement, kill switch, broker state, risk limits, and entry-session evidence without changing account configuration.

Dashboard no longer uses `GET /api/bootstrap`. Legacy default-account endpoints remain compatibility surfaces only and must not be reused by new console code. Reconciliation uses `POST /api/trading-accounts/:id/reconciliation/run`; position and order actions use the account identity carried by their records.

## Pagination and mutations

Account authorization and filters are applied server-side before pagination. Changing a filter or page size resets that page's pagination without discarding unrelated URL state. Mutation invalidation must include the same account identity used by the affected query; an aggregate selection is not permission to issue an account-ambiguous mutation.

The current route configuration, scope provider, API authorization, and tests are the implementation authority.
