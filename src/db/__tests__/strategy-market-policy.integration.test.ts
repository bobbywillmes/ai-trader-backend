import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Strategy market policy PostgreSQL integrity', () => {
  const database = `strategy_market_policy_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let strategyId: number, policyId: number, activeRevisionId: number;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('policy-test','Policy Test',true,now(),now()) RETURNING id`)).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  it('replays migrations without schema drift', () => {
    const output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000 });
    expect(output).toContain('No difference detected');
  }, 70_000);

  it('creates an audited explicit five-dimension PREPARED revision and activates it', async () => {
    const service = await import('../../services/strategy-market-policy.service.js');
    const policy = await service.createStrategyMarketPolicy(strategyId, 0, 'Initial shadow policy');
    policyId = policy.id; expect(policy.authority).toBe('SHADOW_ONLY'); expect(policy.revisions[0]?.dimensionRules).toHaveLength(5);
    expect(policy.revisions[0]?.dimensionRules.every(rule => rule.requirement === 'IGNORED')).toBe(true);
    const initial = policy.revisions[0]!;
    const saved = await service.saveStrategyMarketPolicyRevision(strategyId, initial.id, { expectedConfigurationFingerprint: initial.configurationFingerprint, rules: initial.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' : 'IGNORED', allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })) }, 0);
    const validation = await service.validateStrategyMarketPolicyRevision(strategyId, saved.id);
    expect(validation).toMatchObject({ valid: true, revision: 1 });
    const active = await service.activateStrategyMarketPolicyRevision(strategyId, saved.id, validation.configurationFingerprint, 0);
    activeRevisionId = active.id; expect(active.status).toBe('ACTIVE');
    expect((await db.query(`SELECT count(*)::int count FROM "SystemEvent" WHERE type LIKE 'strategy_market_policy_%'`)).rows[0].count).toBeGreaterThanOrEqual(3);
  });

  it('serializes revision numbering and permits only one PREPARED revision', async () => {
    const service = await import('../../services/strategy-market-policy.service.js');
    const results = await Promise.allSettled([
      service.prepareStrategyMarketPolicyRevision(strategyId, 0, 'Concurrent A'),
      service.prepareStrategyMarketPolicyRevision(strategyId, 0, 'Concurrent B'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rows = (await db.query(`SELECT revision,status FROM "StrategyMarketPolicyRevision" WHERE "policyId"=$1 ORDER BY revision`, [policyId])).rows;
    expect(rows).toEqual([{ revision: 1, status: 'ACTIVE' }, { revision: 2, status: 'PREPARED' }]);
  });

  it('enforces vocabulary, explicit ignored semantics, and PREPARED-only edits', async () => {
    const service = await import('../../services/strategy-market-policy.service.js');
    const prepared = (await service.getStrategyMarketPolicy(strategyId)).policy!.revisions.find(row => row.status === 'PREPARED')!;
    const rules = prepared.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.requirement, allowedStates: rule.allowedStates.map(item => item.state) }));
    const fingerprint = service.strategyMarketPolicyConfigurationFingerprint(prepared.dimensionRules);
    await expect(service.saveStrategyMarketPolicyRevision(strategyId, prepared.id, { expectedConfigurationFingerprint: fingerprint, rules: rules.map(rule => rule.dimension === 'TREND' ? { ...rule, allowedStates: ['BULLISH'] } : rule) }, 0)).rejects.toThrow(/incomplete or invalid/);
    await expect(service.saveStrategyMarketPolicyRevision(strategyId, prepared.id, { expectedConfigurationFingerprint: fingerprint, rules: rules.map(rule => rule.dimension === 'TREND' ? { ...rule, requirement: 'IGNORED', allowedStates: ['UP'] } : rule) }, 0)).rejects.toThrow(/incomplete or invalid/);
    const unchanged = (await service.getStrategyMarketPolicy(strategyId)).policy!.revisions.find(row => row.id === prepared.id)!;
    expect(service.strategyMarketPolicyConfigurationFingerprint(unchanged.dimensionRules)).toBe(fingerprint);
    const saved = await service.saveStrategyMarketPolicyRevision(strategyId, prepared.id, { expectedConfigurationFingerprint: fingerprint, rules: rules.map(rule => rule.dimension === 'TREND' ? { ...rule, requirement: 'REQUIRED', allowedStates: ['NEUTRAL', 'UP'] } : rule) }, 0);
    await expect(service.saveStrategyMarketPolicyRevision(strategyId, activeRevisionId, { expectedConfigurationFingerprint: '0'.repeat(64), rules }, 0)).rejects.toThrow(/PREPARED/);
    await expect(service.saveStrategyMarketPolicyRevision(strategyId, prepared.id, { expectedConfigurationFingerprint: fingerprint, rules }, 0)).rejects.toThrow(/changed after it was loaded/);
    expect(saved.configurationFingerprint).not.toBe(fingerprint);
    expect((await db.query(`SELECT count(*)::int count FROM "SystemEvent" WHERE type='strategy_market_policy_revision_saved' AND "entityId"=$1`, [String(prepared.id)])).rows[0].count).toBe(1);
    await expect(service.activateStrategyMarketPolicyRevision(strategyId, prepared.id, fingerprint, 0)).rejects.toThrow(/changed after validation/);
    const activeRule = (await db.query(`SELECT id FROM "StrategyMarketPolicyDimensionRule" WHERE "revisionId"=$1 AND dimension='TREND'`, [activeRevisionId])).rows[0].id;
    await expect(db.query(`INSERT INTO "StrategyMarketPolicyAllowedState" ("ruleId",state) VALUES ($1,'UP')`, [activeRule])).rejects.toThrow(/PREPARED/);
  });

  it('atomically retires the prior ACTIVE revision and leaves one active policy', async () => {
    const service = await import('../../services/strategy-market-policy.service.js');
    const prepared = (await service.getStrategyMarketPolicy(strategyId)).policy!.revisions.find(row => row.status === 'PREPARED')!;
    const validation = await service.validateStrategyMarketPolicyRevision(strategyId, prepared.id);
    const next = await service.activateStrategyMarketPolicyRevision(strategyId, prepared.id, validation.configurationFingerprint, 0);
    expect(next.status).toBe('ACTIVE');
    const rows = (await db.query(`SELECT revision,status,"retiredAt" FROM "StrategyMarketPolicyRevision" WHERE "policyId"=$1 ORDER BY revision`, [policyId])).rows;
    expect(rows[0]).toMatchObject({ revision: 1, status: 'RETIRED' }); expect(rows[0].retiredAt).toBeTruthy(); expect(rows[1]).toMatchObject({ revision: 2, status: 'ACTIVE' });
    expect((await db.query(`SELECT count(*)::int count FROM "StrategyMarketPolicyRevision" WHERE "policyId"=$1 AND status='ACTIVE'`, [policyId])).rows[0].count).toBe(1);
    await expect(db.query(`UPDATE "StrategyMarketPolicyRevision" SET "changeNote"='rewrite' WHERE id=$1`, [next.id])).rejects.toThrow(/immutable/);
  });

  it('rejects direct-SQL lifecycle reversals and freezes activated policy identity', async () => {
    const rows = (await db.query(`SELECT id,status FROM "StrategyMarketPolicyRevision" WHERE "policyId"=$1 ORDER BY revision`, [policyId])).rows;
    const retired = rows.find(row => row.status === 'RETIRED')!;
    const active = rows.find(row => row.status === 'ACTIVE')!;
    await expect(db.query(`UPDATE "StrategyMarketPolicyRevision" SET status='PREPARED', "activatedAt"=NULL, "retiredAt"=NULL WHERE id=$1`, [active.id])).rejects.toThrow(/not allowed|immutable/);
    await expect(db.query(`UPDATE "StrategyMarketPolicyRevision" SET status='PREPARED', "activatedAt"=NULL, "retiredAt"=NULL WHERE id=$1`, [retired.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE "StrategyMarketPolicyRevision" SET revision=revision+10 WHERE id=$1`, [active.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE "StrategyMarketPolicyRevision" SET "activatedAt"="activatedAt" + interval '1 second' WHERE id=$1`, [active.id])).rejects.toThrow(/not allowed|immutable/);
    await expect(db.query(`DELETE FROM "StrategyMarketPolicyRevision" WHERE id=$1`, [active.id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query(`INSERT INTO "StrategyMarketPolicyRevision" ("policyId",revision,status,"createdAt","activatedAt") VALUES ($1,99,'ACTIVE',now(),now())`, [policyId])).rejects.toThrow(/begin PREPARED/);
    const otherStrategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('policy-other','Policy Other',true,now(),now()) RETURNING id`)).rows[0].id;
    await expect(db.query(`UPDATE "StrategyMarketPolicy" SET "strategyId"=$1 WHERE id=$2`, [otherStrategyId, policyId])).rejects.toThrow(/identity and authority are immutable/);
  });

  it('rejects incomplete activation without retiring the active revision', async () => {
    const service = await import('../../services/strategy-market-policy.service.js');
    const prepared = await service.prepareStrategyMarketPolicyRevision(strategyId, 0, 'Incomplete test');
    await db.query(`DELETE FROM "StrategyMarketPolicyDimensionRule" WHERE "revisionId"=$1 AND dimension='BREADTH'`, [prepared.id]);
    const validation = await service.validateStrategyMarketPolicyRevision(strategyId, prepared.id);
    expect(validation.valid).toBe(false);
    await expect(service.activateStrategyMarketPolicyRevision(strategyId, prepared.id, validation.configurationFingerprint, 0)).rejects.toThrow(/incomplete or invalid/);
    expect((await db.query(`SELECT revision FROM "StrategyMarketPolicyRevision" WHERE "policyId"=$1 AND status='ACTIVE'`, [policyId])).rows[0].revision).toBe(2);
  });
});
