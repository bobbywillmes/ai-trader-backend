import { configuredTiingoRestClient, type TiingoBar } from '../integrations/tiingo/rest.client.js';
import { addDays, etDate, marketSession, type CalendarException } from './market-calendar.js';
import { calendarExceptions } from './market-calendar.service.js';
import { verifyReferencePrice } from './live-market-data.service.js';
import type { ReferencePriceEvidence } from './live-market-data.contracts.js';
import { DASHBOARD_PRICE_SYMBOLS } from './dashboard-reference-prices.service.js';

type Reason = 'NO_REFERENCE_PRICE' | 'NO_COMPLETED_SESSION' | 'NO_MINUTES' | 'INCOMPLETE_MINUTES' | 'INVALID_MINUTE' | 'PROVIDER_ERROR' | 'MISSING_BASELINE' | 'MISSING_REGULAR_RANGE' | null;
type SessionBars = { sessionDate: string; state: 'PARTIAL' | 'COMPLETE' | 'UNAVAILABLE'; high: number | null; low: number | null;
  close: number | null; observedThrough: string | null; reason: Reason; source: 'TIINGO_REGULAR_MINUTE' };
type Baseline = { sessionDate: string | null; close: number | null; source: 'TIINGO_REGULAR_MINUTE'; reason: Reason };
export type DashboardMarketSymbol = { symbol: typeof DASHBOARD_PRICE_SYMBOLS[number]; referencePrice: ReferencePriceEvidence;
  observationPhase: 'PREMARKET' | 'REGULAR' | 'POSTMARKET' | 'CLOSED' | 'UNKNOWN';
  previousClose: Baseline; regularSession: SessionBars | null;
  change: number | null; changePercent: number | null; changeReason: Reason;
  rangePosition: number | null; rangeReason: Reason };
export type DashboardMarketState = { updatedAt: string; symbols: DashboardMarketSymbol[] };

const validPrice = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;
const minuteSource = 'TIINGO_REGULAR_MINUTE' as const;

/** Stale is still displayable for this dashboard; all other verification rejections remain fatal. */
export function dashboardReferenceValue(row: ReferencePriceEvidence): number | null {
  const observed = row.observedAt ? Date.parse(row.observedAt) : NaN;
  const fetched = Date.parse(row.fetchedAt);
  const acceptedState = row.available && row.freshness === 'FRESH' && row.unavailableReason === null ||
    !row.available && row.freshness === 'STALE' && row.unavailableReason === 'STALE_OBSERVATION';
  return row.provider === 'TIINGO_CONSOLIDATED' &&
    (row.basis === 'TIINGO_TNGO_LAST' || row.basis === 'TIINGO_LQ_REF_PRICE') &&
    validPrice(row.price) && Number.isFinite(observed) && Number.isFinite(fetched) && observed <= fetched &&
    row.providerError === null && acceptedState ? row.price : null;
}

function previousSession(date: string, exceptions: readonly CalendarException[]) {
  for (let i = 1; i <= 20; i++) {
    const candidate = addDays(date, -i);
    if (marketSession(candidate, exceptions)) return candidate;
  }
  return null;
}

/** Strict minute-grid evidence; no synthetic prices and no skipped regular minutes. */
export function summarizeRegularMinutes(date: string, rows: readonly TiingoBar[], exceptions: readonly CalendarException[],
  cutoff: Date, completed: boolean): SessionBars {
  const session = marketSession(date, exceptions);
  if (!session) return { sessionDate: date, state: 'UNAVAILABLE', high: null, low: null, close: null,
    observedThrough: null, reason: 'NO_COMPLETED_SESSION', source: minuteSource };
  const fullCount = (session.closeAt.getTime() - session.openAt.getTime()) / 60_000;
  const eligibleCount = Math.max(0, Math.min(fullCount, Math.floor((cutoff.getTime() - session.openAt.getTime()) / 60_000)));
  const through = session.openAt.getTime() + (completed ? fullCount : eligibleCount) * 60_000;
  const relevant = rows.filter(row => row.barStartAt >= session.openAt && row.barStartAt < session.closeAt && row.barStartAt.getTime() < through)
    .sort((a, b) => a.barStartAt.getTime() - b.barStartAt.getTime());
  const expected = completed ? fullCount : relevant.length ? (relevant.at(-1)!.barStartAt.getTime() - session.openAt.getTime()) / 60_000 + 1 : 0;
  const invalid = relevant.some(row => !Number.isFinite(row.barStartAt.getTime()) ||
    ![row.open, row.high, row.low, row.close].every(value => Number.isFinite(value) && value > 0) ||
    !Number.isFinite(row.volume) || row.volume < 0 || row.low > Math.min(row.open, row.close) ||
    row.high < Math.max(row.open, row.close, row.low));
  const grid = relevant.length === expected && relevant.every((row, index) =>
    row.barStartAt.getTime() === session.openAt.getTime() + index * 60_000);
  const reason: Reason = invalid ? 'INVALID_MINUTE' : expected === 0 || relevant.length === 0 ? 'NO_MINUTES' : !grid ? 'INCOMPLETE_MINUTES' : null;
  if (reason) return { sessionDate: date, state: 'UNAVAILABLE', high: null, low: null, close: null,
    observedThrough: relevant.at(-1)?.barStartAt.toISOString() ?? null, reason, source: minuteSource };
  return { sessionDate: date, state: completed ? 'COMPLETE' : 'PARTIAL',
    high: Math.max(...relevant.map(row => row.high)), low: Math.min(...relevant.map(row => row.low)),
    close: relevant.at(-1)!.close, observedThrough: relevant.at(-1)!.barStartAt.toISOString(), reason: null, source: minuteSource };
}

type Dependencies = { verify?: typeof verifyReferencePrice; calendar?: typeof calendarExceptions;
  minutes?: (symbol: string, date: string) => Promise<TiingoBar[]> };

export async function getDashboardMarketState(now = new Date(), dependencies: Dependencies = {}): Promise<DashboardMarketState> {
  const verify = dependencies.verify ?? verifyReferencePrice;
  let client: ReturnType<typeof configuredTiingoRestClient> | null = null;
  const minutes = dependencies.minutes ?? ((symbol: string, date: string) => {
    client ??= configuredTiingoRestClient();
    return client.intradayHistory(symbol, date, date, { resampleFreq: '1min', afterHours: false });
  });
  const calendar = dependencies.calendar ?? calendarExceptions;
  const symbols = await Promise.all(DASHBOARD_PRICE_SYMBOLS.map(async symbol => {
    const referencePrice = await verify(symbol, 'TIINGO_CONSOLIDATED').catch((): ReferencePriceEvidence => ({
      symbol, provider: 'TIINGO_CONSOLIDATED', price: null, basis: null, observedAt: null,
      fetchedAt: now.toISOString(), freshness: 'UNKNOWN', available: false,
      unavailableReason: 'PROVIDER_ERROR', providerError: 'REQUEST_FAILED',
    }));
    const price = dashboardReferenceValue(referencePrice);
    const unavailable = (reason: Reason): DashboardMarketSymbol => ({ symbol, referencePrice, observationPhase: 'UNKNOWN',
      previousClose: { sessionDate: null, close: null, source: minuteSource, reason }, regularSession: null,
      change: null, changePercent: null, changeReason: reason, rangePosition: null, rangeReason: reason });
    if (price === null || !referencePrice.observedAt) return unavailable('NO_REFERENCE_PRICE');
    try {
      const observation = new Date(referencePrice.observedAt);
      const date = etDate(observation);
      const exceptions = await calendar(addDays(date, -21), date);
      const session = marketSession(date, exceptions);
      const phase = !session ? 'CLOSED' : observation < session.openAt ? 'PREMARKET' : observation < session.closeAt ? 'REGULAR' : 'POSTMARKET';
      const previous = previousSession(date, exceptions);
      const activeDate = session && phase !== 'PREMARKET' ? date : previous;
      const baselineDate = phase === 'POSTMARKET' ? date : previous;
      const dates = [...new Set([activeDate, baselineDate].filter((value): value is string => value !== null))];
      const results = await Promise.all(dates.map(async sessionDate => {
        const completed = sessionDate !== date || phase !== 'REGULAR';
        try { return [sessionDate, summarizeRegularMinutes(sessionDate, await minutes(symbol, sessionDate), exceptions, observation, completed)] as const; }
        catch { return [sessionDate, { sessionDate, state: 'UNAVAILABLE', high: null, low: null, close: null,
          observedThrough: null, reason: 'PROVIDER_ERROR', source: minuteSource } as SessionBars] as const; }
      }));
      const byDate = new Map(results);
      const regularSession = activeDate ? byDate.get(activeDate) ?? null : null;
      const baselineBars = baselineDate ? byDate.get(baselineDate) : null;
      const baseline = baselineBars?.state === 'COMPLETE' && validPrice(baselineBars.close) ? baselineBars.close : null;
      const previousClose: Baseline = { sessionDate: baselineDate, close: baseline, source: minuteSource,
        reason: baseline !== null ? null : baselineBars?.reason ?? 'NO_COMPLETED_SESSION' };
      const change = baseline === null ? null : price - baseline;
      const changePercent = baseline === null ? null : (price / baseline - 1) * 100;
      const rangePrice = regularSession?.close ?? null;
      const high = regularSession?.high ?? null; const low = regularSession?.low ?? null;
      const rangePosition = validPrice(rangePrice) && validPrice(high) && validPrice(low) && high > low
        ? Math.max(0, Math.min(100, (rangePrice - low) / (high - low) * 100)) : null;
      return { symbol, referencePrice, observationPhase: phase, previousClose, regularSession,
        change, changePercent, changeReason: baseline === null ? 'MISSING_BASELINE' : null,
        rangePosition, rangeReason: rangePosition === null ? 'MISSING_REGULAR_RANGE' : null } satisfies DashboardMarketSymbol;
    } catch { return unavailable('PROVIDER_ERROR'); }
  }));
  return { updatedAt: now.toISOString(), symbols };
}
