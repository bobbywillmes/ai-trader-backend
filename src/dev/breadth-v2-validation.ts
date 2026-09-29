import { Prisma } from '@prisma/client';
import { mean, median, percentile } from './breadth-statistics.js';
import type { CandidateDay, Family } from './breadth-v2-calibration.js';

export const BREADTH_V2_VALIDATION_VERSION = 'BREADTH_V2_VALIDATION_5C_V1';
export const VALIDATION_FAMILIES = ['QUARTILE', 'TERTILE', 'NARROW'] as const satisfies readonly Family[];
export const FORWARD_HORIZONS = [1, 5, 20] as const;
export type ForwardHorizon = typeof FORWARD_HORIZONS[number];
export type Benchmark = 'SPY' | 'RSP';
export type BenchmarkBar = { date: string; close: string; provider: 'MASSIVE' | 'TIINGO'; splitFactor: string | null };
export type BenchmarkSplit = { date: string; factor: string; provider: 'MASSIVE' | 'TIINGO' };
export type BenchmarkCoverage = { from: string; through: string; provider: 'MASSIVE' | 'TIINGO' };
export type Outcome = { sessionDate: string; benchmark: Benchmark; horizon: ForwardHorizon; provider: BenchmarkBar['provider'] | null; forwardReturn: number | null; forwardMaxDrawdown: number | null; forwardMaxGain: number | null; unavailableReason: string | null };
const Decimal = Prisma.Decimal.clone({ precision: 80 });
const ordered = (values: readonly number[]) => [...values].sort((a, b) => a - b);

/** Returns use exact expected market-session offsets. A provider seam or unproven split interval invalidates the entire window. */
export function benchmarkOutcomes(sessions: readonly string[], benchmark: Benchmark, bars: readonly BenchmarkBar[], events: readonly BenchmarkSplit[], coverages: readonly BenchmarkCoverage[]): Outcome[] {
  const byDate = new Map<string, BenchmarkBar>();
  for (const bar of bars) { if (byDate.has(bar.date)) throw new Error(`Duplicate canonical benchmark bar ${benchmark} ${bar.date}.`); byDate.set(bar.date, bar); }
  const eventsByDate = new Map<string, BenchmarkSplit>();
  for (const event of events) { if (eventsByDate.has(event.date)) throw new Error(`Duplicate benchmark split ${benchmark} ${event.date}.`); eventsByDate.set(event.date, event); }
  const lastBarDate = bars.map(bar => bar.date).sort().at(-1) ?? '';
  const output: Outcome[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const base = byDate.get(sessions[i]!);
    for (const horizon of FORWARD_HORIZONS) {
      let reason: string | null = null, forwardReturn: number | null = null, forwardMaxDrawdown: number | null = null, forwardMaxGain: number | null = null;
      if (!base) reason = 'MISSING_BASE_BAR';
      else if (i + horizon >= sessions.length) reason = 'INCOMPLETE_FORWARD_WINDOW';
      else {
        const baseClose = new Decimal(base.close);
        if (!baseClose.isFinite() || baseClose.lte(0)) reason = 'INVALID_BASE_CLOSE';
        else if (base.provider === 'TIINGO' && (base.splitFactor === null || !new Decimal(base.splitFactor).isFinite() || new Decimal(base.splitFactor).lte(0))) reason = 'INVALID_BASE_SPLIT_FACTOR';
        else {
          let factor = new Decimal(1);
          const changes: number[] = [];
          for (let j = i + 1; j <= i + horizon; j++) {
            const date = sessions[j]!;
            const bar = byDate.get(date);
            if (!bar) { reason = date > lastBarDate ? 'INCOMPLETE_FORWARD_WINDOW' : 'MISSING_FORWARD_BAR'; break; }
            if (bar.provider !== base.provider) { reason = 'PROVIDER_SEAM'; break; }
            let split: Prisma.Decimal;
            if (bar.provider === 'TIINGO') {
              if (bar.splitFactor === null) { reason = 'MISSING_SPLIT_FACTOR'; break; }
              split = new Decimal(bar.splitFactor);
            } else {
              if (!coverages.some(row => row.provider === 'MASSIVE' && row.from <= date && row.through >= date)) { reason = 'SPLIT_COVERAGE_UNAVAILABLE'; break; }
              const event = eventsByDate.get(date);
              if (event && event.provider !== 'MASSIVE') { reason = 'SPLIT_PROVIDER_CONFLICT'; break; }
              split = new Decimal(event?.factor ?? 1);
            }
            const close = new Decimal(bar.close);
            if (!split.isFinite() || split.lte(0) || !close.isFinite() || close.lte(0)) { reason = 'INVALID_BENCHMARK_EVIDENCE'; break; }
            factor = factor.mul(split);
            changes.push(close.mul(factor).div(baseClose).minus(1).toNumber());
          }
          if (!reason && changes.length === horizon) {
            forwardReturn = changes.at(-1)!;
            if (horizon !== 1) { forwardMaxDrawdown = Math.min(0, ...changes); forwardMaxGain = Math.max(0, ...changes); }
          }
        }
      }
      output.push({ sessionDate: sessions[i]!, benchmark, horizon, provider: base?.provider ?? null, forwardReturn, forwardMaxDrawdown, forwardMaxGain, unavailableReason: reason });
    }
  }
  return output;
}

export function outcomeStatistics(rows: readonly Outcome[]) {
  const valid = rows.filter(row => row.forwardReturn !== null);
  const returns = ordered(valid.map(row => row.forwardReturn!));
  const drawdowns = valid.flatMap(row => row.forwardMaxDrawdown === null ? [] : [row.forwardMaxDrawdown]);
  const gains = valid.flatMap(row => row.forwardMaxGain === null ? [] : [row.forwardMaxGain]);
  return { sampleCount: returns.length, meanReturn: mean(returns), medianReturn: percentile(returns, 0.5), p10Return: percentile(returns, 0.1), p25Return: percentile(returns, 0.25), p75Return: percentile(returns, 0.75), p90Return: percentile(returns, 0.9), positiveReturnRate: returns.length ? returns.filter(value => value > 0).length / returns.length : null, meanMaxDrawdown: mean(drawdowns), medianMaxDrawdown: median(drawdowns), meanMaxGain: mean(gains), medianMaxGain: median(gains) };
}

export function regimeEntries(days: readonly CandidateDay[]): CandidateDay[] {
  const previous = new Map<Family, CandidateDay['effectiveState']>();
  return days.filter(day => {
    const prior = previous.get(day.family) ?? null;
    previous.set(day.family, day.effectiveState);
    return day.effectiveState !== null && day.effectiveState !== prior;
  });
}

export function transitionEvents(days: readonly CandidateDay[]) {
  return days.filter(day => day.transition !== null && ['POSITIVE -> MIXED', 'MIXED -> NEGATIVE', 'NEGATIVE -> MIXED', 'MIXED -> POSITIVE'].includes(day.transition));
}

export type Disagreement = { sessionDate: string; category: string; direction: string | null; quartile: CandidateDay['effectiveState']; tertile: CandidateDay['effectiveState']; narrow: CandidateDay['effectiveState']; oppositeDirectional: boolean };
export function candidateDisagreements(days: readonly CandidateDay[]): Disagreement[] {
  const byDate = new Map<string, Map<Family, CandidateDay>>();
  for (const day of days) {
    const row = byDate.get(day.sessionDate) ?? new Map<Family, CandidateDay>();
    if (row.has(day.family)) throw new Error('Duplicate family candidate day.');
    row.set(day.family, day); byDate.set(day.sessionDate, row);
  }
  return [...byDate].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([sessionDate, row]) => {
    if (row.size !== 3) throw new Error(`Incomplete candidate set for ${sessionDate}.`);
    const quartile = row.get('QUARTILE')!.effectiveState, tertile = row.get('TERTILE')!.effectiveState, narrow = row.get('NARROW')!.effectiveState;
    const oppositeDirectional = [quartile, tertile, narrow].includes('POSITIVE') && [quartile, tertile, narrow].includes('NEGATIVE');
    let category: string, direction: string | null = null;
    if ([quartile, tertile, narrow].includes(null)) category = 'UNAVAILABLE';
    else if (oppositeDirectional) category = 'OPPOSITE_DIRECTIONAL';
    else if (quartile === tertile && tertile === narrow) category = 'ALL_AGREE';
    else if (quartile === 'MIXED' && tertile === 'MIXED' && narrow !== 'MIXED') { category = 'NARROW_DIRECTIONAL_ONLY'; direction = narrow; }
    else if (quartile === 'MIXED' && tertile === narrow && narrow !== 'MIXED') { category = 'NARROW_TERTILE_DIRECTIONAL'; direction = narrow; }
    else if (quartile !== 'MIXED' && tertile === 'MIXED' && narrow === 'MIXED') { category = 'QUARTILE_DIRECTIONAL_ONLY'; direction = quartile; }
    else category = 'OTHER_NON_OPPOSITE';
    return { sessionDate, category, direction, quartile, tertile, narrow, oppositeDirectional };
  });
}
