import { describe, expect, it } from 'vitest';

import {
  deriveLifecycleRepairCaseState,
  getFrozenPositionAttributionAssessedAt,
  isPristinePositionExitState,
  positionAttributionRevalidationMatches,
} from './lifecycle-repair.service.js';

const pristine = {
  status: 'watching', targetUnlocked: false, targetUnlockedAt: null,
  targetUnlockedPrice: null, targetUnlockedPnlPct: null, highWaterMark: null,
  trailStopPrice: null, trailBroker: null, trailBrokerOrderId: null,
  trailClientOrderId: null, trailOrderStatus: null,
};

describe('Lifecycle Repair case safety semantics', () => {
  it('allows missing or pristine exit state hydration', () => {
    expect(isPristinePositionExitState(null)).toBe(true);
    expect(isPristinePositionExitState(pristine)).toBe(true);
  });
  it.each([
    { status: 'target_unlocked' }, { targetUnlocked: true }, { highWaterMark: 310 },
    { trailBrokerOrderId: 'broker-order' }, { trailClientOrderId: 'client-order' },
  ])('refuses to overwrite meaningful exit lifecycle progress', (progress) => {
    expect(isPristinePositionExitState({ ...pristine, ...progress })).toBe(false);
  });
  it('derives executable, expired, superseded, and executed state without mutating the case', () => {
    const now = new Date('2026-08-15T12:00:00Z');
    expect(deriveLifecycleRepairCaseState({ executableAtCreation: true, expiresAt: new Date('2026-08-15T12:10:00Z'), superseded: false, successfulExecution: null, now })).toEqual({ executable: true, expired: false, superseded: false, executed: false });
    expect(deriveLifecycleRepairCaseState({ executableAtCreation: true, expiresAt: now, superseded: false, successfulExecution: null, now }).expired).toBe(true);
    expect(deriveLifecycleRepairCaseState({ executableAtCreation: true, expiresAt: new Date('2026-08-15T12:10:00Z'), superseded: true, successfulExecution: null, now }).executable).toBe(false);
    expect(deriveLifecycleRepairCaseState({ executableAtCreation: true, expiresAt: new Date('2026-08-15T12:10:00Z'), superseded: false, successfulExecution: { id: 1 }, now }).executed).toBe(true);
  });
});

describe('position attribution frozen-preview revalidation', () => {
  const assessedAt = '2026-08-15T23:09:34.415Z';
  const createdAt = new Date('2026-08-15T23:09:34.728Z');
  const snapshot = { capturedAt: assessedAt, subscription: { id: 38, key: 'aapl_dip_core' } };
  const proposed = {
    trackedPosition: {
      subscriptionId: { before: null, after: 38 },
      tradingAccountSubscriptionId: { before: null, after: 4 },
      configSnapshotJson: { before: null, after: snapshot },
      configSnapshotCapturedAt: { before: null, after: assessedAt },
    },
  };
  const evidence = { brokerOrderId: 'order-1', clientOrderId: 'ai-entry-tas4-digest' };
  const frozen = {
    localLifecycleFingerprint: 'local-v1',
    configurationFingerprint: 'config-v1',
    proposedMutationsJson: proposed,
    evidenceJson: evidence,
  };
  const unchanged = {
    executable: true,
    localLifecycleFingerprint: 'local-v1',
    configurationFingerprint: 'config-v1',
    proposed,
    evidence,
  };

  it('uses the frozen diagnosis timestamp when case createdAt differs', () => {
    const frozenTime = getFrozenPositionAttributionAssessedAt(proposed);
    expect(frozenTime.toISOString()).toBe(assessedAt);
    expect(frozenTime).not.toEqual(createdAt);
    expect(snapshot.capturedAt).toBe(frozenTime.toISOString());
    expect(positionAttributionRevalidationMatches({ rechecked: unchanged, frozen })).toBe(true);
  });

  it('keeps the exact Preview snapshot timestamp available for Apply', () => {
    const frozenTime = getFrozenPositionAttributionAssessedAt(proposed).toISOString();
    expect(proposed.trackedPosition.configSnapshotJson.after.capturedAt).toBe(frozenTime);
    expect(proposed.trackedPosition.configSnapshotCapturedAt.after).toBe(frozenTime);
  });

  it('still supersedes a real configuration change', () => {
    expect(positionAttributionRevalidationMatches({
      rechecked: { ...unchanged, configurationFingerprint: 'config-v2' }, frozen,
    })).toBe(false);
  });

  it('still supersedes a real broker evidence change', () => {
    expect(positionAttributionRevalidationMatches({
      rechecked: { ...unchanged, evidence: { ...evidence, brokerOrderId: 'order-2' } }, frozen,
    })).toBe(false);
  });

  it('still supersedes a real target lifecycle change', () => {
    expect(positionAttributionRevalidationMatches({
      rechecked: { ...unchanged, localLifecycleFingerprint: 'local-v2' }, frozen,
    })).toBe(false);
  });

  it('fails closed when the frozen timestamp is missing or malformed', () => {
    expect(() => getFrozenPositionAttributionAssessedAt({})).toThrow('no valid frozen snapshot timestamp');
    expect(() => getFrozenPositionAttributionAssessedAt({ trackedPosition: { configSnapshotCapturedAt: { after: 'not-a-date' } } })).toThrow('invalid frozen snapshot timestamp');
  });
});
