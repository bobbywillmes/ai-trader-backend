import { expect, it } from 'vitest';
import { INTRADAY_STRESS_V1_DEFINITION, INTRADAY_STRESS_ALGORITHM_VERSION, INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION } from './intraday-stress-v1.definition.js';

it('freezes the adopted V1 constants without a profile or mutable setting', () => {
  expect(INTRADAY_STRESS_ALGORITHM_VERSION).toBe('INTRADAY_STRESS_V1');
  expect(INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION).toBe(1);
  expect(INTRADAY_STRESS_V1_DEFINITION).toMatchObject({
    algorithmVersion: 'INTRADAY_STRESS_V1', evidenceSchemaVersion: 1,
    symbols: ['SPY', 'RSP'], timeframe: 'MINUTE_15', intervalMs: 900_000,
    shock: { thresholds: [0.40, 0.70] }, rolling: { thresholds: [0.45, 0.80], windowIntervals: 4, warmupTargets: 3 },
    drawdown: { thresholds: [1.00, 1.75] },
    absoluteHigh: { acuteCloseDownsidePct: 0.01, sessionDrawdownPct: 0.025 },
    acuteCollapse: { ratio: 1.20, floor: 0.02, emergency: 0.03 },
    sessionCollapse: { ratio: 2.50, floor: 0.025, emergency: 0.04 },
    severity: { NORMAL: 0, ELEVATED: 1, HIGH: 2, SEVERE: 3 },
    recoverySessions: 2, boundaryRule: 'Lower bounds inclusive; upper bounds exclusive',
  });
  expect(Object.isFrozen(INTRADAY_STRESS_V1_DEFINITION)).toBe(true);
  expect(Object.isFrozen(INTRADAY_STRESS_V1_DEFINITION.shock.thresholds)).toBe(true);
  expect(Object.isFrozen(INTRADAY_STRESS_V1_DEFINITION.rolling.thresholds)).toBe(true);
  expect(Object.isFrozen(INTRADAY_STRESS_V1_DEFINITION.drawdown.thresholds)).toBe(true);
});
