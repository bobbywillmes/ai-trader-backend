# Entry exposure claim rollout

Phase 3C.0 is an intentional safety behavior change: after activation, a trading
account cannot admit a second entry lifecycle for the same canonical Security.
It grants no new LIVE authority.

## Deploy

1. Keep new entry production disabled for every PAPER and LIVE account.
2. Deploy all Phase 3C.0 additive migrations. Do not backfill or clear claims.
3. Start the corrected runtime while entries remain disabled. Allow submitted-order
   synchronization, broker-activity ingestion, tracked-position synchronization,
   and reconciliation to refresh stale local `new`, `accepted`, and
   `partially_filled` records. This recovery stage is required before readiness;
   absence from one open-order response is not terminal proof.
4. Run `npm run entry-exposure:readiness` and retain its JSON report. This is a
   provider-read operation: it enumerates every local trading account and requires
   a fresh Alpaca position snapshot plus a complete, bounded executable BUY-order
   snapshot for each account. PAPER and LIVE credentials are never mixed.
5. Treat `missingSecurity`,
   `unclaimedUnresolvedBuyIntents`, `unclaimedActiveBrokerBuys`,
   `brokerOpenBuysWithoutActiveClaim`, `staleLocalActiveBrokerBuys`,
   `unresolvedClaims`, and `strandedClaims` as unsafe rollout blockers. Review
   `historicalTerminalEvidence` separately; terminal history is not proof of
   present exposure and is never made executable by adoption.
6. Run `npm run entry-exposure:readiness -- --apply`. This adopts a verified open
   position or disposes a separately verified never-submitted intent; it does not
   adopt a pending intent as executable ownership.
   Adoption records blocking ownership; it does not establish execution authority.
   A verified open position is protected by a durable account/Security claim so
   ordinary position management can continue without forced liquidation. Unknown
   historical attribution remains visible for investigation, but protection of
   that symbol is the rollout safety boundary. A legacy BUY is never
   requeued merely because a stable-client-ID lookup returns no order.
7. Run account reconciliation, then run the dry-run again. `ready` may become true only when both
   `databaseReady` and `brokerVerifiedReady` are true. `assessment` distinguishes
   `BROKER_EVIDENCE_UNAVAILABLE`, `BLOCKED`, and `BROKER_VERIFIED_READY`; a local
   adoption pass is never represented as final broker readiness. Every active exposure
   is durably protected and no claimless executable BUY, ambiguous account/Security
   group, missing Security, or stranded lifecycle remains. A protected legacy open
   position may retain unresolved historical attribution without permitting a new
   entry for its symbol. Do not clear claims directly in SQL.
8. Review the retained reports, claim events, and Operational Attention. Verify no
   `entry_exposure_claim_missing` or `entry_exposure_claim_unresolved` finding remains.
9. Only after `BROKER_VERIFIED_READY` and explicit operator review, restore entry
   eligibility through the existing controls. Preserve the existing LIVE arming, write approval, deployment-role, kill
   switch, and trading-enabled controls. This rollout does not satisfy or bypass
   any of them.

## Verification

Readiness enumerates every local TradingAccount, not only enabled accounts. Archived,
disabled, and credential-less accounts remain mandatory when any local position,
BUY order, unresolved intent, activity, or unreleased claim indicates possible
exposure. A missing or unusable credential yields `BROKER_EVIDENCE_UNAVAILABLE`; it
is not silently treated as no exposure. An account may be retired from mandatory
provider verification only after retained authoritative closure or transfer evidence
and local lifecycle repair establish that it has no relevant exposure.

For each account, verify that active broker positions and local open or
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
when exact identity remains unknown, an order remains executable, broker cumulative fills
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
An old `DELIVERY_UNCERTAIN` marker is retained as history but is not itself a
permanent blocker after the exact order is subsequently found and fresh evidence
proves terminal status, complete attributed fills, no broker position, and no
executable BUY. A filled claim without a position uses the same bounded proof;
contradictory identity or incomplete fills preserve the claim.
`--actor-user-id` is audit attribution only, not authentication. Run this command
only from an access-controlled operational host/session after independently
authenticating the SYSTEM_OWNER and retaining the preview/fingerprint record.
For a rollout-adopted position with no attributable entry order, remediation is
eligible only after that exact tracked position is closed, the broker reports no
position for the canonical symbol, and the complete broker open-order observation
contains no executable BUY for the symbol. Final locked revalidation repeats the
local position/order checks. This position-only exception is not available to a
claim that has an originating OrderIntent.

The preview reports a `disposition`: `TERMINAL_BROKER_ORDER_NO_EXPOSURE` (an exact broker
order was found), `CLOSED_ADOPTED_POSITION`, `DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE`, or
`UNSUPPORTED`. A terminal broker order whose client order ID, symbol or side contradicts
the claim is refused with `BROKER_ORDER_IDENTITY_CONFLICT`.

### Consumed or recorded dispatch with no broker order

A failed or blocked entry whose dispatch already started (a broker-time consumption, a
final un-enforced dispatch authorization, or dispatch telemetry) is never released as
never-submitted. The order worker records the delivery outcome on the claim and holds it
as `UNRESOLVED`. The terminal-claim sweep releases it automatically only under the
evidence standard in `docs/architecture/market-policy-broker-time-enforcement.md`
(section 5b). Otherwise it appears in readiness as `terminalIntentsWithUnreleasedClaims`
with its remediation eligibility.

For such a claim the preview uses the `DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE` disposition
instead of the old `BROKER_ORDER_NOT_ESTABLISHED` blocker. It shows the intent, claim,
consumption, dispatch decision and un-enforced record identities; the recorded
classification; fresh broker and local evidence; and a conclusiveness value:

- `CONCLUSIVE`: a definite local non-send (adapter guard before the network request, or
  a dispatch record whose acknowledgement was lost) or a definitive, settled HTTP
  rejection, with no exposure anywhere. `--apply --confirm <fingerprint>` releases it
  as `VERIFIED_DISPATCH_NO_EXPOSURE:<basis>`.
- `PENDING`: the rejection settle window has not passed, or a broker read failed
  (including incomplete open-order pagination). Preview again later.
- `CONTRADICTED`: a broker order, position, executable BUY, local fill, unattributed
  BUY fill, or identity mismatch exists. Resolve that exposure first.
- `AMBIGUOUS_ABSENCE`: delivery may have reached Alpaca (5xx, network, crash between
  the record and the adapter, or a non-definitive 4xx). The claim stays held. Follow
  the printed investigation guidance: review the Alpaca order history and account
  activities for the client order ID. If an order appears, the
  `TERMINAL_BROKER_ORDER_NO_EXPOSURE` disposition recovers it once terminal. A lookup
  miss never releases this claim, and there is no forced or time-based release.

Apply always repeats fresh broker verification, requires the exact fingerprint, and
revalidates under the account/Security lock. It appends immutable operator-authorization
and release events, keeps the consumption and dispatch records unchanged, and never
resends, requeues or cancels anything. A later entry for the Security needs a new
admission with a new client order ID.

## Legacy disposition matrix

| Condition | Detection and required evidence | Safe disposition | Entry effect and approval | Acceptance proof |
| --- | --- | --- | --- | --- |
| Verified existing open position | Local open/closing `TrackedPosition` matches a fresh broker position for the same account and canonical Security; the complete broker BUY snapshot is available. | `--apply` may create one `POSITION_OPEN` claim with `OPERATOR_ROLLOUT_ADOPTION`. The event states unknown provenance and `executionAuthority=NONE`. Position and protective exits remain usable. | Blocks another entry for the symbol. No liquidation or exit-authority invention. Operator retains the apply report. | `entry-exposure-lifecycle.prisma.integration.test.ts`, case 11. |
| Never-submitted `received`/`pending` intent | No delivery-uncertain marker, local `BrokerOrder`, `BrokerActivity`, broker position, or executable broker BUY for that account/symbol, using complete fresh snapshots. | Atomically block only an intent still in the expected state, create immutable evidence, then release as `ROLLOUT_VERIFIED_NEVER_SUBMITTED`. | Never requeues and does not block after verified release. Operator apply required. One 404 never qualifies uncertain delivery. | Case 12. |
| `submitting` or delivery-uncertain intent | Local active/uncertain status plus exact client/broker identity and subsequent broker order/fill evidence. | Preserve the claim until authoritative reconciliation. If later exact terminal order, complete fills, and absence of exposure are proven, fingerprinted owner remediation may release it. | Hard blocker until verified. It is never treated as never-submitted from a failed lookup. | Cases 6, 9, and 17 plus remediation tests. |
| Terminal claim without a durable dispatch row | Inspect the explicit intent delivery classification and immutable claim outcomes. Missing rows, terminal status, repeated 404s, elapsed time, and HTTP 408/409 do not prove non-delivery. | Release automatically only for explicit local pre-dispatch non-send evidence. Preserve uncertain/unknown evidence with Operational Attention; a transient database failure retains the prior recoverable state for the bounded scheduler retry. | Blocks duplicate account/Security entry until conclusive evidence permits the standard release. | Phase 3C.3 recovery scheduling and shared-boundary regressions. |
| Claimless broker-active BUY | Complete account order snapshot contains an executable BUY with no matching local broker identity/claim. | Readiness reports `brokerOnlyOpenBuys`. Resolve it through authorized broker operations or exact lifecycle repair, then rerun readiness. Readiness never creates or cancels an order. | Hard blocker; operator action required. No force release. | Cases 5 and 13. |
| Historical filled-but-unlinked order | Terminal history lacks position attribution; compare exact order and cumulative fills with immutable local fills and current position/order snapshots. | Closed-position history and a filled intent with verified no current exposure remain investigation evidence, not an executable blocker. Current position/order evidence remains blocked. | History alone grants no execution authority. Owner remediation is available only with the bounded proof above. | Cases 3, 15, 17, and remediation tests. |
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

## Remaining external-order race and provider verification

Readiness is a point-in-time proof. An external or manual BUY placed after the
complete order snapshot can race the report. During rollout, operators must
coordinate a broker-side change freeze (or independently recheck the broker
immediately before reactivation) and confirm no manual automation can create BUYs
in the interval.

Before production rollout, perform one narrowly scoped read-only verification for
each relevant PAPER and LIVE credential: account-scoped positions, complete open
BUY pagination, and exact client/broker-order lookup used by reconciliation. Do not
submit, replace, or cancel an order for this check. This repository task
intentionally does not perform live Alpaca credential checks.
