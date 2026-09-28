import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { constituentHash, freezeBreadthUniverse, getBreadthUniverseStatus, importSecurityUniverses } from '../../services/security-universe-import.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('persistent Breadth status on disposable PostgreSQL', () => {
  const name = `breadth_status_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient;
  const day1 = new Date('2026-09-28T16:00:00Z');
  const day2 = new Date('2026-10-02T16:00:00Z');
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; url.searchParams.delete('schema');
    sql = new Client({ connectionString: url.toString() }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    for (const migration of (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
      await sql.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); await sql?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); } });

  it('derives EMPTY, REQUIRED and CURRENT from deduplicated database truth across dates', async () => {
    expect(await getBreadthUniverseStatus({ db, now: day1 })).toMatchObject({ asOfDate: '2026-09-28', state: 'EMPTY', current: { memberCount: 0, constituentHash: null }, latestRevision: null });
    expect(await getBreadthUniverseStatus({ db, now: new Date('2026-09-28T02:30:00Z') })).toMatchObject({ asOfDate: '2026-09-27', state: 'EMPTY' });
    await importSecurityUniverses('symbol,name,SP500,NASDAQ100\nAAPL,Apple,1,1\n', { db, now: day1, apply: true });
    const required = await getBreadthUniverseStatus({ db, now: day1 });
    expect(required).toMatchObject({ state: 'REVISION_REQUIRED', current: { memberCount: 1, constituentHash: constituentHash(['AAPL']) }, difference: { addedCount: 1, removedCount: 0 } });
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'AAPL' } })).enabled).toBe(false);
    expect(await freezeBreadthUniverse({ db, effectiveDate: '2026-09-28' })).toMatchObject({ memberCount: 1, constituentHash: required.current.constituentHash });
    const frozen = await freezeBreadthUniverse({ db, effectiveDate: '2026-09-28', apply: true });
    await expect(freezeBreadthUniverse({ db, effectiveDate: '2026-09-28', expectedConstituentHash: 'stale', apply: true })).rejects.toThrow('changed since preview');
    expect(await freezeBreadthUniverse({ db, effectiveDate: '2026-09-28', apply: true })).toMatchObject({ applied: false, alreadyExists: true, revisionId: frozen.revisionId });
    expect(await getBreadthUniverseStatus({ db, now: day2 })).toMatchObject({ state: 'CURRENT', latestRevision: { id: frozen.revisionId, effectiveDate: '2026-09-28', memberCount: 1 }, difference: { addedCount: 0, removedCount: 0 } });

    await importSecurityUniverses('symbol,DJIA\nAAPL,1\n', { db, now: day2, apply: true });
    expect(await getBreadthUniverseStatus({ db, now: day2 })).toMatchObject({ state: 'CURRENT', current: { memberCount: 1 }, difference: { addedCount: 0, removedCount: 0 } });
    await importSecurityUniverses('symbol,name,SP600\nMSFT,Microsoft,1\n', { db, now: day2, timing: { kind: 'scheduled', membershipEffectiveDate: '2026-10-19' }, apply: true });
    expect(await getBreadthUniverseStatus({ db, now: day2 })).toMatchObject({ state: 'CURRENT', current: { memberCount: 1 } });

    await importSecurityUniverses('symbol,name,SP600\nIBM,IBM,1\n', { db, now: day2, apply: true });
    expect(await getBreadthUniverseStatus({ db, now: day2 })).toMatchObject({ state: 'REVISION_REQUIRED', current: { memberCount: 2 }, difference: { addedCount: 1, removedCount: 0 } });
    const next = await freezeBreadthUniverse({ db, effectiveDate: '2026-10-02', apply: true });
    expect(await getBreadthUniverseStatus({ db, now: day2 })).toMatchObject({ state: 'CURRENT', latestRevision: { id: next.revisionId, memberCount: 2 } });

    const later = new Date('2026-10-03T16:00:00Z');
    await importSecurityUniverses('symbol,SP500,NASDAQ100,DJIA\nAAPL,0,0,0\n', { db, now: later, apply: true });
    expect(await getBreadthUniverseStatus({ db, now: later })).toMatchObject({ state: 'REVISION_REQUIRED', current: { memberCount: 1 }, difference: { addedCount: 0, removedCount: 1 } });
    await sql.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-10-19',1)`);
    await expect(getBreadthUniverseStatus({ db, now: later })).rejects.toThrow('immutable future revision');
  });
});
