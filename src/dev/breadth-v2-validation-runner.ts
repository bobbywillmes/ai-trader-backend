import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../db/prisma.js';
import { addDays, datesBetween, marketSession } from '../services/market-calendar.js';
import { BREADTH_V2_CALIBRATION_VERSION, type CandidateDay, type Family } from './breadth-v2-calibration.js';
import { runBreadthV2Calibration, type CalibrationInput } from './breadth-v2-calibration-runner.js';
import { BREADTH_V2_VALIDATION_VERSION, FORWARD_HORIZONS, VALIDATION_FAMILIES, benchmarkOutcomes, candidateDisagreements, outcomeStatistics, regimeEntries, transitionEvents, type Benchmark, type BenchmarkBar, type BenchmarkCoverage, type BenchmarkSplit, type Outcome } from './breadth-v2-validation.js';

type ValidationInput = CalibrationInput;
const benchmarks = ['SPY', 'RSP'] as const;
const states = ['POSITIVE', 'MIXED', 'NEGATIVE'] as const;
const csv = (values: readonly (string | number | boolean | null)[]) => values.map(value => value === null ? '' : String(value)).join(',') + '\n';
const iso = (date: Date) => date.toISOString().slice(0, 10);
const stats = (rows: readonly Outcome[]) => outcomeStatistics(rows);

export async function runBreadthV2Validation(input: ValidationInput) {
  const now = input.now ?? new Date();
  const outputDirectory = input.outputDirectory ?? join('node_modules', '.cache', 'breadth-v2-validation', `revision-${input.revisionId}`, `${input.from}_${input.through}_${input.calibrationThrough}_${now.toISOString().replaceAll(':', '-')}`);
  await mkdir(outputDirectory, { recursive: true });
  const calibration = await runBreadthV2Calibration({ ...input, now, outputDirectory: join(outputDirectory, 'phase5b-frozen'), includeValidationEvidence: true });
  if (calibration.summary.researchVersion !== BREADTH_V2_CALIBRATION_VERSION || calibration.summary.phase5aResearchVersion !== 'BREADTH_V2_RESEARCH_5A_V2' || calibration.summary.gapPolicy !== 'STRICT') throw new Error('Phase 5B research identity changed.');
  const evidence = calibration.validationEvidence!;
  const days = evidence.mildDays;
  if (days.some(day => day.variant !== 'MILD_POSITIVE_MIXED_CONFIRMATION')) throw new Error('Phase 5C candidate set changed.');
  const targetSessions = [...new Set(evidence.fullMetrics.map(row => row.sessionDate))];
  const end = addDays(input.through, 45);
  const loaded = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const securities = await tx.security.findMany({ where: { symbol: { in: [...benchmarks] } }, select: { id: true, symbol: true } });
    if (securities.length !== 2) throw new Error('Both canonical SPY and RSP Securities are required for Phase 5C.');
    const ids = securities.map(row => row.id);
    const [calendar, bars, events, coverages] = await Promise.all([
      tx.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(input.from), lte: new Date(end) } }, orderBy: { sessionDate: 'asc' } }),
      tx.marketBar.findMany({ where: { securityId: { in: ids }, timeframe: 'DAY_1', barStartAt: { gte: new Date(input.from), lt: new Date(addDays(end, 1)) } }, select: { securityId: true, barStartAt: true, close: true, splitFactor: true, provider: true, adjustmentMode: true }, orderBy: [{ securityId: 'asc' }, { barStartAt: 'asc' }] }),
      tx.marketSplitEvent.findMany({ where: { securityId: { in: ids }, executionDate: { gte: new Date(input.from), lte: new Date(end) } }, select: { securityId: true, executionDate: true, splitFactor: true, provider: true }, orderBy: [{ securityId: 'asc' }, { executionDate: 'asc' }] }),
      tx.marketSplitCoverage.findMany({ where: { securityId: { in: ids }, fromDate: { lte: new Date(end) }, throughDate: { gte: new Date(input.from) } }, select: { securityId: true, fromDate: true, throughDate: true, provider: true }, orderBy: [{ securityId: 'asc' }, { fromDate: 'asc' }] }),
    ]);
    const exceptions = calendar.map(row => ({ sessionDate: iso(row.sessionDate), type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt }));
    const sessions = datesBetween(input.from, end).filter(date => marketSession(date, exceptions));
    if (JSON.stringify(sessions.filter(date => date <= input.through)) !== JSON.stringify(targetSessions)) throw new Error('Benchmark and breadth market-session calendars differ.');
    const bySymbol = Object.fromEntries(benchmarks.map(symbol => {
      const id = securities.find(row => row.symbol === symbol)!.id;
      const selectedBars: BenchmarkBar[] = bars.filter(row => row.securityId === id).map(row => {
        if (row.barStartAt.toISOString().slice(11) !== '00:00:00.000Z' || row.adjustmentMode !== 'UNADJUSTED') throw new Error(`Invalid canonical ${symbol} DAY_1 benchmark evidence.`);
        return { date: iso(row.barStartAt), close: row.close.toString(), splitFactor: row.splitFactor?.toString() ?? null, provider: row.provider };
      });
      const selectedEvents: BenchmarkSplit[] = events.filter(row => row.securityId === id).map(row => ({ date: iso(row.executionDate), factor: row.splitFactor.toString(), provider: row.provider }));
      const selectedCoverages: BenchmarkCoverage[] = coverages.filter(row => row.securityId === id).map(row => ({ from: iso(row.fromDate), through: iso(row.throughDate), provider: row.provider }));
      return [symbol, { securityId: id, bars: selectedBars, events: selectedEvents, coverages: selectedCoverages }];
    })) as Record<Benchmark, { securityId: number; bars: BenchmarkBar[]; events: BenchmarkSplit[]; coverages: BenchmarkCoverage[] }>;
    return { sessions, bySymbol, calendar: exceptions };
  }, { isolationLevel: 'RepeatableRead', timeout: 60_000 });
  const benchmarkInputHash = createHash('sha256').update(JSON.stringify(loaded)).digest('hex');
  const outcomes = benchmarks.flatMap(symbol => benchmarkOutcomes(loaded.sessions, symbol, loaded.bySymbol[symbol].bars, loaded.bySymbol[symbol].events, loaded.bySymbol[symbol].coverages).filter(row => row.sessionDate <= input.through));
  const outcomeMap = new Map(outcomes.map(row => [`${row.sessionDate}:${row.benchmark}:${row.horizon}`, row]));
  const get = (date: string, symbol: Benchmark, horizon: number) => outcomeMap.get(`${date}:${symbol}:${horizon}`)!;
  const periods = [{ label: 'VALIDATION', from: calibration.summary.validationFrom, through: input.through }, { label: 'CALIBRATION', from: input.from, through: input.calibrationThrough }, { label: 'FULL', from: input.from, through: input.through }, ...[...new Set(targetSessions.map(date => date.slice(0, 4)))].map(year => ({ label: year, from: `${year}-01-01`, through: `${year}-12-31` }))];
  const sample = (dates: readonly string[], symbol: Benchmark, horizon: number) => dates.map(date => get(date, symbol, horizon));
  type StateRow = { period: string; family: Family; view: 'ALL_SESSIONS' | 'REGIME_ENTRIES'; state: typeof states[number]; benchmark: Benchmark; horizon: number } & ReturnType<typeof outcomeStatistics>;
  const stateRows: StateRow[] = [], entryRows: StateRow[] = [];
  const transitionRows: ({ period: string; family: Family; transition: string; benchmark: Benchmark; horizon: number } & ReturnType<typeof outcomeStatistics>)[] = [];
  const disagreementRows: ({ period: string; category: string; benchmark: Benchmark; horizon: number } & ReturnType<typeof outcomeStatistics>)[] = [];
  const pairwiseRows: { period: string; family: Family; view: 'ALL_SESSIONS' | 'REGIME_ENTRIES'; benchmark: Benchmark; horizon: number; positiveMinusNegativeMedianReturn: number | null; mixedMinusNegativeMedianReturn: number | null; positiveMinusNegativeMedianMaxDrawdown: number | null; mixedMinusNegativeMedianMaxDrawdown: number | null }[] = [];
  for (const period of periods) for (const family of VALIDATION_FAMILIES) {
    const familyDays = days.filter(day => day.family === family && day.sessionDate >= period.from && day.sessionDate <= period.through);
    const entries = regimeEntries(days.filter(day => day.family === family)).filter(day => day.sessionDate >= period.from && day.sessionDate <= period.through);
    const transitions = transitionEvents(days.filter(day => day.family === family)).filter(day => day.sessionDate >= period.from && day.sessionDate <= period.through);
    for (const view of ['ALL_SESSIONS', 'REGIME_ENTRIES'] as const) for (const state of states) for (const symbol of benchmarks) for (const horizon of FORWARD_HORIZONS) {
      const dates = (view === 'ALL_SESSIONS' ? familyDays : entries).filter(day => day.effectiveState === state).map(day => day.sessionDate);
      const row = { period: period.label, family, view, state, benchmark: symbol, horizon, ...stats(sample(dates, symbol, horizon)) };
      (view === 'ALL_SESSIONS' ? stateRows : entryRows).push(row);
    }
    for (const category of ['POSITIVE -> MIXED', 'MIXED -> NEGATIVE', 'NEGATIVE -> MIXED', 'MIXED -> POSITIVE']) for (const symbol of benchmarks) for (const horizon of FORWARD_HORIZONS) {
      const dates = transitions.filter(day => day.transition === category).map(day => day.sessionDate);
      transitionRows.push({ period: period.label, family, transition: category, benchmark: symbol, horizon, ...stats(sample(dates, symbol, horizon)) });
    }
  }
  const disagreements = candidateDisagreements(days);
  const categories = ['ALL_AGREE', 'NARROW_DIRECTIONAL_ONLY', 'NARROW_TERTILE_DIRECTIONAL', 'QUARTILE_DIRECTIONAL_ONLY', 'OTHER_NON_OPPOSITE', 'OPPOSITE_DIRECTIONAL', 'UNAVAILABLE'];
  for (const period of periods) for (const category of categories) for (const symbol of benchmarks) for (const horizon of FORWARD_HORIZONS) {
    disagreementRows.push({ period: period.label, category, benchmark: symbol, horizon, ...stats(sample(disagreements.filter(row => row.category === category && row.sessionDate >= period.from && row.sessionDate <= period.through).map(row => row.sessionDate), symbol, horizon)) });
  }
  for (const period of periods) for (const family of VALIDATION_FAMILIES) for (const view of ['ALL_SESSIONS', 'REGIME_ENTRIES'] as const) for (const symbol of benchmarks) for (const horizon of FORWARD_HORIZONS) {
    const rows = (view === 'ALL_SESSIONS' ? stateRows : entryRows).filter(row => row.period === period.label && row.family === family && row.view === view && row.benchmark === symbol && row.horizon === horizon);
    const find = (state: string) => rows.find(row => row.state === state);
    const difference = (metric: 'medianReturn' | 'medianMaxDrawdown', left: string, right: string) => {
      const a = find(left)?.[metric], b = find(right)?.[metric]; return a === null || a === undefined || b === null || b === undefined ? null : a - b;
    };
    pairwiseRows.push({ period: period.label, family, view, benchmark: symbol, horizon, positiveMinusNegativeMedianReturn: difference('medianReturn', 'POSITIVE', 'NEGATIVE'), mixedMinusNegativeMedianReturn: difference('medianReturn', 'MIXED', 'NEGATIVE'), positiveMinusNegativeMedianMaxDrawdown: difference('medianMaxDrawdown', 'POSITIVE', 'NEGATIVE'), mixedMinusNegativeMedianMaxDrawdown: difference('medianMaxDrawdown', 'MIXED', 'NEGATIVE') });
  }
  const csvStats = (row: ReturnType<typeof outcomeStatistics>) => [row.sampleCount, row.meanReturn, row.medianReturn, row.p10Return, row.p25Return, row.p75Return, row.p90Return, row.positiveReturnRate, row.meanMaxDrawdown, row.medianMaxDrawdown, row.meanMaxGain, row.medianMaxGain] as const;
  const statsHeader = 'sampleCount,meanReturn,medianReturn,p10Return,p25Return,p75Return,p90Return,positiveReturnRate,meanMaxDrawdown,medianMaxDrawdown,meanMaxGain,medianMaxGain';
  const benchmarkProvenance = Object.fromEntries(benchmarks.map(symbol => {
    const rows = loaded.bySymbol[symbol].bars;
    const providers = Object.fromEntries(['MASSIVE', 'TIINGO'].map(provider => [provider, rows.filter(row => row.provider === provider).length]));
    const seams = rows.filter((row, i) => i > 0 && row.provider !== rows[i - 1]!.provider).map(row => ({ atSession: row.date, newProvider: row.provider }));
    const byHorizon = Object.fromEntries(FORWARD_HORIZONS.map(h => [String(h), { available: outcomes.filter(row => row.benchmark === symbol && row.horizon === h && row.forwardReturn !== null).length, unavailableReasons: Object.fromEntries([...new Set(outcomes.filter(row => row.benchmark === symbol && row.horizon === h && row.unavailableReason !== null).map(row => row.unavailableReason!))].sort().map(reason => [reason, outcomes.filter(row => row.benchmark === symbol && row.horizon === h && row.unavailableReason === reason).length])) }]));
    return [symbol, { securityId: loaded.bySymbol[symbol].securityId, providerBarCounts: providers, providerSeams: seams, targetBarsPresent: targetSessions.filter(date => rows.some(row => row.date === date)).length, targetSessions: targetSessions.length, byHorizon }];
  }));
  const contextUnavailable = { status: 'UNAVAILABLE_EXACT_REPLAY_NOT_INTEGRATED', reason: 'Production effective-state replay depends on publisher bootstrap, predecessor continuation, reviewed calendar, and persisted split-coverage semantics. Phase 5C does not approximate these histories.' };
  const validationRows = stateRows.filter(row => row.period === 'VALIDATION');
  const summary = { researchVersion: BREADTH_V2_VALIDATION_VERSION, phase5aResearchVersion: calibration.summary.phase5aResearchVersion, phase5bResearchVersion: calibration.summary.researchVersion,
    canonicalInputHash: calibration.summary.canonicalInputHash, constituentHash: calibration.summary.constituentHash, benchmarkInputHash, revisionId: input.revisionId, revisionMemberCount: calibration.summary.revisionMemberCount,
    requestedFrom: input.from, requestedThrough: input.through, calibrationThrough: input.calibrationThrough, validationFrom: calibration.summary.validationFrom,
    breadthProvider: 'TIINGO', breadthAdjustmentMode: 'UNADJUSTED', splitNormalizationVersion: calibration.summary.splitNormalizationVersion, gapPolicy: 'STRICT', survivorshipBias: true,
    candidateFamilies: VALIDATION_FAMILIES, hysteresisCandidate: 'MILD_POSITIVE_MIXED_CONFIRMATION', frozenThresholds: calibration.summary.thresholds, thresholdDerivation: calibration.summary.thresholdDerivation, structuralAggregation: calibration.summary.structuralAggregation,
    benchmarkProvenance, benchmarkSplitEvidence: { TIINGO: 'MarketBar.splitFactor', MASSIVE: 'MarketSplitEvent plus MarketSplitCoverage' }, benchmarkReturnSemantics: 'Split-normalized raw closing-price returns; excludes dividends and is not total return or trading P&L.',
    validation: { stateOutcomes: validationRows, regimeEntryOutcomes: entryRows.filter(row => row.period === 'VALIDATION'), transitionOutcomes: transitionRows.filter(row => row.period === 'VALIDATION'), disagreementOutcomes: disagreementRows.filter(row => row.period === 'VALIDATION'), pairwiseStateSeparation: pairwiseRows.filter(row => row.period === 'VALIDATION'), disagreementCounts: Object.fromEntries(categories.map(category => [category, disagreements.filter(row => row.sessionDate >= calibration.summary.validationFrom && row.category === category).length])) },
    disagreementCountsFull: Object.fromEntries(categories.map(category => [category, disagreements.filter(row => row.category === category).length])), oppositeDirectionalCases: disagreements.filter(row => row.oppositeDirectional),
    trendContext: contextUnavailable, volatilityContext: contextUnavailable,
    limitations: ['Historical association research; breadth does not establish causes of future returns, drawdowns, Trend, or Volatility.', 'Forward windows overlap and daily states are serially dependent; reported samples are not independent observations.', 'REGIME_ENTRIES reduces run-length weighting but its forward windows can still overlap.', 'Breadth and benchmark read-only snapshots are separate; both input hashes and matching target-session calendars are recorded.', 'Unavailable benchmark windows are excluded from outcome statistics and reported by reason.', 'No candidate ranking, threshold adjustment, trading return, or production authority.'],
    runtime: { generatedAt: now.toISOString() } };
  await Promise.all([
    writeFile(join(outputDirectory, 'benchmark-outcomes.csv'), 'sessionDate,benchmark,provider,horizon,forwardReturn,forwardMaxDrawdown,forwardMaxGain,rspMinusSpyReturn,unavailableReason\n' + targetSessions.flatMap(date => benchmarks.flatMap(symbol => FORWARD_HORIZONS.map(h => { const row = get(date, symbol, h), spy = get(date, 'SPY', h), rsp = get(date, 'RSP', h); return csv([date, symbol, row.provider, h, row.forwardReturn, row.forwardMaxDrawdown, row.forwardMaxGain, spy.forwardReturn !== null && rsp.forwardReturn !== null ? rsp.forwardReturn - spy.forwardReturn : null, row.unavailableReason]); }))).join('')),
    writeFile(join(outputDirectory, 'state-outcomes.csv'), `period,thresholdFamily,samplingView,breadthState,benchmark,horizon,${statsHeader}\n` + stateRows.map(row => csv([row.period, row.family, row.view, row.state, row.benchmark, row.horizon, ...csvStats(row)])).join('')),
    writeFile(join(outputDirectory, 'regime-entry-outcomes.csv'), `period,thresholdFamily,samplingView,breadthState,benchmark,horizon,${statsHeader}\n` + entryRows.map(row => csv([row.period, row.family, row.view, row.state, row.benchmark, row.horizon, ...csvStats(row)])).join('')),
    writeFile(join(outputDirectory, 'transition-outcomes.csv'), `period,thresholdFamily,transition,benchmark,horizon,${statsHeader}\n` + transitionRows.map(row => csv([row.period, row.family, row.transition, row.benchmark, row.horizon, ...csvStats(row)])).join('')),
    writeFile(join(outputDirectory, 'candidate-disagreements.csv'), 'sessionDate,category,direction,quartile,tertile,narrow,oppositeDirectional\n' + disagreements.map(row => csv([row.sessionDate, row.category, row.direction, row.quartile, row.tertile, row.narrow, row.oppositeDirectional])).join('')),
    writeFile(join(outputDirectory, 'disagreement-outcomes.csv'), `period,category,benchmark,horizon,${statsHeader}\n` + disagreementRows.map(row => csv([row.period, row.category, row.benchmark, row.horizon, ...csvStats(row)])).join('')),
    writeFile(join(outputDirectory, 'pairwise-state-separation.csv'), 'period,thresholdFamily,samplingView,benchmark,horizon,positiveMinusNegativeMedianReturn,mixedMinusNegativeMedianReturn,positiveMinusNegativeMedianMaxDrawdown,mixedMinusNegativeMedianMaxDrawdown\n' + pairwiseRows.map(row => csv([row.period, row.family, row.view, row.benchmark, row.horizon, row.positiveMinusNegativeMedianReturn, row.mixedMinusNegativeMedianReturn, row.positiveMinusNegativeMedianMaxDrawdown, row.mixedMinusNegativeMedianMaxDrawdown])).join('')),
    writeFile(join(outputDirectory, 'trend-context.csv'), 'status,reason\n' + csv([contextUnavailable.status, contextUnavailable.reason])),
    writeFile(join(outputDirectory, 'volatility-context.csv'), 'status,reason\n' + csv([contextUnavailable.status, contextUnavailable.reason])),
  ]);
  await writeFile(join(outputDirectory, 'validation-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { outputDirectory, summary };
}
