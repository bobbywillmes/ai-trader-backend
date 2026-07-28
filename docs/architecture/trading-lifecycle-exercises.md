# Trading lifecycle exercises

Trading lifecycle exercises are the primary human-operated surface for proving
the account-specific trading lifecycle without replacing n8n signal routes.
The initial implementation is deliberately **Paper-only**.

## Selection and preview

A System Owner selects one catalog `Subscription` and either specific account
holder Users or Everyone eligible. Selection follows
`TradingAccount.accountHolderUserId`; memberships never create a target. Every
matching `TradingAccountSubscription` becomes one frozen target, ordered by
Trading Account ID and assignment ID. Previews are limited to 25 targets and
record disabled, missing, duplicate, and otherwise unresolved User selections.

Preview reuses existing sizing and entry-risk services. It creates no
`OrderIntent` and performs no broker write. Evidence covers account,
credentials, allocation, assignment, catalog, sizing, exposure, risk, and entry
session checks.

The configuration fingerprint covers selection, frozen assignments, account and
risk configuration, allocations, assignment sizing and enablement, and catalog
Security, Strategy, Subscription, and ExitProfile configuration. Market prices
are excluded. A preview expires after five minutes.

## Launch and idempotency

Launch requires `{ "confirmation": "LAUNCH PAPER EXERCISE" }`. An atomic
`PREVIEWED` to `LAUNCHING` claim prevents concurrent or repeated launch. Paper
identity, expiration, frozen relationships, target count, and configuration
fingerprint are revalidated before dispatch.

Ready targets run sequentially through `processEntryForAccountSubscription`
using `lifecycle-exercise:{exerciseId}:target:{targetId}`. The shared entry
service remains authoritative for sizing, risk, duplicate protection,
client-order IDs, `OrderIntent` creation, broker-write policy, and outcome
classification. Workers asynchronously handle submission, fills, positions,
exits, and synchronization.

## Projection and completion

Exercise records do not implement another trading state machine. Detail
responses derive stages and timelines from `OrderIntent`, `BrokerOrder`,
`BrokerActivity`, `TrackedPosition`, `PositionExitState`, and reconciliation
evidence without fabricating timestamps.

A target is reconciled only when diagnostic reconciliation is clean and its
authoritative lifecycle is terminal. An exercise completes only after every
remaining target is reconciled or cancelled.

## Cancellation, manual close, and reconciliation

Cancellation stops undispatched work and retains evidence. It does not cancel
broker or protective orders, close positions, disable accounts, or stop
lifecycle workers. Already-dispatched work continues normally.

Manual close uses the existing account-scoped close endpoint. There is no timed
automatic close. Target reconciliation wraps existing account-scoped diagnostic
reconciliation without repair mutations and stores only a sanitized summary.

## API and access

```text
POST /api/trading-lifecycle-exercises/preview
POST /api/trading-lifecycle-exercises/:id/launch
POST /api/trading-lifecycle-exercises/:id/cancel
POST /api/trading-lifecycle-exercises/:exerciseId/targets/:targetId/reconciliation
GET  /api/trading-lifecycle-exercises
GET  /api/trading-lifecycle-exercises/:id
```

`tradingLifecycleExercise.read` and `tradingLifecycleExercise.write` are granted
only through the System Owner all-permissions rule in this phase.

## Future Live extension

Live targets, mixed environments, provisioning, activation, write permits, and
the first Live canary remain future work. Live support must add explicit
readiness and authorization; it must not loosen the Paper boundary.
