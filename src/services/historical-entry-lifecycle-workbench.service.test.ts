import { LifecycleRepairActionStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { historicalPreviewReuseDecision } from './historical-entry-lifecycle-workbench.service.js';

const now = new Date('2026-09-03T12:00:00.000Z');

describe('historical lifecycle preview generation', () => {
  it('returns an unchanged current usable preview idempotently', () => {
    expect(historicalPreviewReuseDecision({ sameMaterialEvidence: true, expiresAt: new Date(now.getTime() + 60_000), now, actionStatuses: [LifecycleRepairActionStatus.PROPOSED] })).toBe('RETURN_CURRENT');
  });

  it.each([
    ['expired', new Date(now.getTime() - 1), LifecycleRepairActionStatus.PROPOSED],
    ['failed', new Date(now.getTime() + 60_000), LifecycleRepairActionStatus.FAILED],
    ['superseded', new Date(now.getTime() + 60_000), LifecycleRepairActionStatus.SUPERSEDED],
  ])('creates a new immutable generation for %s evidence', (_label, expiresAt, status) => {
    expect(historicalPreviewReuseDecision({ sameMaterialEvidence: true, expiresAt, now, actionStatuses: [status] })).toBe('CREATE_GENERATION');
  });

  it('does not let ordinary preview bypass an unchanged refusal', () => {
    expect(historicalPreviewReuseDecision({ sameMaterialEvidence: true, expiresAt: new Date(now.getTime() - 1), now, actionStatuses: [LifecycleRepairActionStatus.REFUSED] })).toBe('RETURN_IMMUTABLE_REFUSAL');
  });

  it('creates a generation when material evidence changed', () => {
    expect(historicalPreviewReuseDecision({ sameMaterialEvidence: false, expiresAt: new Date(now.getTime() + 60_000), now, actionStatuses: [LifecycleRepairActionStatus.REFUSED] })).toBe('CREATE_GENERATION');
  });
});
