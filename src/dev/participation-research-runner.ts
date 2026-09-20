import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addDays, datesBetween, etDate, marketSession, validDate } from '../services/market-calendar.js';
import { researchCalendar } from './intraday-stress-calendar.js';
import { calculateParticipation, DIAGNOSTIC_CUT_POINTS, fullSessionDates, PARTICIPATION_SYMBOLS, summarizeParticipation,
  type ParticipationInput } from './participation-calculation.js';
import { digest, PARTICIPATION_CACHE, ParticipationCache, parseDaily, parseSplits, type Transport } from './participation-research-data.js';

export type ParticipationOptions = { from: string; to: string; fetch: boolean; refresh: boolean; maxRequests: number; output: string; cacheDir: string };
export function parseParticipationArgs(args: string[], now: Date): ParticipationOptions {
  const values = new Map<string, string>(), switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (values.has(key) || switches.has(key)) throw new Error(`Duplicate option: ${key}`);
    if (['--fetch', '--refresh'].includes(key)) switches.add(key);
    else if (['--from', '--to', '--output', '--cache-dir', '--max-requests'].includes(key) && args[i + 1] && !args[i + 1]!.startsWith('--')) values.set(key, args[++i]!);
    else throw new Error(`Unknown option or missing value: ${key}`);
  }
  const calendar = researchCalendar([]);
  let latest = etDate(now) < '2026-12-31' ? etDate(now) : '2026-12-31';
  while (latest >= '2021-01-01') {
    const session = marketSession(latest, calendar);
    if (session?.closeMinutes === 960 && session.closeAt.getTime() + 30 * 60000 <= now.getTime()) break;
    latest = addDays(latest, -1);
  }
  const options = { from: values.get('--from') ?? '2021-01-01', to: values.get('--to') ?? latest,
    fetch: switches.has('--fetch'), refresh: switches.has('--refresh'), maxRequests: Number(values.get('--max-requests') ?? 100),
    cacheDir: values.get('--cache-dir') ?? PARTICIPATION_CACHE, output: values.get('--output') ?? path.join(PARTICIPATION_CACHE, 'report.json') };
  validateOptions(options, now);
  return options;
}
function validateOptions(options: ParticipationOptions, now: Date) {
  if (!validDate(options.from) || !validDate(options.to) || options.from > options.to || options.from < '2021-01-01' || options.to > '2026-12-31') throw new Error('Range must be within reviewed 2021–2026 calendar.');
  if (options.refresh && !options.fetch) throw new Error('--refresh requires --fetch.');
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 300) throw new Error('Request budget must be 1..300.');
  if (!Number.isFinite(now.getTime()) || options.to > etDate(now)) throw new Error('Future/incomplete end date.');
  const calendar = researchCalendar([]), targets = fullSessionDates(options.from, options.to, calendar);
  if (!targets.length) throw new Error('No full-session targets in range.');
  if (marketSession(targets.at(-1)!, calendar)!.closeAt.getTime() + 30 * 60000 > now.getTime()) throw new Error('Latest target is not complete (16:30 ET grace).');
}

export async function runParticipationResearch(options: ParticipationOptions, now: Date, transport: Transport, baseUrl: string) {
  validateOptions(options, now);
  const calendar = researchCalendar([]);
  const history = fullSessionDates('2021-01-01', options.to, calendar);
  const firstTarget = history.findIndex(d => d >= options.from);
  const evidenceFrom = history[Math.max(0, firstTarget - 40)]!;
  const cache = new ParticipationCache(options.cacheDir, options.fetch, options.refresh, options.maxRequests, transport, baseUrl);
  const input = {} as ParticipationInput;
  const providerGaps: { symbol: string; kind: string; from: string; to: string; error: string }[] = [];
  const evidenceManifest: { symbol: string; kind: string; from: string; to: string; digest: string | null; error: string | null }[] = [];
  const ranges: [string, string][] = [];
  for (let year = Number(evidenceFrom.slice(0, 4)); year <= Number(options.to.slice(0, 4)); year++) {
    // Stable full-year starts allow overlap/reuse; never ask beyond requested completed range.
    ranges.push([`${year}-01-01`, `${year}-12-31` < options.to ? `${year}-12-31` : options.to]);
  }
  for (const symbol of PARTICIPATION_SYMBOLS) {
    const bars: ParticipationInput[typeof symbol]['bars'][number][] = [], splits: ParticipationInput[typeof symbol]['splits'][number][] = [];
    const splitErrors: string[] = [];
    for (const [from, to] of ranges) for (const kind of ['daily', 'splits'] as const) {
      const loaded = await cache.load(kind, symbol, from, to);
      let error = loaded.ok ? null : loaded.error;
      if (loaded.ok) {
        try {
          if (kind === 'daily') bars.push(...parseDaily(loaded.evidence, symbol, from, to).map(b => ({ date: b.date, volume: b.v })));
          else splits.push(...parseSplits(loaded.evidence, symbol, from, to));
        } catch (e) { error = e instanceof Error ? e.message : 'INVALID_CACHED_EVIDENCE'; }
      }
      evidenceManifest.push({ symbol, kind, from, to, digest: loaded.ok ? digest(loaded.evidence) : null, error });
      if (error) {
        providerGaps.push({ symbol, kind, from, to, error });
        if (kind === 'splits') splitErrors.push(`${from}/${to}:${error}`);
      }
    }
    input[symbol] = { bars, splits, ...(splitErrors.length ? { splitError: splitErrors.join(';') } : {}) };
  }
  const days = calculateParticipation(input, evidenceFrom, options.from, options.to, calendar);
  const definition = { version: 'participation-research-v1', symbols: PARTICIPATION_SYMBOLS, horizons: [20, 40],
    primary: 'Median of all five continuous RVOL values; equal sensors; direction-neutral.',
    diagnosticCutPoints: DIAGNOSTIC_CUT_POINTS, statesFrozen: false, tradingAuthority: false,
    normalizationThrough: options.to, calendarSource: 'Reviewed researchCalendar([]); no DB/operator calendar lookup.',
    volumeBasis: 'Massive unadjusted daily aggregate volume; full-length session dates only.' };
  const identity = { definition, from: options.from, to: options.to, evidenceFrom, calendar, evidenceManifest };
  const report = { ...identity, datasetId: digest(identity), generatedAt: now.toISOString(),
    actualProviderRequests: cache.requests, cacheHits: cache.hits, requestBudget: options.maxRequests,
    plannedCacheUnits: ranges.length * 10, expectedColdRequestsWithoutPagination: ranges.length * 10,
    excludedEarlyCloseDates: datesBetween(options.from, options.to).filter(d => marketSession(d, calendar)?.closeMinutes === 780),
    providerGaps, days, summary: summarizeParticipation(days),
    limitations: ['Daily aggregates are provider-defined daily evidence, not reconstructed 09:30–16:00-only intraday volume.',
      'ETF volume includes ETF-specific hedging/arbitrage; it is not total underlying-stock participation.',
      'History starts at reviewed 2021 calendar boundary; early targets can lack warmup. No history is invented.',
      'Missing split evidence conservatively invalidates that ETF for the entire requested run.'] };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2));
  return report;
}

export async function participationMain(args: string[]) {
  if (args.includes('--help')) {
    console.log('research:participation [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--fetch] [--refresh] [--max-requests 100] [--output PATH] [--cache-dir PATH]\nDefaults: 2021-01-01 through latest completed full session (reviewed calendar through 2026). Cache-only without --fetch.');
    return;
  }
  const now = new Date(), options = parseParticipationArgs(args, now);
  // Cache-only runs do not load environment/DB/provider modules at all.
  let transport: Transport = async () => { throw new Error('FETCH_DISABLED'); };
  let baseUrl = 'https://api.massive.com';
  if (options.fetch) {
    const [{ massiveEvidenceGet }, { env }] = await Promise.all([import('../integrations/massive/evidence.client.js'), import('../config/env.js')]);
    transport = massiveEvidenceGet; baseUrl = env.MASSIVE_BASE_URL;
  }
  console.log(`Participation research ${options.from}..${options.to}; fetch=${options.fetch}; request cap=${options.maxRequests}.`);
  const report = await runParticipationResearch(options, now, transport, baseUrl);
  console.log(JSON.stringify({ datasetId: report.datasetId, providerRequests: report.actualProviderRequests, cacheHits: report.cacheHits,
    providerGapCount: report.providerGaps.length, targets: report.summary.targetCount,
    panels: Object.fromEntries(Object.entries(report.summary.panels).map(([n, p]) => [n, { available: p.available, unavailable: p.unavailable, distribution: p.distribution }])),
    comparison: report.summary.comparison, output: options.output }, null, 2));
}
