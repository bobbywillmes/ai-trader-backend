import { describe, expect, it } from 'vitest';
import { evaluateLiveEntryArmingBinding } from './live-entry-arming.service.js';

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
