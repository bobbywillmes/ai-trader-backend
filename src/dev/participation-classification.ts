/** Frozen research algorithm only. No production publishing or transition state. */
import { PARTICIPATION_SYMBOLS, PARTICIPATION_THRESHOLDS } from '../services/participation-v1.definition.js';
export { PARTICIPATION_STATES, classifyParticipation, type ParticipationState } from '../services/participation-v1.definition.js';
export const FROZEN_PARTICIPATION = Object.freeze({
  version: 'PARTICIPATION_V1', symbols: PARTICIPATION_SYMBOLS, baselineSessions: 20, targetExcludedFromBaseline: true,
  fullSessionsOnly: true, earlyClosesExcludedFromTargetAndBaseline: true,
  volumeBasis: 'Unadjusted Massive daily aggregates, explicitly split-normalized; not intraday regular-hours reconstruction',
  aggregation: 'Median of five equal ETF RVOL sensors',
  thresholds: PARTICIPATION_THRESHOLDS,
  hysteresis: false, allFiveRequired: true, directionNeutral: true, tradingAuthority: false,
});
