import { describe, expect, it } from 'vitest';
import { TradingAccountReadinessPurpose } from '@prisma/client';
import {
  blockingAccountWorkers,
  deriveReadinessValidity,
  isCredentialVerificationCurrent,
  liveEntryArmingRiskReducingPrerequisitesPassed,
  liveEntryArmingWorkerGate,
  readinessAssessmentLifetimeMs,
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

describe('LIVE_ENTRY_ARMING worker gates', () => {
  const dormant = (workerKey: string) => ({
    workerKey,
    applicable: false,
    status: 'DORMANT',
    eligibilityReason: 'no_work_for_workflow',
  });
  const healthy = (workerKey: string) => ({
    workerKey,
    applicable: true,
    status: 'HEALTHY',
    eligibilityReason: 'usable_credentials_operational_account',
  });

  it.each([
    'pending_order_processing',
    'submitted_order_sync',
    'exit_evaluation',
  ])('accepts %s as dormant only when its account workload is empty', (workerKey) => {
    expect(liveEntryArmingWorkerGate(workerKey, dormant(workerKey))).toMatchObject({
      outcome: 'PASSED',
      evidence: { applicable: false, status: 'DORMANT', eligibilityReason: 'no_work_for_workflow' },
    });
  });

  it.each(['FAILING', 'STALE', 'BACKING_OFF'])('blocks an applicable work-dependent worker in %s', (status) => {
    expect(liveEntryArmingWorkerGate('pending_order_processing', {
      workerKey: 'pending_order_processing', applicable: true, status,
    }).outcome).toBe('BLOCKED');
  });

  it('does not accept dormant when credentials or another condition made the worker inapplicable', () => {
    expect(liveEntryArmingWorkerGate('submitted_order_sync', {
      workerKey: 'submitted_order_sync', applicable: false, status: 'DORMANT',
      eligibilityReason: 'credentials_unavailable_dormant',
    }).outcome).toBe('BLOCKED');
  });

  it.each([
    'broker_activity_sync',
    'tracked_position_sync',
    'account_snapshot_scheduler',
  ])('requires always-applicable worker %s to remain applicable and healthy', (workerKey) => {
    expect(liveEntryArmingWorkerGate(workerKey, healthy(workerKey)).outcome).toBe('PASSED');
    expect(liveEntryArmingWorkerGate(workerKey, dormant(workerKey)).outcome).toBe('BLOCKED');
  });

  it('leaves only credential freshness and ENTRY authorization in a staged zero-exposure blocker set', () => {
    const workers = [
      dormant('pending_order_processing'),
      dormant('submitted_order_sync'),
      healthy('broker_activity_sync'),
      healthy('tracked_position_sync'),
      dormant('exit_evaluation'),
      healthy('account_snapshot_scheduler'),
    ];
    const workerBlockers = workers
      .map((row) => liveEntryArmingWorkerGate(row.workerKey, row))
      .filter((item) => item.outcome === 'BLOCKED');
    const unchangedNonWorkerBlockers = [
      'ARMING_CREDENTIAL_VERIFICATION_CURRENT',
      'ARMING_ENTRY_APPROVAL_CURRENT',
    ];
    expect([...workerBlockers.map((item) => item.code), ...unchangedNonWorkerBlockers])
      .toEqual(unchangedNonWorkerBlockers);
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

describe('LIVE_ENTRY_ARMING risk-reducing grant evidence', () => {
  const passed = (code: string) => ({ code, outcome: 'PASSED' as const, message: 'passed' });
  const blocked = (code: string) => ({ code, outcome: 'BLOCKED' as const, message: 'blocked' });

  it.each([
    [blocked('ARMING_RISK_REDUCING_APPROVAL')],
    [blocked('ARMING_ENTRY_APPROVAL_CURRENT')],
    [blocked('ARMING_RISK_REDUCING_APPROVAL'), blocked('ARMING_ENTRY_APPROVAL_CURRENT')],
  ])('allows only the expected unresolved authorization gates', (...authorizationGates) => {
    expect(liveEntryArmingRiskReducingPrerequisitesPassed([
      passed('ARMING_ACCOUNT_ACTIVE_DISARMED'),
      ...authorizationGates,
    ])).toBe(true);
  });

  it.each([
    'ARMING_CREDENTIAL_VERIFICATION_CURRENT',
    'ARMING_WORKER_PENDING_ORDER_PROCESSING',
    'LOCAL_OPEN_POSITIONS_EMPTY',
    'CANARY_ACCOUNT_RISK_LIMITS',
    'ARMING_DEPLOYMENT_EXECUTOR',
  ])('rejects unrelated blocker %s', (code) => {
    expect(liveEntryArmingRiskReducingPrerequisitesPassed([
      blocked('ARMING_RISK_REDUCING_APPROVAL'),
      blocked('ARMING_ENTRY_APPROVAL_CURRENT'),
      blocked(code),
    ])).toBe(false);
  });
});

describe('readiness operator and credential windows', () => {
  it('uses 15 minutes for LIVE_ENTRY_ARMING and retains five minutes for activation', () => {
    expect(readinessAssessmentLifetimeMs(TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING)).toBe(15 * 60_000);
    expect(readinessAssessmentLifetimeMs(TradingAccountReadinessPurpose.LIVE_ACTIVATION)).toBe(5 * 60_000);
  });

  it('keeps arming evidence current through its 15-minute window and expires afterward', () => {
    const fingerprints = { configurationFingerprint: 'c', credentialFingerprint: 'k', policyFingerprint: 'p' };
    const completedAt = new Date('2026-08-18T12:00:00Z');
    const assessment = { ...fingerprints, expiresAt: new Date(completedAt.getTime() + 15 * 60_000) };
    expect(deriveReadinessValidity(assessment, fingerprints, new Date('2026-08-18T12:14:59.999Z')).validity).toBe('CURRENT');
    expect(deriveReadinessValidity(assessment, fingerprints, new Date('2026-08-18T12:15:00.000Z')).validity).toBe('EXPIRED');
  });

  it('independently expires credential verification after 15 minutes', () => {
    const verifiedAt = new Date('2026-08-18T12:00:00Z');
    expect(isCredentialVerificationCurrent(verifiedAt, new Date('2026-08-18T12:15:00Z'))).toBe(true);
    expect(isCredentialVerificationCurrent(verifiedAt, new Date('2026-08-18T12:15:00.001Z'))).toBe(false);
  });
});
