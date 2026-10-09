import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Market Regime composition PostgreSQL integrity', () => {
  const database = `market_regime_composition_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, prisma: PrismaClient, databaseUrl: string;
  const sourceIds: number[] = [];
  const sourceDefinitions = [
    ['TREND', 'TREND_V1', 'UP', '2026-10-07T20:00:00Z'],
    ['VOLATILITY', 'VOLATILITY_V1', 'NORMAL', '2026-10-07T20:00:00Z'],
    ['BREADTH', 'BREADTH_V1', 'POSITIVE', '2026-10-07T20:00:00Z'],
    ['PARTICIPATION', 'PARTICIPATION_V1', 'ACTIVE', '2026-10-07T20:00:00Z'],
    ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', 'NORMAL', '2026-10-08T17:45:00Z'],
  ] as const;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) {
      try { await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8')); }
      catch (error) { throw new Error(`Migration ${migration} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    }
    for (const [dimension, algorithmVersion, state, targetAt] of sourceDefinitions) {
      const result = await db.query(`INSERT INTO "MarketRegimeDimensionAssessment"
        (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson")
        VALUES ($1,$2,1,$3,'2026-10-08',1,'VALID',$4,$4,$3,'2026-10-08T18:15:00Z',$3,$3,'{}') RETURNING id`,
      [dimension, algorithmVersion, targetAt, state]);
      sourceIds.push(result.rows[0].id);
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }, 120_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  function insertParent(client: Client, fingerprint: string) {
    return client.query(`INSERT INTO "MarketRegimeAssessment"
      ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","dataThroughAt","validUntil","publicationStatus","evidenceHealth","publicationReasonCode","evidenceReasonCode","sourceSetFingerprint","startedAt","completedAt","evidenceJson")
      VALUES ('MARKET_REGIME_COMPOSITION_V1',1,'2026-10-08T17:45:00Z','2026-10-08T18:00:00Z','2026-10-07T20:00:00Z','2026-10-08T18:15:00Z','SUCCEEDED','COMPLETE',NULL,NULL,$1,'2026-10-08T17:59:59Z','2026-10-08T18:00:01Z','{}') RETURNING id`, [fingerprint]);
  }

  async function insertSource(client: Client, parentId: number, index: number, options: { algorithmVersion?: string; sourceId?: number; sourceAttempt?: number } = {}) {
    const [dimension, defaultAlgorithm, , expectedTargetAt] = sourceDefinitions[index]!;
    const sourceId = options.sourceId ?? sourceIds[index]!;
    const source = (await client.query(`SELECT * FROM "MarketRegimeDimensionAssessment" WHERE id=$1`, [sourceId])).rows[0];
    return client.query(`INSERT INTO "MarketRegimeAssessmentSource"
      ("marketRegimeAssessmentId",dimension,"requiredAlgorithmVersion","expectedTargetAt","sourceAssessmentId","sourceEvidenceSchemaVersion","sourceAttempt","sourceStatus","sourceTargetAt","sourceCompletedAt","sourceDataThroughAt","sourceValidUntil","sourceRawState","sourceEffectiveState",health,"reasonCode",ordinal,"evidenceJson")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'AVAILABLE',NULL,$15,'{}')`, [
      parentId, dimension, options.algorithmVersion ?? defaultAlgorithm, expectedTargetAt, sourceId,
      source.evidenceSchemaVersion, options.sourceAttempt ?? source.attempt, source.status, source.targetAt,
      source.completedAt, source.dataThroughAt, source.validUntil, source.rawState, source.effectiveState, index + 1,
    ]);
  }

  async function insertCompleteComposition(fingerprint: string) {
    await db.query('BEGIN');
    try {
      const parentId = (await insertParent(db, fingerprint)).rows[0].id;
      for (let index = 0; index < 5; index++) await insertSource(db, parentId, index);
      await db.query('COMMIT');
      return parentId as number;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }

  it('replays all migrations without Prisma schema drift', () => {
    const output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000, stdio: 'pipe',
    });
    expect(output).toContain('No difference detected');
  }, 70_000);

  it('persists one immutable exact five-source composition', async () => {
    const parentId = await insertCompleteComposition('a'.repeat(64));
    expect((await db.query(`SELECT count(*)::int count FROM "MarketRegimeAssessmentSource" WHERE "marketRegimeAssessmentId"=$1`, [parentId])).rows[0].count).toBe(5);
    await expect(db.query(`UPDATE "MarketRegimeAssessment" SET "evidenceReasonCode"='rewrite' WHERE id=$1`, [parentId])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "MarketRegimeAssessmentSource" WHERE "marketRegimeAssessmentId"=$1`, [parentId])).rejects.toThrow(/immutable/);
  });

  it('rejects incomplete source vectors at deferred commit time', async () => {
    await db.query('BEGIN');
    try {
      const parentId = (await insertParent(db, 'b'.repeat(64))).rows[0].id;
      for (let index = 0; index < 4; index++) await insertSource(db, parentId, index);
      await expect(db.query('COMMIT')).rejects.toThrow(/exactly five/);
    } finally { await db.query('ROLLBACK'); }
  });

  it('preserves a successful degraded composition with all five expected slots', async () => {
    await db.query('BEGIN');
    try {
      const parentId = (await db.query(`INSERT INTO "MarketRegimeAssessment"
        ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","publicationStatus","evidenceHealth","publicationReasonCode","evidenceReasonCode","sourceSetFingerprint","startedAt","completedAt","evidenceJson")
        VALUES ('MARKET_REGIME_COMPOSITION_V1',1,'2026-10-08T17:45:00Z','2026-10-08T18:00:00Z','SUCCEEDED','DEGRADED',NULL,'SOURCE_VECTOR_DEGRADED',$1,'2026-10-08T17:59:59Z','2026-10-08T18:00:01Z','{}') RETURNING id`, ['1'.repeat(64)])).rows[0].id;
      const [dimension, algorithmVersion, , expectedTargetAt] = sourceDefinitions[0];
      await db.query(`INSERT INTO "MarketRegimeAssessmentSource"
        ("marketRegimeAssessmentId",dimension,"requiredAlgorithmVersion","expectedTargetAt",health,"reasonCode",ordinal,"evidenceJson")
        VALUES ($1,$2,$3,$4,'MISSING','SOURCE_MISSING',1,'{}')`, [parentId, dimension, algorithmVersion, expectedTargetAt]);
      for (let index = 1; index < 5; index++) await insertSource(db, parentId, index);
      await db.query('COMMIT');
      expect((await db.query(`SELECT "publicationStatus","evidenceHealth","validUntil" FROM "MarketRegimeAssessment" WHERE id=$1`, [parentId])).rows[0])
        .toMatchObject({ publicationStatus: 'SUCCEEDED', evidenceHealth: 'DEGRADED', validUntil: null });
      expect((await db.query(`SELECT count(*)::int count FROM "MarketRegimeAssessmentSource" WHERE "marketRegimeAssessmentId"=$1`, [parentId])).rows[0].count).toBe(5);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });

  it('keeps publication failure orthogonal to a complete source vector', async () => {
    await db.query('BEGIN');
    try {
      const parentId = (await db.query(`INSERT INTO "MarketRegimeAssessment"
        ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","dataThroughAt","validUntil","publicationStatus","evidenceHealth","publicationReasonCode","evidenceReasonCode","sourceSetFingerprint","startedAt","completedAt","evidenceJson")
        VALUES ('MARKET_REGIME_COMPOSITION_V1',1,'2026-10-08T17:45:00Z','2026-10-08T18:00:00Z','2026-10-07T20:00:00Z','2026-10-08T18:15:00Z','FAILED','COMPLETE','COMPOSER_FAILED',NULL,$1,'2026-10-08T17:59:59Z','2026-10-08T18:00:01Z','{}') RETURNING id`, ['2'.repeat(64)])).rows[0].id;
      for (let index = 0; index < 5; index++) await insertSource(db, parentId, index);
      await db.query('COMMIT');
      expect((await db.query(`SELECT "publicationStatus","evidenceHealth" FROM "MarketRegimeAssessment" WHERE id=$1`, [parentId])).rows[0])
        .toEqual({ publicationStatus: 'FAILED', evidenceHealth: 'COMPLETE' });
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });

  it('rejects Breadth V2, duplicate dimensions and mismatched source snapshots', async () => {
    await db.query('BEGIN');
    try {
      const parentId = (await insertParent(db, 'c'.repeat(64))).rows[0].id;
      await expect(insertSource(db, parentId, 2, { algorithmVersion: 'BREADTH_V2_TERTILE_V1' })).rejects.toThrow();
    } finally { await db.query('ROLLBACK'); }
    await db.query('BEGIN');
    try {
      const parentId = (await insertParent(db, 'd'.repeat(64))).rows[0].id;
      for (let index = 0; index < 5; index++) await insertSource(db, parentId, index, index === 0 ? { sourceAttempt: 99 } : {});
      await expect(db.query('COMMIT')).rejects.toThrow(/snapshot conflicts/);
    } finally { await db.query('ROLLBACK'); }
  });

  it('enforces idempotency and composition-version predecessor isolation', async () => {
    const first = await insertCompleteComposition('e'.repeat(64));
    await expect(insertCompleteComposition('e'.repeat(64))).rejects.toThrow(/unique/i);
    await db.query('BEGIN');
    try {
      await expect(db.query(`INSERT INTO "MarketRegimeAssessment"
        ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","publicationStatus","evidenceHealth","publicationReasonCode","evidenceReasonCode","sourceSetFingerprint","previousAssessmentId","startedAt","completedAt","evidenceJson")
        VALUES ('MARKET_REGIME_COMPOSITION_V2',1,'2026-10-08T17:45:00Z','2026-10-08T18:00:00Z','FAILED','DEGRADED','PUBLICATION_FAILED','SOURCE_VECTOR_DEGRADED',$1,$2,'2026-10-08T17:59:59Z','2026-10-08T18:00:01Z','{}')`, ['f'.repeat(64), first])).rejects.toThrow();
    } finally { await db.query('ROLLBACK'); }
  });

  it('previews read-only, publishes atomically, deduplicates ticks and expires at read time', async () => {
    const { currentMarketRegimeComposition, previewMarketRegimeComposition, publishMarketRegimeComposition } =
      await import('../../services/market-regime-composition-publication.service.js');
    const before = await prisma.marketRegimeAssessment.count();
    const preview = await previewMarketRegimeComposition(new Date('2026-10-08T18:00:00Z'), prisma);
    expect(preview).toMatchObject({ publicationStatus: 'SUCCEEDED', evidenceHealth: 'COMPLETE' });
    expect(preview.sources).toHaveLength(5);
    expect(await prisma.marketRegimeAssessment.count()).toBe(before);

    const first = await publishMarketRegimeComposition({
      db: prisma, observedAt: new Date('2026-10-08T18:00:00Z'), clock: () => new Date('2026-10-08T18:00:01Z'),
    });
    expect(first).toMatchObject({ published: true, reused: false, assessment: { evidenceHealth: 'COMPLETE' } });
    expect(first.assessment.sources).toHaveLength(5);
    const repeated = await publishMarketRegimeComposition({
      db: prisma, observedAt: new Date('2026-10-08T18:04:00Z'), clock: () => new Date('2026-10-08T18:04:01Z'),
    });
    expect(repeated).toMatchObject({ published: false, reused: true, assessment: { id: first.assessment.id } });
    expect(await prisma.marketRegimeAssessment.count()).toBe(before + 1);
    await expect(currentMarketRegimeComposition(new Date('2026-10-08T18:15:00Z'), prisma))
      .resolves.toMatchObject({ freshness: 'EXPIRED', assessment: { id: first.assessment.id, publicationStatus: 'SUCCEEDED' } });
  });

  it('lets a failed current-target retry displace valid evidence but never lets a late backfill displace the target', async () => {
    const { previewMarketRegimeComposition } = await import('../../services/market-regime-composition-publication.service.js');
    await prisma.marketRegimeDimensionAssessment.create({ data: {
      dimension: 'TREND', algorithmVersion: 'TREND_V1', evidenceSchemaVersion: 1,
      targetAt: new Date('2026-10-07T20:00:00Z'), sessionDate: new Date('2026-10-07T00:00:00Z'), attempt: 2,
      status: 'FAILED', reasonCode: 'CALCULATION_FAILED', rawState: null, effectiveState: null,
      dataThroughAt: null, validUntil: null, startedAt: new Date('2026-10-08T18:01:00Z'),
      completedAt: new Date('2026-10-08T18:02:00Z'), evidenceJson: {},
    } });
    await prisma.marketRegimeDimensionAssessment.create({ data: {
      dimension: 'TREND', algorithmVersion: 'TREND_V1', evidenceSchemaVersion: 1,
      targetAt: new Date('2026-10-06T20:00:00Z'), sessionDate: new Date('2026-10-06T00:00:00Z'), attempt: 50,
      status: 'VALID', reasonCode: null, rawState: 'UP', effectiveState: 'UP',
      dataThroughAt: new Date('2026-10-06T20:00:00Z'), validUntil: new Date('2026-10-09T00:00:00Z'),
      startedAt: new Date('2026-10-08T18:03:00Z'), completedAt: new Date('2026-10-08T18:04:00Z'), evidenceJson: {},
    } });
    const preview = await previewMarketRegimeComposition(new Date('2026-10-08T18:05:00Z'), prisma);
    expect(preview.sources[0]).toMatchObject({ source: { attempt: 2, targetAt: new Date('2026-10-07T20:00:00Z') }, health: 'FAILED' });
    expect(preview.evidenceHealth).toBe('DEGRADED');
  });

  it('serializes concurrent triggers and persists only one row for a fingerprint', async () => {
    const second = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const { previewMarketRegimeComposition, publishMarketRegimeComposition } =
      await import('../../services/market-regime-composition-publication.service.js');
    try {
      const observedAt = new Date('2026-10-08T18:06:00Z');
      const preview = await previewMarketRegimeComposition(observedAt, prisma);
      const results = await Promise.allSettled([
        publishMarketRegimeComposition({ db: prisma, observedAt, clock: () => new Date('2026-10-08T18:06:01Z') }),
        publishMarketRegimeComposition({ db: second, observedAt, clock: () => new Date('2026-10-08T18:06:01Z') }),
      ]);
      expect(results.some(result => result.status === 'fulfilled')).toBe(true);
      expect(await prisma.marketRegimeAssessment.count({ where: {
        compositionVersion: 'MARKET_REGIME_COMPOSITION_V1', sourceSetFingerprint: preview.sourceSetFingerprint,
      } })).toBe(1);
    } finally { await second.$disconnect(); }
  });
});
