# Alpaca IEX intraday research: Phase A

Phase A implements an isolated, manually launched capture/replay experiment. **IEX is not accepted as Intraday Stress evidence.** No assessment, classifier comparison, production cutoff or trading authority is produced. The first live connection is an operator action after review; implementation and tests used no Alpaca connection.

## Files and isolation

| File | Responsibility |
| --- | --- |
| `src/dev/alpaca-iex/config.ts` | Only the three dedicated market-data variables |
| `src/dev/alpaca-iex/transport.ts` | Native WebSocket adapter and injectable interface |
| `src/dev/alpaca-iex/capture.ts` | Protocol state, receipt stamping, reconnect/shutdown |
| `src/dev/alpaca-iex/model.ts` | Pure normalized format, validation and hashes |
| `src/dev/alpaca-iex/journal.ts` | Exclusive run creation, lock, bounded append queue and fsync |
| `src/dev/alpaca-iex/session.ts` | Pure verified calendar/session snapshot |
| `src/dev/alpaca-iex/replay.ts` | Cutoff minute reconstruction, strict windows and provenance |
| `src/dev/alpaca-iex/analyze.ts` | Offline completeness, revisions and latency diagnostics |
| `src/dev/alpaca-iex/cli.ts` | Manual entry-point orchestration and artifact validation |
| `src/dev/alpaca-iex/{capture,replay,boundary}.test.ts` | Offline fixtures, disk/CLI round trip and transitive dependency guard |
| `scripts/capture-alpaca-iex-intraday.ts` | Capture command |
| `scripts/analyze-alpaca-iex-intraday.ts` | Offline JSON command |
| `package.json` | Two explicitly invoked research scripts |

Existing pure calendar helpers and the verified 2021–2026 closure definition are reused. No database calendar query occurs. The manifest freezes session open/close, calendar coverage and exception hash. Closed dates and dates outside verified coverage are rejected. A changed calendar hash requires explicit artifact/parser review; analysis never silently substitutes a new calendar.

The dependency test traverses imports/exports with the TypeScript parser. Only this research subtree, four explicitly named pure calendar modules, and allowlisted Node builtins may be reached. Dynamic imports/require and forbidden persistence/trading identifiers are rejected; production source must not import the research subtree. Neither CLI imports application `env.ts`, Prisma, account/broker services, entry/exit pipelines or publishers. There are no schema changes, migrations, Prisma generation, server changes, workers, provider enum changes, threshold/grace changes or V1/V2 authority changes.

## Runtime and explicit configuration

Local verification: Node v24.15.0, native `WebSocket` present, installed `@types/node` declarations expose it, and the ES2022/NodeNext project compiles it. Capture requires Node 24 or later. No `ws`, SDK or dependency was added. The adapter sends message authentication to the fixed `wss://stream.data.alpaca.markets/v2/iex` endpoint.

Required process environment:

```text
ALPACA_MARKET_DATA_API_KEY=<operator-provisioned key>
ALPACA_MARKET_DATA_API_SECRET=<operator-provisioned secret>
ALPACA_MARKET_DATA_FEED=iex
```

No legacy `ALPACA_API_KEY`/`ALPACA_API_SECRET` fallback exists. Supplying the same underlying pair is an explicit operator choice. The harness does not automatically load `.env` or validate unrelated application configuration. Never commit credentials or paste real values into commands that save shell history.

The normal command is:

```powershell
npm.cmd run research:intraday-stress:alpaca-iex:capture -- --session-date 2026-09-22
```

If environment injection is inconvenient, create an ignored local `.env.iex` with only the variables above using an editor, then use Node's explicit env-file loader:

```powershell
node --env-file=.env.iex --import tsx scripts/capture-alpaca-iex-intraday.ts --session-date 2026-09-22
```

Optional arguments: `--output-dir <root>` and `--parent-run-id <previous-run-id>`. The date defaults to today's New York date. Symbols are frozen to SPY/RSP; no symbol/feed/endpoint tuning is exposed. Choose the actual session date for the capture; the command does not wait until market open or auto-stop at the close.

## Protocol, retry and shutdown

Expected event sequence: `process_started`, `socket_connected` (provider connected acknowledgment), `auth_sent`, `authenticated`, `subscription_sent`, `subscription_confirmed`. The only requested channels are `bars` and `updatedBars`, each with exactly SPY/RSP. The acknowledgment must contain exactly those symbol sets and no nonempty additional channel. Valid data arriving before confirmation is preserved and flagged as a protocol anomaly.

Frames are JSON arrays. Receipt wall time and process-monotonic offset are stamped before parsing. Malformed frames/observations, unexpected symbols and unexpected types produce sanitized events, without retaining unsafe raw payloads. Event output goes to stderr. Server messages and native exceptions are never printed; numeric provider error codes remain inspectable.

Authentication, entitlement, invalid subscription and other non-transient errors terminate with a nonzero status. Network failures and provider 406/407/500 receive at most eight retries per run. Backoff uses 500ms exponential bases capped at 30 seconds, jittered to 50–100% of the base. The budget does not reset merely because a connection opens. One reconnect timer is permitted; every new socket gets a new epoch, reauthenticates and resubscribes. A 10-second handshake watchdog detects stalled connection/auth/subscription setup. A retiring socket must be closed before another is opened. No invented heartbeat or REST repair is used.

Ctrl+C/SIGTERM disables reconnect, closes the socket, drains append work and records shutdown events. Native close waits at most five seconds; the overall drain watchdog for signals and terminal failures is ten seconds. A drain timeout exits unsuccessfully and leaves the lock/crash evidence for review. Disk/queue errors stop capture; when the disk cannot record `writer_error`, a sanitized stderr event is the fallback. A shutdown-complete journal record means capture shutdown completed, not that all possible provider corrections arrived.

## Journals and restart

Default layout:

```text
node_modules/.cache/intraday-stress-alpaca-iex/
  capture.lock
  <session-date>/<uuid-run-id>/
    manifest.json
    observations-000001.ndjson
    events.ndjson
```

The lock is repository-local even with a custom output root. It records PID, host and start time, never credentials. Existing locks fail closed: inspect the owner host/process before manually removing a stale lock. No automatic stale-lock deletion occurs. This is not cross-host leader election and cannot stop another repository/provider client from consuming the same connection entitlement.

Each invocation exclusively creates a fresh run. A restart never appends to the previous run; optionally link it with `--parent-run-id`. There is no retrospective gap repair or cross-run replay merge.

The manifest records format/parser/aggregator versions, Git commit, Node version, provider/feed/endpoint, symbols/channels, run/start identity and calendar/session snapshot. Each observation contains run/epoch, local ordinal, frame ordinal, element index, original RFC3339 provider timestamp, normalized UTC minute start, receipt UTC/monotonic offset, b/u channel, OHLCV, optional trade count/VWAP, and canonical payload hash. The hash covers symbol/minute and normalized values; it intentionally ignores receipt/channel so identical replacements can be diagnosed. Ordinals reflect local receipt only; they are not provider sequence IDs.

Validation rejects impossible/non-minute timestamps, fractional timestamp residues, invalid OHLC relationships, nonfinite/unsafe numeric values, negative/fractional share volume and unsafe/noninteger trade counts. No silent coercion or timestamp rounding occurs. Unexpected symbols/types are excluded and counted.

NDJSON uses exclusive append handles and one queue bounded at 8 MiB. Every record is flushed with fsync before its append promise completes. No rotation is currently needed for two symbols. Separate durable timestamps are deliberately not recorded: a timestamp inside a line cannot certify its own future fsync completion. Reports use receipt cutoffs only and explicitly state that durable-availability replay is unavailable. A later phase can add a separate flush acknowledgment ledger if measurements require it.

Replay reads complete newline-terminated records; a partial trailing line is reported as a crash artifact and left untouched. Interior corruption or invalid normalized records fail analysis. Missing segment files and unsupported manifest identities fail. Journals never contain auth frames, keys, secrets, full environment, raw error text or credential URLs.

## Replay and aggregation

Replay accepts one run and an inclusive receipt cutoff. Local ordinals order the observations that passed the cutoff. It retains all observations and selected provenance for each ALPACA/IEX/symbol/minute; future receipts cannot change earlier snapshots.

- Initial b establishes a minute. Conflicting b observations mark it ambiguous and never silently replace its values.
- Each u replaces the selected values in local receipt order. Identical payload repeats remain observable without adding a value correction or volume.
- A u before b is usable research evidence with `initialMissing=true`; a later b clears the missing-initial diagnostic but cannot downgrade u values.
- A differing u across connection epochs is conservatively ambiguous. Receipt-order values remain available for forensic inspection; accepted complete counts exclude ambiguity.
- No claim of provider revision ordering or correction finality is made.

Windows are half-open 15-minute intervals anchored at 09:30 ET. Exactly 15 distinct one-minute slots are required, with first open, maximum high, minimum low, final close and summed selected volume. No missing slot is synthesized. Extended-hours/other-session observations remain in the journal and are excluded from session windows. Early-close and DST behavior come from pure repository calendar functions. The closing window is retained with `actionableTarget=false`.

States are `INCOMPLETE`, `COMPLETE_INITIAL`, `COMPLETE_AFTER_UPDATE`, with orthogonal ambiguity/initial-missing/transport diagnostics. Constituent value changes create immutable report versions even when resulting aggregate OHLCV is unchanged. Equal receipt timestamps are treated as one availability group. Identical duplicate receipts do not create value versions; all selected-observation provenance remains in minute history/final windows.

## Offline analysis

No provider credentials are needed:

```powershell
npm.cmd run research:intraday-stress:alpaca-iex:analyze -- "node_modules/.cache/intraday-stress-alpaca-iex/2026-09-22/<run-id>"
```

For a clean JSON file without npm's command banner:

```powershell
node --import tsx scripts/analyze-alpaca-iex-intraday.ts "node_modules/.cache/intraday-stress-alpaca-iex/2026-09-22/<run-id>" > iex-report.json
```

Optionally pass `--cutoff 2026-09-22T15:00:00Z`; it cannot exceed the recorded horizon. The default is the latest recorded observation/event timestamp. Redirect generated reports to an ignored/operator archive location rather than committing capture data.

Reports include manifest and input hashes, b/u/symbol counts, malformed/unexpected/ignored counts, duplicate/correction counts, expected/missing/ambiguous minutes, connection events and reconnect gaps, window versions/provenance, first all-initial availability, first unambiguous completion, selected-correction availability, latest value-changing correction and aggregate deltas. Minute diagnostics retain initial/update receipt times, initial/update latency, correction lag and whether OHLC/volume ever changed.

Latency summaries include count, negative count, median, p90/p95/p99 and maximum. Completeness tables use target +30/60/90/120/300 seconds, separately by symbol and paired SPY+RSP, over all scheduled windows. Horizons beyond capture end are censored; later changes to candidate snapshots remain visible. Connection continuity is diagnostic, never proof that revisions were not missed. A receipt wall-clock/monotonic discrepancy above one second flags clock uncertainty and excludes that run from latency acceptance. Negative latency is reported, not celebrated as faster delivery. Host clock synchronization remains an operator responsibility.

## First manual live capture (operator only)

1. Review this commit. Use Node 24+, a synchronized clock, writable local disk, and the intended verified trading session date. Ensure another client is not already using the provider connection entitlement.
2. Provision the three dedicated variables or create the ignored `.env.iex` file described above. No application/database/account credentials are required.
3. Run one capture command above before 09:30 ET if possible. Confirm `authenticated` and `subscription_confirmed` in stderr and `events.ndjson`. Auth/entitlement errors require operator correction; do not start competing clients.
4. Leave it running for several 15-minute windows, ideally the full session in a later run. Continue through an explicitly noted post-session observation horizon if studying closing-window corrections; no horizon proves finality.
5. Press Ctrl+C once, wait for exit, and inspect the last event for `shutdown_complete`. Preserve stderr if capture reports disk/queue failure.
6. Run the offline analyzer. Inspect SPY/RSP missing minutes, ambiguity, correction/latency distributions, censored windows and paired candidate-cutoff completeness. Capture success does not accept IEX.
7. Archive the complete run directory and JSON report before cleaning/reinstalling node_modules. For example, after replacing the paths:

   ```powershell
   Copy-Item -LiteralPath "node_modules/.cache/intraday-stress-alpaca-iex/2026-09-22/<run-id>" -Destination "D:\ResearchArchive\<run-id>" -Recurse
   ```

   Copy rather than alter the original journal. Choose an existing operator-controlled archive parent outside this repository; preserve all files, manifest and hashes. Secrets are not part of the run and must not be copied into it.

## Validation and Phase B boundary

Focused tests use fake transports, clocks, schedulers and sinks; no test opens a live Alpaca socket. Tests cover batching, auth/entitlement failure, exact subscription validation, retry budget/cancellation, epoch changes, malformed evidence, disk failure, append/crash behavior, offline CLI without credentials, revisions/cutoffs, missing first/interior minutes, final-minute updates, extended hours, DST/early close and transitive zero-authority isolation.

Checks: `npm.cmd run check`, `npm.cmd run build`, `npm.cmd exec vitest run src/dev/alpaca-iex`, `npm.cmd test` with `RUN_DATABASE_INTEGRITY_TESTS=0`, and `git diff --check`. No UI changes/build, database tests, migration or Prisma generation are required.

Implementation validation on 2026-09-22: 47 focused tests passed. The final full-suite run with `--maxWorkers=4` passed 2,184 tests (198 files), with 150 database-gated tests skipped (9 files). One preceding default-concurrency rerun had a Vitest worker exit unexpectedly; the bounded-concurrency run completed without errors. TypeScript check and backend build passed. No live data connection was made.

Phase B must separately settle the session/market-regime sampling plan, post-session capture horizon, delayed Massive snapshot retrieval/retention contract, frozen daily baseline artifacts, revision comparison policy and treatment of ambiguous/gapped/censored runs. Reserved reference boundary: `reference/massive/<fetch-id>/`; nothing writes it in Phase A. Current JSON reports are regenerable derived artifacts. Massive comparison, classifier calculations and production acceptance remain unimplemented. Whether a durable-availability ledger is needed must be decided from disk/receipt measurement requirements. No production cutoff or provider acceptance is selected here.
