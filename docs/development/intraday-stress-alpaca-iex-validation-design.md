# Alpaca IEX validation design for Intraday Stress

Date: 2026-09-21. Investigation only, on `feat/intraday-stress-v1`.
Repository inspected at `fb4202ac5afd7bb6a0b4d3b303e8f3d9573b6a18`.

## 1. Decision and scope

Phase B update (2026-09-22): the first operator capture had excellent transport
latency and no reconnects, but RSP supplied only 67 of roughly 80 elapsed minutes
while SPY supplied 80. Strict 15/15 produced only one paired complete window even
at +300 seconds. Missing minutes must now be tested against historical ALPACA/IEX
before distinguishing PROVIDER_NO_BAR from CAPTURE_GAP; continuity alone is not
proof. See [Phase B tooling and exact first-run results](intraday-stress-alpaca-iex-phase-b.md).
The strict diagnostic remains preserved. No IEX acceptance or production authority
follows from this evidence.

Alpaca IEX is a plausible **research candidate**, not yet an accepted Intraday Stress authority. A manually launched, account-independent capture experiment can safely evaluate it without touching production evidence or trading. Timeliness alone is insufficient: IEX must also preserve the price-based classification, particularly adverse events and RSP coverage.

Recommend a separate global market-data credential boundary, a standalone capture/replay harness, and an explicit accept/reject/inconclusive decision after multiple sessions. Keep Massive authoritative for daily evidence, Trend, Volatility and Breadth, and use separately captured delayed Massive intraday observations as the comparison reference. Never select a provider implicitly from availability.

If accepted, recommend `INTRADAY_STRESS_V2`, even with unchanged formulas and thresholds, because the evidence population and temporal acceptance contract change. Preserve V1 and its historical observations. Production integration requires a separate design and implementation task.

The original investigation included no prototype. Phase A is now implemented as a manually launched, isolated research harness; see [the Phase A operator guide](intraday-stress-alpaca-iex-phase-a.md) for exact files, commands and limitations. No live capture was run during implementation, no dependency was added, and no schema, startup or production authority changed.

## 2. Repository findings

### Alpaca integration and credentials

Inspected `src/integrations/alpaca/`, including client, adapters, types, normalizers, request metadata and relevant tests; `src/services/alpaca-config-resolver.service.ts`; `alpaca-api-usage.service.ts`; trading credential services; `src/config/env.ts`; `src/app/server.ts`; `prisma/schema.prisma`; `package.json`; Docker and compose configuration.

| Area | Actual implementation | Consequence |
| --- | --- | --- |
| REST transport | `alpacaRequestForAccount(tradingAccountId, path, options)` uses fetch, account resolver, typed endpoint/operation metadata and HTTP outcome accounting | Cannot directly serve an account-independent WebSocket |
| Broker coverage | Account, positions, orders including stable client-order lookup, submissions/cancellations, account activities, clock/calendar | Broker lifecycle support, not a market-data transport |
| Authorization | LIVE critical writes pass deployment flags and live-write/entry authorization | Do not import these concerns into regime evidence |
| Credentials | Resolver requires an existing Alpaca TradingAccount and normally an ACTIVE TradingAccountCredential; selects paper/live REST URL from account environment | No legacy-env fallback in this resolver; account deletion/revocation affects access |
| Clock/calendar | Account-keyed in-memory caches; clock cache also uses persisted Setting records | Do not reuse this adapter in the no-write research harness |
| Legacy env | `ALPACA_API_KEY`, `ALPACA_API_SECRET` still required by global env validation; `ALPACA_BASE_URL` remains compatibility input to paper-mode/startup checks and status | Both credential mechanisms exist in configuration, but active broker routing uses database credentials |
| Streaming/data support | Searches of owned `src/` and `scripts/` found no `data.alpaca.markets`, WebSocket, IEX/SIP selection, bars/updatedBars or Alpaca trade/quote stream implementation | Build a separate data adapter; position `current_price` is not bar evidence |
| Persistence | Alpaca broker fills go through broker lifecycle models; MarketBar ingestion is Massive-only | No existing Alpaca market-data persistence to reuse |
| Startup | `server.ts` starts minute evidence and Intraday Stress publication workers alongside daily dimensions | No Alpaca stream exists; research must not import server startup |

`TradingAccountCredential` has account ownership, encrypted key/secret, status and verification metadata. `trading-credential-crypto.service.ts` implements versioned AES-256-GCM using the configured encryption key and key ID. Its storage/rotation workflow is coupled to account activation and live-write capabilities. Reusing that credential record would unnecessarily bind global evidence to a trading lifecycle.

Reuse pure calendar/calculation code and architectural patterns, not the account REST transport, resolver, market-session adapter or REST usage registry. A provider login still owns the external entitlement; account-independent means independent of application TradingAccount state, not independent of Alpaca's authentication service.

The root AGENTS.md describes Intraday Stress and Breadth as research/calibration-only, but this branch contains production publisher implementations, migrations and server wiring. This investigation uses the actual branch code and the supplied acceptance report; it does not treat that older prose as evidence that publishers are absent. Updating the broader project manual is outside this focused design commit.

### MarketBar identity, ingestion and consumer inventory

`MarketDataProvider` currently contains only MASSIVE. `MarketBarTimeframe` contains DAY_1 and MINUTE_15, not MINUTE_1. MarketBar stores decimal OHLCV, adjustmentMode, provider, receivedAt and createdAt, with uniqueness on `(securityId, timeframe, barStartAt)`. It has no feed, revision, payload hash, finalization time or provider response status.

Migration `20260915120000_market_data_trend_foundation` enforces that unique index, finite/valid OHLCV, restricted Security references and a BEFORE UPDATE OR DELETE immutability trigger. Adding an enum value alone would not permit two providers for one interval. Adding provider/feed uniqueness alone would still not preserve repeated revisions from one feed.

`src/integrations/massive/evidence.client.ts` accepts both OK and DELAYED responses, requests unadjusted 15-minute aggregates, validates symbol/OHLCV/grid and rejects conflicting duplicates within one response. It assigns a local receivedAt per fetched page but discards response status from normalized bars. `syncMinuteBars` requests today's session only, inserts eligible missing intervals with `skipDuplicates`, and does not re-fetch already-present intervals when there are no gaps. Thus the first accepted observation wins, not the eventual settled aggregate.

Inventory from all owned-code `marketBar` queries and MASSIVE references:

| Consumer | Source assumption requiring preservation or review before dual-source storage |
| --- | --- |
| `intraday-stress-assessment.service.ts` | Explicit MASSIVE/UNADJUSTED for MINUTE_15 and daily baseline queries |
| `trend-assessment.service.ts`, `volatility-assessment.service.ts` | Explicit MASSIVE/UNADJUSTED daily reads and evidence provenance |
| `market-bar-ingestion.service.ts` | Daily/minute inserts explicitly MASSIVE; daily gap scan, minute presence scan and daily status query omit provider |
| `trend-lab.service.ts` | Daily research reads omit provider; adding another source could duplicate dates |
| `src/dev/volatility-report.ts` | Daily research reads omit provider |
| `scripts/research-intraday-stress.ts` | Daily baseline reads and grouped counts omit provider |
| Breadth observation ingestion, bootstrap import/artifact and V1 publisher | Separate MarketBreadthObservation and Massive grouped/reference evidence, not MarketBar; retain explicit Massive provenance and universe identity |
| `momentum-market-chart.service.ts`, `massive-market-data.service.ts` | Separate Massive-backed chart/data path, not an Alpaca or MarketBar fallback |

Provider-omitting presence queries are particularly dangerous: an IEX row could incorrectly satisfy a missing Massive interval. All such queries must become authority-specific before any shared-table expansion. No production query should select whichever provider arrived first.

Identity safeguards inspected: `src/db/__tests__/market-data.integration.test.ts` checks unique overlap/no rewrite, concurrent insertion, update/delete rejection, restricted Security deletion and invalid OHLCV. `market-bar-ingestion.service.test.ts` checks eligible insert-only MASSIVE data and no Alpaca dependency. Intraday integration tests protect immutable assessments, attempt/VALID uniqueness, lineage, concurrent publishers and no trading writes; publisher unit tests explicitly protect delayed recovery. Trend/Volatility integration and service tests plus Trend Lab/research tests use the single-source assumptions. None demonstrates dual-feed or revision identity; these would need new tests in a future schema task. No tests were run here that create databases.

## 3. Official capability findings

Official pages reviewed on 2026-09-21. These describe capability, not verified entitlement or measured behavior of this user's keys. No credentials were inspected and no Alpaca connection was made.

| Source | Verified finding |
| --- | --- |
| [Alpaca plans](https://docs.alpaca.markets/us/docs/about-market-data-api) | Trading API Basic is free for paper/live; US stocks/ETFs; real-time IEX; 30 WebSocket symbols; 200 historical calls/minute. The table lists a latest-15-minute historical restriction. Broker-partner plan limits are a different product. |
| [Market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) | IEX covers one exchange; SIP consolidates exchanges. Recent SIP requires subscription; unpaid historical SIP queries need `end` at least 15 minutes old. Latest IEX is available without that subscription. Hence “all free REST is delayed” is inaccurate; always specify feed. Bar timestamps are interval starts. No eligible trades, or only trades that cannot populate prices, can mean no bar. |
| [Real-time stock data](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data) | Endpoint: `wss://stream.data.alpaca.markets/v2/iex`. `v2/sip` and `v2/delayed_sip` are distinct feeds, not free real-time SIP. `bars` emits prior-minute aggregates after minute boundaries, including extended hours. `updatedBars` emits late-trade revisions after half-minute boundaries. Types b/u contain S, t, o/h/l/c/v, n and vw. t is RFC-3339; the revision retains the affected minute's timestamp. No bar sequence/revision ID or finality marker is specified. |
| [WebSocket protocol](https://docs.alpaca.markets/us/docs/streaming-market-data) | Authenticate using Trading API key/secret (same credential type as trading REST), via headers or auth message within 10 seconds. Connected/authenticated acknowledgments and full subscription acknowledgments are documented. Messages are arrays. Most subscriptions allow one connection per user/endpoint; another client can receive 406. Errors include 402 auth, 404 timeout, 405 symbol limit, 407 slow client, 409 entitlement and 500 server. Slow clients can disconnect without warning. |
| [Stock Minute Bars](https://alpaca.markets/learn/stock-minute-bars) | Explains initial calculation roughly one second after minute end and recalculation at 30 seconds for late trades. Treat this as explanatory timing, not a network delivery or finality SLA. |

The general protocol's one-connection wording is qualified (“many”/“most”), not a Basic-specific guaranteed matrix. Design for **one**, and verify entitlement/conflicts during a later manual run. SPY/RSP use only two symbols. Do not infer extra connections from separate application accounts or copied keys.

Documentation does not establish a maximum number of revisions per minute, an absolute latest correction time, resumable offsets, replay-on-reconnect, a guaranteed heartbeat cadence, or a numeric WebSocket control-message rate budget. Multiple corrections must be tolerated; whether they occur and whether all later trade corrections propagate to bars remain empirical/support questions. Trade correction/cancel channels are separate from updatedBars; bars-only capture is not a reconstruction of every trade correction.

Research protocol proposal (placeholders only):

```json
{"action":"auth","key":"<market-data-key>","secret":"<market-data-secret>"}
{"action":"subscribe","bars":["SPY","RSP"],"updatedBars":["SPY","RSP"]}
```

Wait for authentication acknowledgment before subscribing; verify both symbol sets in subscription confirmation. After disconnect, establish a new session, authenticate and subscribe again. This is an application requirement derived from session-scoped subscriptions, not a promise that the server resumes missed messages. Do not send invented JSON heartbeat actions. Connection acknowledgments are not ongoing evidence of symbol freshness.

## 4. Credentials and client recommendation

| Option | Assessment |
| --- | --- |
| New global `ALPACA_MARKET_DATA_API_KEY`, `ALPACA_MARKET_DATA_API_SECRET`, `ALPACA_MARKET_DATA_FEED=iex` | Recommended. Explicit data ownership, independent config validation and rotation; no TradingAccount lookup. Require IEX for this experiment and fix/allowlist the data endpoint. |
| Reuse legacy `ALPACA_API_KEY/SECRET` | Technically the credential type works, but implicit reuse obscures ownership and mixes compatibility settings with new authority. Do not silently fall back to these names. An operator could deliberately provision the same underlying pair into the new boundary, with shared rotation/connection limits understood. |
| Reuse TradingAccountCredential | Reject for global evidence. Account status/credential lifecycle, database availability, environment selection and decryption dependencies become global data dependencies. |

Use an operator-provisioned dedicated data credential pair where available, preferably avoiding live-trading keys for research. The docs do not establish a data-only privilege on a Trading API key; variable renaming does not remove broker privileges. The harness must have no broker endpoints or account-write code. Paper/live selects trading API routing, not the IEX data population; entitlement remains attached to the supplied external credentials.

For research, validate only the three new variables in a standalone module. Do not import `src/config/env.ts`, which demands database/trading configuration. Future deployment injects secrets through managed runtime configuration, excludes them from images/Git/output, and rotates by closing the old stream before authenticating the replacement. Never persist auth frames, headers, raw errors containing keys or entire environment objects. If global database-backed secret management is later needed, reuse the encryption primitive after decoupling it, with a separate credential owner model; do not create a fake TradingAccount.

Runtime evidence: Dockerfile uses `node:24-bookworm-slim`; production compose builds that file. Local `node --version` is v24.15.0. `package.json` has no engines constraint, no ws dependency and no Alpaca SDK; `@types/node` is v25-range, which does not establish runtime capability. Actual deployed image version was not inspected.

Node's [WebSocket documentation](https://nodejs.org/api/globals.html#class-websocket) records native client stability since v22.4.0, available without its experimental flag since v22.0.0. **Recommend native WebSocket for the Node 24 research harness**, with an explicit runtime/capability check and injected transport factory. Message authentication avoids needing custom handshake headers. Native client availability is not a reason to add a dependency here.

The [ws project](https://github.com/websockets/ws) exposes ping/pong and immediate termination, useful for production transport-health detection. It is a reasonable future production choice if those controls or broader runtime support are required; its dependency/types/lockfile would need an explicit change. Native's browser-style API lacks those low-level controls. A local application freshness watchdog cannot distinguish a healthy quiet feed from a dead socket by itself. Keep that limitation visible during research; do not call timeouts evidence of missing exchange trades.

Inject transport, clock, scheduler and append sink so parser/aggregation/reconnect tests are entirely offline. Do not rely on transitive ws packages or patch global WebSocket in every test. Fake transport tests should cover batched frames, confirmations, duplicate connections, malformed data, disk pressure, close/error ordering and reconnect cancellation.

## 5. Capture architecture and persistence

Proposed flow: manual CLI -> isolated global config -> one IEX connection -> pure frame parser -> append-only observation journal -> pure replay/aggregation -> separate comparison report. No Prisma imports, publisher calls or server wiring. Supply frozen daily baselines/calendar snapshots as files to offline analysis; any later export is a separate explicit read-only operation, not capture startup.

Use `node_modules/.cache/intraday-stress-alpaca-iex/<session-date>/<run-id>/`. Existing `.gitignore` ignores node_modules. Cache loss during npm cleanup is possible: archive selected runs to an operator-controlled location outside Git before reinstalling dependencies. Never store secrets there.

Proposed files:

- `manifest.json`: format/parser/aggregator versions, code commit, Node version, ALPACA/IEX endpoint, requested symbols/channels, UTC start, session/calendar hash, optional baseline hash, run ID and parent run ID. No credentials or full command/environment dump.
- `observations-000001.ndjson`: one normalized observation per line, retained even if duplicate or later superseded.
- `events.ndjson`: allowlisted connection/auth-success/subscription/close/gap/clock-jump/writer-failure events; only sanitized errors and close codes.
- `derived/<analysis-id>/`: regenerable minute versions, 15m versions, cutoff snapshots, comparisons and metrics, with input hashes and analyzer version.
- Separate `reference/massive/<fetch-id>/` artifacts: unadjusted data, response status/request metadata, receivedAt and content hashes, excluding authenticated URLs/headers.

An observation envelope retains `formatVersion`, `runId`, `connectionEpoch`, monotonically increasing local `ordinal`, frame ordinal and element index; `provider=ALPACA`, `feed=IEX`, `symbol`, `channel`, `messageType`; original provider timestamp string and parsed minute-start UTC; local UTC receivedAt and process-monotonic receive offset; normalized OHLCV plus n/vw when present; allowlisted provider metadata and canonical payload hash. Preserve the safe b/u payload fields needed to replay without rereading the network. No global provider sequence is invented: local ordinal is only local receipt order. Feed is connection provenance because bar payloads do not identify it.

Timestamp receipt before expensive parsing/disk work, then separately record durable append time. Guard integer precision and reject unsafe numeric fields rather than silently rounding volume/trade count. Preserve original timestamp precision while requiring minute alignment for accepted bars. Hash normalized content for deduplication diagnostics, not to discard raw observations.

Use one writer queue with bounded memory and backpressure monitoring. If persistence cannot keep up, stop capture and mark an explicit gap; never report dropped data as a complete run. Periodic flush/checkpoint and final flush define durability, not market finality.

Restart/resume: acquire an exclusive local capture lock before connecting; stale-lock recovery checks owner/process rather than blindly deleting the lock. Each restart writes a new immutable run/segment linked to the previous one. Replay complete newline-terminated records; record a truncated final line as a crash artifact, preserve the old segment, and never append over it. Corruption inside a segment fails analysis rather than skipping silently. Checkpoints are rebuildable caches keyed to journal hash/offset. Offline replay causes no network call. A fresh process records a reconnect gap; it never backdates receipt or assumes missed messages were replayed. Local locking does not protect a second host using the same entitlement.

## 6. Deterministic minutes and 15-minute aggregation

Use `market-calendar.ts` pure functions with an explicitly supplied, versioned calendar snapshot including closures and early closes. Never depend on the workstation timezone or account market-clock adapter. Convert America/New_York session open/close to UTC, respecting DST. Reject unknown calendar coverage instead of assuming every weekday is open.

Each bucket is `[sessionOpen + k*15m, sessionOpen + (k+1)*15m)`, anchored at 09:30 ET. `targetAt` is its end. Expect exactly 15 unique minute-start slots; one minute belongs to one bucket. Open = earliest minute open; high = maximum highs; low = minimum lows; close = final minute close; volume = sum selected minute volumes. Sort by provider interval time, not receipt time. Never aggregate volume across revisions of the same minute.

Capture the closing bucket for reference diagnostics, but exclude the bucket ending at session close from actionable classifier targets, matching existing code (25 actionable targets on a normal session; 13 on a 13:00 early close). Reject partial buckets from unsupported calendar alignment. Extended-hours bars can remain in the journal with exclusion reason, never in regular-session aggregates.

| Edge case | Deterministic research treatment |
| --- | --- |
| Missing minute, including no eligible IEX trades | INCOMPLETE with exact slot list. No carry-forward, zero-volume synthesis or substitution. Absence alone cannot distinguish sparsity from transport loss. |
| Identical duplicate | Retain journal record; no new selected value, no extra volume or correction count. Count duplicate messages separately. |
| b then u | u is a complete replacement OHLCV observation, not a delta; recompute the affected bucket and downstream session measurements. |
| Multiple u messages | Retain all; select latest received u as of the replay boundary. Count value-changing revisions separately from unchanged u frames. No “one update only” assumption. |
| u arrives before b | Accept valid u as observed minute evidence with `initialMissing=true`; a later b cannot downgrade it. Report the missing initial bar. |
| Conflicting b messages without u | Preserve both and mark ambiguous minute; exclude from accepted complete metrics until investigated. Do not silently choose by volume. |
| Out-of-order minute timestamps | Place into their own minute/bucket; local journal order determines what was known at each cutoff. |
| Conflicting updates across connection epochs | Maintain arrival-order research reconstruction with an ambiguity flag; exclude ambiguous windows from accepted classification pairs. No documented revision sequence proves which was newer at source. |
| Reconnect mid-window | Record disconnect/re-auth/subscription coverage, missing slots and possible missed revisions. Even 15 observed slots do not prove uninterrupted correction coverage. |
| First/final minute arrives late | FirstCompleteAt is when all slots actually exist; earlier cutoff snapshots remain incomplete. Updates after target completion produce new research versions. |
| Malformed timestamp/OHLCV | Quarantine sanitized diagnostics; reject non-RFC3339, impossible/non-minute timestamps, nonfinite values and invalid OHLC relationships. No truncation to force alignment. |
| Unexpected symbol/channel/feed | Exclude and flag configuration/protocol anomaly. Endpoint is fixed to IEX; reject mismatched provenance, never silently re-route. |

Within one connection, later u arrival is a deterministic **observation selection rule**, not a claim of source revision ordering. Preserve enough history to revise the research rule if data exposes ambiguity. Recalculate the whole session prefix when an earlier bucket changes: its close affects later references/rolling returns, and its high can affect every later drawdown.

Expose orthogonal diagnostics: `completeness`, `revisionSeen`, `initialMissing`, `transportCoverage`, `ambiguous`, `lateArrival`. Display COMPLETE_INITIAL when all slots are selected from initial b observations; COMPLETE_AFTER_UPDATE when a complete selection uses u evidence (whether it filled a gap or revised a complete window); INCOMPLETE otherwise. Store first-complete status/time separately so later revisions do not erase it. “Complete” means slot coverage, never proven finality.

## 7. Finalization and latency measurements

Do not adopt a production grace/cutoff in this experiment. Keep capture running through a documented post-session observation horizon and mark the last interval's metrics right-censored if capture ends too early. A quiet period cannot prove no later correction.

For each minute retain end time, first b receipt (nullable), first observed receipt, every u receipt, last value-changing correction observed, and durable-write time. For each bucket retain targetAt, firstCompleteAt, every version time/hash, last observed correction and whether a correction affects OHLC, volume or classification.

Replay as-of candidate times `targetAt + 30s / 60s / 90s / 120s / 300s`. At each time select only observations received by then; record candidateFinalizationAt only when complete and unambiguous. These are analysis scenarios, not proposed production defaults. Also record whether later observations invalidate each candidate snapshot's values or state. Repeat with a durable-availability boundary to expose disk lag rather than mistaking callback receipt for usable evidence.

Report counts, median, p90/p95/p99 and maximum, with denominators and censored observations:

- Initial b latency = first b receivedAt minus minute end; first-observation latency separately when only u exists.
- Update latency = each u receivedAt minus minute end; correction lag from first observation; last observed value-changing correction lag.
- Minutes with u / observed minutes, minutes changed / observed minutes; missing expected minutes separately.
- Windows changed after initial completeness / complete windows; windows whose classification changed after each candidate cutoff.
- FirstCompleteAt minus targetAt; complete-by fractions for every candidate horizon over **all scheduled windows**, separately per symbol and paired SPY+RSP.
- Reconnect downtime, subscription latency, receipt-to-durable delay, clock-jump exclusions and per-symbol staleness.

Synchronize the host clock and record clock quality/offset where available. Monotonic time orders events inside a run; UTC permits comparison to exchange interval time. Negative or implausible latency is a clock/data diagnostic, not fast delivery. Do not exclude missing windows to make latency look good.

## 8. Massive reference and classification comparison

Fetch delayed Massive data explicitly after the session and again later (for example next day) to test stability, retaining both snapshots. Label “settled reference” operationally by recorded agreement over these fetches, not as a provider guarantee. If they differ, retain both, flag reference uncertainty and postpone firm comparison for those windows. Capture response DELAYED/OK status even for older bars; status by itself does not prove an individual historical bar is unsettled.

Use the same symbols, interval starts, regular-session calendar and unadjusted convention as the capture. A reference-only fetcher may reuse pure parsing concepts but must not call ingestion or store MarketBar. Existing immutable MarketBar values from today's early polling are not a trustworthy settled reference. Never update those rows to make comparisons pass.

Join by symbol/session/bucket. Report OHLC signed differences, absolute differences and basis points `10000 * (IEX - Massive) / Massive`, with absolute-error distributions. Report volume absolute difference and ratio separately; consolidated and IEX volume are expected to differ. Different trade eligibility rules can also change extrema. Exact OHLC/volume equality is not the acceptance objective.

Use the existing pure exports from `src/services/intraday-stress-calculation.ts`: `measureIntradaySession`, `marketRawState`, `advanceIntradayStress`. Keep frozen thresholds unchanged. Supply both source runs with the **same** prior-session Massive daily ATR14 percentage baseline, using existing Wilder and split-normalization semantics, and identical calendar snapshots. Freeze baseline, source daily rows/hash, split evidence, units (fraction, not percent points) and code version before analysis. Do not import `intraday-stress-assessment.service.ts`, whose entry point reads/writes Prisma.

Compare per symbol: reference price, 15m shock percentage/ATR ratio and state; 60m realized movement/ATR ratio and state; session peak/drawdown; acute current-close downside; absolute HIGH safeguards; acute/session collapse predicates and reasons; general and raw states. Compare market raw state as worse(SPY,RSP), never average or SPY-only substitution. First three targets have rolling warmup, not a failure; target four begins the 60m comparison.

Run three clearly labeled views:

1. Observed-endpoint IEX versus settled Massive: isolates price-population effects, while acknowledging IEX may still lack unseen late corrections.
2. IEX as-of each candidate cutoff versus settled Massive: measures actionable timeliness plus classification fidelity. Reference future knowledge is intentional here and must be labeled; it is not a simulation of live Massive availability.
3. Independent chronological effective-state replays: reset at session start, apply each raw state once per target, pause/reset recovery confirmation on unavailable targets. Preserve each source/cutoff scenario's own lineage, then compare transitions and delay. Do not count every revision as a new hysteresis confirmation.

Raw-state comparison can proceed only when each calculation has its required complete session prefix and daily baseline. A single missing early bucket can make all subsequent session drawdowns unavailable under current pure logic. Report that cascading loss separately from the standalone complete-window rate. Do not omit it by starting the session at the first convenient complete bucket. As-of live replay freezes earlier decisions; hindsight replay may recompute the session but must remain a separate output. Mark effective-state comparisons unavailable when required lineage is not reconstructable.

## 9. Acceptance review, without invented pass thresholds

Collect consecutive full sessions plus identified ordinary/quiet, first-hour and high-volatility episodes. Document date selection and capture outages. Severe-market observations may require longer collection; a quiet sample cannot establish severe-event fidelity. Synthetic stress fixtures test code only and must not count as market evidence.

The results document must include:

- Scheduled windows, captured windows, paired windows compared, exclusions by reason and session count; normal/early-close denominators.
- Per-symbol and joint complete-window rates at all candidate cutoffs, uninterrupted-stream subsets, and end-to-end classifiable-target rate with prefix continuity.
- OHLC signed/absolute/bps error distributions, worst examples and volume ratios; ordinary versus volatile sessions and first-hour strata.
- SPY, RSP and market confusion matrices; exact agreement, adjacent difference (one severity), multi-level difference (two or three), with counts and denominator explicitly restricted to valid pairs.
- Separate unavailable outcomes over all expected targets; unavailable is never NORMAL or an agreement.
- Every Massive HIGH/SEVERE -> IEX NORMAL case and Massive SEVERE -> IEX NORMAL/ELEVATED case, including chronology, raw components, missing observations and distance from threshold boundaries.
- Opposite false-positive cases (IEX HIGH/SEVERE versus reference NORMAL, and IEX SEVERE versus reference <= ELEVATED), plus directional adjacent disagreements.
- Severe/HIGH predicate differences even where market max masks a symbol disagreement; state changes caused by later corrections; effective-state transition/detection/recovery delays.
- RSP minute sparsity and early-session gaps, reconnect episodes, no-update observation horizons, availability/correction latency and coverage limitations.

Review magnitudes and durations of errors, not only average agreement dominated by NORMAL. Show binomial uncertainty where useful and stratify/cluster by session because windows are correlated. Label insufficient HIGH/SEVERE coverage inconclusive. Do not optimize algorithm thresholds, relax missing-minute rules or drop RSP to force success.

The decision gate records accepted/rejected/inconclusive, justification, unresolved dangerous false negatives, evidence coverage, and separately proposed numerical service/fidelity objectives for a follow-up validation set. Acceptance as a candidate is not permission to publish. RSP sparsity, exchange-specific extrema/last prices, and the full-session-prefix requirement may make strict IEX unsuitable even if SPY looks excellent.

## 10. Current Massive acceptance defects and freshness semantics

The following are **user-reported live findings from 2026-09-21**, not independently reproduced by this investigation: both SPY/RSP responses reported DELAYED; receivedAt was later than targetAt+5m; later direct responses materially revised identical intervals; repeated MISSING_INTRADAY_EVIDENCE occurred; a failed target later became VALID; minute-sync and publisher workers entered failing health. No production database or live provider request was used to verify their exact values here.

The inspected code explains the mechanism:

1. `barEligibility` makes MINUTE_15 eligible at interval end +5m. Eligibility tests wall-clock time, not provider finality or arrival deadline.
2. The evidence parser accepts DELAYED and ingestion saves the first missing interval once eligible. receivedAt after +5m is not alone a defect (polling occurs then); the material revision proves that eligibility did not guarantee stable values.
3. Immutability correctly preserves that first observation. `skipDuplicates` cannot repair a premature authority decision, and a present interval stops triggering fetches for itself.
4. `fetchIntradayBars` filters on bar time eligibility but never gates receivedAt. `latestActionableTarget` permits an ordinary target until the next target's end+5m, i.e. targetAt+20m; the final actionable target expires at session close.
5. A failed attempt can be followed by a new immutable VALID attempt in that window. Unit test “eventually recovers a stuck target once evidence arrives” explicitly expects UNAVAILABLE attempt 1 -> VALID attempt 2 at +6m. Completion is rechecked against validUntil, so code does prohibit publication after that broader expiry.
6. Publication loads the last VALID predecessor and replays skipped targets from evidence available **now**. Late-filled gaps can therefore contribute to reconstructed hysteresis even though there is no retroactive assessment row. Repeated identical failures are fingerprint-suppressed but still yield blocked worker health. Minute sync throws on missing eligible bars; publisher wrapper throws on blocked results.

Conclusion: the current +5m value is an earliest eligibility time, not an enforced acute-evidence freshness deadline. Recovery is intentional in current code/tests; it is a mismatch with a stricter interpretation of “right now,” not proof that an implemented +5m upper bound malfunctioned. No behavior is changed here.

### Proposed future contract

Separate `targetAt`, earliest publish/finalization eligibility, evidence acceptance deadline, publication deadline, and current-result validUntil. Choose their offsets only after measurements; +5m cannot simultaneously mean “first fetch allowed” and “all fetching must already be done” without proactive capture and explicit boundary semantics.

For the future authority, once a target misses its acceptance/publication deadline, it must never newly become current authoritative VALID. Late evidence and revisions remain historical observations/reference diagnostics. Reconnect/retry does not reset the deadline. Define receipt as durably available validated evidence, preserve callback receipt separately, and revalidate publication completion before committing. Explicitly document equality: observations durably present at the evidence cutoff may qualify; no publication at or after its expiry. Final deadline values remain undecided.

Implications for the future design:

- **Retries/attempts:** transient UNAVAILABLE attempts may recover only before the deadline. Preserve all attempts; record one terminal deadline outcome with idempotent suppression afterward. A worker down across the cutoff needs an explicit terminal-gap record, not inferred success from subsequently filled bars. Do not mutate failed attempts.
- **Hysteresis:** expired/unavailable targets feed null, hold internal severity and reset recovery progress; held state is not a fresh current assessment. Later historical completion cannot count as a supporting recovery assessment or retroactively worsen/soften the live chain.
- **Lineage:** each authoritative result references its same-version predecessor plus ordered target outcomes and immutable selected evidence IDs/hashes/cutoff. Carry explicit expired gaps even if previousAssessmentId remains the last VALID row. Persist terminal availability facts or an equivalent verifiable ledger.
- **Replay:** reconstruct what was known by each historical cutoff, not the latest stored values. Keep forensic hindsight replay separate. Restart cannot bootstrap through missed targets as if they were timely VALID observations.
- **Later measurements:** timely decisions at a new target may use historical observations now available as measurement inputs, with full provenance and a declared revision policy. That does not rehabilitate earlier target outcomes. Compare this policy empirically against freezing earlier bucket versions; choose explicitly before production.
- **Corrections:** append immutable observations; never rewrite a published assessment or finalized snapshot. Post-cutoff corrections belong to diagnostics and potentially future-target inputs under the declared policy, not alternate VALID attempts for the same target.
- **Health:** distinguish connected/authenticated, data completeness, deadline misses and publisher health. Historical reference recovery is not a successful current publication. Aggregate incidents to avoid one alert per tick; health can recover on subsequent timely targets while retaining missed-target evidence.

## 11. Versioning and future schema alternatives

Recommend V2. Source population (consolidated versus single venue), minute composition/revision policy and time-of-knowledge acceptance are part of the dimension's evidence contract, even if the numeric classifier stays identical. V1 definition currently versions formulas/thresholds but does not explicitly authorize changing providers under the same label. V2 offers a clean lineage boundary, preserves existing audit meaning and prevents accidental reuse of V1 continuation. Freeze the new provider/feed/finalization policy in V2 evidence; continue daily Massive baselines explicitly. Begin at a reviewed session boundary with session-local bootstrap and no cross-version predecessor. APIs/UI/version selection and constraints need a later impact review.

Remaining V1 would be defensible only with an explicit evidence-policy version and fully isolated authority/lineage selection; that is more ambiguity than this branch needs. Do not relabel historical V1 rows or use an evidence-schema version alone as a silent provider switch.

| Alternative | Benefits | Costs and risks |
| --- | --- | --- |
| A: provider in MarketBar unique key | Smallest way to store Massive and Alpaca for one interval; existing Massive values unchanged | Cannot distinguish IEX/SIP; still only one observation per provider/interval; implicit consumers break; 1m timeframe and correction storage remain unresolved |
| B: provider + feed identity in unique key | Separates ALPACA/IEX from ALPACA/SIP and supports explicit provider replacement/comparison | Needs controlled non-null feed semantics, consumer/index updates and provenance migration strategy; still cannot store repeated revisions without an additional observation identity |
| C: immutable raw provider observations separate from canonical evidence | Preserves every arrival/revision and receipt time; supports dual-feed comparisons, as-of replay and policy-specific finalized snapshots | Additional storage, retention, lineage and selection complexity; “canonical” must be scoped by authority/version, never mean whichever provider is available |

Prefer **C with explicit provider/feed identity** for future production design. Initially retain existing MarketBar and all daily consumers unchanged as legacy accepted Massive evidence. Add an append-only observation store whose identity can distinguish repeated observations by feed/symbol/timeframe/start plus observation ID, received time/hash and capture metadata. Source timestamp is not a revision key. Build immutable selected 15m snapshots with constituent observation references, algorithm/aggregation version and cutoff. V2 can consume these explicitly rather than inserting IEX into the legacy table.

A later unification could adopt B for selected snapshots, but must not imply updates to immutable legacy rows. Adding feed metadata via a separate mapping may avoid rewriting old rows; any column/default/backfill migration must preserve values, receipt timestamps, identities and triggers. Existing Massive records should be labeled as historical accepted observations, not retroactively certified final. Assess storage cost and retention without deleting evidence referenced by assessments. No migration or enum/key change is proposed for the research phase.

## 12. Connection ownership and observability

Research: one manually launched process, one connection, two symbols, no production wiring. Record reconnects and subscription acknowledgment before treating coverage as active. Use exponential backoff with jitter and a cap; one reconnect timer and one socket generation at a time. Reset backoff after sustained health, not merely TCP open. Authentication/entitlement failures stop for operator correction; repeated 406 must back off and surface ownership conflict instead of racing another client.

Future production: one dedicated global data service/worker owns the connection for the deployment, independent of TradingAccount, tradingEnabled, kill switch, LIVE/PAPER mode and broker-write settings. A process-global singleton is necessary inside one process but insufficient across replicas. Prefer a dedicated single-replica service initially, with explicit deployment ownership and graceful rolling replacement; generic backend replicas must not each connect.

For failover, compare:

- Session-level Postgres advisory lock on a dedicated connection: fits existing locking patterns, releases on DB session death; not a long transaction and not a transaction-scoped lock across the stream lifetime. Immediately close the stream if the lock connection is lost. Detection lag/network partitions still permit overlapping external sockets.
- Leader lease with fencing epoch: owner renews against database time, closes before lease expiry, and each persistence operation verifies the current epoch. More schema/coordination complexity but stronger protection against stale-owner writes. Fencing protects database authority, not Alpaca's external connection slot.

Recommendation for production review: dedicated owner plus fenced lease if automated failover is required. Do not claim an advisory lock alone guarantees no overlapping sockets during partitions. If two processes connect, the provider may reject the second (406); if entitlement permits both, downstream deduplication and fencing must still prevent duplicate authority. Account/key aliases may share a provider connection budget, and third-party applications can consume it. Coordinate rotation/deployment and avoid overlapping old/new streams.

Proposed WorkerHealth key: `alpaca_iex_market_data_stream`, global rather than account-scoped. Health is sustained connection/subscription and per-symbol timeliness, not a successful recurring REST-like tick. Metrics: active/attempted connections, reconnects/backoff, connection epoch/owner, subscribed symbols, frames/elements/bytes, b/u counts, value changes, duplicates, malformed/ambiguous frames, last message and per-symbol minute timestamps, pending writes, durable lag, disconnect gaps and deadline misses. Schedule-aware idle outside sessions is distinct from stale evidence during sessions. Transport-health thresholds are operational settings, separate from research finalization cutoffs.

On SIGTERM: prevent reconnects, close stream, drain bounded in-flight parser/writer work, flush journal or commit selected observations, record shutdown/gap and release leadership only after ingestion stops. Use a bounded drain timeout and record an unclean end if exceeded. A mid-window drop marks incomplete/coverage-uncertain evidence; reconnect resumes capture prospectively. Historical REST repair, if ever used, is separately labeled and cannot erase live availability failure.

`AlpacaApiUsageRegistry` accounts for account-scoped REST operations, HTTP outcomes, response rate-limit headers and deferral. A received bar is not an API request. Do not send WebSocket frames through it or let trading REST backoff pause a global stream. Use the separate metrics above. Future optional market-data REST calls need their own global provider/feed request accounting.

The initial harness needs **zero Alpaca REST requests**: authentication and subscriptions occur on its one stream; calendar/baseline inputs are local files. Massive reference pulls are separate, bounded, cached research requests and must respect that provider's configured entitlement. Optional later Alpaca historical IEX diagnostics may help attribute gaps, but are not live recovery and cannot replace missing captured observations. Two symbols and one persistent connection avoid REST polling pressure; rate/connection failures still remain observable, not assumed impossible.

## 13. Staged implementation and decision gates

| Phase | Deliverables | Boundary/validation |
| --- | --- | --- |
| A: research harness | Standalone config, native WebSocket adapter, pure parser, journal/restart logic, calendar injection, deterministic aggregation/as-of snapshots and offline fixtures | No database/schema, backend startup or publication. Mock transport, clock and disk; test corrections, ambiguity, missing minutes, DST/early close, crashes and zero unauthorized side effects. Run TypeScript check, focused tests, diff check. |
| B: evidence collection and analysis | Manual full-session runs, delayed Massive snapshots, frozen baseline files, pure classifier comparison, results document and reproducible artifact hashes | No automated live connections in tests. Separate live availability and hindsight fidelity; report unobserved market regimes and reference revisions. |
| Decision gate | Accept/reject/inconclusive IEX candidate; review adverse false negatives, RSP continuity and latency objectives | No threshold tuning to force agreement. Insufficient volatile/severe coverage remains inconclusive. No production authority granted by capture success. |
| C: production evidence design, only if accepted | Provider/feed observation/snapshot model, reviewed migrations, authority/version contract, deadline/outcome ledger, worker ownership/fencing, rotation/retention/runbook and consumer audit | Preserve legacy Massive evidence and daily dimensions; explicitly review every provider-omitting query. Separate approval/task before implementation. |
| D: explicit authoritative integration and acceptance | Version-specific publisher, currentness/lineage selection, no-fallback behavior, health/shutdown and market-hours acceptance | Backend and relevant integration checks, future migration verification and live data-only acceptance. Trading authority remains zero; deployment is a separately authorized operation. |

Phase A fixture matrix includes b/u batching, u-before-b, repeated updates, ambiguous duplicates, cross-epoch updates, final-minute correction, missing first minutes, and replay of candidate cutoffs without future-data leakage. Session classification, baseline-unit parity and frozen definition reuse belong to Phase B comparison; Phase A invokes no classifier or baseline logic.

### Phase A concrete choices (2026-09-22)

- Native Node 24 WebSocket through an injected transport; independent three-variable config, fixed IEX endpoint and SPY/RSP b/u subscription. No SDK/ws dependency or application environment import.
- One exclusive repository-local capture lock; stale locks fail closed for operator PID/host inspection. Restarts create a new UUID run, optionally linked by parentRunId; old segments are never resumed.
- One append-only observation segment plus event journal, 8 MiB bounded queue and fsync per record. Receipt timestamps precede parsing. Durable completion timestamps are not implemented; durable-cutoff replay remains an explicitly documented measurement limitation rather than conflating receipt with durability.
- Inclusive receipt-cutoff replay, sticky ambiguity for conflicting initials and differing cross-epoch replacements, u-before-b retention, strict 15-slot windows and constituent provenance. The verified pure 2021–2026 calendar is frozen by hash; unsupported coverage fails closed.
- Eight run-total exponential/jittered retries, 30-second delay cap and a 10-second handshake watchdog. Terminal auth/entitlement/config errors stop. Native close is awaited before another socket; shutdown drains with bounded close/signal watchdogs.
- JSON analysis exposes scheduled-window denominators, censored candidate cutoffs, aggregate versions, gaps and clock uncertainty. No Massive retrieval/comparison, classifier execution or acceptance decision is included.

## 14. Risks and unresolved questions

1. Does this user's entitlement accept both channels for SPY/RSP on IEX, and is its single connection already used elsewhere? Verify manually later.
2. How sparse is RSP's eligible IEX minute evidence? Strict 15/15 windows and complete session prefixes may be the decisive blocker.
3. Do later or repeated revisions occur beyond the described half-minute cycle, including across reconnects? What provider support guidance exists for correction ordering/finality and heartbeat behavior?
4. Can venue-specific highs/lows or sparse closes suppress acute or session collapse conditions? Favor event case studies over aggregate agreement.
5. How stable is delayed Massive reference evidence over repeated fetches? Retain uncertainty rather than declaring the latest response truth without qualification.
6. What is the measured availability/correction distribution under ordinary, opening and volatile conditions, including host/disk delays? No production cutoff chosen yet.
7. Which explicit historical-revision policy should future targets use, while preserving earlier decisions and hysteresis? Research should expose its effects before selection.
8. Confirm actual deployment Node version, secret ownership, data-use entitlement and multi-process topology before a later production task. This investigation inspected repository configuration only.
9. Documentation has qualified connection limits and no revision/heartbeat SLA. These are open questions, not permission to infer stronger guarantees.

## 15. Non-goals and validation record

This task does not fix today's failed acceptance. No Prisma migration/generation, provider enum or uniqueness change, MarketBar rewrite/insertion, assessment publication, grace/threshold/version change, Alpaca startup worker, `.env` edit, dependency installation, signal/order/account write, live connection, deployment, branch switch, merge/rebase or push. No production/live credentials were used in tests or displayed.

Documentation-only validation: `git diff --check`, staged diff review and one focused local commit. Backend/UI builds and database tests are unnecessary for this document-only change and were not run. The future phases above are proposals, not implemented work.
