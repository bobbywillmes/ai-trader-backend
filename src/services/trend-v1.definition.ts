import { MEASUREMENT_DEFINITIONS } from './trend-calculation.js';

export const TREND_ALGORITHM_VERSION = 'TREND_V1';
// Independent production constants, in percentage points. Never alias a research profile.
export const TREND_V1_THRESHOLDS = Object.freeze([0.10, 0.02, 0.30, 0.15, 0.02, 0.10, 0.25, 0.01, 0.15]);
// Version 1 of the authoritative publication envelope; research decoding is unchanged.
export const TREND_PUBLICATION_EVIDENCE_VERSION = 1;
export const TREND_V1_THRESHOLD_EVIDENCE = Object.freeze(Object.fromEntries(
  MEASUREMENT_DEFINITIONS.map((measurement, i) => [measurement.key, TREND_V1_THRESHOLDS[i]!]),
));
