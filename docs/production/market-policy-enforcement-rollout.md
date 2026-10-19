# PAPER Market-Policy Enforcement Rollout (Phases 3C.2–3C.3)

This runbook covers deploying authoritative PAPER market-policy enforcement: pre-intent
admission (3C.2) and broker-time revalidation (3C.3). Both stay inert until a
SYSTEM_OWNER activates the PAPER runtime rollout. A frozen obligation, however, is
revalidated at broker time whether or not the rollout is active. LIVE has no Market
Intelligence authority.

Architecture: `docs/architecture/market-policy-pre-intent-enforcement.md` and
`docs/architecture/market-policy-broker-time-enforcement.md`.

## What deployment changes

- Migration `20261018170000_market_policy_broker_time_enforcement` is additive. It
  adds broker-time decisions, gates and consumptions, plus the corrected 3C.2
  functions (L1–L3). It creates no decisions and no grants.
- With the rollout **inactive** (default), no intent has an obligation unless one was
  admitted during an earlier active period. Un-obligated entries keep existing broker
  behavior.
- Every new entry BUY POST now passes the broker-time guard. A guard failure fails
  closed with a definite non-send (`MARKET_POLICY_BROKER_TIME:...`) and never claims
  broker delivery.

## Ordering

1. **Keep new entry submission disabled during deployment.** Use the existing
   controls: `tradingEnabled=false`, the kill switch where appropriate, and
   `ALLOW_TRADING_ENABLED_ON_START=false`. Leave position management and protective
   workers running.
2. **Apply all outstanding migrations** (`docs/production/database-migrations.md`).
3. **Start the corrected runtime without enabling enforcement.** Confirm
   `GET /api/system-status` → `trading.marketPolicyEnforcement` shows the rollout
   `NOT_ACTIVATED` or `DEACTIVATED` and `brokerTimeEnforcement:
   FROZEN_OBLIGATIONS_ALWAYS_REVALIDATED`.
4. **Complete Phase 3C.0 broker-verified exposure readiness**
   (`npm run entry-exposure:readiness`, `docs/production/entry-exposure-rollout.md`).
5. **Verify queued BUYs and delivery uncertainty:** run
   `npm run market-policy:broker-readiness` (or
   `GET /api/market-policy-enforcement/broker-time-readiness` as SYSTEM_OWNER). Review:
   - `QUARANTINED_AT_BROKER_TIME_WHILE_ROLLOUT_ACTIVE`: queued entries without an
     obligation whose assignment now requires enforcement. Activation quarantines
     them. Decide whether to let that happen or to resolve them first.
   - `DELIVERY_UNCERTAIN` / `DISPATCH_IN_PROGRESS_OR_UNCERTAIN`: these stay in the
     existing recovery pathway. Resolve them through stable-ID recovery or the claim
     remediation workflow, never by deleting intents or claims.
   - `BROKER_ORDER_DELIVERED`: managed normally. No action is needed, and positions
     never need to be liquidated to activate enforcement.
6. **Complete authorization and lapse review:** for every `unresolvedLapses` entry
   (including V1 grants marked `securityBindingReapprovalRequired`), either
   reauthorize the current enrollment generation or record an explicit owner
   `resolve-lapse`. Unresolved lapses fail closed while the rollout is active.
7. **Confirm the broker-time guard and monitoring are operational.** Watch
   `SystemEvent` types `MARKET_POLICY_BROKER_DISPATCH_REFUSED` (WARNING),
   `MARKET_POLICY_LEGACY_ENTRY_QUARANTINED` (WARNING) and
   `MARKET_POLICY_BROKER_DISPATCH_TECHNICAL_FAILURE` (ERROR), plus account health for
   `PENDING_ORDER_ITEM_FAILURE`.
8. **Perform an isolated PAPER enforcement rehearsal** on a dedicated PAPER account and
   assignment:
   - grant, activate, then admit under an ALLOWED composition and confirm a single
     ALLOWED decision with one consumption and one POST;
   - with a BLOCKED composition, confirm a refusal with no POST and a released claim;
   - revoke after admission and confirm `AUTHORIZATION_REVOKED` and no POST.
9. **Activate enforcement only after owner approval and successful readiness**, via
   `POST /api/market-policy-enforcement/runtime-rollout/activate`.

## Deactivation and rollback

- Deactivation returns **new** admissions to existing behavior. It never erases or
  bypasses frozen obligations: pending obligated intents are still revalidated before
  any new POST.
- Code rollback to a pre-3C.3 build would dispatch obligated intents without broker-time
  revalidation. Before rolling back, ensure no obligated intent is `pending`: run the
  readiness report and let pending obligated intents dispatch or be refused first.
  Never drop the decision tables.
- The kill switch, LIVE write approvals, protective management and broker recovery
  are unchanged.

## Residual risk

The consumption commit is the linearization point. A revocation committed after it
cannot recall an in-flight Alpaca request. The resulting order is recovered and
managed normally, including fills, positions and protective exits.
