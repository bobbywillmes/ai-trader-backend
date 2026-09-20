/** Frozen research algorithm only. No production publishing or transition state. */
import { PARTICIPATION_SYMBOLS } from './participation-calculation.js';
export const PARTICIPATION_STATES = ['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE'] as const;
export type ParticipationState = typeof PARTICIPATION_STATES[number];
export const FROZEN_PARTICIPATION = Object.freeze({
  version: 'PARTICIPATION_V1', symbols: PARTICIPATION_SYMBOLS, baselineSessions: 20, targetExcludedFromBaseline: true,
  fullSessionsOnly: true, earlyClosesExcludedFromTargetAndBaseline: true,
  volumeBasis: 'Unadjusted Massive daily aggregates, explicitly split-normalized; not intraday regular-hours reconstruction',
  aggregation: 'Median of five equal ETF RVOL sensors',
  thresholds: Object.freeze({ NORMAL: 0.75, ACTIVE: 1.25, INTENSE: 1.50 }),
  hysteresis: false, allFiveRequired: true, directionNeutral: true, tradingAuthority: false,
});
export function classifyParticipation(panelMedianRvol: number): ParticipationState {
  if (!Number.isFinite(panelMedianRvol) || panelMedianRvol < 0) throw new Error('Participation RVOL must be finite and non-negative.');
  if (panelMedianRvol < FROZEN_PARTICIPATION.thresholds.NORMAL) return 'QUIET';
  if (panelMedianRvol < FROZEN_PARTICIPATION.thresholds.ACTIVE) return 'NORMAL';
  if (panelMedianRvol < FROZEN_PARTICIPATION.thresholds.INTENSE) return 'ACTIVE';
  return 'INTENSE';
}
