# Tiingo market data migration

## Authority and branch boundary

Tiingo is the intended market observation provider. Alpaca remains broker and execution truth. There is no runtime market data provider fallback. This branch's Phase 0/1 adds only schema and a disconnected REST foundation. Massive retains all current production workers, assessments, dashboard, Momentum, sizing, and trading consumers. No WebSocket is required. Later phases will use Tiingo REST for daily EOD, consolidated intraday, and operational/latest price observations. Massive News was never an active production capability and will be retired, not migrated.

An operator must choose and record an explicit market session boundary outside regular trading hours for provider authority. Deployment time cannot infer the cutover. No code in this phase performs that cutover.

## Canonical evidence

`MarketBar` stays immutable with one accepted observation per `(securityId, timeframe, barStartAt)`. Provider is provenance, not part of identity. Massive historical rows remain unchanged. Future Tiingo rows join the same timeline after the explicit cutover. All bars remain raw `UNADJUSTED` OHLCV. Tiingo `DAY_1` ingestion must require and store its provider `splitFactor`; old Massive rows keep null, as may `MINUTE_15` rows. The database checks positive finite factors when present; provider/timeframe requirements belong in the ingestion validator so historical evidence stays valid.

`MarketSplitEvent` freezes a non-unit split factor with security, execution date, provider, provenance, receipt and creation times. One row per security/date prevents contradictory canonical factors. A disputed provider correction requires operator review rather than rewriting evidence. Phase 2 must migrate publishers to persisted split evidence, with explicit historical coverage and cutover rules; Phase 1 does not change their provider calls.

## Owned observation universe

AI Trader will curate about 3,000–3,500 U.S. equities manually, roughly quarterly. Initial source universes represent S&P 500, Nasdaq-100, DJIA, Russell 2000, S&P MidCap 400, and S&P SmallCap 600. `SecurityUniverseMembership` is effective dated and rejects overlapping intervals for the same security and universe. The frozen `BreadthUniverseRevision` and member table represent the deduplicated union selected for BREADTH_V2. One Security/issue gets one equal vote even if it belongs to several source universes. `memberCount` is a declared count; the future revision creation service must insert and verify all members in one transaction before use. The revision and members cannot be updated or deleted.

`Security.enabled` controls trading eligibility. It is never an observation universe filter. Any new observation-only Security must be created with `enabled=false` explicitly because the existing default is true. Membership does not grant a subscription or trading authority. `Security.sector` and `industry` remain mutable metadata, with no classification history.

`MarketBreadthObservation.breadthUniverseRevisionId` is nullable so all BREADTH_V1 evidence stays unchanged. BREADTH_V2 must require a revision at its ingestion boundary and read Tiingo canonical `DAY_1` bars. Sector breadth, rotation, dispersion, leadership, and momentum Market Intelligence are outside this branch.

## Transport and rollout

The Tiingo REST client validates shape, price ranges, duplicate timestamps, dates, and split factors. It bounds request time and per-process concurrency, and keeps credentials and upstream bodies out of errors. Later ingestion must add a cross-process provider rate budget, retry policy, completion window, audit events, and advisory locking; the present client does not submit database writes. Existing Massive configuration stays required. `TIINGO_API_TOKEN` is optional until the authority change.

Before persistent Tiingo ingestion, the owner must confirm a Tiingo plan that permits storage of raw market observations. Tiingo's [current terms](https://api.tiingo.com/tos/) restrict persistent retention on starter and trial plans. The intended data volume and EOD/intraday entitlements also need confirmation before Phase 2.
