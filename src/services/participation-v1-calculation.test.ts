import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { calculateParticipationV1, normalizeParticipationVolumes, participationMedian, participationPanel, type ParticipationCalculationInput } from './participation-v1-calculation.js';
import { classifyParticipation, PARTICIPATION_SYMBOLS } from './participation-v1.definition.js';
import { barEligibility, etInstant, isFullMarketSession, type CalendarException } from './market-calendar.js';

const baselineDates = Array.from({ length: 20 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
function input(target = 21): ParticipationCalculationInput {
  return { targetDate: '2026-09-01', baselineDates, observations: Object.fromEntries(PARTICIPATION_SYMBOLS.map(s => [s,
    [...baselineDates.map((date, i) => ({ date, volume: i + 1 })), { date: '2026-09-01', volume: target }]])) };
}
describe('Participation V1 pure foundation', () => {
  it.each([[0.74999999, 'QUIET'], [0.75, 'NORMAL'], [1.24999999, 'NORMAL'], [1.25, 'ACTIVE'], [1.49999999, 'ACTIVE'], [1.5, 'INTENSE']] as const)('classifies %s', (n, state) => expect(classifyParticipation(n)).toBe(state));
  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid numbers %s', n => {
    expect(() => classifyParticipation(n)).toThrow(); expect(() => participationMedian([n])).toThrow();
    expect(calculateParticipationV1(input(n))).toMatchObject({ available: false, diagnostics: [expect.objectContaining({ code: 'INVALID_VOLUME' }), ...Array(4).fill(expect.anything())] });
  });
  it('uses exact twenty-slot median, excludes target, requires five and returns equal states', () => {
    const result = calculateParticipationV1(input());
    expect(result).toMatchObject({ available: true, instruments: PARTICIPATION_SYMBOLS.map(symbol => ({ symbol, medianVolume20: 10.5, rvol20: 2 })), panel: { panelMedianRvol: 2, rawState: 'INTENSE', effectiveState: 'INTENSE' } });
    expect(participationPanel([100, 0, 1.3, 1.2, 1])).toMatchObject({ panelMedianRvol: 1.2, minimumRvol: 0, maximumRvol: 100, range: 100, rawState: 'NORMAL' });
    expect(() => participationPanel([1, 1, 1, 1])).toThrow();
  });
  it('does not replace missing expected slots with older observations or admit target into baseline', () => {
    const fixture = input(); fixture.observations.SPY = [...fixture.observations.SPY!.slice(1), { date: '2026-07-31', volume: 100 }];
    expect(calculateParticipationV1(fixture)).toMatchObject({ available: false, diagnostics: [{ code: 'MISSING_VOLUME', symbol: 'SPY', date: baselineDates[0] }] });
    for (const dates of [baselineDates.slice(1), [...baselineDates, '2026-08-21'], [...baselineDates.slice(1), fixture.targetDate], [...baselineDates].reverse()]) {
      expect(calculateParticipationV1({ ...input(), baselineDates: dates })).toMatchObject({ available: false, diagnostics: [{ code: 'INVALID_WINDOW' }] });
    }
    delete fixture.observations.QQQ;
    expect(calculateParticipationV1(fixture).available).toBe(false);
  });
  it('allows zero target, rejects zero baseline, duplicate volumes and overflow', () => {
    expect(calculateParticipationV1(input(0))).toMatchObject({ available: true, panel: { rawState: 'QUIET' } });
    const zero = input(); zero.observations.SPY = zero.observations.SPY!.map(x => ({ ...x, volume: 0 }));
    expect(calculateParticipationV1(zero)).toMatchObject({ available: false, diagnostics: [{ code: 'ZERO_MEDIAN_BASELINE', symbol: 'SPY' }] });
    const dup = input(); dup.observations.SPY = [...dup.observations.SPY!, dup.observations.SPY![0]!];
    expect(calculateParticipationV1(dup).available).toBe(false);
    const overflow = input(Number.MAX_VALUE); overflow.observations.SPY = overflow.observations.SPY!.map(x => ({ ...x, volume: x.date === overflow.targetDate ? x.volume : Number.MIN_VALUE }));
    expect(calculateParticipationV1(overflow)).toMatchObject({ available: false, diagnostics: [{ code: 'NON_FINITE_RVOL', symbol: 'SPY' }] });
  });
  it('diagnostic agreement, prior states and OHLC do not control classification', () => {
    expect(participationPanel([0, 0, 1, 2, 100]).rawState).toBe(participationPanel([1, 1, 1, 1, 1]).rawState);
    const fixture = { ...input(), previousState: 'QUIET', open: -100, close: 999 };
    expect(calculateParticipationV1(fixture)).toEqual(calculateParticipationV1(input()));
  });
  it('excludes closed and early-close dates while retaining DAY_1 eligibility', () => {
    const calendar: CalendarException[] = [{ sessionDate: '2026-11-27', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }, { sessionDate: '2026-11-26', type: 'CLOSED', closeTimeMinutesEt: null }];
    expect(isFullMarketSession('2026-11-25', calendar)).toBe(true);
    for (const d of ['2026-11-26', '2026-11-27', '2026-11-28']) expect(isFullMarketSession(d, calendar)).toBe(false);
    expect(barEligibility('DAY_1', etInstant('2026-11-27', 0), etInstant('2026-11-27', 810), calendar).status).toBe('ELIGIBLE');
  });
  it.each([[[], 100], [[0.5], 200], [[2], 50], [[0.5, 0.25], 800]])('normalizes forward/reverse/multiple/no splits %j', (factors, volume) => {
    const splits = factors.map((priceFactor, i) => ({ id: String(i), executionDate: `2026-11-${27 + i}`, splitFrom: priceFactor, splitTo: 1, priceFactor }));
    expect(normalizeParticipationVolumes([{ date: '2026-11-25', volume: 100 }], splits, '2026-11-28')[0]!.volume).toBe(volume);
  });
  it('applies target and excluded early-close splits only to earlier bars; raw evidence unchanged', () => {
    const bars = [{ date: '2026-11-25', volume: 100 }, { date: '2026-11-30', volume: 100 }];
    const splits = ['2026-11-27', '2026-11-30'].map((executionDate, i) => ({ id: String(i), executionDate, splitFrom: 1, splitTo: 2, priceFactor: 0.5 }));
    expect(normalizeParticipationVolumes(bars, splits, '2026-11-30').map(x => x.volume)).toEqual([400, 100]);
    expect(bars.map(x => x.volume)).toEqual([100, 100]);
    for (const invalid of [[splits[0]!, splits[0]!], [{ ...splits[0]!, splitFrom: NaN }], [{ ...splits[0]!, priceFactor: 0 }], [splits[0]!, { ...splits[0]!, id: 'different' }]]) expect(() => normalizeParticipationVolumes(bars, invalid, '2026-11-30')).toThrow();
  });
  it('matches research normalization through a later report date at threshold-adjacent ratios', () => {
    for (const rvol of [0.749999999, 0.75, 1.249999999, 1.25, 1.499999999, 1.5]) {
      const bars = [{ date: '2026-09-01', volume: 100 }, { date: '2026-09-02', volume: 100 * rvol }];
      const splits = [{ id: 'later', executionDate: '2026-09-03', splitFrom: 1, splitTo: 2, priceFactor: 0.5 }];
      const target = normalizeParticipationVolumes(bars, splits, '2026-09-02');
      const report = normalizeParticipationVolumes(bars, splits, '2026-09-03');
      expect(target[1]!.volume / target[0]!.volume).toBe(report[1]!.volume / report[0]!.volume);
      expect(classifyParticipation(target[1]!.volume / target[0]!.volume)).toBe(classifyParticipation(report[1]!.volume / report[0]!.volume));
    }
  });
  it('keeps the production dependency closure pure and contains no publisher', () => {
    const visited = new Set<string>();
    function inspect(path: string) {
      if (visited.has(path)) return; visited.add(path);
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/(?:prisma|process\.env|fetch\(|Date\.now|new Date\(\)|EntryDecision|SignalEvaluation|StrategyMarketRegimePolicy|order\.service|signal\.service)/);
      for (const match of source.matchAll(/from ['"]\.\/([^'"]+)\.js['"]/g)) inspect(`src/services/${match[1]}.ts`);
    }
    inspect('src/services/participation-v1-calculation.ts');
    expect(existsSync('src/services/participation-assessment.service.ts')).toBe(false);
    expect(readFileSync('src/services/participation-v1-calculation.ts', 'utf8')).not.toMatch(/40|predecessor/);
  });
});
