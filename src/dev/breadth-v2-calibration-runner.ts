import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BREADTH_V2_RESEARCH_VERSION, SPLIT_NORMALIZATION_VERSION } from './breadth-v2-calculation.js';
import { runBreadthV2Research } from './breadth-v2-research.js';
import { BREADTH_V2_CALIBRATION_VERSION, HYSTERESIS_VARIANTS, THRESHOLD_FAMILIES, buildCandidateDays, coverageDiagnostics, deriveBands, periodSummary, sensitivity, validationStability, type Family } from './breadth-v2-calibration.js';

const csv = (values: readonly (string | number | null)[]) => values.map(value => value === null ? '' : String(value)).join(',') + '\n';
export type CalibrationInput = { revisionId: number; from: string; through: string; calibrationThrough: string; outputDirectory?: string; expectedInputHash?: string; now?: Date; includeValidationEvidence?: boolean };

export async function runBreadthV2Calibration(input: CalibrationInput) {
  if (input.calibrationThrough < input.from || input.calibrationThrough >= input.through || !/^\d{4}-\d{2}-\d{2}$/.test(input.calibrationThrough)) throw new Error('Calibration boundary must be inside the requested range, before --through.');
  const now = input.now ?? new Date();
  const outputDirectory = input.outputDirectory ?? join('node_modules', '.cache', 'breadth-v2-calibration', `revision-${input.revisionId}`, `${input.from}_${input.through}_${input.calibrationThrough}_${now.toISOString().replaceAll(':', '-')}`);
  await mkdir(outputDirectory, { recursive: true });
  const phase5a = await runBreadthV2Research({ revisionId: input.revisionId, from: input.from, through: input.through, now, outputDirectory: join(outputDirectory, 'phase5a-strict'), includeCalibrationEvidence: true });
  if (input.expectedInputHash && phase5a.summary.canonicalInputHash !== input.expectedInputHash) throw new Error('Phase 5A canonical input hash differs from the expected hash.');
  const evidence = phase5a.calibrationEvidence!;
  if (!evidence.fullMetrics.some(row => row.sessionDate <= input.calibrationThrough) || !evidence.fullMetrics.some(row => row.sessionDate > input.calibrationThrough)) throw new Error('Calibration and validation both require market sessions.');
  const bands = deriveBands(evidence.fullMetrics, input.calibrationThrough);
  const fullDays = buildCandidateDays(evidence.fullMetrics, bands);
  const coreDays = buildCandidateDays(evidence.stableCoreMetrics, bands);
  const stability = validationStability(evidence.fullMetrics, bands, input.calibrationThrough);
  const coreSensitivity = { stableCoreMemberCount: evidence.stableCoreMemberCount, fullRevisionMemberCount: phase5a.summary.revisionMemberCount, ...sensitivity(evidence.fullMetrics, evidence.stableCoreMetrics, fullDays, coreDays) };
  const dates = [...new Set(evidence.fullMetrics.map(row => row.sessionDate))];
  const periods = [{ label: 'CALIBRATION', from: input.from, through: input.calibrationThrough }, { label: 'VALIDATION', from: dates.find(date => date > input.calibrationThrough)!, through: input.through }, { label: 'FULL', from: input.from, through: input.through }, ...[...new Set(dates.map(date => date.slice(0, 4)))].map(year => ({ label: year, from: `${year}-01-01`, through: `${year}-12-31` }))];
  const summaries = periods.flatMap(period => (Object.keys(THRESHOLD_FAMILIES) as Family[]).flatMap(family => HYSTERESIS_VARIANTS.map(variant => {
    const days = fullDays.filter(day => day.family === family && day.variant === variant && day.sessionDate >= period.from && day.sessionDate <= period.through);
    return { period: period.label, family, variant, ...periodSummary(days) };
  })));
  const thresholdRows = (Object.keys(THRESHOLD_FAMILIES) as Family[]).flatMap(family => (['DAY_1', 'DAY_5', 'DAY_20'] as const).map(horizon => ({ family, horizon, ...bands[family][horizon] })));
  const thresholdCsv = 'thresholdCandidate,horizon,lowerAdvanceShare,upperAdvanceShare,lowerNetBreadth,upperNetBreadth,calibrationLowerPercentile,calibrationUpperPercentile\n' + thresholdRows.map(row => csv([row.family, row.horizon, row.lower, row.upper, 2 * row.lower - 1, 2 * row.upper - 1, row.lowerPercentile, row.upperPercentile])).join('');
  const stateCsv = 'sessionDate,thresholdCandidate,hysteresisCandidate,day1AdvanceShare,day1State,day5AdvanceShare,day5State,day20AdvanceShare,day20State,rawState,effectiveState,transition\n' + fullDays.map(day => csv([day.sessionDate, day.family, day.variant, day.values.DAY_1, day.horizonStates.DAY_1, day.values.DAY_5, day.horizonStates.DAY_5, day.values.DAY_20, day.horizonStates.DAY_20, day.rawState, day.effectiveState, day.transition])).join('');
  const distributionRows: string[] = [], transitionRows: string[] = [], runRows: string[] = [], agreementRows: string[] = [];
  for (const row of summaries) {
    for (const [series, counts] of Object.entries({ ...row.horizonDistributions, RAW: row.rawDistribution, EFFECTIVE: row.effectiveDistribution })) for (const [state, count] of Object.entries(counts)) distributionRows.push(csv([row.period, row.family, row.variant, series, state, count, row.sessions ? count / row.sessions : null]));
    for (const [category, count] of Object.entries(row.transitionCategories)) transitionRows.push(csv([row.period, row.family, row.variant, category, count, row.transitionCount, row.oneSessionRuns, row.atMostTwoSessionRuns, row.medianRunDuration, row.meanRunDuration, row.directTwoLevelFlips, row.unavailableStateSessions, row.effectiveDiffersFromRawPercent]));
    if (!Object.keys(row.transitionCategories).length) transitionRows.push(csv([row.period, row.family, row.variant, 'NONE', 0, row.transitionCount, row.oneSessionRuns, row.atMostTwoSessionRuns, row.medianRunDuration, row.meanRunDuration, row.directTwoLevelFlips, row.unavailableStateSessions, row.effectiveDiffersFromRawPercent]));
    for (const run of row.runs) runRows.push(csv([row.period, row.family, row.variant, run.state, run.fromSession, run.throughSession, run.lengthSessions]));
    const a = row.structuralAgreement;
    agreementRows.push(csv([row.period, row.family, row.variant, a.bothPositive, a.bothNegative, a.bothMixed, a.oppositeDirectional, a.oneDirectionalOneMixed, a.confirmedByDay1, a.oneDirectionalOneMixed ? a.confirmedByDay1 / a.oneDirectionalOneMixed : null]));
  }
  const coverage = coverageDiagnostics(evidence.fullMetrics);
  const summary = { researchVersion: BREADTH_V2_CALIBRATION_VERSION, phase5aResearchVersion: BREADTH_V2_RESEARCH_VERSION, canonicalInputHash: phase5a.summary.canonicalInputHash, constituentHash: phase5a.summary.constituentHash,
    revisionId: input.revisionId, revisionMemberCount: phase5a.summary.revisionMemberCount, requestedFrom: input.from, requestedThrough: input.through, calibrationThrough: input.calibrationThrough, validationFrom: periods[1]!.from,
    provider: 'TIINGO', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED', splitNormalizationVersion: SPLIT_NORMALIZATION_VERSION, gapPolicy: 'STRICT', survivorshipBias: true,
    thresholdDerivation: 'Calibration-only advanceShare empirical quantiles; linear interpolation at p*(n-1); full precision retained for classification. netBreadth=2*advanceShare-1.',
    structuralAggregation: '5d and 20d agree => that state; opposite directional => MIXED; one directional plus MIXED => directional only when 1d confirms; otherwise MIXED.',
    hysteresisVariants: HYSTERESIS_VARIANTS, thresholds: bands, validationStability: stability, coverageDiagnostics: coverage, stableCoreSensitivity: coreSensitivity,
    candidatePeriodSummaries: summaries.map(({ runs, ...summaryRow }) => summaryRow), runtime: { generatedAt: now.toISOString() } };
  await Promise.all([
    writeFile(join(outputDirectory, 'thresholds.csv'), thresholdCsv),
    writeFile(join(outputDirectory, 'candidate-states.csv'), stateCsv),
    writeFile(join(outputDirectory, 'candidate-distributions.csv'), 'period,thresholdCandidate,hysteresisCandidate,series,state,count,shareOfSessions\n' + distributionRows.join('')),
    writeFile(join(outputDirectory, 'candidate-transitions.csv'), 'period,thresholdCandidate,hysteresisCandidate,category,categoryCount,totalTransitions,oneSessionRuns,atMostTwoSessionRuns,medianRunDuration,meanRunDuration,directTwoLevelFlips,unavailableStateSessions,effectiveDiffersFromRawPercent\n' + transitionRows.join('')),
    writeFile(join(outputDirectory, 'candidate-runs.csv'), 'period,thresholdCandidate,hysteresisCandidate,state,fromSession,throughSession,lengthSessions\n' + runRows.join('')),
    writeFile(join(outputDirectory, 'structural-agreement.csv'), 'period,thresholdCandidate,hysteresisCandidate,bothPositive,bothNegative,bothMixed,oppositeDirectional,oneDirectionalOneMixed,confirmedByDay1,confirmationRate\n' + agreementRows.join('')),
    writeFile(join(outputDirectory, 'validation-stability.csv'), 'thresholdCandidate,horizon,validationSampleCount,lowerThreshold,calibrationLowerPercentile,validationLowerPercentile,upperThreshold,calibrationUpperPercentile,validationUpperPercentile\n' + stability.map(row => csv([row.family, row.horizon, row.validationSampleCount, row.lowerThreshold, row.calibrationLowerPercentile, row.validationLowerPercentile, row.upperThreshold, row.calibrationUpperPercentile, row.validationUpperPercentile])).join('')),
    writeFile(join(outputDirectory, 'coverage-sensitivity.csv'), 'type,key,horizon,pairedSessions,meanFullEligibleCount,meanStableCoreEligibleCount,pearsonCorrelation,meanAbsoluteDifference,medianAbsoluteDifference,maximumAbsoluteDifference,maximumDate,disagreementRate\n' + Object.entries(coreSensitivity.byHorizon).map(([horizon, value]) => csv(['METRIC', '', horizon, value.pairedSessions, value.meanFullEligibleCount, value.meanStableCoreEligibleCount, value.pearsonCorrelation, value.meanAbsoluteDifference, value.medianAbsoluteDifference, value.maximumAbsoluteDifference?.absoluteDifference ?? null, value.maximumAbsoluteDifference?.sessionDate ?? null, null])).join('') + Object.entries(coreSensitivity.disagreements).flatMap(([family, value]) => [...Object.entries(value.horizonStateDisagreementRate).map(([horizon, rate]) => csv(['HORIZON_STATE', family, horizon, null, null, null, null, null, null, null, null, rate])), csv(['RAW_STATE', family, '', null, null, null, null, null, null, null, null, null, value.rawStructuralStateDisagreementRate])]).join('')),
  ]);
  await writeFile(join(outputDirectory, 'calibration-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { outputDirectory, summary, ...(input.includeValidationEvidence ? { validationEvidence: { mildDays: fullDays.filter(day => day.variant === 'MILD_POSITIVE_MIXED_CONFIRMATION'), bands, fullMetrics: evidence.fullMetrics } } : {}) };
}
