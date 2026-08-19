import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runBrokerActivitySync } from './broker-activity.worker.js';

const mocks = vi.hoisted(() => ({
  enumerate: vi.fn(),
  syncForAccount: vi.fn(),
  runWorkflow: vi.fn(),
}));

vi.mock('../services/lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerate,
}));

vi.mock('../services/broker-activity.service.js', () => ({
  syncBrokerActivitiesForAccount: mocks.syncForAccount,
}));

vi.mock('../services/trading-account-workflow-runner.service.js', () => ({
  runTradingAccountWorkflow: mocks.runWorkflow,
}));

function eligible(id: number) {
  return {
    tradingAccountId: id,
    displayName: `Account ${id}`,
    broker: 'ALPACA',
    environment: id === 1 ? 'PAPER' : 'LIVE',
    status: 'ACTIVE',
    credentialStatus: 'ACTIVE',
    eligible: true,
    reason: 'usable_credentials_with_work',
    exposureSummary: { hasLifecycleWork: true },
  };
}

describe('broker activity account coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runWorkflow.mockImplementation(async ({ execute }) => {
      try {
        return { outcome: 'PROCESSED', value: await execute() };
      } catch (error) {
        return { outcome: 'FAILED', error };
      }
    });
  });

  it('continues in stable account order after one API failure', async () => {
    mocks.enumerate.mockResolvedValue([eligible(1), eligible(2)]);
    mocks.syncForAccount
      .mockRejectedValueOnce(new Error('Paper activity failure'))
      .mockResolvedValueOnce({ seen: 2, created: 2, updated: 0 });

    const result = await runBrokerActivitySync();

    expect(mocks.syncForAccount.mock.calls.map((call) => call[0])).toEqual([
      1, 2,
    ]);
    expect(result.results?.map((item) => item.outcome)).toEqual([
      'FAILED',
      'PROCESSED',
    ]);
  });

  it('makes no activity request for a dormant credentialless account', async () => {
    mocks.enumerate.mockResolvedValue([
      {
        ...eligible(2),
        eligible: false,
        credentialStatus: null,
        reason: 'credentials_unavailable_dormant',
        exposureSummary: { hasLifecycleWork: false },
      },
    ]);

    const result = await runBrokerActivitySync();

    expect(mocks.syncForAccount).not.toHaveBeenCalled();
    expect(result.results?.[0]?.outcome).toBe('SKIPPED');
  });
});
