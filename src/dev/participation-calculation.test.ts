import { describe, expect, it } from 'vitest';
import { researchCalendar } from './intraday-stress-calendar.js';
import { calculateParticipation, distribution, fullSessionDates, median, panelDiagnostics, PARTICIPATION_SYMBOLS,
  summarizeParticipation, validateSplits, type ParticipationInput } from './participation-calculation.js';

const calendar = researchCalendar([]);
const dates = fullSessionDates('2024-01-01', '2024-05-31', calendar);
function fixture(volume: (i: number) => number = () => 100): ParticipationInput {
  return Object.fromEntries(PARTICIPATION_SYMBOLS.map(s => [s, { bars: dates.map((date, i) => ({ date, volume: volume(i) })), splits: [] }])) as unknown as ParticipationInput;
}
function measure(input = fixture(), index = 40) {
  return calculateParticipation(input, dates[0]!, dates[index]!, dates[index]!, calendar)[0]!;
}
describe('Participation pure research', () => {
  it('uses correct odd/even medians without mutating input', () => {
    const xs = [5, 1, 3]; expect(median(xs)).toBe(3); expect(xs).toEqual([5, 1, 3]);
    expect(median([9, 1, 4, 2])).toBe(3); expect(median([])).toBeNull();
  });
  it.each([20, 40] as const)('excludes target from its %i-session median', n => {
    const day = measure(fixture(i => i === 40 ? 10000 : 100));
    expect(day.etfs.SPY[`medianVolume${n}`]).toBe(100);
    expect(day.etfs.SPY[`rvol${n}`]).toBe(100);
  });
  it('compares a changed recent norm against the slower control', () => {
    const d = measure(fixture(i => i < 20 ? 100 : 300));
    expect(d.etfs.SPY).toMatchObject({ medianVolume20: 300, medianVolume40: 200, rvol20: 1, rvol40: 1.5, baselineRatio: 1.5 });
  });
  it('normalizes pre-split volume inversely to price factor', () => {
    const input = fixture(i => i < 30 ? 100 : 200);
    for (const s of PARTICIPATION_SYMBOLS) input[s].splits = [{ id: 'split', executionDate: dates[30]!, splitFrom: 1, splitTo: 2, priceFactor: 0.5 }];
    expect(measure(input).etfs.SPY).toMatchObject({ normalizedTargetVolume: 200, medianVolume20: 200, medianVolume40: 200, rvol20: 1, rvol40: 1 });
  });
  it('excludes early closes from targets and both baseline horizons', () => {
    const ds = fullSessionDates('2024-05-01', '2024-08-01', calendar);
    const input = Object.fromEntries(PARTICIPATION_SYMBOLS.map(s => [s, { bars: [...ds.map(date => ({ date, volume: 100 })),
      { date: '2024-07-03', volume: 999999 }], splits: [] }])) as unknown as ParticipationInput;
    const result = calculateParticipation(input, '2024-05-01', '2024-07-03', '2024-08-01', calendar);
    expect(result.some(d => d.date === '2024-07-03')).toBe(false);
    expect(result[0]!.date).toBe('2024-07-05');
    expect(result[0]!.etfs.SPY).toMatchObject({ medianVolume20: 100, medianVolume40: 100 });
    // A missing earlier full date still counts even with an early close between it and target.
    input.SPY.bars = input.SPY.bars.filter(b => b.date !== ds[ds.indexOf('2024-07-05') - 40]);
    expect(calculateParticipation(input, '2024-05-01', '2024-07-05', '2024-07-05', calendar)[0]!.panel40).toBeNull();
  });
  it('never skips missing expected evidence; horizons fail independently', () => {
    const input = fixture(); input.IWM.bars = input.IWM.bars.filter(b => b.date !== dates[5]);
    const d = measure(input);
    expect(d.panel20).not.toBeNull(); expect(d.panel40).toBeNull();
    expect(d.etfs.IWM.reasons40).toContain(`BASELINE:${dates[5]}:MISSING_VOLUME`);
  });
  it('requires all five target volumes', () => {
    const input = fixture(); input.DIA.bars = input.DIA.bars.filter(b => b.date !== dates[40]);
    const d = measure(input); expect(d.panel20).toBeNull(); expect(d.panel40).toBeNull();
    expect(d.panel20Reasons[0]).toContain('DIA:TARGET');
  });
  it('uses five-value median, immune to one extreme sensor, and inclusive diagnostic counts', () => {
    expect(panelDiagnostics([1, 2, 3, 4, 100000]).panelMedianRvol).toBe(3);
    expect(panelDiagnostics([0.7, 0.8, 1.25, 1.5, 2]).agreement).toEqual({ le070: 1, le080: 2, ge100: 3, ge125: 3, ge150: 2, ge200: 1 });
    expect(panelDiagnostics([0.7, 0.8, 1.25, 1.5, 2]).range).toBeCloseTo(1.3);
  });
  it('cannot use OHLC/direction because it only consumes date and volume', () => {
    const input = fixture();
    const changed = Object.fromEntries(PARTICIPATION_SYMBOLS.map(s => [s, { ...input[s], bars: input[s].bars.map(b =>
      ({ ...b, open: 1000, high: 1001, low: 1, close: 2 })) }])) as unknown as ParticipationInput;
    expect(measure(changed)).toEqual(measure(input));
  });
  it('fails closed on malformed or conflicting splits, duplicates, and zero baselines', () => {
    const s = { id: 'a', executionDate: dates[20]!, splitFrom: 1, splitTo: 2, priceFactor: 0.5 };
    expect(() => validateSplits([s, { ...s, id: 'b' }])).toThrow();
    expect(() => validateSplits([{ ...s, splitTo: Infinity }])).toThrow();
    const input = fixture(); input.RSP.splits = [s, s]; expect(measure(input).panel20).toBeNull();
    const duplicate = fixture(); duplicate.SPY.bars = [...duplicate.SPY.bars, duplicate.SPY.bars[40]!];
    expect(measure(duplicate).etfs.SPY.reasons20[0]).toContain('DUPLICATE');
    expect(measure(fixture(() => 0)).etfs.SPY.reasons20).toContain('ZERO_MEDIAN_BASELINE');
  });
  it('reports insufficient warmup and transparent paired summaries', () => {
    expect(measure(fixture(), 19).etfs.SPY.reasons20).toContain('INSUFFICIENT_CALENDAR_HISTORY:19/20');
    expect(distribution([0, 100]).percentiles.p25).toBe(25);
    const summary = summarizeParticipation([measure(), measure(fixture(i => i < 20 ? 100 : 300))]);
    expect(summary.comparison).toMatchObject({ pairedCount: 2, meanAbsoluteDifference: 0.25, medianAbsoluteDifference: 0.25, pearsonCorrelation: null });
    expect(summary.panels[20]!.agreementCounts.ge100!.find(x => x.count === 5)?.sessions).toBe(2);
  });
});
