import { describe, expect, it, vi } from 'vitest';
import type { MarketBar } from '@prisma/client';
vi.mock('../config/env.js', () => ({ env: { MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-09-24' } }));
import { validateCanonicalDailyRows } from './market-daily-authority.js';
import { datesBetween, etInstant, marketSession } from './market-calendar.js';
import { normalizeSplits, calculateTrendWithThresholds, type ResearchBar } from './trend-calculation.js';
import { calculateVolatility, instrumentMeasurements } from './volatility-calculation.js';
import { calculateParticipationV1 } from './participation-v1-calculation.js';
import { TREND_V1_THRESHOLDS } from './trend-v1.definition.js';
import { PARTICIPATION_SYMBOLS } from './participation-v1.definition.js';

describe('daily calculation parity across Massive to Tiingo seam', () => {
  it('feeds unchanged Trend, Volatility, Participation, and ATR rules from logical sessions', () => {
    const dates = datesBetween('2026-06-01', '2026-09-25').filter(date => marketSession(date, []));
    const raw = (symbolIndex: number): ResearchBar[] => dates.map((date, id) => ({ id: id + 1 + symbolIndex * 1000, date,
      open: 100 + id / 10, high: 101 + id / 10, low: 99 + id / 10, close: 100 + id / 10,
      volume: id === dates.length - 1 ? 1500 : 1000 }));
    const controls = PARTICIPATION_SYMBOLS.map((_, i) => raw(i));
    const stored = controls.flatMap((bars, i) => bars.map(bar => ({ ...bar, securityId: i + 1, timeframe: 'DAY_1',
      barStartAt: bar.date >= '2026-09-24' ? new Date(`${bar.date}T00:00:00Z`) : etInstant(bar.date, 0),
      provider: bar.date >= '2026-09-24' ? 'TIINGO' : 'MASSIVE', adjustmentMode: 'UNADJUSTED' }))) as unknown as MarketBar[];
    const canonical = validateCanonicalDailyRows(stored, dates[0]!, dates.at(-1)!);
    const seam = PARTICIPATION_SYMBOLS.map((_, i) => canonical.filter(row => row.securityId === i + 1)
      .map(row => ({ id: row.id, date: row.sessionDate, open: Number(row.open), high: Number(row.high),
        low: Number(row.low), close: Number(row.close), volume: Number(row.volume) })));
    expect(seam).toEqual(controls);
    const normalizedControl = controls.slice(0, 2).map(bars => normalizeSplits(bars, [], dates.at(-1)!));
    const normalizedSeam = seam.slice(0, 2).map(bars => normalizeSplits(bars, [], dates.at(-1)!));
    expect(calculateTrendWithThresholds(dates, normalizedSeam[0]!, normalizedSeam[1]!, TREND_V1_THRESHOLDS))
      .toEqual(calculateTrendWithThresholds(dates, normalizedControl[0]!, normalizedControl[1]!, TREND_V1_THRESHOLDS));
    expect(calculateVolatility(dates, normalizedSeam[0]!, normalizedSeam[1]!))
      .toEqual(calculateVolatility(dates, normalizedControl[0]!, normalizedControl[1]!));
    expect(instrumentMeasurements(normalizedSeam[0]!)).toEqual(instrumentMeasurements(normalizedControl[0]!));
    const baselineDates = dates.slice(-21, -1), targetDate = dates.at(-1)!;
    const input = (bars: ResearchBar[][]) => ({ targetDate, baselineDates,
      observations: Object.fromEntries(PARTICIPATION_SYMBOLS.map((symbol, i) => [symbol, bars[i]!.slice(-21).map(bar => ({ date: bar.date, volume: bar.volume }))])) });
    expect(calculateParticipationV1(input(seam))).toEqual(calculateParticipationV1(input(controls)));
  });
});
