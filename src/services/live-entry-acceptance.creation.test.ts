import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assignmentFindFirst: vi.fn(),
  runCreate: vi.fn(),
  runFindFirst: vi.fn(),
  approvalFindMany: vi.fn(),
  readinessFindFirst: vi.fn(),
  computeReadinessFingerprints: vi.fn(),
  validateActiveLiveEntryArming: vi.fn(),
  submitOrder: vi.fn(),
  disarmLiveEntries: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountSubscription: { findFirst: mocks.assignmentFindFirst },
    liveEntryAcceptanceRun: {
      create: mocks.runCreate,
      findFirst: mocks.runFindFirst,
    },
    tradingAccountLiveWriteApproval: { findMany: mocks.approvalFindMany },
    tradingAccountReadinessAssessment: { findFirst: mocks.readinessFindFirst },
  },
}));
vi.mock('./trading-account-readiness.service.js', () => ({
  computeReadinessFingerprints: mocks.computeReadinessFingerprints,
}));
vi.mock('./live-entry-arming.service.js', () => ({
  validateActiveLiveEntryArming: mocks.validateActiveLiveEntryArming,
  disarmLiveEntries: mocks.disarmLiveEntries,
}));
vi.mock('./place-order.service.js', () => ({ submitOrder: mocks.submitOrder }));
vi.mock('./assignment-entry-evaluation.service.js', () => ({ evaluateAssignmentEntry: vi.fn() }));
vi.mock('../workers/order.worker.js', () => ({ syncSubmittedOrdersForAccount: vi.fn() }));
vi.mock('./broker-activity.service.js', () => ({ syncBrokerActivitiesForAccount: vi.fn() }));
vi.mock('./position-tracking.service.js', () => ({ syncTrackedPositionsForAccount: vi.fn() }));
vi.mock('./reconciliation.service.js', () => ({ reconcileTradingAccount: vi.fn() }));

import {
  createLiveEntryAcceptanceRun,
  executeLiveEntryAcceptanceRun,
  previewLiveEntryAcceptanceRun,
} from './live-entry-acceptance.service.js';

function assignment(status: 'ACTIVE' | 'PAUSED' | 'DISABLED', environment: 'LIVE' | 'PAPER' = 'LIVE') {
  return {
    id: 8,
    tradingAccountId: 1,
    subscriptionId: 3,
    tradingAccount: {
      environment,
      status,
      tradingEnabled: false,
      killSwitchEnabled: true,
      activeLiveEntryArmingId: null,
    },
    subscription: { securityId: 4, security: { id: 4, symbol: 'RSP' } },
  };
}

function run(status: 'ACTIVE' | 'PAUSED') {
  return {
    id: 9,
    tradingAccountId: 1,
    tradingAccountSubscriptionId: 8,
    subscriptionId: 3,
    securityId: 4,
    createdByUserId: 2,
    reason: 'First canary',
    previewRevision: 0,
    previewFingerprint: null,
    previewJson: null,
    previewedAt: null,
    executionClaimedAt: null,
    executionRequestedByUserId: null,
    executionRequestKey: null,
    executionUncertainAt: null,
    executionFailureJson: null,
    terminalOutcome: null,
    terminalReason: null,
    terminalEvidenceJson: null,
    terminalAt: null,
    terminatedByUserId: null,
    liveEntryArming: null,
    orderIntent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tradingAccount: {
      id: 1,
      displayName: 'Bobby Live',
      environment: 'LIVE',
      status,
      tradingEnabled: false,
      killSwitchEnabled: true,
      activeLiveEntryArmingId: null,
    },
    tradingAccountSubscription: {
      ...assignment(status),
      enabled: true,
      entriesEnabled: false,
      exitsEnabled: true,
      subscription: {
        id: 3,
        key: 'rsp_dip_core',
        securityId: 4,
        security: { id: 4, symbol: 'RSP' },
      },
    },
  };
}

const createArgs = {
  tradingAccountId: 1,
  tradingAccountSubscriptionId: 8,
  createdByUserId: 2,
  reason: 'First canary',
};

describe('Live-entry acceptance run creation posture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.approvalFindMany.mockResolvedValue([]);
    mocks.readinessFindFirst.mockResolvedValue(null);
    mocks.computeReadinessFingerprints.mockResolvedValue(null);
  });

  it('creates a SETUP run for a safely paused Live account without conferring authority', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(assignment('PAUSED'));
    mocks.runCreate.mockResolvedValue(run('PAUSED'));

    const projection = await createLiveEntryAcceptanceRun(createArgs);

    expect(projection.phase).toBe('SETUP');
    expect(projection.setup).toEqual({
      ready: false,
      accountActive: false,
      assignmentMatches: true,
      canaryStaged: false,
    });
    expect(mocks.runCreate).toHaveBeenCalledTimes(1);
    expect(mocks.validateActiveLiveEntryArming).not.toHaveBeenCalled();
    expect(mocks.submitOrder).not.toHaveBeenCalled();
    expect(mocks.disarmLiveEntries).not.toHaveBeenCalled();
  });

  it('creates a run for an otherwise eligible active Live account', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(assignment('ACTIVE'));
    mocks.runCreate.mockResolvedValue(run('ACTIVE'));

    const projection = await createLiveEntryAcceptanceRun(createArgs);

    expect(projection.phase).toBe('SETUP');
    expect(projection.setup.accountActive).toBe(true);
    expect(projection.setup.canaryStaged).toBe(false);
  });

  it('rejects Paper and nonparticipating Live account states', async () => {
    mocks.assignmentFindFirst.mockResolvedValueOnce(assignment('ACTIVE', 'PAPER'));
    await expect(createLiveEntryAcceptanceRun(createArgs)).rejects.toThrow(
      'applies only to LIVE accounts',
    );

    mocks.assignmentFindFirst.mockResolvedValueOnce(assignment('DISABLED'));
    await expect(createLiveEntryAcceptanceRun(createArgs)).rejects.toThrow(
      'requires an ACTIVE or safely PAUSED account',
    );
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  it.each([
    { tradingEnabled: true },
    { killSwitchEnabled: false },
    { activeLiveEntryArmingId: 12 },
  ])('rejects an unsafe paused posture: %j', async (override) => {
    mocks.assignmentFindFirst.mockResolvedValue({
      ...assignment('PAUSED'),
      tradingAccount: { ...assignment('PAUSED').tradingAccount, ...override },
    });

    await expect(createLiveEntryAcceptanceRun(createArgs)).rejects.toThrow(
      'must be entry-disarmed',
    );
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  it('preserves the one-unresolved-run uniqueness conflict', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(assignment('PAUSED'));
    mocks.runCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );

    await expect(createLiveEntryAcceptanceRun(createArgs)).rejects.toThrow(
      'already has an unresolved acceptance run',
    );
  });

  it('cannot preview or execute a newly created paused run without arming authority', async () => {
    const pausedRun = run('PAUSED');
    mocks.runFindFirst.mockResolvedValue(pausedRun);
    mocks.validateActiveLiveEntryArming.mockResolvedValue({
      valid: false,
      reason: 'ACCOUNT_LATCH_MISMATCH',
    });

    await expect(previewLiveEntryAcceptanceRun({ tradingAccountId: 1, runId: 9 }))
      .rejects.toThrow('A valid active Live-entry arming is required');
    await expect(executeLiveEntryAcceptanceRun({
      tradingAccountId: 1,
      runId: 9,
      actorUserId: 2,
      requestKey: 'request-key',
      expectedPreviewRevision: 0,
      expectedPreviewFingerprint: 'a'.repeat(64),
      typedConfirmation: 'BUY RSP',
    })).rejects.toThrow('Typed confirmation must exactly match');
    expect(mocks.submitOrder).not.toHaveBeenCalled();
  });
});
