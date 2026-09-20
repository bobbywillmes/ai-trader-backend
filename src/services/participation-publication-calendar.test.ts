import { describe, expect, it } from 'vitest';
import { calendarIssue, latestParticipationSession, planParticipationWindow } from './participation-publication-calendar.js';
import { verifiedCalendarRows } from './market-calendar-bootstrap.service.js';
import { etInstant } from './market-calendar.js';

describe('Participation reviewed calendar authority', () => {
  it('requires reviewed early closes even when target itself is a trustworthy full date', () => {
    const incomplete = verifiedCalendarRows.filter(e => e.sessionDate !== '2026-11-27');
    expect(latestParticipationSession(etInstant('2026-11-30', 990), incomplete).date).toBe('2026-11-30');
    expect(planParticipationWindow('2026-11-30', incomplete).calendar.failures).toContainEqual({ sessionDate: '2026-11-27', code: 'MISSING_OR_CONFLICTING_REVIEWED_EXCEPTION' });
    expect(() => latestParticipationSession(etInstant('2026-11-27', 990), incomplete)).toThrow('calendar authority');
  });
  it('checks semantic values rather than mutable names or audit metadata', () => {
    const renamed = verifiedCalendarRows.map(e => ({ ...e, name: 'Different operator description' }));
    expect(planParticipationWindow('2026-11-30', renamed)).toEqual(planParticipationWindow('2026-11-30', verifiedCalendarRows));
    const conflict = verifiedCalendarRows.map(e => e.sessionDate === '2026-11-27' ? { ...e, closeTimeMinutesEt: 800 } : e);
    expect(calendarIssue('2026-11-27', conflict)).toBe('MISSING_OR_CONFLICTING_REVIEWED_EXCEPTION');
  });
  it('excludes early-close/holiday chains from target baselines and next validity', () => {
    const plan = planParticipationWindow('2026-11-25', verifiedCalendarRows);
    expect(plan.next?.date).toBe('2026-11-30'); expect(plan.proposedValidUntil).toEqual(etInstant('2026-11-30', 990));
    const following = planParticipationWindow('2026-11-30', verifiedCalendarRows);
    expect(following.baselineDates).toHaveLength(20); expect(following.baselineDates).not.toContain('2026-11-27'); expect(following.baselineDates).not.toContain('2026-11-26');
  });
  it('rejects duplicate and malformed operator exceptions and out-of-horizon authority', () => {
    expect(calendarIssue('2026-11-27', [...verifiedCalendarRows, verifiedCalendarRows.find(e => e.sessionDate === '2026-11-27')!])).toBe('DUPLICATE_EXCEPTION');
    expect(calendarIssue('2026-09-14', [{ sessionDate: '2026-09-14', type: 'EARLY_CLOSE', closeTimeMinutesEt: 10 }])).toBe('INVALID_EXCEPTION');
    expect(calendarIssue('2027-01-01', [])).toBe('OUTSIDE_REVIEWED_HORIZON');
  });
});
