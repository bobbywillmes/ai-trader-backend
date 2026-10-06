import { describe, expect, it } from 'vitest';
import { datesBetween, marketSession } from './market-calendar.js';
import { BreadthV2BootstrapAccumulator } from './breadth-v2-bootstrap.js';
import { advanceFrozenBreadthV2, classifyFrozenBreadthV2Shares, replayBreadthV2MildConfirmation } from './breadth-v2.definition.js';
import type { ResearchBar } from './breadth-v2-measurement-calculation.js';
import { tiingoDayEligibleAt } from './tiingo-daily.service.js';

const sessions = datesBetween('2020-11-16', '2021-01-15').filter(date => marketSession(date));
const replayFrom = '2021-01-04', replayThrough = '2021-01-15';
function fixture(missing?: string, altered = false) {
  const acc = new BreadthV2BootstrapAccumulator(sessions, replayFrom, replayThrough, 7, 'f'.repeat(64));
  for (const [index, symbol] of ['AAA', 'BBB', 'CCC'].entries()) {
    const bars = new Map<string, ResearchBar>();
    for (const [i, date] of sessions.entries()) if (date !== missing) bars.set(date, { close: String(index === 0 ? 100 + i + (altered && i === 5 ? 1 : 0) : 200 + index * 100 - i), splitFactor: '1' });
    acc.addMember({ securityId: index + 1, symbol }, bars, [...bars].map(([date, bar]) => `${date}:${bar.close}:${bar.splitFactor}`));
  }
  return acc.finish();
}

describe('fixed-revision V2 bootstrap replay', () => {
  it('uses the shared Tiingo 20:15 ET timestamp across daylight and standard time', () => {
    expect(tiingoDayEligibleAt('2026-09-29').toISOString()).toBe('2026-09-30T00:15:00.000Z');
    expect(tiingoDayEligibleAt('2026-12-01').toISOString()).toBe('2026-12-02T01:15:00.000Z');
  });
  it('establishes a known TERTILE + mild checkpoint without historical revisions or live readiness gates', () => {
    const result = fixture();
    expect(result).toMatchObject({ bootstrapVersion: 'BREADTH_V2_BOOTSTRAP_V1', populationPolicy: 'TARGET_OBSERVATION_REVISION_FIXED_BACKCAST', revisionId: 7, memberCount: 3, preCurrentEffectiveState: 'NEGATIVE', preCurrentRecoveryConfirmation: 0, preCurrentMildDeteriorationConfirmation: 0 });
    expect(result.validRawSessionCount).toBeGreaterThan(0);
    expect(result.rawStates.filter(Boolean)).toEqual(Array(result.validRawSessionCount).fill('NEGATIVE'));
    const researched = replayBreadthV2MildConfirmation(result.rawStates);
    expect(researched.at(-1)?.hysteresis.effectiveState).toBe(result.preCurrentEffectiveState);
    expect(researched.at(-1)?.hysteresis.recoveryConfirmationAfter).toBe(result.preCurrentRecoveryConfirmation);
    expect(result.historicalReplayHash).toBe(fixture().historicalReplayHash);
    expect(result.historicalReplayHash).not.toBe(fixture(undefined, true).historicalReplayHash);
  });
  it('pauses counters across unavailable strict sessions and never fabricates a bar', () => {
    const result = fixture('2021-01-06');
    expect(result.unavailableRawSessionCount).toBeGreaterThan(0);
    expect(result.rawStates).toContain(null);
    const replayed = replayBreadthV2MildConfirmation(result.rawStates);
    const unavailableIndex = result.rawStates.indexOf(null);
    expect(replayed[unavailableIndex]!.hysteresis.reason).toContain('pause');
    expect(result.preCurrentEffectiveState).toBe(replayed.at(-1)!.hysteresis.effectiveState);
    expect(advanceFrozenBreadthV2({ effectiveState: 'NEGATIVE', recoveryConfirmation: 1, mildDeteriorationConfirmation: 0 }, null)).toMatchObject({ recoveryConfirmationAfter: 1, mildDeteriorationConfirmationAfter: 0, effectiveState: 'NEGATIVE' });
    expect(advanceFrozenBreadthV2({ effectiveState: 'POSITIVE', recoveryConfirmation: 0, mildDeteriorationConfirmation: 1 }, null)).toMatchObject({ recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 1, effectiveState: 'POSITIVE' });
  });
  it('cannot establish bootstrap continuation from empty historical evidence', () => {
    const acc = new BreadthV2BootstrapAccumulator(sessions, replayFrom, replayThrough, 7, 'f'.repeat(64));
    acc.addMember({ securityId: 1, symbol: 'AAA' }, new Map());
    const result = acc.finish();
    expect(result.validRawSessionCount).toBe(0);
    expect(result.preCurrentEffectiveState).toBeNull();
    expect(result.unavailableRawSessionCount).toBe(result.expectedSessionCount);
  });
  it('classifies the accepted structural example from shares and advances one assessment identically to research', () => {
    const classified = classifyFrozenBreadthV2Shares({ DAY_1: 0.388, DAY_5: 0.2246, DAY_20: 0.2536 });
    expect(classified).toMatchObject({ horizonStates: { DAY_1: 'MIXED', DAY_5: 'NEGATIVE', DAY_20: 'NEGATIVE' }, rawState: 'NEGATIVE' });
    const raw = ['POSITIVE', 'MIXED', 'MIXED', 'NEGATIVE', 'POSITIVE', 'POSITIVE', null] as const;
    const researched = replayBreadthV2MildConfirmation(raw);
    let history = { effectiveState: null as 'POSITIVE' | 'MIXED' | 'NEGATIVE' | null, recoveryConfirmation: 0, mildDeteriorationConfirmation: 0 };
    for (const [i, value] of raw.entries()) {
      const transition = advanceFrozenBreadthV2(history, value);
      expect(transition).toEqual(researched[i]!.hysteresis);
      history = { effectiveState: transition.effectiveState, recoveryConfirmation: transition.recoveryConfirmationAfter, mildDeteriorationConfirmation: transition.mildDeteriorationConfirmationAfter };
    }
    expect(researched[1]!.hysteresis.effectiveState).toBe('POSITIVE');
    expect(researched[2]!.hysteresis.effectiveState).toBe('MIXED');
    expect(researched[3]!.hysteresis.effectiveState).toBe('NEGATIVE');
    expect(researched[4]!.hysteresis.recoveryConfirmationAfter).toBe(1);
    expect(researched[5]!.hysteresis.effectiveState).toBe('MIXED');
    expect(researched[6]!.hysteresis.recoveryConfirmationAfter).toBe(0);
    expect(advanceFrozenBreadthV2({ effectiveState: 'POSITIVE', recoveryConfirmation: 0, mildDeteriorationConfirmation: 0 }, 'NEGATIVE').effectiveState).toBe('MIXED');
    expect(advanceFrozenBreadthV2({ effectiveState: 'NEGATIVE', recoveryConfirmation: 1, mildDeteriorationConfirmation: 0 }, 'POSITIVE').effectiveState).toBe('MIXED');
  });
});
