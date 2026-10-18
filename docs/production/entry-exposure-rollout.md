# Entry exposure claim rollout

Phase 3C.0 is an intentional safety behavior change: after activation, a trading
account cannot admit a second entry lifecycle for the same canonical Security.
It grants no new LIVE authority.

## Deploy

1. Keep new entry production disabled. Position, exit, broker-activity, and
   reconciliation workers may continue.
2. Deploy the additive migration. It creates claim and event tables and does not
   backfill historical rows.
3. Run `npm run entry-exposure:readiness` and retain its JSON report.
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
6. Run the dry-run again. `ready` may become true only when every active exposure
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
