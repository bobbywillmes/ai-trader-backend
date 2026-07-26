import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runScheduledAccountSnapshots } from './account-snapshot.worker.js';

const mocks = vi.hoisted(() => ({
  enumerate: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../services/lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerate,
}));

vi.mock('../services/account-snapshot.service.js', () => ({
  recordAccountSnapshot: mocks.record,
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
