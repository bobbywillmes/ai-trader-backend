/** Pure coverage diagnostics. Absence is not a claim about provider entitlement. */
import { datesBetween, marketSession, type CalendarException } from '../services/market-calendar.js';
import { fullSessionDates, PARTICIPATION_SYMBOLS, type ParticipationDay, type ParticipationInput } from './participation-calculation.js';

export function compactSessionRanges(expected: readonly string[], selected: ReadonlySet<string>) {
  const ranges: { from: string; to: string; sessions: number }[] = [];
  let current: typeof ranges[number] | undefined;
  for (const date of expected) {
    if (!selected.has(date)) { current = undefined; continue; }
    if (current) { current.to = date; current.sessions++; }
    else { current = { from: date, to: date, sessions: 1 }; ranges.push(current); }
  }
  return ranges;
}
export function participationCoverage(days: readonly ParticipationDay[], from: string, to: string,
  calendar: readonly CalendarException[], rawInput?: ParticipationInput) {
  const expected = fullSessionDates(from, to, calendar), byDate = new Map(days.map(d => [d.date, d]));
  return {
    range: { from, to }, source: rawInput ? 'Validated raw daily observations before split normalization' : 'Existing report target evidence and explicit missing-volume reasons; no raw-cache lookup',
    rangeDefinition: 'Contiguous eligible full sessions; weekends, holidays and early closes do not break ranges.',
    excludedEarlyCloseDates: datesBetween(from, to).filter(d => { const s = marketSession(d, calendar); return s && s.closeMinutes < 960; }),
    etfs: Object.fromEntries(PARTICIPATION_SYMBOLS.map(symbol => {
      const observed = new Set(rawInput ? rawInput[symbol].bars.map(b => b.date) : days.filter(d => d.etfs[symbol]?.normalizedTargetVolume !== null
        && Number.isFinite(d.etfs[symbol]?.normalizedTargetVolume)).map(d => d.date));
      const missing = new Set(expected.filter(date => rawInput ? !observed.has(date) :
        (byDate.get(date)?.etfs[symbol]?.reasons20 ?? []).includes(`TARGET:${date}:MISSING_VOLUME`)));
      const observedDates = [...observed].filter(d => d >= from && d <= to).sort();
      const observedExpected = expected.filter(d => observed.has(d));
      const unknown = expected.filter(d => !observed.has(d) && !missing.has(d));
      return [symbol, { firstObservedDailyEvidenceDate: observedDates[0] ?? null, lastObservedDailyEvidenceDate: observedDates.at(-1) ?? null,
        expectedFullSessionCount: expected.length, observedExpectedSessionCount: observedExpected.length, missingExpectedSessionCount: missing.size,
        missingRanges: compactSessionRanges(expected, missing), unknownEvidenceStatusCount: unknown.length,
        unknownRanges: compactSessionRanges(expected, new Set(unknown)),
        earliestValidRvol20: days.find(d => d.etfs[symbol]?.rvol20 !== null && Number.isFinite(d.etfs[symbol]?.rvol20))?.date ?? null,
        earliestValidRvol40: days.find(d => d.etfs[symbol]?.rvol40 !== null && Number.isFinite(d.etfs[symbol]?.rvol40))?.date ?? null,
        calendarBoundaryWarmup: Object.fromEntries(([20, 40] as const).map(n => {
          const affected = new Set(days.filter(d => (d.etfs[symbol]?.[`reasons${n}`] ?? []).some(r => r.startsWith('INSUFFICIENT_CALENDAR_HISTORY:'))).map(d => d.date));
          return [n, { count: affected.size, ranges: compactSessionRanges(expected, affected) }];
        })) }];
    })),
    panels: Object.fromEntries(([20, 40] as const).map(n => {
      const valid = days.filter(d => d[`panel${n}`]);
      return [n, { firstValidDate: valid[0]?.date ?? null, available: valid.length, unavailable: expected.length - valid.length }];
    })),
  };
}
