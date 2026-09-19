import { INTRADAY_STRESS_DEFINITION } from './intraday-stress-calculation.js';

export const INTRADAY_STRESS_ALGORITHM_VERSION = 'INTRADAY_STRESS_V1';
export const INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION = 1;
// Adopt the calibrated immutable definition without tunable profiles or settings.
// Any future formula/threshold change requires a new algorithm version.
export const INTRADAY_STRESS_V1_DEFINITION = Object.freeze({
  ...INTRADAY_STRESS_DEFINITION, algorithmVersion: INTRADAY_STRESS_ALGORITHM_VERSION,
  hysteresis: Object.freeze({
    scope: 'Session-local; no cross-session hysteresis. The first valid assessment of a new session sets effective state from raw state.',
    worsening: 'Jump immediately to raw severity', recovery: 'Two supporting VALID assessments below effective state; exactly one lower state; reset after transition',
    equal: 'Hold and reset confirmation', unavailable: 'Pause effective state; reset recovery confirmation to zero (a gap never carries partial progress forward)',
    bootstrap: 'First valid raw of the session becomes effective',
  }),
});
