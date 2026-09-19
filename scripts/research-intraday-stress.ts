import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { prisma } from '../src/db/prisma.js';
import { addDays, etDate, marketSession, validDate } from '../src/services/market-calendar.js';
import { researchCalendar } from '../src/dev/intraday-stress-calendar.js';
import { CACHE, cached, fetchBars, splits, months, measureHistory, digest, requests } from '../src/dev/intraday-stress-data.js';
import type { Symbol, Bar } from '../src/dev/intraday-stress-calculation.js';

const fetch = process.argv.includes('--fetch');
const challengers = process.argv.includes('--challengers');
const dailyOnly = process.argv.includes('--daily-only');
const flag = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
await mkdir(CACHE, { recursive: true });
try {
  const snapshot = await cached('database-snapshot', async () => prisma.$transaction(async db => {
    await db.$executeRaw`SET TRANSACTION READ ONLY`;
    return { exceptions: (await db.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } })).map(x => ({ sessionDate: x.sessionDate.toISOString().slice(0, 10), type: x.type, closeTimeMinutesEt: x.closeTimeMinutesEt, name: x.name })),
      counts: await db.marketBar.groupBy({ by: ['timeframe'], _count: true, _min: { barStartAt: true }, _max: { barStartAt: true } }) };
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 }), true);
  if (!snapshot.ok) throw new Error(snapshot.error);
  const storedDaily = await cached('stored-daily', async () => prisma.$transaction(async db => {
    await db.$executeRaw`SET TRANSACTION READ ONLY`;
    const rows = await db.marketBar.findMany({ where: { timeframe: 'DAY_1', security: { symbol: { in: ['SPY', 'RSP'] } } }, include: { security: { select: { symbol: true } } }, orderBy: { barStartAt: 'asc' } });
    return rows.map(b => {
      if (b.provider !== 'MASSIVE' || b.adjustmentMode !== 'UNADJUSTED') throw new Error('Unexpected stored daily evidence provenance.');
      return { symbol: b.security.symbol as Symbol, timeframe: 'DAY_1' as const, t: b.barStartAt.getTime(), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) };
    });
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 }), true);
  if (!storedDaily.ok) throw new Error(storedDaily.error);
  const calendar = researchCalendar(snapshot.value.exceptions);
  let latest = etDate(new Date());
  while (!marketSession(latest, calendar) || marketSession(latest, calendar)!.closeAt.getTime() + 30 * 60000 > Date.now()) latest = addDays(latest, -1);
  const to = flag('--to') ?? latest;
  if (!validDate(to) || to > latest || to > '2026-12-31' || to < '2021-01-01') throw new Error('End date outside complete-session/reviewed-calendar boundary.');
  const symbols: Symbol[] = challengers ? ['QQQ', 'IWM'] : ['SPY', 'RSP'];
  const selection = challengers && !dailyOnly ? JSON.parse(await readFile(`${CACHE}/challenge-dates.json`, 'utf8')) as string[] : [];
  if (selection.length > 100) throw new Error('Diagnostic sample exceeds 100 sessions.');
  const output: Record<string, unknown> = {};
  for (const symbol of symbols) {
    console.log(`Loading ${symbol}; cache-first, provider fetch=${fetch}.`);
    const daily: Bar[] = [], intraday: Bar[] = [], failures: unknown[] = [];
    // Yearly daily requests isolate entitlement failures in early history.
    for (let year = 2021; year <= Number(to.slice(0, 4)); year++) {
      const from = `${year}-01-01`, end = `${year}-12-31` < to ? `${year}-12-31` : to;
      const r = await cached(`${symbol}-DAY_1-${from}-${end}`, () => fetchBars(symbol, 'DAY_1', from, end), fetch);
      if (r.ok) daily.push(...r.value); else failures.push({ from, to: end, timeframe: 'DAY_1', error: r.error });
    }
    const dailyConflicts: { date: string; fields: string[] }[] = [];
    for (const stored of storedDaily.value.filter(b => b.symbol === symbol && etDate(new Date(b.t)) <= to)) {
      const i = daily.findIndex(b => b.t === stored.t);
      if (i < 0) daily.push(stored);
      else {
        const fields = (['open', 'high', 'low', 'close', 'volume'] as const).filter(k => Math.abs(daily[i]![k] - stored[k]) > 1e-8);
        if (fields.length) dailyConflicts.push({ date: etDate(new Date(stored.t)), fields });
        daily[i] = stored; // Immutable stored observations own overlapping dates; revisions remain diagnostics.
      }
    }
    daily.sort((a, b) => a.t - b.t);
    const splitResult = await cached(`${symbol}-splits-2021-01-01-${to}`, () => splits(symbol, '2021-01-01', to), fetch);
    if (!splitResult.ok) throw new Error(`${symbol}: split evidence unavailable: ${splitResult.error}`);
    const ranges = dailyOnly ? [] : challengers ? selection.map(d => [d, d] as [string, string]) : months('2021-01-01', to);
    for (const [from, end] of ranges) {
      const r = await cached(`${symbol}-MINUTE_15-${from}-${end}`, () => fetchBars(symbol, 'MINUTE_15', from, end), fetch);
      if (r.ok) intraday.push(...r.value); else failures.push({ from, to: end, timeframe: 'MINUTE_15', error: r.error });
      console.log(`${symbol} ${from}: ${r.ok ? r.value.length + ' bars' : r.error}`);
    }
    const measured = measureHistory(symbol, daily, intraday, splitResult.value, '2021-01-01', to, calendar);
    if (challengers) measured.targets = measured.targets.filter(t => selection.includes(t.date));
    output[symbol] = { daily, ...measured, splits: splitResult.value, failures, dailyConflicts, rawDigest: digest({ daily, intraday, splits: splitResult.value }), intradayCount: intraday.length };
  }
  const result = { requestedFrom: '2021-01-01', requestedTo: to, calendar, snapshot: snapshot.value, generatedAt: new Date().toISOString(), requests, symbols: output };
  await writeFile(`${CACHE}/${dailyOnly ? 'diagnostic-daily' : challengers ? 'challengers' : 'measurements'}.json`, JSON.stringify(result));
  console.log(`Saved ${challengers ? 'challengers' : 'measurements'}.json; ${requests} provider requests.`);
} finally { await prisma.$disconnect(); }
