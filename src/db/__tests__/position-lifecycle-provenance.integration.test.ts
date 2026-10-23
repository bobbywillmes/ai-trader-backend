import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDisposablePostgresDatabase,
  type DisposablePostgresDatabase,
} from './disposable-postgres.js';

const enabled =
  process.env.RUN_POSITION_LIFECYCLE_PROVENANCE_TESTS === '1' &&
  process.env.DATABASE_URL;
const describePostgres = enabled ? describe : describe.skip;
const originalDatabaseUrl = process.env.DATABASE_URL;

let disposable: DisposablePostgresDatabase;
let prisma: typeof import('../prisma.js').prisma;
let recordDecision: typeof import('../../services/position-lifecycle-provenance.service.js').recordPositionLifecycleProvenanceDecision;

async function fixture(args: {
  creationAuthority?: 'EXECUTOR' | 'OBSERVER';
  withLifecycleRecords?: boolean;
} = {}) {
  const suffix = randomUUID().replaceAll('-', '');
  const user = await prisma.user.create({ data: {
    email: `position-provenance-${suffix}@example.invalid`,
    platformRole: 'SYSTEM_OWNER',
  } });
  const account = await prisma.tradingAccount.create({ data: {
    accountHolderUserId: user.id,
    displayName: `Provenance ${suffix}`,
    environment: 'PAPER',
    status: 'ACTIVE',
    tradingEnabled: false,
    killSwitchEnabled: true,
  } });
  const security = await prisma.security.create({ data: {
    symbol: `P${suffix.slice(0, 7)}`.toUpperCase(),
    name: `Provenance ${suffix}`,
    assetType: 'STOCK',
  } });
  const strategy = await prisma.strategy.create({ data: {
    key: `provenance-strategy-${suffix}`,
    name: `Provenance strategy ${suffix}`,
  } });
  const exitProfile = await prisma.exitProfile.create({ data: {
    key: `provenance-exit-${suffix}`,
    name: `Provenance exit ${suffix}`,
    exitMode: 'market',
    takeProfitBehavior: 'close',
    targetPct: 4,
    trailingStopPct: 1,
  } });
  const subscription = await prisma.subscription.create({ data: {
    key: `provenance-subscription-${suffix}`,
    name: `Provenance subscription ${suffix}`,
    symbol: security.symbol,
    securityId: security.id,
    strategyId: strategy.id,
    exitProfileId: exitProfile.id,
  } });
  const assignment = await prisma.tradingAccountSubscription.create({ data: {
    tradingAccountId: account.id,
    subscriptionId: subscription.id,
    enabled: true,
    entriesEnabled: true,
    exitsEnabled: true,
    fixedQty: 10,
  } });
  const position = await prisma.trackedPosition.create({ data: {
    broker: 'alpaca',
    symbol: security.symbol,
    side: 'long',
    qty: 10,
    avgEntryPrice: 100,
    currentPrice: 105,
    marketValue: 1050,
    costBasis: 1000,
    unrealizedPnL: 50,
    unrealizedPnLPct: 0.05,
    status: 'open',
    rawPositionJson: { fixture: 'production-style', symbol: security.symbol },
    securityId: security.id,
    tradingAccountId: account.id,
    subscriptionId: subscription.id,
    tradingAccountSubscriptionId: assignment.id,
    configSnapshotJson: { exitProfileKey: exitProfile.key, source: 'legacy-fixture' },
    configSnapshotCapturedAt: new Date('2026-10-01T12:00:00.000Z'),
    ...(args.creationAuthority
      ? { lifecycleAuthorityAtCreation: args.creationAuthority }
      : {}),
  } });

  let exitState = null;
  let claim = null;
  if (args.withLifecycleRecords) {
    exitState = await prisma.positionExitState.create({ data: {
      trackedPositionId: position.id,
      exitManagementModeSnapshot: 'BACKEND_MANAGED',
      exitOwnershipProvenance: { source: 'local_order_intent', subscriptionId: subscription.id },
      status: 'watching',
      exitProfileKey: exitProfile.key,
      exitMode: exitProfile.exitMode,
      takeProfitBehavior: exitProfile.takeProfitBehavior,
      targetPct: exitProfile.targetPct,
      trailingStopPct: exitProfile.trailingStopPct,
    } });
    claim = await prisma.entryExposureClaim.create({ data: {
      tradingAccountId: account.id,
      securityId: security.id,
      trackedPositionId: position.id,
      ownerKey: `provenance-claim-${suffix}`,
      status: 'POSITION_OPEN',
    } });
  }
  return { user, account, security, assignment, position, exitState, claim };
}

function systemEvidence(label: string) {
  return { source: 'POSTGRES_INTEGRATION_TEST', label, evidenceIds: [] };
}

describePostgres('position lifecycle provenance foundation', () => {
  beforeAll(async () => {
    disposable = await createDisposablePostgresDatabase(
      process.env.DATABASE_URL!,
      'pos_provenance',
    );
    await disposable.migrate();
    await disposable.verify();
    process.env.DATABASE_URL = disposable.url;
    ({ prisma } = await import('../prisma.js'));
    ({ recordPositionLifecycleProvenanceDecision: recordDecision } =
      await import('../../services/position-lifecycle-provenance.service.js'));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await disposable?.drop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('keeps legacy positions readable with null creation authority and no inferred provenance', async () => {
    const { position } = await fixture();
    const read = await prisma.trackedPosition.findUniqueOrThrow({
      where: { id: position.id },
      include: { lifecycleProvenanceDecisions: true },
    });
    expect(read.lifecycleAuthorityAtCreation).toBeNull();
    expect(read.lifecycleProvenanceDecisions).toEqual([]);
  });

  it('persists a new immutable provenance value through the controlled append path', async () => {
    const { account, position } = await fixture({ creationAuthority: 'EXECUTOR' });
    const decision = await recordDecision({
      trackedPositionId: position.id,
      tradingAccountId: account.id,
      origin: 'LOCAL_ORDER_CHAIN',
      ownership: 'LOCAL_LIFECYCLE_OWNED',
      classifierVersion: 'integration-v1',
      evidence: systemEvidence('owned-local-chain'),
      actor: { type: 'SYSTEM' },
    });
    expect(decision.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.supersedesDecisionId).toBeNull();
    expect(decision.legacyExitContinuityAuthorized).toBe(false);
  });

  it('makes creation authority immutable, including historical null values', async () => {
    const classified = await fixture({ creationAuthority: 'EXECUTOR' });
    await expect(prisma.trackedPosition.update({
      where: { id: classified.position.id },
      data: { lifecycleAuthorityAtCreation: 'OBSERVER' },
    })).rejects.toThrow(/creation authority is immutable/i);

    const legacy = await fixture();
    await expect(prisma.trackedPosition.update({
      where: { id: legacy.position.id },
      data: { lifecycleAuthorityAtCreation: 'EXECUTOR' },
    })).rejects.toThrow(/creation authority is immutable/i);
    expect((await prisma.trackedPosition.findUniqueOrThrow({
      where: { id: legacy.position.id },
    })).lifecycleAuthorityAtCreation).toBeNull();
  });

  it('rejects update and delete of append-only provenance decisions', async () => {
    const { account, position } = await fixture({ creationAuthority: 'OBSERVER' });
    const decision = await recordDecision({
      trackedPositionId: position.id,
      tradingAccountId: account.id,
      origin: 'BROKER_EXTERNAL',
      ownership: 'NOT_LOCALLY_OWNED',
      classifierVersion: 'integration-v1',
      evidence: systemEvidence('external'),
      actor: { type: 'SYSTEM' },
    });
    await expect(prisma.positionLifecycleProvenanceDecision.update({
      where: { id: decision.id },
      data: { classifierVersion: 'rewritten' },
    })).rejects.toThrow(/immutable evidence/i);
    await expect(prisma.positionLifecycleProvenanceDecision.delete({
      where: { id: decision.id },
    })).rejects.toThrow(/immutable evidence/i);
  });

  it('supersedes linearly while preserving the prior evidence and reviewed continuity decision', async () => {
    const { user, account, position } = await fixture();
    const firstEvidence = systemEvidence('unknown-origin');
    const first = await recordDecision({
      trackedPositionId: position.id,
      tradingAccountId: account.id,
      origin: 'UNKNOWN',
      ownership: 'UNKNOWN',
      classifierVersion: 'integration-v1',
      evidence: firstEvidence,
      actor: { type: 'SYSTEM' },
    });
    const second = await recordDecision({
      trackedPositionId: position.id,
      tradingAccountId: account.id,
      origin: 'BROKER_EXTERNAL',
      ownership: 'NOT_LOCALLY_OWNED',
      legacyExitContinuityAuthorized: true,
      classifierVersion: 'review-v1',
      evidence: { source: 'REVIEWED_LEGACY_EVIDENCE', priorDecisionId: first.id },
      actor: { type: 'USER', userId: user.id },
    });
    expect(second.supersedesDecisionId).toBe(first.id);
    expect(second.legacyExitContinuityAuthorized).toBe(true);
    expect((await prisma.positionLifecycleProvenanceDecision.findUniqueOrThrow({
      where: { id: first.id },
    })).evidenceJson).toEqual(firstEvidence);
    const heads = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT d.id FROM "PositionLifecycleProvenanceDecision" d
      WHERE d."trackedPositionId" = ${position.id}
        AND NOT EXISTS (
          SELECT 1 FROM "PositionLifecycleProvenanceDecision" successor
          WHERE successor."supersedesDecisionId" = d.id
        )
    `;
    expect(heads).toEqual([{ id: second.id }]);
  });

  it('rejects invalid origin/ownership, continuity, actor, and cross-account relationships', async () => {
    const left = await fixture();
    const right = await fixture();
    const base = {
      trackedPositionId: left.position.id,
      tradingAccountId: left.account.id,
      classifierVersion: 'integration-v1',
      evidenceFingerprint: 'a'.repeat(64),
      evidenceJson: systemEvidence('invalid'),
      actorType: 'SYSTEM' as const,
    };
    await expect(prisma.positionLifecycleProvenanceDecision.create({ data: {
      ...base,
      origin: 'BROKER_EXTERNAL',
      ownership: 'LOCAL_LIFECYCLE_OWNED',
    } })).rejects.toThrow();
    await expect(prisma.positionLifecycleProvenanceDecision.create({ data: {
      ...base,
      origin: 'BROKER_EXTERNAL',
      ownership: 'NOT_LOCALLY_OWNED',
      legacyExitContinuityAuthorized: true,
    } })).rejects.toThrow();
    await expect(prisma.positionLifecycleProvenanceDecision.create({ data: {
      ...base,
      tradingAccountId: right.account.id,
      origin: 'UNKNOWN',
      ownership: 'UNKNOWN',
    } })).rejects.toThrow();
  });

  it('leaves current position, claim, exit-state, configuration, and exit eligibility unchanged', async () => {
    const created = await fixture({ withLifecycleRecords: true });
    const before = await prisma.trackedPosition.findUniqueOrThrow({
      where: { id: created.position.id },
      include: { exitState: true, entryExposureClaim: true, tradingAccountSubscription: true },
    });
    await recordDecision({
      trackedPositionId: created.position.id,
      tradingAccountId: created.account.id,
      origin: 'LOCAL_ORDER_CHAIN',
      ownership: 'LOCAL_LIFECYCLE_OWNED',
      classifierVersion: 'integration-v1',
      evidence: systemEvidence('compatibility'),
      actor: { type: 'SYSTEM' },
    });
    const after = await prisma.trackedPosition.findUniqueOrThrow({
      where: { id: created.position.id },
      include: { exitState: true, entryExposureClaim: true, tradingAccountSubscription: true },
    });
    expect(after.status).toBe(before.status);
    expect(after.subscriptionId).toBe(before.subscriptionId);
    expect(after.tradingAccountSubscriptionId).toBe(before.tradingAccountSubscriptionId);
    expect(after.configSnapshotJson).toEqual(before.configSnapshotJson);
    expect(after.exitState).toEqual(before.exitState);
    expect(after.entryExposureClaim).toEqual(before.entryExposureClaim);
    expect(after.tradingAccountSubscription?.exitsEnabled).toBe(true);
  });

  it('supports mixed-version writes that omit all Phase 1A columns', async () => {
    const created = await fixture();
    await prisma.$executeRaw`
      UPDATE "TrackedPosition" SET "currentPrice" = 106, "lastSyncedAt" = CURRENT_TIMESTAMP
      WHERE id = ${created.position.id}
    `;
    const read = await prisma.trackedPosition.findUniqueOrThrow({ where: { id: created.position.id } });
    expect(read.currentPrice).toBe(106);
    expect(read.lifecycleAuthorityAtCreation).toBeNull();
  });

  it('keeps the additive column nullable with no database default or automatic backfill', async () => {
    const rows = await prisma.$queryRaw<Array<{ is_nullable: string; column_default: string | null }>>`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'TrackedPosition'
        AND column_name = 'lifecycleAuthorityAtCreation'
    `;
    expect(rows).toEqual([{ is_nullable: 'YES', column_default: null }]);
  });
});
