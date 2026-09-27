import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSecurityCatalog, exportUniverseSnapshot, freezeBreadthUniverse, importSecurityUniverses } from '../../services/security-universe-import.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('owned universe import timing on disposable PostgreSQL', () => {
  const database = `universe_timing_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient;
  const earlyUtc = new Date('2026-09-27T02:30:00Z'); // September 26 in New York.
  const todayUtc = new Date('2026-09-27T16:00:00Z');
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    sql = new Client({ connectionString: url.toString() }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    for (const migration of (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
      await sql.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); await sql?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); } });

  it('resolves immediate timing from New York and converges same-day add/remove/add', async () => {
    const add = 'symbol,name,SP500\nAAAA,Alpha,1\n';
    const first = await importSecurityUniverses(add, { db, now: earlyUtc, apply: true });
    expect(first).toMatchObject({ timing: { kind: 'immediate' }, effectiveDate: '2026-09-26', membershipAdditions: [{ symbol: 'AAAA', code: 'SP500' }] });
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'AAAA' } })).enabled).toBe(false);
    const remove = 'symbol,SP500\nAAAA,0\n';
    const removal = await importSecurityUniverses(remove, { db, now: earlyUtc, apply: true });
    expect(removal.membershipDeletions).toHaveLength(1);
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'AAAA' } } })).toBe(0);
    await importSecurityUniverses(add, { db, now: earlyUtc, apply: true });
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'AAAA' }, effectiveTo: null } })).toBe(1);
    expect((await db.securityUniverseMembership.findFirstOrThrow({ where: { security: { symbol: 'AAAA' } } })).effectiveFrom.toISOString().slice(0, 10)).toBe('2026-09-26');
  });

  it('ends an older membership today and can cancel that same-day end', async () => {
    const remove = 'symbol,SP500\nAAAA,0\n';
    const ended = await importSecurityUniverses(remove, { db, now: todayUtc, apply: true });
    expect(ended.membershipRemovals).toHaveLength(1);
    expect((await db.securityUniverseMembership.findFirstOrThrow({ where: { security: { symbol: 'AAAA' } } })).effectiveTo?.toISOString().slice(0, 10)).toBe('2026-09-27');
    const restored = await importSecurityUniverses('symbol,SP500\nAAAA,1\n', { db, now: todayUtc, apply: true });
    expect(restored.membershipReopens).toHaveLength(1);
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'AAAA' } } })).toBe(1);
    expect((await db.securityUniverseMembership.findFirstOrThrow({ where: { security: { symbol: 'AAAA' } } })).effectiveTo).toBeNull();
  });

  it('keeps frozen revisions authoritative over same-day corrections', async () => {
    await freezeBreadthUniverse({ db, effectiveDate: '2026-09-27', apply: true });
    const plan = await importSecurityUniverses('symbol,SP500\nAAAA,0\n', { db, now: todayUtc });
    expect(plan.conflicts).toContain('Membership change at 2026-09-27 would alter an immutable Breadth revision dated 2026-09-27 or later.');
    await expect(importSecurityUniverses('symbol,SP500\nAAAA,0\n', { db, now: todayUtc, apply: true })).rejects.toThrow('immutable Breadth revision');
  });

  it('rejects today/past scheduling and applies metadata and new Security records before future memberships', async () => {
    for (const membershipEffectiveDate of ['2026-09-26', '2026-09-27'])
      await expect(importSecurityUniverses('symbol,SP600\nAAAA,1\n', { db, now: todayUtc, timing: { kind: 'scheduled', membershipEffectiveDate } })).rejects.toThrow('must be after');
    const scheduled = await importSecurityUniverses('symbol,name,sector,SP600\nAAAA,Alpha revised,Technology,0\nBBBB,Beta,Technology,1\n', {
      db, now: todayUtc, timing: { kind: 'scheduled', membershipEffectiveDate: '2026-10-01' }, apply: true,
    });
    expect(scheduled).toMatchObject({ effectiveDate: '2026-10-01', timing: { kind: 'scheduled', membershipEffectiveDate: '2026-10-01' }, membershipAdditions: [{ symbol: 'BBBB', code: 'SP600' }] });
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'AAAA' } })).name).toBe('Alpha revised');
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'AAAA' } })).sector).toBe('Technology');
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'BBBB' } })).enabled).toBe(false);
    expect((await db.security.findUniqueOrThrow({ where: { symbol: 'BBBB' } })).sector).toBe('Technology');
    expect(await db.securityUniverseMembership.count({ where: { security: { symbol: 'BBBB' }, effectiveFrom: new Date('2026-10-01') } })).toBe(1);
    expect(await exportUniverseSnapshot(db, todayUtc)).not.toContain('BBBB');
    expect(await exportUniverseSnapshot(db, new Date('2026-10-02T16:00:00Z'))).toContain('BBBB');
    expect(await exportSecurityCatalog(db)).toContain(',BBBB,');
  });
});
