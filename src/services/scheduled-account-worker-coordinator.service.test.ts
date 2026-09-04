import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enumerate: vi.fn(),
  recordAttempt: vi.fn(),
}));

vi.mock('./lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerate,
}));

vi.mock('./trading-account-workflow-runner.service.js', () => ({ accountWorkflowProcessInstanceId: 'test-process' }));
vi.mock('./trading-account-worker-health.service.js', () => ({ recordTradingAccountWorkerAttempt: mocks.recordAttempt }));

import { propagateScheduledAccountDecision } from './scheduled-account-worker-coordinator.service.js';

function account(id: number, overrides: Record<string, unknown> = {}) {
  return {
    tradingAccountId: id,
    displayName: `Account ${id}`,
    broker: 'ALPACA',
    environment: 'PAPER',
    status: 'PAUSED',
    credentialStatus: 'ACTIVE',
    eligible: true,
    reason: 'usable_credentials_operational_account',
    exposureSummary: { hasLifecycleWork: false },
    ...overrides,
  };
}

describe('scheduled account worker coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordAttempt.mockResolvedValue({});
  });

  it('records eligible not-due decisions as first-class healthy skips', async () => {
    mocks.enumerate.mockResolvedValue([account(1)]);

    await propagateScheduledAccountDecision({
      workflow: 'scheduled_snapshots',
      workerKey: 'account_snapshot_scheduler',
      lockFamily: 'account-snapshot',
      decision: 'not_due',
    });

    expect(mocks.enumerate).toHaveBeenCalledWith('scheduled_snapshots', {
      persistWorkerHealth: false,
    });
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      workerKey: 'account_snapshot_scheduler', outcome: 'skipped', skipReason: 'not_due',
      summary: { reason: 'not_due' },
    }));
  });

  it('marks every account dormant when the optional worker is disabled', async () => {
    mocks.enumerate.mockResolvedValue([
      account(1),
      account(2, {
        eligible: false,
        credentialStatus: null,
        reason: 'credentials_unavailable_with_exposure',
        exposureSummary: { hasLifecycleWork: true },
      }),
    ]);

    await propagateScheduledAccountDecision({
      workflow: 'reconciliation',
      workerKey: 'scheduled_reconciliation',
      lockFamily: 'reconciliation',
      decision: 'disabled',
    });

    expect(mocks.recordAttempt).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.recordAttempt.mock.calls) {
      expect(args).toMatchObject({ outcome: 'dormant', applicable: false, eligible: false, eligibilityReason: 'worker_disabled' });
    }
  });

  it('preserves credential failures and isolates later accounts', async () => {
    mocks.enumerate.mockResolvedValue([
      account(1, {
        eligible: false,
        credentialStatus: null,
        reason: 'credentials_unavailable_with_exposure',
        exposureSummary: { hasLifecycleWork: true },
      }),
      account(2),
    ]);

    const result = await propagateScheduledAccountDecision({
      workflow: 'scheduled_snapshots',
      workerKey: 'account_snapshot_scheduler',
      lockFamily: 'account-snapshot',
      decision: 'not_due',
    });

    expect(result.results.map((item) => item.outcome)).toEqual([
      'FAILED',
      'SKIPPED',
    ]);
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.recordAttempt.mock.calls[0]![0]).toMatchObject({
      outcome: 'failure',
      errorCode: 'CREDENTIALS_UNAVAILABLE_WITH_EXPOSURE',
      eligible: false,
    });
  });

  it('does not acquire a lifecycle lock for disabled or not-due bookkeeping', async () => {
    mocks.enumerate.mockResolvedValue([account(1)]);
    await propagateScheduledAccountDecision({ workflow: 'reconciliation', workerKey: 'scheduled_reconciliation', lockFamily: 'lifecycle-mutation', decision: 'disabled' });
    await propagateScheduledAccountDecision({ workflow: 'reconciliation', workerKey: 'scheduled_reconciliation', lockFamily: 'lifecycle-mutation', decision: 'not_due' });
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(2);
  });
});
