import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { validDate } from './market-calendar.js';

export const SOURCE_UNIVERSES = [
  { code: 'SP500', name: 'S&P 500' },
  { code: 'NASDAQ100', name: 'Nasdaq-100' },
  { code: 'DJIA', name: 'Dow Jones Industrial Average' },
  { code: 'RUSSELL2000', name: 'Russell 2000' },
  { code: 'SP400', name: 'S&P MidCap 400' },
  { code: 'SP600', name: 'S&P SmallCap 600' },
] as const;
export type UniverseCode = typeof SOURCE_UNIVERSES[number]['code'];
export const CSV_COLUMNS = ['symbol', 'name', 'sector', 'industry', ...SOURCE_UNIVERSES.map(u => u.code)] as const;
const LOCK_KEY = createHash('sha256').update('ai-trader:owned-security-universe').digest().readBigInt64BE(0);
type Db = PrismaClient | Prisma.TransactionClient;
type Row = { symbol: string; name: string; sector: string | null; industry: string | null; codes: UniverseCode[] };
type Plan = { effectiveDate: string; newSecurities: Row[]; existingSecurities: string[];
  metadataChanges: { symbol: string; before: { name: string; sector: string | null; industry: string | null }; after: { name: string; sector: string | null; industry: string | null } }[];
  membershipAdditions: { symbol: string; code: UniverseCode }[];
  membershipRemovals: { symbol: string; code: UniverseCode; membershipId: number }[];
  unchangedMemberships: number; broadMemberCount: number; conflicts: string[]; missingUniverses: UniverseCode[] };

function parseCsvRecords(csv: string): string[][] {
  const result: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let closed = false;
  const source = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error(`Malformed CSV quote at character ${i}.`);
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && source[i + 1] === '\n') i++;
        result.push(row); row = [];
      }
    } else {
      if (closed) throw new Error(`Unexpected text after CSV quote at character ${i}.`);
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated CSV quote.');
  if (field || closed || row.length) { row.push(field); result.push(row); }
  return result.filter(fields => fields.length !== 1 || fields[0]!.trim() !== '');
}

export function parseUniverseCsv(csv: string): Row[] {
  const records = parseCsvRecords(csv);
  if (!records.length || records[0]!.length !== CSV_COLUMNS.length || records[0]!.some((value, i) => value !== CSV_COLUMNS[i]))
    throw new Error(`CSV header must be exactly: ${CSV_COLUMNS.join(',')}`);
  const seen = new Set<string>(); const rows: Row[] = [];
  for (const [index, fields] of records.slice(1).entries()) {
    const line = index + 2;
    if (fields.length !== CSV_COLUMNS.length) throw new Error(`CSV row ${line} has ${fields.length} fields; expected ${CSV_COLUMNS.length}.`);
    const symbol = fields[0]!.trim().toUpperCase(), name = fields[1]!.trim();
    if (!symbol || symbol.length > 32 || /[\s,]/.test(symbol) || !name || name.length > 240) throw new Error(`Invalid symbol/name on CSV row ${line}.`);
    if (seen.has(symbol)) throw new Error(`Duplicate CSV symbol ${symbol} on row ${line}.`);
    seen.add(symbol);
    const sector = fields[2]!.trim() || null, industry = fields[3]!.trim() || null;
    if ((sector?.length ?? 0) > 160 || (industry?.length ?? 0) > 160) throw new Error(`Invalid metadata length on CSV row ${line}.`);
    const codes: UniverseCode[] = [];
    SOURCE_UNIVERSES.forEach((universe, i) => {
      const flag = fields[4 + i]!.trim();
      if (flag !== '0' && flag !== '1') throw new Error(`Invalid ${universe.code} flag on CSV row ${line}; use 0 or 1.`);
      if (flag === '1') codes.push(universe.code);
    });
    if (!codes.length) throw new Error(`CSV row ${line} belongs to no source universe; omit removals from a complete snapshot.`);
    rows.push({ symbol, name, sector, industry, codes });
  }
  if (!rows.length) throw new Error('CSV contains no constituent rows.');
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const dateOf = (date: Date) => date.toISOString().slice(0, 10);
const key = (symbol: string, code: string) => `${symbol}\u0000${code}`;

async function planImport(db: Db, rows: Row[], effectiveDate: string): Promise<Plan> {
  if (!validDate(effectiveDate)) throw new Error('An explicit valid --effective=YYYY-MM-DD date is required.');
  const at = new Date(effectiveDate);
  const [securities, universes, memberships, laterRevisions] = await Promise.all([
    db.security.findMany({ select: { id: true, symbol: true, name: true, sector: true, industry: true, assetType: true, enabled: true } }),
    db.securityUniverse.findMany({ where: { code: { in: SOURCE_UNIVERSES.map(u => u.code) } } }),
    db.securityUniverseMembership.findMany({ where: { universe: { code: { in: SOURCE_UNIVERSES.map(u => u.code) } } }, include: { universe: true, security: { select: { symbol: true } } } }),
    db.breadthUniverseRevision.findFirst({ where: { effectiveFrom: { gte: at } }, orderBy: { effectiveFrom: 'asc' }, select: { effectiveFrom: true } }),
  ]);
  const conflicts: string[] = [];
  const requestedSymbols = new Set(rows.map(row => row.symbol));
  const bySymbol = new Map<string, typeof securities[number]>();
  for (const security of securities) {
    const normalized = security.symbol.trim().toUpperCase();
    if (!requestedSymbols.has(normalized)) continue;
    if (bySymbol.has(normalized) || security.symbol !== normalized) conflicts.push(`Ambiguous existing Security identity ${security.symbol}.`);
    bySymbol.set(normalized, security);
  }
  const missingUniverses: UniverseCode[] = [];
  for (const expected of SOURCE_UNIVERSES) {
    const found = universes.find(universe => universe.code === expected.code);
    if (!found) missingUniverses.push(expected.code);
    else if (found.name !== expected.name) conflicts.push(`Universe ${expected.code} has conflicting display name ${found.name}.`);
  }
  const newSecurities: Row[] = [], existingSecurities: string[] = [], metadataChanges: Plan['metadataChanges'] = [];
  for (const row of rows) {
    const existing = bySymbol.get(row.symbol);
    if (!existing) newSecurities.push(row);
    else {
      existingSecurities.push(row.symbol);
      if (existing.assetType !== 'STOCK') conflicts.push(`${row.symbol} exists as ${existing.assetType}, not STOCK.`);
      const before = { name: existing.name, sector: existing.sector, industry: existing.industry };
      const after = { name: row.name, sector: row.sector, industry: row.industry };
      if (JSON.stringify(before) !== JSON.stringify(after)) metadataChanges.push({ symbol: row.symbol, before, after });
    }
  }
  const active = new Map<string, typeof memberships[number]>();
  for (const membership of memberships) {
    if (membership.security.symbol !== membership.security.symbol.trim().toUpperCase()) conflicts.push(`Ambiguous membership Security identity ${membership.security.symbol}.`);
    const from = dateOf(membership.effectiveFrom), to = membership.effectiveTo ? dateOf(membership.effectiveTo) : null;
    if (from > effectiveDate) { conflicts.push(`Future membership exists for ${membership.security.symbol}/${membership.universe.code}.`); continue; }
    if (from <= effectiveDate && (!to || effectiveDate < to)) active.set(key(membership.security.symbol, membership.universe.code), membership);
  }
  const desired = new Set(rows.flatMap(row => row.codes.map(code => key(row.symbol, code))));
  const membershipAdditions: Plan['membershipAdditions'] = [], membershipRemovals: Plan['membershipRemovals'] = [];
  for (const row of rows) for (const code of row.codes) if (!active.has(key(row.symbol, code))) membershipAdditions.push({ symbol: row.symbol, code });
  for (const [identity, membership] of active) if (!desired.has(identity)) {
    if (dateOf(membership.effectiveFrom) === effectiveDate) conflicts.push(`Cannot end same-day membership ${membership.security.symbol}/${membership.universe.code}.`);
    else if (membership.effectiveTo) conflicts.push(`Cannot override scheduled membership end for ${membership.security.symbol}/${membership.universe.code}.`);
    else membershipRemovals.push({ symbol: membership.security.symbol, code: membership.universe.code as UniverseCode, membershipId: membership.id });
  }
  if (laterRevisions && (membershipAdditions.length || membershipRemovals.length)) conflicts.push(`Membership change at ${effectiveDate} would alter an immutable Breadth revision dated ${dateOf(laterRevisions.effectiveFrom)} or later.`);
  return { effectiveDate, newSecurities, existingSecurities, metadataChanges, membershipAdditions, membershipRemovals,
    unchangedMemberships: [...desired].filter(identity => active.has(identity)).length, broadMemberCount: rows.length, conflicts, missingUniverses };
}

export async function importSecurityUniverses(csv: string, options: { effectiveDate: string; apply?: boolean; db?: PrismaClient }) {
  const rows = parseUniverseCsv(csv), db = options.db ?? prisma;
  return db.$transaction(async tx => {
    const lock = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS acquired`;
    if (!lock[0]?.acquired) throw new Error('Owned universe operation already running.');
    const plan = await planImport(tx, rows, options.effectiveDate);
    if (options.apply && plan.conflicts.length) throw new Error(`Universe import refused: ${plan.conflicts.join(' ')}`);
    if (!options.apply) return { applied: false, ...plan };
    for (const identity of SOURCE_UNIVERSES) await tx.securityUniverse.upsert({ where: { code: identity.code }, update: {}, create: identity });
    for (let i = 0; i < plan.newSecurities.length; i += 500) {
      const batch = plan.newSecurities.slice(i, i + 500);
      const result = await tx.security.createMany({ data: batch.map(row => ({ symbol: row.symbol, name: row.name, sector: row.sector, industry: row.industry, assetType: 'STOCK', enabled: false })) });
      if (result.count !== batch.length) throw new Error('New Security count mismatch.');
    }
    for (const change of plan.metadataChanges) await tx.security.update({ where: { symbol: change.symbol }, data: change.after });
    const allSecurities = await tx.security.findMany({ where: { symbol: { in: rows.map(row => row.symbol) } }, select: { id: true, symbol: true } });
    const universes = await tx.securityUniverse.findMany({ where: { code: { in: SOURCE_UNIVERSES.map(u => u.code) } } });
    const securityIds = new Map(allSecurities.map(security => [security.symbol, security.id]));
    const universeIds = new Map(universes.map(universe => [universe.code, universe.id]));
    const additions = plan.membershipAdditions.map(addition => {
      const securityId = securityIds.get(addition.symbol), universeId = universeIds.get(addition.code);
      if (!securityId || !universeId) throw new Error('Import identity disappeared during transaction.');
      return { securityId, universeId, effectiveFrom: new Date(options.effectiveDate) };
    });
    for (let i = 0; i < additions.length; i += 500) {
      const batch = additions.slice(i, i + 500);
      const result = await tx.securityUniverseMembership.createMany({ data: batch });
      if (result.count !== batch.length) throw new Error('Membership addition count mismatch.');
    }
    for (let i = 0; i < plan.membershipRemovals.length; i += 500) {
      const batch = plan.membershipRemovals.slice(i, i + 500);
      const result = await tx.securityUniverseMembership.updateMany({ where: { id: { in: batch.map(removal => removal.membershipId) } }, data: { effectiveTo: new Date(options.effectiveDate) } });
      if (result.count !== batch.length) throw new Error('Membership removal count mismatch.');
    }
    return { applied: true, ...plan };
  }, { timeout: 300_000 });
}

export function constituentHash(symbols: readonly string[]) {
  return createHash('sha256').update([...symbols].sort().join('\n') + '\n').digest('hex');
}

export async function freezeBreadthUniverse(options: { effectiveDate: string; apply?: boolean; db?: PrismaClient }) {
  if (!validDate(options.effectiveDate)) throw new Error('An explicit valid --effective=YYYY-MM-DD date is required.');
  const db = options.db ?? prisma, at = new Date(options.effectiveDate);
  return db.$transaction(async tx => {
    const lock = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS acquired`;
    if (!lock[0]?.acquired) throw new Error('Owned universe operation already running.');
    const universes = await tx.securityUniverse.findMany({ where: { code: { in: SOURCE_UNIVERSES.map(u => u.code) } } });
    for (const expected of SOURCE_UNIVERSES) if (universes.find(u => u.code === expected.code)?.name !== expected.name) throw new Error(`Missing or conflicting source universe ${expected.code}.`);
    const memberships = await tx.securityUniverseMembership.findMany({ where: { universeId: { in: universes.map(u => u.id) }, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }, select: { securityId: true } });
    const ids = [...new Set(memberships.map(m => m.securityId))].sort((a, b) => a - b);
    if (!ids.length) throw new Error('Cannot freeze an empty Breadth universe.');
    const securities = await tx.security.findMany({ where: { id: { in: ids } }, select: { id: true, symbol: true } });
    if (securities.length !== ids.length || new Set(securities.map(s => s.symbol)).size !== ids.length) throw new Error('Breadth revision members are missing or ambiguous.');
    const symbols = securities.map(s => s.symbol).sort();
    const hash = constituentHash(symbols);
    const existing = await tx.breadthUniverseRevision.findUnique({ where: { effectiveFrom: at }, include: { members: true } });
    if (existing) {
      const same = existing.memberCount === ids.length && existing.members.length === ids.length && existing.members.every(member => ids.includes(member.securityId));
      if (!same) throw new Error(`Conflicting immutable Breadth revision for ${options.effectiveDate}.`);
      return { applied: false, alreadyExists: true, revisionId: existing.id, effectiveDate: options.effectiveDate, memberCount: ids.length, constituentHash: hash };
    }
    if (!options.apply) return { applied: false, alreadyExists: false, revisionId: null, effectiveDate: options.effectiveDate, memberCount: ids.length, constituentHash: hash };
    const revision = await tx.breadthUniverseRevision.create({ data: { effectiveFrom: at, memberCount: ids.length } });
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const result = await tx.breadthUniverseRevisionMember.createMany({ data: batch.map(securityId => ({ revisionId: revision.id, securityId })) });
      if (result.count !== batch.length) throw new Error('Breadth revision member insertion mismatch.');
    }
    const persisted = await tx.breadthUniverseRevisionMember.count({ where: { revisionId: revision.id } });
    if (persisted !== ids.length) throw new Error('Persisted Breadth member count mismatch.');
    return { applied: true, alreadyExists: false, revisionId: revision.id, effectiveDate: options.effectiveDate, memberCount: ids.length, constituentHash: hash };
  }, { timeout: 120_000 });
}
