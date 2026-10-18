# Entry exposure claim rollout

Phase 3C.0 is an intentional safety behavior change: after activation, a trading
account cannot admit a second entry lifecycle for the same canonical Security.
It grants no new LIVE authority.

## Deploy

1. Keep new entry production disabled. Position, exit, broker-activity, and
   reconciliation workers may continue.
2. Deploy the additive migration. It creates claim and event tables and does not
   backfill historical rows.
3. Run `npm run entry-exposure:readiness` and retain its JSON report. This is a
   provider-read operation: it enumerates every local trading account and requires
   a fresh Alpaca position snapshot plus a complete, bounded executable BUY-order
   snapshot for each account. PAPER and LIVE credentials are never mixed.
4. Treat `ambiguous`, `missingSecurity`,
   `unclaimedUnresolvedBuyIntents`, `unclaimedActiveBrokerBuys`,
   and `strandedClaims` as unsafe rollout blockers. Review
   `historicalTerminalEvidence` separately; terminal history is not proof of
   present exposure and is never made executable by adoption.
5. Run `npm run entry-exposure:readiness -- --apply`. This adopts only a single
   active position or a single entry lifecycle for an account/security pair.
   Adoption records blocking ownership; it does not establish execution authority.
   A verified open position is protected by a durable account/Security claim so
   ordinary position management can continue without forced liquidation. Unknown
   historical attribution remains visible for investigation, but protection of
   that symbol is the rollout safety boundary. A legacy BUY is never
   requeued merely because a stable-client-ID lookup returns no order.
6. Run the dry-run again. `ready` may become true only when both
   `databaseReady` and `brokerVerifiedReady` are true. `assessment` distinguishes
   `BROKER_EVIDENCE_UNAVAILABLE`, `BLOCKED`, and `BROKER_VERIFIED_READY`; a local
   adoption pass is never represented as final broker readiness. Every active exposure
   is durably protected and no claimless executable BUY, ambiguous account/Security
   group, missing Security, or stranded lifecycle remains. A protected legacy open
   position may retain unresolved historical attribution without permitting a new
   entry for its symbol. Do not clear claims directly in SQL.
7. Restart the application on the new version, run account reconciliation, and
   verify no `entry_exposure_claim_missing` or
   `entry_exposure_claim_unresolved` findings/attention remain.
8. Preserve the existing LIVE arming, write approval, deployment-role, kill
   switch, and trading-enabled controls. This rollout does not satisfy or bypass
   any of them.

## Verification

For each enabled account, verify that active broker positions and local open or
closing tracked positions have exactly one unreleased claim. Confirm pending,
submitting, submitted, partially filled, and filled-without-position BUY entries
also have one claim. A claim in `UNRESOLVED` is a blocker, not permission to
submit.

## Rollback

Disable new entries before rolling application code back. Leave position, exit,
broker activity, and reconciliation processing available. The migration is
additive; retain `EntryExposureClaim` and `EntryExposureClaimEvent` tables and all
rows. Do not reverse the migration or clear claims during an incident. Old code
does not enforce the new admission boundary, so it must not be used to re-enable
entries. Roll forward to corrected Phase 3C.0 code, reconcile, and only then
restore entry eligibility through existing controls.

## Claim remediation

There is no force-release endpoint. Reconciliation must first obtain fresh exact
Alpaca order identity/status and position-by-symbol evidence. Release is refused
when delivery is uncertain, an order remains executable, broker cumulative fills
are not represented by attributed local fill evidence, a broker position remains,
or database state changes during final lock/revalidation. The claim event history
and Operational Attention episode provide the exact account, Security, intent,
broker-order, old-position, and newly observed-position identities for review.

Resolve the underlying attribution or ingestion gap, rerun reconciliation, and
retain the report and claim events as the operator record. Never update
`releasedAt`, `releaseReason`, or `status` manually. Resolving historical ownership
does not create or requeue an entry; a later entry must pass a fresh normal
admission and all existing PAPER/LIVE controls.

An authorized owner may preview the bounded remediation check:

```bash
npm run entry-exposure:remediate -- --claim <claim-id> --actor-user-id <system-owner-id>
```

The preview prints every account, Security, intent, broker-order, position, fill,
and claim identity plus blockers and an exact evidence fingerprint. Only
after reviewing that exact output, repeat with `--apply --confirm <fingerprint>`.
Apply performs fresh broker lookups again and locked database revalidation; any
change or uncertainty refuses release. The command appends operator authorization
and release events. It cannot submit or requeue an order and grants no LIVE authority.
`--actor-user-id` is audit attribution only, not authentication. Run this command
only from an access-controlled operational host/session after independently
authenticating the SYSTEM_OWNER and retaining the preview/fingerprint record.
For a rollout-adopted position with no attributable entry order, remediation is
eligible only after that exact tracked position is closed, the broker reports no
position for the canonical symbol, and the complete broker open-order observation
contains no executable BUY for the symbol. Final locked revalidation repeats the
local position/order checks. This position-only exception is not available to a
claim that has an originating OrderIntent.

## Legacy disposition matrix

| Condition | Detection and required evidence | Safe disposition | Entry effect and approval | Acceptance proof |
| --- | --- | --- | --- | --- |
| Verified existing open position | Local open/closing `TrackedPosition` matches a fresh broker position for the same account and canonical Security; the complete broker BUY snapshot is available. | `--apply` may create one `POSITION_OPEN` claim with `OPERATOR_ROLLOUT_ADOPTION`. The event states unknown provenance and `executionAuthority=NONE`. Position and protective exits remain usable. | Blocks another entry for the symbol. No liquidation or exit-authority invention. Operator retains the apply report. | `entry-exposure-lifecycle.prisma.integration.test.ts`, case 11. |
| Never-submitted `received`/`pending` intent | No delivery-uncertain marker, local `BrokerOrder`, `BrokerActivity`, broker position, or executable broker BUY for that account/symbol, using complete fresh snapshots. | Atomically block only an intent still in the expected state, create immutable evidence, then release as `ROLLOUT_VERIFIED_NEVER_SUBMITTED`. | Never requeues and does not block after verified release. Operator apply required. One 404 never qualifies uncertain delivery. | Case 12. |
| Adopted `submitting` or delivery-uncertain intent | Local active/uncertain status plus exact client/broker identity and subsequent broker order/fill evidence. | Preserve the claim. Reconciliation may advance it only from authoritative identity evidence; release uses the full normal protocol. | Hard blocker. Automatic retry is safe; operator investigates identity gaps. | Cases 6 and 9. |
| Claimless broker-active BUY | Complete account order snapshot contains an executable BUY with no matching local broker identity/claim. | Readiness reports `brokerOnlyOpenBuys`. Resolve it through authorized broker operations or exact lifecycle repair, then rerun readiness. Readiness never creates or cancels an order. | Hard blocker; operator action required. No force release. | Cases 5 and 13. |
| Historical filled-but-unlinked order | Terminal history lacks claim/position attribution; compare cumulative broker fills with immutable local fills and current position/order snapshots. | Report as `historicalTerminalEvidence`. Repair only from exact evidence through existing lifecycle and Operational Attention patterns; never invent ownership. | History alone grants no execution authority; current ambiguity remains blocked. Operator review required. | Cases 3 and 8 plus remediation tests. |
| Existing open position with unknown entry provenance | Verified broker/local position match without a trustworthy historical strategy link. | Protect with a position-only claim. Keep existing/default exit ownership; never infer external exit authority. | Symbol remains blocked while open. Deployment-compatible without forced sale. | Case 11. |
| Claimed position already closed | Closed local position, absent broker position, complete open BUY snapshot, exact origin/replacement evidence when present, and fill reconciliation. | Existing reconciliation retries the release protocol. Transient errors append retry diagnostics and preserve status. | Blocks until verified release. No second lifecycle controller. | Cases 3 and 6. |
| Ambiguous/conflicting identity, unknown status, incomplete pagination, or broker-only position | Any identity mismatch, malformed/partial response, unknown state, conflicting fill/position evidence, or broker position without a local tracked position. | Report a precise blocker and use lifecycle repair/Operational Attention. Genuine contradiction may become `UNRESOLVED`; there is no force-release escape hatch. | Hard blocker; operator review required. | Cases 7, 8, and 13 plus adapter pagination tests. |
| Stale/terminal local lifecycle record | Compare local terminal state with exact order identity, replacement chain, fills, current position, and complete open BUY snapshot. | Reconciliation/remediation releases only through the standard evidence protocol; otherwise retain ownership or historical diagnostics. | Never becomes executable from terminal history. Operator approval is required for manual remediation. | Cases 6 and 9. |

## Broker-verified rehearsal

The disposable PostgreSQL acceptance suite is the rollout rehearsal. It seeds an
open legacy position and a separate never-submitted intent, obtains stubbed fresh
account broker snapshots, proves dry-run is blocked, applies only the supported
dispositions, and proves the next assessment is `BROKER_VERIFIED_READY` while the
position remains open. Separate cases prove executable BUY evidence and incomplete
pagination keep readiness false. The stub prohibits broker POSTs.

In production, retain both JSON reports and compare their account lists. A
legitimate open position is compatible with readiness only when present in both
broker and local snapshots and protected by exactly one unreleased position claim.
A timeout, rate limit, credential failure, malformed response, or possible
pagination truncation yields `BROKER_EVIDENCE_UNAVAILABLE`, never readiness.
