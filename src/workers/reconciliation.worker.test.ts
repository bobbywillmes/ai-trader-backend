import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntimeTradingConfig: vi.fn(),
  runReconciliationCheck: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../services/config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

vi.mock('../services/reconciliation.service.js', () => ({
  runReconciliationCheck: mocks.runReconciliationCheck,
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

    expect(mocks.runReconciliationCheck).not.toHaveBeenCalled();
  });

  it('runs reconciliation when enabled and due', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      reconciliationWorkerEnabled: true,
      reconciliationWorkerIntervalMinutes: 15,
    });

    mocks.runReconciliationCheck.mockResolvedValue({
      findings: [],
      eventCount: 0,
      skippedDuplicateEventCount: 0,
      attentionUpdateCount: 0,
      persistedEvents: true,
      persistedAttention: true,
    });

    const result = await runScheduledReconciliation();

    expect(result).toEqual({
      skipped: false,
      result: {
        findings: [],
        eventCount: 0,
        skippedDuplicateEventCount: 0,
        attentionUpdateCount: 0,
        persistedEvents: true,
        persistedAttention: true,
      },
    });

    expect(mocks.runReconciliationCheck).toHaveBeenCalledWith({
      persistEvents: true,
      persistAttention: true,
      dedupeEvents: true,
    });
  });
});