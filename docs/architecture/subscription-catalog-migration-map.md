# Subscription Catalog Migration Map

This document records the pre-migration state audited on
`feat/subscription-catalog-and-account-assignment`. It is both the destructive
schema-change checklist and the map from legacy ownership to the target model.

## Target ownership

`Subscription` is a global catalog definition joining one `Security`, one
`Strategy`, and one `ExitProfile`. `TradingAccountSubscription` is the only
account-specific deployment and execution identity. It owns allocation,
enablement, entry/exit permissions, sizing, reservations, limits, and notes.

An entry-capable request must identify one `tradingAccountSubscriptionId`.
Runtime code must fail closed instead of resolving a default account.

## Legacy field migration

| Legacy source | Existing consumers | Target |
| --- | --- | --- |
| `Subscription.tradingAccountId` | Catalog list/create/update, strategy and security UI | Remove. Assignment rows provide account ownership. |
| `Subscription.broker` | Catalog forms, audit payloads, seed data | Remove. `TradingAccount.broker` and its credentials own broker routing. |
| `Subscription.brokerMode` | Catalog forms, seed data, reporting UI | Remove. `TradingAccount.environment` owns PAPER/LIVE routing. |
| `Subscription.sizingType` | Order resolution, catalog/security/strategy UI, bootstrap | Remove after diagnostics. `TradingAccountSubscription.sizingType` is authoritative. |
| `Subscription.sizingValue` | Order resolution, catalog/security/strategy UI, bootstrap | Remove after diagnostics. `fixedQty` or `maxPositionNotional` is authoritative. |
| `Subscription.enabled` | Entry eligibility and admin UI | Retain as the global catalog enable/retire switch. It does not block protective exits. |
| `Subscription.symbol` | Signals, reporting, UI | Retain during this migration for compatibility; validate and synchronize it with `Security.symbol`. `securityId` is the relational source of truth. |

The `(securityId, strategyId, exitProfileId)` combination is deliberately not
unique. Keys are unique, and separate keyed variants of the same combination
remain valid for future catalog evolution.

## Default-account consumers

Default-account resolution is currently used by both read-only compatibility
surfaces and operational paths. It must be removed from:

- Subscription list/create/update.
- `submitOrder` and entry risk evaluation.
- The pending order worker query and broker submission.
- Entry signal ingestion.
- Momentum execution/handoff when it becomes order-capable.

Exit and reconciliation services are audited separately. Existing positions and
broker records may lack assignment identity, so those services may use preserved
recorded `tradingAccountId`; they must not infer a new order destination from a
default account.

## Order-capable contracts

- `POST /api/orders` currently accepts `subscriptionKey` and resolves a default
  account. Entry requests will require `tradingAccountSubscriptionId`.
- `POST /api/signals/entry` currently accepts only `subscriptionKey`. It will
  require `tradingAccountSubscriptionId`; the key may remain only as an optional
  consistency assertion.
- `OrderIntent` already stores `tradingAccountId`,
  `tradingAccountSubscriptionId`, and `subscriptionId`.
- `TrackedPosition` already stores those three identities.
- `EntryDecision` already stores account and assignment identity, but momentum
  eligibility currently begins from catalog keys and must produce or select
  account-specific assignments before execution.
- Risk preview is account-assignment scoped and already uses
  `TradingAccountSubscription`; compatibility fallbacks in the central risk gate
  must be removed for entries.

## Account assignment management

The schema already enforces
`@@unique([tradingAccountId, subscriptionId])`. Existing admin endpoints list,
read, create, and edit assignments. Required changes:

- Create with `enabled=false`, `entriesEnabled=false`, `exitsEnabled=true`.
- Validate that allocation belongs to the same account and is enabled when
  entries are enabled.
- Add catalog availability and safe deletion.
- Refuse deletion when referenced by active positions, non-terminal order
  intents, or other operational state that must retain the relation.
- Keep copied/bulk-created assignments independent; no automatic Paper-to-Live
  copying.

## Transitional scripts and fixtures

`scripts/bootstrap-trading-account-subscriptions.ts` copied legacy Subscription
sizing into Bobby Paper assignments. It is a one-run migration utility, not an
onboarding workflow. It will be moved to an explicitly archived migration
location or changed to diagnostics-only after the production verification
checks below are available.

`src/db/seed.ts` and test fixtures still create legacy Subscription sizing and
must be converted with the destructive schema migration.

## Destructive migration gates

Before legacy columns are dropped, production diagnostics must prove:

1. Every legacy account-owned Subscription has exactly one deterministic
   TradingAccountSubscription mapping for its prior account.
2. Every enabled legacy Subscription intended for Bobby Paper has a Bobby Paper
   assignment with allocation and valid sizing.
3. No enabled assignment has missing/disabled allocation or invalid sizing.
4. The expected 25 Bobby Paper assignments are present.
5. Bobby Live has no assignments.
6. No entry-capable API, worker, signal, momentum, fixture, or script routes by
   `subscriptionKey` or default account.

The destructive migration must contain SQL assertions that abort on unmapped
legacy data. Production deployment must run the diagnostic command before
`prisma migrate deploy`.
