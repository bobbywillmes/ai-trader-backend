# Subscription Catalog and Account Deployment

## Ownership model

A `Subscription` is one reusable global definition: key, name, Security,
Strategy, ExitProfile, description, and global enabled state. It never owns an
account, broker environment, allocation, or sizing.

A `TradingAccountSubscription` deploys that definition to exactly one
`TradingAccount`. It owns allocation, master enablement, entry and exit
permissions, sizing, reserved notional, position limits, quantity limits, and
account-specific notes. A database uniqueness constraint prevents assigning the
same Subscription twice to one account while allowing independent Paper and
Live assignments.

Global enablement controls whether a definition may open new positions anywhere.
Assignment enablement controls one account deployment. `entriesEnabled` controls
new buys. `exitsEnabled` remains independent so an entries-disabled assignment
can still protect or close existing positions. Catalog retirement and entry
disablement do not by themselves stop protective exits.

## Adding and deploying a strategy definition

1. Ensure the Security exists.
2. Choose or create the Strategy and ExitProfile.
3. Create one entry in **Subscription Catalog**. This creates zero account
   assignments.
4. Open **Trading Account → Subscriptions → Add from Catalog**.
5. Select an allocation and configure assignment sizing.
6. Validate account risk and credentials.
7. Deliberately enable the assignment and then entries.

New assignments start with `enabled=false`, `entriesEnabled=false`, and
`exitsEnabled=true`. A newly created TradingAccount starts with no assignments.
Nothing copies Bobby Paper configuration into Bobby Live.

## Execution identity and isolation

Entry requests use `tradingAccountSubscriptionId`. Runtime resolves:

`TradingAccountSubscription → TradingAccount → Allocation → Subscription → Security/Strategy/ExitProfile`

It verifies global and assignment entry switches, ACTIVE account status,
account trading enablement, kill switch, ACTIVE account-scoped credentials,
allocation state, sizing, and the account risk hierarchy. The resulting
`OrderIntent` records `tradingAccountId`, `tradingAccountSubscriptionId`, and
`subscriptionId`. The worker revalidates the same identity and safety state
immediately before broker submission.

There is no default-account or environment-variable credential fallback in
entry routing. Missing or ambiguous assignment identity fails closed. This
prevents a Bobby Paper request from reaching Bobby Live and ensures Bobby Live
cannot trade while it is `NEEDS_CREDENTIALS`, trading-disabled, kill-switched,
or missing active credentials.

Momentum eligibility returns account-specific assignment identities. Research
may refer to catalog Subscriptions, but any produced order signal must select
one of those assignments. External/n8n entry payloads must carry
`tradingAccountSubscriptionId`; `subscriptionKey` is optional and, when sent,
is checked for consistency.

## Onboarding another account holder

Create the User and PAPER or LIVE TradingAccount, configure and verify
account-scoped credentials, configure account risk and allocations, then select
catalog definitions. Create disabled assignments, validate them, and enable
deliberately. Users do not own global Subscriptions.

## Legacy migration

Legacy `Subscription.tradingAccountId`, `broker`, `brokerMode`, `sizingType`,
and `sizingValue` have been removed. The prior one-run
`bootstrap-trading-account-subscriptions.ts` utility is retired; its historical
purpose and field map are recorded in
`subscription-catalog-migration-map.md`. It is not an onboarding mechanism.

Before production migration, run:

```powershell
npx tsx scripts/diagnose-subscription-catalog-migration.ts
```

The diagnostic fails unless Bobby Paper has 25 valid assignments, Bobby Live
has zero, and all assignments have valid allocation and sizing. The SQL
migration independently aborts if any legacy account-owned Subscription lacks a
deterministic assignment or migrated sizing is invalid.

After the diagnostic succeeds, back up the database, deploy the migration,
regenerate/rebuild the application, and verify health, catalog assignment
counts, Bobby Live safety state, one Bobby Paper risk preview, and an n8n
dry-run payload before enabling normal automation.
