import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { distribution } from '../alpaca-iex/analyze.js';
import { readBaseline } from '../alpaca-iex/baseline.js';
import { hash, SYMBOLS } from '../alpaca-iex/model.js';
import { advanceIntradayStress, INTRADAY_STRESS_SEVERITY, marketRawState, type IntradayStressHistory } from '../../services/intraday-stress-calculation.js';
import { agreement, measure, minutesAt, priceDifference, windowsAt, type Source } from './compare.js';
import { readExperiment } from './experiment.js';
import { exclusiveJson, loadProviderRun } from './journal.js';
import type { Observation, Prices } from './model.js';

const fields = ['open', 'high', 'low', 'close', 'volume'] as const;
const components = ['shockAtrRatio', 'realizedMovement60AtrRatio', 'sessionDrawdownAtrRatio', 'acuteCloseDownsideAtrRatio'] as const;
type Field = typeof fields[number];
type Kind = 'DUPLICATE' | 'PRE_CLOSE_EVOLUTION' | 'FIRST_COMPLETED_VERSION' | 'POST_CLOSE_REVISION' | 'UNAVAILABLE_VERSION';
type Delta = { signed: number; absolute: number; bps?: number | null; percent?: number | null };
function diff(a: Prices, b: Prices) {
  return Object.fromEntries(fields.map(k => {
    const x = a[k], y = b[k];
    return [k, x === y ? null : x === null || y === null ? { before: x, after: y } : {
      before: x, after: y, signed: y - x, absolute: Math.abs(y - x),
      ...(k === 'volume' ? { percent: x === 0 ? null : (y / x - 1) * 100 } : { bps: x === 0 ? null : (y / x - 1) * 10000 })
    }];
  })) as Record<Field, (Delta & { before: number; after: number }) | { before: number | null; after: number | null } | null>;
}
export function chain(rows: Observation[]) {
  const versions = [...rows].sort((a, b) => a.ordinal - b.ordinal);
  const endAt = new Date(Date.parse(versions[0]!.startAt) + 60000).toISOString();
  const completed = versions.filter(v => v.requestedAt !== null && v.requestedAt >= endAt && v.values !== null);
  const firstCompleted: Observation | null = completed[0] ?? null, previousCompleted: Observation | null = completed.at(-1) ?? null;
  const transitions = versions.map((observation, i) => {
    const previous = versions[i - 1] ?? null;
    const priorCompleted = versions.slice(0, i).filter(v => v.requestedAt && v.requestedAt >= endAt && v.values).at(-1);
    const comparison = observation.requestedAt && observation.requestedAt >= endAt && priorCompleted ? priorCompleted : previous;
    const changes = comparison?.values && observation.values ? diff(comparison.values, observation.values) : null;
    const changedFields = changes ? fields.filter(k => changes[k] !== null) : [];
    const isCompleted = observation.requestedAt !== null && observation.requestedAt >= endAt && observation.values !== null;
    let kind: Kind;
    if (observation.values === null) kind = 'UNAVAILABLE_VERSION';
    else if (observation === firstCompleted) kind = 'FIRST_COMPLETED_VERSION';
    else if (previous?.valueHash === observation.valueHash) kind = 'DUPLICATE';
    else if (!isCompleted) kind = 'PRE_CLOSE_EVOLUTION';
    else kind = 'POST_CLOSE_REVISION';
    return { ordinal: observation.ordinal, requestedAt: observation.requestedAt, receivedAt: observation.receivedAt,
      kind, changedFields, changes, previousCompletedOrdinal: kind === 'POST_CLOSE_REVISION' ? (versions.slice(0, i).filter(v => v.requestedAt && v.requestedAt >= endAt && v.values).at(-1)?.ordinal ?? null) : null };
  });
  const post = transitions.filter(t => t.kind === 'POST_CLOSE_REVISION');
  const lastDiffering = transitions.filter(t => t.kind === 'PRE_CLOSE_EVOLUTION' || t.kind === 'POST_CLOSE_REVISION').at(-1);
  const lag = (time: string | null, origin = endAt) => time === null ? null : Date.parse(time) - Date.parse(origin);
  return { symbol: versions[0]!.symbol, startAt: versions[0]!.startAt, endAt, versions,
    transitions, broadRevisionCount: Math.max(0, versions.filter(v => !v.duplicate && v.values).length - 1),
    firstCompleted, finalObserved: previousCompleted,
    firstFinalDifference: firstCompleted?.values && previousCompleted?.values ? diff(firstCompleted.values, previousCompleted.values) : null,
    timing: { firstReceivedAt: versions[0]!.receivedAt, firstCompletedRequestedAt: firstCompleted?.requestedAt ?? null,
      firstCompletedReceivedAt: firstCompleted?.receivedAt ?? null, firstCompletedRequestLagMs: lag(firstCompleted?.requestedAt ?? null),
      firstCompletedReceiptLagMs: lag(firstCompleted?.receivedAt ?? null), firstPostCloseRequestedAt: post.length ? post[0]!.requestedAt : null,
      firstPostCloseReceivedAt: post.length ? post[0]!.receivedAt : null, firstPostCloseRequestLagMs: lag(post[0]?.requestedAt ?? null),
      firstPostCloseReceiptLagMs: lag(post[0]?.receivedAt ?? null), lastPostCloseRequestLagMs: lag(post.at(-1)?.requestedAt ?? null),
      lastPostCloseReceiptLagMs: lag(post.at(-1)?.receivedAt ?? null),
      lastDifferingRequestedAt: lastDiffering?.requestedAt ?? null, lastDifferingReceivedAt: lastDiffering?.receivedAt ?? null,
      finalObservedRequestedAt: previousCompleted?.requestedAt ?? null, finalObservedReceivedAt: previousCompleted?.receivedAt ?? null,
      firstToFinalReceiptMs: firstCompleted && previousCompleted ? lag(previousCompleted.receivedAt, firstCompleted.receivedAt) : null } };
}
function classify(source: Source, experiment: Awaited<ReturnType<typeof readExperiment>>, baseline: Awaited<ReturnType<typeof readBaseline>>) {
  const windows = windowsAt(source, experiment.session, source.end), measured = measure(experiment.session, windows, baseline);
  const history: IntradayStressHistory = { effectiveState: null, confirmation: 0 };
  const targets = measured[0]!.map(spy => {
    const rsp = measured[1]!.find(r => r.targetAt === spy.targetAt)!;
    const raw = spy.instrumentRawState && rsp.instrumentRawState ? marketRawState(spy.instrumentRawState, rsp.instrumentRawState) : null;
    const transition = advanceIntradayStress(history, raw);
    history.effectiveState = transition.effectiveState; history.confirmation = transition.confirmationAfter;
    return { targetAt: spy.targetAt, spy, rsp, raw, effective: transition.effectiveState, transition };
  });
  return { windows, targets };
}
function totals(chains: ReturnType<typeof chain>[]) {
  const transitions = chains.flatMap(c => c.transitions);
  const post = transitions.filter(t => t.kind === 'POST_CLOSE_REVISION');
  const magnitudes = Object.fromEntries(fields.map(field => [field, Object.fromEntries(['PRE_CLOSE_EVOLUTION', 'FIRST_COMPLETED_VERSION', 'POST_CLOSE_REVISION'].map(kind =>
    [kind, distribution(transitions.filter(t => t.kind === kind).flatMap(t => {
      const d = t.changes?.[field]; return d && 'absolute' in d ? [field === 'volume' ? d.percent : d.bps].filter((x): x is number => x !== null && x !== undefined).map(Math.abs) : [];
    }))]))]));
  return { minutes: chains.length, broadRevisionCount: chains.reduce((n, c) => n + c.broadRevisionCount, 0),
    counts: Object.fromEntries((['DUPLICATE', 'PRE_CLOSE_EVOLUTION', 'FIRST_COMPLETED_VERSION', 'POST_CLOSE_REVISION', 'UNAVAILABLE_VERSION'] as Kind[]).map(k => [k, transitions.filter(t => t.kind === k).length])),
    changedFields: Object.fromEntries(fields.map(k => [k, post.filter(t => t.changedFields.includes(k)).length])),
    fieldCombinations: Object.fromEntries([...new Set(post.map(t => t.changedFields.join('+')))].map(k => [k, post.filter(t => t.changedFields.join('+') === k).length])),
    volumeOnly: post.filter(t => t.changedFields.length === 1 && t.changedFields[0] === 'volume').length,
    priceOnly: post.filter(t => t.changedFields.some(k => k !== 'volume') && !t.changedFields.includes('volume')).length,
    priceAndVolume: post.filter(t => t.changedFields.some(k => k !== 'volume') && t.changedFields.includes('volume')).length,
    priceAffecting: post.filter(t => t.changedFields.some(k => k !== 'volume')).length,
    magnitudes, volumeAbsoluteChange: distribution(post.flatMap(t => { const d = t.changes?.volume; return d && 'absolute' in d ? [d.absolute] : []; })),
    timing: Object.fromEntries(['firstCompletedRequestLagMs', 'firstCompletedReceiptLagMs', 'firstPostCloseRequestLagMs', 'firstPostCloseReceiptLagMs', 'lastPostCloseRequestLagMs', 'lastPostCloseReceiptLagMs', 'firstToFinalReceiptMs'].map(k =>
      [k, distribution(chains.flatMap(c => { const v = c.timing[k as keyof typeof c.timing]; return typeof v === 'number' ? [v] : []; }))])) };
}
export async function analyzeSession(directory: string) {
  const experiment = await readExperiment(directory), baseline = await readBaseline(directory);
  if (hash(baseline) !== experiment.baselineHash || baseline.sessionDate !== experiment.session.date || baseline.calendarHash !== experiment.session.calendarHash) throw new Error('Baseline identity mismatch');
  const run = await loadProviderRun(join(directory, experiment.runs.TIINGO));
  if (!run.cleanShutdown || run.truncatedFinalLine || run.manifest.experimentId !== experiment.experimentId || run.manifest.runId !== experiment.runs.TIINGO
    || run.manifest.provider !== 'TIINGO' || run.manifest.baselineHash !== experiment.baselineHash || hash(run.manifest.session) !== hash(experiment.session)
    || run.manifest.gitCommit !== experiment.gitCommit) throw new Error('Tiingo run linkage/integrity mismatch');
  const rest = run.observations.filter(o => o.product === 'TIINGO_REST');
  if (!rest.length || rest.some(o => o.requestedAt === null)) throw new Error('Missing or invalid TIINGO_REST observations');
  const ws: Source = { key: 'TIINGO_WS', product: 'TIINGO_WS', observations: run.observations.filter(o => o.product === 'TIINGO_WS'),
    startedAt: run.manifest.startedAt, end: run.end, events: run.events };
  const groups = new Map<string, Observation[]>();
  for (const o of rest) if (o.startAt >= experiment.session.openAt && o.startAt < experiment.session.closeAt) {
    const key = `${o.symbol}/${o.startAt}`, rows = groups.get(key) ?? []; rows.push(o); groups.set(key, rows);
  }
  const chains = [...groups.values()].map(chain).sort((a, b) => a.startAt.localeCompare(b.startAt) || a.symbol.localeCompare(b.symbol));
  const makeSource = (view: 'firstCompleted' | 'finalObserved'): Source => ({ key: view, product: 'TIINGO_REST',
    observations: chains.flatMap(c => c[view] ? [c[view]] : []), startedAt: run.manifest.startedAt, end: run.end, events: run.events });
  const first = classify(makeSource('firstCompleted'), experiment, baseline), final = classify(makeSource('finalObserved'), experiment, baseline);
  const full: Source = { ...makeSource('finalObserved'), key: 'TIINGO_REST_CHRONOLOGY', observations: rest };
  const windowImpact = first.windows.map(w => {
    const later = final.windows.find(v => v.symbol === w.symbol && v.targetAt === w.targetAt)!;
    return { symbol: w.symbol, targetAt: w.targetAt, first: w, final: later,
      changes: w.values && later.values ? diff(w.values, later.values) : null,
      priceDifference: w.values && later.values ? priceDifference(later.values, w.values) : null };
  });
  const targetImpact = first.targets.map(a => {
    const b = final.targets.find(t => t.targetAt === a.targetAt)!;
    return { targetAt: a.targetAt, first: a, final: b, rawAgreement: agreement(a.raw, b.raw),
      effectiveAgreement: agreement(a.effective, b.effective),
      componentDeltas: Object.fromEntries((['spy', 'rsp'] as const).map(s => [s, Object.fromEntries(components.map(k => [k,
        a[s][k] === null || b[s][k] === null ? null : b[s][k]! - a[s][k]!]))])) };
  });
  const readyHistory: IntradayStressHistory = { effectiveState: null, confirmation: 0 };
  const chronological = first.targets.map((target, i) => {
    const prefix = windowsAt(full, experiment.session, run.end).filter(w => w.targetAt <= target.targetAt);
    const at = prefix.every(w => w.usableAt) ? prefix.map(w => w.usableAt!).sort().at(-1)! : null;
    const snapshot = at ? windowsAt(full, experiment.session, at).filter(w => w.targetAt <= target.targetAt) : [];
    const measured = at && snapshot.every(w => w.values) ? measure(experiment.session, snapshot, baseline) : null;
    const spy = measured?.[0]?.find(t => t.targetAt === target.targetAt), rsp = measured?.[1]?.find(t => t.targetAt === target.targetAt);
    const raw = spy?.instrumentRawState && rsp?.instrumentRawState ? marketRawState(spy.instrumentRawState, rsp.instrumentRawState) : null;
    const transition = advanceIntradayStress(readyHistory, raw);
    readyHistory.effectiveState = transition.effectiveState; readyHistory.confirmation = transition.confirmationAfter;
    const affected = chains.filter(c => c.startAt < target.targetAt && c.transitions.some(t => t.kind === 'POST_CLOSE_REVISION' && t.receivedAt > (at ?? run.end)));
    return { targetAt: target.targetAt, classifierReadyAt: raw ? at : null, rawAtReady: raw, effectiveAtReady: transition.effectiveState,
      transitionAtReady: transition, spyAtReady: spy ?? null, rspAtReady: rsp ?? null,
      laterRevisedMinutes: affected.map(c => ({ symbol: c.symbol, startAt: c.startAt })), finalRaw: final.targets[i]!.raw,
      finalEffective: final.targets[i]!.effective, rawChangedAfterReady: raw !== null && raw !== final.targets[i]!.raw,
      effectiveChangedAfterReady: raw !== null && transition.effectiveState !== final.targets[i]!.effective };
  });
  const wsMinutes = new Map(minutesAt(ws, run.end).map(m => [`${m.symbol}/${m.startAt}`, m]));
  const wsWindows = new Map(windowsAt(ws, experiment.session, run.end).map(w => [`${w.symbol}/${w.targetAt}`, w]));
  const wsRelationship = chains.filter(c => c.transitions.some(t => t.kind === 'POST_CLOSE_REVISION') && c.firstCompleted?.values && c.finalObserved?.values)
    .map(c => { const w = wsMinutes.get(`${c.symbol}/${c.startAt}`), a = c.firstCompleted!.values!, b = c.finalObserved!.values!;
      return { symbol: c.symbol, startAt: c.startAt, ws: w ?? null, first: a, final: b,
        fields: w ? Object.fromEntries((['open', 'high', 'low', 'close'] as const).map(k => [k, Math.abs(b[k] - w[k]) < Math.abs(a[k] - w[k]) ? 'CLOSER' : Math.abs(b[k] - w[k]) > Math.abs(a[k] - w[k]) ? 'FARTHER' : 'UNCHANGED_DISTANCE'])) : null }; });
  const wsWindowRelationship = windowImpact.filter(w => w.changes && fields.some(k => k !== 'volume' && w.changes![k])).map(w => {
    const reference = wsWindows.get(`${w.symbol}/${w.targetAt}`), wsValues = reference?.values ?? null;
    return { symbol: w.symbol, targetAt: w.targetAt, ws: reference ?? null,
      firstDistance: wsValues && w.first.values ? priceDifference(w.first.values, wsValues) : null,
      finalDistance: wsValues && w.final.values ? priceDifference(w.final.values, wsValues) : null };
  });
  return { experiment: { directory, experimentId: experiment.experimentId, session: experiment.session, experimentHash: hash(experiment),
    baselineHash: experiment.baselineHash, tiingoRunId: run.manifest.runId, journalHash: run.journalHash },
    integrity: { experiment: 'VALID', baseline: 'VALID', tiingoRun: 'VALID', cleanShutdown: true }, chains,
    symbols: Object.fromEntries(SYMBOLS.map(s => [s, totals(chains.filter(c => c.symbol === s))])), totals: totals(chains),
    windows: windowImpact, targets: targetImpact, chronological, wsRelationship, wsWindowRelationship };
}
export async function revisionsMain(args = process.argv.slice(2)) {
  if (!args.length) throw new Error('Expected one or more experiment directories');
  const directories = args.map(p => resolve(p));
  if (new Set(directories).size !== directories.length) throw new Error('Duplicate experiment directory');
  const sessions = [];
  for (const directory of directories) sessions.push(await analyzeSession(directory));
  if (new Set(sessions.map(s => s.experiment.experimentId)).size !== sessions.length) throw new Error('Duplicate experiment identity');
  const all = sessions.flatMap(s => s.chains);
  const largest = sessions.flatMap(s => s.chains.flatMap(c => c.transitions.filter(t => t.kind === 'POST_CLOSE_REVISION').flatMap(t =>
    (['open', 'high', 'low', 'close'] as const).flatMap(field => {
      const d = t.changes?.[field]; return d && 'bps' in d && d.bps !== null && d.bps !== undefined
        ? [{ session: s.experiment.session.date, symbol: c.symbol, minute: c.startAt, ordinal: t.ordinal, requestedAt: t.requestedAt,
          receivedAt: t.receivedAt, field, ...d, bps: d.bps as number }] : [];
    })))).sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));
  const report = { version: 1, authority: 'RESEARCH_ONLY', analysis: 'TIINGO_REST_REVISION_FORENSICS', sessions,
    aggregate: { ...totals(all), symbols: Object.fromEntries(SYMBOLS.map(s => [s, totals(all.filter(c => c.symbol === s))])), largestPriceRevisions: largest },
    limitations: ['Final observed means the last completed version within the bounded experiment, not provider finality.',
      'First completed versus final observed is revision sensitivity, not target-time availability.',
      'WS locally aggregates derived reference prices, has no volume, and is not ground truth.',
      'Receipt is a time-of-knowledge proxy, not fsync time. Neither source has trading authority.'] };
  const output = join(directories[0]!, 'derived', `tiingo-revision-forensics-${randomUUID()}`);
  await mkdir(output, { recursive: false });
  await exclusiveJson(join(output, 'report.json'), report);
  const lines = ['# Tiingo REST revision forensics', '', 'Research only. No provider acceptance or trading authority.', '',
    '| Session | Symbol | Broad revision count | Pre-close evolutions | Post-close revisions | Volume-only | Price-affecting | Max price bps | V1 raw-state changes | V1 effective-state changes |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const s of sessions) for (const symbol of SYMBOLS) {
    const t = s.symbols[symbol]!;
    const max = Math.max(0, ...(['open', 'high', 'low', 'close'] as const).map(k => t.magnitudes[k]?.POST_CLOSE_REVISION?.max ?? 0));
    lines.push(`| ${s.experiment.session.date} | ${symbol} | ${t.broadRevisionCount} | ${t.counts.PRE_CLOSE_EVOLUTION} | ${t.counts.POST_CLOSE_REVISION} | ${t.volumeOnly} | ${t.priceAffecting} | ${max.toFixed(3)} | ${s.targets.filter(x => x.rawAgreement.category !== 'EXACT_STATE_AGREEMENT').length} | ${s.targets.filter(x => x.effectiveAgreement.category !== 'EXACT_STATE_AGREEMENT').length} |`);
  }
  lines.push('', `Combined: ${report.aggregate.broadRevisionCount} broad changes, ${report.aggregate.counts.PRE_CLOSE_EVOLUTION} pre-close evolutions, ${report.aggregate.counts.POST_CLOSE_REVISION} post-close revisions.`,
    '', `Post-close timing (ms): ${JSON.stringify(report.aggregate.timing)}`, `Changed fields: ${JSON.stringify(report.aggregate.changedFields)}`,
    `Field combinations: ${JSON.stringify(report.aggregate.fieldCombinations)}`, `Magnitude distributions (absolute bps for prices, absolute percent for volume when prior volume is nonzero): ${JSON.stringify(report.aggregate.magnitudes)}`,
    `Absolute volume change distribution: ${JSON.stringify(report.aggregate.volumeAbsoluteChange)}.`,
    '', '## Largest post-close price revisions',
    ...largest.slice(0, 15).map(x => `- ${x.session} ${x.symbol} ${x.minute} ${x.field}: ${x.before} -> ${x.after}; ${x.bps.toFixed(3)} bps; requested ${x.requestedAt}.`),
    '', '## State sensitivity');
  for (const s of sessions) {
    const raw = s.targets.filter(x => x.rawAgreement.category !== 'EXACT_STATE_AGREEMENT');
    const effective = s.targets.filter(x => x.effectiveAgreement.category !== 'EXACT_STATE_AGREEMENT');
    lines.push(`${s.experiment.session.date}: ${raw.length} raw and ${effective.length} effective state changes; ${s.chronological.filter(x => x.rawChangedAfterReady).length} raw changes after classifier readiness.`);
    const maximumComponent = Math.max(0, ...s.targets.flatMap(t => Object.values(t.componentDeltas).flatMap(symbol => Object.values(symbol as Record<string, number | null>).map(v => Math.abs(v ?? 0)))));
    lines.push(`Largest absolute V1 component movement: ${maximumComponent}. Chronological targets with later revised minutes: ${s.chronological.filter(x => x.laterRevisedMinutes.length).length}.`);
    for (const x of raw) lines.push(`- ${x.targetAt}: ${x.first.raw} -> ${x.final.raw}; components ${JSON.stringify(x.componentDeltas)}`);
    const affected = s.windows.filter(w => w.changes && ['open', 'high', 'low', 'close'].some(k => w.changes![k as Field]));
    lines.push(`Affected 15-minute OHLC windows: ${affected.length}.`);
    for (const w of affected) lines.push(`- ${w.symbol} ${w.targetAt} (${w.first.actionable ? 'actionable' : 'closing, nonactionable'}): ${JSON.stringify(w.changes)}`);
    const wsCounts = { CLOSER: 0, FARTHER: 0, UNCHANGED_DISTANCE: 0 };
    for (const x of s.wsRelationship) if (x.fields) for (const field of ['open', 'high', 'low', 'close'] as const) if (x.first[field] !== x.final[field])
      wsCounts[x.fields[field] as keyof typeof wsCounts]++;
    lines.push(`WS price-field distance: ${JSON.stringify(wsCounts)}; comparable revised minutes ${s.wsRelationship.filter(x => x.ws).length}/${s.wsRelationship.length}.`);
  }
  lines.push('', '## Limitations', ...report.limitations.map(x => `- ${x}`));
  await writeFile(join(output, 'summary.md'), lines.join('\n') + '\n', { flag: 'wx' });
  return output;
}
