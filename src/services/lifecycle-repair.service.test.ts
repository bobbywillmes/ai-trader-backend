import { describe, expect, it } from 'vitest';

import { deriveLifecycleRepairCaseState, isPristinePositionExitState } from './lifecycle-repair.service.js';

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
