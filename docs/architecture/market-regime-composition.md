# Market Regime composition

## Status and authority

Milestone 2A defines immutable storage and pure source selection for
`MARKET_REGIME_COMPOSITION_V1`. It does not publish compositions automatically and has
no strategy, signal, entry, order, broker, or trading authority.

The composition is an as-of source vector, not a bullish/bearish score. It records
precisely these authoritative identities in this order:

1. `TREND / TREND_V1`
2. `VOLATILITY / VOLATILITY_V1`
3. `BREADTH / BREADTH_V1`
4. `PARTICIPATION / PARTICIPATION_V1`
5. `INTRADAY_STRESS / INTRADAY_STRESS_V1`

Breadth V2 is shadow evidence and is rejected by both source selection and database
identity constraints.

## Identity, observation time, and expiration

A composition's idempotency identity is:

```text
composition version
+ evidence schema version
+ five ordered expected targets
+ selected source assessment identities and attempt metadata
+ five classified source-health outcomes and reason codes
```

The SHA-256 `sourceSetFingerprint` intentionally excludes `observedAt`. Repeating the
same observation while the selected source vector and its health are unchanged produces
the same fingerprint and is deduplicated by `(compositionVersion,
sourceSetFingerprint)`. A new source attempt, a new expected target, or a health
transition such as `AVAILABLE -> EXPIRED` changes the fingerprint.

`observedAt` remains persisted evidence of when selection was evaluated. It is not a
license to reuse the row forever. A complete composition has `validUntil` equal to the
earliest selected source expiration. Every consumer must call the shared runtime
usability check, which requires:

- publication status `SUCCEEDED`;
- evidence health `COMPLETE`;
- non-null `validUntil`;
- request time strictly before `validUntil`.

Therefore a successfully persisted composition becomes unusable at expiration even if
no later composition has been published. A later publisher milestone may persist the
resulting degraded/expired vector; reads must not wait for that row to fail closed.

## Deterministic source selection

Expected targets are resolved by the caller using each publisher's calendar/cadence
contract. Milestone 2A deliberately does not introduce scheduling or independently
reimplement those target calculations.

For each authoritative identity, selection considers only assessments whose:

- `targetAt` is not after the expected target;
- `completedAt` is not after `observedAt`.

Applicable rows are ordered by:

1. `targetAt DESC`
2. `attempt DESC`
3. `completedAt DESC`
4. `id DESC`

Consequences:

- a late retry for the current target supersedes an earlier attempt;
- a late historical backfill cannot displace a newer target;
- an assessment completed after the observation is not retroactively visible;
- the latest failed or unavailable attempt remains visible;
- there is no latest-valid fallback;
- daily and intraday inputs use the same rule while retaining their independent expected
  targets.

If the newest selected valid row targets an older instant than the expected target, its
slot is `STALE`. If the target matches but `observedAt >= validUntil`, it is `EXPIRED`.

## Health layers

`publicationStatus` describes whether the composer executed and persisted its evidence.
It does not describe whether the source vector is usable.

`evidenceHealth` describes the vector:

- `COMPLETE`: all five slots are `AVAILABLE`;
- `DEGRADED`: one or more slots are not available.

Every composition contains all five slots. Slot health is one of:

- `AVAILABLE`
- `MISSING`
- `UNAVAILABLE`
- `FAILED`
- `STALE`
- `EXPIRED`
- `INVALID`

Degraded compositions deliberately have null aggregate `dataThroughAt` and `validUntil`
so they cannot be mistaken for globally usable evidence. Source-level timestamps and
identities remain preserved. Future strategy policy may explicitly ignore a dimension;
the global composition does not decide whether degradation in an ignored dimension is
material to that strategy.

## Database invariants

PostgreSQL enforces:

- immutable parent and source rows;
- version-isolated predecessor lineage and no self-predecessor;
- source identity through a composite foreign key to
  `(assessment id, dimension, algorithm version)`;
- an exact V1 dimension/version/ordinal allowlist;
- one source per dimension and ordinal;
- exactly five source rows at deferred transaction commit;
- exact source snapshot equality with the referenced immutable assessment;
- parent `COMPLETE` only when all five slots are `AVAILABLE`;
- idempotency by composition version and source-set fingerprint;
- coherent terminal timestamps and complete/degraded aggregate fields.

The deferred five-source constraint means a parent and all children must be inserted in
one transaction. This prevents a visible partially constructed composition.

Application code is responsible for resolving expected publisher targets and for
constructing the canonical fingerprint. Those concepts depend on publisher timing and
canonical serialization and are not safely expressible as static row constraints.

## Future milestones

Milestone 2B may add an advisory-locked publisher, triggers, APIs, and operational
monitoring. Strategy policy and eligibility remain separate later milestones. No future
consumer may infer trading authority from these rows.
