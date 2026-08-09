# Frontend TradingAccount Scope

The Admin Console has a first-class, URL-authoritative TradingAccount scope. Phase 1 establishes the scope infrastructure and shell presentation; operational page queries remain unchanged until later phases.

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

- `ACCOUNT_FILTERABLE`: Dashboard, Open Positions, Open Orders, Trade History, Entry Decisions, System Events, and Reports. The shell presents the interactive selector. Later phases will make these pages consume it.
- `ACCOUNT_SPECIFIC`: TradingAccount detail, Reconciliation, and account-specific portal routes. A concrete route account is authoritative and the shell presents explicit, non-interactive account context rather than an aggregate choice.
- `SYSTEM`: global catalog, research, configuration, and administration pages, including the Trading Accounts directory, Users & Access, Strategies, Exit Profiles, Securities, Subscription Catalog, Momentum Scanner, Market Diary, Settings, and Lifecycle Exercises. The selector is hidden so the page does not appear filtered.

Scope persistence and scope applicability are separate. The `account` URL parameter may remain while visiting a `SYSTEM` page, but that page must not use it to filter data. Returning through scoped sidebar navigation restores the prior account context.

The current Reconciliation URL (`/system/reconciliation`) has no account identity in its path even though its semantics are account-specific. Phase 1 classifies it as `ACCOUNT_SPECIFIC`, hides the aggregate selector, and labels the shell context generically. A later reconciliation conversion must introduce or derive an authoritative account identity before using the new scope for requests. The Account Portal retains its existing route-authoritative model and is not wrapped in the Admin Console scope provider.

## Consuming scope in future phases

Operational pages should call `useTradingAccountScope()` only on routes whose metadata permits account filtering. They must not issue account-specific requests until `isLoading` is false, `isError` is false, and an `ACCOUNT` scope has a non-null `selectedAccount`.

Every TanStack Query key introduced or converted for scoped data must include stable scope identity, for example `"all"` for aggregate data or the numeric `tradingAccountId` for account data. Query functions and keys must change together so cache entries cannot leak across TradingAccount scopes.

The Dashboard's existing `PAPER TRADING` badge still describes the legacy `/api/bootstrap` account. It is not a scope indicator and remains unchanged in Phase 1.
