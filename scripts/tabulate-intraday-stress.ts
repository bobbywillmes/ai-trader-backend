import { readFile, writeFile } from 'node:fs/promises';
import { CACHE } from '../src/dev/intraday-stress-data.js';
import { classify, STATES, type Target } from '../src/dev/intraday-stress-calculation.js';
import { candidateAnalysis, distributions, representatives, sessionSummaries } from '../src/dev/intraday-stress-analysis.js';
type Analysis = ReturnType<typeof candidateAnalysis>;
type Reps = ReturnType<typeof representatives>;
const read = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const out = 'docs/development/intraday-stress';
const candidates = await Promise.all(['A', 'B', 'C'].map(name => read<Analysis>(`${CACHE}/candidate-${name}.json`)));
const reps = await read<Reps>(`${out}/representative-sessions.json`);
const data = await read<{ symbols: Record<string, { targets: Target[] }> }>(`${CACHE}/measurements.json`);
const targets = Object.values(data.symbols).flatMap(s => s.targets), dist = distributions(targets);
const f = (n: number | null | undefined, places = 3) => n == null ? 'N/A' : n.toFixed(places);
const table = (heads: string[], rows: (string | number)[][]) => ['| ' + heads.join(' | ') + ' |', '| ' + heads.map(() => '---').join(' | ') + ' |', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
const sections = ['# Intraday stress quantitative tables', '\nGenerated from the cached dataset. Interpret with [the research report](../intraday-stress-calibration.md). Percentages in these tables are percentage points; CSV fields ending in Pct are decimal fractions. Quantiles use linear interpolation at (n−1)p. Primary state distributions exclude the closing bar; the final table is a separate closing-only diagnostic.\n'];
sections.push('## Measurement distributions\n', table(['Symbol', 'Measurement', 'n', 'p50', 'p75', 'p90', 'p95', 'p97.5', 'p99', 'p99.5', 'p99.9', 'max'], dist.filter(d => d.group === 'actionable' && ['shockAtrRatio', 'realizedMovement60AtrRatio', 'sessionDrawdownAtrRatio', 'downsideExcursionAtrRatio'].includes(d.metric)).map(d => [d.symbol, d.metric, d.n, ...d.quantiles.map(x => f(x))])));
sections.push('\n## Absolute measurements (%)\n', table(['Symbol', 'Measurement', 'p50', 'p95', 'p99', 'p99.9', 'max'], dist.filter(d => d.group === 'actionable' && ['shockPct', 'realizedMovement60Pct', 'sessionDrawdownPct', 'downsideExcursionPct'].includes(d.metric)).map(d => [d.symbol, d.metric, ...[0, 3, 5, 7, 8].map(i => f(d.quantiles[i]! * 100))])));
sections.push('\n## Opening and closing sensitivity\n', table(['Symbol', 'Group', 'Metric', 'n', 'p50', 'p95', 'p99'], dist.filter(d => ['opening_1_4', 'nonopening_5_plus', 'closing_only', 'including_close'].includes(d.group) && ['shockAtrRatio', 'realizedMovement60AtrRatio', 'sessionDrawdownAtrRatio'].includes(d.metric)).map(d => [d.symbol, d.group, d.metric, d.n, ...[0, 3, 5].map(i => f(d.quantiles[i]))])));
sections.push('\n## Candidate state frequencies (%)\n', table(['Candidate', 'Recovery', 'NORMAL', 'ELEVATED', 'HIGH', 'SEVERE', 'Valid targets'], candidates.flatMap(a => (['raw', 'two', 'three'] as const).map(k => {
  const d = a.frequency[k]!; return [a.candidate.name, k, ...d.percentages.map(x => f(x)), d.n];
}))));
sections.push('\n## Raw state frequencies by period (%)\n', table(['Candidate', 'Period', 'NORMAL', 'ELEVATED', 'HIGH', 'SEVERE', 'n'], candidates.flatMap(a => Object.entries(a.byPeriod).map(([k, d]) => [a.candidate.name, k, ...d.percentages.map(x => f(x)), d.n]))));
sections.push('\n## Persistence\n', 'Minutes assume evidence becomes usable exactly target+5 minutes and expires at min(next target+5, session close). Last target therefore contributes 10 minutes; other targets contribute 15. Actual provider latency is not modeled. Episodes never cross sessions or unavailable evidence. Session-end censoring is reported, not treated as observed recovery.\n', table(['Candidate', 'Recovery', 'Episode state', 'Episodes', 'Sessions', 'Median min', 'p95 min', 'Max min', 'Close-censored'], candidates.flatMap(a => Object.entries(a.duration).flatMap(([k, types]) => Object.entries(types).map(([s, d]) => [a.candidate.name, k, s, d.episodes, d.sessions, f(d.medianMinutes, 1), f(d.p95Minutes, 1), d.maxMinutes, d.closingCensored])))));
sections.push('\n## Representative sessions\n', 'Maxima below are across SPY/RSP actionable targets and need not come from the same instrument or instant. Daily range and whole-session path selection diagnostics include the close. Four controls are nearest the median normalized daily range; the other sessions are deterministic extremes.\n', table(['Date', 'Selection', 'Shock / ATR', '60m / ATR', 'Drawdown / ATR', 'Max downside %', 'Max drawdown %', 'Max raw A/B/C', 'B HIGH+ min (raw/2/3)'], reps.map(r => {
  const rows = candidates.map(a => a.records.filter(t => t.date === r.date));
  const max = rows.map(a => STATES[Math.max(...a.map(t => t.raw ?? 0))]!);
  const duration = ['raw', 'two', 'three'].map(key => { const rs = rows[1]!; return rs.reduce((sum, t) => sum + ((t[key as 'raw'] ?? 0) >= 2 ? (t.index === Math.max(...rs.map(x => x.index)) ? 10 : 15) : 0), 0); });
  return [r.date, r.reasons.join(', '), f(r.shock), f(r.rolling), f(r.drawdown), f(r.downsidePct * 100), f(r.drawdownPct * 100), max.join('/'), duration.join('/')];
})));
sections.push('\n## Threshold boundary evidence\n', 'Nearest observed values on each side; no rounding is used for classification. A measurement crossing does not necessarily change the market state because another measurement may already be worse. Index 1 means 09:45 ET.\n', table(['Candidate', 'Measurement', 'Boundary', 'Side', 'Date', 'Symbol', 'Index', 'Value'], candidates.flatMap(a => a.boundaries.map(b => [a.candidate.name, b.channel, b.level, b.side, b.target.date, b.target.symbol, b.target.index, f(b.target[b.channel], 6)]))));
sections.push('\n## Closing-bar state sensitivity (diagnostic only)\n', table(['Candidate', 'Closing targets', 'NORMAL', 'ELEVATED', 'HIGH', 'SEVERE'], candidates.map(a => {
  const closing = targets.filter(t => t.closing && t.symbol === 'SPY' && t.status === 'VALID').map(t => {
    const r = targets.find(r => r.symbol === 'RSP' && r.date === t.date && r.index === t.index)!;
    return Math.max(classify(t, a.candidate)!, classify(r, a.candidate)!);
  });
  return [a.candidate.name, closing.length, ...STATES.map((_, i) => f(closing.filter(x => x === i).length / closing.length * 100))];
})));
// Preserve the separately generated, bounded clarification when rebuilding historical tables.
const clarificationMarker = '<!-- INTRADAY_SEMANTIC_CLARIFICATION_START -->';
const previousTables = await readFile(`${out}/tables.md`, 'utf8').catch(() => '');
const clarificationAt = previousTables.indexOf(clarificationMarker);
const clarification = clarificationAt < 0 ? '' : '\n' + previousTables.slice(clarificationAt).trimEnd() + '\n';
await writeFile(`${out}/tables.md`, sections.join('\n') + '\n' + clarification);
const b = candidates[1]!;
const representativeRows = b.records.filter(r => reps.some(d => d.date === r.date));
const columns = ['date', 'index', 'targetAt', 'rawB', 'recovery2B', 'recovery3B', ...['spy', 'rsp'].flatMap(s => ['priorAtr14Pct', 'referencePrice', 'trueRange15', 'shockAtrRatio', 'downsideExcursionPct', 'realizedMovement60AtrRatio', 'rollingStatus', 'sessionDrawdownPct', 'sessionDrawdownAtrRatio', 'openToCurrentPct'].map(k => `${s}_${k}`))];
await writeFile(`${out}/representative-targets.csv`, columns.join(',') + '\n' + representativeRows.map(r => [r.date, r.index, r.spy.targetAt, STATES[r.raw!], STATES[r.two!], STATES[r.three!], ...[r.spy, r.rsp].flatMap(t => [t.priorAtr14Pct, t.referencePrice, t.trueRange15, t.shockAtrRatio, t.downsideExcursionPct, t.realizedMovement60AtrRatio, t.rollingStatus, t.sessionDrawdownPct, t.sessionDrawdownAtrRatio, t.openToCurrentPct])].join(',')).join('\n') + '\n');
console.log('Wrote quantitative tables and representative target evidence.');
