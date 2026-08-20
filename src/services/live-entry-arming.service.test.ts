import { describe, expect, it } from 'vitest';
import {
  acceptanceRunBindingMatches,
  assertArmingCredentialVerificationCurrent,
  evaluateLiveEntryArmingBinding,
} from './live-entry-arming.service.js';

const arming = {
  entryApprovalId: 10,
  entryApprovalRevision: 1,
  riskReducingApprovalId: 20,
  riskReducingApprovalRevision: 4,
  configurationFingerprint: 'config-1',
  credentialFingerprint: 'credential-1',
  policyFingerprint: 'policy-1',
  tradingAccountSubscriptionId: 30,
};

const current = {
  arming,
  entryApproval: { id: 10, revision: 1 },
  riskReducingApproval: { id: 20, revision: 4 },
  fingerprints: {
    configurationFingerprint: 'config-1',
    credentialFingerprint: 'credential-1',
    policyFingerprint: 'policy-1',
  },
  tradingAccountSubscriptionId: 30,
};

describe('Live entry arming binding', () => {
  it('accepts only the exact armed approval revisions, fingerprints, and assignment', () => {
    expect(evaluateLiveEntryArmingBinding(current)).toEqual({ valid: true });
  });

  it('does not let replacement ENTRY revision 2 inherit revision-1 arming', () => {
    expect(evaluateLiveEntryArmingBinding({ ...current, entryApproval: { id: 10, revision: 2 } })).toEqual({ valid: false, reason: 'ENTRY_APPROVAL_MISMATCH' });
  });

  it.each([
    ['configurationFingerprint', 'config-2'],
    ['credentialFingerprint', 'credential-2'],
    ['policyFingerprint', 'policy-2'],
  ] as const)('rejects stale %s', (field, value) => {
    expect(evaluateLiveEntryArmingBinding({ ...current, fingerprints: { ...current.fingerprints, [field]: value } })).toEqual({ valid: false, reason: 'ARMING_FINGERPRINT_STALE' });
  });

  it('rejects a different assignment even when it has the same symbol', () => {
    expect(evaluateLiveEntryArmingBinding({ ...current, tradingAccountSubscriptionId: 31 })).toEqual({ valid: false, reason: 'ASSIGNMENT_NOT_ARMED' });
  });

  it('rejects replacement risk-reducing authority', () => {
    expect(evaluateLiveEntryArmingBinding({ ...current, riskReducingApproval: { id: 20, revision: 5 } })).toEqual({ valid: false, reason: 'RISK_REDUCING_APPROVAL_MISMATCH' });
  });
});

describe('Live-entry acceptance arming boundary binding', () => {
  it('requires a run-bound arming and intent to name the same run', () => {
    expect(acceptanceRunBindingMatches({ armingAcceptanceRunId: 7, intentAcceptanceRunId: 7 })).toBe(true);
    expect(acceptanceRunBindingMatches({ armingAcceptanceRunId: 7, intentAcceptanceRunId: 8 })).toBe(false);
    expect(acceptanceRunBindingMatches({ armingAcceptanceRunId: 7, intentAcceptanceRunId: null })).toBe(false);
  });

  it('preserves the existing boundary for ordinary unbound armings', () => {
    expect(acceptanceRunBindingMatches({ armingAcceptanceRunId: null, intentAcceptanceRunId: null })).toBe(true);
  });
});

describe('Live entry ARM credential freshness', () => {
  it('does not let a CURRENT 15-minute assessment extend stale credential verification', () => {
    const verifiedAt = new Date('2026-08-18T12:00:00Z');
    expect(() => assertArmingCredentialVerificationCurrent(
      verifiedAt,
      new Date('2026-08-18T12:15:00.001Z'),
    )).toThrow('Credential verification is no longer current');
  });
});
