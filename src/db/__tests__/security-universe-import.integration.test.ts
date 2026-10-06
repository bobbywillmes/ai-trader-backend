import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSV_COLUMNS, SOURCE_UNIVERSES, constituentHash, exportSecurityCatalog, exportUniverseSnapshot, freezeBreadthUniverse, importSecurityUniverses as runImport, parseUniverseCsv } from '../../services/security-universe-import.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('owned Security universe PostgreSQL workflow', () => {
  const name = `owned_universe_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient;
  const importSecurityUniverses = (file: string, options: { db: PrismaClient; effectiveDate: string; apply?: boolean }) => {
    const { effectiveDate, ...rest } = options;
    return runImport(file, { ...rest, now: new Date(`${effectiveDate}T16:00:00Z`) });
  };
  const csv = (rows: string[]) => `${CSV_COLUMNS.join(',')}\n${rows.join('\n')}\n`;
  const initial = csv([
    'AAPL,Apple Inc,Technology,Hardware,1,1,0,0,0,0',
    'MSFT,Microsoft Corp,Technology,Software,1,1,0,0,0,0',
    'IBM,IBM,Technology,Services,0,0,1,0,0,0',
  ]);
  const quarterly = csv([
    'AAPL,Apple Inc,Technology,Hardware,1,0,0,0,0,0',
    'MSFT,Microsoft Corp,Technology,Software,0,0,0,0,0,0',
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
  it('previews and applies supplied rows with disabled new Securities, preserving trading controls', async () => {
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
  it('exports sorted round-trip universe CSV and scalar-only catalog CSV', async () => {
    const snapshot = await exportUniverseSnapshot(db);
    const parsed = parseUniverseCsv(snapshot);
    expect(parsed.columns).toEqual([...CSV_COLUMNS]);
    expect(parsed.rows.map(row => row.symbol)).toEqual(['AAPL', 'IBM', 'MSFT']);
    expect(parsed.rows[0]?.flags.SP500).toBe('1');
    const catalog = await exportSecurityCatalog(db);
    expect(catalog.split('\r\n')[0]).toBe('id,symbol,name,enabled,assetType,sector,industry,createdAt,updatedAt');
    expect(catalog).toContain(',SNOW,');
    expect(catalog).toContain(',SOFI,');
    expect(catalog).not.toContain('subscription');
  });
  it('applies sparse rows and leaves omitted rows, metadata and columns untouched', async () => {
    const partial = 'SP600,symbol,industry\n1,AAPL,Consumer Hardware\n,IBM,\n';
    const preview = await importSecurityUniverses(partial, { db, effectiveDate: '2026-03-01' });
    expect(preview).toMatchObject({ inputSecurityCount: 2, membershipAdditions: [{ symbol: 'AAPL', code: 'SP600' }], membershipRemovals: [], resultingBroadMemberCount: 3 });
    await importSecurityUniverses(partial, { db, effectiveDate: '2026-03-01', apply: true });
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'AAPL' } })).industry).toBe('Consumer Hardware');
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'IBM' } })).industry).toBe('Services');
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'MSFT' }, effectiveTo: null } })).toBe(2);
    expect(await importSecurityUniverses(partial, { db, effectiveDate: '2026-03-01', apply: true })).toMatchObject({ metadataChanges: [], membershipAdditions: [], membershipRemovals: [] });
    const removal = await importSecurityUniverses('symbol,SP600\nAAPL,0\n', { db, effectiveDate: '2026-03-05' });
    expect(removal.membershipRemovals).toHaveLength(1);
    await importSecurityUniverses('symbol,SP600\nAAPL,0\n', { db, effectiveDate: '2026-03-05', apply: true });
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'AAPL' }, universe: { code: 'SP600' }, effectiveTo: { not: null } } })).toBe(1);
    await importSecurityUniverses('symbol,SP600\nAAPL,1\n', { db, effectiveDate: '2026-03-07', apply: true });
    const symbolOnly = await importSecurityUniverses('symbol\nIBM\n', { db, effectiveDate: '2026-03-02' });
    expect(symbolOnly).toMatchObject({ metadataChanges: [], membershipAdditions: [], membershipRemovals: [] });
    expect((await importSecurityUniverses('symbol,name,SP600\nNEW,,1\n', { db, effectiveDate: '2026-03-02' })).conflicts).toHaveLength(1);
  });
  it('never removes an omitted SP600 Security; explicit 0 removes only that Security', async () => {
    await importSecurityUniverses('symbol,name,SP600\nAAP,AAP,1\nAAT,AAT,1\n', { db, effectiveDate: '2026-03-10', apply: true });
    const oneRow = 'symbol,SP600\nAAP,1\n';
    const plan = await importSecurityUniverses(oneRow, { db, effectiveDate: '2026-03-15' });
    expect(plan.membershipRemovals).toEqual([]);
    expect(plan.unchangedMembershipValues).toContainEqual({ symbol: 'AAP', code: 'SP600', value: '1' });
    await importSecurityUniverses(oneRow, { db, effectiveDate: '2026-03-15', apply: true });
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'AAT' }, universe: { code: 'SP600' }, effectiveTo: null } })).toBe(1);
    expect((await importSecurityUniverses('symbol,SP600\nAAP,\n', { db, effectiveDate: '2026-03-15' })).membershipRemovals).toEqual([]);
    const removal = await importSecurityUniverses('symbol,SP600\nAAT,0\n', { db, effectiveDate: '2026-03-15' });
    expect(removal.membershipRemovals).toEqual([{ symbol: 'AAT', code: 'SP600', membershipId: expect.any(Number) }]);
    await importSecurityUniverses('symbol,SP600\nAAT,0\n', { db, effectiveDate: '2026-03-15', apply: true });
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'AAT' }, universe: { code: 'SP600' }, effectiveTo: null } })).toBe(0);
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'AAP' }, universe: { code: 'SP600' }, effectiveTo: null } })).toBe(1);
    expect((await importSecurityUniverses('symbol,SP600\nAAT,0\n', { db, effectiveDate: '2026-03-15', apply: true })).membershipRemovals).toEqual([]);
  });
  it('end-dates removals without altering historical membership or the frozen revision', async () => {
    const before = await tradingCounts();
    const preview = await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-04-01' });
    expect(preview).toMatchObject({ broadMemberCount: 4, unchangedMemberships: 2, conflicts: [] });
    expect(preview.membershipAdditions).toEqual([{ symbol: 'GOOG', code: 'NASDAQ100' }]);
    expect(preview.membershipRemovals).toHaveLength(4);
    await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-04-01', apply: true });
    const old = await db.securityUniverseMembership.findMany({ where: { security: { symbol: 'MSFT' } } });
    expect(old).toHaveLength(2);
    expect(old.every(row => row.effectiveFrom.toISOString().slice(0, 10) === '2026-01-01' && row.effectiveTo?.toISOString().slice(0, 10) === '2026-04-01')).toBe(true);
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'GOOG' } })).enabled).toBe(false);
    expect(await freezeBreadthUniverse({ db, effectiveDate: '2026-01-01' })).toMatchObject({ alreadyExists: true, memberCount: 3 });
    expect(await freezeBreadthUniverse({ db, effectiveDate: '2026-04-01', apply: true })).toMatchObject({ memberCount: 4, constituentHash: constituentHash(['AAP', 'AAPL', 'GOOG', 'IBM']) });
    expect(await tradingCounts()).toEqual(before);
    expect(await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-04-01', apply: true })).toMatchObject({ membershipAdditions: [], membershipRemovals: [] });
  });
  it('refuses retroactive membership changes and conflicting revisions', async () => {
    const retroactiveChange = csv(['AAPL,Apple Inc,Technology,Hardware,1,0,0,0,0,0']);
    const preview = await importSecurityUniverses(retroactiveChange, { db, effectiveDate: '2026-01-01' });
    expect(preview.conflicts.length).toBeGreaterThan(0);
    await expect(importSecurityUniverses(retroactiveChange, { db, effectiveDate: '2026-01-01', apply: true })).rejects.toThrow('refused');
    await sql.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-07-01',1)`);
    await expect(freezeBreadthUniverse({ db, effectiveDate: '2026-07-01' })).rejects.toThrow('Conflicting immutable');
  });
  it('refuses non-STOCK members when freezing an observation revision', async () => {
    const etf = await db.security.create({ data: { symbol: 'TESTETF', name: 'Test ETF', assetType: 'ETF', enabled: false } });
    const universe = await db.securityUniverse.findUniqueOrThrow({ where: { code: 'SP500' } });
    const membership = await db.securityUniverseMembership.create({ data: { securityId: etf.id, universeId: universe.id, effectiveFrom: new Date('2026-06-01') } });
    await expect(freezeBreadthUniverse({ db, effectiveDate: '2026-06-01' })).rejects.toThrow('requires STOCK securities');
    await db.securityUniverseMembership.delete({ where: { id: membership.id } });
  });
  it('refuses a source code with a changed display name', async () => {
    await db.securityUniverse.update({ where: { code: 'SP500' }, data: { name: 'Renamed index' } });
    const preview = await importSecurityUniverses(quarterly, { db, effectiveDate: '2026-10-01' });
    expect(preview.conflicts).toContain('Universe SP500 has conflicting display name Renamed index.');
    await expect(importSecurityUniverses(quarterly, { db, effectiveDate: '2026-10-01', apply: true })).rejects.toThrow('refused');
  });
});
