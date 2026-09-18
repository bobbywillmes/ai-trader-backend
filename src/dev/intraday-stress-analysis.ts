import { classify, recover, STATES, type Bar, type Candidate, type Target } from './intraday-stress-calculation.js';
export const METRICS = ['shockPct', 'shockAtrRatio', 'downsideExcursionPct', 'downsideExcursionAtrRatio',
  'realizedMovement60Pct', 'realizedMovement60AtrRatio', 'sessionDrawdownPct', 'sessionDrawdownAtrRatio', 'pathLength60', 'openToCurrentPct'] as const;
export const PROBABILITIES = [0.5, 0.75, 0.9, 0.95, 0.975, 0.99, 0.995, 0.999, 1];
export function quantile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), index = (a.length - 1) * p, low = Math.floor(index);
  return a[low]! + (a[Math.ceil(index)]! - a[low]!) * (index - low);
}
export function distributions(targets: Target[]) {
  const rows: { symbol: string; group: string; metric: string; n: number; quantiles: (number | null)[] }[] = [];
  for (const symbol of [...new Set(targets.map(t => t.symbol))]) {
    const valid = targets.filter(t => t.symbol === symbol && t.status === 'VALID');
    const groups: [string, Target[]][] = [
      ['actionable', valid.filter(t => !t.closing)], ['closing_only', valid.filter(t => t.closing)], ['including_close', valid],
      ['opening_1_4', valid.filter(t => !t.closing && t.index <= 4)], ['nonopening_5_plus', valid.filter(t => !t.closing && t.index > 4)],
      ...Array.from({ length: 26 }, (_, i) => [`index_${i + 1}`, valid.filter(t => !t.closing && t.index === i + 1)] as [string, Target[]]),
      ['prior_ATR_lt_1pct', valid.filter(t => !t.closing && t.priorAtr14Pct! < 0.01)],
      ['prior_ATR_ge_2pct', valid.filter(t => !t.closing && t.priorAtr14Pct! >= 0.02)],
    ];
    for (const [group, sample] of groups) for (const metric of METRICS) {
      const values = sample.flatMap(t => t[metric] === null ? [] : [t[metric]]);
      rows.push({ symbol, group, metric, n: values.length, quantiles: PROBABILITIES.map(p => quantile(values, p)) });
    }
  }
  return rows;
}
export function sessionSummaries(targets: Target[], daily: Bar[]) {
  const dates = [...new Set(targets.map(t => t.date))];
  const result = dates.map(date => {
    const rows = targets.filter(t => t.date === date && !t.closing), valid = rows.filter(t => t.status === 'VALID');
    const max = (key: typeof METRICS[number]) => valid.reduce((m, t) => Math.max(m, t[key] ?? 0), 0);
    const terminal = targets.filter(t => t.date === date && t.closing && t.status === 'VALID');
    const path = ['SPY', 'RSP'].map(symbol => {
      const a = targets.filter(t => t.date === date && t.symbol === symbol && t.status === 'VALID');
      let previous = 0;
      return a.reduce((sum, t) => { const current = t.openToCurrentPct ?? 0; const r = (1 + current) / (1 + previous) - 1; previous = current; return sum + Math.abs(r); }, 0);
    });
    const range = daily.filter(b => new Date(b.t).toISOString().slice(0, 10) === date).map(b => {
      const base = valid.find(t => t.symbol === b.symbol)?.priorAtr14Pct;
      return base ? (b.high - b.low) / b.open / base : 0;
    });
    return { date, valid: valid.length, expected: rows.length, complete: rows.length > 0 && valid.length === rows.length,
      shock: max('shockAtrRatio'), downside: max('downsideExcursionAtrRatio'), downsidePct: max('downsideExcursionPct'),
      rolling: max('realizedMovement60AtrRatio'), drawdown: max('sessionDrawdownAtrRatio'), drawdownPct: max('sessionDrawdownPct'),
      range: Math.max(0, ...range), path: Math.max(0, ...path),
      absoluteCloseReturn: Math.max(0, ...terminal.map(t => Math.abs(t.openToCurrentPct!))),
      whipsaw: terminal.length === 2 ? Math.max(0, ...path) / (0.001 + Math.max(...terminal.map(t => Math.abs(t.openToCurrentPct!)))) : 0 };
  });
  return result;
}
export function representatives(sessions: ReturnType<typeof sessionSummaries>) {
  const valid = sessions.filter(s => s.complete), selected = new Map<string, string[]>();
  const add = (date: string, reason: string) => selected.set(date, [...selected.get(date) ?? [], reason]);
  for (const key of ['range', 'drawdown', 'downside', 'rolling', 'shock', 'whipsaw'] as const) {
    [...valid].sort((a, b) => b[key] - a[key] || a.date.localeCompare(b.date)).slice(0, 4).forEach(s => add(s.date, key));
  }
  const median = quantile(valid.map(s => s.range), 0.5)!;
  [...valid].sort((a, b) => Math.abs(a.range - median) - Math.abs(b.range - median) || a.date.localeCompare(b.date)).slice(0, 4).forEach(s => add(s.date, 'median_range'));
  // Top lists overlap. Fill deterministically with next extreme ranks to reach 24 unique sessions.
  for (let rank = 4; selected.size < 24 && rank < valid.length; rank++) {
    for (const key of ['range', 'drawdown', 'downside', 'rolling', 'whipsaw'] as const) {
      if (selected.size >= 24) break;
      const row = [...valid].sort((a, b) => b[key] - a[key] || a.date.localeCompare(b.date))[rank]!;
      add(row.date, `${key}_rank_${rank + 1}`);
    }
  }
  return [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([date, reasons]) => ({ ...sessions.find(s => s.date === date)!, reasons }));
}
export function candidateAnalysis(targets: Target[], c: Candidate) {
  const grouped = new Map<string, Target[]>();
  for (const t of targets.filter(t => !t.closing)) { const a = grouped.get(t.date) ?? []; a.push(t); grouped.set(t.date, a); }
  const records: { date: string; index: number; raw: number | null; two: number | null; three: number | null; spy: Target; rsp: Target }[] = [];
  for (const [date, rows] of grouped) {
    const spy = rows.filter(t => t.symbol === 'SPY').sort((a, b) => a.index - b.index);
    const rsp = new Map(rows.filter(t => t.symbol === 'RSP').map(t => [t.index, t]));
    const raw = spy.map(t => { const r = rsp.get(t.index); if (!r) return null; const a = classify(t, c), b = classify(r, c); return a === null || b === null ? null : Math.max(a, b); });
    const two = recover(raw, 2), three = recover(raw, 3);
    spy.forEach((t, i) => { const r = rsp.get(t.index); if (r) records.push({ date, index: t.index, raw: raw[i]!, two: two[i]!, three: three[i]!, spy: t, rsp: r }); });
  }
  const valid = records.filter(r => r.raw !== null);
  const freq = (rows: typeof records, key: 'raw' | 'two' | 'three') => ({ n: rows.length, counts: STATES.map((_, i) => rows.filter(r => r[key] === i).length), percentages: STATES.map((_, i) => rows.length ? rows.filter(r => r[key] === i).length / rows.length * 100 : null) });
  const runs = (key: 'raw' | 'two' | 'three', floor: number) => {
    const list: { date: string; start: number; end: number; bars: number; minutes: number; closingCensored: boolean }[] = [];
    let last: typeof list[number] | undefined;
    for (const r of records) {
      if (r[key] === null || r[key]! < floor) { last = undefined; continue; }
      if (last && last.date === r.date && last.end + 1 === r.index) { last.end = r.index; last.bars++; }
      else { last = { date: r.date, start: r.index, end: r.index, bars: 1, minutes: 0, closingCensored: false }; list.push(last); }
      last.closingCensored = r.spy.index === Math.max(...grouped.get(r.date)!.map(t => t.index));
      last.minutes += last.closingCensored ? 10 : 15;
    }
    return { episodes: list.length, sessions: new Set(list.map(r => r.date)).size, medianMinutes: quantile(list.map(r => r.minutes), 0.5), p95Minutes: quantile(list.map(r => r.minutes), 0.95), maxMinutes: Math.max(0, ...list.map(r => r.minutes)), closingCensored: list.filter(r => r.closingCensored).length, list };
  };
  const channels = ['shockAtrRatio', 'realizedMovement60AtrRatio', 'sessionDrawdownAtrRatio'] as const;
  const bounds = [c.shock, c.rolling, c.drawdown];
  const uniqueHigh = channels.map((channel, i) => ({ channel, targets: valid.filter(r => {
    const hit = channels.map((k, j) => [r.spy, r.rsp].some(t => t[k] !== null && t[k]! >= bounds[j]![1]));
    return hit[i] && hit.filter(Boolean).length === 1;
  }).length }));
  const rallyHigh = valid.filter(r => [r.spy, r.rsp].some(t => t.sessionDrawdownAtrRatio! >= c.drawdown[1] && t.openToCurrentPct! > 0));
  const boundaries = channels.flatMap((channel, i) => bounds[i]!.flatMap((threshold, level) => {
    const values = targets.filter(t => !t.closing && t.status === 'VALID' && t[channel] !== null);
    return ['below', 'above'].flatMap(side => [...values].filter(t => side === 'below' ? t[channel]! < threshold : t[channel]! >= threshold)
      .sort((a, b) => Math.abs(a[channel]! - threshold) - Math.abs(b[channel]! - threshold)).slice(0, 1)
      .map(t => ({ channel, threshold, level: level ? 'HIGH' : 'ELEVATED', side, target: t })));
  }));
  return { candidate: c, frequency: Object.fromEntries((['raw', 'two', 'three'] as const).map(key => [key, freq(valid, key)])),
    byPeriod: Object.fromEntries([
      ['opening_1_4', valid.filter(r => r.index <= 4)], ['nonopening', valid.filter(r => r.index > 4)],
      ['quiet_ATR_both_lt_1pct', valid.filter(r => Math.max(r.spy.priorAtr14Pct!, r.rsp.priorAtr14Pct!) < 0.01)],
      ['high_ATR_either_ge_2pct', valid.filter(r => Math.max(r.spy.priorAtr14Pct!, r.rsp.priorAtr14Pct!) >= 0.02)],
      ...[2021, 2022, 2023, 2024, 2025, 2026].map(y => [String(y), valid.filter(r => r.date.startsWith(String(y)))]),
    ].map(([key, rows]) => [key, freq(rows as typeof records, 'raw')])),
    duration: Object.fromEntries((['raw', 'two', 'three'] as const).map(key => [key, { highOrSevere: runs(key, 2), severe: runs(key, 3) }])),
    uniqueHigh, rallyHigh: { targets: rallyHigh.length, sessions: [...new Set(rallyHigh.map(r => r.date))], examples: rallyHigh.slice(0, 12) }, boundaries,
    severeEvents: valid.filter(r => r.raw === 3), records };
}
