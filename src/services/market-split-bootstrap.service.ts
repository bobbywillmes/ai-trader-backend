import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { fetchStrictSplitEvidence, type SplitEvent } from '../integrations/massive/evidence.client.js';
import { etDate, validDate } from './market-calendar.js';
import { MARKET_DAILY_EVIDENCE_SYMBOLS, type DailyEvidenceSymbol } from './market-daily-evidence.definition.js';
import { dailyAuthoritySegments, dailySessionEligible, marketDailyAuthority } from './market-daily-authority.js';
import { calendarExceptions } from './market-calendar.service.js';
import { addDays, datesBetween, marketSession } from './market-calendar.js';

const LOCK_KEY = createHash('sha256').update('ai-trader:market-split-bootstrap').digest().readBigInt64BE(0);
type Db = PrismaClient;
type FetchSplits = typeof fetchStrictSplitEvidence;
type Candidate = { securityId: number; symbol: DailyEvidenceSymbol; from: string; through: string; events: { executionDate: string; splitFactor: string; provenance: string }[] };
const day = (value: Date) => value.toISOString().slice(0, 10);

export function canonicalFactor(split: SplitEvent): string {
  if (!Number.isFinite(split.splitFrom) || !Number.isFinite(split.splitTo) || split.splitFrom <= 0 || split.splitTo <= 0 ||
      !Number.isFinite(split.priceFactor) || Math.abs(split.priceFactor - split.splitFrom / split.splitTo) > 1e-12 || split.splitFrom === split.splitTo)
    throw new Error('Invalid Massive split ratio.');
  const exact = new Prisma.Decimal(split.splitTo).div(split.splitFrom);
  const stored = exact.toDecimalPlaces(10);
  if (!stored.isFinite() || stored.lte(0) || stored.eq(1) || stored.gte(new Prisma.Decimal(10).pow(14)) ||
      exact.minus(stored).abs().div(exact).gt('0.000000001')) throw new Error('Split factor cannot be represented safely.');
  return stored.toFixed(10);
}

export async function planMarketSplitBootstrap(db: Db, through: string, fetchSplits: FetchSplits = fetchStrictSplitEvidence): Promise<Candidate[]> {
  if (!validDate(through) || through > etDate(new Date())) throw new Error('Invalid bootstrap through date.');
  const candidates: Candidate[] = [];
  for (const symbol of MARKET_DAILY_EVIDENCE_SYMBOLS) {
    const security = await db.security.findUnique({ where: { symbol }, select: { id: true } });
    if (!security) throw new Error(`Missing daily evidence Security ${symbol}.`);
    const first = await db.marketBar.findFirst({ where: { securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' }, orderBy: { barStartAt: 'asc' }, select: { barStartAt: true } });
    const latest = await db.marketBar.findFirst({ where: { securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' }, orderBy: { barStartAt: 'desc' }, select: { barStartAt: true } });
    if (!first || !latest) throw new Error(`Missing or uncovered daily evidence for ${symbol}.`);
    const from = etDate(first.barStartAt);
    for (const segment of dailyAuthoritySegments(from, through).filter(item => item.provider === 'MASSIVE')) {
      const events = await fetchSplits(symbol, segment.from, segment.through);
      const dates = new Set<string>(), ids = new Set<string>();
      const normalized = events.map(event => {
        if (event.symbol !== symbol || !event.id.trim() || ids.has(event.id) || !validDate(event.executionDate) || event.executionDate < segment.from || event.executionDate > segment.through || dates.has(event.executionDate))
          throw new Error(`Invalid or duplicate ${symbol} split identity.`);
        ids.add(event.id); dates.add(event.executionDate);
        const provenance = `MASSIVE:${event.id}`;
        if (provenance.length > 240) throw new Error(`Invalid ${symbol} split provenance length.`);
        return { executionDate: event.executionDate, splitFactor: canonicalFactor(event), provenance };
      }).sort((a, b) => a.executionDate.localeCompare(b.executionDate));
      candidates.push({ securityId: security.id, symbol, from: segment.from, through: segment.through, events: normalized });
    }
  }
  return candidates;
}

export async function planAutomaticMarketSplitExtension(db: Db, now: Date, fetchSplits: FetchSplits = fetchStrictSplitEvidence): Promise<Candidate[] | null> {
  const today = etDate(now);
  const exceptions = await calendarExceptions(addDays(today, -14), today, db);
  const target = datesBetween(addDays(today, -14), today).reverse()
    .find(date => marketSession(date, exceptions) && marketDailyAuthority(date).provider === 'MASSIVE' && dailySessionEligible(date, now, exceptions));
  if (!target || marketDailyAuthority(today).provider !== 'MASSIVE') return null;
  const candidates: Candidate[] = [];
  const targetAuthority = marketDailyAuthority(target);
  const activeStart = targetAuthority.massiveResumeSession && target >= targetAuthority.massiveResumeSession
    ? targetAuthority.massiveResumeSession : '1900-01-01';
  for (const symbol of MARKET_DAILY_EVIDENCE_SYMBOLS) {
    const security = await db.security.findUnique({ where: { symbol }, select: { id: true } });
    if (!security) throw new Error(`Missing daily evidence Security ${symbol}.`);
    const targetBar = await db.marketBar.findFirst({ where: { securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', barStartAt: { gte: new Date(`${target}T00:00:00Z`), lt: new Date(`${addDays(target, 1)}T00:00:00Z`) } } });
    if (!targetBar) throw new Error(`Massive DAY_1 evidence is not yet available for ${symbol} ${target}.`);
    const first = await db.marketBar.findFirst({ where: { securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', ...(activeStart === '1900-01-01' ? {} : { barStartAt: { gte: new Date(`${activeStart}T00:00:00Z`) } }) }, orderBy: { barStartAt: 'asc' }, select: { barStartAt: true } });
    if (!first) throw new Error(`Missing Massive segment evidence for ${symbol}.`);
    const segmentFrom = activeStart === '1900-01-01' ? etDate(first.barStartAt) : activeStart;
    const coverage = await db.marketSplitCoverage.findMany({ where: { securityId: security.id, provider: 'MASSIVE', fromDate: { lte: new Date(target) }, throughDate: { gte: new Date(segmentFrom) } }, orderBy: [{ fromDate: 'asc' }, { throughDate: 'asc' }] });
    let from = segmentFrom;
    for (const row of coverage) {
      const start = day(row.fromDate), end = day(row.throughDate);
      if (start > from) break;
      if (end >= from) from = addDays(end, 1);
    }
    if (from > target) continue;
    const events = await fetchSplits(symbol, from, target);
    const dates = new Set<string>(), ids = new Set<string>();
    const normalized = events.map(event => {
      if (event.symbol !== symbol || !event.id.trim() || ids.has(event.id) || !validDate(event.executionDate) || event.executionDate < from || event.executionDate > target || dates.has(event.executionDate)) throw new Error(`Invalid or duplicate ${symbol} split identity.`);
      ids.add(event.id); dates.add(event.executionDate);
      const provenance = `MASSIVE:${event.id}`;
      if (provenance.length > 240) throw new Error(`Invalid ${symbol} split provenance length.`);
      return { executionDate: event.executionDate, splitFactor: canonicalFactor(event), provenance };
    });
    candidates.push({ securityId: security.id, symbol, from, through: target, events: normalized });
  }
  return candidates;
}

export async function bootstrapMarketSplits(options: { apply?: boolean; through?: string; db?: Db; fetchSplits?: FetchSplits; now?: Date } = {}) {
  const db = options.db ?? prisma;
  const through = options.through ?? etDate(options.now ?? new Date());
  const candidates = await planMarketSplitBootstrap(db, through, options.fetchSplits);
  return applyCandidates(db, candidates, !!options.apply, options.now ?? new Date());
}

async function applyCandidates(db: Db, candidates: Candidate[], apply: boolean, receivedAt: Date) {
  return db.$transaction(async tx => {
    const locks = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS acquired`;
    if (!locks[0]?.acquired) throw new Error('Market split bootstrap already running.');
    const report = [];
    for (const item of candidates) {
      const existing = await tx.marketSplitEvent.findMany({ where: { securityId: item.securityId, executionDate: { gte: new Date(item.from), lte: new Date(item.through) } } });
      const byDate = new Map(item.events.map(event => [event.executionDate, event]));
      for (const row of existing) {
        const candidate = byDate.get(day(row.executionDate));
        if (!candidate || row.provider !== 'MASSIVE' || !row.splitFactor.eq(candidate.splitFactor) || row.provenance !== candidate.provenance)
          throw new Error(`Conflicting canonical split evidence for ${item.symbol} ${day(row.executionDate)}.`);
      }
      const pending = item.events.filter(event => !existing.some(row => day(row.executionDate) === event.executionDate));
      const coverage = await tx.marketSplitCoverage.findUnique({ where: { securityId_fromDate_throughDate: { securityId: item.securityId, fromDate: new Date(item.from), throughDate: new Date(item.through) } } });
      if (coverage && coverage.provider !== 'MASSIVE') throw new Error(`Conflicting split coverage for ${item.symbol}.`);
      if (apply) {
        if (pending.length) await tx.marketSplitEvent.createMany({ data: pending.map(event => ({ securityId: item.securityId, executionDate: new Date(event.executionDate), splitFactor: event.splitFactor, provider: 'MASSIVE', provenance: event.provenance, receivedAt })) });
        if (!coverage) await tx.marketSplitCoverage.create({ data: { securityId: item.securityId, fromDate: new Date(item.from), throughDate: new Date(item.through), provider: 'MASSIVE', receivedAt } });
      }
      report.push({ symbol: item.symbol, from: item.from, through: item.through, providerEvents: item.events.length, existingEvents: existing.length, pendingEvents: pending.length, coverageExists: !!coverage });
    }
    return { applied: apply, symbols: report };
  });
}

export async function extendMarketSplitCoverage(options: { db?: Db; fetchSplits?: FetchSplits; now?: Date } = {}) {
  const db = options.db ?? prisma, now = options.now ?? new Date();
  const candidates = await planAutomaticMarketSplitExtension(db, now, options.fetchSplits);
  if (candidates === null) return { dormant: true, reason: 'tiingo_authority' as const, extended: 0 };
  if (!candidates.length) return { dormant: false, extended: 0 };
  const result = await applyCandidates(db, candidates, true, now);
  return { dormant: false, extended: result.symbols.length, symbols: result.symbols };
}
