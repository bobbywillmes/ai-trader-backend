import { describe, expect, it } from 'vitest';
import { compareRawCloses, finalizeBreadth, HORIZONS, SPLIT_NORMALIZATION_VERSION } from './breadth-v2-measurement-calculation.js';
import { compareRawCloses as researchCompare, finalizeBreadth as researchFinalize } from '../dev/breadth-v2-calculation.js';
import { breadthV2EvidenceBlocker } from './breadth-v2-measurement.service.js';

describe('production and research strict breadth primitive', () => {
  const sessions = ['2026-09-22', '2026-09-23', '2026-09-24'];
  it('uses exact raw Decimal comparisons and the same result as Phase 5A', () => {
    const cases = [
      [['100', '1'], ['101', '1'], ['102', '1'], 'ADVANCING'],
      [['100', '1'], ['60', '2'], ['50', '1'], 'UNCHANGED'],
      [['100', '1'], ['120', '0.5'], ['200', '1'], 'UNCHANGED'],
      [['100', '1'], ['50', '2'], ['25', '2'], 'UNCHANGED'],
      [['100', '1'], ['100', '1'], ['99', '1'], 'DECLINING'],
    ] as const;
    for (const [a, b, c, direction] of cases) {
      const bars = new Map(sessions.map((day, i) => [day, { close: [a, b, c][i]![0], splitFactor: [a, b, c][i]![1] }]));
      expect(compareRawCloses(sessions, 0, 2, bars)?.direction).toBe(direction);
      expect(compareRawCloses(sessions, 0, 2, bars)).toEqual(researchCompare(sessions, 0, 2, bars));
    }
  });
  it('excludes missing target, anchor, and intervening split evidence', () => {
    const bars = new Map([[sessions[0]!, { close: '100', splitFactor: '1' }], [sessions[2]!, { close: '101', splitFactor: '1' }]]);
    expect(compareRawCloses(sessions, 0, 2, bars)).toBeNull();
    expect(compareRawCloses(sessions, 0, 2, new Map([[sessions[2]!, { close: '101', splitFactor: '1' }]]))).toBeNull();
    expect(compareRawCloses(sessions, 0, 2, new Map([[sessions[0]!, { close: '100', splitFactor: '1' }]]))).toBeNull();
  });
  it('excludes unchanged from directional ratios with unchanged research values', () => {
    expect(finalizeBreadth(100, 40, 30, 20)).toEqual(researchFinalize(100, 40, 30, 20));
    expect(finalizeBreadth(100, 40, 30, 20)).toMatchObject({ eligibleCount: 90, excludedCount: 10, directionalCount: 70, advanceShare: 40 / 70, netBreadth: 10 / 70, coverageRatio: 0.9 });
    expect(HORIZONS).toEqual([1, 5, 20]);
    expect(SPLIT_NORMALIZATION_VERSION).toBe('RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1');
  });
  it('accepts small gaps and blocks material target, horizon, or directional insufficiency', () => {
    const horizon = [{ horizonSessions: 1, eligibleCount: 2875, directionalCount: 2000 }, { horizonSessions: 5, eligibleCount: 2875, directionalCount: 2000 }, { horizonSessions: 20, eligibleCount: 2875, directionalCount: 2000 }];
    expect(breadthV2EvidenceBlocker(2877, 2875, horizon)).toBeNull();
    expect(breadthV2EvidenceBlocker(2877, 2800, horizon)?.code).toBe('INSUFFICIENT_TARGET_COVERAGE');
    expect(breadthV2EvidenceBlocker(2877, 2877, [{ ...horizon[0]!, eligibleCount: 2700 }, ...horizon.slice(1)])?.code).toBe('INSUFFICIENT_HORIZON_COVERAGE');
    expect(breadthV2EvidenceBlocker(2877, 2877, [{ ...horizon[0]!, directionalCount: 0 }, ...horizon.slice(1)])?.code).toBe('ZERO_DIRECTIONAL_BREADTH');
  });
});
