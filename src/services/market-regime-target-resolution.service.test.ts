import { describe, expect, it } from 'vitest';
import { resolveMarketRegimeExpectedTargets } from './market-regime-target-resolution.service.js';
import type { CalendarException } from './market-calendar.js';

describe('Market Regime expected-target resolution', () => {
  it('resolves daily and intraday publishers independently before, during and after a session', () => {
    const premarket = resolveMarketRegimeExpectedTargets(new Date('2026-10-08T13:00:00Z'), []);
    expect(premarket.sessions).toEqual({
      trend: '2026-10-07', volatility: '2026-10-07', breadth: '2026-10-07',
      participation: '2026-10-07', intradayStress: '2026-10-07',
    });

    const regular = resolveMarketRegimeExpectedTargets(new Date('2026-10-08T14:25:00Z'), []);
    expect(regular.sessions.trend).toBe('2026-10-07');
    expect(regular.sessions.participation).toBe('2026-10-07');
    expect(regular.sessions.intradayStress).toBe('2026-10-08');
    expect(regular.targets.intradayStress.toISOString()).toBe('2026-10-08T14:15:00.000Z');

    const postmarket = resolveMarketRegimeExpectedTargets(new Date('2026-10-08T21:00:00Z'), []);
    expect(postmarket.sessions).toEqual({
      trend: '2026-10-08', volatility: '2026-10-08', breadth: '2026-10-08',
      participation: '2026-10-08', intradayStress: '2026-10-08',
    });
  });

  it('honors weekends, closures, early closes and each publisher grace window', () => {
    const exceptions: CalendarException[] = [
      { sessionDate: '2026-11-26', name: 'Thanksgiving', type: 'CLOSED', closeTimeMinutesEt: null },
      { sessionDate: '2026-11-27', name: 'Thanksgiving Friday', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 },
    ];
    const holiday = resolveMarketRegimeExpectedTargets(new Date('2026-11-26T18:00:00Z'), exceptions);
    expect(new Set(Object.values(holiday.sessions))).toEqual(new Set(['2026-11-25']));

    const beforeGrace = resolveMarketRegimeExpectedTargets(new Date('2026-11-27T18:20:00Z'), exceptions);
    expect(beforeGrace.sessions.trend).toBe('2026-11-25');
    expect(beforeGrace.sessions.breadth).toBe('2026-11-25');
    expect(beforeGrace.sessions.participation).toBe('2026-11-25');
    expect(beforeGrace.sessions.intradayStress).toBe('2026-11-27');

    const afterGrace = resolveMarketRegimeExpectedTargets(new Date('2026-11-27T18:31:00Z'), exceptions);
    expect(afterGrace.sessions.trend).toBe('2026-11-27');
    expect(afterGrace.sessions.breadth).toBe('2026-11-27');
    expect(afterGrace.sessions.participation).toBe('2026-11-25'); // Participation accepts full sessions only.
    expect(afterGrace.sessions.intradayStress).toBe('2026-11-27');

    const weekend = resolveMarketRegimeExpectedTargets(new Date('2026-11-28T18:00:00Z'), exceptions);
    expect(weekend.sessions.trend).toBe('2026-11-27');
    expect(weekend.sessions.participation).toBe('2026-11-25');
  });
});
