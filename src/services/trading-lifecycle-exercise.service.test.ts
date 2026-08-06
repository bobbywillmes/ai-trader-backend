import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({
  subscriptionFindUnique: vi.fn(),
  assignmentFindMany: vi.fn(),
  exerciseCreate: vi.fn(),
  evaluateAssignmentEntry: vi.fn(),
  createSystemEvent: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    subscription: { findUnique: mocks.subscriptionFindUnique },
    tradingAccountSubscription: { findMany: mocks.assignmentFindMany },
    tradingLifecycleExercise: { create: mocks.exerciseCreate },
  },
}));
vi.mock('./assignment-entry-evaluation.service.js', () => ({ evaluateAssignmentEntry: mocks.evaluateAssignmentEntry }));
vi.mock('./system-event.service.js', () => ({ createSystemEvent: mocks.createSystemEvent }));
vi.mock('./signal-entry.service.js', () => ({ processEntryForAccountSubscription: vi.fn() }));
vi.mock('./trading-account-entry-risk-preview.service.js', () => ({ previewTradingAccountEntryRisk: vi.fn() }));
vi.mock('./reconciliation.service.js', () => ({ reconcileTradingAccountWithLock: vi.fn() }));

import {
  listSubscriptionEntryCandidates,
  previewSubscriptionEntryLifecycleExercise,
} from './trading-lifecycle-exercise.service.js';

function identity(id: number, subscriptionId = 7, environment = 'PAPER') {
  return { id, subscriptionId, tradingAccount: { id: id + 100, environment } };
}

function assignment(id: number, accountId = id + 100, environment = 'PAPER') {
  return {
    id, updatedAt: new Date('2026-08-01T00:00:00Z'), subscriptionId: 7,
    allocationId: 20, enabled: true, entriesEnabled: true, exitsEnabled: true,
    sizingType: 'FIXED_QTY', fixedQty: 2, maxPositionNotional: null,
    reservedNotional: 1000, minPositionNotional: null, maxQty: null,
    allocation: { id: 20, updatedAt: new Date('2026-08-01T00:00:00Z'), enabled: true, maxAllocatedNotional: 5000, maxOpenPositions: 5, maxPositionNotional: 1000 },
    tradingAccount: {
      id: accountId, updatedAt: new Date('2026-08-01T00:00:00Z'), accountHolderUserId: 3,
      environment, status: 'ACTIVE', tradingEnabled: true, killSwitchEnabled: false,
      estimatedTradingCapital: 5000, maxDeployableNotional: 5000,
      accountHolder: { enabled: true },
      credential: { status: 'ACTIVE', verifiedAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z') },
      riskSettings: null,
    },
    subscription: {
      id: 7, key: 'NVDA-MOMENTUM', updatedAt: new Date('2026-08-01T00:00:00Z'), enabled: true,
      security: { id: 1, enabled: true, updatedAt: new Date('2026-08-01T00:00:00Z') },
      strategy: { id: 2, enabled: true, updatedAt: new Date('2026-08-01T00:00:00Z') },
      exitProfile: { id: 3, enabled: true, updatedAt: new Date('2026-08-01T00:00:00Z') },
    },
  };
}

function evaluation(id: number) {
  return {
    context: {}, input: {}, blockers: [], warnings: [], permitsIntentCreation: true,
    outcomeCode: 'ENTRY_ELIGIBLE', risk: { allowed: true }, session: null,
    sizing: { qty: id, estimatedNotional: id * 10, snapshot: {} },
    referencePrice: 10, estimatedNotional: id * 10,
    priceEvidence: { observedAt: null, source: null },
  };
}

describe('Subscription-entry candidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only queried assignment rows in deterministic order without secrets and marks LIVE unavailable', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({ id: 7, key: 'NVDA-MOMENTUM', name: 'NVDA Momentum' });
    mocks.assignmentFindMany.mockResolvedValue([
      {
        id: 2, subscriptionId: 7, tradingAccountId: 11, allocationId: 20,
        enabled: true, entriesEnabled: true, exitsEnabled: true, sizingType: 'FIXED_QTY',
        fixedQty: 1, maxPositionNotional: null, reservedNotional: 100, minPositionNotional: null, maxQty: null,
        subscription: {
          id: 7, key: 'NVDA-MOMENTUM', name: 'NVDA Momentum', enabled: true,
          security: { enabled: true }, strategy: { enabled: true }, exitProfile: { enabled: true },
        },
        allocation: { id: 20, key: 'core', name: 'Core', enabled: true },
        tradingAccount: {
          id: 11, displayName: 'Live account', environment: 'LIVE', status: 'ACTIVE',
          tradingEnabled: true, killSwitchEnabled: false,
          accountHolder: { id: 3, name: 'Holder', email: 'holder@example.com', enabled: true },
          memberships: [], credential: { status: 'ACTIVE', verifiedAt: new Date() },
        },
      },
    ]);

    const result = await listSubscriptionEntryCandidates(7);

    expect(mocks.assignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { subscriptionId: 7 }, orderBy: [{ tradingAccountId: 'asc' }, { id: 'asc' }],
    }));
    expect(result.candidates[0]).toMatchObject({
      tradingAccountSubscriptionId: 2, tradingAccountId: 11, selectable: false,
      unavailableReasons: [{ code: 'LIVE_EXERCISES_NOT_SUPPORTED' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/Ciphertext|apiKey|apiSecret|accessToken|refreshToken/i);
  });

  it('returns a structured not-found error for an unknown Subscription', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    await expect(listSubscriptionEntryCandidates(999)).rejects.toMatchObject({
      statusCode: 404, details: { code: 'SUBSCRIPTION_NOT_FOUND' },
    });
    expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
  });
});

describe('explicit assignment preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscriptionFindUnique.mockResolvedValue({ id: 7, key: 'NVDA-MOMENTUM', name: 'NVDA Momentum' });
    mocks.exerciseCreate.mockImplementation(async ({ data }) => ({ id: 50, ...data, targets: data.targets.create }));
    mocks.createSystemEvent.mockResolvedValue(undefined);
  });

  it('freezes exactly the selected assignment IDs and evaluates each through the shared evaluator', async () => {
    mocks.assignmentFindMany
      .mockResolvedValueOnce([identity(4), identity(8)])
      .mockResolvedValueOnce([assignment(8, 108), assignment(4, 104)]);
    mocks.evaluateAssignmentEntry.mockImplementation(async ({ input }) => evaluation(input.tradingAccountSubscriptionId));

    const result = await previewSubscriptionEntryLifecycleExercise({
      reason: 'Selected canary', subscriptionId: 7,
      tradingAccountSubscriptionIds: [8, 4], environment: 'PAPER',
    }, 1, new Date('2026-08-06T12:00:00Z'));

    expect(mocks.evaluateAssignmentEntry.mock.calls.map(([arg]) => arg.input.tradingAccountSubscriptionId)).toEqual([4, 8]);
    expect(result.targets.map((target: { tradingAccountSubscriptionId: number }) => target.tradingAccountSubscriptionId)).toEqual([4, 8]);
    expect(mocks.exerciseCreate).toHaveBeenCalledOnce();
    const createInput = mocks.exerciseCreate.mock.calls[0]![0];
    expect(createInput.data.targets.create).toHaveLength(2);
    expect(createInput.data.previewExpiresAt.toISOString()).toBe('2026-08-06T12:05:00.000Z');
  });

  it.each([
    { rows: [], code: 'ASSIGNMENT_NOT_FOUND' },
    { rows: [identity(4, 9)], code: 'ASSIGNMENT_WRONG_SUBSCRIPTION' },
    { rows: [identity(4, 7, 'LIVE')], code: 'LIVE_EXERCISES_NOT_SUPPORTED' },
  ])('rejects invalid target identity atomically ($code)', async ({ rows, code }) => {
    mocks.assignmentFindMany.mockResolvedValue(rows);
    await expect(previewSubscriptionEntryLifecycleExercise({
      reason: 'Invalid canary', subscriptionId: 7,
      tradingAccountSubscriptionIds: [4], environment: 'PAPER',
    }, 1)).rejects.toMatchObject({
      statusCode: 409, details: { code: 'INVALID_ASSIGNMENT_SELECTION', errors: [expect.objectContaining({ code })] },
    });
    expect(mocks.evaluateAssignmentEntry).not.toHaveBeenCalled();
    expect(mocks.exerciseCreate).not.toHaveBeenCalled();
  });

  it('persists a blocker for a valid selected assignment whose evaluation is currently blocked', async () => {
    const disabled = assignment(4);
    disabled.tradingAccount.tradingEnabled = false;
    mocks.assignmentFindMany.mockResolvedValueOnce([identity(4)]).mockResolvedValueOnce([disabled]);
    mocks.evaluateAssignmentEntry.mockRejectedValue(new HttpError(403, 'Trading is disabled.'));

    const result = await previewSubscriptionEntryLifecycleExercise({
      reason: 'Blocked canary', subscriptionId: 7,
      tradingAccountSubscriptionIds: [4], environment: 'PAPER',
    }, 1);
    expect(result.targets[0]).toMatchObject({
      tradingAccountSubscriptionId: 4, status: 'BLOCKED',
      blockersJson: [{ code: 'ACCOUNT_TRADING_DISABLED' }],
    });
  });
});
