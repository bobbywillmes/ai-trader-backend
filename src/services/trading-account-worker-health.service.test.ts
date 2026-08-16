import { describe, expect, it } from 'vitest';
import {
  deriveTradingAccountWorkerStatus,
  isAccountWorkerRecoveryTransition,
} from './trading-account-worker-health.service.js';
import { getWorkerDefinition } from '../workers/worker-health.definitions.js';

const definition = getWorkerDefinition('exit_evaluation');
const now = new Date('2026-07-26T20:00:00.000Z');
const base = {
  applicable: true, eligible: true, currentRunStartedAt: null,
  lastSucceededAt: now, lastFailedAt: null, consecutiveFailures: 0,
  backoffUntil: null, lastLockSkippedAt: null, totalLockSkips: 0,
  createdAt: now,
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
      totalLockSkips: 3,
      lastLockSkippedAt: now,
      createdAt: new Date(now.getTime() - definition.staleAfterMs - 1),
    }, definition, now)).toBe('STALE');
  });

  it('makes sustained contention delayed before it becomes stale', () => {
    expect(deriveTradingAccountWorkerStatus({
      ...base,
      lastSucceededAt: null,
      totalLockSkips: 2,
      lastLockSkippedAt: now,
      createdAt: new Date(now.getTime() - definition.delayedAfterMs - 1),
    }, definition, now)).toBe('DELAYED');
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

describe('isAccountWorkerRecoveryTransition', () => {
  it.each([
    ['FAILING', 'HEALTHY'],
    ['STALE', 'HEALTHY'],
    ['DEGRADED', 'HEALTHY'],
    ['BACKING_OFF', 'HEALTHY'],
  ] as const)('classifies %s to %s as recovery', (previous, next) => {
    expect(isAccountWorkerRecoveryTransition(previous, next)).toBe(true);
  });

  it.each([
    ['FAILING', 'BACKING_OFF'],
    ['STALE', 'BACKING_OFF'],
    ['DEGRADED', 'BACKING_OFF'],
    ['FAILING', 'DEGRADED'],
    ['STALE', 'DEGRADED'],
    ['BACKING_OFF', 'FAILING'],
    ['BACKING_OFF', 'BACKING_OFF'],
    ['HEALTHY', 'HEALTHY'],
    ['FAILING', 'DORMANT'],
    ['STALE', 'DORMANT'],
  ] as const)('does not classify %s to %s as recovery', (previous, next) => {
    expect(isAccountWorkerRecoveryTransition(previous, next)).toBe(false);
  });
});
