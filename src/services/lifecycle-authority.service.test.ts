import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  now: new Date('2026-10-24T12:00:00.000Z'),
  env: {
    PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY' as 'OBSERVATION_ONLY' | 'PAPER_EXECUTOR',
    PAPER_BROKER_WRITE_OWNERSHIP: [] as Array<{ tradingAccountId: number; role: 'OBSERVER' | 'EXECUTOR'; expectedBrokerAccountId?: string }>,
    PAPER_BROKER_WRITE_AUTHORIZATIONS: [] as Array<{ brokerAccountId: string; keyFingerprint: string }>,
  },
  account: null as null | {
    id: number; broker: 'ALPACA'; environment: 'PAPER' | 'LIVE'; brokerAccountId: string | null;
    credential: null | { id: number; status: 'ACTIVE' | 'REVOKED' | 'NEEDS_VERIFICATION'; verifiedAt: Date | null;
      revokedAt: Date | null; keyFingerprint: string | null; updatedAt: Date };
  },
  mappings: [] as Array<{ id: number }>,
  observedBrokerAccountId: 'PA-BOBBY',
  brokerFailure: false,
  apiKey: 'key-one',
  resolvedFingerprint: 'fp:key-one' as string | null,
}));

vi.mock('../config/env.js', () => ({ env: state.env }));
vi.mock('../db/prisma.js', () => ({ prisma: { tradingAccount: {
  findUnique: vi.fn(async () => state.account), findMany: vi.fn(async () => state.mappings),
} } }));
vi.mock('../integrations/alpaca/account.adapter.js', () => ({ getAlpacaAccount: vi.fn(async () => {
  if (state.brokerFailure) throw new Error('offline');
  return { account_number: state.observedBrokerAccountId };
}) }));
vi.mock('./alpaca-config-resolver.service.js', () => ({ resolveAlpacaConfigForTradingAccount: vi.fn(async () => ({
  apiKey: state.apiKey, keyFingerprint: state.resolvedFingerprint,
})) }));
vi.mock('./trading-credential-crypto.service.js', () => ({ fingerprintSecret: vi.fn((value: string) => `fp:${value}`) }));

import {
  LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS,
  assessLifecycleAuthority,
  invalidateLifecycleAuthorityCache,
  issueLifecycleAuthorityGrant,
  validateLifecycleAuthorityGrant,
  type LifecycleAuthorityGrant,
} from './lifecycle-authority.service.js';

function configure(role: 'OBSERVER' | 'EXECUTOR' = 'OBSERVER', environment: 'PAPER' | 'LIVE' = 'PAPER') {
  state.account = { id: 7, broker: 'ALPACA', environment, brokerAccountId: 'PA-BOBBY', credential: {
    id: 11, status: 'ACTIVE', verifiedAt: new Date('2026-10-24T11:00:00Z'), revokedAt: null,
    keyFingerprint: 'fp:key-one', updatedAt: new Date('2026-10-24T11:00:00Z'),
  } };
  state.mappings = [{ id: 7 }];
  state.env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE = role === 'EXECUTOR' ? 'PAPER_EXECUTOR' : 'OBSERVATION_ONLY';
  state.env.PAPER_BROKER_WRITE_OWNERSHIP = [{ tradingAccountId: 7, role, expectedBrokerAccountId: 'PA-BOBBY' }];
  state.env.PAPER_BROKER_WRITE_AUTHORIZATIONS = role === 'EXECUTOR'
    ? [{ brokerAccountId: 'PA-BOBBY', keyFingerprint: 'fp:key-one' }] : [];
}

beforeEach(() => {
  configure(); state.observedBrokerAccountId = 'PA-BOBBY'; state.brokerFailure = false;
  state.apiKey = 'key-one'; state.resolvedFingerprint = 'fp:key-one';
  invalidateLifecycleAuthorityCache();
});

describe('PAPER lifecycle authority assessment', () => {
  it('verifies exact observer identity in production-shaped configuration and grants only observation mutations', async () => {
    const assessment = await assessLifecycleAuthority(7, { now: state.now });
    expect(assessment).toMatchObject({ outcome: 'OBSERVER', reasonCode: 'VERIFIED_OBSERVER',
      policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY', observedBrokerAccountId: 'PA-BOBBY' });
    expect(assessment.allowedOperations).toEqual(['OBSERVE', 'POSITION_CREATE', 'POSITION_MARKET_REFRESH']);
    expect(assessment.deniedOperations).toContainEqual({ operation: 'EXIT_STATE_MUTATION', reasonCode: 'OBSERVER_STRATEGY_OPERATION_DENIED' });
  });

  it('verifies exact executor identity and existing fingerprint authorization', async () => {
    configure('EXECUTOR');
    const assessment = await assessLifecycleAuthority(7, { forceRefresh: true, now: state.now });
    expect(assessment).toMatchObject({ outcome: 'EXECUTOR', reasonCode: 'VERIFIED_EXECUTOR' });
    expect(assessment.allowedOperations).toHaveLength(10);
  });

  it.each([
    ['missing declaration', () => { state.env.PAPER_BROKER_WRITE_OWNERSHIP = []; }, 'UNKNOWN', 'OWNERSHIP_UNDECLARED'],
    ['missing stored identity', () => { state.account!.brokerAccountId = null; }, 'UNKNOWN', 'STORED_BROKER_IDENTITY_MISSING'],
    ['stored identity mismatch', () => { state.account!.brokerAccountId = 'OTHER'; state.mappings = [{ id: 7 }]; }, 'DENIED', 'STORED_BROKER_IDENTITY_MISMATCH'],
    ['inactive credential', () => { state.account!.credential!.status = 'REVOKED'; }, 'DENIED', 'CREDENTIAL_INACTIVE'],
    ['unverified credential', () => { state.account!.credential!.verifiedAt = null; }, 'UNKNOWN', 'CREDENTIAL_UNVERIFIED'],
    ['credential fingerprint mismatch', () => { state.resolvedFingerprint = 'fp:other'; }, 'DENIED', 'CREDENTIAL_FINGERPRINT_MISMATCH'],
    ['duplicate local mapping', () => { state.mappings = [{ id: 7 }, { id: 8 }]; }, 'DENIED', 'LOCAL_BROKER_IDENTITY_DUPLICATE'],
    ['broker identity mismatch', () => { state.observedBrokerAccountId = 'OTHER'; }, 'DENIED', 'BROKER_IDENTITY_MISMATCH'],
    ['broker identity failure', () => { state.brokerFailure = true; }, 'UNKNOWN', 'BROKER_IDENTITY_UNAVAILABLE'],
  ])('fails closed for %s', async (_name, mutate, outcome, reasonCode) => {
    mutate();
    await expect(assessLifecycleAuthority(7, { forceRefresh: true, now: state.now })).resolves.toMatchObject({ outcome, reasonCode, allowedOperations: [] });
  });

  it('denies declarations that contradict the deployment role', async () => {
    state.env.PAPER_BROKER_WRITE_OWNERSHIP = [{ tradingAccountId: 7, role: 'EXECUTOR', expectedBrokerAccountId: 'PA-BOBBY' }];
    await expect(assessLifecycleAuthority(7, { forceRefresh: true })).resolves.toMatchObject({ outcome: 'DENIED', reasonCode: 'DEPLOYMENT_ROLE_CONTRADICTORY' });
  });

  it('delegates LIVE without invoking PAPER-only authorization', async () => {
    configure('OBSERVER', 'LIVE');
    await expect(assessLifecycleAuthority(7, { forceRefresh: true })).resolves.toMatchObject({ outcome: 'UNKNOWN', reasonCode: 'LIVE_POLICY_INDEPENDENT', policyDelegation: 'LIVE_INDEPENDENT' });
  });
});

describe('operation-scoped lifecycle grants', () => {
  it('accepts only the exact account and operation', async () => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', now: state.now });
    expect(grant).not.toBeNull();
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE', now: state.now })).resolves.toBe(true);
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 8, operation: 'OBSERVE', now: state.now })).resolves.toBe(false);
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'POSITION_CREATE', now: state.now })).resolves.toBe(false);
  });

  it('rejects expired, fabricated, and process-local capabilities', async () => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs: 1, now: state.now });
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE', now: new Date(state.now.getTime() + 1) })).resolves.toBe(false);
    await expect(validateLifecycleAuthorityGrant({ grant: Object.freeze({}) as LifecycleAuthorityGrant, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });

  it('caps grants at five minutes', async () => {
    const assessment = await assessLifecycleAuthority(7, { forceRefresh: true, ttlMs: 99_000_000, now: state.now });
    expect(new Date(assessment.expiresAt!).getTime() - state.now.getTime()).toBe(LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS);
  });

  it.each([
    ['credential rotation', () => { state.account!.credential!.keyFingerprint = 'fp:rotated'; state.account!.credential!.updatedAt = new Date('2026-10-24T12:01:00Z'); }],
    ['credential revocation', () => { state.account!.credential!.status = 'REVOKED'; state.account!.credential!.revokedAt = new Date(); }],
    ['stored identity change', () => { state.account!.brokerAccountId = 'OTHER'; }],
    ['ownership configuration change', () => { state.env.PAPER_BROKER_WRITE_OWNERSHIP = []; }],
    ['duplicate mapping', () => { state.mappings = [{ id: 7 }, { id: 8 }]; }],
  ])('invalidates a grant after %s', async (_name, mutate) => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', now: state.now });
    mutate();
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE', now: state.now })).resolves.toBe(false);
  });

  it('does not issue executor lifecycle grants to a verified observer', async () => {
    await expect(issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'EXIT_STATE_MUTATION', now: state.now })).resolves.toBeNull();
  });

  it('invalidates cached assessment explicitly after failed re-verification', async () => {
    await expect(assessLifecycleAuthority(7, { now: state.now })).resolves.toMatchObject({ outcome: 'OBSERVER' });
    state.brokerFailure = true;
    invalidateLifecycleAuthorityCache(7);
    await expect(assessLifecycleAuthority(7, { now: state.now })).resolves.toMatchObject({ outcome: 'UNKNOWN', reasonCode: 'BROKER_IDENTITY_UNAVAILABLE' });
  });
});
