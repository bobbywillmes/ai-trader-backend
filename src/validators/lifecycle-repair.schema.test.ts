import { describe, expect, it } from 'vitest';
import { applyLifecycleRepairSchema, diagnosePositionAttributionRepairSchema } from './lifecycle-repair.schema.js';

describe('lifecycle repair request schemas', () => {
  it('accepts only the Phase 1 repair type', () => {
    expect(diagnosePositionAttributionRepairSchema.parse({ repairType: 'RESOLVE_POSITION_ATTRIBUTION', tradingAccountId: 1, trackedPositionId: 73 })).toMatchObject({ trackedPositionId: 73 });
    expect(() => diagnosePositionAttributionRepairSchema.parse({ repairType: 'LINK_BROKER_ORDER', tradingAccountId: 1, trackedPositionId: 73 })).toThrow();
  });
  it('requires reason, typed confirmation, and a constrained attempt key', () => {
    expect(applyLifecycleRepairSchema.parse({ reason: 'Recover deterministic TAS ownership.', confirmation: 'APPLY POSITION ATTRIBUTION REPAIR', attemptKey: 'repair:73:attempt:1' })).toBeTruthy();
    expect(() => applyLifecycleRepairSchema.parse({ reason: '', confirmation: 'yes', attemptKey: 'x' })).toThrow();
  });
});
