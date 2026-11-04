import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectExternalSignalExecutionLifecycle } from '../../services/external-signal-execution-lifecycle-projection.service.js';
import { processTradingViewOrderIntentForC2 } from '../../services/external-signal-broker-worker.service.js';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && databaseUrl ? describe : describe.skip;

describeDatabase('external signal execution lifecycle projection on PostgreSQL', () => {
  const sql = new pg.Client({ connectionString: databaseUrl });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
  let fixture: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;

  beforeAll(async () => { await sql.connect(); fixture = await createTradingViewGraphFixture(sql); });
  afterAll(async () => { await db.$disconnect(); await sql.end(); });

  it('maps real SHADOW and execution-prospective cycles without inventing admission authority', async () => {
    const shadowTarget = await fixture.createTarget({ grant: false });
    const shadow = await fixture.buildCycle(`projection-shadow-${randomUUID()}`, shadowTarget);
    await sql.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_ADMISSION_PENDING' WHERE id=$1`, [shadow.accountCycleId]);
    const prospectiveTarget = await fixture.createTarget();
    const prospective = await fixture.prospective(`projection-prospective-${randomUUID()}`, prospectiveTarget);

    const shadowProjection = await projectExternalSignalExecutionLifecycle(shadow.cycleId, [shadow.accountCycleId], db as never);
    const prospectiveProjection = await projectExternalSignalExecutionLifecycle(prospective.cycleId, [prospective.accountCycleId], db as never);
    expect(shadowProjection.accountCycles[0]?.lifecycle).toEqual({ stage: 'NOT_AN_EXECUTION_CANDIDATE', reasonCode: 'ENTRY_ADMISSION_PENDING' });
    expect(prospectiveProjection.accountCycles[0]?.lifecycle).toEqual({ stage: 'ADMISSION_AWAITING_PROCESSING', reasonCode: 'DURABLE_EXECUTION_PROSPECTIVE_ADMISSION' });
  });

  it('keeps authoritative recovery truth and association counts independent of the 100-row display cap', async () => {
    const graph = await fixture.admit(`projection-attention-${randomUUID()}`);
    await sql.query('BEGIN');
    await sql.query(`SET LOCAL session_replication_role='replica'`);
    const brokerOrderId = (await sql.query(`INSERT INTO "BrokerOrder" ("orderIntentId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","securityId","tradingAccountId","createdAt","updatedAt") VALUES ($1,'alpaca',$2,$3,$4,'buy','accepted','{}',$5,$6,now(),now()) RETURNING id`, [graph.intentId, `broker-${randomUUID()}`, graph.clientOrderId, graph.target.symbol, graph.target.securityId, fixture.paperId])).rows[0].id as number;
    await sql.query('COMMIT');
    await sql.query(`INSERT INTO "OperationalAttention" ("tradingAccountId",code,source,status,severity,title,message,"detailsJson",fingerprint,"resolutionPolicy","orderIntentId","resolvedAt","resolutionMethod","resolutionReason","createdAt","updatedAt") SELECT $1,'PROJECTION_RESOLVED_'||n,'TEST','RESOLVED','WARNING','Resolved','Resolved','{}',md5(random()::text||n::text),'AUTHORITATIVE_ONLY',$2,now(),'AUTHORITATIVE','fixture',now(),now() FROM generate_series(1,100) n`, [fixture.paperId, graph.intentId]);
    const activeId = (await sql.query(`INSERT INTO "OperationalAttention" ("tradingAccountId",code,source,status,severity,title,message,"detailsJson",fingerprint,"activeKey","resolutionPolicy","orderIntentId","brokerOrderId","createdAt","updatedAt") VALUES ($1,'PROJECTION_ACTIVE','TEST','OPEN','ERROR','Active','Active','{}',$2,$3,'AUTHORITATIVE_ONLY',$4,$5,now(),now()) RETURNING id`, [fixture.paperId, randomUUID(), randomUUID(), graph.intentId, brokerOrderId])).rows[0].id as number;
    const before = (await sql.query(`SELECT count(*)::int AS n FROM "OperationalAttention" WHERE "orderIntentId"=$1`, [graph.intentId])).rows[0].n;

    for (let request = 0; request < 2; request += 1) {
      const result = await projectExternalSignalExecutionLifecycle(graph.cycleId, [graph.accountCycleId], db as never);
      const recovery = result.accountCycles[0]!.recovery;
      expect(recovery).toMatchObject({ authoritativeReconciliationRequired: true, unresolvedAuthoritativeOnlyCount: 1, activeAttentionCount: 1, operationalAttentionMetadata: { returned: 100, total: 101, truncated: true }, activeOperationalAttentionMetadata: { returned: 1, total: 1, truncated: false } });
      expect(recovery.activeOperationalAttention).toEqual([expect.objectContaining({ id: activeId })]);
    }
    expect((await sql.query(`SELECT count(*)::int AS n FROM "OperationalAttention" WHERE "orderIntentId"=$1`, [graph.intentId])).rows[0].n).toBe(before);
  });

  it('projects a real risk-denied C2 refusal and released exposure as terminal', async () => {
    const graph = await fixture.admit(`projection-c2-refusal-${randomUUID()}`);
    await sql.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
    expect(await processTradingViewOrderIntentForC2(graph.intentId, { db })).toMatchObject({ outcome: 'RISK_DENIED' });
    const result = await projectExternalSignalExecutionLifecycle(graph.cycleId, [graph.accountCycleId], db as never);
    expect(result.accountCycles[0]).toMatchObject({
      lifecycle: { stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED' },
      readiness: { c2WorkerClaimPresent: true },
      evidence: { orderIntent: { status: 'blocked' }, exposure: { held: false, status: 'RELEASED' }, workerClaim: { id: expect.any(Number) } },
    });
  });
});
