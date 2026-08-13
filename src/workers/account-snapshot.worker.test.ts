import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runScheduledAccountSnapshots } from './account-snapshot.worker.js';

const mocks = vi.hoisted(() => ({
  enumerate: vi.fn(),
  record: vi.fn(),
  propagate: vi.fn(),
}));

vi.mock('../services/scheduled-account-worker-coordinator.service.js', () => ({
  propagateScheduledAccountDecision: mocks.propagate,
}));

vi.mock('../services/lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerate,
}));

vi.mock('../services/account-snapshot.service.js', () => ({
  recordAccountSnapshot: mocks.record,
}));

vi.mock('../services/trading-account-workflow-runner.service.js', () => ({
  runTradingAccountWorkflow: async <T>(args: {
    execute: () => Promise<T>;
    classify?: (value: T) => { outcome: 'success' | 'skipped' | 'failure'; error?: unknown };
  }) => {
    try {
      const value = await args.execute();
      const classification = args.classify?.(value);
      if (classification?.outcome === 'failure') {
        return { outcome: 'FAILED' as const, error: classification.error, value };
      }
      return {
        outcome: classification?.outcome === 'skipped'
          ? 'SKIPPED' as const
          : 'PROCESSED' as const,
        value,
      };
    } catch (error) {
      return { outcome: 'FAILED' as const, error };
    }
  },
}));

function account(id: number) {
  return {
    tradingAccountId: id,
    displayName: `Account ${id}`,
    broker: 'ALPACA',
    environment: id === 1 ? 'PAPER' : 'LIVE',
    status: 'PAUSED',
    credentialStatus: 'ACTIVE',
    eligible: true,
    reason: 'usable_credentials_with_work',
    exposureSummary: { hasLifecycleWork: true },
  };
}

describe('scheduled snapshot account coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T13:36:00.000Z'));
    mocks.propagate.mockResolvedValue({ results: [{ outcome: 'SKIPPED' }] });
  });

  it('propagates a healthy not-due decision outside checkpoint windows', async () => {
    vi.setSystemTime(new Date('2026-07-27T14:00:00.000Z'));

    const result = await runScheduledAccountSnapshots();

    expect(mocks.propagate).toHaveBeenCalledWith({
      workflow: 'scheduled_snapshots',
      workerKey: 'account_snapshot_scheduler',
      lockFamily: 'account-snapshot',
      decision: 'not_due',
    });
    expect(result).toMatchObject({ due: false, results: [{ outcome: 'SKIPPED' }] });
    expect(mocks.enumerate).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('propagates a healthy not-due decision on weekends', async () => {
    vi.setSystemTime(new Date('2026-08-01T14:00:00.000Z'));

    await runScheduledAccountSnapshots();

    expect(mocks.propagate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'not_due',
    }));
    expect(mocks.enumerate).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the same checkpoint run key and isolates snapshot failures', async () => {
    mocks.enumerate.mockResolvedValue([account(1), account(2)]);
    mocks.record
      .mockRejectedValueOnce(new Error('Paper snapshot failed'))
      .mockResolvedValueOnce({ created: true });

    const result = await runScheduledAccountSnapshots();

    expect(mocks.record.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    expect(mocks.record.mock.calls.map((call) => call[1].runKey)).toEqual([
      'scheduled_morning:2026-07-27',
      'scheduled_morning:2026-07-27',
    ]);
    expect(result.results.map((item) => item.outcome)).toEqual([
      'FAILED',
      'PROCESSED',
    ]);
    expect(result.recorded).toBe(1);
  });

  it('skips dormant credentialless accounts before snapshot fetch', async () => {
    mocks.enumerate.mockResolvedValue([
      {
        ...account(2),
        eligible: false,
        credentialStatus: null,
        reason: 'credentials_unavailable_dormant',
        exposureSummary: { hasLifecycleWork: false },
      },
    ]);

    const result = await runScheduledAccountSnapshots();

    expect(mocks.record).not.toHaveBeenCalled();
    expect(result.results[0]?.outcome).toBe('SKIPPED');
  });
});
