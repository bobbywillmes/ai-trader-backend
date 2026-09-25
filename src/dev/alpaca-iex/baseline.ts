import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { datesBetween, etDate, etInstant, marketSession, validDate } from '../../services/market-calendar.js';
import { normalizeSplits, type ResearchBar, type ResearchSplit } from '../../services/trend-calculation.js';
import { instrumentMeasurements, VOLATILITY_DEFINITION } from '../../services/volatility-calculation.js';
import { INTRADAY_STRESS_DEFINITION } from '../../services/intraday-stress-calculation.js';
import { researchCalendar } from '../intraday-stress-calendar.js';
import { hash, record, SYMBOLS, type Symbol } from './model.js';
import { massivePages, parseMassiveBar, type Get } from './reference.js';
import { sessionPlan } from './session.js';

export function baselineRange(sessionDate: string) {
  sessionPlan(sessionDate);
  const calendar = researchCalendar([]);
  const previous = datesBetween(new Date(Date.parse(sessionDate) - 10 * 86400_000).toISOString().slice(0, 10), sessionDate).filter(d => d < sessionDate && marketSession(d, calendar)).at(-1)!;
  const from = new Date(Date.parse(previous) - 400 * 86400_000).toISOString().slice(0, 10);
  sessionPlan(datesBetween(from, previous).find(d => marketSession(d, calendar))!);
  return { from, previous, dates: datesBetween(from, previous).filter(d => marketSession(d, calendar)) };
}
export function calculateBaseline(sessionDate: string, daily: Record<Symbol, ResearchBar[]>, splits: Record<Symbol, ResearchSplit[]>) {
  const range = baselineRange(sessionDate);
  const priorAtr14Pct = {} as Record<Symbol, number>;
  for (const symbol of SYMBOLS) {
    if (new Set(daily[symbol].map(b => b.date)).size !== daily[symbol].length || daily[symbol].some(b => !range.dates.includes(b.date))) throw new Error('Invalid daily dates');
    const normalized = new Map(normalizeSplits(daily[symbol], splits[symbol], sessionDate).map(b => [b.date, b]));
    const last = instrumentMeasurements(range.dates.map(d => normalized.get(d) ?? null)).at(-1);
    const value = (last?.ATR14Pct?.value ?? 0) / 100;
    if (!(value > 0)) throw new Error('Prior ATR14 unavailable');
    priorAtr14Pct[symbol] = value;
  }
  return { version: 1, authority: 'RESEARCH_ONLY', provider: 'MASSIVE', sessionDate, calendarHash: sessionPlan(sessionDate).calendarHash,
    ...range, daily, dailyHashes: Object.fromEntries(SYMBOLS.map(s => [s, hash(daily[s])])), splits, priorAtr14Pct,
    calculationVersion: 'INTRADAY_STRESS_V1/VOLATILITY_V1/400-day-prior-window',
    definitionHash: hash({ volatility: VOLATILITY_DEFINITION, intraday: INTRADAY_STRESS_DEFINITION }) };
}
export type Baseline = ReturnType<typeof calculateBaseline>;
export async function fetchBaseline(sessionDate: string, key: string, get: Get) {
  const range = baselineRange(sessionDate);
  const daily = { SPY: [], RSP: [] } as Record<Symbol, ResearchBar[]>;
  const splits = { SPY: [], RSP: [] } as Record<Symbol, ResearchSplit[]>;
  const statuses: { symbol: Symbol; kind: string; status: unknown; fetchedAt: string }[] = [];
  for (const symbol of SYMBOLS) {
    for (const page of await massivePages(`/v2/aggs/ticker/${symbol}/range/1/day/${range.from}/${range.previous}?adjusted=false&sort=asc&limit=50000`, key, get)) {
      if (page.ticker !== symbol || page.adjusted !== false || !Array.isArray(page.results)) throw new Error('Invalid daily response');
      statuses.push({ symbol, kind: 'daily', status: page.status, fetchedAt: new Date().toISOString() });
      for (const row of page.results) {
        if (!record(row) || !Number.isSafeInteger(row.t)) throw new Error('Invalid daily row');
        const date = etDate(new Date(row.t as number));
        if (etInstant(date, 0).getTime() !== row.t) throw new Error('Daily timestamp not ET midnight');
        const b = parseMassiveBar({ ...row, t: new Date(row.t as number).toISOString() }, symbol, '1Min');
        daily[symbol].push({ id: daily[symbol].length + 1, date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
      }
    }
    for (const page of await massivePages(`/stocks/v1/splits?ticker=${symbol}&execution_date.gte=${range.from}&execution_date.lte=${sessionDate}&sort=execution_date.asc&limit=1000`, key, get)) {
      if (!Array.isArray(page.results)) throw new Error('Invalid splits response');
      statuses.push({ symbol, kind: 'splits', status: page.status, fetchedAt: new Date().toISOString() });
      for (const row of page.results) {
        if (!record(row) || row.ticker !== symbol || typeof row.id !== 'string' || typeof row.execution_date !== 'string' || !validDate(row.execution_date)
          || row.execution_date < range.from || row.execution_date > sessionDate || typeof row.split_from !== 'number' || typeof row.split_to !== 'number'
          || !(row.split_from > 0 && row.split_to > 0) || splits[symbol].some(s => s.id === row.id)) throw new Error('Invalid split');
        splits[symbol].push({ id: row.id, executionDate: row.execution_date, splitFrom: row.split_from, splitTo: row.split_to, priceFactor: row.split_from / row.split_to });
      }
    }
  }
  return { ...calculateBaseline(sessionDate, daily, splits), fetchedAt: new Date().toISOString(), statuses,
    calculationHash: hash(await Promise.all(['volatility-calculation.ts', 'trend-calculation.ts', 'intraday-stress-calculation.ts'].map(name => readFile(new URL(`../../services/${name}`, import.meta.url), 'utf8')))) };
}
export async function writeBaseline(runDir: string, baseline: Baseline) {
  const directory = join(runDir, 'reference', 'baseline');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...baseline, contentHash: hash(baseline) }, null, 2) + '\n', { flag: 'wx' });
}
export async function readBaseline(runDir: string): Promise<Baseline> {
  const { contentHash, ...value } = JSON.parse(await readFile(join(runDir, 'reference', 'baseline', 'manifest.json'), 'utf8'));
  if (hash(value) !== contentHash || value.provider !== 'MASSIVE') throw new Error('Baseline hash/provenance mismatch');
  const computed = calculateBaseline(value.sessionDate, value.daily, value.splits);
  if (hash(computed.priorAtr14Pct) !== hash(value.priorAtr14Pct) || computed.definitionHash !== value.definitionHash || computed.calendarHash !== value.calendarHash) throw new Error('Baseline calculation mismatch');
  return value as Baseline;
}
