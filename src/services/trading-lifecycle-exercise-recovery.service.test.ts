import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exerciseFindUnique: vi.fn(), targetUpdateMany: vi.fn(), targetUpdate: vi.fn(),
  orderIntentFindMany: vi.fn(), processEntry: vi.fn(), createSystemEvent: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({ prisma: {
  tradingLifecycleExercise: { findUnique: mocks.exerciseFindUnique },
  tradingLifecycleExerciseTarget: { updateMany: mocks.targetUpdateMany, update: mocks.targetUpdate },
  orderIntent: { findMany: mocks.orderIntentFindMany },
} }));
vi.mock('./signal-entry.service.js', () => ({ processEntryForAccountSubscription: mocks.processEntry }));
vi.mock('./system-event.service.js', () => ({ createSystemEvent: mocks.createSystemEvent }));
vi.mock('./trading-lifecycle-exercise-projection.service.js', () => ({ projectTradingLifecycleExerciseTarget: vi.fn(() => ({ stage: 'INTENT_CREATED' })) }));
vi.mock('./assignment-entry-evaluation.service.js', () => ({ evaluateAssignmentEntry: vi.fn() }));
vi.mock('./trading-account-entry-risk-preview.service.js', () => ({ previewTradingAccountEntryRisk: vi.fn() }));
vi.mock('./reconciliation.service.js', () => ({ reconcileTradingAccountWithLock: vi.fn() }));

import {
  LIFECYCLE_EXERCISE_DISPATCH_STALE_MS,
  recoverStaleTradingLifecycleExerciseDispatches,
} from './trading-lifecycle-exercise.service.js';

const staleAt = new Date('2026-08-06T11:00:00Z');
function target(id: number, assignmentId: number, orderIntent: { id: number; status: string } | null = null) {
  return {
    id, tradingAccountId: 100 + id, tradingAccountSubscriptionId: assignmentId,
    environment: 'PAPER', status: 'DISPATCHING', dispatchStartedAt: staleAt,
    orderIntentId: orderIntent?.id ?? null, orderIntent,
  };
}
function exercise(targets: ReturnType<typeof target>[]) {
  return {
    id: 50, reason: 'Recovery canary', exerciseType: 'SUBSCRIPTION_ENTRY',
    containsLiveTargets: false, environment: 'PAPER', targets,
  };
}
function projectedExercise() {
  return {
    ...exercise([]), subscription: {}, createdByUser: {}, status: 'RUNNING',
    targets: [],
  };
}

describe('Lifecycle Exercise stale dispatch recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSystemEvent.mockResolvedValue(undefined);
    mocks.targetUpdate.mockResolvedValue({});
    mocks.processEntry.mockResolvedValue({
      outcome: 'INTENT_CREATED', code: 'INTENT_CREATED', message: 'Created once.', orderIntentId: 900,
    });
  });

  it('recovers linked and exact-scope intents, refuses ambiguity, and dispatches only a claimed missing intent', async () => {
    mocks.exerciseFindUnique
      .mockResolvedValueOnce(exercise([
        target(1, 11, { id: 501, status: 'received' }),
        target(2, 12), target(3, 13), target(4, 14),
      ]))
      .mockResolvedValueOnce(projectedExercise());
    mocks.orderIntentFindMany
      .mockResolvedValueOnce([{ id: 502, status: 'received' }])
      .mockResolvedValueOnce([{ id: 503, status: 'received' }, { id: 504, status: 'received' }])
      .mockResolvedValueOnce([]);
    mocks.targetUpdateMany.mockResolvedValue({ count: 1 });

    const result = await recoverStaleTradingLifecycleExerciseDispatches(50, 7, new Date('2026-08-06T12:00:00Z'));

    expect(result.recovery.results.map((row) => row.code)).toEqual([
      'RECOVERED_LINKED_ORDER_INTENT', 'RECOVERED_DISCOVERED_ORDER_INTENT',
      'RECOVERY_AMBIGUOUS_ORDER_INTENT', 'INTENT_CREATED',
    ]);
    expect(mocks.processEntry).toHaveBeenCalledOnce();
    expect(mocks.processEntry).toHaveBeenCalledWith(expect.objectContaining({
      tradingAccountSubscriptionId: 14,
      idempotencyKey: 'lifecycle-exercise:50:target:4',
    }));
    expect(mocks.orderIntentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tradingAccountId: 102, tradingAccountSubscriptionId: 12 }),
      take: 2,
    }));
    expect(mocks.createSystemEvent.mock.calls.flatMap(([arg]) => arg.type)).toEqual(expect.arrayContaining([
      'trading_lifecycle_exercise.dispatch_recovery_started',
      'trading_lifecycle_exercise.dispatch_order_intent_recovered',
      'trading_lifecycle_exercise.dispatch_recovery_ambiguous',
      'trading_lifecycle_exercise.dispatch_target_reclaimed',
      'trading_lifecycle_exercise.dispatch_recovery_completed',
    ]));
  });

  it('queries only persisted claims older than the threshold and never processes recent targets', async () => {
    mocks.exerciseFindUnique.mockResolvedValueOnce(exercise([])).mockResolvedValueOnce(projectedExercise());
    await recoverStaleTradingLifecycleExerciseDispatches(50, 7, new Date('2026-08-06T12:00:00Z'));
    expect(mocks.exerciseFindUnique.mock.calls[0]![0]).toEqual(expect.objectContaining({
      include: expect.objectContaining({ targets: expect.objectContaining({
        where: { status: 'DISPATCHING', dispatchStartedAt: { lte: new Date('2026-08-06T11:55:00Z') } },
      }) }),
    }));
    expect(LIFECYCLE_EXERCISE_DISPATCH_STALE_MS).toBe(5 * 60_000);
    expect(mocks.processEntry).not.toHaveBeenCalled();
  });

  it('does not dispatch when another concurrent recovery wins the atomic reclaim', async () => {
    mocks.exerciseFindUnique.mockResolvedValueOnce(exercise([target(4, 14)])).mockResolvedValueOnce(projectedExercise());
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.targetUpdateMany.mockResolvedValue({ count: 0 });
    await recoverStaleTradingLifecycleExerciseDispatches(50, 7, new Date('2026-08-06T12:00:00Z'));
    expect(mocks.processEntry).not.toHaveBeenCalled();
    expect(mocks.targetUpdate).not.toHaveBeenCalled();
  });
});
