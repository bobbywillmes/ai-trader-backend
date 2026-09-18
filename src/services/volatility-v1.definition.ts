import { VOLATILITY_DEFINITION } from './volatility-calculation.js';

export const VOLATILITY_ALGORITHM_VERSION = 'VOLATILITY_V1';
export const VOLATILITY_PUBLICATION_EVIDENCE_VERSION = 1;
// Adopt the calibrated immutable definition without tunable profiles or settings.
// Any future formula/threshold change requires a new algorithm version.
const { candidate: _candidate, ...calibrated } = VOLATILITY_DEFINITION;
export const VOLATILITY_V1_DEFINITION = Object.freeze({
  ...calibrated, algorithmVersion: VOLATILITY_ALGORITHM_VERSION,
  hysteresis: Object.freeze({ worsening: 'Jump immediately to raw severity', recovery: 'Two supporting VALID sessions; exactly one lower state; reset after transition', equal: 'Hold and reset confirmation', unavailable: 'Pause effective state and confirmation', bootstrap: 'First valid raw becomes effective' }),
});
