import { describe, expect, it } from 'vitest';
import { projectTradingLifecycleExerciseTarget } from './trading-lifecycle-exercise-projection.service.js';

const at = new Date('2026-07-28T12:00:00.000Z');

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: 'READY',
    createdAt: at,
    dispatchStartedAt: null,
    dispatchCompletedAt: null,
    intentCreatedAt: null,
    reconciledAt: null,
    cancelledAt: null,
    reconciliationSummaryJson: null,
    orderIntent: null,
    ...overrides,
  } as Parameters<typeof projectTradingLifecycleExerciseTarget>[0];
}

function position(status = 'open', exitState: Record<string, unknown> | null = null) {
  return {
    id: 30, status, openedAt: new Date(at.getTime() + 3_000),
    closedAt: status === 'closed' ? new Date(at.getTime() + 6_000) : null,
    updatedAt: new Date(at.getTime() + 6_000),
    exitState: exitState && {
      id: 40, status: 'watching', attentionRequired: false,
      trailBrokerOrderId: null, trailClientOrderId: null, trailOrderStatus: null,
      createdAt: new Date(at.getTime() + 4_000), updatedAt: new Date(at.getTime() + 4_000),
      ...exitState,
    },
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 10, status: 'pending', createdAt: new Date(at.getTime() + 1_000),
    updatedAt: new Date(at.getTime() + 1_000), brokerActivities: [],
    brokerOrders: [], trackedPosition: null, ...overrides,
  };
}

describe('lifecycle exercise projection', () => {
  it.each([
    ['READY', 'PREVIEW_READY'],
    ['BLOCKED', 'PREVIEW_BLOCKED'],
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
  ])('projects target %s as %s', (status, stage) => {
    expect(projectTradingLifecycleExerciseTarget(target({ status })).stage).toBe(stage);
  });

  it('projects accepted and partially-filled broker states', () => {
    const accepted: any = intent({ brokerOrders: [{ id: 20, status: 'accepted', createdAt: at, updatedAt: at, trackedPosition: null }] });
    expect(projectTradingLifecycleExerciseTarget(target({ orderIntent: accepted })).stage).toBe('ORDER_ACCEPTED');
    accepted.brokerOrders[0]!.status = 'partially_filled';
    expect(projectTradingLifecycleExerciseTarget(target({ orderIntent: accepted })).stage).toBe('PARTIALLY_FILLED');
  });

  it('projects open, monitored, protective, and attention states', () => {
    expect(projectTradingLifecycleExerciseTarget(target({ orderIntent: intent({ trackedPosition: position() }) })).stage).toBe('POSITION_OPEN');
    expect(projectTradingLifecycleExerciseTarget(target({ orderIntent: intent({ trackedPosition: position('open', {}) }) })).stage).toBe('EXIT_MONITORING');
    expect(projectTradingLifecycleExerciseTarget(target({ orderIntent: intent({ trackedPosition: position('open', { trailClientOrderId: 'trail-1' }) }) })).stage).toBe('PROTECTIVE_ORDER_ACTIVE');
    expect(projectTradingLifecycleExerciseTarget(target({ orderIntent: intent({ trackedPosition: position('open', { attentionRequired: true }) }) })).stage).toBe('ATTENTION_REQUIRED');
  });

  it('requires clean reconciliation after closure and deduplicates timeline keys', () => {
    const projected = projectTradingLifecycleExerciseTarget(target({
      reconciledAt: new Date(at.getTime() + 7_000),
      reconciliationSummaryJson: { clean: true },
      orderIntent: intent({
        trackedPosition: position('closed', {}),
        brokerActivities: [{ id: 50, activityType: 'fill', createdAt: new Date(at.getTime() + 2_000) }],
      }),
    }));
    expect(projected.stage).toBe('RECONCILED');
    expect(new Set(projected.timeline.map((event) => event.key)).size).toBe(projected.timeline.length);
    expect(projected.timeline.map((event) => event.type)).toContain('POSITION_CLOSED');
  });
});
