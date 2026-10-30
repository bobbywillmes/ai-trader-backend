import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enumerateLifecycleAccounts } from './lifecycle-account-eligibility.service.js';

const mocks = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  intentGroupBy: vi.fn(),
  positionGroupBy: vi.fn(),
  terminalClaimRecovery: vi.fn(),
  tradingViewRecoveryGroupBy: vi.fn(),
}));

vi.mock('./entry-dispatch-recovery.service.js', () => ({
  summarizeTerminalClaimRecoveryByAccount: mocks.terminalClaimRecovery,
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: { findMany: mocks.accountFindMany },
    orderIntent: { groupBy: mocks.intentGroupBy },
    trackedPosition: { groupBy: mocks.positionGroupBy },
    externalSignalTradeCycleAccount: { groupBy: mocks.tradingViewRecoveryGroupBy },
  },
}));

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    displayName: 'Bobby Paper',
    broker: 'ALPACA',
    environment: 'PAPER',
    status: 'ACTIVE',
    credential: { status: 'ACTIVE' },
    _count: {
      orderIntents: 0,
      brokerOrders: 0,
      trackedPositions: 0,
      brokerActivities: 0,
    },
    ...overrides,
  };
}

describe('lifecycle account eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.intentGroupBy.mockResolvedValue([]);
    mocks.positionGroupBy.mockResolvedValue([]);
    mocks.terminalClaimRecovery.mockResolvedValue(new Map());
    mocks.tradingViewRecoveryGroupBy.mockResolvedValue([]);
  });

  it('returns accounts in stable ID order with workflow-specific reasons', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({ id: 1 }),
      account({
        id: 2,
        displayName: 'Bobby Live',
        environment: 'LIVE',
        status: 'NEEDS_CREDENTIALS',
        credential: null,
      }),
    ]);

    const result = await enumerateLifecycleAccounts('scheduled_snapshots');

    expect(mocks.accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'asc' } })
    );
    expect(result.map((item) => item.tradingAccountId)).toEqual([1, 2]);
    expect(result[0]).toMatchObject({
      eligible: true,
      reason: 'usable_credentials_operational_account',
    });
    expect(result[1]).toMatchObject({
      eligible: false,
      reason: 'credentials_unavailable_dormant',
    });
  });

  it('marks a credentialless paused account with exposure as critical lifecycle work', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        status: 'PAUSED',
        credential: null,
        _count: {
          orderIntents: 1,
          brokerOrders: 1,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
    ]);
    mocks.intentGroupBy.mockResolvedValue([
      {
        tradingAccountId: 1,
        status: 'submitted',
        _count: { _all: 1 },
      },
    ]);

    const result = await enumerateLifecycleAccounts('positions');

    expect(result[0]).toMatchObject({
      eligible: false,
      reason: 'credentials_unavailable_with_exposure',
      exposureSummary: {
        submittedIntents: 1,
        nonterminalOrders: 1,
        activePositions: 1,
        hasLifecycleWork: true,
      },
    });
  });

  it('keeps paused accounts with usable credentials lifecycle-eligible', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        status: 'PAUSED',
        _count: {
          orderIntents: 0,
          brokerOrders: 0,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
    ]);

    const result = await enumerateLifecycleAccounts('positions');

    expect(result[0]).toMatchObject({
      eligible: true,
      reason: 'usable_credentials_with_work',
    });
  });

  it('evaluates exits for paused or kill-switched accounts with exposure', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        id: 1,
        status: 'PAUSED',
        _count: {
          orderIntents: 0,
          brokerOrders: 0,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
      account({
        id: 2,
        status: 'ERROR',
        _count: {
          orderIntents: 0,
          brokerOrders: 0,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
    ]);

    const result = await enumerateLifecycleAccounts('exit_evaluation');

    expect(result).toEqual([
      expect.objectContaining({ tradingAccountId: 1, eligible: true }),
      expect.objectContaining({ tradingAccountId: 2, eligible: true }),
    ]);
  });

  it('does not enumerate a credentialed account without exposure for exit evaluation', async () => {
    mocks.accountFindMany.mockResolvedValue([account()]);

    const result = await enumerateLifecycleAccounts('exit_evaluation');

    expect(result[0]).toMatchObject({
      eligible: false,
      reason: 'no_work_for_workflow',
    });
  });

  it('reports credentialless pending submissions without making them eligible', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        credential: null,
        _count: {
          orderIntents: 1,
          brokerOrders: 0,
          trackedPositions: 0,
          brokerActivities: 0,
        },
      }),
    ]);
    mocks.intentGroupBy.mockResolvedValue([
      {
        tradingAccountId: 1,
        status: 'pending',
        _count: { _all: 1 },
      },
    ]);

    const result = await enumerateLifecycleAccounts('pending_submissions');

    expect(result[0]).toMatchObject({
      eligible: false,
      reason: 'credentials_unavailable_with_exposure',
      exposureSummary: { pendingIntents: 1 },
    });
  });

  it('enumerates submitted-order recovery when the only work is a due, actionable terminal entry claim', async () => {
    mocks.accountFindMany.mockResolvedValue([account()]);
    mocks.terminalClaimRecovery.mockResolvedValue(new Map([[1, { actionableDue: 1, actionableWaiting: 0, operatorInvestigation: 0, protectedExposure: 0, held: 1 }]]));

    const result = await enumerateLifecycleAccounts('submitted_orders');

    expect(result[0]).toMatchObject({
      eligible: true,
      reason: 'usable_credentials_with_work',
      exposureSummary: { terminalEntryClaimsDue: 1, terminalEntryClaimsHeld: 1, hasLifecycleWork: true },
    });
  });

  it('does not schedule the sweep for operator-only or waiting claims, yet keeps them visible as credential exposure', async () => {
    mocks.terminalClaimRecovery.mockResolvedValue(new Map([
      [1, { actionableDue: 0, actionableWaiting: 1, operatorInvestigation: 2, protectedExposure: 0, held: 3 }],
      [2, { actionableDue: 0, actionableWaiting: 0, operatorInvestigation: 1, protectedExposure: 0, held: 1 }],
    ]));
    mocks.accountFindMany.mockResolvedValue([account(), account({ id: 2, displayName: 'Bobby Live', environment: 'LIVE', credential: null })]);

    const [credentialed, credentialless] = await enumerateLifecycleAccounts('submitted_orders');

    expect(credentialed).toMatchObject({ eligible: false, reason: 'no_work_for_workflow', exposureSummary: { terminalEntryClaimsDue: 0, terminalEntryClaimsHeld: 3, hasLifecycleWork: false } });
    expect(credentialless).toMatchObject({ eligible: false, reason: 'credentials_unavailable_with_exposure', exposureSummary: { terminalEntryClaimsHeld: 1 } });
  });

  it('schedules stale-admission recovery only when due, and keeps abandoned admissions visible as credential exposure', async () => {
    const entry = (staleAdmissionDue: number, staleAdmissionHeld: number) => ({ actionableDue: 0, actionableWaiting: 0, operatorInvestigation: 0, protectedExposure: 0, held: 0, staleAdmissionDue, staleAdmissionHeld });
    mocks.terminalClaimRecovery.mockResolvedValue(new Map([[1, entry(1, 1)], [2, entry(0, 1)], [3, entry(0, 1)]]));
    mocks.accountFindMany.mockResolvedValue([account(), account({ id: 2 }), account({ id: 3, credential: null })]);

    const [due, waiting, credentialless] = await enumerateLifecycleAccounts('submitted_orders');

    expect(due).toMatchObject({ eligible: true, exposureSummary: { staleAdmissionClaimsDue: 1, staleAdmissionClaimsHeld: 1, hasLifecycleWork: true } });
    expect(waiting).toMatchObject({ eligible: false, reason: 'no_work_for_workflow', exposureSummary: { staleAdmissionClaimsDue: 0, staleAdmissionClaimsHeld: 1 } });
    expect(credentialless).toMatchObject({ eligible: false, reason: 'credentials_unavailable_with_exposure', exposureSummary: { staleAdmissionClaimsHeld: 1 } });
  });

  it('schedules unfinished TradingView reconciliation after its exposure claim has been released', async () => {
    mocks.accountFindMany.mockResolvedValue([account()]);
    mocks.tradingViewRecoveryGroupBy.mockResolvedValue([{ tradingAccountId: 1, _count: { _all: 1 } }]);

    const [result] = await enumerateLifecycleAccounts('submitted_orders');

    expect(mocks.tradingViewRecoveryGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: 'ENTRY_INTENT_CREATED',
        entryOrderIntent: { is: { status: { in: ['blocked', 'failed'] } } },
      },
    }));
    expect(result).toMatchObject({
      eligible: true,
      reason: 'usable_credentials_with_work',
      exposureSummary: { tradingViewAdmissionReconciliations: 1, hasLifecycleWork: true },
    });
  });
});
