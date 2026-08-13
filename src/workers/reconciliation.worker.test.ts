import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntimeTradingConfig: vi.fn(),
  reconcileEligibleTradingAccounts: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  propagate: vi.fn(),
}));

vi.mock('../services/scheduled-account-worker-coordinator.service.js', () => ({
  propagateScheduledAccountDecision: mocks.propagate,
}));

vi.mock('../services/config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

vi.mock('../services/reconciliation.service.js', () => ({
  reconcileEligibleTradingAccounts: mocks.reconcileEligibleTradingAccounts,
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import {
  resetScheduledReconciliationStateForTests,
  runScheduledReconciliation,
} from './reconciliation.worker.js';

describe('runScheduledReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetScheduledReconciliationStateForTests();
    mocks.propagate.mockResolvedValue({ results: [{ outcome: 'SKIPPED' }] });
  });

  it('skips when the reconciliation worker is disabled', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      reconciliationWorkerEnabled: false,
      reconciliationWorkerIntervalMinutes: 15,
    });

    const result = await runScheduledReconciliation();

    expect(result).toEqual({
      skipped: true,
      reason: 'disabled',
      results: [{ outcome: 'SKIPPED' }],
    });

    expect(mocks.propagate).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'reconciliation',
      workerKey: 'scheduled_reconciliation',
      decision: 'disabled',
    }));

    expect(mocks.reconcileEligibleTradingAccounts).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('propagates healthy account decisions while the interval is not due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T14:00:00.000Z'));
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      reconciliationWorkerEnabled: true,
      reconciliationWorkerIntervalMinutes: 15,
    });

    mocks.reconcileEligibleTradingAccounts.mockResolvedValue({
      processedAccounts: 1,
      failedAccounts: 0,
      credentialUnavailableAccounts: 0,
      skippedAccounts: 0,
      results: [],
    });
    await runScheduledReconciliation();
    vi.setSystemTime(new Date('2026-07-27T14:01:00.000Z'));
    const result = await runScheduledReconciliation();

    expect(result).toEqual({
      skipped: true,
      reason: 'not_due',
      results: [{ outcome: 'SKIPPED' }],
    });
    expect(mocks.propagate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'not_due',
    }));
  });

  it('runs reconciliation when enabled and due', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      reconciliationWorkerEnabled: true,
      reconciliationWorkerIntervalMinutes: 15,
    });

    mocks.reconcileEligibleTradingAccounts.mockResolvedValue({
      workflow: 'reconciliation',
      processedAccounts: 1,
      failedAccounts: 0,
      credentialUnavailableAccounts: 0,
      skippedAccounts: 0,
      results: [],
    });

    const result = await runScheduledReconciliation();

    expect(result).toEqual({
      skipped: false,
      result: {
        workflow: 'reconciliation',
        processedAccounts: 1,
        failedAccounts: 0,
        credentialUnavailableAccounts: 0,
        skippedAccounts: 0,
        results: [],
      },
    });

    expect(mocks.reconcileEligibleTradingAccounts).toHaveBeenCalledWith({
      persistEvents: true,
      persistAttention: true,
      dedupeEvents: true,
    });
  });
});
