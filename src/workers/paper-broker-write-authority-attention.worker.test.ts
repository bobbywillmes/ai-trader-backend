import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock('../services/paper-broker-write-authority-attention.service.js', () => ({
  reconcileAllPaperBrokerWriteAuthorityAttention: mocks.reconcile,
}));

import { runPaperBrokerWriteAuthorityAttentionWorker } from './paper-broker-write-authority-attention.worker.js';

describe('PAPER authority attention worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports successful reconciliation and account-enumeration failure distinctly', async () => {
    mocks.reconcile.mockResolvedValueOnce({ assessed: 2, failures: [], assessmentUnresolved: [] });
    await expect(runPaperBrokerWriteAuthorityAttentionWorker()).resolves.toMatchObject({ outcome: 'success' });
    mocks.reconcile.mockResolvedValueOnce({ assessed: 0, failures: [], assessmentUnresolved: ['PAPER account enumeration failed.'] });
    await expect(runPaperBrokerWriteAuthorityAttentionWorker()).rejects.toThrow('enumeration failed');
  });

  it('prevents overlapping runs and surfaces per-account failure', async () => {
    let release!: () => void;
    mocks.reconcile.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ assessed: 1, failures: [], assessmentUnresolved: [] }); }));
    const first = runPaperBrokerWriteAuthorityAttentionWorker();
    await expect(runPaperBrokerWriteAuthorityAttentionWorker()).resolves.toEqual({ outcome: 'skipped', skipReason: 'already_running' });
    release();
    await expect(first).resolves.toMatchObject({ outcome: 'success' });
    mocks.reconcile.mockResolvedValueOnce({ assessed: 1, failures: [{ tradingAccountId: 7, error: 'failed' }], assessmentUnresolved: [] });
    await expect(runPaperBrokerWriteAuthorityAttentionWorker()).rejects.toThrow('7');
  });
});
