import { aggregateStructuralV3, applyMildDeteriorationConfirmation, advanceBreadthMildDeteriorationConfirmation, type BreadthState, type MildDeteriorationHistory } from './breadth-calculation.js';

/** Phase 5D research decision. Proposed production contract; grants no publishing or trading authority. */
export const BREADTH_V2_TERTILE_V1 = Object.freeze({
  algorithmVersion: 'BREADTH_V2_TERTILE_V1',
  selectedFamily: 'TERTILE',
  thresholds: Object.freeze({
    DAY_1: Object.freeze({ lower: 0.3775183266753999, upper: 0.6256031216081678 }),
    DAY_5: Object.freeze({ lower: 0.4075077399380805, upper: 0.6133782078249895 }),
    DAY_20: Object.freeze({ lower: 0.41043083900226757, upper: 0.6142910587355032 }),
  }),
  structuralAggregationRule: 'STRUCTURAL_V3_5D_20D_WITH_1D_CONFIRMATION',
  hysteresisRule: 'MILD_POSITIVE_MIXED_CONFIRMATION',
  gapPolicy: 'STRICT',
  provider: 'TIINGO',
  timeframe: 'DAY_1',
  adjustmentMode: 'UNADJUSTED',
  splitNormalizationVersion: 'RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1',
  weighting: 'EQUAL_WEIGHT_ONE_SECURITY_ONE_VOTE',
  allowedStates: Object.freeze(['POSITIVE', 'MIXED', 'NEGATIVE'] as const),
  researchProvenance: Object.freeze({
    revisionId: 2,
    revisionMemberCount: 2877,
    calibrationThrough: '2024-12-31',
    validationFrom: '2025-01-02',
    validationThrough: '2026-09-28',
    phase5aVersion: 'BREADTH_V2_RESEARCH_5A_V2',
    phase5bVersion: 'BREADTH_V2_CALIBRATION_5B_V1',
    phase5cVersion: 'BREADTH_V2_VALIDATION_5C_V1',
    canonicalInputHash: '620a26894ee2dd6348959842b5ab4904d0615c7c11281084ed88b42c6e6a4dc4',
    constituentHash: 'b0af80c6d0df43766bfb6c4a4ae1f47f0cee9290d5d88c9235c888b2ed0dc125',
  }),
});

export type BreadthV2Horizon = keyof typeof BREADTH_V2_TERTILE_V1.thresholds;
export type BreadthV2Band = { lower: number; upper: number };

/** The same exact-boundary classifier used by Phase 5B and 5C. Null means unavailable evidence. */
export function classifyBreadthV2Share(value: number | null, band: BreadthV2Band): BreadthState | null {
  if (value === null) return null;
  if (value <= band.lower) return 'NEGATIVE';
  if (value >= band.upper) return 'POSITIVE';
  return 'MIXED';
}

/** Uses Phase 5B's pure structural rule. Missing any required horizon fails closed. */
export function aggregateBreadthV2Structural(day1: BreadthState | null, day5: BreadthState | null, day20: BreadthState | null): BreadthState | null {
  if (day1 === null || day5 === null || day20 === null) return null;
  return aggregateStructuralV3(day1, day5, day20);
}

/** Input shares must already be strict Tiingo DAY_1 measurements with complete split evidence. */
export function classifyFrozenBreadthV2Shares(shares: Record<BreadthV2Horizon, number | null>) {
  const horizonStates = {
    DAY_1: classifyBreadthV2Share(shares.DAY_1, BREADTH_V2_TERTILE_V1.thresholds.DAY_1),
    DAY_5: classifyBreadthV2Share(shares.DAY_5, BREADTH_V2_TERTILE_V1.thresholds.DAY_5),
    DAY_20: classifyBreadthV2Share(shares.DAY_20, BREADTH_V2_TERTILE_V1.thresholds.DAY_20),
  };
  return { horizonStates, rawState: aggregateBreadthV2Structural(horizonStates.DAY_1, horizonStates.DAY_5, horizonStates.DAY_20) };
}

/** Reuses the exact Phase 5B/5C mild replay, including pause on unavailable raw evidence. */
export const replayBreadthV2MildConfirmation = applyMildDeteriorationConfirmation;

/** One production assessment, with the exact same transition used by Phase 5 replay. */
export function advanceFrozenBreadthV2(previous: MildDeteriorationHistory, raw: BreadthState | null) {
  return advanceBreadthMildDeteriorationConfirmation(previous, raw);
}
