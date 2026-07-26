import { describe, expect, it } from 'vitest';
import { deriveTradingAccountWorkerStatus } from './trading-account-worker-health.service.js';
import { getWorkerDefinition } from '../workers/worker-health.definitions.js';

const definition = getWorkerDefinition('exit_evaluation');
const now = new Date('2026-07-26T20:00:00.000Z');
const base = {
  applicable: true, eligible: true, currentRunStartedAt: null,
  lastSucceededAt: now, lastFailedAt: null, consecutiveFailures: 0,
  backoffUntil: null, lastLockSkippedAt: null,
};

describe('deriveTradingAccountWorkerStatus', () => {
  it('keeps dormant workflows from becoming stale without a success', () => {
    expect(deriveTradingAccountWorkerStatus({
      ...base, applicable: false, lastSucceededAt: null,
    }, definition, now)).toBe('DORMANT');
  });

  it('preserves failure visibility while retry backoff is active', () => {
    expect(deriveTradingAccountWorkerStatus({
      ...base, consecutiveFailures: 2,
      lastFailedAt: new Date(now.getTime() - 1_000),
      backoffUntil: new Date(now.getTime() + 10_000),
    }, definition, now)).toBe('BACKING_OFF');
  });

  it('does not hide an applicable credential failure as dormant', () => {
    expect(deriveTradingAccountWorkerStatus({
      ...base,
      eligible: false,
      consecutiveFailures: 1,
      lastFailedAt: new Date(now.getTime() - 1_000),
    }, definition, now)).toBe('FAILING');
  });

  it('makes repeated lock exclusion stale after the freshness threshold', () => {
    expect(deriveTradingAccountWorkerStatus({
      ...base, lastSucceededAt: null,
      lastLockSkippedAt: new Date(now.getTime() - definition.staleAfterMs - 1),
    }, definition, now)).toBe('STALE');
  });

  it('distinguishes delayed and stale successful heartbeats', () => {
    expect(deriveTradingAccountWorkerStatus({
      ...base,
      lastSucceededAt: new Date(now.getTime() - definition.delayedAfterMs - 1),
    }, definition, now)).toBe('DELAYED');
    expect(deriveTradingAccountWorkerStatus({
      ...base,
      lastSucceededAt: new Date(now.getTime() - definition.staleAfterMs - 1),
    }, definition, now)).toBe('STALE');
  });
});
