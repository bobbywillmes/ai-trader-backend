import { PlatformRole } from '@prisma/client';
import { readFile, readdir } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assignmentEnrollmentConfigurationFingerprint } from './assignment-market-policy-enrollment.service.js';
import { STRATEGY_MARKET_POLICY_DIMENSIONS } from './strategy-market-policy.definition.js';
import { strategyMarketPolicyConfigurationFingerprint } from './strategy-market-policy.service.js';

const mocks = vi.hoisted(() => ({ db: {} as Record<string, any> }));
vi.mock('../db/prisma.js', () => ({ prisma: { $transaction: (operation: (db: unknown) => unknown) => operation(mocks.db) } }));

const service = await import('./assignment-market-policy-enforcement-authorization.service.js');

const rules = STRATEGY_MARKET_POLICY_DIMENSIONS.map(definition => ({
  dimension: definition.dimension, algorithmVersion: definition.algorithmVersion,
  requirement: definition.dimension === 'TREND' ? 'REQUIRED' : 'IGNORED',
  allowedStates: definition.dimension === 'TREND' ? [{ state: 'UP' }] : [],
}));

function context(overrides: { account?: object; generation?: object | null; boundRevision?: object | null; activePolicyRevisionId?: number | null; effectiveAuthorizationId?: number | null } = {}) {
  const account = { id: 7, environment: 'PAPER', accountHolderUserId: 20, ...overrides.account };
  const boundRevision = overrides.boundRevision === null ? null : { id: 5, status: 'ACTIVE', strategyId: 4, dimensionRules: rules, ...overrides.boundRevision };
  const configurationFingerprint = assignmentEnrollmentConfigurationFingerprint({ accountId: 7, assignmentId: 9, strategyId: 4, policyRevisionId: 5, policyConfigurationFingerprint: strategyMarketPolicyConfigurationFingerprint(rules), accountHolderUserId: 20, environment: 'PAPER', generation: 2 });
  const generation = overrides.generation === null ? null : { id: 11, enrollmentId: 3, generation: 2, status: 'ACTIVE', tradingAccountId: 7, accountSubscriptionId: 9, strategyId: 4, policyRevisionId: 5, accountHolderUserId: 20, configurationFingerprint, ...overrides.generation };
  return {
    account, assignment: { id: 9, tradingAccountId: 7, routingStrategyId: 4 },
    activePolicyRevisionId: overrides.activePolicyRevisionId === undefined ? 5 : overrides.activePolicyRevisionId,
    generation, boundRevision, effectiveAuthorizationId: overrides.effectiveAuthorizationId ?? null,
  };
}
const codes = (input: ReturnType<typeof context>) => service.evaluateEnforcementAuthorizationEligibility(input).blockingReasons.map(reason => reason.code);

describe('enforcement authorization eligibility', () => {
  it('permits an exact, valid ACTIVE PAPER generation', () => {
    const result = service.evaluateEnforcementAuthorizationEligibility(context());
    expect(result).toMatchObject({ eligible: true, blockingReasons: [], configurationValidity: { valid: true } });
    expect(result.expectedConfigurationFingerprint).toBe(context().generation!.configurationFingerprint);
  });

  it.each(['PREPARED', 'DISABLED'])('rejects %s generations', status => {
    expect(codes(context({ generation: { status } }))).toEqual(['ENROLLMENT_NOT_ACTIVE']);
  });

  it('rejects LIVE accounts', () => {
    expect(codes(context({ account: { environment: 'LIVE' } }))).toContain('ACCOUNT_NOT_PAPER');
  });

  it('rejects changed account holders without a redundant fingerprint reason', () => {
    expect(codes(context({ account: { accountHolderUserId: 21 } }))).toEqual(['ACCOUNT_OWNERSHIP_CHANGED']);
  });

  it('rejects superseded policy revisions', () => {
    expect(codes(context({ activePolicyRevisionId: 6, boundRevision: { status: 'RETIRED' } }))).toContain('POLICY_REVISION_SUPERSEDED');
    expect(codes(context({ activePolicyRevisionId: null }))).toContain('ACTIVE_POLICY_REQUIRED');
  });

  it('rejects invalid five-dimension configuration and fingerprint drift', () => {
    expect(codes(context({ boundRevision: { dimensionRules: rules.slice(1) } }))).toContain('POLICY_CONFIGURATION_INVALID');
    expect(codes(context({ generation: { configurationFingerprint: 'f'.repeat(64) } }))).toEqual(['CONFIGURATION_FINGERPRINT_MISMATCH']);
  });

  it('rejects mismatched assignment identity and missing generations', () => {
    expect(codes(context({ generation: { strategyId: 99 } }))).toContain('ASSIGNMENT_IDENTITY_MISMATCH');
    expect(codes(context({ generation: null }))).toContain('ENROLLMENT_GENERATION_REQUIRED');
  });

  it('rejects overlapping effective grants', () => {
    expect(codes(context({ effectiveAuthorizationId: 40 }))).toEqual(['AUTHORIZATION_ALREADY_EFFECTIVE']);
  });

  it('keeps market outcome and operational posture out of configuration validity', () => {
    expect(service.evaluateEnforcementAuthorizationEligibility.length).toBe(1);
    expect(Object.keys(context())).not.toContain('marketOutcome');
  });
});

describe('enforcement authorization projections', () => {
  const user = { id: 1, email: 'owner@example.com', name: 'Owner' };
  const row = {
    id: 40, enrollmentId: 3, enrollmentGenerationId: 11, authorizationSequence: 1, authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', status: 'REVOKED',
    environment: 'PAPER', tradingAccountId: 7, accountSubscriptionId: 9, strategyId: 4, policyRevisionId: 5, accountHolderUserId: 20,
    configurationFingerprint: 'a'.repeat(64), authorizationFingerprint: 'b'.repeat(64), authorizedByUserId: 1, authorizedAt: new Date(), grantReason: 'private grant',
    revokedByUserId: 1, revokedAt: new Date(), revocationReason: 'private revoke', invalidatedByUserId: null, invalidatedAt: null, invalidationReasonCode: null,
    createdAt: new Date(), authorizedBy: user, revokedBy: user, invalidatedBy: null,
  } as any;

  it('gives owners the exact bound identity and actors', () => {
    expect(service.presentEnforcementAuthorization(row, PlatformRole.SYSTEM_OWNER)).toMatchObject({ authorizationFingerprint: 'b'.repeat(64), grantReason: 'private grant', revokedBy: user });
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])('redacts actors, reasons and fingerprints for %s', role => {
    const result = service.presentEnforcementAuthorization(row, role);
    expect(result).toMatchObject({ id: 40, status: 'REVOKED', policyRevisionId: 5 });
    for (const key of ['authorizedBy', 'revokedBy', 'grantReason', 'revocationReason', 'configurationFingerprint', 'authorizationFingerprint', 'accountHolderUserId']) expect(result).not.toHaveProperty(key);
  });
});

describe('enforcement authorization server-side owner requirement', () => {
  beforeEach(() => {
    mocks.db = {
      user: { findUnique: vi.fn() },
      $queryRaw: vi.fn(),
      assignmentMarketPolicyEnforcementAuthorization: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    };
  });

  it.each([
    ['an Operator', { platformRole: 'OPERATOR', enabled: true }],
    ['an Account User', { platformRole: 'ACCOUNT_USER', enabled: true }],
    ['a disabled owner', { platformRole: 'SYSTEM_OWNER', enabled: false }],
    ['a missing owner', null],
  ])('rejects %s before any lock or write', async (_label, actor) => {
    mocks.db.user.findUnique.mockResolvedValue(actor);
    await expect(service.grantAssignmentMarketPolicyEnforcementAuthorization(7, 9, { generationId: 11, expectedConfigurationFingerprint: 'a'.repeat(64), expectedPolicyRevisionId: 5, reason: 'grant' }, 2)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.revokeAssignmentMarketPolicyEnforcementAuthorization(7, 9, { authorizationId: 40, reason: 'revoke' }, 2)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.db.assignmentMarketPolicyEnforcementAuthorization.create).not.toHaveBeenCalled();
    expect(mocks.db.assignmentMarketPolicyEnforcementAuthorization.update).not.toHaveBeenCalled();
  });

  it('reports runtime enforcement as inactive', () => {
    expect(service.MARKET_POLICY_RUNTIME_ENFORCEMENT).toEqual({ active: false, status: 'NOT_ACTIVATED', tradingEffect: 'NONE' });
  });
});

describe('Phase 3C.1 trading non-interference', () => {
  // Authorization records must not be consumed by any trading path until Phase 3C.2.
  it('is not referenced by order, risk, worker, broker, exit or signal code', async () => {
    const roots = ['src/services', 'src/workers', 'src/integrations', 'src/routes', 'src/controllers'];
    const allowed = new Set([
      'src/services/assignment-market-policy-enforcement-authorization.service.ts',
      'src/services/assignment-market-policy-enforcement-authorization.service.test.ts',
      'src/controllers/trading-accounts.controller.ts',
    ]);
    const offenders: string[] = [];
    for (const root of roots) {
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const path = `${entry.parentPath ?? (entry as any).path}/${entry.name}`.replaceAll('\\', '/');
        if (allowed.has(path)) continue;
        const source = await readFile(path, 'utf8');
        if (/enforcement-authorization\.service|assignmentMarketPolicyEnforcementAuthorization|AssignmentMarketPolicyEnforcementAuthorization"/.test(source)) offenders.push(path);
      }
    }
    expect(offenders.filter(path => !path.endsWith('.routes.ts') && !path.endsWith('.routes.test.ts'))).toEqual([]);
  }, 60_000);
});
