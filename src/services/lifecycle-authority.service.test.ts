import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestAccount = null | { id: number; broker: 'ALPACA' | 'OTHER'; environment: 'PAPER' | 'LIVE'; brokerAccountId: string | null;
  credential: null | { id: number; status: 'ACTIVE' | 'REVOKED' | 'NEEDS_VERIFICATION'; verifiedAt: Date | null;
    revokedAt: Date | null; keyFingerprint: string | null; updatedAt: Date } };
type TestMappings = Array<{ id: number }>;

const state = vi.hoisted(() => ({
  env: {
    PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY' as 'OBSERVATION_ONLY' | 'PAPER_EXECUTOR',
    PAPER_BROKER_WRITE_OWNERSHIP: [] as Array<{ tradingAccountId: number; role: 'OBSERVER' | 'EXECUTOR'; expectedBrokerAccountId?: string }>,
    PAPER_BROKER_WRITE_AUTHORIZATIONS: [] as Array<{ brokerAccountId: string; keyFingerprint: string }>,
  },
  account: null as TestAccount,
  mappings: [] as TestMappings, observedBrokerAccountId: 'PA-BOBBY', brokerFailure: false,
  brokerImplementation: null as null | (() => Promise<{ account_number: string }>),
  accountReadImplementation: null as null | (() => Promise<TestAccount>),
  mappingReadImplementation: null as null | (() => Promise<TestMappings>),
  apiKey: 'key-one', resolvedFingerprint: 'fp:key-one' as string | null,
}));
vi.mock('../config/env.js', () => ({ env: state.env }));
vi.mock('../db/prisma.js', () => ({ prisma: { tradingAccount: {
  findUnique: vi.fn(async () => state.accountReadImplementation ? state.accountReadImplementation() : state.account),
  findMany: vi.fn(async () => state.mappingReadImplementation ? state.mappingReadImplementation() : state.mappings),
} } }));
vi.mock('../integrations/alpaca/account.adapter.js', () => ({ getAlpacaAccount: vi.fn(async () => {
  if (state.brokerImplementation) return state.brokerImplementation();
  if (state.brokerFailure) throw new Error('offline');
  return { account_number: state.observedBrokerAccountId };
}) }));
vi.mock('./alpaca-config-resolver.service.js', () => ({ resolveAlpacaConfigForTradingAccount: vi.fn(async () => ({ apiKey: state.apiKey, keyFingerprint: state.resolvedFingerprint })) }));
vi.mock('./trading-credential-crypto.service.js', () => ({ fingerprintSecret: vi.fn((value: string) => `fp:${value}`) }));

import { LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS, assessLifecycleAuthority, invalidateLifecycleAuthorityCache,
  issueLifecycleAuthorityGrant, validateLifecycleAuthorityGrant, type LifecycleAuthorityGrant } from './lifecycle-authority.service.js';

function configure(role: 'OBSERVER' | 'EXECUTOR' = 'OBSERVER', environment: 'PAPER' | 'LIVE' = 'PAPER') {
  state.account = { id: 7, broker: 'ALPACA', environment, brokerAccountId: 'PA-BOBBY', credential: {
    id: 11, status: 'ACTIVE', verifiedAt: new Date('2026-10-24T11:00:00Z'), revokedAt: null,
    keyFingerprint: 'fp:key-one', updatedAt: new Date('2026-10-24T11:00:00Z') } };
  state.mappings = [{ id: 7 }];
  state.env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE = role === 'EXECUTOR' ? 'PAPER_EXECUTOR' : 'OBSERVATION_ONLY';
  state.env.PAPER_BROKER_WRITE_OWNERSHIP = [{ tradingAccountId: 7, role, expectedBrokerAccountId: 'PA-BOBBY' }];
  state.env.PAPER_BROKER_WRITE_AUTHORIZATIONS = role === 'EXECUTOR' ? [{ brokerAccountId: 'PA-BOBBY', keyFingerprint: 'fp:key-one' }] : [];
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  configure(); state.observedBrokerAccountId = 'PA-BOBBY'; state.brokerFailure = false; state.brokerImplementation = null;
  state.accountReadImplementation = null; state.mappingReadImplementation = null;
  state.apiKey = 'key-one'; state.resolvedFingerprint = 'fp:key-one'; invalidateLifecycleAuthorityCache();
});

describe('immutable lifecycle authority decisions', () => {
  it('returns deeply frozen detached diagnostics that cannot poison internal authority', async () => {
    const assessment = await assessLifecycleAuthority(7);
    for (const mutation of [
      () => ((assessment.allowedOperations as string[]).push('BROKER_EXIT_WRITE')),
      () => ((assessment.deniedOperations as Array<unknown>).length = 0),
      () => ((assessment as { outcome: string }).outcome = 'EXECUTOR'),
      () => ((assessment as { reasonCode: string }).reasonCode = 'VERIFIED_EXECUTOR'),
      () => ((assessment as { expiresAt: string }).expiresAt = '2999-01-01T00:00:00.000Z'),
    ]) expect(mutation).toThrow(TypeError);
    const later = await assessLifecycleAuthority(7);
    expect(later).toMatchObject({ outcome: 'OBSERVER', reasonCode: 'VERIFIED_OBSERVER' });
    expect(later).not.toBe(assessment);
    await expect(issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'BROKER_EXIT_WRITE' })).resolves.toBeNull();
  });

  it('independently enforces observer policy during issuance and validation', async () => {
    const observe = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' });
    expect(observe).not.toBeNull();
    await expect(validateLifecycleAuthorityGrant({ grant: observe!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(true);
    state.env.PAPER_BROKER_WRITE_OWNERSHIP[0]!.role = 'EXECUTOR';
    await expect(validateLifecycleAuthorityGrant({ grant: observe!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });
});

describe('trusted grant lifetime', () => {
  it('caps a late-issued grant to its broker-verification deadline and retains the five-minute maximum', async () => {
    await assessLifecycleAuthority(7);
    vi.advanceTimersByTime(LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS - 1_000);
    const lateGrant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' });
    expect(lateGrant).not.toBeNull();
    vi.advanceTimersByTime(999);
    await expect(validateLifecycleAuthorityGrant({ grant: lateGrant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(true);
    vi.advanceTimersByTime(1);
    await expect(validateLifecycleAuthorityGrant({ grant: lateGrant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);

    const freshGrant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs: 99_000_000 });
    vi.advanceTimersByTime(LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS);
    await expect(validateLifecycleAuthorityGrant({ grant: freshGrant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });

  it('expires exactly at the boundary and cannot be revived by moving the clock backward', async () => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs: 1_000 });
    vi.advanceTimersByTime(999);
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(true);
    vi.advanceTimersByTime(1);
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
    vi.setSystemTime(new Date('2026-10-24T11:00:00Z'));
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });

  it('caps lifetime and rejects invalid TTLs and fabricated capabilities', async () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs })).resolves.toBeNull();
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs: 99_000_000 });
    vi.advanceTimersByTime(LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS);
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
    await expect(validateLifecycleAuthorityGrant({ grant: Object.freeze({}) as LifecycleAuthorityGrant, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });

  it('ignores injected legacy clock fields from untyped callers', async () => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs: 1_000,
      now: new Date('2999-01-01T00:00:00Z') } as Parameters<typeof issueLifecycleAuthorityGrant>[0]);
    expect(grant).not.toBeNull();
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE',
      now: new Date('1900-01-01T00:00:00Z') } as Parameters<typeof validateLifecycleAuthorityGrant>[0])).resolves.toBe(true);
    vi.advanceTimersByTime(1_000);
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE',
      now: new Date('1900-01-01T00:00:00Z') } as Parameters<typeof validateLifecycleAuthorityGrant>[0])).resolves.toBe(false);
  });

  it('permanently rejects a wall-clock rollback after a successful validation', async () => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs: 10_000 });
    vi.advanceTimersByTime(2_000);
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(true);
    vi.setSystemTime(new Date('2026-10-24T12:00:01Z'));
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
    vi.setSystemTime(new Date('2026-10-24T12:00:03Z'));
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });
});

describe('revocation generations and concurrent assessments', () => {
  async function validationBlockedOnAccountRead(grant: LifecycleAuthorityGrant) {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    state.accountReadImplementation = async () => { await blocked; return state.account; };
    const validation = validateLifecycleAuthorityGrant({ grant, tradingAccountId: 7, operation: 'OBSERVE' });
    await Promise.resolve();
    return { validation, release };
  }

  it('revokes grants on account and global invalidation', async () => {
    const accountGrant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' });
    invalidateLifecycleAuthorityCache(7);
    await expect(validateLifecycleAuthorityGrant({ grant: accountGrant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
    const globalGrant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' });
    invalidateLifecycleAuthorityCache();
    await expect(validateLifecycleAuthorityGrant({ grant: globalGrant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });

  it('revokes a prior grant when forced broker verification fails', async () => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' });
    state.brokerFailure = true;
    await expect(assessLifecycleAuthority(7, { forceRefresh: true })).resolves.toMatchObject({ outcome: 'UNKNOWN', reasonCode: 'BROKER_IDENTITY_UNAVAILABLE' });
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });

  it.each([
    ['account', () => invalidateLifecycleAuthorityCache(7)],
    ['global', () => invalidateLifecycleAuthorityCache()],
  ])('rejects validation when %s invalidation occurs during database evidence reads', async (_name, invalidate) => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' });
    const pending = await validationBlockedOnAccountRead(grant!);
    invalidate();
    pending.release();
    await expect(pending.validation).resolves.toBe(false);
  });

  it('rejects validation when the grant expires during a database evidence read', async () => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE', ttlMs: 1_000 });
    const pending = await validationBlockedOnAccountRead(grant!);
    vi.advanceTimersByTime(1_000);
    pending.release();
    await expect(pending.validation).resolves.toBe(false);
  });

  it('prevents a stale successful assessment from restoring authority after newer invalidation', async () => {
    let releaseSlow!: (value: { account_number: string }) => void;
    const slow = new Promise<{ account_number: string }>(resolve => { releaseSlow = resolve; });
    let call = 0;
    state.brokerImplementation = async () => ++call === 1 ? slow : Promise.reject(new Error('newer failure'));
    const older = assessLifecycleAuthority(7, { forceRefresh: true });
    await Promise.resolve(); await Promise.resolve();
    const newer = await assessLifecycleAuthority(7, { forceRefresh: true });
    expect(newer.reasonCode).toBe('BROKER_IDENTITY_UNAVAILABLE');
    releaseSlow({ account_number: 'PA-BOBBY' });
    await expect(older).resolves.toMatchObject({ outcome: 'OBSERVER' });
    await expect(issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBeNull();
  });
});

describe('identity and mixed deployment policy', () => {
  it('supports an observer inside PAPER_EXECUTOR without granting executor operations', async () => {
    state.env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE = 'PAPER_EXECUTOR';
    const assessment = await assessLifecycleAuthority(7, { forceRefresh: true });
    expect(assessment).toMatchObject({ outcome: 'OBSERVER', reasonCode: 'VERIFIED_OBSERVER' });
    await expect(issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'EXIT_STATE_MUTATION' })).resolves.toBeNull();
  });

  it('denies an executor declaration inside OBSERVATION_ONLY', async () => {
    state.env.PAPER_BROKER_WRITE_OWNERSHIP[0]!.role = 'EXECUTOR';
    await expect(assessLifecycleAuthority(7, { forceRefresh: true })).resolves.toMatchObject({ outcome: 'DENIED', reasonCode: 'DEPLOYMENT_ROLE_CONTRADICTORY' });
  });

  it.each([
    ['broker change', () => { state.account!.broker = 'OTHER'; }],
    ['environment change', () => { state.account!.environment = 'LIVE'; }],
    ['credential rotation', () => { state.account!.credential!.keyFingerprint = 'fp:rotated'; state.account!.credential!.updatedAt = new Date(); }],
    ['credential revocation', () => { state.account!.credential!.status = 'REVOKED'; state.account!.credential!.revokedAt = new Date(); }],
    ['mapping conflict', () => { state.mappings = [{ id: 7 }, { id: 8 }]; }],
    ['declaration removal', () => { state.env.PAPER_BROKER_WRITE_OWNERSHIP = []; }],
  ])('invalidates validation after %s', async (_name, mutate) => {
    const grant = await issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' });
    mutate();
    await expect(validateLifecycleAuthorityGrant({ grant: grant!, tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBe(false);
  });

  it('keeps LIVE independently governed', async () => {
    configure('OBSERVER', 'LIVE');
    await expect(assessLifecycleAuthority(7, { forceRefresh: true })).resolves.toMatchObject({ outcome: 'UNKNOWN', reasonCode: 'LIVE_POLICY_INDEPENDENT', policyDelegation: 'LIVE_INDEPENDENT' });
    await expect(issueLifecycleAuthorityGrant({ tradingAccountId: 7, operation: 'OBSERVE' })).resolves.toBeNull();
  });
});
