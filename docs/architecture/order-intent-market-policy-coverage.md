# OrderIntent Market-Policy Coverage (Phase 3B.1)

Phase 3B.1 records exact, compare-only market-policy coverage identity alongside
applicable BUY entry `OrderIntent` rows. It does not evaluate market eligibility,
authorize an order, block an order, or change broker behavior.

## Authority boundary

Every `OrderIntentMarketPolicyCoverage` row is immutable. PostgreSQL requires
`comparisonMode=COMPARE_ONLY` and `tradingEffect=NONE`; application code cannot
promote this evidence into trading authority. Phase 3C requires a separate owner
authorization and a separately persisted per-intent enforcement obligation. An
ACTIVE Phase 3A enrollment or a Phase 3B.1 coverage row is never sufficient.

The AFTER INSERT trigger only applies to BUY intents having both an exact account
and assignment identity. It reads committed enrollment and policy identities from
one PostgreSQL statement snapshot. It does not lock configuration rows. Its entire
comparison/capture block is exception-contained, so comparison-specific failures
cannot roll back or alter the `OrderIntent`, risk decision, status, or stable client
order ID.

Captured provenance is:

- `ACTIVE_EXACT`: the retained ACTIVE enrollment generation is bound to the
  Strategy's currently ACTIVE policy revision.
- `SUPERSEDED_COMPARE_ONLY`: the exact retained ACTIVE enrollment generation and
  its original bound revision are preserved, while the separately captured active
  revision is different or absent.
- `UNENROLLED`: no ACTIVE enrollment generation existed in the insert snapshot.
- `CAPTURE_UNKNOWN`: the bounded scanner found expected post-epoch capture missing.
  Enrollment and policy fields remain null and are never reconstructed from current
  configuration.

No synchronous eligibility evaluation, broker-time hook, order authorization
change, or POST_COMMIT_OBSERVED fallback exists in this phase. A later genuinely
new POST opportunity must create fresh evidence and must not reuse this comparison.

## Rollout and epoch

Migration `20261010230000_order_intent_market_policy_coverage` installs the trigger
but inserts rollout state with `enabled=false`. Migration application therefore has
no capture effect on trading.

After migration and verification, an owner-approved operator may start the one-shot
rollout with:

```sql
UPDATE "OrderIntentMarketPolicyCaptureRollout" SET enabled = true WHERE id = 1;
```

PostgreSQL stamps `effectiveEpoch` with `clock_timestamp()` inside that update.
Callers cannot supply or rewrite the epoch. Intents before it are historical and are
not expected to have coverage. Disabling similarly stamps `disabledAt`; the closed
interval remains scannable. Re-enabling is deliberately refused in Phase 3B.1
because multiple rollout intervals require an explicit future epoch model.

`detectOrderIntentMarketPolicyCoverageGaps(limit)` scans at most 500 applicable
intents per transaction and serializes only its singleton cursor. It inserts
idempotent `CAPTURE_UNKNOWN` evidence under the unique OrderIntent key. The mutable
cursor lives in `OrderIntentMarketPolicyCoverageScannerState`, separate from the
immutable historical rows. Phase 3B.1 does not schedule this scanner; invocation is
an explicit operational action until a monitored worker is separately approved.

## PostgreSQL feasibility result

The isolated feasibility harness uses shadow tables before the application trigger
is exercised. It proves exception containment, standalone and interactive
transaction behavior, committed-snapshot coherence under `READ COMMITTED` and
`REPEATABLE READ`, rollback invisibility, and nonblocking behavior during uncommitted
prepare/disable/revision changes. A 500-row probe must complete within two seconds.
The application integrity suite repeats the safety properties against replayed real
migrations and verifies schema drift.

Plain MVCC reads may capture the immediately preceding committed configuration when
a concurrent configuration transaction has not committed yet. That is coherent and
intent-time accurate; the trigger never waits for or observes the future transaction.
After commit, subsequent intents observe the new identity. Serializable callers may
still receive PostgreSQL serialization failures for their own transaction conflicts;
the trigger adds no configuration lock or retry behavior.

## Future Operational Attention producer (document only)

A future producer should identify a superseded ACTIVE enrollment with a stable
incident key scoped to the exact `TradingAccountSubscription` (and therefore its
exact trading account). It should emit WARNING while the enrollment remains
configuration-only and may emit ERROR only when a separately authorized enforcement
obligation is affected.

Detection should run after policy revision changes and through periodic
reconciliation. The incident must retain the original generation, bound revision,
replacement revision, assignment, account, and observation evidence. It must never
automatically rebind policy. Resolution is allowed only after verified replacement
or disablement. Policy activation and order execution must never depend on OA
availability or successful OA writes. No OA behavior is implemented in Phase 3B.1.
