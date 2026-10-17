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
4. Resolve every `ambiguous` or `missingSecurity` item using broker, order,
   activity, and tracked-position evidence. Do not infer ownership from a symbol.
5. Run `npm run entry-exposure:readiness -- --apply`. This adopts only a single
   active position or a single entry lifecycle for an account/security pair.
   Entry-only adoption remains `UNRESOLVED` and therefore non-executable until
   normal stable-client-ID recovery establishes broker state.
6. Run the dry-run again. It must report no unresolved legacy candidates before
   enabling new entries.
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
