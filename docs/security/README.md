# Access Control and RBAC

AI Trader separates machine authentication, human sessions, platform permissions, and Trading Account scope.

## Authentication boundaries

- n8n uses `AI_TRADER_SIGNAL_API_KEY` on signal/client routes.
- Human users authenticate through `/api/auth` and use a User session bearer token.
- The static admin API key is reserved for trusted maintenance operations and is not an n8n credential.

There is no public registration. A system owner creates invitations in **System → Users & Access**, then shares the generated one-time setup link manually. Setup tokens are hashed in the database, expire after seven days, and are invalidated when regenerated.

## Platform roles and application surfaces

| Platform role | Application surface | Account scope |
| --- | --- | --- |
| `SYSTEM_OWNER` | Admin Console | Unrestricted; membership scope is bypassed |
| `OPERATOR` | Admin Console | Explicit `TradingAccountMembership` records |
| `ACCOUNT_USER` | Shared console with a simplified personal navigation surface | Explicit `TradingAccountMembership` records |

Platform role selects available application capabilities. Platform permissions remain the backend-aligned capability vocabulary. Trading account memberships independently determine which accounts a non-system-owner user may access.

`accessibleTradingAccountIds` semantics:

- `null`: unrestricted System owner scope
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

System owners receive every permission. Operators receive operational trading, risk, subscription, strategy-read, exit-profile-read, and reporting permissions. Account Users receive the read permissions needed for Dashboard, My Accounts, Open Positions, Open Orders, Reports, and Trade History, subject to membership scope.

## Enforcement and validation

The backend validates the session, platform permission, and Trading Account membership where applicable. The web UI derives navigation and direct-route guards from shared route policies. Hiding a link is never treated as the security boundary; account-specific reads still validate membership, aggregate reads resolve the user's authorized account set, and sensitive writes retain their existing owner/permission middleware.

Disabled users and users with incomplete setup cannot sign in. The backend prevents demoting the final System Owner, disabling the final enabled System Owner, changing one's own platform role, and removing a membership required by an account-holder assignment.

- Confirm system owner login enters the full owner console and can open `/users`.
- Confirm Operator login enters the owner console and only sees permitted features.
- Confirm account user login enters `/dashboard`, sees only the personal navigation surface, and can access only membership-scoped accounts.
- Confirm direct unauthorized routes and API requests are rejected.
- Confirm invitation, setup completion, setup-link regeneration, and membership replacement.
- Confirm n8n continues to authenticate only with its signal API key.
