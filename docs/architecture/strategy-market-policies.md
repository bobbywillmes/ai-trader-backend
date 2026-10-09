# Strategy Market Policies (Phase 2C)

Phase 2C adds versioned, strategy-owned market eligibility policy configuration. Its only authority is `SHADOW_ONLY`. It does not evaluate policies, create eligibility decisions, affect signal evaluation, or change trading behavior.

## Model

Each `Strategy` may own one `StrategyMarketPolicy`. A policy may have no active revision. Each revision has a backend-assigned integer revision number and is `PREPARED`, `ACTIVE`, or `RETIRED`.

Every revision contains exactly one explicit rule for each authoritative V1 dimension:

- `TREND` / `TREND_V1`: `DOWN`, `NEUTRAL`, `UP`
- `VOLATILITY` / `VOLATILITY_V1`: `LOW`, `NORMAL`, `HIGH`, `EXTREME`
- `BREADTH` / `BREADTH_V1`: `NEGATIVE`, `MIXED`, `POSITIVE`
- `PARTICIPATION` / `PARTICIPATION_V1`: `QUIET`, `NORMAL`, `ACTIVE`, `INTENSE`
- `INTRADAY_STRESS` / `INTRADAY_STRESS_V1`: `NORMAL`, `ELEVATED`, `HIGH`, `SEVERE`

A rule is `REQUIRED` or `IGNORED`. Required rules have at least one allowed effective state. Ignored rules have no allowed states and therefore never grant eligibility. This representation is intentionally per-dimension: a future evaluator must inspect the health of required evidence and must not reject a composition merely because an ignored source made the composition `DEGRADED`.

## Lifecycle and integrity

Policy creation produces PREPARED revision 1 with all five dimensions explicitly ignored. Preparing a later revision clones the latest revision. A policy has at most one PREPARED and one ACTIVE revision.

Only PREPARED rules and allowed states are editable. Activation locks the policy, validates all five rules, retires the previous ACTIVE revision, and activates the selected revision in one serializable transaction. Database partial unique indexes prevent competing ACTIVE or PREPARED revisions. Triggers protect ACTIVE and RETIRED evidence from direct-SQL mutation and validate allowed-state vocabulary as defense in depth.

Every creation, edit, activation, and automatic retirement writes a `SystemEvent` in the same transaction. Historical revisions remain readable.

## HTTP API

Read access uses the existing `STRATEGY_READ` permission. All mutations require `SYSTEM_OWNER`; ACCOUNT_USER access is not broadened.

- `GET /api/strategies/:id/market-policy`
- `POST /api/strategies/:id/market-policy`
- `POST /api/strategies/:id/market-policy/revisions`
- `PATCH /api/strategies/:id/market-policy/revisions/:revisionId/dimensions/:dimension`
- `GET /api/strategies/:id/market-policy/revisions/:revisionId/validation`
- `POST /api/strategies/:id/market-policy/revisions/:revisionId/activate`

The Strategy detail screen is the single management surface. Market Intelligence intentionally has no second policy editor.

## Deployment

Apply `20261009120000_strategy_market_policies` before deploying the backend, then deploy the web UI. No data backfill is required and existing strategies remain without policies until an owner creates one.
