import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSV_COLUMNS, SOURCE_UNIVERSES, constituentHash, freezeBreadthUniverse, importSecurityUniverses } from '../../services/security-universe-import.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('owned Security universe PostgreSQL workflow', () => {
  const name = `owned_universe_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient;
  const csv = (rows: string[]) => `${CSV_COLUMNS.join(',')}\n${rows.join('\n')}\n`;
  const initial = csv([
    'AAPL,Apple Inc,Technology,Hardware,1,1,0,0,0,0',
    'MSFT,Microsoft Corp,Technology,Software,1,1,0,0,0,0',
    'IBM,IBM,Technology,Services,0,0,1,0,0,0',
  ]);
  const quarterly = csv([
    'AAPL,Apple Inc,Technology,Hardware,1,0,0,0,0,0',
    'IBM,IBM,Technology,Services,0,0,1,0,0,0',
    'GOOG,Alphabet Inc,Communication,Internet,0,1,0,0,0,0',
  ]);
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; url.searchParams.delete('schema');
    sql = new Client({ connectionString: url.toString() }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    for (const migration of (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort())
      await sql.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    await db.security.create({ data: { symbol: 'AAPL', name: 'Old Apple Name', assetType: 'STOCK', enabled: true } });
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); await sql?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); } });
  async function tradingCounts() {
    const tables = ['Subscription', 'Strategy', 'TradingAccountSubscription', 'TradingAccountAllocation', 'OrderIntent', 'TrackedPosition'];
    const counts: number[] = [];
    for (const table of tables) counts.push((await sql.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n as number);
    return counts;
  }
  it('previews full snapshot and applies with disabled new Securities, preserving trading controls', async () => {
    const before = await tradingCounts();
    const preview = await importSecurityUniverses(initial, { db, effectiveDate: '2026-01-01' });
    expect(preview).toMatchObject({ applied: false, broadMemberCount: 3, unchangedMemberships: 0, conflicts: [] });
    expect(preview.newSecurities.map(s => s.symbol)).toEqual(['IBM', 'MSFT']);
    expect(preview.existingSecurities).toEqual(['AAPL']);
    expect(preview.metadataChanges.map(s => s.symbol)).toEqual(['AAPL']);
    expect(preview.membershipAdditions).toHaveLength(5);
    expect(preview.missingUniverses).toHaveLength(6);
    expect(await db.securityUniverse.count()).toBe(0);
    await importSecurityUniverses(initial, { db, effectiveDate: '2026-01-01', apply: true });
    expect((await db.securityUniverse.findMany({ orderBy: { id: 'asc' } })).map(u => u.code)).toEqual(SOURCE_UNIVERSES.map(u => u.code));
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'AAPL' } })).enabled).toBe(true);
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'MSFT' } })).enabled).toBe(false);
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'IBM' } })).enabled).toBe(false);
    expect(await tradingCounts()).toEqual(before);
    const retry = await importSecurityUniverses(initial, { db, effectiveDate: '2026-01-01', apply: true });
    expect(retry).toMatchObject({ newSecurities: [], metadataChanges: [], membershipAdditions: [], membershipRemovals: [], unchangedMemberships: 5 });
  });
  it('freezes one vote per Security with deterministic hash and immutable member rows', async () => {
    const preview = await freezeBreadthUniverse({ db, effectiveDate: '2026-01-01' });
    expect(preview).toMatchObject({ applied: false, alreadyExists: false, memberCount: 3, constituentHash: constituentHash(['AAPL', 'IBM', 'MSFT']) });
    const created = await freezeBreadthUniverse({ db, effectiveDate: '2026-01-01', apply: true });
    expect(created).toMatchObject({ applied: true, memberCount: 3 });
    expect(await db.breadthUniverseRevisionMember.count({ where: { revisionId: created.revisionId! } })).toBe(3);
    expect(await freezeBreadthUniverse({ db, effectiveDate: '2026-01-01', apply: true })).toMatchObject({ applied: false, alreadyExists: true, revisionId: created.revisionId });
    await expect(db.breadthUniverseRevision.update({ where: { id: created.revisionId! }, data: { memberCount: 4 } })).rejects.toThrow('immutable');
    await expect(db.breadthUniverseRevisionMember.deleteMany({ where: { revisionId: created.revisionId! } })).rejects.toThrow('immutable');
  });
  it('end-dates removals without altering historical membership or the frozen revision', async () => {
    const before = await tradingCounts();
    const preview = await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-04-01' });
    expect(preview).toMatchObject({ broadMemberCount: 3, unchangedMemberships: 2, conflicts: [] });
    expect(preview.membershipAdditions).toEqual([{ symbol: 'GOOG', code: 'NASDAQ100' }]);
    expect(preview.membershipRemovals).toHaveLength(3);
    await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-04-01', apply: true });
    const old = await db.securityUniverseMembership.findMany({ where: { security: { symbol: 'MSFT' } } });
    expect(old).toHaveLength(2);
    expect(old.every(row => row.effectiveFrom.toISOString().slice(0, 10) === '2026-01-01' && row.effectiveTo?.toISOString().slice(0, 10) === '2026-04-01')).toBe(true);
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'GOOG' } })).enabled).toBe(false);
    expect(await freezeBreadthUniverse({ db, effectiveDate: '2026-01-01' })).toMatchObject({ alreadyExists: true, memberCount: 3 });
    expect(await freezeBreadthUniverse({ db, effectiveDate: '2026-04-01', apply: true })).toMatchObject({ memberCount: 3, constituentHash: constituentHash(['AAPL', 'GOOG', 'IBM']) });
    expect(await tradingCounts()).toEqual(before);
    expect(await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-04-01', apply: true })).toMatchObject({ membershipAdditions: [], membershipRemovals: [] });
  });
  it('refuses retroactive membership changes and conflicting revisions', async () => {
    const oldSnapshot = csv(['AAPL,Apple Inc,Technology,Hardware,1,0,0,0,0,0']);
    const preview = await importSecurityUniverses(oldSnapshot, { db, effectiveDate: '2026-01-01' });
    expect(preview.conflicts.length).toBeGreaterThan(0);
    await expect(importSecurityUniverses(oldSnapshot, { db, effectiveDate: '2026-01-01', apply: true })).rejects.toThrow('refused');
    await sql.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-07-01',1)`);
    await expect(freezeBreadthUniverse({ db, effectiveDate: '2026-07-01' })).rejects.toThrow('Conflicting immutable');
  });
  it('refuses a source code with a changed display name', async () => {
    await db.securityUniverse.update({ where: { code: 'SP500' }, data: { name: 'Renamed index' } });
    const preview = await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-10-01' });
    expect(preview.conflicts).toContain('Universe SP500 has conflicting display name Renamed index.');
    await expect(importSecurityUniverses(quarterly, { db, effectiveDate: '2026-10-01', apply: true })).rejects.toThrow('refused');
  });
});
