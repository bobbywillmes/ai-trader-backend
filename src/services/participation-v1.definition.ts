/** Frozen, stateless production semantics. No publication or trading authority. */
export const PARTICIPATION_ALGORITHM_VERSION = 'PARTICIPATION_V1';
export const PARTICIPATION_PUBLICATION_EVIDENCE_VERSION = 1;
export const PARTICIPATION_SYMBOLS = Object.freeze(['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'] as const);
export type ParticipationSymbol = typeof PARTICIPATION_SYMBOLS[number];
export const PARTICIPATION_STATES = ['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE'] as const;
export type ParticipationState = typeof PARTICIPATION_STATES[number];
export const PARTICIPATION_BASELINE_SESSIONS = 20;
export const PARTICIPATION_THRESHOLDS = Object.freeze({ NORMAL: 0.75, ACTIVE: 1.25, INTENSE: 1.50 });
export const PARTICIPATION_DIAGNOSTIC_CUT_POINTS = Object.freeze({ le070: 0.70, le080: 0.80, ge100: 1, ge125: 1.25, ge150: 1.5, ge200: 2 });
export function classifyParticipation(value: number): ParticipationState {
  if (!Number.isFinite(value) || value < 0) throw new Error('Participation RVOL must be finite and non-negative.');
  if (value < PARTICIPATION_THRESHOLDS.NORMAL) return 'QUIET';
  if (value < PARTICIPATION_THRESHOLDS.ACTIVE) return 'NORMAL';
  if (value < PARTICIPATION_THRESHOLDS.INTENSE) return 'ACTIVE';
  return 'INTENSE';
}
/** Deliberately no predecessor or transition engine. */
export function participationStates(value: number) {
  const rawState = classifyParticipation(value);
  return { rawState, effectiveState: rawState };
}
