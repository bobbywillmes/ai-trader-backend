import { describe, expect, it } from 'vitest';
import {
  blockingAccountWorkers,
  deriveReadinessValidity,
  readinessFingerprint,
} from './trading-account-readiness.service.js';

describe('account worker readiness blockers', () => {
  it('blocks only unhealthy applicable workers without mutating health', () => {
    const workers = [
      { workerKey: 'healthy', applicable: true, status: 'HEALTHY' },
      { workerKey: 'dormant', applicable: false, status: 'DORMANT' },
      { workerKey: 'stale-dormant', applicable: false, status: 'STALE' },
      { workerKey: 'stale', applicable: true, status: 'STALE' },
      { workerKey: 'failing', applicable: true, status: 'FAILING' },
      { workerKey: 'backoff', applicable: true, status: 'BACKING_OFF' },
      { workerKey: 'degraded', applicable: true, status: 'DEGRADED' },
    ];
    const before = structuredClone(workers);

    expect(blockingAccountWorkers(workers).map((worker) => worker.workerKey))
      .toEqual(['stale', 'failing', 'backoff', 'degraded']);
    expect(workers).toEqual(before);
  });
});

describe('readiness fingerprints', () => {
  it('is deterministic across object property ordering', () => {
    expect(readinessFingerprint({ beta: 2, alpha: { y: 2, x: 1 } }))
      .toBe(readinessFingerprint({ alpha: { x: 1, y: 2 }, beta: 2 }));
  });

  it('changes for meaningful configuration and policy values', () => {
    expect(readinessFingerprint({ tradingEnabled: false }))
      .not.toBe(readinessFingerprint({ tradingEnabled: true }));
    expect(readinessFingerprint({ allowLiveTrading: false }))
      .not.toBe(readinessFingerprint({ allowLiveTrading: true }));
  });
});

describe('readiness validity', () => {
  const fingerprints = {
    configurationFingerprint: 'configuration',
    credentialFingerprint: 'credential',
    policyFingerprint: 'policy',
  };

  it('returns CURRENT when evidence matches and is unexpired', () => {
    expect(deriveReadinessValidity({
      ...fingerprints, expiresAt: new Date('2026-01-01T00:05:00Z'),
    }, fingerprints, new Date('2026-01-01T00:00:00Z'))).toEqual({
      validity: 'CURRENT', staleReasons: [],
    });
  });

  it('returns explicit stale reasons', () => {
    expect(deriveReadinessValidity({
      ...fingerprints, credentialFingerprint: 'old', policyFingerprint: 'old-policy',
      expiresAt: new Date('2026-01-01T00:05:00Z'),
    }, fingerprints, new Date('2026-01-01T00:00:00Z'))).toEqual({
      validity: 'STALE', staleReasons: ['CREDENTIAL_CHANGED', 'POLICY_CHANGED'],
    });
  });

  it('gives expiration presentation precedence while retaining stale reasons', () => {
    expect(deriveReadinessValidity({
      ...fingerprints, configurationFingerprint: 'old',
      expiresAt: new Date('2025-12-31T23:59:00Z'),
    }, fingerprints, new Date('2026-01-01T00:00:00Z'))).toEqual({
      validity: 'EXPIRED', staleReasons: ['CONFIGURATION_CHANGED'],
    });
  });
});
