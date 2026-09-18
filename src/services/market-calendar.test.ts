import { describe, expect, it } from 'vitest';
import { barEligibility, etInstant, marketSession, validDate, type CalendarException } from './market-calendar.js';
const early: CalendarException[] = [{ sessionDate: '2026-11-27', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }];
describe('market calendar and completion boundaries', () => {
  it('validates real dates', () => { expect(validDate('2026-02-30')).toBe(false); expect(validDate('2024-02-29')).toBe(true); });
  it('handles weekends and configured closures', () => {
    expect(marketSession('2026-09-12')).toBeNull();
    expect(marketSession('2026-09-07', [{ sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null }])).toBeNull();
  });
  it('uses Eastern daylight and standard session close', () => {
    expect(marketSession('2026-09-14')?.closeAt.toISOString()).toBe('2026-09-14T20:00:00.000Z');
    expect(marketSession('2026-12-14')?.closeAt.toISOString()).toBe('2026-12-14T21:00:00.000Z');
    expect(marketSession('2026-11-27', early)?.closeAt.toISOString()).toBe('2026-11-27T18:00:00.000Z');
  });
  it('requires the daily 30 minute grace including early close', () => {
    const start = etInstant('2026-11-27', 0);
    expect(barEligibility('DAY_1', start, new Date('2026-11-27T18:29:59Z'), early).status).toBe('NOT_YET_ELIGIBLE');
    expect(barEligibility('DAY_1', start, new Date('2026-11-27T18:30:00Z'), early).status).toBe('ELIGIBLE');
    expect(barEligibility('DAY_1', etInstant('2026-09-14', 0), new Date('2026-09-14T20:29:59Z')).status).toBe('NOT_YET_ELIGIBLE');
  });
  it('requires 15m interval end plus five minutes', () => {
    const start = etInstant('2026-09-14', 570);
    expect(barEligibility('MINUTE_15', start, etInstant('2026-09-14', 589)).status).toBe('NOT_YET_ELIGIBLE');
    expect(barEligibility('MINUTE_15', start, etInstant('2026-09-14', 590)).status).toBe('ELIGIBLE');
    expect(barEligibility('MINUTE_15', etInstant('2026-09-14', 960), etInstant('2026-09-14', 990)).status).toBe('CLOSED');
  });
});
