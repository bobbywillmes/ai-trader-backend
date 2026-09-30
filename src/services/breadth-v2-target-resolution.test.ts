import { describe, expect, it } from 'vitest';
import { latestEligibleTiingoSession } from './breadth-v2-measurement.service.js';
import type { CalendarException } from './market-calendar.js';

const at = (value: string) => new Date(value);
const closed: CalendarException[] = [{ sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null }];

describe('BREADTH_V2 eligible target resolution', () => {
  it('uses the prior session before 20:15 ET and today at the boundary', () => {
    expect(latestEligibleTiingoSession(at('2026-09-30T13:00:00Z'), [])).toBe('2026-09-29');
    expect(latestEligibleTiingoSession(at('2026-10-01T00:14:59Z'), [])).toBe('2026-09-29');
    expect(latestEligibleTiingoSession(at('2026-10-01T00:15:00Z'), [])).toBe('2026-09-30');
  });
  it('uses the latest eligible Friday on a weekend and before a CLOSED holiday', () => {
    expect(latestEligibleTiingoSession(at('2026-10-03T18:00:00Z'), [])).toBe('2026-10-02');
    expect(latestEligibleTiingoSession(at('2026-09-07T18:00:00Z'), closed)).toBe('2026-09-04');
  });
  it('includes an EARLY_CLOSE session but retains the 20:15 ET Tiingo boundary', () => {
    const early: CalendarException[] = [{ sessionDate: '2026-09-25', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }];
    expect(latestEligibleTiingoSession(at('2026-09-25T22:00:00Z'), early)).toBe('2026-09-24');
    expect(latestEligibleTiingoSession(at('2026-09-26T00:15:00Z'), early)).toBe('2026-09-25');
  });
  it('returns no due target when the reviewed lookback has no eligible session', () => {
    const allClosed: CalendarException[] = [{ sessionDate: '2026-09-30', type: 'CLOSED', closeTimeMinutesEt: null }];
    expect(latestEligibleTiingoSession(at('2026-09-30T13:00:00Z'), allClosed, 0)).toBeNull();
  });
});
