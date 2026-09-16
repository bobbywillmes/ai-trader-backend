import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { fetchSplitEvidence } from '../integrations/massive/evidence.client.js';
import { addDays, barEligibility, datesBetween, etDate, etInstant, marketSession, validDate } from './market-calendar.js';
import { calendarExceptions } from './market-calendar.service.js';
import { TREND_DATA_START } from './market-bar-ingestion.service.js';
import { TREND_PRE_ROLL_SESSIONS, TREND_RESEARCH_START, TREND_SYMBOLS } from './trend-lab.config.js';
import { calculateTrend, normalizeSplits, summarizeTrend, TREND_EVIDENCE_SCHEMA_VERSION, TREND_PROFILES, type TrendDay, type TrendProfile } from './trend-calculation.js';

const CACHE_MS = 10 * 60_000;
type Run = Awaited<ReturnType<typeof buildLab>>;
const cache = new Map<string, { expiresAt: number; run: Run }>();
const inflight = new Map<string, Promise<Run>>();
export async function buildLab(from: string, to: string, now = new Date()) {
  if (from < TREND_RESEARCH_START || to > etDate(now) || from > to) throw new HttpError(400, `Research range must start on/after ${TREND_RESEARCH_START}, end on/before today, and be chronological.`);
  datesBetween(TREND_DATA_START, to); // Bound input size, not just displayed size.
  const exceptions = await calendarExceptions(TREND_DATA_START, to);
  const checkpoint = await prisma.setting.findUnique({ where: { key: 'marketDailyEvidenceSync' } });
  const operationalFrom = checkpoint ? (JSON.parse(checkpoint.value) as { fromDate: string }).fromDate : etDate(now);
  const series = await Promise.all(TREND_SYMBOLS.map(async symbol => {
    const security = await prisma.security.findUnique({ where: { symbol }, select: { id: true } });
    if (!security) throw new HttpError(409, `Security ${symbol} is missing.`);
    const rows = await prisma.marketBar.findMany({ where: { securityId: security.id, timeframe: 'DAY_1', barStartAt: { gte: etInstant(TREND_DATA_START, 0), lt: etInstant(addDays(to, 1), 0) } }, orderBy: { barStartAt: 'asc' } });
    const eligible = rows.filter(row => barEligibility('DAY_1', row.barStartAt, now, exceptions).status === 'ELIGIBLE');
    const splits = await fetchSplitEvidence(symbol, eligible[0] ? etDate(eligible[0].barStartAt) : TREND_DATA_START, to);
    const raw = eligible.map(row => ({ id: row.id, date: etDate(row.barStartAt), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }));
    return { symbol, securityId: security.id, splits, bars: normalizeSplits(raw, splits, to), source: { count: raw.length, earliest: raw[0]?.date ?? null, dataThrough: raw.at(-1)?.date ?? null, preRollSessions: raw.filter(row => row.date < from).length, marketBarIds: raw.map(row => row.id) } };
  }));
  const [spy, rsp] = series;
  const dates = new Set(series.flatMap(s => s.bars.map(bar => bar.date)));
  // Historical calendar is deliberately not reconstructed. Current/future expected
  // sessions plus the union of observed historical sessions reveal known gaps.
  if (operationalFrom <= to) for (const date of datesBetween(operationalFrom, to)) if (marketSession(date, exceptions) && barEligibility('DAY_1', etInstant(date, 0), now, exceptions).status === 'ELIGIBLE') dates.add(date);
  const ordered = [...dates].sort();
  const spyByDate = new Map(spy!.bars.map(bar => [bar.date, bar])); const rspByDate = new Map(rsp!.bars.map(bar => [bar.date, bar]));
  const a = ordered.map(date => spyByDate.get(date) ?? null), b = ordered.map(date => rspByDate.get(date) ?? null);
  const profiles = Object.fromEntries((Object.keys(TREND_PROFILES) as TrendProfile[]).map(profile => {
    const days = calculateTrend(ordered, a, b, profile).filter(day => day.date >= from && day.date <= to);
    return [profile, { days, summary: summarizeTrend(days) }];
  })) as Record<TrendProfile, { days: TrendDay[]; summary: ReturnType<typeof summarizeTrend> }>;
  const missing = ordered.filter(date => date >= from && (!spyByDate.has(date) || !rspByDate.has(date)));
  const warnings = ['Historical sessions absent from both instruments cannot be distinguished from holidays without historical calendar exceptions. Statistics cover known sessions only.', 'Research candidates only. No authoritative assessments or trading decisions are written.'];
  if (series.some(s => s.source.preRollSessions < TREND_PRE_ROLL_SESSIONS)) warnings.push(`Insufficient pre-roll: at least ${TREND_PRE_ROLL_SESSIONS} earlier sessions per instrument are recommended. Backfill more history before comparing profiles.`);
  if (series.some(s => s.bars.length === 0)) warnings.push('No stored daily history for one or both instruments. Run owner backfill.');
  for (const s of series) if (s.source.earliest && s.source.earliest > addDays(from, 10)) warnings.push(`${s.symbol} coverage begins ${s.source.earliest}, after requested ${from}. Earlier unknown sessions are not counted as valid or unavailable; check Massive history entitlement.`);
  if (missing.length) warnings.push(`${missing.length} known sessions have incomplete SPY/RSP data; EMA history restarts after a missing input and hysteresis pauses until valid.`);
  const datasetId = createHash('sha256').update(JSON.stringify({ from, to, series, exceptions, operationalFrom, eligibleDates: ordered, evidenceSchemaVersion: TREND_EVIDENCE_SCHEMA_VERSION })).digest('hex');
  return { datasetId, from, to, generatedAt: now.toISOString(), evidenceSchemaVersion: TREND_EVIDENCE_SCHEMA_VERSION, profiles, series, warnings, missingDates: missing, preRollRequired: TREND_PRE_ROLL_SESSIONS };
}
async function resolveRun(from: string, to: string, refresh = false): Promise<Run> {
  if (!validDate(from) || !validDate(to) || from < TREND_RESEARCH_START || to > etDate(new Date()) || from > to) throw new HttpError(400, 'Invalid research date range.');
  const key = `${from}:${to}`; const existing = cache.get(key);
  let run: Run;
  if (!refresh && existing && existing.expiresAt > Date.now()) run = existing.run;
  else {
    let pending = inflight.get(key);
    if (!pending) {
      if (inflight.size >= 2) throw new HttpError(429, 'Two Trend research ranges are already being calculated. Try again shortly.');
      pending = buildLab(from, to); inflight.set(key, pending);
    }
    try { run = await pending; } finally { inflight.delete(key); }
    if (!cache.has(key) && cache.size >= 2) cache.delete(cache.keys().next().value!);
    cache.set(key, { run, expiresAt: Date.now() + CACHE_MS });
  }
  return run;
}
export async function getTrendLab(from: string, to: string, refresh = false) {
  const run = await resolveRun(from, to, refresh);
  const { profiles, series, ...meta } = run;
  const common = new Map(profiles.MIDDLE.days.map(day => [day.date, day]));
  return { ...meta, profiles: Object.fromEntries(Object.entries(profiles).map(([profile, value]) => [profile, { summary: value.summary, timeline: value.days.map(day => ({ date: day.date, status: day.status, rawState: day.rawState, effectiveState: day.effectiveState, transitioned: day.transition.transitioned })) }])),
    series: series.map(s => ({ ...s, bars: s.bars.filter(bar => bar.date >= from).map(bar => { const evidence = common.get(bar.date)?.[s.symbol === 'SPY' ? 'spy' : 'rsp']; return { ...bar, ema10: evidence?.ema10 ?? null, ema20: evidence?.ema20 ?? null, ema50: evidence?.ema50 ?? null }; }) })) };
}
export async function getTrendDay(datasetId: string, profile: TrendProfile, date: string, from: string, to: string) {
  if (!validDate(from) || !validDate(to) || from > to) throw new HttpError(400, 'Invalid research date range.');
  const entry = [...cache.values()].find(value => value.run.datasetId === datasetId && value.expiresAt > Date.now());
  const run = entry?.run ?? await resolveRun(from, to);
  if (run.datasetId !== datasetId || run.from !== from || run.to !== to) throw new HttpError(409, 'Research evidence changed. Refresh the research snapshot before inspecting this date.');
  const day = run.profiles[profile].days.find(value => value.date === date);
  if (!day) throw new HttpError(404, 'No known research session on this date.');
  return { datasetId, profile, evidenceSchemaVersion: TREND_EVIDENCE_SCHEMA_VERSION, ...day };
}
export function clearTrendLabCache() { cache.clear(); }
