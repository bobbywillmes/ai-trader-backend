import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { advanceIntradayStress, marketRawState, measureIntradaySession, INTRADAY_STRESS_SEVERITY,
  type IntradayStressHistory, type IntradayStressState } from '../../services/intraday-stress-calculation.js';
import { researchCalendar } from '../intraday-stress-calendar.js';
import { readBaseline, type Baseline } from '../alpaca-iex/baseline.js';
import { loadRun } from '../alpaca-iex/cli.js';
import { distribution } from '../alpaca-iex/analyze.js';
import { hash, SYMBOLS, type Symbol } from '../alpaca-iex/model.js';
import { replay } from '../alpaca-iex/replay.js';
import { readReference, type Reference } from '../alpaca-iex/reference.js';
import type { SessionPlan } from '../alpaca-iex/session.js';
import { readExperiment, type Experiment } from './experiment.js';
import { exclusiveJson, loadProviderRun } from './journal.js';
import { PRODUCTS, type Observation, type Prices, type Product } from './model.js';

export type Source = { key: string; product: Product | 'ALPACA' | 'MASSIVE'; startedAt: string; end: string;
  observations: Observation[]; events: { type: string; at: string }[];
  alpaca?: Awaited<ReturnType<typeof loadRun>>; reference?: Reference };
export type Minute = Prices & { symbol: Symbol; startAt: string; firstSeenAt: string; usableAt: string | null;
  ambiguous: boolean; selectedOrdinals: number[]; hash: string; duplicateCount: number; revisionCount: number };
function providerTime(o: Observation): bigint {
  const raw = o.providerTimestamp;
  const fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(raw)?.[1] ?? '';
  return BigInt(Math.floor(Date.parse(raw) / 1000)) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}
function continuous(source: Source, start: string, end: string) {
  if (source.startedAt > start || source.end < end) return false;
  const relevant = source.events.filter(e => ['subscription_confirmed', 'socket_closed', 'transport_failure', 'reconnect_scheduled', 'shutdown_requested', 'terminal_error'].includes(e.type));
  return relevant.filter(e => e.at <= start).at(-1)?.type === 'subscription_confirmed'
    && !relevant.some(e => e.at > start && e.at < end && e.type !== 'subscription_confirmed');
}
export function minutesAt(source: Source, cutoff: string): Minute[] {
  const horizon = cutoff < source.end ? cutoff : source.end;
  if (source.alpaca) return [...replay(source.alpaca.observations, horizon).values()].map(s => ({ ...s.selected,
    startAt: s.minuteStartAt, firstSeenAt: s.observations[0]!.receivedAt,
    usableAt: s.ambiguous ? null : new Date(Math.max(Date.parse(s.minuteStartAt) + 60000, Date.parse(s.observations[0]!.receivedAt))).toISOString(),
    ambiguous: s.ambiguous, selectedOrdinals: [s.selected.ordinal], hash: s.selected.payloadHash,
    duplicateCount: s.duplicateCount, revisionCount: s.correctionCount }));
  const groups = new Map<string, Observation[]>();
  for (const o of source.observations) {
    if (o.receivedAt > horizon || (o.product !== 'TIINGO_WS' && o.values === null)) continue;
    const key = `${o.symbol}/${o.startAt}`, rows = groups.get(key) ?? []; rows.push(o); groups.set(key, rows);
  }
  return [...groups.values()].map(rows => {
    rows.sort((a, b) => a.ordinal - b.ordinal);
    const first = rows[0]!, end = new Date(Date.parse(first.startAt) + 60000).toISOString();
    let p: Prices, selected: Observation[], usableAt: string | null;
    if (source.product === 'TIINGO_WS') {
      selected = [...rows].sort((a, b) => providerTime(a) < providerTime(b) ? -1 : providerTime(a) > providerTime(b) ? 1 : a.ordinal - b.ordinal);
      p = { open: selected[0]!.price!, high: Math.max(...selected.map(o => o.price!)), low: Math.min(...selected.map(o => o.price!)), close: selected.at(-1)!.price!, volume: null };
      usableAt = continuous(source, first.startAt, end) && horizon >= end ? (first.receivedAt > end ? first.receivedAt : end) : null;
    } else {
      // A snapshot requested before minute end is diagnostic partial evidence, never a completed bar.
      const closed = rows.filter(o => o.requestedAt !== null && o.requestedAt >= end);
      selected = [closed.at(-1) ?? rows.at(-1)!]; p = selected[0]!.values!; usableAt = closed[0]?.receivedAt ?? null;
    }
    return { ...p, symbol: first.symbol, startAt: first.startAt, firstSeenAt: first.receivedAt, usableAt,
      ambiguous: false, selectedOrdinals: selected.map(o => o.ordinal), hash: hash({ p, constituents: selected.map(o => o.payloadHash) }),
      duplicateCount: rows.filter(o => o.duplicate).length,
      revisionCount: source.product === 'TIINGO_WS' ? 0 : rows.filter(o => !o.duplicate).length - 1 };
  });
}
export type Window = { symbol: Symbol; startAt: string; targetAt: string; actionable: boolean; missingMinutes: string[];
  unusableMinutes: string[]; values: Prices | null; usableAt: string | null; constituentHashes: string[] };
export function windowsAt(source: Source, plan: SessionPlan, cutoff: string): Window[] {
  const minutes = new Map(minutesAt(source, cutoff).map(m => [`${m.symbol}/${m.startAt}`, m]));
  const output: Window[] = [];
  for (const symbol of SYMBOLS) for (let t = Date.parse(plan.openAt); t < Date.parse(plan.closeAt); t += 900000) {
    const startAt = new Date(t).toISOString(), targetAt = new Date(t + 900000).toISOString();
    if (source.reference) {
      const bar = source.reference.bars.find(b => b.symbol === symbol && b.startAt === startAt);
      const available = source.reference.fetchedAt <= cutoff && targetAt <= cutoff;
      output.push({ symbol, startAt, targetAt, actionable: targetAt < plan.closeAt, missingMinutes: [], unusableMinutes: [],
        values: bar && available ? bar : null, usableAt: bar && available ? source.reference.fetchedAt : null,
        constituentHashes: bar ? [hash(bar)] : [] }); continue;
    }
    const expected = Array.from({ length: 15 }, (_, i) => new Date(t + i * 60000).toISOString());
    const rows = expected.map(at => minutes.get(`${symbol}/${at}`));
    const missingMinutes = expected.filter((_, i) => !rows[i]);
    const unusableMinutes = expected.filter((_, i) => rows[i] && (rows[i]!.ambiguous || !rows[i]!.usableAt || rows[i]!.usableAt! > cutoff));
    const usable = !missingMinutes.length && !unusableMinutes.length && targetAt <= cutoff && targetAt <= source.end;
    const volume = usable && rows.every(m => m!.volume !== null) ? rows.reduce((n, m) => n + m!.volume!, 0) : null;
    if (volume !== null && (!Number.isFinite(volume) || volume > Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe aggregate volume');
    output.push({ symbol, startAt, targetAt, actionable: targetAt < plan.closeAt, missingMinutes, unusableMinutes,
      values: usable ? { open: rows[0]!.open, high: Math.max(...rows.map(m => m!.high)), low: Math.min(...rows.map(m => m!.low)), close: rows[14]!.close,
        volume } : null,
      usableAt: usable ? rows.map(m => m!.usableAt!).sort().at(-1)! : null,
      constituentHashes: rows.flatMap(m => m ? [m.hash] : []) });
  }
  return output;
}
/** Numeric zero exists only inside this price-only adapter, never as claimed provider evidence. */
export function measure(plan: SessionPlan, windows: Window[], baseline: Baseline | null) {
  if (baseline && (baseline.sessionDate !== plan.date || baseline.calendarHash !== plan.calendarHash)) throw new Error('Shared baseline mismatch');
  return SYMBOLS.map(symbol => {
    const rows = windows.filter(w => w.symbol === symbol && w.values);
    return measureIntradaySession(plan.date, rows.map(w => ({ ...w.values!, volume: w.values!.volume ?? 0, barStartAtMs: Date.parse(w.startAt) })),
      baseline?.priorAtr14Pct[symbol] ?? null, researchCalendar([])).map(t => {
      const w = rows.find(w => w.targetAt === t.targetAt);
      return { ...t, interval: { ...t.interval, volume: w?.values?.volume ?? null },
        volumeAdapter: w?.values?.volume === null ? 'PRICE_ONLY_NUMERIC_PLACEHOLDER_V1_VOLUME_INVARIANCE_TESTED' : null };
    });
  });
}
function classification(measured: ReturnType<typeof measure>, targetAt: string, history: IntradayStressHistory) {
  const spy = measured[0]!.find(t => t.targetAt === targetAt)!, rsp = measured[1]!.find(t => t.targetAt === targetAt)!;
  const raw = spy.instrumentRawState && rsp.instrumentRawState ? marketRawState(spy.instrumentRawState, rsp.instrumentRawState) : null;
  const transition = advanceIntradayStress(history, raw);
  return { spy, rsp, raw, effective: transition.effectiveState, transition };
}
export function agreement(left: IntradayStressState | null, right: IntradayStressState | null) {
  if (left === null || right === null) return { category: 'UNCOMPARABLE', highRiskFalseNegativeCandidate: false };
  const a = INTRADAY_STRESS_SEVERITY[left], b = INTRADAY_STRESS_SEVERITY[right], distance = Math.abs(a - b);
  return { category: distance === 0 ? 'EXACT_STATE_AGREEMENT' : distance === 1 ? 'ADJACENT_DISAGREEMENT' : 'MULTI_LEVEL_DISAGREEMENT',
    highRiskFalseNegativeCandidate: (b >= 2 && a === 0) || (b === 3 && a <= 1) };
}
export function priceDifference(a: Prices, b: Prices) {
  return Object.fromEntries((['open', 'high', 'low', 'close'] as const).map(k => [k, { signed: a[k] - b[k], absolute: Math.abs(a[k] - b[k]), bps: b[k] ? (a[k] / b[k] - 1) * 10000 : null }]));
}
export function compareSources(experiment: Experiment, sources: Source[], baseline: Baseline | null) {
  const plan = experiment.session;
  if ((baseline ? hash(baseline) : null) !== experiment.baselineHash) throw new Error('Baseline identity mismatch');
  const reports = sources.map(source => {
    const finalWindows = windowsAt(source, plan, source.end), finalMeasurements = measure(plan, finalWindows, baseline);
    const minutes = minutesAt(source, source.end).filter(m => m.startAt >= plan.openAt && m.startAt < plan.closeAt);
    const finalHistory: IntradayStressHistory = { effectiveState: null, confirmation: 0 };
    const targets = finalMeasurements[0]!.map(t => t.targetAt);
    const final = targets.map(targetAt => {
      const row = classification(finalMeasurements, targetAt, finalHistory);
      finalHistory.effectiveState = row.effective; finalHistory.confirmation = row.transition.confirmationAfter;
      return { targetAt, ...row };
    });
    const firstUsable = targets.map(targetAt => {
      const prefix = finalWindows.filter(w => w.targetAt <= targetAt);
      let at = prefix.every(w => w.usableAt) ? prefix.map(w => w.usableAt!).sort().at(-1)! : null;
      // Later sticky IEX ambiguity must not erase an earlier usable prefix.
      if (source.alpaca) {
        const firsts = SYMBOLS.flatMap(symbol => Array.from({ length: (Date.parse(targetAt) - Date.parse(plan.openAt)) / 60000 }, (_, i) => {
          const minute = new Date(Date.parse(plan.openAt) + i * 60000).toISOString();
          return source.alpaca!.observations.find(o => o.symbol === symbol && o.minuteStartAt === minute)?.receivedAt ?? null;
        }));
        at = firsts.every(t => t !== null) ? [targetAt, ...firsts as string[]].sort().at(-1)! : null;
      }
      // Recalculate at the first availability bound, never reuse final/corrected prices.
      const snapshot = at ? windowsAt(source, plan, at).filter(w => w.targetAt <= targetAt) : [];
      if (snapshot.some(w => !w.values)) at = null;
      const measured = at ? measure(plan, snapshot, baseline) : null;
      const row = measured ? classification(measured, targetAt, { effectiveState: null, confirmation: 0 }) : null;
      return { targetAt, evidenceFirstUsableAt: at, classifierFirstUsableAt: row?.raw ? at : null, firstRaw: row?.raw ?? null,
        measurements: row ? { spy: row.spy, rsp: row.rsp } : null };
    });
    const asOf = [30, 60, 90, 120, 300].map(seconds => {
      const history: IntradayStressHistory = { effectiveState: null, confirmation: 0 };
      return { seconds, targets: targets.map(targetAt => {
        const at = new Date(Date.parse(targetAt) + seconds * 1000).toISOString(), censored = at > source.end;
        const snapshot = windowsAt(source, plan, censored ? source.end : at).filter(w => w.targetAt <= targetAt);
        const row = classification(measure(plan, censored ? [] : snapshot, baseline), targetAt, history);
        history.effectiveState = row.effective; history.confirmation = row.transition.confirmationAfter;
        return { targetAt, at, censored, ...row };
      }) };
    });
    const expected = (Date.parse(plan.closeAt) - Date.parse(plan.openAt)) / 60000;
    const minuteCompleteness = Object.fromEntries(SYMBOLS.map(symbol => {
      const selected = minutes.filter(m => m.symbol === symbol);
      const missing = Array.from({ length: expected }, (_, i) => new Date(Date.parse(plan.openAt) + i * 60000).toISOString()).filter(at => !selected.some(m => m.startAt === at));
      const elapsedStart = Math.max(Date.parse(plan.openAt), Math.ceil(Date.parse(source.startedAt) / 60000) * 60000);
      const elapsedEnd = Math.min(Date.parse(plan.closeAt), Math.floor(Date.parse(source.end) / 60000) * 60000);
      return [symbol, { expected: source.reference ? null : expected, captured: source.reference ? null : selected.length, missingMinutes: source.reference ? null : missing,
        elapsedExpected: source.reference ? null : Math.max(0, (elapsedEnd - elapsedStart) / 60000),
        elapsedCaptured: source.reference ? null : selected.filter(m => Date.parse(m.startAt) >= elapsedStart && Date.parse(m.startAt) < elapsedEnd).length,
        completeWindows: finalWindows.filter(w => w.symbol === symbol && w.values).length,
        duplicates: selected.reduce((n, m) => n + m.duplicateCount, 0), revisions: selected.reduce((n, m) => n + m.revisionCount, 0),
        firstSeenLatencyMs: distribution(selected.map(m => Date.parse(m.firstSeenAt) - Date.parse(m.startAt) - 60000)),
        availabilityLatencyMs: distribution(selected.flatMap(m => m.usableAt ? [Date.parse(m.usableAt) - Date.parse(m.startAt) - 60000] : [])) }];
    }));
    return { key: source.key, provenance: source.product in PRODUCTS ? PRODUCTS[source.product as Product] : { provider: source.product, feed: source.product === 'ALPACA' ? 'IEX' : 'DELAYED_REFERENCE', sourceKind: 'PROVIDER_BAR' },
      minuteConstruction: source.product === 'TIINGO_WS' ? 'LOCAL_OHLC_FROM_DERIVED_REFERENCE_EVENTS' : 'PROVIDER_PRODUCED_BARS',
      observationCount: source.alpaca?.observations.length ?? source.observations.length,
      unavailableBarObservations: source.observations.filter(o => o.unavailableValues !== undefined),
      horizon: source.end, clockUncertain: source.events.some(e => e.type === 'clock_jump'), minuteCompleteness, minutes, windows: finalWindows, final, asOf, firstUsable,
      eventCounts: Object.fromEntries([...new Set(source.events.map(e => e.type))].map(type => [type, source.events.filter(e => e.type === type).length])),
      events: source.events, observationHash: hash(source.alpaca?.observations ?? source.observations) };
  });
  const pairs = reports.flatMap(left => reports.filter(right => right.key !== left.key).map(right => {
    const compare = (a: typeof left.final, b: typeof right.final) => a.map(row => {
      const other = b.find(t => t.targetAt === row.targetAt)!;
      return { targetAt: row.targetAt, raw: agreement(row.raw, other.raw), effective: agreement(row.raw ? row.effective : null, other.raw ? other.effective : null),
        components: Object.fromEntries((['spy', 'rsp'] as const).map(s => [s, Object.fromEntries((['shockAtrRatio', 'realizedMovement60AtrRatio', 'sessionDrawdownAtrRatio', 'acuteCloseDownsideAtrRatio'] as const)
          .map(k => [k, row[s][k] === null || other[s][k] === null ? null : row[s][k]! - other[s][k]!]))])) };
    });
    const final = compare(left.final, right.final);
    return { left: left.key, right: right.key, final, counts: Object.fromEntries(['EXACT_STATE_AGREEMENT', 'ADJACENT_DISAGREEMENT', 'MULTI_LEVEL_DISAGREEMENT', 'UNCOMPARABLE'].map(c => [c, final.filter(r => r.raw.category === c).length])),
      highRiskFalseNegativeCandidates: final.filter(r => r.raw.highRiskFalseNegativeCandidate).map(r => r.targetAt),
      asOf: left.asOf.map((a, i) => ({ seconds: a.seconds, targets: compare(a.targets, right.asOf[i]!.targets) })),
      prices: left.windows.map(w => { const other = right.windows.find(r => r.symbol === w.symbol && r.startAt === w.startAt)!;
        return { symbol: w.symbol, targetAt: w.targetAt, comparison: w.values && other.values ? priceDifference(w.values, other.values) : null }; }),
      minutePrices: left.minutes.map(m => { const other = right.minutes.find(r => r.symbol === m.symbol && r.startAt === m.startAt);
        return { symbol: m.symbol, startAt: m.startAt, comparison: other ? priceDifference(m, other) : null }; }) };
  }));
  return { version: 1, authority: 'RESEARCH_ONLY', experiment, baselineHash: experiment.baselineHash,
    baselineStatus: baseline ? 'FROZEN_SHARED_PRIOR_SESSION_ATR' : 'UNAVAILABLE_SMOKE_ONLY', sources: reports, pairs,
    limitations: ['No provider is truth or accepted production authority.', 'Tiingo consolidated is beta and supplies derived reference prices, not executed trades.',
      'Tiingo threshold 6 only emits meaningful price changes; empty minutes stay missing. Full transport coverage is required for local bars.',
      'Twelve Data default live source coverage is limited; listed-symbol coverage is not consolidated venue coverage.',
      'Strict 15/15 and contiguous session prefix are required. No synthetic bars, forward fill or historical repair.',
      'First seen is not completed-bar availability; no provider finality guarantee. Tiingo local minute closure is a research clock boundary.',
      'Receipt availability is not fsync availability; clock-jump runs require review. Missing volume stays null outside the tested price-only adapter.',
      'Pairwise false-negative candidates are directional disagreements, never verified market ground truth.',
      'Final classifications are hindsight. As-of target cutoffs retain time-of-knowledge prices; censored targets are unavailable.',
      'A short mid-session smoke cannot validate full-session completeness or classifier readiness. Archive evidence before cleaning node_modules.'] };
}
export async function compareMain(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'massive-run-dir': { type: 'string' }, 'massive-fetch-id': { type: 'string' } } });
  if (positionals.length !== 1) throw new Error('Expected experiment directory');
  const directory = resolve(positionals[0]!), experiment = await readExperiment(directory);
  const baseline = experiment.baselineHash ? await readBaseline(directory) : null;
  const sources: Source[] = [], integrity: Record<string, unknown> = {};
  for (const provider of ['ALPACA', 'TIINGO', 'TWELVE_DATA'] as const) {
    const runDir = join(directory, experiment.runs[provider]);
    try { await readFile(join(runDir, 'manifest.json')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { integrity[provider] = { missingRun: true }; continue; } throw e; }
    if (provider === 'ALPACA') {
      const run = await loadRun(runDir), link = JSON.parse(await readFile(join(runDir, 'experiment-link.json'), 'utf8'));
      if (run.identity.runId !== experiment.runs[provider] || hash(run.identity.session) !== hash(experiment.session)
        || link.experimentId !== experiment.experimentId || link.baselineHash !== experiment.baselineHash || run.identity.gitCommit !== experiment.gitCommit) throw new Error('Alpaca linkage mismatch');
      sources.push({ key: 'ALPACA_IEX', product: 'ALPACA', startedAt: run.identity.startedAt, end: run.end, observations: [], events: run.events, alpaca: run });
      integrity[provider] = { cleanShutdown: run.events.at(-1)?.type === 'shutdown_complete', crashArtifacts: run.crashArtifacts };
    } else {
      const run = await loadProviderRun(runDir);
      if (run.manifest.experimentId !== experiment.experimentId || run.manifest.runId !== experiment.runs[provider] || run.manifest.provider !== provider
        || run.manifest.baselineHash !== experiment.baselineHash || hash(run.manifest.session) !== hash(experiment.session) || run.manifest.gitCommit !== experiment.gitCommit) throw new Error('Provider linkage mismatch');
      for (const product of provider === 'TIINGO' ? ['TIINGO_WS', 'TIINGO_REST'] as const : ['TWELVE_DATA'] as const)
        sources.push({ key: product, product, startedAt: run.manifest.startedAt, end: run.end, observations: run.observations.filter(o => o.product === product), events: run.events });
      integrity[provider] = { cleanShutdown: run.cleanShutdown, truncatedFinalLine: run.truncatedFinalLine, journalHash: run.journalHash };
    }
  }
  if (values['massive-run-dir'] || values['massive-fetch-id']) {
    if (!values['massive-run-dir'] || !values['massive-fetch-id']) throw new Error('Both Massive reference arguments required');
    const reference = await readReference(resolve(values['massive-run-dir']), 'MASSIVE', values['massive-fetch-id']);
    if (reference.sessionDate !== experiment.session.date) throw new Error('Reference session mismatch');
    sources.push({ key: 'MASSIVE_DELAYED_REFERENCE', product: 'MASSIVE', startedAt: experiment.session.openAt, end: reference.fetchedAt,
      observations: [], events: [], reference });
  }
  const transportReadiness = ['ALPACA_IEX', 'TIINGO_WS', 'TIINGO_REST', 'TWELVE_DATA'].map(key => {
    const s = sources.find(s => s.key === key);
    const records = s?.alpaca?.observations ?? s?.observations ?? [];
    const missingSymbols = SYMBOLS.filter(symbol => !records.some(o => o.symbol === symbol && ('messageType' in o || o.price !== null || o.values !== null)));
    const provider = key === 'ALPACA_IEX' ? 'ALPACA' : key.startsWith('TIINGO') ? 'TIINGO' : 'TWELVE_DATA';
    const clean = (integrity[provider] as { cleanShutdown?: boolean } | undefined)?.cleanShutdown === true;
    const acknowledged = !!s?.events.some(e => e.type === (key === 'ALPACA_IEX' || key === 'TIINGO_WS' ? 'subscription_confirmed' : 'poll_success'));
    const problems = s?.events.filter(e => ['auth_failure', 'terminal_error', 'malformed', 'malformed_frame', 'clock_jump', 'rate_limited'].includes(e.type)).map(e => e.type) ?? [];
    return { source: key, acknowledged, missingSymbols, cleanShutdown: clean, problems: [...new Set(problems)], ready: acknowledged && !missingSymbols.length && clean && !problems.length };
  });
  const report = { ...compareSources(experiment, sources, baseline), integrity, smokeReadiness: { transportChecks: transportReadiness,
    transportReady: transportReadiness.every(r => r.ready), fullSessionBaselineReady: !!baseline,
    note: 'Transport readiness is not full-session coverage, source acceptance, or a baseline for a different session date.' } };
  const output = join(directory, 'derived', randomUUID()); await mkdir(output, { recursive: true });
  await exclusiveJson(join(output, 'report.json'), report);
  const summary = ['# Research provider comparison', '', `Session: ${experiment.session.date}. Experiment: ${experiment.experimentId}.`,
    'No production authority. RSP coverage is a primary diagnostic.', '', '| Source | Symbol | Captured / expected minutes | Complete 15m windows | Revisions |', '|---|---|---:|---:|---:|',
    ...report.sources.flatMap(s => ['RSP', 'SPY'].map(symbol => { const m = s.minuteCompleteness[symbol]!; return `| ${s.key} | ${symbol} | ${m.captured ?? 'N/A'} / ${m.expected ?? 'N/A'} | ${m.completeWindows} | ${m.revisions} |`; })), '',
    `Baseline: ${report.baselineStatus}.`, `Smoke readiness: ${JSON.stringify(report.smokeReadiness)}.`, `Integrity: ${JSON.stringify(integrity)}.`, '',
    ...report.pairs.map(p => `${p.left} vs ${p.right}: ${JSON.stringify(p.counts)}; high-risk candidates: ${p.highRiskFalseNegativeCandidates.length}.`), '',
    ...report.limitations.map(l => `- ${l}`)].join('\n');
  await writeFile(join(output, 'summary.md'), summary + '\n', { flag: 'wx' });
  process.stdout.write(output + '\n');
}
