import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LiveWriteApprovalStatus,
  LiveWriteCapability,
  TradingAccountReadinessPurpose,
} from '@prisma/client';

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'production',
    LIVE_WRITE_DEPLOYMENT_ROLE: 'PRODUCTION_EXECUTOR',
    ALLOW_LIVE_TRADING: true,
    ALLOW_LIVE_RISK_REDUCING_WRITES: true,
  },
  transaction: vi.fn(),
  computeReadinessFingerprints: vi.fn(),
  credentialCurrent: vi.fn(),
  getMarketSession: vi.fn(),
}));

vi.mock('../config/env.js', () => ({ env: mocks.env }));
vi.mock('../db/prisma.js', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('./trading-account-readiness.service.js', () => ({
  computeReadinessFingerprints: mocks.computeReadinessFingerprints,
  isCredentialVerificationCurrent: mocks.credentialCurrent,
  LIVE_ENTRY_ARMING_READINESS_VERSION: 2,
  READINESS_ASSESSMENT_VERSION: 1,
}));
vi.mock('../integrations/alpaca/orders.adapter.js', () => ({ getOpenAlpacaOrders: vi.fn() }));
vi.mock('../integrations/alpaca/positions.adapter.js', () => ({ getAlpacaPositions: vi.fn() }));
vi.mock('../integrations/alpaca/market-session.adapter.js', () => ({ getAlpacaMarketSessionSnapshot: mocks.getMarketSession }));

import {
  computeLiveWriteApprovalFingerprints,
  grantLiveWriteApproval,
  resolveGrantReadinessPurpose,
} from './live-write-approval.service.js';

const account = {
  id: 2,
  broker: 'ALPACA',
  environment: 'LIVE',
  status: 'ACTIVE',
  tradingEnabled: false,
  killSwitchEnabled: true,
  baseCurrency: 'USD',
  maxDeployableNotional: 1000,
  brokerAccountId: 'synthetic-live',
  riskSettings: null,
  allocations: [],
  accountSubscriptions: [],
};
const credential = {
  id: 4,
  authType: 'API_KEY',
  status: 'ACTIVE',
  keyFingerprint: 'synthetic',
  encryptionVersion: 1,
  verifiedAt: new Date(),
  revokedAt: null,
  updatedAt: new Date('2026-08-18T12:00:00Z'),
};
const readinessFingerprints = {
  configurationFingerprint: 'readiness-config',
  credentialFingerprint: 'readiness-credential',
  policyFingerprint: 'readiness-policy',
};

function makeTx(options: {
  posture?: Partial<typeof account>;
  purpose?: TradingAccountReadinessPurpose;
  evidence?: Record<string, unknown>;
  expiresAt?: Date;
  assessmentAccountMatches?: boolean;
  assessmentVersion?: number;
} = {}) {
  const currentAccount = { ...account, ...options.posture };
  const purpose = options.purpose ?? TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING;
  const assessment = {
    id: 9,
    tradingAccountId: 2,
    purpose,
    result: 'BLOCKED',
    assessmentVersion: options.assessmentVersion ?? (purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING ? 2 : 1),
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
    credentialVerifiedAt: new Date(),
    evidenceJson: options.evidence ?? { prerequisitesForRiskReducingGrantPassed: true },
    ...readinessFingerprints,
  };
  const tx = {
    tradingAccount: { findUnique: vi.fn().mockResolvedValue(currentAccount) },
    tradingAccountCredential: { findUnique: vi.fn().mockResolvedValue(credential) },
    tradingAccountReadinessAssessment: {
      findFirst: vi.fn().mockImplementation(async ({ where }) =>
        options.assessmentAccountMatches === false || where.purpose !== purpose ? null : assessment),
    },
    tradingAccountLiveWriteApproval: {
      findUnique: vi.fn().mockResolvedValue({ id: 1, revision: 2 }),
      update: vi.fn().mockImplementation(async ({ data }) => ({ id: 1, ...data })),
      create: vi.fn(),
    },
    tradingAccountLiveWriteApprovalDecision: { create: vi.fn().mockResolvedValue({}) },
    systemEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  return { tx, assessment };
}

async function grantRisk(tx: ReturnType<typeof makeTx>['tx']) {
  const fingerprints = await computeLiveWriteApprovalFingerprints(2, LiveWriteCapability.RISK_REDUCING, tx as never);
  return grantLiveWriteApproval({
    tradingAccountId: 2,
    capability: LiveWriteCapability.RISK_REDUCING,
    actorUserId: 1,
    input: {
      reason: 'Reauthorize synthetic risk reduction.',
      typedConfirmation: 'APPROVE LIVE RISK_REDUCING',
      readinessAssessmentId: 9,
      expectedConfigurationFingerprint: fingerprints!.configurationFingerprint,
      expectedCredentialFingerprint: fingerprints!.credentialFingerprint,
      expectedRevision: 2,
    },
  });
}

async function grantEntry(tx: ReturnType<typeof makeTx>['tx'], expiresAt: Date) {
  const entryFingerprints = await computeLiveWriteApprovalFingerprints(2, LiveWriteCapability.ENTRY, tx as never);
  const riskFingerprints = await computeLiveWriteApprovalFingerprints(2, LiveWriteCapability.RISK_REDUCING, tx as never);
  tx.tradingAccountLiveWriteApproval.findUnique.mockImplementation(async ({ where }) => {
    const capability = where.tradingAccountId_capability?.capability;
    if (capability === LiveWriteCapability.RISK_REDUCING) {
      return {
        id: 1,
        status: LiveWriteApprovalStatus.GRANTED,
        revision: 3,
        expiresAt: null,
        ...riskFingerprints!,
      };
    }
    return null;
  });
  tx.tradingAccountLiveWriteApproval.create.mockImplementation(async ({ data }) => ({ id: 2, ...data }));

  return grantLiveWriteApproval({
    tradingAccountId: 2,
    capability: LiveWriteCapability.ENTRY,
    actorUserId: 1,
    input: {
      reason: 'Authorize synthetic entry.',
      typedConfirmation: 'APPROVE LIVE ENTRY',
      readinessAssessmentId: 9,
      expectedConfigurationFingerprint: entryFingerprints!.configurationFingerprint,
      expectedCredentialFingerprint: entryFingerprints!.credentialFingerprint,
      expectedRevision: 0,
      expiresAt,
    },
  });
}

describe('RISK_REDUCING grant readiness contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeReadinessFingerprints.mockResolvedValue(readinessFingerprints);
    mocks.credentialCurrent.mockReturnValue(true);
    mocks.transaction.mockImplementation(async (callback) => callback(currentTx));
  });
  let currentTx: ReturnType<typeof makeTx>['tx'];

  it('keeps valid PAUSED first activation on LIVE_ACTIVATION evidence', async () => {
    const setup = makeTx({
      posture: { status: 'PAUSED' },
      purpose: TradingAccountReadinessPurpose.LIVE_ACTIVATION,
    });
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).resolves.toMatchObject({ status: LiveWriteApprovalStatus.GRANTED, revision: 3 });
    expect(setup.tx.tradingAccountReadinessAssessment.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ purpose: TradingAccountReadinessPurpose.LIVE_ACTIVATION }) });
  });

  it('does not let PAUSED substitute LIVE_ENTRY_ARMING evidence', async () => {
    const setup = makeTx({ posture: { status: 'PAUSED' }, purpose: TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING });
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).rejects.toThrow('fresh same-account');
  });

  it('reauthorizes exact ACTIVE entry-disarmed posture from qualified LIVE_ENTRY_ARMING evidence', async () => {
    const setup = makeTx();
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).resolves.toMatchObject({ status: 'GRANTED', revision: 3, readinessAssessmentId: 9 });
  });

  it('rejects unrelated blocked arming evidence', async () => {
    const setup = makeTx({ evidence: { prerequisitesForRiskReducingGrantPassed: false } });
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).rejects.toThrow('every non-authorization prerequisite passed');
  });

  it('rejects stale credential verification at the grant boundary', async () => {
    const setup = makeTx();
    currentTx = setup.tx;
    mocks.credentialCurrent.mockReturnValue(false);
    await expect(grantRisk(setup.tx)).rejects.toThrow('Credential verification is no longer current');
  });

  it('rejects wrong-account, expired, unsupported, and fingerprint-stale assessments', async () => {
    let setup = makeTx({ assessmentAccountMatches: false });
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).rejects.toThrow('fresh same-account');
    setup = makeTx({ expiresAt: new Date(Date.now() - 1) });
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).rejects.toThrow('expired');
    setup = makeTx({ assessmentVersion: 1 });
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).rejects.toThrow('version is not supported');
    setup = makeTx();
    currentTx = setup.tx;
    mocks.computeReadinessFingerprints.mockResolvedValueOnce({ ...readinessFingerprints, credentialFingerprint: 'changed' });
    await expect(grantRisk(setup.tx)).rejects.toThrow('readiness assessment is stale');
  });

  it.each([
    { status: 'ACTIVE', tradingEnabled: true, killSwitchEnabled: false },
    { status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: false },
    { status: 'ACTIVE', tradingEnabled: true, killSwitchEnabled: true },
  ])('rejects unsafe ACTIVE tuple %j', async (posture) => {
    const setup = makeTx({ posture });
    currentTx = setup.tx;
    await expect(grantRisk(setup.tx)).rejects.toThrow('exact PAUSED or ACTIVE entry-disarmed posture');
  });

  it('leaves ENTRY purpose selection unchanged', () => {
    expect(resolveGrantReadinessPurpose(LiveWriteCapability.ENTRY, {
      status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true,
    })).toBe(TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING);
  });
});

describe('ENTRY approval regular-session expiration boundary', () => {
  let currentTx: ReturnType<typeof makeTx>['tx'];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T18:00:00.000Z'));
    mocks.computeReadinessFingerprints.mockResolvedValue(readinessFingerprints);
    mocks.credentialCurrent.mockReturnValue(true);
    mocks.getMarketSession.mockResolvedValue({
      sessionOpenAt: '2026-08-18T13:30:00.000Z',
      sessionCloseAt: '2026-08-18T20:00:00.000Z',
      nextOpenAt: '2026-08-19T13:30:00.000Z',
      nextCloseAt: '2026-08-18T20:00:00.000Z',
    });
    const setup = makeTx({ evidence: { prerequisitesForEntryGrantPassed: true } });
    currentTx = setup.tx;
    mocks.transaction.mockImplementation(async (callback) => callback(currentTx));
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    '2026-08-18T19:00:00.000Z',
    '2026-08-18T19:30:00.000Z',
    '2026-08-18T20:00:00.000Z',
  ])('accepts expiration at %s', async (expiresAt) => {
    await expect(grantEntry(currentTx, new Date(expiresAt))).resolves.toMatchObject({
      status: LiveWriteApprovalStatus.GRANTED,
      expiresAt: new Date(expiresAt),
    });
  });

  it('rejects expiration one minute after the regular-session close', async () => {
    await expect(grantEntry(currentTx, new Date('2026-08-18T20:01:00.000Z')))
      .rejects.toThrow('must not extend beyond');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
