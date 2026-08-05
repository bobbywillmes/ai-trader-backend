# Responsive catalog pages

Strategies, the global Subscription Catalog, Exit Profiles, and administrative catalogs use the shared responsive data-display primitives. Their presentation is selected from the width of the page container rather than the browser viewport:

- Wide containers use concise semantic tables.
- Compact containers use summary rows with stable inline details.
- Narrow containers use record cards and a focus-managed details drawer.

Catalog summaries keep a strong record identity, full status label, a small set of operational values, a stable Details control, and a distinct action area. Long descriptions are clamped in summaries and remain available in details. Raw database IDs, keys, and enum values belong in the collapsed **Routing & identifiers** section.

## Subscription boundaries

`Subscription` is a global catalog definition. It owns the security, strategy, default exit profile, description, and global enabled/retired state.

`TradingAccountSubscription` is an account-specific assignment. It owns deployment switches, entry and exit permissions, allocation, and sizing. The global catalog may summarize assignment usage across accounts, but must not present account allocation or sizing as catalog configuration. Editing account assignments remains in the relevant Trading Account page.

## Details hierarchy

Catalog detail views start with identity and user-facing configuration, followed by behavior and dependency usage. Technical routing values are collapsed by default. New catalog pages should keep summary fields concise and use `RecordDetailsGrid` inside small domain-focused sections rather than adding columns for every property.

## Dependency and consequential-action safety

Retire, disable, and other consequential actions are secondary actions, not prominent list controls. Existing confirmations, impact queries, dependency checks, loading locks, and API payloads must remain intact. Exit Profile edits continue to warn and require confirmation when enabled subscriptions depend on the profile. No delete action should be invented when the existing API does not expose one.

Create and edit dialogs stack fields on narrow containers, use intentional two-column groups when space allows, scroll internally at short viewport heights, and keep footer actions reachable. Stable keys remain immutable after creation where required by the existing contract.

## Reuse guidance

Future catalog pages should compose `ResponsiveDataView`, `DataTable`, `CompactRecordList`, `MobileRecordCard`, `ResponsiveDetails`, `ResponsiveFilterToolbar`, `DataState`, `StatusBadge`, and `ResponsiveActions`. Keep domain rules in the feature and avoid adding business-specific props to shared primitives. Verify semantic tables, full badge labels, keyboard focus restoration, filter drawers, filtered-empty states, long identifiers, and mobile touch targets at each responsive milestone.

## Users and account access

The Users catalog combines the existing user, per-user membership, and trading-account read contracts. Wide containers show a concise semantic table, compact containers show expandable summary rows, and narrow containers use cards with a focus-managed details drawer. Summary access text distinguishes unrestricted System Owner scope, explicit trading-account memberships, and accounts held by the user. It does not imply that account holding and membership are interchangeable.

Identity, account access, and security/setup state are grouped in details. User and membership IDs remain collapsed under **Routing & identifiers**. Create and manage surfaces keep role, enabled state, and membership selection visible while preventing saves when membership data could not be loaded. Existing server-side System Owner, self-management, ownership, membership, and authorization safeguards remain authoritative.
