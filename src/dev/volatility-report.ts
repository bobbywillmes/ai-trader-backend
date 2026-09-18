import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { fetchSplitEvidence } from '../integrations/massive/evidence.client.js';
import { barEligibility, datesBetween, etDate, marketSession, type CalendarException } from '../services/market-calendar.js';
import { normalizeSplits } from '../services/trend-calculation.js';
import { calculateVolatility, summarizeVolatility, VOLATILITY_DEFINITION } from '../services/volatility-calculation.js';
import { VOLATILITY_RESEARCH_CALENDAR, volatilityResearchExceptions } from './volatility-research-calendar.js';

/** Research only. PostgreSQL itself prohibits writes while loading the snapshot. */
export async function buildVolatilityReport(now = new Date()) {
  const snapshot = await prisma.$transaction(async db => {
    await db.$executeRaw`SET TRANSACTION READ ONLY`;
    const securities = await db.security.findMany({ where: { symbol: { in: ['SPY', 'RSP'] } }, select: { id: true, symbol: true } });
    if (securities.length !== 2) throw new Error('Stored SPY and RSP securities are required.');
    const rows = await db.marketBar.findMany({ where: { securityId: { in: securities.map(s => s.id) }, timeframe: 'DAY_1' }, orderBy: { barStartAt: 'asc' } });
    const exceptions = await db.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
    return { securities, rows, exceptions };
  }, { isolationLevel: 'RepeatableRead', timeout: 30_000 });
  const storedExceptions: CalendarException[] = snapshot.exceptions.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
  const exceptions = volatilityResearchExceptions(storedExceptions);
  if (snapshot.rows.some(row => etDate(row.barStartAt) < VOLATILITY_RESEARCH_CALENDAR.from || etDate(row.barStartAt) > VOLATILITY_RESEARCH_CALENDAR.to)) throw new Error('Stored history exceeds reviewed research calendar coverage; extend its sourced closure list before running.');
  if (snapshot.rows.some(row => !marketSession(etDate(row.barStartAt), exceptions))) throw new Error('Stored bar conflicts with a calendar closure; resolve evidence before running.');
  const eligible = snapshot.rows.filter(row => barEligibility('DAY_1', row.barStartAt, now, exceptions).status === 'ELIGIBLE');
  const first = eligible[0] ? etDate(eligible[0].barStartAt) : null;
  const last = eligible.at(-1) ? etDate(eligible.at(-1)!.barStartAt) : null;
  if (!first || !last) throw new Error('No completed stored daily history.');
  // Unlike the Trend research union, include absent-both expected sessions.
  // Do not infer a holiday from missing bars or manufacture a previous close.
  const dates = datesBetween(first, last).filter(date => marketSession(date, exceptions));
  const series = await Promise.all((['SPY', 'RSP'] as const).map(async symbol => {
    const security = snapshot.securities.find(s => s.symbol === symbol)!;
    const rows = eligible.filter(row => row.securityId === security.id);
    const raw = rows.map(row => ({ id: row.id, date: etDate(row.barStartAt), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }));
    if (new Set(raw.map(bar => bar.date)).size !== raw.length) throw new Error(`Duplicate ${symbol} daily session.`);
    const splits = await fetchSplitEvidence(symbol, first, last);
    const bars = normalizeSplits(raw, splits, last);
    return { symbol, splits, bars, source: { count: raw.length, first: raw[0]?.date ?? null, last: raw.at(-1)?.date ?? null, marketBarIds: raw.map(bar => bar.id) } };
  }));
  const aligned = series.map(s => {
    const map = new Map(s.bars.map(bar => [bar.date, bar]));
    return dates.map(date => map.get(date) ?? null);
  });
  const days = calculateVolatility(dates, aligned[0]!, aligned[1]!);
  const missingSessions = dates.flatMap((date, i) => {
    const missing = series.filter((_, j) => !aligned[j]![i]).map(s => s.symbol);
    return missing.length ? [{ date, missing }] : [];
  });
  const datasetId = createHash('sha256').update(JSON.stringify({ series, dates, exceptions, definition: VOLATILITY_DEFINITION })).digest('hex');
  return { datasetId, definition: VOLATILITY_DEFINITION,
    source: series.map(({ bars: _bars, ...source }) => source), calendarExceptions: exceptions,
    researchCalendar: VOLATILITY_RESEARCH_CALENDAR,
    missingSessions, summary: summarizeVolatility(days),
    warnings: [
      'Candidate behavior report only. No authoritative assessments, trading writes, or threshold tuning.',
      'Expected sessions use the existing weekday calendar plus sourced research-only NYSE closures and stored operator exceptions. Missing expected sessions, including absent-both gaps, restart affected metrics. Early closes remain sessions.',
      'Each instrument restarts RV and Wilder ATR after its own unusable session. Effective state and confirmation pause until both instruments are valid.',
    ], days };
}
