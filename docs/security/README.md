# Access Control and RBAC

AI Trader separates machine authentication, human sessions, platform permissions, and Trading Account scope.

## Authentication boundaries

- n8n uses `AI_TRADER_SIGNAL_API_KEY` on signal/client routes.
- Human users authenticate through `/api/auth` and use a User session bearer token.
- The static admin API key is reserved for trusted maintenance operations and is not an n8n credential.

There is no public registration. A System Owner creates invitations in **System → Users & Access**, then shares the generated one-time setup link manually. Setup tokens are hashed in the database, expire after seven days, and are invalidated when regenerated.

## Platform roles and application surfaces

| Platform role | Application surface | Account scope |
| --- | --- | --- |
| `SYSTEM_OWNER` | Admin Console | Unrestricted; membership scope is bypassed |
| `OPERATOR` | Admin Console | Explicit `TradingAccountMembership` records |
| `ACCOUNT_USER` | Account Portal at `/portal` | Explicit `TradingAccountMembership` records |

Platform role selects the application surface. Platform permissions control features within the Admin Console. Trading Account memberships determine which accounts a non-System-Owner user may access.

`accessibleTradingAccountIds` semantics:

- `null`: unrestricted System Owner scope
- `[]`: no assigned Trading Accounts
- `number[]`: explicit membership scope

Memberships do not contain account-level roles or capability flags.

## Platform permissions

- `system.settings.read` / `system.settings.write`
- `system.security.read` / `system.security.write`
- `tradingAccount.read` / `tradingAccount.write` / `tradingAccount.risk.write`
- `subscription.read` / `subscription.write`
- `strategy.read` / `strategy.write`
- `exitProfile.read` / `exitProfile.write`
- `reports.read`
- `systemEvents.read`

System Owners receive every permission. Operators receive operational trading, risk, subscription, strategy-read, exit-profile-read, and reporting permissions. Account Users receive the read permissions required by the Account Portal, subject to membership scope.

## Enforcement and validation

The backend validates the session, platform permission, and Trading Account membership where applicable. The Admin UI mirrors those boundaries by routing Account Users to the Account Portal and applying permission checks to Admin Console navigation and direct routes.

Disabled users and users with incomplete setup cannot sign in. The backend prevents demoting the final System Owner, disabling the final enabled System Owner, changing one's own platform role, and removing a membership required by an account-holder assignment.

- Confirm System Owner login enters the full Admin Console and can open `/users`.
- Confirm Operator login enters the Admin Console and only sees permitted features.
- Confirm Account User login enters `/portal` and only sees membership-scoped accounts.
- Confirm direct unauthorized routes and API requests are rejected.
- Confirm invitation, setup completion, setup-link regeneration, and membership replacement.
- Confirm n8n continues to authenticate only with its signal API key.
