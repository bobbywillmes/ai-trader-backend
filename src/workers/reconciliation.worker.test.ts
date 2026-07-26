import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntimeTradingConfig: vi.fn(),
  reconcileEligibleTradingAccounts: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
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

import { runScheduledReconciliation } from './reconciliation.worker.js';

describe('runScheduledReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    });

    expect(mocks.reconcileEligibleTradingAccounts).not.toHaveBeenCalled();
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
