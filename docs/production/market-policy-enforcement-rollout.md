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
- Migration `20261019120000_market_policy_dispatch_recovery` (Hermes HIGH-1 and
  MEDIUM-1) is additive. It adds the immutable `MarketPolicyBrokerUnenforcedDispatch`
  final authorization for un-obligated PAPER entries and makes
  `EntryExposureClaimEvent` append-only. It creates no authorizations, releases no
  claims, and changes no consumption. Apply it together with the corrected runtime:
  the runtime requires the new table.
- With the rollout **inactive** (default), no intent has an obligation unless one was
  admitted during an earlier active period. Un-obligated entries keep existing broker
  behavior.
- Every new entry BUY POST now passes the broker-time guard. A guard failure fails
  closed with a definite non-send (`MARKET_POLICY_BROKER_TIME:...`) and never claims
  broker delivery.
- Every un-obligated PAPER entry, with the rollout active or inactive, gets a final
  serialized authorization immediately before the POST. While the rollout is inactive
  it records `RUNTIME_INACTIVE` and behaves as before. While active, it quarantines an
  entry whose assignment requires enforcement by then.
- A failure after a consumption or un-enforced dispatch record never releases the claim
  as unsubmitted. The outcome is recorded and the claim becomes `UNRESOLVED`. A definite
  local non-send, or a definitive and settled HTTP rejection, is released automatically
  after fresh broker verification. Delivery uncertainty stays held for operator
  investigation.

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
     This includes LIVE and legacy intents with no durable dispatch row: missing rows,
     repeated lookup absence, HTTP 408/409 and elapsed time never authorize release.
   - `BROKER_ORDER_DELIVERED`: managed normally. No action is needed, and positions
     never need to be liquidated to activate enforcement.
6. **Complete authorization and lapse review:** for every `unresolvedLapses` entry
   (including V1 grants marked `securityBindingReapprovalRequired`), either
   reauthorize the current enrollment generation or record an explicit owner
   `resolve-lapse`. Unresolved lapses fail closed while the rollout is active.
   - `terminalWithUnreleasedClaim` (activation reason
     `TERMINAL_ENTRIES_WITH_UNRELEASED_CLAIMS`): failed or blocked entries whose claims
     are still held, including consumed dispatches. Review them with
     `npm run entry-exposure:readiness` (`terminalIntentsWithUnreleasedClaims`) and the
     remediation preview.
     Read each item's `recoveryState` and `systemRecovery`:
     `AWAITING_FIRST_ATTEMPT` and `RETRY_SCHEDULED` (with `nextAttemptDueAt`) are
     automatic recovery that has not yet completed. `TECHNICAL_FAILURE_RETRY_SCHEDULED`
     means the last attempt hit an infrastructure failure and the claim stays held.
     `OPERATOR_INVESTIGATION_REQUIRED` means delivery is uncertain or unknown: no
     automatic or absence-based release exists, and only positive broker order evidence
     (the exact client order ID terminal at Alpaca) releases it.
     `PROTECTED_BY_EXPOSURE_WORKFLOW` is owned by order sync. No state means "processed";
     `recoveryAttempted` and `lastRecoveryResult.result` report what actually happened.
     `lastRecoveryResult` describes the newest attempt (a repeated result separated by a
     different one is recorded again); `lastRecoveryResult.at` is when that result was
     first observed and `lastAttemptAt` is the newest attempt.
     Watch the CRITICAL system event `entry_exposure.delivery_evidence_unpersisted`: an
     entry failure whose classification could not be stored keeps its claim held until
     stale recovery reviews it. `preDispatchProofCandidate: true` means the failure came
     before the stable-ID lookup completed (for example an idempotency GET 429/5xx or
     network failure) and stale recovery will prove it from the claim's adapter-marker
     evidence; no action is needed unless it persists past the 5-minute stale threshold.
     A pre-dispatch lookup or database failure that the worker proved never sent is
     released automatically (`WORKER_PROVEN_PRE_DISPATCH_BOUNDARY_FAILURE`); it is not an
     operator item.
   - `staleAdmissionClaims`: abandoned admissions (`received` for more than 15 minutes
     with an `ENTRY_PENDING` claim). `AUTOMATIC_STALE_ADMISSION_RECOVERY` is released by
     the next stale-recovery tick. `OPERATOR_INVESTIGATION` lists the `blockers` that kept
     the claim (for example a LIVE acceptance execution or an adapter marker); investigate
     those exactly as for a terminal claim. Never delete the intent or the claim.
7. **Confirm the broker-time guard and monitoring are operational.** Watch
   `SystemEvent` types `MARKET_POLICY_BROKER_DISPATCH_REFUSED` (WARNING),
   `MARKET_POLICY_LEGACY_ENTRY_QUARANTINED` (WARNING),
   `MARKET_POLICY_BROKER_DISPATCH_TECHNICAL_FAILURE` (ERROR),
   `entry_exposure.dispatch_outcome_recorded` (WARNING for a definite local non-send,
   ERROR otherwise), `entry_exposure.unsubmitted_release_refused` (ERROR) and
   `entry_exposure.dispatch_claim_released` (INFO), plus account health for
   `PENDING_ORDER_ITEM_FAILURE` and the `entry_exposure_claim_unresolved`
   reconciliation finding.
8. **Perform an isolated PAPER enforcement rehearsal** on a dedicated PAPER account and
   assignment:
   - grant, activate, then admit under an ALLOWED composition and confirm a single
     ALLOWED decision with one consumption and one POST;
   - with a BLOCKED composition, confirm a refusal with no POST and a released claim;
   - revoke after admission and confirm `AUTHORIZATION_REVOKED` and no POST;
   - queue an un-obligated entry on a never-authorized assignment, grant before it
     dispatches, and confirm a `LEGACY_UNOBLIGATED_QUARANTINED` decision with reason
     `..._AT_FINAL_AUTHORIZATION` and no POST;
   - dispatch an un-obligated entry and confirm one `MarketPolicyBrokerUnenforcedDispatch`
     record with the expected `basis`.
9. **Activate enforcement only after owner approval and successful readiness**, via
   `POST /api/market-policy-enforcement/runtime-rollout/activate`.

## Deactivation and rollback

- Deactivation returns **new** admissions to existing behavior. It never erases or
  bypasses frozen obligations: pending obligated intents are still revalidated before
  any new POST.
- Code rollback to a pre-3C.3 build would dispatch obligated intents without broker-time
  revalidation. That rollback remains prohibited while any obligated intent is
  `pending`. Before any rollback, run the readiness report and let pending obligated
  intents dispatch or be refused first. Never drop the decision tables.
- Rolling back from this correction to the earlier 3C.3 build is also unsafe in
  practice. The earlier build performs no final authorization for un-obligated entries
  (the MEDIUM-1 race returns). Its worker also strands claims after a post-consumption
  failure (HIGH-1) and does not read `MarketPolicyBrokerUnenforcedDispatch` as prior
  dispatch evidence. Prefer a forward fix. If a rollback is unavoidable, disable new
  entry submission first, let no un-obligated PAPER entry dispatch under the older
  build, and keep the new table and its records. Never drop
  `MarketPolicyBrokerUnenforcedDispatch`, the consumptions, or claim events, and never
  remove the append-only trigger on claim events.
- The kill switch, LIVE write approvals, protective management and broker recovery
  are unchanged.

## Residual risk

The consumption commit is the linearization point for obligated entries. A revocation
committed after it cannot recall an in-flight Alpaca request. The final un-enforced
authorization commit is the linearization point for un-obligated entries. A grant or
activation committed after it cannot recall the subsequent POST. In both cases the
resulting order is recovered and managed normally, including fills, positions and
protective exits.

Neither record is proof of broker receipt. After uncertain delivery (5xx, network, a
crash between the record and the adapter, or a non-definitive 4xx), the claim stays
`UNRESOLVED` until a broker order is discovered or the evidence becomes conclusive. The
Security is blocked for new entries on that account until then. That is the intended
fail-closed trade-off; there is no time-based release.
