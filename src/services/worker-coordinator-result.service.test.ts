import { describe, expect, it } from 'vitest';

import {
  AccountCoordinatorFailureError,
  assertAccountCoordinatorHealthy,
} from './worker-coordinator-result.service.js';

function result(
  id: number,
  outcome: 'PROCESSED' | 'SKIPPED' | 'CREDENTIALS_UNAVAILABLE' | 'FAILED'
) {
  return {
    account: { tradingAccountId: id, displayName: `Account ${id}` },
    outcome,
  };
}

describe('worker coordinator health result', () => {
  it('fails after a mixed success and account failure', () => {
    expect(() =>
      assertAccountCoordinatorHealthy('positions', [
        result(1, 'PROCESSED'),
        result(2, 'FAILED'),
      ])
    ).toThrow(AccountCoordinatorFailureError);
  });

  it('fails when all accounts fail', () => {
    expect(() =>
      assertAccountCoordinatorHealthy('activities', [
        result(1, 'FAILED'),
        result(2, 'FAILED'),
      ])
    ).toThrow(/2:Account 2:FAILED/);
  });

  it('accepts success plus a dormant skip', () => {
    expect(() =>
      assertAccountCoordinatorHealthy('snapshots', [
        result(1, 'PROCESSED'),
        result(2, 'SKIPPED'),
      ])
    ).not.toThrow();
  });

  it('fails visibly for credential-unavailable lifecycle exposure', () => {
    expect(() =>
      assertAccountCoordinatorHealthy('pending', [
        result(1, 'CREDENTIALS_UNAVAILABLE'),
      ])
    ).toThrow(
      expect.objectContaining({
        credentialUnavailableAccounts: 1,
        failedAccounts: 0,
      })
    );
  });

  it('surfaces a stale-recovery account failure', () => {
    expect(() =>
      assertAccountCoordinatorHealthy('stale_submitting_recovery', [
        result(1, 'PROCESSED'),
        result(2, 'FAILED'),
      ])
    ).toThrow(/stale_submitting_recovery completed with account failures/);
  });
});
