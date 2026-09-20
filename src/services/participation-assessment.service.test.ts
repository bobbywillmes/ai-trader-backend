import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment, type MarketBar } from '@prisma/client';
vi.mock('../db/prisma.js', () => ({ prisma: {} }));
import { getParticipationV1Assessment, latestParticipationV1Assessment, listParticipationV1Assessments, publishParticipationAssessments } from './participation-assessment.service.js';
import { datesBetween, etInstant, isFullMarketSession, type CalendarException } from './market-calendar.js';
import { verifiedCalendarRows } from './market-calendar-bootstrap.service.js';
import { planParticipationWindow } from './participation-publication-calendar.js';
import { PARTICIPATION_SYMBOLS, type ParticipationSymbol } from './participation-v1.definition.js';
import * as calculation from './participation-v1-calculation.js';
import { HttpError } from '../errors/http-error.js';
import { readFileSync, existsSync } from 'node:fs';

let rows: MarketBar[], assessments: MarketRegimeDimensionAssessment[], exceptions: CalendarException[];
let securities: { id: number; symbol: string }[], locked: boolean, tx: ReturnType<typeof makeTx>, externalWinner: MarketRegimeDimensionAssessment | null;
const fetchSplits = vi.fn().mockResolvedValue([]);
type Query = { where: { dimension?: string; algorithmVersion?: string; status?: string; targetAt?: Date | { gt: Date }; id?: number | { lt: number } }; orderBy?: unknown; take?: number };
function matches({ where, orderBy, take }: Query) {
  const found = assessments.filter(a => (!where.dimension || a.dimension === where.dimension) && (!where.algorithmVersion || a.algorithmVersion === where.algorithmVersion) && (!where.status || a.status === where.status)
    && (!where.targetAt || (where.targetAt instanceof Date ? +a.targetAt === +where.targetAt : a.targetAt > where.targetAt.gt))
    && (!where.id || (typeof where.id === 'number' ? a.id === where.id : a.id < where.id.lt)));
  return found.sort((a, b) => (JSON.stringify(orderBy).includes('asc') ? 1 : -1) * (+a.targetAt - +b.targetAt) || b.attempt - a.attempt).slice(0, take);
}
function makeTx() {
  return {
    $queryRaw: vi.fn(async () => [{ acquired: !locked }]),
    security: { findMany: vi.fn(async () => securities) },
    marketBar: { findMany: vi.fn(async ({ where }: { where: { OR: { barStartAt: { gte: Date; lt: Date } }[] } }) => rows.filter(r => where.OR.some(q => r.barStartAt >= q.barStartAt.gte && r.barStartAt < q.barStartAt.lt))) },
    marketCalendarException: { findMany: vi.fn(async () => exceptions.map(e => ({ ...e, sessionDate: new Date(e.sessionDate) }))) },
    marketRegimeDimensionAssessment: {
      findFirst: vi.fn(async (q: Query) => matches(q)[0] ?? null), findMany: vi.fn(async (q: Query) => matches(q)),
      create: vi.fn(async ({ data }: { data: Omit<MarketRegimeDimensionAssessment, 'id' | 'createdAt'> }) => {
        const row = { ...data, id: assessments.length + 1, createdAt: new Date('2026-09-14T21:00Z') }; assessments.push(row); return row;
      }),
    },
    systemEvent: { create: vi.fn(async (_args: unknown) => ({})) },
  };
}
function client() {
  return { ...tx, marketRegimeDimensionAssessment: { ...tx.marketRegimeDimensionAssessment, findFirst: vi.fn(async (q: Query) => externalWinner ?? matches(q)[0] ?? null) },
    $transaction: async (execute: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
      const before = [...assessments];
      try { return await execute(tx); } catch (e) { assessments = before; throw e; }
    } } as unknown as PrismaClient;
}
function add(date: string, volume = '1000', ids = [1, 2, 3, 4, 5]) {
  for (const securityId of ids) rows.push({ id: Math.max(0, ...rows.map(r => r.id)) + 1, securityId, barStartAt: etInstant(date, 0), timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED',
    open: new Prisma.Decimal(100), high: new Prisma.Decimal(101), low: new Prisma.Decimal(99), close: new Prisma.Decimal(100), volume: new Prisma.Decimal(volume), receivedAt: new Date('2026-09-14T20:20Z'), createdAt: new Date('2026-09-14T20:20Z') });
}
function history(from: string, through: string) { for (const d of datesBetween(from, through).filter(d => isFullMarketSession(d, exceptions))) add(d); }
const run = (at = '2026-09-14T20:30Z') => publishParticipationAssessments({ db: client(), now: new Date(at), clock: () => new Date(at), fetchSplits });
type Evidence = { canonicalInputHash: string; attemptFingerprint: string; expectedBaselineDates: string[]; normalizationThrough: string; bootstrap: boolean; initialization?: { inputBarCount: number };
  missing: unknown[]; panel: { panelMedianRvol: number; diagnostics: { affectsClassification: boolean } } | null;
  instruments: { symbol: string; rvol20: number; target: { rawVolume: string }; baseline: { rawVolume: string; normalizedVolume: number; priceFactorProduct: number }[]; splitEvidence: { events: unknown[] } }[] };
const evidence = (index = assessments.length - 1) => assessments[index]!.evidenceJson as unknown as Evidence;
beforeEach(() => {
  vi.restoreAllMocks(); fetchSplits.mockReset().mockResolvedValue([]); rows = []; assessments = []; exceptions = [...verifiedCalendarRows]; locked = false; externalWinner = null;
  securities = PARTICIPATION_SYMBOLS.map((symbol, i) => ({ id: i + 1, symbol })); tx = makeTx(); history('2026-07-01', '2026-09-14');
});

describe('PARTICIPATION_V1 immutable publisher', () => {
  it('has no worker/HTTP exposure or trading dependencies and does not mutate MarketBar', () => {
    const source = readFileSync('src/services/participation-assessment.service.ts', 'utf8');
    expect(source).not.toMatch(/StrategyMarketRegimePolicy|SignalEvaluation|EntryDecision|OrderIntent|TradingAccount|OperationalAttention|alpaca|\.marketBar\.(?:create|update|delete)|fetchDailyEvidence/);
    expect(existsSync('src/workers/participation-assessment.worker.ts')).toBe(false);
    expect(existsSync('src/controllers/participation-assessment.controller.ts')).toBe(false);
    expect(readFileSync('src/app/server.ts', 'utf8')).not.toContain('publishParticipation');
    expect(readFileSync('src/routes/market-data.routes.ts', 'utf8')).not.toContain('participation');
  });
  it('publishes only latest-due bootstrap with 105 reconstructable inputs and exact aligned dates', async () => {
    expect(await run()).toEqual({ published: 1, attempts: 1, suppressed: false, notDue: false, blocked: null });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]).toMatchObject({ sessionDate: new Date('2026-09-14'), targetAt: new Date('2026-09-14T20:00Z'), dataThroughAt: new Date('2026-09-14T20:00Z'), validUntil: new Date('2026-09-15T20:30Z'), rawState: 'NORMAL', effectiveState: 'NORMAL', previousAssessmentId: null });
    expect(evidence().initialization?.inputBarCount).toBe(105); expect(evidence().bootstrap).toBe(true);
    expect(evidence().instruments.map(i => i.symbol)).toEqual(PARTICIPATION_SYMBOLS);
    expect(evidence().instruments.every(i => i.baseline.length === 20 && i.rvol20 === 1)).toBe(true);
    expect(evidence().expectedBaselineDates).toEqual(planParticipationWindow('2026-09-14', exceptions).baselineDates);
    expect(evidence().panel?.diagnostics.affectsClassification).toBe(false);
    expect(tx.systemEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'participation_assessment_bootstrap' }) }));
  });
  it.each(['2026-09-14', '2026-09-10'])('pins latest due when %s is missing, never substitutes an older date', async d => {
    rows = rows.filter(r => +r.barStartAt !== +etInstant(d, 0));
    expect(await run()).toMatchObject({ published: 0, blocked: { sessionDate: '2026-09-14', reasonCode: 'MISSING_MARKET_DATA' } });
    expect(evidence().missing).toHaveLength(5); expect(fetchSplits).not.toHaveBeenCalled();
    expect(assessments[0]).toMatchObject({ rawState: null, effectiveState: null, dataThroughAt: null, validUntil: null });
    expect(await run()).toMatchObject({ attempts: 0, suppressed: true, blocked: { sessionDate: '2026-09-14' } });
    add(d); expect(await run()).toMatchObject({ published: 1 });
    expect(assessments.map(a => a.attempt)).toEqual([1, 2]); expect(assessments[1]!.targetAt).toEqual(assessments[0]!.targetAt);
  });
  it('records changing missing slots, then recovers a several-day-old first attempt before catch-up', async () => {
    rows = rows.filter(r => +r.barStartAt !== +etInstant('2026-09-14', 0)); await run();
    add('2026-09-14', '1000', [1]); expect(await run()).toMatchObject({ attempts: 1, suppressed: false });
    add('2026-09-14', '1000', [2, 3, 4, 5]); history('2026-09-15', '2026-09-18');
    expect(await run('2026-09-18T20:30Z')).toMatchObject({ published: 5, blocked: null });
    expect(assessments.slice(0, 3).map(a => [a.status, a.attempt, a.previousAssessmentId])).toEqual([['UNAVAILABLE', 1, null], ['UNAVAILABLE', 2, null], ['VALID', 3, null]]);
    expect(assessments[3]!.previousAssessmentId).toBe(assessments[2]!.id);
  });
  it.each([1, 3, 5])('missing Security %s prevents provider calls and identifies SECURITY role', async id => {
    securities = securities.filter(s => s.id !== id); rows = rows.filter(r => r.securityId !== id);
    expect(await run()).toMatchObject({ blocked: { reasonCode: 'MISSING_MARKET_DATA' } });
    expect(evidence().missing).toContainEqual({ symbol: PARTICIPATION_SYMBOLS[id - 1], role: 'SECURITY' }); expect(fetchSplits).not.toHaveBeenCalled();
  });
  it('records all 105 missing bars deterministically', async () => { rows = []; await run(); expect(evidence().missing).toHaveLength(105); });
  it('records all five absent Security identities', async () => { rows = []; securities = []; await run(); expect(evidence().missing).toEqual(PARTICIPATION_SYMBOLS.map(symbol => ({ symbol, role: 'SECURITY' }))); });
  it('uses frozen close/grace boundary without I/O time changing eligibility', async () => {
    await run(); tx.marketBar.findMany.mockClear(); fetchSplits.mockClear();
    expect(await run('2026-09-15T20:29:59.999Z')).toMatchObject({ notDue: true }); expect(tx.marketBar.findMany).not.toHaveBeenCalled();
    history('2026-09-15', '2026-09-16');
    tx.marketCalendarException.findMany.mockImplementationOnce(async () => { vi.setSystemTime(new Date('2026-09-15T20:31Z')); return exceptions.map(e => ({ ...e, sessionDate: new Date(e.sessionDate) })); });
    expect(await run('2026-09-15T20:29:59.999Z')).toMatchObject({ notDue: true });
    expect(await run('2026-09-15T20:30Z')).toMatchObject({ published: 1 });
  });
  it('fresh bootstrap before cutoff selects yesterday, never today', async () => { await run('2026-09-14T20:29:59.999Z'); expect(assessments[0]!.sessionDate).toEqual(new Date('2026-09-11')); });
  it.each(['2026-09-12T20:30Z', '2026-09-13T20:30Z', '2026-09-07T20:30Z'])('weekend/holiday %s creates no excluded target', async at => {
    await run(at); expect(isFullMarketSession(assessments[0]!.sessionDate!.toISOString().slice(0, 10), exceptions)).toBe(true);
  });
  it('skips Monday early close for target, baseline and Friday validity', async () => {
    exceptions.push({ sessionDate: '2026-09-14', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 });
    await run('2026-09-11T20:30Z'); expect(assessments[0]!.validUntil).toEqual(new Date('2026-09-15T20:30Z'));
    expect(await run()).toMatchObject({ notDue: true }); add('2026-09-15'); await run('2026-09-15T20:30Z');
    expect(evidence().expectedBaselineDates).not.toContain('2026-09-14'); expect(assessments).toHaveLength(2);
  });
  it('derives each close in Eastern time across DST', async () => {
    rows = []; history('2026-01-01', '2026-03-09'); await run('2026-03-06T21:30Z');
    expect(assessments[0]!.targetAt).toEqual(new Date('2026-03-06T21:00Z')); expect(assessments[0]!.validUntil).toEqual(new Date('2026-03-09T20:30Z'));
  });
  it('insufficient trusted history differs from ordinary missing bars', async () => {
    rows = []; history('2021-01-01', '2021-01-05');
    expect(await run('2021-01-05T21:30Z')).toMatchObject({ blocked: { reasonCode: 'INSUFFICIENT_HISTORY' } }); expect(fetchSplits).not.toHaveBeenCalled();
  });
  it('zero baseline blocks before split work', async () => {
    rows.forEach(r => { r.volume = new Prisma.Decimal(0); }); expect(await run()).toMatchObject({ blocked: { reasonCode: 'INSUFFICIENT_HISTORY' } }); expect(fetchSplits).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'negative', 'infinite', 'not-midnight', 'unexpected-security'])('corrupt %s evidence fails before missing data/split dependencies', async kind => {
    const row = rows.at(-1)!;
    if (kind === 'duplicate') rows.push({ ...row });
    if (kind === 'negative') row.volume = new Prisma.Decimal(-1);
    if (kind === 'infinite') row.volume = new Prisma.Decimal(Infinity);
    if (kind === 'not-midnight') row.barStartAt = new Date(+row.barStartAt + 1000);
    if (kind === 'unexpected-security') row.securityId = 999;
    expect(await run()).toMatchObject({ blocked: { reasonCode: 'CALCULATION_FAILED' } }); expect(fetchSplits).not.toHaveBeenCalled(); expect(JSON.stringify(evidence())).not.toMatch(/NaN|Infinity/);
  });
  it('records known-target calendar failure, suppresses it and recovers after calendar repair', async () => {
    exceptions = exceptions.filter(e => e.sessionDate !== '2026-09-07');
    expect(await run()).toMatchObject({ blocked: { reasonCode: 'CALENDAR_EVIDENCE_UNAVAILABLE' } }); expect(await run()).toMatchObject({ suppressed: true });
    expect(tx.marketBar.findMany).not.toHaveBeenCalled(); exceptions = [...verifiedCalendarRows]; expect(await run()).toMatchObject({ published: 1 });
  });
  it('does not fabricate target when reviewed latest identity or horizon is unknown', async () => {
    exceptions = exceptions.filter(e => e.sessionDate !== '2026-09-07');
    await expect(run('2026-09-07T20:30Z')).rejects.toThrow('calendar authority'); expect(assessments).toHaveLength(0);
    await expect(run('2027-01-05T21:30Z')).rejects.toThrow('calendar authority');
  });
  it('next validity beyond reviewed horizon becomes calendar failure for known target', async () => {
    expect(await run('2026-12-31T21:30Z')).toMatchObject({ blocked: { reasonCode: 'CALENDAR_EVIDENCE_UNAVAILABLE' } });
  });
  it.each(['CLOSED', 'EARLY_CLOSE'] as const)('retrospective %s conflict is visible even before notDue', async type => {
    await run(); exceptions.push({ sessionDate: '2026-09-14', type, closeTimeMinutesEt: type === 'CLOSED' ? null : 780 });
    await expect(run()).rejects.toThrow('persisted target conflicts'); expect(assessments).toHaveLength(1);
  });
  it.each(['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE'])('predecessor %s and malformed evidence never affect current math/hash', async state => {
    await run(); const predecessor = assessments[0]!; add('2026-09-15', '2000'); await run('2026-09-15T20:30Z'); const expected = evidence().canonicalInputHash;
    assessments = [{ ...predecessor, rawState: state, effectiveState: state, evidenceJson: { nonsense: 'no continuation' } }];
    await run('2026-09-15T20:30Z'); expect(evidence().canonicalInputHash).toBe(expected); expect(assessments[1]).toMatchObject({ rawState: 'INTENSE', effectiveState: 'INTENSE' });
  });
  it('supports direct INTENSE to QUIET without a transition engine', async () => {
    rows.filter(r => +r.barStartAt === +etInstant('2026-09-14', 0)).forEach(r => { r.volume = new Prisma.Decimal(2000); }); await run(); add('2026-09-15', '100'); await run('2026-09-15T20:30Z');
    expect(assessments.map(a => a.effectiveState)).toEqual(['INTENSE', 'QUIET']);
  });
  it.each([[1, 2, .5], [2, 1, 2]])('normalizes %s:%s split through target and preserves decimal evidence', async (from, to, factor) => {
    fetchSplits.mockImplementation(async (symbol: ParticipationSymbol) => [{ id: 'split', symbol, executionDate: '2026-09-14', splitFrom: from, splitTo: to, priceFactor: factor }]);
    await run(); expect(evidence().instruments[0]!.baseline[0]).toMatchObject({ rawVolume: '1000', normalizedVolume: 1000 / factor, priceFactorProduct: factor });
    expect(evidence().instruments[0]!.rvol20).toBe(factor); expect(evidence().normalizationThrough).toBe('2026-09-14');
  });
  it('multiple splits including excluded early close affect earlier volumes', async () => {
    exceptions.push({ sessionDate: '2026-09-10', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 });
    fetchSplits.mockImplementation(async (symbol: ParticipationSymbol) => ['2026-09-10', '2026-09-14'].map((executionDate, i) => ({ id: String(i), symbol, executionDate, splitFrom: 1, splitTo: 2, priceFactor: .5 })));
    await run(); expect(evidence().instruments[0]!.baseline[0]!.priceFactorProduct).toBe(.25);
  });
  it.each(['duplicate', 'malformed', 'request'])('strict split %s failure is sanitized and retried', async kind => {
    fetchSplits.mockImplementation(async (symbol: ParticipationSymbol) => {
      if (kind === 'request') throw new Error('https://secret/?apiKey=credential');
      const e = { id: 'same', symbol, executionDate: '2026-09-14', splitFrom: 1, splitTo: 2, priceFactor: kind === 'malformed' ? -1 : .5 };
      return kind === 'duplicate' ? [e, e] : [e];
    });
    expect(await run()).toMatchObject({ blocked: { reasonCode: 'SPLIT_EVIDENCE_UNAVAILABLE' } }); expect(await run()).toMatchObject({ suppressed: true });
    expect(JSON.stringify(evidence())).not.toContain('credential'); fetchSplits.mockResolvedValue([]); expect(await run()).toMatchObject({ published: 1 });
  });
  it('canonical hash ignores run clocks, receipt timestamps, batch size and future splits', async () => {
    await run(); const first = assessments[0]!; add('2026-09-15'); add('2026-09-16');
    fetchSplits.mockImplementation(async (symbol: ParticipationSymbol, _from: string, through: string) => through >= '2026-09-16' ? [{ id: 'future', symbol, executionDate: '2026-09-16', splitFrom: 1, splitTo: 2, priceFactor: .5 }] : []);
    await run('2026-09-15T20:30Z'); const one = evidence(); assessments = [first];
    rows.forEach(r => { r.receivedAt = new Date('2026-09-16T20:00Z'); }); fetchSplits.mockClear(); await run('2026-09-16T20:30Z');
    expect(evidence(1).canonicalInputHash).toBe(one.canonicalInputHash); expect(evidence(1).attemptFingerprint).toBe(one.attemptFingerprint);
    expect(evidence(1).instruments[0]!.splitEvidence.events).toEqual([]); expect(fetchSplits).toHaveBeenCalledTimes(5);
  });
  it('changed stable split failure category creates a new immutable attempt', async () => {
    fetchSplits.mockRejectedValue(new HttpError(502, 'Massive evidence: split request failed')); await run();
    fetchSplits.mockRejectedValue(new HttpError(502, 'Massive evidence: malformed or duplicate split evidence'));
    expect(await run()).toMatchObject({ attempts: 1, suppressed: false }); expect(assessments.map(a => a.attempt)).toEqual([1, 2]);
  });
  it('one publication deadline cancels and awaits all five dependencies before storing failure', async () => {
    const controller = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let settled = 0;
    fetchSplits.mockImplementation(async (_symbol: string, _from: string, _through: string, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { settled++; reject(new Error('cancelled')); }, { once: true }));
      return [];
    });
    const promise = run();
    await vi.waitFor(() => expect(fetchSplits).toHaveBeenCalledTimes(5)); controller.abort();
    expect(await promise).toMatchObject({ attempts: 1, blocked: { reasonCode: 'SPLIT_EVIDENCE_UNAVAILABLE' } }); expect(settled).toBe(5);
    expect(JSON.stringify(evidence())).toContain('PUBLICATION_DEADLINE');
  });
  it('waits for remaining symbols even when one dependency rejects immediately', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    fetchSplits.mockImplementation(async (symbol: string) => { if (symbol === 'SPY') throw new Error('failed'); await gate; return []; });
    const promise = run(); await vi.waitFor(() => expect(fetchSplits).toHaveBeenCalledTimes(5));
    expect(tx.marketRegimeDimensionAssessment.create).not.toHaveBeenCalled(); release();
    expect(await promise).toMatchObject({ blocked: { reasonCode: 'SPLIT_EVIDENCE_UNAVAILABLE' } });
  });
  it('rejects semantically invalid predecessor even if a database adapter returns it', async () => {
    await run(); const valid = assessments[0]!; add('2026-09-15');
    tx.marketRegimeDimensionAssessment.findFirst.mockResolvedValueOnce({ ...valid, status: 'FAILED' });
    await expect(run('2026-09-15T20:30Z')).rejects.toThrow('predecessor lineage');
  });
  it('rejects non-earlier predecessor instead of using it for calculation', async () => {
    await run(); const valid = assessments[0]!;
    tx.marketRegimeDimensionAssessment.findFirst.mockResolvedValueOnce(valid).mockResolvedValueOnce({ ...valid, status: 'UNAVAILABLE' });
    await expect(run()).rejects.toThrow('predecessor lineage');
  });
  it('preserves fractional raw volumes as canonical decimal strings', async () => {
    rows.forEach(r => { r.volume = new Prisma.Decimal('1000.123400'); }); await run(); expect(evidence().instruments[0]!.target.rawVolume).toBe('1000.1234');
  });
  it('stops at earliest unresolved continuation and uses only earlier VALID lineage', async () => {
    await run(); add('2026-09-16'); expect(await run('2026-09-16T20:30Z')).toMatchObject({ blocked: { sessionDate: '2026-09-15' } });
    const prior = assessments[1]!.previousAssessmentId; expect(await run('2026-09-16T20:30Z')).toMatchObject({ suppressed: true });
    add('2026-09-15'); expect(await run('2026-09-16T20:30Z')).toMatchObject({ published: 2 }); expect(assessments[2]!.previousAssessmentId).toBe(prior);
    expect(assessments[3]!.previousAssessmentId).toBe(assessments[2]!.id);
  });
  it('bounds catch-up at 20, then resumes with one fetch per symbol per run', async () => {
    await run('2026-08-03T20:30Z'); history('2026-09-15', '2026-09-18'); fetchSplits.mockClear();
    expect(await run('2026-09-18T20:30Z')).toMatchObject({ published: 20 }); expect(fetchSplits).toHaveBeenCalledTimes(5);
    const remaining = datesBetween(assessments.at(-1)!.sessionDate!.toISOString().slice(0, 10), '2026-09-18').filter(d => isFullMarketSession(d, exceptions)).length - 1;
    expect(await run('2026-09-18T20:30Z')).toMatchObject({ published: remaining });
  });
  it('does not select other dimension/version predecessors', async () => {
    await run(); const first = assessments[0]!; assessments = [{ ...first, dimension: 'TREND', algorithmVersion: 'TREND_V1' }, { ...first, id: 2, algorithmVersion: 'PARTICIPATION_V2' }];
    await run(); expect(assessments.at(-1)!.previousAssessmentId).toBeNull();
  });
  it('events obey blocked/bootstrap/recovered/transition precedence and suppress idle/unchanged work', async () => {
    rows = rows.filter(r => +r.barStartAt !== +etInstant('2026-09-14', 0)); await run(); await run(); add('2026-09-14'); await run(); await run();
    add('2026-09-15'); await run('2026-09-15T20:30Z'); await run('2026-09-16T20:30Z'); add('2026-09-16', '2000'); await run('2026-09-16T20:30Z'); add('2026-09-17', '100'); await run('2026-09-17T20:30Z');
    expect(assessments.map(a => [a.status, (a.evidenceJson as unknown as Evidence).bootstrap])).toEqual(assessments.map(a => [a.status, a.previousAssessmentId === null && a.status === 'VALID' ? true : false]));
    expect(assessments.filter(a => (a.evidenceJson as unknown as Evidence).bootstrap)).toHaveLength(1);
    expect(tx.systemEvent.create.mock.calls.map(([args]) => (args as { data: { type: string } }).data.type)).toEqual(['participation_assessment_blocked', 'participation_assessment_bootstrap', 'participation_assessment_blocked', 'participation_assessment_recovered', 'participation_assessment_transition']);
  });
  it('lock contention precedes all state/calendar/bar reads', async () => {
    locked = true; await expect(run()).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.marketRegimeDimensionAssessment.findFirst).not.toHaveBeenCalled(); expect(tx.marketCalendarException.findMany).not.toHaveBeenCalled(); expect(tx.marketBar.findMany).not.toHaveBeenCalled();
  });
  it.each([true, false])('P2002 is suppressed only with committed VALID winner (%s)', async winner => {
    tx.marketRegimeDimensionAssessment.create.mockImplementationOnce(async ({ data }) => {
      if (winner) externalWinner = { ...data, id: 99, createdAt: new Date() };
      throw new Prisma.PrismaClientKnownRequestError('collision', { code: 'P2002', clientVersion: 'test' });
    });
    if (winner) expect(await run()).toMatchObject({ attempts: 0, published: 0, suppressed: true }); else await expect(run()).rejects.toMatchObject({ code: 'P2002' });
    expect(assessments).toHaveLength(0);
  });
  it('transaction failure propagates and reports no committed result', async () => {
    tx.systemEvent.create.mockRejectedValueOnce(new Error('transaction rolled back'));
    await expect(run()).rejects.toThrow('rolled back'); expect(assessments).toHaveLength(0);
  });
  it('arithmetic exception becomes terminal calculation failure', async () => {
    vi.spyOn(calculation, 'calculateParticipationV1').mockImplementationOnce(() => { throw new Error('unsafe details'); });
    expect(await run()).toMatchObject({ blocked: { reasonCode: 'CALCULATION_FAILED' } }); expect(evidence().panel).toBeNull();
  });
  it('read helpers independently scope latest attempt/valid, list and detail without mutating expiry', async () => {
    await run(); await run('2026-09-15T20:30Z'); const original = JSON.stringify(assessments); const db = client();
    expect(await latestParticipationV1Assessment(db)).toEqual({ latestAttempt: assessments[1], latestValid: assessments[0] });
    expect(await listParticipationV1Assessments(10, 2, db)).toEqual([assessments[0]]);
    expect(await getParticipationV1Assessment(1, db)).toEqual(assessments[0]); await expect(getParticipationV1Assessment(999, db)).rejects.toMatchObject({ statusCode: 404 }); expect(JSON.stringify(assessments)).toBe(original);
  });
});
