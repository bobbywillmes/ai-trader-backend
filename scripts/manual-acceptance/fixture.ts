import { BrokerCredentialAuthType, LiveWriteApprovalAction, LiveWriteApprovalStatus, LiveWriteCapability, PlatformRole, TradingAccountEnvironment, TradingAccountStatus } from '@prisma/client';

import { installMockAlpacaTransport } from './mock-alpaca-transport.js';
import { parseManualAcceptanceFixtureProfile } from './profile.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (new URL(databaseUrl).pathname !== '/ai_trader_live_entry_acceptance') {
  throw new Error('Fixture refuses DATABASE_URL unless the database is ai_trader_live_entry_acceptance.');
}
const fixtureProfile = parseManualAcceptanceFixtureProfile(process.argv[2]);
installMockAlpacaTransport();

const { prisma } = await import('../../src/db/prisma.js');
const { hashPassword } = await import('../../src/services/auth.service.js');
const { upsertTradingAccountApiKeyCredential } = await import('../../src/services/trading-account-credential.service.js');
const { verifyTradingAccountCredential } = await import('../../src/services/trading-account-credential-verification.service.js');
const { computeLiveWriteApprovalFingerprints } = await import('../../src/services/live-write-approval.service.js');
const { recordTradingAccountWorkerAttempt } = await import('../../src/services/trading-account-worker-health.service.js');

const email = 'owner@live-entry-acceptance.invalid';
const password = 'Synthetic-Acceptance-Only-2026!';
const owner = await prisma.user.create({
  data: {
    email,
    passwordHash: await hashPassword(password),
    platformRole: PlatformRole.SYSTEM_OWNER,
    enabled: true,
    name: 'Synthetic System Owner',
    emailVerifiedAt: new Date(),
    setupCompletedAt: new Date(),
  },
});

const subscription = await prisma.subscription.findUniqueOrThrow({ where: { key: 'rsp_dip_core' } });
const account = await prisma.tradingAccount.create({
  data: {
    accountHolderUserId: owner.id,
    displayName: 'Synthetic Live Acceptance',
    environment: TradingAccountEnvironment.LIVE,
    status: TradingAccountStatus.PAUSED,
    tradingEnabled: false,
    killSwitchEnabled: true,
    estimatedTradingCapital: 1_000,
    maxDeployableNotional: 1_000,
    baseCurrency: 'USD',
    notes: 'Disposable manual-acceptance fixture. Never broker connected.',
    memberships: { create: { userId: owner.id } },
    riskSettings: { create: {
      enabled: true,
      maxDailyEntryOrders: 1,
      maxDailyEntryNotional: 1_000,
      maxOpenPositions: 1,
      maxTotalOpenNotional: 1_000,
      maxSymbolOpenNotional: 1_000,
      maxSubscriptionOpenNotional: 1_000,
      notes: 'One-shot synthetic canary limits.',
    } },
    allocations: { create: {
      key: 'core_etf', name: 'Core ETF', enabled: true,
      maxAllocatedNotional: 1_000, maxOpenPositions: 1, maxPositionNotional: 1_000,
    } },
  },
  include: { allocations: true },
});

await prisma.tradingAccountSubscription.create({
  data: {
    tradingAccountId: account.id,
    subscriptionId: subscription.id,
    allocationId: account.allocations[0]!.id,
    enabled: true,
    entriesEnabled: false,
    exitsEnabled: true,
    sizingType: 'MAX_NOTIONAL',
    maxPositionNotional: 1_000,
    reservedNotional: 1_000,
    maxQty: 10,
    notes: 'Synthetic rsp_dip_core Live-entry acceptance canary.',
  },
});

await upsertTradingAccountApiKeyCredential(account.id, {
  authType: BrokerCredentialAuthType.API_KEY,
  apiKey: 'SYNTHETIC-LIVE-KEY-NOT-AN-ALPACA-KEY',
  apiSecret: 'SYNTHETIC-LIVE-SECRET-NOT-AN-ALPACA-SECRET',
}, owner.id);
const verification = await verifyTradingAccountCredential(account.id, owner.id);
if (!verification?.ok) throw new Error(`Synthetic credential verification failed: ${verification?.message}`);

if (fixtureProfile === 'entry-ready') {
  await prisma.tradingAccount.update({
    where: { id: account.id },
    data: { status: TradingAccountStatus.ACTIVE, tradingEnabled: false, killSwitchEnabled: true },
  });
}

for (const workerKey of ['pending_order_processing', 'submitted_order_sync', 'broker_activity_sync', 'tracked_position_sync', 'exit_evaluation', 'account_snapshot_scheduler'] as const) {
  await recordTradingAccountWorkerAttempt({
    tradingAccountId: account.id,
    workerKey,
    processInstanceId: 'manual-acceptance-fixture',
    outcome: 'success',
    applicable: true,
    eligible: true,
  });
}

if (fixtureProfile === 'entry-ready') {
  const fingerprints = await computeLiveWriteApprovalFingerprints(account.id, LiveWriteCapability.RISK_REDUCING);
  if (!fingerprints) throw new Error('Could not compute RISK_REDUCING fingerprints.');
  const riskApproval = await prisma.tradingAccountLiveWriteApproval.create({
    data: {
      tradingAccountId: account.id,
      capability: LiveWriteCapability.RISK_REDUCING,
      status: LiveWriteApprovalStatus.GRANTED,
      revision: 1,
      ...fingerprints,
      grantedByUserId: owner.id,
      grantedAt: new Date(),
      grantReason: 'Synthetic fixture bootstrap for isolated manual acceptance.',
    },
  });
  await prisma.tradingAccountLiveWriteApprovalDecision.create({
    data: {
      tradingAccountId: account.id,
      capability: LiveWriteCapability.RISK_REDUCING,
      action: LiveWriteApprovalAction.GRANT,
      actorUserId: owner.id,
      reason: 'Synthetic fixture bootstrap for isolated manual acceptance.',
      ...fingerprints,
      deploymentEnvironment: 'manual_acceptance_harness',
      priorRevision: 0,
      resultingRevision: riskApproval.revision,
    },
  });
}

console.log(JSON.stringify({
  accountId: account.id,
  email,
  password,
  brokerIdentity: 'manual-acceptance-live-account',
  database: 'ai_trader_live_entry_acceptance',
  fixtureProfile,
}, null, 2));
await prisma.$disconnect();
