import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && databaseUrl ? describe : describe.skip;
const releaseFailure = vi.hoisted(() => ({ next: false }));

vi.mock('../../services/entry-exposure-claim.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/entry-exposure-claim.service.js')>();
  return {
    ...actual,
    releaseUnsubmittedEntryExposureClaim: async (...args: Parameters<typeof actual.releaseUnsubmittedEntryExposureClaim>) => {
      if (releaseFailure.next) {
        releaseFailure.next = false;
        throw new Error('INJECTED_EXPOSURE_RELEASE_TECHNICAL_FAILURE');
      }
      return actual.releaseUnsubmittedEntryExposureClaim(...args);
    },
  };
});

describeDatabase('external signal execution lifecycle projection on PostgreSQL', () => {
  const originalDatabaseUrl = databaseUrl!;
  const fetchSpy = vi.fn(async () => { throw new Error('Projection tests forbid broker network access'); });
  let disposable: DisposablePostgresDatabase | undefined;
  let sql: pg.Client | undefined;
  let db: PrismaClient | undefined;
  let fixture: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;
  let projectExternalSignalExecutionLifecycle: typeof import('../../services/external-signal-execution-lifecycle-projection.service.js')['projectExternalSignalExecutionLifecycle'];
  let processTradingViewOrderIntentForC2: typeof import('../../services/external-signal-broker-worker.service.js')['processTradingViewOrderIntentForC2'];
  let globalPrisma: typeof import('../prisma.js')['prisma'] | undefined;

  beforeAll(async () => {
    try {
      vi.stubGlobal('fetch', fetchSpy);
      disposable = await createDisposablePostgresDatabase(originalDatabaseUrl, 'execproj');
      await disposable.migrate();
      await disposable.verify();
      process.env.DATABASE_URL = disposable.url;
      sql = new pg.Client({ connectionString: disposable.url });
      await sql.connect();
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: disposable.url }) });
      ({ prisma: globalPrisma } = await import('../prisma.js'));
      ({ projectExternalSignalExecutionLifecycle } = await import('../../services/external-signal-execution-lifecycle-projection.service.js'));
      ({ processTradingViewOrderIntentForC2 } = await import('../../services/external-signal-broker-worker.service.js'));
      fixture = await createTradingViewGraphFixture(sql);
    } catch (error) {
      await db?.$disconnect().catch(() => undefined);
      await globalPrisma?.$disconnect().catch(() => undefined);
      await sql?.end().catch(() => undefined);
      await disposable?.drop().catch(() => undefined);
      process.env.DATABASE_URL = originalDatabaseUrl;
      vi.unstubAllGlobals();
      throw error;
    }
  }, 300_000);
  afterAll(async () => {
    try {
      await db?.$disconnect().catch(() => undefined);
      await globalPrisma?.$disconnect().catch(() => undefined);
      await sql?.end().catch(() => undefined);
      await disposable?.drop();
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
      vi.unstubAllGlobals();
    }
  });

  it('maps real SHADOW and execution-prospective cycles without inventing admission authority', async () => {
    const shadowTarget = await fixture.createTarget({ grant: false });
    const shadow = await fixture.buildCycle(`projection-shadow-${randomUUID()}`, shadowTarget);
    await sql!.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_ADMISSION_PENDING' WHERE id=$1`, [shadow.accountCycleId]);
    const prospectiveTarget = await fixture.createTarget();
    const prospective = await fixture.prospective(`projection-prospective-${randomUUID()}`, prospectiveTarget);

    const shadowProjection = await projectExternalSignalExecutionLifecycle(shadow.cycleId, [shadow.accountCycleId], db as never);
    const prospectiveProjection = await projectExternalSignalExecutionLifecycle(prospective.cycleId, [prospective.accountCycleId], db as never);
    expect(shadowProjection.accountCycles[0]?.lifecycle).toEqual({ stage: 'NOT_AN_EXECUTION_CANDIDATE', reasonCode: 'ENTRY_ADMISSION_PENDING' });
    expect(prospectiveProjection.accountCycles[0]?.lifecycle).toEqual({ stage: 'ADMISSION_AWAITING_PROCESSING', reasonCode: 'DURABLE_EXECUTION_PROSPECTIVE_ADMISSION' });
  });

  it('keeps authoritative recovery truth and association counts independent of the 100-row display cap', async () => {
    const graph = await fixture.admit(`projection-attention-${randomUUID()}`);
    await sql!.query('BEGIN');
    await sql!.query(`SET LOCAL session_replication_role='replica'`);
    const brokerOrderId = (await sql!.query(`INSERT INTO "BrokerOrder" ("orderIntentId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","securityId","tradingAccountId","createdAt","updatedAt") VALUES ($1,'alpaca',$2,$3,$4,'buy','accepted','{}',$5,$6,now(),now()) RETURNING id`, [graph.intentId, `broker-${randomUUID()}`, graph.clientOrderId, graph.target.symbol, graph.target.securityId, fixture.paperId])).rows[0].id as number;
    await sql!.query('COMMIT');
    await sql!.query(`INSERT INTO "OperationalAttention" ("tradingAccountId",code,source,status,severity,title,message,"detailsJson",fingerprint,"resolutionPolicy","orderIntentId","resolvedAt","resolutionMethod","resolutionReason","createdAt","updatedAt") SELECT $1,'PROJECTION_RESOLVED_'||n,'TEST','RESOLVED','WARNING','Resolved','Resolved','{}',md5(random()::text||n::text),'AUTHORITATIVE_ONLY',$2,now(),'AUTHORITATIVE','fixture',now(),now() FROM generate_series(1,100) n`, [fixture.paperId, graph.intentId]);
    const activeId = (await sql!.query(`INSERT INTO "OperationalAttention" ("tradingAccountId",code,source,status,severity,title,message,"detailsJson",fingerprint,"activeKey","resolutionPolicy","orderIntentId","brokerOrderId","createdAt","updatedAt") VALUES ($1,'PROJECTION_ACTIVE','TEST','OPEN','ERROR','Active','Active','{}',$2,$3,'AUTHORITATIVE_ONLY',$4,$5,now(),now()) RETURNING id`, [fixture.paperId, randomUUID(), randomUUID(), graph.intentId, brokerOrderId])).rows[0].id as number;
    const before = (await sql!.query(`SELECT count(*)::int AS n FROM "OperationalAttention" WHERE "orderIntentId"=$1`, [graph.intentId])).rows[0].n;

    for (let request = 0; request < 2; request += 1) {
      const result = await projectExternalSignalExecutionLifecycle(graph.cycleId, [graph.accountCycleId], db as never);
      const recovery = result.accountCycles[0]!.recovery;
      expect(recovery).toMatchObject({ authoritativeReconciliationRequired: true, unresolvedAuthoritativeOnlyCount: 1, activeAttentionCount: 1, operationalAttentionMetadata: { returned: 100, total: 101, truncated: true }, activeOperationalAttentionMetadata: { returned: 1, total: 1, truncated: false } });
      expect(recovery.activeOperationalAttention).toEqual([expect.objectContaining({ id: activeId })]);
    }
    expect((await sql!.query(`SELECT count(*)::int AS n FROM "OperationalAttention" WHERE "orderIntentId"=$1`, [graph.intentId])).rows[0].n).toBe(before);
  });

  it('projects a real risk-denied C2 refusal and released exposure as terminal', async () => {
    const graph = await fixture.admit(`projection-c2-refusal-${randomUUID()}`);
    await sql!.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
    expect(await processTradingViewOrderIntentForC2(graph.intentId, { db: db! })).toMatchObject({ outcome: 'RISK_DENIED' });
    const result = await projectExternalSignalExecutionLifecycle(graph.cycleId, [graph.accountCycleId], db as never);
    expect(result.accountCycles[0]).toMatchObject({
      lifecycle: { stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED' },
      readiness: { c2WorkerClaimPresent: true },
      evidence: { orderIntent: { status: 'blocked' }, exposure: { held: false, status: 'RELEASED' }, workerClaim: { id: expect.any(Number) } },
      recovery: { retainedExposureReviewRequired: false, retainedExposureReasonCode: null },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a real C2 refusal with an injected release failure visibly inconsistent and recoverable', async () => {
    const graph = await fixture.admit(`projection-c2-retained-${randomUUID()}`);
    await sql!.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
    releaseFailure.next = true;
    expect(await processTradingViewOrderIntentForC2(graph.intentId, { db: db! })).toMatchObject({ outcome: 'RISK_DENIED' });

    const durable = (await sql!.query(`SELECT i.status, c.status AS "claimStatus", c."releasedAt",
      array_agg(e."eventType" ORDER BY e.id) AS events
      FROM "OrderIntent" i JOIN "EntryExposureClaim" c ON c."orderIntentId"=i.id
      LEFT JOIN "EntryExposureClaimEvent" e ON e."claimId"=c.id
      WHERE i.id=$1 GROUP BY i.status,c.status,c."releasedAt"`, [graph.intentId])).rows[0];
    expect(durable).toMatchObject({ status: 'blocked', claimStatus: 'ENTRY_SUBMITTING', releasedAt: null });
    expect(durable.events).toContain('RECOVERY_ATTEMPT_FAILED');

    const result = await projectExternalSignalExecutionLifecycle(graph.cycleId, [graph.accountCycleId], db as never);
    expect(result.accountCycles[0]).toMatchObject({
      lifecycle: { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE' },
      evidence: { orderIntent: { status: 'blocked' }, exposure: { held: true, status: 'ENTRY_SUBMITTING', releasedAt: null }, workerClaim: { id: expect.any(Number) } },
      recovery: { retainedExposureReviewRequired: true, retainedExposureReasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE', authoritativeReconciliationRequired: false },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
