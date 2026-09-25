import { advanceIntradayStress, marketRawState, measureIntradaySession, INTRADAY_STRESS_SEVERITY, type IntradayStressState, type IntradayStressHistory } from '../../services/intraday-stress-calculation.js';
import { researchCalendar } from '../intraday-stress-calendar.js';
import { analyze, distribution } from './analyze.js';
import type { Baseline } from './baseline.js';
import type { loadRun } from './cli.js';
import { hash, SYMBOLS, type Values, type Observation } from './model.js';
import { replay, windows } from './replay.js';
import type { Reference, ReferenceBar } from './reference.js';
import type { SessionPlan } from './session.js';

const fields = ['open', 'high', 'low', 'close', 'volume'] as const;
export function difference(actual: Values, reference: Values) {
  return { exact: fields.every(k => actual[k] === reference[k]),
    ohlc: Object.fromEntries(fields.filter(k => k !== 'volume').map(k => [k, { signed: actual[k] - reference[k], absolute: Math.abs(actual[k] - reference[k]), bps: reference[k] ? (actual[k] / reference[k] - 1) * 10000 : null }])),
    volumeDifference: actual.volume - reference.volume, volumeRatio: reference.volume ? actual.volume / reference.volume : null };
}
export type MinuteLabel = 'CAPTURED' | 'PROVIDER_NO_BAR' | 'CAPTURE_GAP' | 'REFERENCE_UNAVAILABLE';
export function missingLabel(captured: boolean, reference: Reference | null, symbol: string, startAt: string): MinuteLabel {
  if (captured) return 'CAPTURED';
  if (!reference?.complete || reference.provider !== 'ALPACA' || reference.feed !== 'IEX' || startAt < reference.range.startAt || Date.parse(startAt) + 60000 > Date.parse(reference.range.endAt)) return 'REFERENCE_UNAVAILABLE';
  return reference.minutes.some(b => b.symbol === symbol && b.startAt === startAt) ? 'CAPTURE_GAP' : 'PROVIDER_NO_BAR';
}
export function reconstruct(observations: Observation[], plan: SessionPlan, reference: Reference | null, cutoff: string) {
  const states = replay(observations, cutoff);
  return windows(states, plan).map(strict => {
    const omitted: string[] = [], blocked: { startAt: string; reason: string }[] = [], present: Observation[] = [];
    for (let i = 0; i < 15; i++) {
      const startAt = new Date(Date.parse(strict.startAt) + i * 60000).toISOString();
      const state = states.get(`${strict.symbol}/${startAt}`);
      if (state) { if (state.ambiguous) blocked.push({ startAt, reason: 'AMBIGUOUS' }); present.push(state.selected); }
      else {
        const label = missingLabel(false, reference, strict.symbol, startAt);
        const existsLater = observations.some(o => o.symbol === strict.symbol && o.minuteStartAt === startAt);
        if (label === 'PROVIDER_NO_BAR' && !existsLater) omitted.push(startAt);
        else blocked.push({ startAt, reason: existsLater ? 'NOT_CAPTURED_AT_CUTOFF' : label });
      }
    }
    const aggregate: Values | null = blocked.length || !present.length ? null : { open: present[0]!.open, high: Math.max(...present.map(b => b.high)),
      low: Math.min(...present.map(b => b.low)), close: present.at(-1)!.close, volume: present.reduce((n, b) => n + b.volume, 0) };
    if (aggregate && !Number.isSafeInteger(aggregate.volume)) throw new Error('Unsafe aggregate volume');
    const official = reference?.bars.find(b => b.symbol === strict.symbol && b.startAt === strict.startAt);
    const validation = aggregate && official ? difference(aggregate, official) : null;
    return { symbol: strict.symbol, startAt: strict.startAt, targetAt: strict.targetAt, mode: 'PROVIDER_SPARSE',
      strict: { mode: 'STRICT_15_OF_15', ...strict }, aggregate, omittedProviderNoBarMinutes: omitted, blocked,
      capturedUpdateCount: present.reduce((n, b) => n + (states.get(`${b.symbol}/${b.minuteStartAt}`)?.observations.filter(o => o.messageType === 'u').length ?? 0), 0),
      officialAbsent: !official, officialComparison: validation,
      // Conservative research validation: exact OHLCV; report every discrepancy, do not invent a tolerance.
      validated: !!validation?.exact, constituents: present.map(b => ({ ordinal: b.ordinal, receivedAt: b.receivedAt, payloadHash: b.payloadHash })) };
  });
}
export function categories(iex: IntradayStressState | null, massive: IntradayStressState | null) {
  if (iex === null || massive === null) return { categories: [...(iex === null ? ['UNCOMPARABLE_IEX'] : []), ...(massive === null ? ['UNCOMPARABLE_MASSIVE'] : [])], highestRiskFalseNegative: false };
  const a = INTRADAY_STRESS_SEVERITY[iex], b = INTRADAY_STRESS_SEVERITY[massive], distance = Math.abs(a - b);
  return { categories: [distance === 0 ? 'EXACT_STATE_AGREEMENT' : distance === 1 ? 'ADJACENT_STATE_DISAGREEMENT' : 'MULTI_LEVEL_DISAGREEMENT',
    ...(a < b ? ['IEX_FALSE_NEGATIVE_CANDIDATE'] : a > b ? ['IEX_FALSE_POSITIVE_CANDIDATE'] : [])],
    highestRiskFalseNegative: (b >= 2 && a === 0) || (b === 3 && a <= 1) };
}
/** Also usable for historical source fidelity; carries no claim about live availability. */
export function measurements(plan: SessionPlan, bars: ReferenceBar[], baseline: Baseline) {
  if (baseline.sessionDate !== plan.date || baseline.calendarHash !== plan.calendarHash) throw new Error('Baseline session mismatch');
  return SYMBOLS.map(symbol => measureIntradaySession(plan.date, bars.filter(b => b.symbol === symbol).map(b => ({ ...b, barStartAtMs: Date.parse(b.startAt) })), baseline.priorAtr14Pct[symbol], researchCalendar([])));
}
export function stateComparison(iex: ReturnType<typeof measurements>, massive: ReturnType<typeof measurements>, targets: string[]) {
  const histories: IntradayStressHistory[] = [{ effectiveState: null, confirmation: 0 }, { effectiveState: null, confirmation: 0 }];
  return targets.map(targetAt => {
    const sides = [iex, massive].map((source, i) => {
      const spy = source[0]!.find(t => t.targetAt === targetAt)!, rsp = source[1]!.find(t => t.targetAt === targetAt)!;
      const raw = spy.instrumentRawState && rsp.instrumentRawState ? marketRawState(spy.instrumentRawState, rsp.instrumentRawState) : null;
      const transition = advanceIntradayStress(histories[i]!, raw);
      histories[i] = { effectiveState: transition.effectiveState, confirmation: transition.confirmationAfter };
      return { spy, rsp, raw, effective: transition.effectiveState, transition };
    });
    const a = sides[0]!, b = sides[1]!;
    return { targetAt, iex: a, massive: b, rawComparison: categories(a.raw, b.raw),
      effectiveComparison: categories(a.raw === null ? null : a.effective, b.raw === null ? null : b.effective),
      hysteresisOnlyDisagreement: a.raw !== null && a.raw === b.raw && a.effective !== b.effective,
      componentDifferences: Object.fromEntries(['spy', 'rsp'].map(symbol => {
        const left = a[symbol as 'spy' | 'rsp'], right = b[symbol as 'spy' | 'rsp'];
        return [symbol, Object.fromEntries(['shockAtrRatio', 'realizedMovement60AtrRatio', 'sessionDrawdownAtrRatio', 'acuteCloseDownsideAtrRatio'].map(key => {
          const x = left[key as 'shockAtrRatio'], y = right[key as 'shockAtrRatio']; return [key, x === null || y === null ? null : x - y];
        }))];
      })) };
  });
}
export function revisionComparison(snapshots: Reference[]) {
  const sorted = [...snapshots].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  return sorted.slice(1).map((later, i) => {
    const first = sorted[i]!;
    const keys = new Set([...first.bars, ...later.bars].map(b => `${b.symbol}/${b.startAt}`));
    return { firstFetchId: first.fetchId, laterFetchId: later.fetchId, elapsedMs: Date.parse(later.fetchedAt) - Date.parse(first.fetchedAt),
      intervals: [...keys].map(key => { const a = first.bars.find(b => `${b.symbol}/${b.startAt}` === key), b = later.bars.find(b => `${b.symbol}/${b.startAt}` === key);
        return { key, firstObserved: a ?? null, laterObserved: b ?? null, comparison: a && b ? difference(b, a) : null,
          changedOHLC: !!a && !!b && fields.slice(0, 4).some(k => a[k] !== b[k]), changedVolume: !!a && !!b && a.volume !== b.volume }; }) };
  });
}
export function compareRun(run: Awaited<ReturnType<typeof loadRun>>, alpaca: Reference, massive: Reference, baseline: Baseline, snapshots: Reference[], alpacaSnapshots: Reference[] = [alpaca]) {
  const { identity, observations, events, end } = run, plan = identity.session;
  for (const ref of [alpaca, massive, ...snapshots, ...alpacaSnapshots]) if (ref.runId !== identity.runId || ref.sessionDate !== plan.date) throw new Error('Reference run/session mismatch');
  if (alpaca.provider !== 'ALPACA' || alpaca.feed !== 'IEX' || massive.provider !== 'MASSIVE') throw new Error('Reference provider mismatch');
  const phaseA = analyze(identity, observations, events, end);
  const horizonStart = Math.max(Date.parse(plan.openAt), Math.ceil(Date.parse(identity.startedAt) / 60000) * 60000);
  const horizonEnd = Math.min(Date.parse(plan.closeAt), Math.floor(Date.parse(end) / 60000) * 60000);
  const states = replay(observations, end);
  const minuteRows = SYMBOLS.flatMap(symbol => Array.from({ length: Math.max(0, (horizonEnd - horizonStart) / 60000) }, (_, i) => {
    const startAt = new Date(horizonStart + i * 60000).toISOString(), state = states.get(`${symbol}/${startAt}`);
    const ref = alpaca.minutes.find(b => b.symbol === symbol && b.startAt === startAt);
    const first = state?.observations.find(o => o.messageType === 'b');
    return { symbol, startAt, classification: missingLabel(!!state, alpaca, symbol, startAt), historicalAbsent: !ref,
      selectedComparison: ref && state ? difference(state.selected, ref) : null,
      initialComparison: ref && first ? difference(first, ref) : null,
      updateConverged: !!ref && !!state && !!first && !difference(first, ref).exact && difference(state.selected, ref).exact,
      historicalDiffersFromAllVersions: !!ref && !!state && state.observations.every(o => !difference(o, ref).exact) };
  }));
  const hindsight = reconstruct(observations, plan, alpaca, end).filter(w => Date.parse(w.targetAt) <= horizonEnd);
  const initials = reconstruct(observations.filter(o => o.messageType === 'b'), plan, alpaca, end);
  const toBars = (rows: ReturnType<typeof reconstruct>) => rows.filter(w => w.validated && w.aggregate).map(w => ({ symbol: w.symbol, startAt: w.startAt, ...w.aggregate! }));
  const targets = hindsight.filter(w => w.symbol === 'SPY' && w.targetAt < plan.closeAt).map(w => w.targetAt);
  const massiveMeasurements = measurements(plan, massive.bars, baseline);
  const classification = stateComparison(measurements(plan, toBars(hindsight), baseline), massiveMeasurements, targets);
  const cutoffs = [30, 60, 90, 120, 300].map(seconds => {
    const rows = targets.map(targetAt => {
      const at = new Date(Date.parse(targetAt) + seconds * 1000).toISOString(), censored = at > end;
      const reconstructed = reconstruct(observations, plan, alpaca, censored ? end : at).filter(w => w.targetAt <= targetAt);
      return { targetAt, at, censored, windows: reconstructed.filter(w => w.targetAt === targetAt), measured: measurements(plan, censored ? [] : toBars(reconstructed), baseline) };
    });
    // Each target retains its own time-of-knowledge measurement; later corrections never rewrite earlier decisions.
    const iex = SYMBOLS.map((_, i) => rows.map(row => row.measured[i]!.find(t => t.targetAt === row.targetAt)!));
    return { seconds, uncensoredScheduledWindows: rows.filter(r => !r.censored).length * 2,
      uncensoredCompleteWindows: rows.filter(r => !r.censored).flatMap(r => r.windows).filter(w => w.validated).length,
      perSymbol: Object.fromEntries(SYMBOLS.map(symbol => { const scheduled = rows.filter(r => !r.censored).length;
        const complete = rows.filter(r => !r.censored).flatMap(r => r.windows).filter(w => w.symbol === symbol && w.validated).length;
        return [symbol, { scheduled, complete, completePct: scheduled ? complete / scheduled * 100 : null }]; })),
      paired: { scheduled: rows.filter(r => !r.censored).length,
        complete: rows.filter(r => !r.censored && r.windows.length === 2 && r.windows.every(w => w.validated)).length },
      snapshots: rows.map(({ measured: _measured, ...row }) => row), classification: stateComparison(iex, massiveMeasurements, targets) };
  });
  const prices = hindsight.map(w => { const b = massive.bars.find(b => b.symbol === w.symbol && b.startAt === w.startAt);
    return { symbol: w.symbol, targetAt: w.targetAt, validatedIex: w.validated, comparison: b && w.aggregate ? difference(w.aggregate, b) : null }; });
  const counts = (rows: typeof classification) => Object.fromEntries([...new Set(rows.flatMap(r => r.rawComparison.categories))].map(c => [c, rows.filter(r => r.rawComparison.categories.includes(c)).length]));
  return { version: 1, authority: 'RESEARCH_ONLY', evidenceClass: 'LIVE_CAPTURE_WITH_HINDSIGHT_REFERENCE_LABELS',
    providers: [{ provider: 'ALPACA', feed: 'IEX' }, { provider: 'MASSIVE' }], captureIntegrity: { ...phaseA, crashArtifacts: run.crashArtifacts, cleanShutdown: events.at(-1)?.type === 'shutdown_complete' },
    baseline, baselineHash: hash(baseline), reference: { alpaca, massive },
    minuteRows, minuteSummary: Object.fromEntries(SYMBOLS.map(s => [s, Object.fromEntries(['CAPTURED', 'PROVIDER_NO_BAR', 'CAPTURE_GAP', 'REFERENCE_UNAVAILABLE'].map(c => [c, minuteRows.filter(r => r.symbol === s && r.classification === c).length]))])),
    hindsight: hindsight.map(w => ({ ...w, equalityRequiredUpdates: w.validated && !initials.find(i => i.symbol === w.symbol && i.startAt === w.startAt)?.validated })),
    liveAsOf: cutoffs, referenceStability: revisionComparison(snapshots),
    alpacaReferenceStability: { fifteenMinute: revisionComparison(alpacaSnapshots), minute: revisionComparison(alpacaSnapshots.map(r => ({ ...r, bars: r.minutes }))) }, prices,
    priceSummary: Object.fromEntries(SYMBOLS.map(s => [s, Object.fromEntries(fields.slice(0, 4).map(k => [k, distribution(prices.filter(p => p.symbol === s).flatMap(p => p.comparison?.ohlc[k]?.bps == null ? [] : [p.comparison.ohlc[k]!.bps!]))]))])),
    classification, classificationCounts: counts(classification),
    rawConfusionMatrix: Object.fromEntries(classification.filter(r => r.iex.raw && r.massive.raw).map(r => `${r.iex.raw}/${r.massive.raw}`).filter((v, i, a) => a.indexOf(v) === i).map(k => [k, classification.filter(r => `${r.iex.raw}/${r.massive.raw}` === k).length])),
    limitations: ['IEX is one venue; volume is diagnostic, not a primary fidelity criterion.', 'Historical labels are hindsight and do not establish live knowledge of no-bar minutes.',
      'Massive snapshots are delayed reference evidence, never final truth.', 'Exact official OHLCV equality is a conservative research validation gate, not a production acceptance rule.',
      'Partial horizon and sparse adverse regimes cannot establish acceptance.', 'No production authority or cutoff is granted.'] };
}
export function markdownReport(report: ReturnType<typeof compareRun>) {
  return `# Phase B research comparison\n\nRun: ${report.captureIntegrity.manifest.runId}; session: ${report.captureIntegrity.manifest.session.date}.\n\nALPACA / IEX: ${report.reference.alpaca.fetchId}. MASSIVE: ${report.reference.massive.fetchId}.\n\nNo production authority.\n\n| Symbol | Captured | Provider no bar | Capture gap | Reference unavailable |\n|---|---:|---:|---:|---:|\n${SYMBOLS.map(s => `| ${s} | ${Object.values(report.minuteSummary[s]!).join(' | ')} |`).join('\n')}\n\nValidated hindsight windows: ${report.hindsight.filter(w => w.validated).length}/${report.hindsight.length}.\n\nRaw comparison: ${JSON.stringify(report.classificationCounts)}. Highest-risk false-negative candidates: ${report.classification.filter(r => r.rawComparison.highestRiskFalseNegative).length}.\n\n${report.liveAsOf.map(c => `- +${c.seconds}s: ${c.uncensoredCompleteWindows}/${c.uncensoredScheduledWindows} validated uncensored symbol windows.`).join('\n')}\n\nSee report.json for price errors, components, raw/effective replay, corrections, reference revisions and forensic negative latencies.\n\n${report.limitations.map(l => `- ${l}`).join('\n')}\n`;
}
