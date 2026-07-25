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

When `allocationId` is present, a composite database foreign key requires the
referenced `TradingAccountAllocation` to have the same `tradingAccountId` as
the assignment. Dormant or otherwise non-entry-capable assignments may retain
`allocationId=null`; `tradingAccountId` remains required. Service-layer
ownership, enablement, reservation, transaction, order-entry, and diagnostic
checks remain in place as defense in depth.

Allocations are disabled rather than hard-deleted through the administrative
API. At the database level, referenced allocations cannot be deleted or moved
to another trading account until assignments are explicitly detached. The
ownership migration first counts missing and cross-account allocation
references and aborts with the invalid row count instead of rewriting
audit-sensitive configuration.

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

Global entry requests use `subscriptionKey` and the backend enumerates its
account assignments. Targeted smoke-test requests use one
`tradingAccountSubscriptionId`. For each assignment, runtime resolves:

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

The diagnostic prints independent conclusions:

- `initialBootstrapFidelityValid` is a time-bounded exact-parity assertion for
  an immediate post-bootstrap run. Its immutable output is the strongest proof
  that enablement and sizing were initially copied exactly.
- `legacyMigrationProvenanceValid` proves durable mapping, routing, lifecycle,
  conversion, and divergence provenance. Later writer-valid assignment changes
  are classified and do not fail this gate; unexplained or malformed states do.
- `schemaDropSafe` requires durable migration provenance, no unknown initial
  conversion, no unexplained divergence, and no malformed current assignment.
- `productionBaselineValid` proves that the discovered Bobby Paper account has
  exactly the authoritative curated key set and that the discovered Bobby Live
  account has zero assignments. Missing or ambiguous account discovery fails
  this gate.
- `runtimeEntryReady` proves that every currently active entry-capable
  assignment has complete same-account allocation, reservation, sizing,
  allocation-capacity, account-limit, and entry-risk configuration.

These conclusions are deliberately not interchangeable. `schemaDropSafe` does
not mean an account is ready to trade, and `runtimeEntryReady` does not prove
that legacy values were migrated faithfully. Exact enablement and sizing parity
remain visible evidence, but editable authoritative account assignments may
legitimately diverge after bootstrap. `overallDiagnosticPassed` requires
`schemaDropSafe`, `productionBaselineValid`, and `runtimeEntryReady`. Retired,
assignment-disabled, or entry-disabled deployments may intentionally retain
null allocation and reservation fields.

Assignment-specific administrative changes did not historically emit dedicated
`SystemEvent` audit records. Provenance classification therefore uses assignment
timestamps, the bootstrap note and inferred batch, writer-valid state, and
catalog-level event chronology without claiming actor-level proof.

Retain the complete JSON output as migration evidence before dropping the
legacy columns. A successful result is a prerequisite to the destructive
migration, not a claim that production has already been verified. The SQL
migration currently contains narrower defensive assertions and must not be used
as a substitute for this preflight.

Retain both the restored-backup diagnostic JSON and its reviewed row-level
provenance report as migration evidence.

After the diagnostic succeeds, back up the database, deploy the migration,
regenerate/rebuild the application, and verify health, catalog assignment
counts, Bobby Live safety state, one Bobby Paper risk preview, and an n8n
dry-run payload before enabling normal automation.
