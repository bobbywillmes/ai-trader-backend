import { readFile, writeFile } from 'node:fs/promises';
import { CACHE, months } from '../src/dev/intraday-stress-data.js';
import { classify, STATES, type Bar, type Candidate, type Target } from '../src/dev/intraday-stress-calculation.js';
import { quantile } from '../src/dev/intraday-stress-analysis.js';
type Data = { requestedTo: string; symbols: Record<string, { daily: Bar[]; targets: Target[]; splits: unknown[]; dailyConflicts: unknown[]; failures: unknown[]; rawDigest: string }> };
const read = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const data = await read<Data>(`${CACHE}/measurements.json`), challenge = await read<Data>(`${CACHE}/challengers.json`);
const candidates = await read<Candidate[]>('docs/development/intraday-stress/candidates.json');
const all = Object.values(data.symbols).flatMap(d => d.targets), valid = all.filter(t => !t.closing && t.status === 'VALID');
const challenges = Object.values(challenge.symbols).flatMap(d => d.targets).filter(t => !t.closing);
const targetMap = new Map(all.map(t => [`${t.symbol}:${t.date}:${t.index}`, t]));
const sample = (t: Target) => ({ symbol: t.symbol, date: t.date, index: t.index, targetAt: t.targetAt,
  priorAtrPct: t.priorAtr14Pct! * 100, shock: t.shockAtrRatio, rolling: t.realizedMovement60AtrRatio, drawdown: t.sessionDrawdownAtrRatio,
  downsidePct: t.downsideExcursionPct! * 100, drawdownPct: t.sessionDrawdownPct! * 100, openReturnPct: t.openToCurrentPct! * 100, peakFromOpenPct: t.peakFromOpenPct! * 100 });
const b = candidates.find(c => c.name === 'B')!;
const incremental = challenges.flatMap(t => {
  const spy = targetMap.get(`SPY:${t.date}:${t.index}`), rsp = targetMap.get(`RSP:${t.date}:${t.index}`);
  if (!spy || !rsp) return [];
  const s = classify(spy, b), r = classify(rsp, b), diagnostic = classify(t, b);
  return s !== null && r !== null && diagnostic !== null && Math.max(s, r) < 2 && diagnostic >= 2
    ? [{ ...sample(t), diagnostic: STATES[diagnostic], market: STATES[Math.max(s, r)], spy: sample(spy), rsp: sample(rsp) }] : [];
});
const incrementalDates = [...new Set(incremental.map(t => t.date))].map(date => {
  const rows = incremental.filter(t => t.date === date);
  return { date, targets: new Set(rows.map(t => t.index)).size, instrumentTargets: rows.length, severe: rows.filter(t => t.diagnostic === 'SEVERE').length,
    example: [...rows].sort((a, z) => Math.max(z.shock!, z.rolling!, z.drawdown! / 2) - Math.max(a.shock!, a.rolling!, a.drawdown! / 2))[0] };
});
const extremeBars: unknown[] = [], dailyEnvelopeConflicts: unknown[] = [];
for (const [symbol, d] of Object.entries(data.symbols)) {
  const daily = new Map(d.daily.map(b => [new Date(b.t).toISOString().slice(0, 10), b]));
  const byTime = new Map(d.targets.map(t => [t.targetAt, t]));
  for (const [from, to] of months('2021-01-01', data.requestedTo)) {
    const cache = await read<{ ok: boolean; value?: Bar[] }>(`${CACHE}/${symbol}-MINUTE_15-${from}-${to}.json`);
    for (const bar of cache.value ?? []) {
      const date = new Date(bar.t).toISOString().slice(0, 10), day = daily.get(date);
      const target = byTime.get(new Date(bar.t + 900000).toISOString());
      if (!target || target.status !== 'VALID') continue;
      if (day && (bar.low < day.low - 0.01 || bar.high > day.high + 0.01)) dailyEnvelopeConflicts.push({ symbol, date, index: target.index, bar, daily: day });
      if (target.downsideExcursionAtrRatio! >= 1 || target.downsideExcursionPct! >= 0.02) extremeBars.push({ ...sample(target), bar, daily: day });
    }
  }
}
function pearson(a: number[], z: number[]) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mz = z.reduce((s, x) => s + x, 0) / z.length;
  return a.reduce((s, x, i) => s + (x - ma) * (z[i]! - mz), 0) / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * z.reduce((s, x) => s + (x - mz) ** 2, 0));
}
const correlations = ['SPY', 'RSP'].flatMap(symbol => {
  const t = valid.filter(t => t.symbol === symbol && t.realizedMovement60AtrRatio !== null);
  return [['shockAtrRatio', 'realizedMovement60AtrRatio'], ['shockAtrRatio', 'sessionDrawdownAtrRatio'], ['realizedMovement60AtrRatio', 'sessionDrawdownAtrRatio']].map(([a, z]) => ({ symbol, a, b: z,
    correlation: pearson(t.map(x => x[a as keyof Target] as number), t.map(x => x[z as keyof Target] as number)) }));
});
const severeChannel = candidates.map(c => {
  const s = valid.filter(t => classify(t, c) === 3);
  const channel = (t: Target, which: 'acute' | 'session') => {
    const rule = c[which], ratio = which === 'acute' ? t.downsideExcursionAtrRatio! : t.sessionDrawdownAtrRatio!, absolute = which === 'acute' ? t.downsideExcursionPct! : t.sessionDrawdownPct!;
    return { normalizedOnly: ratio >= rule.ratio && absolute < rule.floor, combined: ratio >= rule.ratio && absolute >= rule.floor, emergencyOnly: absolute >= rule.emergency && !(ratio >= rule.ratio && absolute >= rule.floor) };
  };
  return { candidate: c.name, instrumentTargets: s.length, acuteCombined: s.filter(t => channel(t, 'acute').combined).length,
    sessionCombined: s.filter(t => channel(t, 'session').combined).length, acuteEmergencyOnly: s.filter(t => channel(t, 'acute').emergencyOnly).length,
    sessionEmergencyOnly: s.filter(t => channel(t, 'session').emergencyOnly).length,
    preventedByFloors: valid.filter(t => channel(t, 'acute').normalizedOnly || channel(t, 'session').normalizedOnly).length,
    dates: [...new Set(s.map(t => t.date))], events: s.map(sample) };
});
const rally = valid.filter(t => t.sessionDrawdownAtrRatio! >= b.drawdown[1] && t.openToCurrentPct! > 0);
const rallyExamples = [...new Set(rally.map(t => t.date))].map(date => sample([...rally].filter(t => t.date === date).sort((a, z) => z.sessionDrawdownAtrRatio! - a.sessionDrawdownAtrRatio!)[0]!));
const missedAbsolute = valid.filter(t => classify(t, b)! < 2 && (t.downsideExcursionPct! >= 0.01 || t.sessionDrawdownPct! >= 0.025));
const marketMisses = valid.filter(t => t.symbol === 'SPY').flatMap(spy => {
  const rsp = targetMap.get(`RSP:${spy.date}:${spy.index}`);
  if (!rsp || rsp.status !== 'VALID' || Math.max(classify(spy, b)!, classify(rsp, b)!) >= 2) return [];
  return [spy, rsp].some(t => t.downsideExcursionPct! >= 0.01 || t.sessionDrawdownPct! >= 0.025) ? [{ spy: sample(spy), rsp: sample(rsp) }] : [];
});
const result = { correlations, dailyRevisions: Object.fromEntries(Object.entries(data.symbols).map(([s, d]) => [s, d.dailyConflicts])),
  diagnosticCoverage: Object.fromEntries(Object.entries(challenge.symbols).map(([s, d]) => [s, { sessions: new Set(d.targets.map(t => t.date)).size, validActionable: d.targets.filter(t => !t.closing && t.status === 'VALID').length, unavailable: d.targets.filter(t => !t.closing && t.status !== 'VALID').length, failures: d.failures, splits: d.splits, rawDigest: d.rawDigest }])),
  incrementalInstrumentTargets: incremental.length, incrementalDates, dailyEnvelopeConflicts, extremeBars, severeChannel, rallyExamples,
  missedAbsolute: { targets: missedAbsolute.length, dates: [...new Set(missedAbsolute.map(t => t.date))], examples: [...missedAbsolute].sort((a, z) => z.sessionDrawdownPct! - a.sessionDrawdownPct!).slice(0, 10).map(sample) },
  absoluteConcernMarket: { targets: marketMisses.length, sessions: new Set(marketMisses.map(x => x.spy.date)).size,
    examples: [...marketMisses].sort((a, z) => Math.max(z.spy.drawdownPct, z.rsp.drawdownPct) - Math.max(a.spy.drawdownPct, a.rsp.drawdownPct)).slice(0, 10) },
  normalization: ['SPY', 'RSP'].flatMap(symbol => ['quiet', 'turbulent'].map(environment => {
    const t = valid.filter(t => t.symbol === symbol && (environment === 'quiet' ? t.priorAtr14Pct! < 0.01 : t.priorAtr14Pct! >= 0.02));
    return { symbol, environment, n: t.length, shockP95: quantile(t.map(x => x.shockAtrRatio!), 0.95), drawdownP95: quantile(t.map(x => x.sessionDrawdownAtrRatio!), 0.95) };
  })) };
await writeFile('docs/development/intraday-stress/diagnostics.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, extremeBars: extremeBars.length, dailyEnvelopeConflicts: dailyEnvelopeConflicts.length, severeChannel: severeChannel.map(({ events, ...rest }) => rest) }, null, 2));
