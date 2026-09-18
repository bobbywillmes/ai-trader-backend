import { expect, it } from 'vitest';
import { VOLATILITY_V1_DEFINITION } from './volatility-v1.definition.js';
it('freezes the adopted V1 constants without a profile or mutable setting', () => {
  expect(VOLATILITY_V1_DEFINITION).toMatchObject({ algorithmVersion: 'VOLATILITY_V1', evidenceSchemaVersion: 1,
    symbols: ['SPY', 'RSP'], timeframe: 'DAY_1', annualizationSessions: 252, standardDeviation: 'sample (n - 1)',
    rvPeriods: [10, 20], atrPeriod: 14, minimumConsecutiveSessions: 21, recoverySessions: 2,
    rvThresholds: [12, 20, 30], atrPctThresholds: [1, 1.5, 2.5], severity: { LOW: 0, NORMAL: 1, HIGH: 2, EXTREME: 3 },
    boundaryRule: 'Lower bounds inclusive; upper bounds exclusive',
  });
  expect(VOLATILITY_V1_DEFINITION).not.toHaveProperty('candidate');
  expect(Object.isFrozen(VOLATILITY_V1_DEFINITION)).toBe(true);
  expect(Object.isFrozen(VOLATILITY_V1_DEFINITION.rvThresholds)).toBe(true);
  expect(Object.isFrozen(VOLATILITY_V1_DEFINITION.atrPctThresholds)).toBe(true);
});
