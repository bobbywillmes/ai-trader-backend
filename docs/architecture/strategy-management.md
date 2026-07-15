# Strategy Management

`Strategy` is a dedicated backend and Admin UI domain. Strategy reads, usage
summaries, impact previews, enabled-state safeguards, and audit events are owned
by `strategy.service.ts` and `strategy.controller.ts`. Subscription creation,
account associations, allocation assignment, sizing, and exit-profile assignment
remain owned by the subscription and trading-account domains.

## Independent controls

Strategy enabled state is one layer in the entry-eligibility hierarchy:

```text
System automated trading enabled
-> Strategy enabled
-> Subscription enabled
-> Trading account and allocation eligible
-> Candidate eligible
-> Central risk gate approves entry
```

Changing a strategy changes only `Strategy.enabled`:

- Enabling a strategy does not enable any subscription.
- Disabling a strategy does not disable or rewrite any subscription.
- No account, allocation, sizing, exit-profile, risk, signal, candidate, handoff,
  order, or broker record is created or changed by the strategy mutation.
- Enabling a strategy does not create an order.
- Existing historical candidates, catalysts, decisions, and trades are preserved.

All lower-level controls must still independently qualify before an entry can
progress. The centralized risk gate remains the final entry safety boundary.

## API and authorization

Authenticated users with `strategy.read` can use:

```text
GET /api/strategies
GET /api/strategies/:id
GET /api/strategies/:id/change-impact
```

The list supplies system-wide usage summaries without requiring the UI to join
the default-account subscription endpoint. Detail subscription rows are
paginated and include review-oriented account, allocation, exit-profile, and
sizing context.

Only a `SYSTEM_OWNER` can use:

```text
PATCH /api/strategies/:id
{ "enabled": true }
```

`enabled` is the only mutable strategy property. Unsupported fields and
non-boolean values are rejected. Repeating the stored state is an idempotent
no-op.

The change-impact response must be reviewed before an owner confirms a change
in the Admin UI. Counts describe current database state; they do not imply that
all linked subscriptions will become active.

## Audit trail

A real enabled-state transition creates one transactional `SystemEvent`:

- `strategy_enabled`
- `strategy_disabled`

The event records the actor, previous and resulting state, and bounded usage and
momentum-qualification counts. The strategy update and event creation succeed or
fail together. No event is recorded for an ordinary or concurrent idempotent
request.

## Momentum eligibility

The production momentum strategy keys are `momentum_stock` and `momentum_etf`.
Their enabled state is consumed naturally by the existing momentum subscription
eligibility resolver; strategy management does not change resolver rules.

When a momentum strategy is disabled, enabled linked momentum subscriptions are
blocked from price-confirmation and handoff eligibility with
`STRATEGY_DISABLED`. When it is enabled, evaluation continues through the
subscription, account assignment, account status, allocation, and other existing
conditions. Enabling an unrelated strategy does not make it a momentum strategy.

Handoff eligibility is not order approval. No signal, handoff, or order is
created merely by enabling a momentum strategy.

## Admin UI

The Strategy Library at `/strategies` provides the system-wide summary table and
read-only navigation for users with strategy read access. Owners additionally
receive explicit Enable or Disable actions; there is no unguarded table toggle.

`/strategies/:strategyId` provides usage, eligibility implications, and linked
subscription review. It does not provide subscription mutation controls.

Before mutation, both pages load current backend impact data and require an
explicit confirmation. After success, list, detail, and impact data are
refreshed.

## Controlled momentum pilot

Use this conservative sequence when deliberately enabling a momentum strategy:

1. Keep every momentum subscription disabled except the intended pilot.
2. Confirm the pilot account assignment, allocation, sizing, and exit profile.
3. Review the strategy change-impact summary.
4. Enable the appropriate momentum strategy from the Strategy Library.
5. Confirm the intended subscription becomes momentum eligible and verify that
   unrelated or disabled subscriptions remain ineligible.
6. Run the scanner workflow manually.
7. Inspect price-confirmation and handoff behavior and the strategy audit event.
8. Keep automated momentum entry disabled during the pilot.

Production trading controls, the kill switch, account controls, and the central
risk gate should retain their conservative posture throughout this process.
