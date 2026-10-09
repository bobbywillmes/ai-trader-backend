import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Phase 2 integrity corrective migration upgrade', () => {
  const database = `phase2_integrity_upgrade_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client;
  let policyId: number, retiredRevisionId: number, activeRevisionId: number, decisionId: number;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name < '20261010180000_phase2_integrity_corrections')
      .map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));

    const strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('upgrade-policy','Upgrade Policy',true,now(),now()) RETURNING id`)).rows[0].id;
    policyId = (await db.query(`INSERT INTO "StrategyMarketPolicy" ("strategyId",authority,"createdAt","updatedAt") VALUES ($1,'SHADOW_ONLY',now(),now()) RETURNING id`, [strategyId])).rows[0].id;
    retiredRevisionId = (await db.query(`INSERT INTO "StrategyMarketPolicyRevision" ("policyId",revision,status,"changeNote","createdAt","activatedAt","retiredAt") VALUES ($1,1,'RETIRED','Original',now()-interval '3 hours',now()-interval '2 hours',now()-interval '1 hour') RETURNING id`, [policyId])).rows[0].id;
    activeRevisionId = (await db.query(`INSERT INTO "StrategyMarketPolicyRevision" ("policyId",revision,status,"changeNote","createdAt","activatedAt") VALUES ($1,2,'ACTIVE','Current',now()-interval '90 minutes',now()-interval '1 hour') RETURNING id`, [policyId])).rows[0].id;

    const noPolicyStrategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('upgrade-no-policy','Upgrade No Policy',true,now(),now()) RETURNING id`)).rows[0].id;
    decisionId = (await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","decisionFingerprint","strategyEnabled","evidenceJson") VALUES ($1,'CURRENT','CURRENT','STRATEGY_MARKET_ELIGIBILITY_V1','INSUFFICIENT_EVIDENCE','NO_ACTIVE_POLICY',now(),$2,true,'{}') RETURNING id`, [noPolicyStrategyId, randomUUID().replaceAll('-', '').repeat(2)])).rows[0].id;
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  it('upgrades the existing four-migration state without rewriting policy or shadow history', async () => {
    await db.query(await readFile('prisma/migrations/20261010180000_phase2_integrity_corrections/migration.sql', 'utf8'));
    expect((await db.query(`SELECT id,"strategyId",authority FROM "StrategyMarketPolicy" WHERE id=$1`, [policyId])).rows[0]).toMatchObject({ id: policyId, authority: 'SHADOW_ONLY' });
    expect((await db.query(`SELECT id,status,"changeNote","activatedAt","retiredAt" FROM "StrategyMarketPolicyRevision" WHERE id IN ($1,$2) ORDER BY revision`, [retiredRevisionId, activeRevisionId])).rows).toMatchObject([
      { id: retiredRevisionId, status: 'RETIRED', changeNote: 'Original' },
      { id: activeRevisionId, status: 'ACTIVE', changeNote: 'Current', retiredAt: null },
    ]);
    expect((await db.query(`SELECT id,outcome,"reasonCode" FROM "StrategyMarketEligibilityDecision" WHERE id=$1`, [decisionId])).rows[0]).toMatchObject({ id: decisionId, outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'NO_ACTIVE_POLICY' });
    await expect(db.query(`UPDATE "StrategyMarketPolicyRevision" SET status='PREPARED', "activatedAt"=NULL WHERE id=$1`, [activeRevisionId])).rejects.toThrow(/immutable|not allowed/);
  });
});
