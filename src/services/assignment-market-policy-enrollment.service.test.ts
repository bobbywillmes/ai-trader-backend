import { PlatformRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { marketOutcomePermitsConfigurationActivation, serializeAssignmentMarketPolicyEnrollmentGeneration } from './assignment-market-policy-enrollment.service.js';

describe('assignment market-policy enrollment activation boundary', () => {
  it.each(['ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE', null] as const)('does not require a favorable market outcome: %s', outcome => {
    expect(marketOutcomePermitsConfigurationActivation(outcome)).toBe(true);
  });
});

describe('assignment market-policy enrollment read redaction', () => {
  const generation = {
    id: 11, enrollmentId: 2, generation: 1, status: 'ACTIVE', tradingAccountId: 7,
    accountSubscriptionId: 9, strategyId: 4, policyRevisionId: 5, accountHolderUserId: 20,
    configurationFingerprint: 'sensitive-fingerprint', preparedByUserId: 1, activatedByUserId: 1,
    disabledByUserId: null, disableReason: 'sensitive note', enforcementAuthorityVersion: null,
    enforcementAuthorizedAt: null, preparedAt: new Date(), activatedAt: new Date(), disabledAt: null, createdAt: new Date(),
    preparedBy: { id: 1, email: 'owner@example.com' }, activatedBy: { id: 1, email: 'owner@example.com' }, disabledBy: null,
    transitions: [{ id: 1, actor: { id: 1, email: 'owner@example.com' }, reason: 'private' }],
    policyRevision: { id: 5, revision: 3, status: 'ACTIVE', changeNote: 'private note', dimensionRules: [{ dimension: 'TREND', allowedStates: ['UP'] }] },
  };

  it('preserves the complete owner configuration workflow projection', () => {
    const result = serializeAssignmentMarketPolicyEnrollmentGeneration(generation, PlatformRole.SYSTEM_OWNER);
    expect(result.configurationFingerprint).toBe('sensitive-fingerprint');
    expect(result.transitions).toHaveLength(1);
    expect(result.preparedBy.email).toBe('owner@example.com');
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])('removes administrative identities and history for %s', role => {
    const result = serializeAssignmentMarketPolicyEnrollmentGeneration(generation, role);
    expect(result).not.toHaveProperty('configurationFingerprint');
    expect(result).not.toHaveProperty('accountHolderUserId');
    expect(result).not.toHaveProperty('preparedBy');
    expect(result).not.toHaveProperty('activatedBy');
    expect(result).not.toHaveProperty('disabledBy');
    expect(result).not.toHaveProperty('disableReason');
    expect(result.transitions).toEqual([]);
    expect(result.policyRevision).not.toHaveProperty('changeNote');
  });

  it('gives Operators policy rules but redacts them from Account Users', () => {
    expect(serializeAssignmentMarketPolicyEnrollmentGeneration(generation, PlatformRole.OPERATOR).policyRevision.dimensionRules).toHaveLength(1);
    expect(serializeAssignmentMarketPolicyEnrollmentGeneration(generation, PlatformRole.ACCOUNT_USER).policyRevision).not.toHaveProperty('dimensionRules');
  });
});
