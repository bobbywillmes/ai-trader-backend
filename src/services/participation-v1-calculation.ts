/** Pure normalized-volume calculation; callers own exact full-session calendar planning. */
import { validDate } from './market-calendar.js';
import { normalizeSplits, type ResearchSplit } from './trend-calculation.js';
import { PARTICIPATION_BASELINE_SESSIONS, PARTICIPATION_SYMBOLS, PARTICIPATION_DIAGNOSTIC_CUT_POINTS, participationStates, type ParticipationSymbol } from './participation-v1.definition.js';

export type ParticipationVolume = { date: string; volume: number };
export type ParticipationCalculationInput = {
  targetDate: string;
  baselineDates: readonly string[];
  observations: Partial<Record<ParticipationSymbol, readonly ParticipationVolume[]>>;
};
export type ParticipationDiagnostic = { code: 'INVALID_WINDOW' | 'MISSING_VOLUME' | 'INVALID_VOLUME' | 'DUPLICATE_VOLUME' | 'ZERO_MEDIAN_BASELINE' | 'NON_FINITE_RVOL'; symbol?: ParticipationSymbol; date?: string };
export function participationMedian(values: readonly number[]): number {
  if (!values.length || !values.every(x => Number.isFinite(x) && x >= 0)) throw new Error('Median requires finite nonnegative values.');
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]! + (sorted[mid]! - sorted[mid - 1]!) / 2;
}
export function participationPanel(values: readonly number[]) {
  if (values.length !== 5) throw new Error('Participation requires all five sensors.');
  const panelMedianRvol = participationMedian(values);
  const minimumRvol = Math.min(...values), maximumRvol = Math.max(...values);
  const agreement = Object.fromEntries(Object.entries(PARTICIPATION_DIAGNOSTIC_CUT_POINTS).map(([key, cut]) =>
    [key, values.filter(x => key.startsWith('le') ? x <= cut : x >= cut).length])) as Record<keyof typeof PARTICIPATION_DIAGNOSTIC_CUT_POINTS, number>;
  return { panelMedianRvol, ...participationStates(panelMedianRvol), minimumRvol, maximumRvol, range: maximumRvol - minimumRvol, agreement };
}
export function calculateParticipationV1(input: ParticipationCalculationInput) {
  const { targetDate, baselineDates, observations } = input;
  const diagnostics: ParticipationDiagnostic[] = [];
  if (!validDate(targetDate) || baselineDates.length !== PARTICIPATION_BASELINE_SESSIONS ||
    baselineDates.some((d, i) => !validDate(d) || d >= targetDate || (i > 0 && d <= baselineDates[i - 1]!))) {
    return { available: false as const, diagnostics: [{ code: 'INVALID_WINDOW' } satisfies ParticipationDiagnostic] };
  }
  const instruments: { symbol: ParticipationSymbol; normalizedTargetVolume: number; medianVolume20: number; rvol20: number }[] = [];
  for (const symbol of PARTICIPATION_SYMBOLS) {
    const before = diagnostics.length;
    const volumes = new Map<string, number>();
    for (const row of observations[symbol] ?? []) {
      if (volumes.has(row.date)) diagnostics.push({ code: 'DUPLICATE_VOLUME', symbol, date: row.date });
      if (!validDate(row.date) || !Number.isFinite(row.volume) || row.volume < 0) diagnostics.push({ code: 'INVALID_VOLUME', symbol, date: row.date });
      volumes.set(row.date, row.volume);
    }
    for (const date of [...baselineDates, targetDate]) if (!volumes.has(date)) diagnostics.push({ code: 'MISSING_VOLUME', symbol, date });
    if (diagnostics.length !== before) continue;
    const medianVolume20 = participationMedian(baselineDates.map(d => volumes.get(d)!));
    if (medianVolume20 === 0) { diagnostics.push({ code: 'ZERO_MEDIAN_BASELINE', symbol }); continue; }
    const normalizedTargetVolume = volumes.get(targetDate)!, rvol20 = normalizedTargetVolume / medianVolume20;
    if (!Number.isFinite(rvol20)) { diagnostics.push({ code: 'NON_FINITE_RVOL', symbol }); continue; }
    instruments.push({ symbol, normalizedTargetVolume, medianVolume20, rvol20 });
  }
  if (diagnostics.length) return { available: false as const, diagnostics };
  return { available: true as const, targetDate, baselineDates: [...baselineDates], instruments, panel: participationPanel(instruments.map(x => x.rvol20)) };
}

/** Reject ambiguity before normalization, including identical duplicates. */
export function validateParticipationSplits(splits: readonly ResearchSplit[]): void {
  const ids = new Set<string>(), dates = new Set<string>();
  for (const s of splits) {
    if (!s.id.trim() || !validDate(s.executionDate) || ids.has(s.id) || dates.has(s.executionDate) ||
      ![s.splitFrom, s.splitTo, s.priceFactor].every(x => Number.isFinite(x) && x > 0) ||
      Math.abs(s.priceFactor - s.splitFrom / s.splitTo) >= 1e-12) throw new Error('Malformed/conflicting split evidence.');
    ids.add(s.id); dates.add(s.executionDate);
  }
}
/** Target-date share basis, with unit OHLC so actual price direction cannot enter. */
export function normalizeParticipationVolumes(bars: readonly ParticipationVolume[], splits: readonly ResearchSplit[], targetDate: string) {
  validateParticipationSplits(splits);
  if (!validDate(targetDate) || bars.some(b => !validDate(b.date) || b.date > targetDate || !Number.isFinite(b.volume) || b.volume < 0)) throw new Error('Invalid volume normalization input.');
  return normalizeSplits(bars.map((b, id) => ({ ...b, id, open: 1, high: 1, low: 1, close: 1 })), splits, targetDate)
    .map(b => ({ date: b.date, volume: b.volume, normalizationFactor: b.normalizationFactor }));
}
