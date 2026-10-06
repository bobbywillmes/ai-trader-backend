import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { prisma } from '../db/prisma.js';
import { addDays, datesBetween, etDate, etInstant, marketSession, validDate } from '../services/market-calendar.js';
import { constituentHash } from '../services/security-universe-import.service.js';
import { mean, percentile, stddev } from './breadth-statistics.js';
import { BREADTH_V2_RESEARCH_VERSION, SPLIT_NORMALIZATION_VERSION, HORIZONS, GapShapeAccumulator, bridgeCandidate, compareRawCloses, finalizeBreadth, missingRuns, type Horizon, type ResearchBar } from './breadth-v2-calculation.js';

const csv = (values: readonly (string | number | boolean | null)[]) => values.map(value => value === null ? '' : String(value)).join(',') + '\n';
const ratio = (value: number | null) => value === null ? null : value.toFixed(8);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const sortSymbol = (a: { symbol: string }, b: { symbol: string }) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
const BATCH_SIZE = 100;

export type BreadthV2ResearchInput = { revisionId: number; from: string; through: string; outputDirectory?: string; now?: Date; includeCalibrationEvidence?: boolean };
export async function runBreadthV2Research(input: BreadthV2ResearchInput) {
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(input.revisionId) || input.revisionId < 1 || !validDate(input.from) || !validDate(input.through) || input.from > input.through || input.through > etDate(now)) throw new Error('Valid --revision, --from, and --through are required.');
  if (input.through === etDate(now) && now < etInstant(input.through, 20 * 60 + 15)) throw new Error('The requested current session is not yet complete at 20:15 ET.');
  let warmupFrom = addDays(input.from, -90);
  datesBetween(warmupFrom, input.through); // Bound the research interval through the canonical calendar helper.
  const outputDirectory = input.outputDirectory ?? join('node_modules', '.cache', 'breadth-v2', `revision-${input.revisionId}`, `${input.from}_${input.through}_${now.toISOString().replaceAll(':', '-')}`);
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory); // Refuse to overwrite a previous research run.
  const candidatePath = join(outputDirectory, 'bridge-candidates.csv');
  const securityPath = join(outputDirectory, 'coverage-by-security.csv');
  const gapPath = join(outputDirectory, 'gap-analysis.csv');
  await Promise.all([
    writeFile(candidatePath, 'symbol,targetSession,horizon,expectedAnchorSession,actualAnchorSession,bridgedGapSessions,direction,eligibleBridgeMax1,eligibleBridgeMax2,splitEvidenceComplete\n'),
    writeFile(securityPath, 'symbol,securityId,expectedSessions,tiingoPresent,missing,coverageRatio,terminalNoEodCoverage,retrying,otherProviderCollisions\n'),
    writeFile(gapPath, 'symbol,fromSession,throughSession,lengthSessions,shape,lengthBucket\n'),
  ]);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const revision = await tx.breadthUniverseRevision.findUnique({ where: { id: input.revisionId } });
    if (!revision) throw new Error('Frozen Breadth revision unavailable.');
    const membership = await tx.breadthUniverseRevisionMember.findMany({ where: { revisionId: input.revisionId }, include: { security: { select: { symbol: true, enabled: true } } } });
    if (!membership.length || membership.length !== revision.memberCount || new Set(membership.map(row => row.securityId)).size !== revision.memberCount) throw new Error('Frozen Breadth revision memberCount integrity failure.');
    const members = membership.map(row => ({ securityId: row.securityId, symbol: row.security.symbol, enabled: row.security.enabled })).sort(sortSymbol);
    if (new Set(members.map(row => row.symbol)).size !== members.length) throw new Error('Frozen Breadth revision symbol integrity failure.');
    let exceptions: { sessionDate: string; type: 'CLOSED' | 'EARLY_CLOSE'; closeTimeMinutesEt: number | null }[] = [];
    let sessions: string[] = [];
    while (true) {
      const calendarRows = await tx.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(warmupFrom), lte: new Date(input.through) } }, orderBy: { sessionDate: 'asc' } });
      exceptions = calendarRows.map(row => ({ sessionDate: isoDate(row.sessionDate), type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt }));
      sessions = datesBetween(warmupFrom, input.through).filter(date => marketSession(date, exceptions));
      if (sessions.filter(date => date < input.from).length >= 20) break;
      warmupFrom = addDays(warmupFrom, -90);
      datesBetween(warmupFrom, input.through); // Enforce the canonical 6000-day upper bound.
    }
    const targetSessions = sessions.filter(date => date >= input.from);
    if (!targetSessions.length) throw new Error('No market sessions in the requested range.');
    const sessionIndex = new Map(sessions.map((date, index) => [date, index]));
    const inputHash = createHash('sha256');
    inputHash.update(`revision:${input.revisionId}\ncalendar:${JSON.stringify(exceptions)}\n`);
    const aggregate = new Map<string, { advancing: number; declining: number; unchanged: number }>();
    for (const date of targetSessions) for (const horizon of HORIZONS) aggregate.set(`${date}:${horizon}`, { advancing: 0, declining: 0, unchanged: 0 });
    const stableAggregate = input.includeCalibrationEvidence ? new Map([...aggregate].map(([key]) => [key, { advancing: 0, declining: 0, unchanged: 0 }])) : null;
    let stableCoreMemberCount = 0;
    const sessionCoverage = new Map(targetSessions.map(date => [date, { present: 0, otherProvider: 0, terminal: 0, retrying: 0 }]));
    const bridgeRecovered = { DAY_1: { max1: 0, max2: 0 }, DAY_5: { max1: 0, max2: 0 }, DAY_20: { max1: 0, max2: 0 } };
    const gapCounts = { ONE: 0, TWO: 0, THREE_TO_FIVE: 0, OVER_FIVE: 0, longest: 0 };
    const gapShapeAccumulator = new GapShapeAccumulator();
    const missingBySecurity: { symbol: string; missing: number }[] = [];
    const securityCoverageRatios: number[] = [];
    let tiingoPresent = 0, otherProviderCollisions = 0, terminalNoEodCoverage = 0, retrying = 0, untrackedMissing = 0, disabledMembers = 0;
    for (let offset = 0; offset < members.length; offset += BATCH_SIZE) {
      const batch = members.slice(offset, offset + BATCH_SIZE);
      const ids = batch.map(row => row.securityId);
      const [rows, states] = await Promise.all([
        tx.marketBar.findMany({ where: { securityId: { in: ids }, timeframe: 'DAY_1', barStartAt: { gte: new Date(warmupFrom), lt: new Date(addDays(input.through, 1)) } }, select: { securityId: true, barStartAt: true, close: true, splitFactor: true, provider: true, adjustmentMode: true }, orderBy: [{ securityId: 'asc' }, { barStartAt: 'asc' }] }),
        tx.tiingoDailyObservationState.findMany({ where: { securityId: { in: ids }, sessionDate: { gte: new Date(input.from), lte: new Date(input.through) } }, select: { securityId: true, sessionDate: true, status: true, attemptCount: true }, orderBy: [{ securityId: 'asc' }, { sessionDate: 'asc' }] }),
      ]);
      const rowsBySecurity = new Map<number, typeof rows>();
      for (const row of rows) { const list = rowsBySecurity.get(row.securityId) ?? []; list.push(row); rowsBySecurity.set(row.securityId, list); }
      const statesBySecurity = new Map<number, typeof states>();
      for (const state of states) { const list = statesBySecurity.get(state.securityId) ?? []; list.push(state); statesBySecurity.set(state.securityId, list); }
      const securityLines: string[] = [], gapLines: string[] = [], candidateLines: string[] = [];
      for (const member of batch) {
        if (!member.enabled) disabledMembers++;
        inputHash.update(`security:${member.symbol}:${member.securityId}\n`);
        const bars = new Map<string, ResearchBar>();
        const collisions = new Set<string>();
        for (const row of rowsBySecurity.get(member.securityId) ?? []) {
          const date = isoDate(row.barStartAt);
          if (row.barStartAt.toISOString().slice(11) !== '00:00:00.000Z') throw new Error(`Non-midnight DAY_1 bar for ${member.symbol} ${date}.`);
          inputHash.update(`bar:${date}:${row.provider}:${row.adjustmentMode}:${row.close.toString()}:${row.splitFactor?.toString() ?? 'null'}\n`);
          if (row.provider === 'TIINGO') {
            if (row.adjustmentMode !== 'UNADJUSTED' || !row.splitFactor || !row.splitFactor.isFinite() || row.splitFactor.lte(0) || row.close.lte(0)) throw new Error(`Invalid canonical Tiingo DAY_1 evidence for ${member.symbol} ${date}.`);
            bars.set(date, { close: row.close.toString(), splitFactor: row.splitFactor.toString() });
          } else collisions.add(date);
        }
        const state = new Map((statesBySecurity.get(member.securityId) ?? []).map(row => {
          const date = isoDate(row.sessionDate);
          inputHash.update(`state:${date}:${row.status}:${row.attemptCount}\n`);
          return [date, row.status] as const;
        }));
        let present = 0, collisionCount = 0, terminalCount = 0, retryingCount = 0;
        for (const date of targetSessions) {
          const coverage = sessionCoverage.get(date)!;
          const acquisitionStatus = state.get(date);
          if (bars.has(date)) {
            if (acquisitionStatus && acquisitionStatus !== 'RESOLVED') throw new Error(`Tiingo acquisition state conflicts with a present bar for ${member.symbol} ${date}.`);
            present++; coverage.present++; continue;
          }
          if (acquisitionStatus === 'RESOLVED') throw new Error(`Resolved Tiingo acquisition state has no bar for ${member.symbol} ${date}.`);
          if (collisions.has(date)) { collisionCount++; coverage.otherProvider++; }
          if (acquisitionStatus === 'NO_EOD_COVERAGE') { terminalCount++; coverage.terminal++; }
          if (acquisitionStatus === 'RETRYING') { retryingCount++; coverage.retrying++; }
          if (!acquisitionStatus && !collisions.has(date)) untrackedMissing++;
        }
        tiingoPresent += present; otherProviderCollisions += collisionCount; terminalNoEodCoverage += terminalCount; retrying += retryingCount;
        const missing = targetSessions.length - present;
        const stableCoreMember = stableAggregate !== null && missing === 0;
        if (stableCoreMember) stableCoreMemberCount++;
        missingBySecurity.push({ symbol: member.symbol, missing });
        securityCoverageRatios.push(present / targetSessions.length);
        securityLines.push(csv([member.symbol, member.securityId, targetSessions.length, present, missing, ratio(present / targetSessions.length), terminalCount, retryingCount, collisionCount]));
        for (const run of missingRuns(targetSessions, bars)) { gapCounts[run.lengthBucket]++; gapCounts.longest = Math.max(gapCounts.longest, run.length); gapShapeAccumulator.add(member.symbol, run); gapLines.push(csv([member.symbol, run.from, run.through, run.length, run.shape, run.lengthBucket])); }
        for (const targetDate of targetSessions) {
          const targetIndex = sessionIndex.get(targetDate)!;
          for (const horizon of HORIZONS) {
            const expectedAnchorIndex = targetIndex - horizon;
            const key = `${targetDate}:${horizon}`;
            const strict = expectedAnchorIndex >= 0 ? compareRawCloses(sessions, expectedAnchorIndex, targetIndex, bars) : null;
            if (strict) {
              const counts = aggregate.get(key)!;
              if (strict.direction === 'ADVANCING') counts.advancing++;
              else if (strict.direction === 'DECLINING') counts.declining++;
              else counts.unchanged++;
              if (stableCoreMember) {
                const stable = stableAggregate.get(key)!;
                if (strict.direction === 'ADVANCING') stable.advancing++;
                else if (strict.direction === 'DECLINING') stable.declining++;
                else stable.unchanged++;
              }
              continue;
            }
            if (expectedAnchorIndex < 0) continue;
            const candidate = bridgeCandidate(sessions, expectedAnchorIndex, targetIndex, bars, 2);
            if (!candidate) continue;
            const bucket = bridgeRecovered[`DAY_${horizon}` as keyof typeof bridgeRecovered];
            bucket.max2++;
            const max1 = candidate.bridgedGapSessions <= 1 && bridgeCandidate(sessions, expectedAnchorIndex, targetIndex, bars, 1) !== null;
            if (max1) bucket.max1++;
            candidateLines.push(csv([member.symbol, targetDate, `DAY_${horizon}`, candidate.expectedAnchorSession, candidate.actualAnchorSession, candidate.bridgedGapSessions, candidate.direction, max1, true, false]));
          }
        }
      }
      await Promise.all([appendFile(securityPath, securityLines.join('')), appendFile(gapPath, gapLines.join('')), appendFile(candidatePath, candidateLines.join(''))]);
    }
    const metrics = targetSessions.flatMap(date => HORIZONS.map(horizon => {
      const counts = aggregate.get(`${date}:${horizon}`)!;
      return { sessionDate: date, horizon: `DAY_${horizon}` as `DAY_${Horizon}`, ...finalizeBreadth(members.length, counts.advancing, counts.declining, counts.unchanged) };
    }));
    const stableCoreMetrics = stableAggregate === null ? null : targetSessions.flatMap(date => HORIZONS.map(horizon => {
      const counts = stableAggregate.get(`${date}:${horizon}`)!;
      return { sessionDate: date, horizon: `DAY_${horizon}` as `DAY_${Horizon}`, ...finalizeBreadth(stableCoreMemberCount, counts.advancing, counts.declining, counts.unchanged) };
    }));
    const coverage = targetSessions.map(date => {
      const counts = sessionCoverage.get(date)!;
      return { sessionDate: date, universeCount: members.length, tiingoPresent: counts.present, missing: members.length - counts.present, coverageRatio: members.length ? counts.present / members.length : null, terminalNoEodCoverage: counts.terminal, retrying: counts.retrying, otherProviderCollisions: counts.otherProvider };
    });
    const coverageDistribution = Object.fromEntries([['exact100', (value: number) => value === 1], ['atLeast99_9', (value: number) => value >= 0.999], ['atLeast99_5', (value: number) => value >= 0.995], ['atLeast99', (value: number) => value >= 0.99], ['below99', (value: number) => value < 0.99]].map(([key, predicate]) => {
      const count = coverage.filter(row => (predicate as (value: number) => boolean)(row.coverageRatio ?? 0)).length;
      return [key as string, { count, percent: 100 * count / coverage.length }];
    }));
    const securityCoverageDistribution = Object.fromEntries([['exact100', (value: number) => value === 1], ['atLeast99_9', (value: number) => value >= 0.999], ['atLeast99_5', (value: number) => value >= 0.995], ['atLeast99', (value: number) => value >= 0.99], ['below99', (value: number) => value < 0.99]].map(([key, predicate]) => {
      const count = securityCoverageRatios.filter(value => (predicate as (value: number) => boolean)(value)).length;
      return [key as string, { count, percent: 100 * count / securityCoverageRatios.length }];
    }));
    const statistics = Object.fromEntries(HORIZONS.map(horizon => [`DAY_${horizon}`, Object.fromEntries(['advanceShare', 'netBreadth'].map(metric => {
      const values = metrics.filter(row => row.horizon === `DAY_${horizon}` && row[metric as 'advanceShare' | 'netBreadth'] !== null).map(row => ({ date: row.sessionDate, value: row[metric as 'advanceShare' | 'netBreadth']! }));
      const sorted = values.map(row => row.value).sort((a, b) => a - b);
      const sortedByValue = [...values].sort((a, b) => a.value - b.value || a.date.localeCompare(b.date));
      return [metric, { count: values.length, min: sorted[0] ?? null, p01: percentile(sorted, 0.01), p05: percentile(sorted, 0.05), p10: percentile(sorted, 0.10), p25: percentile(sorted, 0.25), median: percentile(sorted, 0.50), p75: percentile(sorted, 0.75), p90: percentile(sorted, 0.90), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1) ?? null, mean: mean(sorted), standardDeviation: stddev(sorted), lowestDates: sortedByValue.slice(0, 10), highestDates: sortedByValue.slice(-10).reverse() }];
    }))]));
    return { members, targetSessions, metrics, stableCoreMetrics, stableCoreMemberCount, coverage, coverageDistribution, securityCoverageDistribution, statistics, bridgeRecovered, gapCounts, gapShapeSummary: gapShapeAccumulator.summary(),
      totals: { expectedObservations: members.length * targetSessions.length, tiingoBarsPresent: tiingoPresent, missingObservations: members.length * targetSessions.length - tiingoPresent, untrackedMissing, terminalNoEodCoverage, retrying, otherProviderCollisions, disabledMembers },
      mostFrequentlyMissing: missingBySecurity.sort((a, b) => b.missing - a.missing || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)).slice(0, 50),
      constituentHash: constituentHash(members.map(member => member.symbol)), canonicalInputHash: inputHash.digest('hex'), memberCount: revision.memberCount };
  }, { isolationLevel: 'RepeatableRead', timeout: 30 * 60_000 });
  const breadthHeader = 'sessionDate,horizon,universeCount,eligibleCount,excludedCount,coverageRatio,advancingCount,decliningCount,unchangedCount,directionalCount,advanceShare,netBreadth\n';
  await writeFile(join(outputDirectory, 'session-breadth.csv'), breadthHeader + result.metrics.map(row => csv([row.sessionDate, row.horizon, row.universeCount, row.eligibleCount, row.excludedCount, ratio(row.coverageRatio), row.advancingCount, row.decliningCount, row.unchangedCount, row.directionalCount, ratio(row.advanceShare), ratio(row.netBreadth)])).join(''));
  await writeFile(join(outputDirectory, 'coverage-by-session.csv'), 'sessionDate,universeCount,tiingoPresent,missing,coverageRatio,terminalNoEodCoverage,retrying,otherProviderCollisions\n' + result.coverage.map(row => csv([row.sessionDate, row.universeCount, row.tiingoPresent, row.missing, ratio(row.coverageRatio), row.terminalNoEodCoverage, row.retrying, row.otherProviderCollisions])).join(''));
  const summary = { researchVersion: BREADTH_V2_RESEARCH_VERSION, revisionId: input.revisionId, constituentHash: result.constituentHash, canonicalInputHash: result.canonicalInputHash, revisionMemberCount: result.memberCount,
    requestedFrom: input.from, requestedThrough: input.through, actualSessionRange: { from: result.targetSessions[0], through: result.targetSessions.at(-1), count: result.targetSessions.length }, provider: 'TIINGO', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED',
    horizonDefinitions: { DAY_1: 'exactly one previous market session', DAY_5: 'exactly five previous market sessions', DAY_20: 'exactly twenty previous market sessions' }, splitNormalizationVersion: SPLIT_NORMALIZATION_VERSION,
    gapPolicy: 'STRICT', bridgeCandidates: { ...result.bridgeRecovered, note: 'Exploratory only. Missing sessions have unknown split factors; candidate directions use observed factors only and are not production-eligible.' }, survivorshipBias: true,
    dataQuality: { ...result.totals, sessionCoverageDistribution: result.coverageDistribution, securityCoverageDistribution: result.securityCoverageDistribution, gapRuns: result.gapCounts, ...result.gapShapeSummary, mostFrequentlyMissing: result.mostFrequentlyMissing }, distributionStatistics: result.statistics,
    runtime: { generatedAt: now.toISOString() } };
  await writeFile(join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { outputDirectory, summary, ...(input.includeCalibrationEvidence ? { calibrationEvidence: { fullMetrics: result.metrics, stableCoreMetrics: result.stableCoreMetrics!, stableCoreMemberCount: result.stableCoreMemberCount } } : {}) };
}
