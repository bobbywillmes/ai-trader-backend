/** Pure research measurements. No state thresholds, clock, I/O or trading authority. */
import { datesBetween, marketSession, validDate, type CalendarException } from '../services/market-calendar.js';
import { normalizeSplits, type ResearchSplit } from '../services/trend-calculation.js';

export const PARTICIPATION_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'] as const;
export type ParticipationSymbol = typeof PARTICIPATION_SYMBOLS[number];
export type VolumeObservation = { date: string; volume: number };
export type InstrumentInput = { bars: readonly VolumeObservation[]; splits: readonly ResearchSplit[]; splitError?: string };
export type ParticipationInput = Record<ParticipationSymbol, InstrumentInput>;
export const DIAGNOSTIC_CUT_POINTS = { le070: 0.70, le080: 0.80, ge100: 1, ge125: 1.25, ge150: 1.5, ge200: 2 } as const;

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  if (!values.every(Number.isFinite)) throw new Error('Non-finite median input.');
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]! / 2 + sorted[mid]! / 2;
}

/** Reject duplicate identities/dates as ambiguous, even when ratios match. */
export function validateSplits(splits: readonly ResearchSplit[]): void {
  const ids = new Set<string>(), dates = new Set<string>();
  for (const s of splits) {
    if (!s.id || !validDate(s.executionDate) || ids.has(s.id) || dates.has(s.executionDate)
      || ![s.splitFrom, s.splitTo, s.priceFactor].every(x => Number.isFinite(x) && x > 0)
      || Math.abs(s.priceFactor - s.splitFrom / s.splitTo) >= 1e-12) throw new Error('Malformed/conflicting split evidence.');
    ids.add(s.id); dates.add(s.executionDate);
  }
}

export function fullSessionDates(from: string, to: string, calendar: readonly CalendarException[]): string[] {
  return datesBetween(from, to).filter(date => marketSession(date, calendar)?.closeMinutes === 960);
}

type HorizonResult = { medianVolume: number | null; rvol: number | null; reasons: string[] };
export type InstrumentDay = { normalizedTargetVolume: number | null; medianVolume20: number | null; rvol20: number | null;
  medianVolume40: number | null; rvol40: number | null; baselineRatio: number | null; reasons20: string[]; reasons40: string[] };
export type Panel = { panelMedianRvol: number; minimumRvol: number; maximumRvol: number; range: number;
  agreement: Record<keyof typeof DIAGNOSTIC_CUT_POINTS, number> };
export type ParticipationDay = { date: string; etfs: Record<ParticipationSymbol, InstrumentDay>;
  panel20: Panel | null; panel40: Panel | null; panel20Reasons: string[]; panel40Reasons: string[] };

export function panelDiagnostics(values: readonly number[]): Panel {
  if (values.length !== 5 || !values.every(x => Number.isFinite(x) && x >= 0)) throw new Error('Panel requires five valid RVOL values.');
  const minimumRvol = Math.min(...values), maximumRvol = Math.max(...values);
  return { panelMedianRvol: median(values)!, minimumRvol, maximumRvol, range: maximumRvol - minimumRvol,
    agreement: Object.fromEntries(Object.entries(DIAGNOSTIC_CUT_POINTS).map(([key, cut]) =>
      [key, values.filter(x => key.startsWith('le') ? x <= cut : x >= cut).length])) as Panel['agreement'] };
}

export function calculateParticipation(input: ParticipationInput, evidenceFrom: string, from: string, to: string,
  calendar: readonly CalendarException[]): ParticipationDay[] {
  const sessions = fullSessionDates(evidenceFrom, to, calendar);
  const series = Object.fromEntries(PARTICIPATION_SYMBOLS.map(symbol => {
    const source = input[symbol], volumes = new Map<string, number>(), errors = new Map<string, string>();
    let splitError = source.splitError;
    try { validateSplits(source.splits); } catch { splitError = 'MALFORMED_OR_CONFLICTING_SPLITS'; }
    const seen = new Set<string>();
    for (const bar of source.bars) {
      if (seen.has(bar.date)) { errors.set(bar.date, 'DUPLICATE_VOLUME'); volumes.delete(bar.date); continue; }
      seen.add(bar.date);
      if (!validDate(bar.date) || !Number.isFinite(bar.volume) || bar.volume < 0) { errors.set(bar.date, 'INVALID_VOLUME'); continue; }
      if (splitError) continue;
      try {
        // Unit OHLC deliberately isolates the shared split-volume formula from actual prices.
        const normalized = normalizeSplits([{ id: 0, date: bar.date, volume: bar.volume, open: 1, high: 1, low: 1, close: 1 }], source.splits, to)[0]!;
        volumes.set(bar.date, normalized.volume);
      } catch { errors.set(bar.date, 'INVALID_NORMALIZED_VOLUME'); }
    }
    return [symbol, { volumes, errors, splitError }];
  })) as Record<ParticipationSymbol, { volumes: Map<string, number>; errors: Map<string, string>; splitError: string | undefined }>;
  return sessions.flatMap((date, index) => {
    if (date < from) return [];
    const etfs = Object.fromEntries(PARTICIPATION_SYMBOLS.map(symbol => {
      const { volumes, errors, splitError } = series[symbol];
      const target = volumes.get(date) ?? null;
      function horizon(n: number): HorizonResult {
        const reasons: string[] = [];
        if (splitError) return { medianVolume: null, rvol: null, reasons: [`SPLIT_EVIDENCE:${splitError}`] };
        if (target === null) reasons.push(`TARGET:${date}:${errors.get(date) ?? 'MISSING_VOLUME'}`);
        const required = sessions.slice(Math.max(0, index - n), index);
        if (required.length < n) reasons.push(`INSUFFICIENT_CALENDAR_HISTORY:${required.length}/${n}`);
        for (const d of required) if (!volumes.has(d)) reasons.push(`BASELINE:${d}:${errors.get(d) ?? 'MISSING_VOLUME'}`);
        const baselineValid = required.length === n && required.every(d => volumes.has(d));
        const baseline = baselineValid ? median(required.map(d => volumes.get(d)!)) : null;
        if (baseline === 0) reasons.push('ZERO_MEDIAN_BASELINE');
        const rvol = baseline !== null && baseline > 0 && target !== null ? target / baseline : null;
        if (rvol !== null && !Number.isFinite(rvol)) reasons.push('NON_FINITE_RVOL');
        return { medianVolume: baseline, rvol: reasons.length ? null : rvol, reasons };
      }
      const h20 = horizon(20), h40 = horizon(40);
      const ratio = h20.medianVolume !== null && h40.medianVolume !== null && h40.medianVolume > 0 ? h20.medianVolume / h40.medianVolume : null;
      return [symbol, { normalizedTargetVolume: target, medianVolume20: h20.medianVolume, rvol20: h20.rvol,
        medianVolume40: h40.medianVolume, rvol40: h40.rvol, baselineRatio: ratio !== null && Number.isFinite(ratio) ? ratio : null,
        reasons20: h20.reasons, reasons40: h40.reasons }];
    })) as ParticipationDay['etfs'];
    const reasons = (n: 20 | 40) => PARTICIPATION_SYMBOLS.flatMap(s => etfs[s][`reasons${n}`].map(r => `${s}:${r}`));
    const panel = (n: 20 | 40) => PARTICIPATION_SYMBOLS.every(s => etfs[s][`rvol${n}`] !== null)
      ? panelDiagnostics(PARTICIPATION_SYMBOLS.map(s => etfs[s][`rvol${n}`]!)) : null;
    return [{ date, etfs, panel20: panel(20), panel40: panel(40), panel20Reasons: reasons(20), panel40Reasons: reasons(40) }];
  });
}

export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, percentiles: Object.fromEntries([1, 5, 10, 25, 50, 75, 90, 95, 99].map(p => {
    const index = (sorted.length - 1) * p / 100, lower = Math.floor(index), fraction = index - lower;
    return [`p${p}`, sorted.length ? sorted[lower]! * (1 - fraction) + sorted[Math.ceil(index)]! * fraction : null];
  })) };
}
const present = (values: (number | null)[]) => values.filter((x): x is number => x !== null);
export function summarizeParticipation(days: readonly ParticipationDay[]) {
  const paired = days.filter(d => d.panel20 && d.panel40).map(d => ({ date: d.date, panel20: d.panel20!.panelMedianRvol,
    panel40: d.panel40!.panelMedianRvol, absoluteDifference: Math.abs(d.panel20!.panelMedianRvol - d.panel40!.panelMedianRvol) }));
  const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  const mx = mean(paired.map(x => x.panel20)), my = mean(paired.map(x => x.panel40));
  let covariance = 0, vx = 0, vy = 0;
  for (const p of paired) { const x = p.panel20 - mx!, y = p.panel40 - my!; covariance += x * y; vx += x * x; vy += y * y; }
  return { targetCount: days.length,
    etfs: Object.fromEntries(PARTICIPATION_SYMBOLS.map(s => [s, { rvol20: distribution(present(days.map(d => d.etfs[s].rvol20))),
      rvol40: distribution(present(days.map(d => d.etfs[s].rvol40))), baselineRatio: distribution(present(days.map(d => d.etfs[s].baselineRatio))) }])),
    panels: Object.fromEntries(([20, 40] as const).map(n => {
      const valid = days.flatMap(d => d[`panel${n}`] ? [{ date: d.date, ...d[`panel${n}`]! }] : []);
      const ranked = [...valid].sort((a, b) => a.panelMedianRvol - b.panelMedianRvol || a.date.localeCompare(b.date));
      const unavailableReasons: Record<string, number> = {};
      for (const d of days) for (const reason of d[`panel${n}Reasons`]) {
        const parts = reason.split(':'); const key = `${parts[0]}:${parts[1]}:${parts.at(-1)}`;
        unavailableReasons[key] = (unavailableReasons[key] ?? 0) + 1;
      }
      return [n, { available: valid.length, unavailable: days.length - valid.length,
        distribution: distribution(valid.map(x => x.panelMedianRvol)), lowest: ranked.slice(0, 10), highest: ranked.reverse().slice(0, 10),
        agreementCounts: Object.fromEntries(Object.keys(DIAGNOSTIC_CUT_POINTS).map(k => [k,
          Array.from({ length: 6 }, (_, count) => ({ count, sessions: valid.filter(p => p.agreement[k as keyof Panel['agreement']] === count).length }))])), unavailableReasons }];
    })),
    comparison: { pairedCount: paired.length, meanAbsoluteDifference: mean(paired.map(x => x.absoluteDifference)),
      medianAbsoluteDifference: median(paired.map(x => x.absoluteDifference)), pearsonCorrelation: vx > 0 && vy > 0 ? covariance / Math.sqrt(vx * vy) : null,
      largestDivergences: [...paired].sort((a, b) => b.absoluteDifference - a.absoluteDifference || a.date.localeCompare(b.date)).slice(0, 10) },
    statistics: 'Percentiles: linear interpolation at (N-1)*p. Pearson: centered cross-product / sqrt(centered sum-of-squares product); null for constant/empty series. Comparisons use paired valid dates only.' };
}
