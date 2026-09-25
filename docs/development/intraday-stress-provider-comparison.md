# Intraday Stress live provider experiment

Research only. No provider acceptance, production authority, database access,
trading dependency, startup integration, or production fallback. The existing
Alpaca Phase A/B tools and their evidence contracts remain intact.

The dated September 22 smoke and September 23 operator instructions below are
preserved as an experiment record. For the completed September 23–24 evidence
and current candidate conclusion, see the
[provider evaluation](intraday-stress-provider-evaluation.md).

## Architecture and design conflicts

The old journal is explicitly ALPACA/IEX and requires numeric trade volume.
The old Phase B classifier comparison uses hindsight historical IEX equality to
validate sparse reconstruction. Neither contract can honestly represent Tiingo
reference prices or a neutral live comparison. The new `src/dev/intraday-providers/`
subsystem therefore uses separate formats, a shared experiment identity, and
strict 15/15 comparison. It reuses existing Alpaca Capture/Journal/replay, the
verified calendar, frozen baseline readers, and the pure V1 calculator.

The parent forks three independent Node processes. Each owns its journal, lock,
transport, timers and shutdown. One failed child never stops a healthy sibling.
Parent signals send IPC shutdown; children also stop on parent disconnect and
their own absolute deadline. Full capture stops at session close +6 minutes.
Ctrl+C or SIGTERM drains journals. A ten-second shutdown watchdog leaves crash
evidence/locks for inspection if shutdown hangs. Windows uses IPC rather than
assuming child.kill(SIGTERM) provides graceful shutdown.

The experiment freezes session date/open/close/calendar hash, SPY/RSP, Git commit,
research source-code hash, provider run IDs, baseline hash, deadline and budgets.
The code hash distinguishes an uncommitted working-tree smoke from the HEAD commit.
Provider manifests link back to the experiment. Alpaca retains its original
manifest plus an `experiment-link.json` sidecar. Classification requires a shared
Massive prior-session ATR artifact copied immutably into the experiment. A bounded
smoke may omit it; no baseline is fabricated. A full run requires it at startup.

## Exact products and limits

Official documentation reviewed September 22, 2026:

| Product | Evidence and request | Limits/limitations |
|---|---|---|
| Alpaca Free / IEX | Existing native WebSocket bars and updatedBars; actual provider minute bars | Existing dedicated credentials, capture lock, exact subscriptions and bounded reconnect rules remain unchanged. |
| [Tiingo consolidated WebSocket](https://www.tiingo.com/documentation/websockets/equity-realtime-stock-data) | `wss://api.tiingo.com/equity/intraday`; subscribe SPY/RSP at thresholdLevel 6. Service `cons`, messageType `A`, `[timestamp,ticker,referencePrice]`. | Consolidated **derived reference price**, corresponding to tngoLast; not an executed trade. Beta. Emits meaningful price changes, not guaranteed one event per minute. |
| [Tiingo REST reference](https://www.tiingo.com/documentation/equity-realtime-stock-data) | `/tiingo/equity/intraday/<symbol>/prices`; date-bounded session, `resampleFreq=1min`, explicit OHLCV columns, `afterHours=false`, `forceFill=false` | Separate eventual provider OHLCV evidence; never repairs WebSocket observations. Beta; verify entitlement empirically. |
| [Twelve Data time_series](https://twelvedata.com/docs#time-series) | REST batch `symbol=SPY,RSP`, `interval=1min`, `outputsize=8`, `timezone=UTC`, `prepost=false`, `adjust=none` | Provider-produced bars. [Default live US coverage](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data) represents approximately 5% of US trading volume; listing coverage does not imply consolidated venue coverage. |

Tiingo REST schedule: one immediate SPY/RSP request pair for authentication/data
inspection; each regular-session 15-minute target +120 seconds; final pair at
close +300 seconds. A slot less than 60 seconds after startup is replaced by the
startup pair. For a normal pre-open launch: at most 28 pairs / 56 requests, at most
12 requests in any rolling hour. This is below the published Starter
[50/hour, 1,000/day](https://www.tiingo.com/about/pricing) limits. Date-bounded
responses include earlier minutes, preserving their repeated observations and
later changes. No per-minute Tiingo REST polling, automatic backfill or retries.

Twelve Data: immediate batch, then every 120 seconds starting at the later of
session open +10 seconds and startup +120 seconds, through close +250 seconds.
Eight recent bars overlap successive polls and recover short gaps. Never request
catch-up bursts after host suspension: slots over 60 seconds late are skipped.
A normal pre-open launch consumes at most 400 credits, two in any rolling minute,
including post-close polls. [Batching costs one credit per symbol](https://support.twelvedata.com/en/articles/5203360-batch-api-requests).
The free account assumption is [8/minute and 800/day](https://support.twelvedata.com/en/articles/5335783-trial);
the daily limit resets at [midnight UTC](https://support.twelvedata.com/en/articles/5615854-credits).

The local experiment lock serializes launch/reservation. A durable daily ledger
reserves planned Twelve Data credits, including failed or aborted runs, and refuses
research reservations above 700/day. This protects repeated local smoke/restarts;
it cannot see other checkouts, hosts or applications sharing the account. Keep
other account usage within the remaining allowance. Tiingo's published limits
also apply to other clients and repeated experiments. HTTP 429/body-code 429,
auth failures, malformed/null values and transport failures remain explicit events.
There are no immediate HTTP retries. REST requests have a 20-second timeout and
a 2 MiB response ceiling. No provider response body or raw exception is logged.

## Credentials and runtime

Node 24+ and the installed project dependencies are required. The manually
invoked capture npm command explicitly uses Node's `--env-file=.env.iex`:

```text
ALPACA_MARKET_DATA_API_KEY
ALPACA_MARKET_DATA_API_SECRET
ALPACA_MARKET_DATA_FEED=iex
TIINGO_API_TOKEN
TWELVE_DATA_API_KEY
```

Provision values in the existing ignored local file; never paste them into
commands, reports or Git. Modules consume process.env only. Application env.ts
is not imported; `.env.iex` is never loaded by normal startup. Only normalized
allowlisted market fields and safe event codes enter evidence. Authentication
frames, raw bodies, headers, URLs with credentials, environment dumps and provider
error text are excluded. Tiingo REST sends the token in Authorization; Twelve
Data's credential-bearing request URL exists only in transport memory.

## Today's smoke: September 22, 2026

1. Ensure the host clock is synchronized and no competing IEX capture owns
   `node_modules/.cache/intraday-stress-alpaca-iex/capture.lock`. A live owner must
   stop normally before another IEX capture starts; never delete its lock.
2. Run during the session. This lasts 150 seconds and performs at most two Twelve
   Data polls (four credits), plus at most two Tiingo REST pairs depending on the
   scheduled target. No ATR baseline is required for transport/integrity checks.

```powershell
npm.cmd run research:intraday-stress:providers:capture -- --session-date 2026-09-22 --duration-seconds 150
```

Equivalent explicit command:

```powershell
node --env-file=.env.iex --import tsx scripts/capture-intraday-providers.ts --session-date 2026-09-22 --duration-seconds 150
```

3. Confirm Alpaca authenticated/subscription_confirmed, Tiingo
   subscription_confirmed, and both REST providers poll_success. Startup prints
   the experiment directory, research warning, session, symbols and provider names.
   Transport acknowledgment is separate from actually observing both symbols.
4. Allow automatic shutdown or press Ctrl+C once. Wait for all children to exit.
   A nonzero exit means at least one provider failed; preserve healthy journals.
5. Analyze the printed experiment directory, without any credentials:

```powershell
$experimentDir = 'node_modules/.cache/intraday-stress-providers/2026-09-22/<experiment-id>'
npm.cmd run research:intraday-stress:providers:compare -- "$experimentDir"
```

Inspect generated `summary.md` and `report.json`: `integrity` for every provider,
`smokeReadiness.transportChecks` for acknowledgment, both symbols, clean shutdown
and protocol/rate/clock problems; especially RSP counts. `transportReady=true`
means these limited checks passed, not full-session coverage or authority.
Missing runs remain explicit. Corrupt manifests/interior records fail analysis;
truncated final lines remain crash artifacts. Mid-session classification is
unavailable because V1 requires the session prefix, even with a baseline.

## Tomorrow's full session: September 23, 2026

First freeze the September 23 baseline **after September 22 close +20 minutes**
(16:20 ET / 13:20 Phoenix), or tomorrow before open. The prior session must have
completed. This separate manual command calls only Massive and writes only disk.
Use a dedicated ignored file containing MASSIVE_API_KEY if it is not already
injected. Do not load application configuration or copy the key into artifacts.

```powershell
$baselineDir = 'node_modules/.cache/intraday-stress-providers/baselines/2026-09-23'
node --env-file=.env.massive-research --import tsx scripts/baseline-intraday-providers.ts --session-date 2026-09-23 --output-dir "$baselineDir"
```

If MASSIVE_API_KEY is already explicitly provisioned in `.env.iex`, the equivalent
npm command is `research:intraday-stress:providers:baseline` with the same arguments.
Existing matching Phase B baseline directories may instead be supplied directly.
Never reuse September 22's baseline for September 23. Repeated baseline commands
refuse an existing frozen file before making requests. No current-session daily
bar enters ATR; all sources share the existing Wilder/split/calendar calculation.

Start shortly before 09:30 ET / 06:30 Phoenix on September 23. The tool checks the
selected date equals today's New York date; it is not an overnight scheduler.

```powershell
npm.cmd run research:intraday-stress:providers:capture -- --session-date 2026-09-23 --baseline-dir "$baselineDir"
```

Keep the machine awake, clock synchronized, and disk available through 16:06 ET /
13:06 Phoenix. Verify all provider acknowledgments and observations at startup.
After automatic shutdown, run the comparison command against the new directory.
An early-start or full-session promise does not override missing provider data.

## Artifacts, replay and comparison

```text
node_modules/.cache/intraday-stress-providers/
  capture.lock
  budgets/<session-date>.ndjson
  <session-date>/<experiment-id>/
    experiment.json
    completion.json
    reference/baseline/manifest.json          # omitted for baseline-free smoke
    <alpaca-run-id>/                          # original Phase A format + link
    <tiingo-run-id>/manifest.json, journal.ndjson
    <twelve-run-id>/manifest.json, journal.ndjson
    derived/<analysis-id>/report.json, summary.md
```

New provider journals serialize and fsync every record with an 8 MiB bounded
queue, chain hash, run-local ordering, connection epoch, wall/monotonic receipt,
provider timestamp and payload/value hashes. REST observations additionally keep
requestedAt, firstSeenAt, revisionOrdinal and duplicate diagnostics. All copies
are retained; a later bar never overwrites an older observation. Identical
consecutive values are duplicates, not revisions; A -> B -> A is two revisions.
Tiingo repeated prices are observations, not provider trade revisions.

Tiingo minutes sort reference prices by full provider timestamp precision, using
local ordinal to break ties. OHLC is local reference-price OHLC; volume is null.
No event in a minute means no bar, even if the last reference price may have been
unchanged. A partial startup minute or minute overlapping a recorded stream gap
is unusable. REST failures do not falsely mark WebSocket transport gaps.

REST bars requested before minute end remain partial diagnostic evidence; a later
request at/after minute end is needed for completed-bar availability. Timestamped
null-OHLC rows retain their normalized nullable provider fields as unavailable
observation versions. Null/missing responses also produce diagnostics, never
synthetic bars or implicit deletions of previous evidence. Poll overlap can only
recover the returned recent horizon.

All providers use identical calendar-anchored, half-open 15-minute windows, strict
15/15, contiguous session prefix and prior ATR baseline. No sparse omission gate
is borrowed from Phase B. The closing window is retained but never actionable.
The calculator is imported directly; formulas and thresholds are not duplicated.
A regression test proves valid volume does not alter any V1 component or state.
Only the price-only adapter supplies a numeric placeholder for the calculator;
it restores null volume and explicit adapter metadata in measured report output.

Reports prioritize per-provider SPY/RSP expected/captured/missing minutes,
elapsed denominators, complete windows, first-seen/completed availability latency,
duplicates/revisions, transport events, minute/15m OHLC absolute/bps differences,
components, raw/effective states, directional agreement and high-risk false-negative
candidate diagnostics. `firstUsable` recalculates the earliest complete prefix's
prices at its availability boundary. Final values are hindsight; +30/60/90/120/300
seconds replay freezes each target's own measurements before chronological
hysteresis. Later receipts cannot rewrite earlier decisions. Effective states
held over unavailable raw evidence are not counted as comparable fresh states.

Massive delayed evidence remains optional and separately labeled. Use the existing
Phase B manual Massive fetch against the experiment's Alpaca run directory, then:

```powershell
node --import tsx scripts/compare-intraday-providers.ts "$experimentDir" --massive-run-dir "$alpacaRunDir" --massive-fetch-id <explicit-fetch-id>
```

The reference must match the session. Its fetchedAt is an availability bound,
not a reconstructed live Massive stream. Keep multiple immutable snapshots and
use existing Phase B stability analysis when evaluating reference revisions.
Neither Massive nor any live provider is called truth.

Restart creates a new experiment and new run IDs; it does not resume/merge a
segment, recover missed stream events or silently fill historical gaps. Locks
fail closed. Inspect host/PID before manually clearing a stale lock. Copy entire
experiment directories to an operator archive before cleaning node_modules.

## Validation and limits

### Offline Tiingo REST revision forensics

Run the analyzer against one or more completed experiment directories. It reads only
the frozen experiment, baseline, and Tiingo journal; it makes no provider requests.
The first input experiment owns the new exclusive
`derived/tiingo-revision-forensics-<uuid>/report.json` and `summary.md` directory.
All input artifacts and prior comparisons remain untouched.

```powershell
npm.cmd run research:intraday-stress:tiingo-revisions -- `
  node_modules/.cache/intraday-stress-providers/2026-09-23/51cf7399-467d-42bb-88a1-9d5400137d01 `
  node_modules/.cache/intraday-stress-providers/2026-09-24/2bd1d89c-ff4a-47ef-8288-ec2612ccf9a2
```

`DUPLICATE` means the captured normalized OHLCV exactly matches the immediately
previous observation. `INITIAL_PARTIAL_VERSION` records the first observation
when it was requested before minute end; it is not a value change.
`PRE_CLOSE_EVOLUTION` means a subsequent changed version was requested before
minute end. `FIRST_COMPLETED_VERSION` is the first usable request at or after minute
end, a milestone even if it matches the partial value. `POST_CLOSE_REVISION`
means a later completed observation changed from the preceding completed value.
`UNAVAILABLE_VERSION` retains a captured null-OHLC observation without claiming
an OHLCV change. A → B → A remains two changes.

The broad comparison `revisionCount` remains unchanged and includes nonduplicate
partial versions. The forensic report separates that count from post-close
changes, includes all observed versions, field deltas, distributions, timing,
first and final completed bars, strict 15-minute windows, V1 measurements,
chronological classifier readiness, and WS price-distance diagnostics. Each
session retains its own frozen baseline and calendar. The combined section
aggregates statistics only after per-session analysis.

`FIRST_COMPLETED` is the first completed version observed. `FINAL_OBSERVED` is
the last completed version inside the experiment horizon, not provider finality.
Their comparison measures revision sensitivity with hindsight. Chronological
records instead replay the captured REST stream at the earliest complete strict
prefix to describe what was known then. Receipt time is not fsync time. Neither
Tiingo WS nor REST is ground truth, and WS volume is unavailable. No provider
acceptance or trading authority follows from this analysis.

Final implementation checks: 135 focused research/calculation tests passed;
TypeScript check and backend build passed. The full suite passed 2,219 tests with
150 database-gated tests skipped (`RUN_DATABASE_INTEGRITY_TESTS=0`, two workers).
Earlier full runs encountered an intermittent Vitest worker exit; complete JSON
reporter reruns passed. No UI build, migration or database test was needed.

Offline tests inject sockets, HTTP responses, time and scheduling; automated tests
never call providers. Tests cover protocol/auth errors, reconnects, malformed/null
rows, duplicate/revised overlaps, precision/minute boundaries, no invented volume,
budget arithmetic, independent failure/shutdown, disk chain integrity, linkage,
shared baseline and deterministic CLI comparison. The transitive static boundary
test covers both research trees and forbids production imports of either.

Receipt time does not certify fsync completion. Native WebSocket has bounded close
waiting, no resume protocol and no claim that a quiet connection is complete.
Clock jumps are exposed. A successful smoke does not establish tomorrow's feed
availability, RSP completeness, adverse-regime fidelity or production readiness.
No acceptance thresholds, provider fallback or authority decision are introduced.

### Implementation smoke record, September 22

Manual live experiment `40609402-31cf-42f3-80de-9e9565309b40` ran for 150 seconds,
ending at 19:21:57 UTC. It used an uncommitted implementation identified by its
captureCodeHash. Tiingo WebSocket subscription succeeded and observed both SPY
and RSP across three minute slots. Tiingo REST returned 350 session minutes for
each symbol; these are historical provider-reference observations, not 350 minutes
of live WebSocket capture. Twelve Data returned eight recent bars for each symbol.
Both new-provider children drained and exited cleanly. Offline hash/provenance
validation passed with no recorded auth, malformed, rate-limit or clock errors.

Alpaca correctly refused to launch: an existing live capture held its lock
(PID 267060, start 16:24:11 UTC). That process and its evidence were left intact.
The other children continued, directly exercising failure isolation. The report
therefore marks three-provider transport readiness false. No baseline was supplied,
and no simultaneous three-provider or full-session classification claim is made.

The smoke exposed a startup scheduling inconvenience: replacing a nearby fixed
Twelve Data slot could delay its second poll beyond 150 seconds. The final schedule
uses startup +120 seconds (or session open +10 seconds, whichever is later), with
offline overlap/budget coverage. This original smoke had one Twelve Data poll;
it is preserved rather than retroactively described as a two-poll test.

Full-session readiness still requires releasing the existing IEX connection,
checking the simultaneous capture, and freezing September 23's baseline after
September 22 close plus the documented delay. No acceptance decision follows.
