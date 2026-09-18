import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CACHE, digest } from '../src/dev/intraday-stress-data.js';
import { candidateAnalysis, distributions, representatives, sessionSummaries } from '../src/dev/intraday-stress-analysis.js';
import { acuteClosingDownside, STATES, type Bar, type Candidate, type Target } from '../src/dev/intraday-stress-calculation.js';
import { compareIntradaySemantics, renderClarificationTables } from '../src/dev/intraday-stress-clarification.js';
type Data = { generatedAt: string; requestedTo: string; symbols: Record<string, { targets: Target[]; daily: Bar[]; rawDigest: string; failures: unknown[]; splits: unknown[]; rejected: unknown[]; invalidDaily: unknown[]; outsideRegularSession: number }> };
const data: Data = JSON.parse(await readFile(`${CACHE}/measurements.json`, 'utf8'));
const targets = Object.values(data.symbols).flatMap(s => s.targets);
if (process.argv.includes('--semantic-clarification')) {
  const out = 'docs/development/intraday-stress';
  const recorded = JSON.parse(await readFile(`${out}/candidate-B.json`, 'utf8'));
  const coverage = JSON.parse(await readFile(`${out}/coverage.json`, 'utf8'));
  const datasetId = digest(Object.values(data.symbols).map(s => s.rawDigest));
  if (datasetId !== coverage.datasetId) throw new Error('Cached dataset differs from original report.');
  const { summary, upgraded } = compareIntradaySemantics(targets, recorded.candidate);
  if (JSON.stringify(summary.frequency.originalB!.raw.counts) !== JSON.stringify(recorded.frequency.raw.counts)
    || JSON.stringify(summary.frequency.originalB!.effective.counts) !== JSON.stringify(recorded.frequency.two.counts)
    || summary.absoluteConcern.originalTargets !== 164 || summary.absoluteConcern.originalSessions !== 41) throw new Error('Original B / concern-set replay mismatch.');
  const report = { datasetId, measurementDigest: digest(targets), providerRequests: 0, recoveryConfirmations: 2, ...summary };
  await writeFile(`${out}/semantic-clarification.json`, JSON.stringify(report, null, 2) + '\n');
  const fields = ['referencePrice', 'currentClose', 'priorAtr14Pct', 'downsideExcursionPct', 'acuteCloseDownsidePct', 'acuteCloseDownsideAtrRatio',
    'shockAtrRatio', 'realizedMovement60AtrRatio', 'sessionDrawdownPct', 'sessionDrawdownAtrRatio', 'openToCurrentPct'] as const;
  const headings = ['date', 'index', 'targetAt', 'originalRaw', 'currentCloseRaw', 'finalRaw', 'originalEffective', 'currentCloseEffective', 'finalEffective',
    ...['spy', 'rsp'].flatMap(s => fields.map(f => `${s}_${f}`))];
  await writeFile(`${out}/semantic-high-upgrades.csv`, headings.join(',') + '\n' + upgraded.map(r => [r.date, r.index, r.targetAt,
    ...[r.raw.originalB, r.raw.currentClose, r.raw.absoluteHigh, r.effective.originalB, r.effective.currentClose, r.effective.absoluteHigh].map(s => s === null ? 'UNAVAILABLE' : STATES[s]),
    ...[r.spy, r.rsp].flatMap(t => { const evidence = { ...t, ...acuteClosingDownside(t) }; return fields.map(f => evidence[f]); })].join(',')).join('\n') + '\n');
  const appendixPath = `${out}/tables.md`, marker = '<!-- INTRADAY_SEMANTIC_CLARIFICATION_START -->';
  const original = (await readFile(appendixPath, 'utf8')).split(marker)[0]!.trimEnd();
  await writeFile(appendixPath, `${original}\n\n${marker}\n${renderClarificationTables(summary).trimEnd()}\n`);
  console.log(JSON.stringify({ datasetId, providerRequests: 0, frequency: summary.frequency,
    safeguards: { ...summary.safeguards, upgradedWithTriggerStillAboveOpen: summary.safeguards.upgradedWithTriggerStillAboveOpen.length },
    absoluteConcern: { ...summary.absoluteConcern, unresolved: summary.absoluteConcern.unresolved.length },
    severeChange: { disappearedSessions: summary.severeChange.disappearedSessions, removed: summary.severeChange.removed.length, new: summary.severeChange.new.length }, bySevereDate: summary.bySevereDate }, null, 2));
  process.exit(0);
}
const daily = Object.values(data.symbols).flatMap(s => s.daily);
const sessions = sessionSummaries(targets, daily), reps = representatives(sessions), dist = distributions(targets);
const output = 'docs/development/intraday-stress'; await mkdir(output, { recursive: true });
await writeFile(`${output}/distributions.csv`, 'symbol,group,metric,n,p50,p75,p90,p95,p97.5,p99,p99.5,p99.9,max\n' + dist.map(d => [d.symbol, d.group, d.metric, d.n, ...d.quantiles].join(',')).join('\n') + '\n');
await writeFile(`${output}/representative-sessions.json`, JSON.stringify(reps, null, 2) + '\n');
await writeFile(`${CACHE}/session-summaries.json`, JSON.stringify(sessions));
await writeFile(`${CACHE}/representative-targets.json`, JSON.stringify(targets.filter(t => reps.some(r => r.date === t.date))));
const coverage = Object.fromEntries(Object.entries(data.symbols).map(([symbol, d]) => {
  const valid = d.targets.filter(t => t.status === 'VALID' && !t.closing), observed = d.targets.filter(t => t.shockPct !== null);
  return [symbol, { expectedActionable: d.targets.filter(t => !t.closing).length, validActionable: valid.length,
    firstObserved: observed[0]?.date, lastObserved: observed.at(-1)?.date, firstValid: valid[0]?.date, lastValid: valid.at(-1)?.date,
    completeSessions: sessions.filter(s => s.complete).length, failures: d.failures, splits: d.splits, rejected: d.rejected, invalidDaily: d.invalidDaily,
    outsideRegularSession: d.outsideRegularSession, reasons: Object.fromEntries([...new Set(d.targets.flatMap(t => t.issues))].map(reason => [reason, d.targets.filter(t => !t.closing && t.issues.includes(reason)).length])),
    unavailableAfterFirstValid: d.targets.filter(t => !t.closing && t.date >= (valid[0]?.date ?? '9999') && t.status !== 'VALID').map(t => ({ date: t.date, index: t.index, issues: t.issues })),
    rawDigest: d.rawDigest }];
}));
await writeFile(`${output}/coverage.json`, JSON.stringify({ requestedTo: data.requestedTo, sourceGeneratedAt: data.generatedAt, datasetId: digest(Object.values(data.symbols).map(s => s.rawDigest)), coverage }, null, 2) + '\n');
try {
  const diagnostic: Data = JSON.parse(await readFile(`${CACHE}/diagnostic-daily.json`, 'utf8'));
  const dates = new Set(reps.map(r => r.date));
  for (const d of Object.values(diagnostic.symbols)) {
    // Independent challenger selection: three largest daily ranges and downside open-to-low moves per year.
    for (let year = 2021; year <= 2026; year++) for (const metric of ['range', 'downside']) {
      [...d.daily].filter(b => new Date(b.t).getUTCFullYear() === year).sort((a, b) => {
        const v = (x: Bar) => metric === 'range' ? (x.high - x.low) / x.open : (x.open - x.low) / x.open;
        return v(b) - v(a) || a.t - b.t;
      }).slice(0, 3).forEach(b => dates.add(new Date(b.t).toISOString().slice(0, 10)));
    }
  }
  await writeFile(`${CACHE}/challenge-dates.json`, JSON.stringify([...dates].sort()));
  console.log(`Diagnostic selection: ${dates.size} dates.`);
} catch { console.log('Diagnostic daily cache not available.'); }
const candidatePath = process.argv[2];
if (candidatePath) {
  const candidates: Candidate[] = JSON.parse(await readFile(candidatePath, 'utf8'));
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3 || new Set(candidates.map(c => c.name)).size !== candidates.length) throw new Error('One to three distinct candidates required.');
  for (const c of candidates) {
    if (!['A', 'B', 'C'].includes(c.name) || ![c.shock, c.rolling, c.drawdown].every(x => x.length === 2 && x.every(v => Number.isFinite(v) && v > 0) && x[0] < x[1])
      || ![c.acute, c.session].every(x => [x.ratio, x.floor, x.emergency].every(v => Number.isFinite(v) && v > 0) && x.floor <= x.emergency)) throw new Error('Invalid bounded candidate definition.');
    const analysis = candidateAnalysis(targets, c);
    await writeFile(`${CACHE}/candidate-${c.name}.json`, JSON.stringify(analysis));
    const { records, severeEvents, boundaries, rallyHigh, ...summary } = analysis;
    const duration = Object.fromEntries(Object.entries(summary.duration).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, r]) => { const { list, ...stats } = r; return [s, stats]; }))]));
    await writeFile(`${output}/candidate-${c.name}.json`, JSON.stringify({ ...summary, duration, rallyHigh: { targets: rallyHigh.targets, sessions: rallyHigh.sessions }, severeSessions: [...new Set(severeEvents.map(r => r.date))],
      boundaries: boundaries.map(b => ({ ...b, target: { date: b.target.date, symbol: b.target.symbol, index: b.target.index, value: b.target[b.channel] } })) }, null, 2) + '\n');
  }
}
console.log(JSON.stringify({ coverage: Object.fromEntries(Object.entries(coverage).map(([s, c]) => [s, { ...c, unavailableAfterFirstValid: c.unavailableAfterFirstValid.length, failures: c.failures.length }])), representatives: reps.map(r => r.date),
  distributions: dist.filter(d => d.group === 'actionable' && !d.metric.includes('Pct') && d.metric !== 'pathLength60') }, null, 2));
