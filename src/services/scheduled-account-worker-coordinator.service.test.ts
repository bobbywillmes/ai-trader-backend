import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enumerate: vi.fn(),
  runWorkflow: vi.fn(),
}));

vi.mock('./lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerate,
}));

vi.mock('./trading-account-workflow-runner.service.js', () => ({
  runTradingAccountWorkflow: mocks.runWorkflow,
}));

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
    mocks.runWorkflow.mockImplementation(async (args) => {
      const value = await args.execute();
      const classification = args.classify(value);
      return classification.outcome === 'failure'
        ? { outcome: 'FAILED', error: classification.error }
        : { outcome: 'SKIPPED', value };
    });
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
    const args = mocks.runWorkflow.mock.calls[0]![0];
    expect(args.classify()).toEqual({
      outcome: 'skipped',
      skipReason: 'not_due',
      summary: { reason: 'not_due' },
    });
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

    expect(mocks.runWorkflow).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.runWorkflow.mock.calls) {
      expect(args.classify()).toMatchObject({
        outcome: 'dormant',
        eligibilityReason: 'worker_disabled',
      });
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
    expect(mocks.runWorkflow).toHaveBeenCalledTimes(2);
    expect(mocks.runWorkflow.mock.calls[0]![0].classify()).toMatchObject({
      outcome: 'failure',
      errorCode: 'CREDENTIALS_UNAVAILABLE_WITH_EXPOSURE',
      eligible: false,
    });
  });

  it('preserves lock contention and backoff outcomes', async () => {
    mocks.enumerate.mockResolvedValue([account(1), account(2)]);
    mocks.runWorkflow
      .mockResolvedValueOnce({ outcome: 'LOCK_SKIPPED' })
      .mockResolvedValueOnce({
        outcome: 'BACKING_OFF',
        backoffUntil: new Date('2026-07-27T14:00:00.000Z'),
      });

    const result = await propagateScheduledAccountDecision({
      workflow: 'scheduled_snapshots',
      workerKey: 'account_snapshot_scheduler',
      lockFamily: 'account-snapshot',
      decision: 'not_due',
    });

    expect(result.results).toEqual([
      expect.objectContaining({ outcome: 'LOCK_SKIPPED' }),
      expect.objectContaining({
        outcome: 'BACKING_OFF',
        backoffUntil: '2026-07-27T14:00:00.000Z',
      }),
    ]);
  });
});
