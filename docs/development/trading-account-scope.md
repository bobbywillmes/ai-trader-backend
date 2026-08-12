# Frontend TradingAccount Scope

The Admin Console has a first-class, URL-authoritative TradingAccount scope used by every account-filterable operational page.

## Scope and URL

The frontend scope is either all accessible accounts or one validated accessible account:

```ts
type TradingAccountScope =
  | { type: "ALL" }
  | { type: "ACCOUNT"; tradingAccountId: number };
```

The URL uses `?account=all` or `?account=<TradingAccount.id>`. The provider does not mirror this selection in component state or local storage. Selector changes push browser-history entries. Missing, malformed, deleted, and inaccessible values are replaced with a canonical safe default after the accessible-account query succeeds. Other search parameters are retained during scope changes.

Sidebar navigation carries only the `account` parameter. It does not copy page-specific filters to a different destination.

## Defaults and authorization

`GET /api/trading-accounts` is the authorization boundary and the source of selector records. The provider never validates an ID by guessing from auth metadata or legacy configuration.

- A System Owner defaults to `ALL`.
- A non-owner with exactly one accessible account defaults to that account.
- A user with multiple or no accessible accounts defaults to `ALL`.
- No legacy default ID, environment, display name, or account ordering participates in selection.

Until the account list succeeds, the context exposes a safe `ALL` scope and a loading or error state. A failed list request is shown as an error, not interpreted as authorized aggregate access. Invalid and inaccessible IDs receive the same generic notification so the UI does not disclose whether another user's account exists.

## Page scope modes

Route scope is classified centrally in `apps/web/src/app/pageScope.ts`:

- `ACCOUNT_FILTERABLE`: Dashboard, Open Positions, Open Orders, Trade History, Entry Decisions, System Events, and Reports. The shell and page present synchronized views of the shared interactive selector, and each page sends either `ALL` or one explicit account identity in its query key and backend request.
- `ACCOUNT_SPECIFIC`: TradingAccount detail and Reconciliation routes. A concrete route account is authoritative. The shell hides the scope-selector area because the page itself identifies its resource.
- `SYSTEM`: global catalog, research, configuration, and administration pages, including the Trading Accounts directory, Users & Access, Strategies, Exit Profiles, Securities, Subscription Catalog, Momentum Scanner, Market Diary, Settings, and Lifecycle Exercises. The selector is hidden so the page does not appear filtered.

Scope persistence and scope applicability are separate. The `account` URL parameter may remain while visiting a `SYSTEM` page, but that page must not use it to filter data. Returning through scoped sidebar navigation restores the prior account context.

The same separation applies to `ACCOUNT_SPECIFIC` routes. For example, `/trading-accounts/1?account=2` displays TradingAccount 1 because the path owns current-page identity while preserving TradingAccount 2 as the operational scope to restore on the next `ACCOUNT_FILTERABLE` page. The shell displays neither identity in its scope-selector area on this route. Links into account-specific resources must carry the existing `account` parameter; they must never rewrite it to match the resource ID.

Pages that own additional URL filters must update only their declared parameter keys. They clone the current query string, remove or replace their owned keys, and retain `account` and every other unrelated key. This prevents independent URL owners from competing with the scope provider.

Reconciliation uses `/trading-accounts/:id/reconciliation`, with the path ID as its authoritative target and the global scope selector hidden. Its in-page target selector changes the route ID while preserving the dormant operational scope. The compatibility `/system/reconciliation` route redirects only from a concrete authorized `?account=<id>`; `ALL`, missing, malformed, or inaccessible scope requires explicit selection and never falls back to a default account. Account Users use the same canonical routes and scope provider as other roles.

## Query and mutation safety

Operational pages should call `useTradingAccountScope()` only on routes whose metadata permits account filtering. They must not issue account-specific requests until `isLoading` is false, `isError` is false, and an `ACCOUNT` scope has a non-null `selectedAccount`.

Every TanStack Query key introduced or converted for scoped data must include stable scope identity, for example `"all"` for aggregate data or the numeric `tradingAccountId` for account data. Query functions and keys must change together so cache entries cannot leak across TradingAccount scopes. Cross-scope navigation must show the target cache or loading state, never previous-account placeholder data. Account-owned mutations must take identity from the record or route, then invalidate that account and the corresponding `ALL` overview when its aggregate state can change.

Phase 2 made Dashboard a scope consumer. Its sidebar and in-page selectors share this provider, and Dashboard no longer uses the legacy `/api/bootstrap` account or presents AI Trader as globally PAPER. See `trading-account-dashboard.md`.

Phase 4 makes Trade History and Entry Decisions scope consumers. Both list APIs require `account=all` or an explicit TradingAccount ID and enforce owner/all versus membership access on the server. Route policy keeps Entry Decisions operational-only, while Trade History supports Account Users over their authorized account set. Detail authorization follows the record's persisted TradingAccount attribution rather than the selected UI scope or the legacy default account.

Entry Decisions preserve historical `tradingAccountId = null` rows without inferring ownership. System Owners may see these records only in `account=all`, where the UI labels them `Legacy / Unattributed`. Selected-account lists exclude them, and non-owner aggregate lists exclude them because they cannot be tied to an authorized membership. Attributed records show TradingAccount and PAPER/LIVE identity in aggregate views. Trade cycles remain limited to canonically attributed TradingAccounts.

Trade History and Entry Decisions use server-side pagination with `page` and `pageSize` query parameters. Both default to 25 records per page and offer 25, 50, or 100 records per page. Pagination is applied after account authorization and page filters, and changing a filter or page size resets the view to page 1 without discarding unrelated URL parameters. Text filters remain local drafts until Enter or Filter Results applies them, preventing a request for every keystroke.

System Events and Reports also consume the shared provider. A selected System Events scope returns only events whose persisted `tradingAccountId` matches that account. Owner `ALL` includes all attributed events plus `tradingAccountId = null` system events, which the UI labels `SYSTEM`. Operator `ALL` includes membership-attributed events only; global events are not inferred into account access.

Report reads require the same explicit account parameter. Snapshot, broker-activity, and canonical trade-cycle performance queries resolve an authorized account set on the server and preserve each row's persisted account attribution. In `ALL`, snapshot balances and trend charts and combined performance financial ratios are intentionally omitted because PAPER, LIVE, different holders, and unrelated brokerage accounts do not form one portfolio. Audit rows remain account-attributed. Legacy default-account service wrappers remain for unrelated consumers, while these Admin Console reads do not use them.

## Compatibility boundary

The current frontend has no runtime consumer of `GET /api/bootstrap`, legacy `GET /api/orders/open`, legacy tracked-position reads, legacy default-account close routes, or `POST /api/reconciliation/run`. `GET /api/bootstrap` and `POST /api/reconciliation/run` remain SYSTEM_OWNER-only compatibility endpoints because private or external consumers are not yet proven absent. Their default-account semantics must not be reused by new Admin Console code. Reconciliation UI uses only `POST /api/trading-accounts/:id/reconciliation/run`; position and order actions use account IDs carried by their records.

`paperMode` remains a legacy system-global safety guard and is labeled that way in Settings. It does not describe the selected account. PAPER/LIVE identity belongs to each TradingAccount and must be explicit in account selectors, aggregate records, and confirmations for broker-affecting LIVE actions.
