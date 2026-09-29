import { describe, expect, it } from 'vitest';
import { nextTiingoEmptyObservation } from './tiingo-daily-observation.js';

describe('Tiingo successful-empty observation schedule', () => {
  it('schedules 1h, 4h, 24h, then terminal without recycling a manual terminal probe', () => {
    const now = new Date('2026-09-28T21:00:00Z');
    const first = nextTiingoEmptyObservation(null, now);
    expect(first).toEqual({ status: 'RETRYING', attemptCount: 1, nextAttemptAt: new Date('2026-09-28T22:00:00Z') });
    const second = nextTiingoEmptyObservation(first, new Date('2026-09-28T22:00:00Z'));
    expect(second).toEqual({ status: 'RETRYING', attemptCount: 2, nextAttemptAt: new Date('2026-09-29T02:00:00Z') });
    const third = nextTiingoEmptyObservation(second, new Date('2026-09-29T02:00:00Z'));
    expect(third).toEqual({ status: 'RETRYING', attemptCount: 3, nextAttemptAt: new Date('2026-09-30T02:00:00Z') });
    const fourth = nextTiingoEmptyObservation(third, new Date('2026-09-30T02:00:00Z'));
    expect(fourth).toEqual({ status: 'NO_EOD_COVERAGE', attemptCount: 4, nextAttemptAt: null });
    expect(nextTiingoEmptyObservation(fourth, new Date('2026-10-01T02:00:00Z'))).toEqual(fourth);
  });
});
