import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { analyze } from './analyze.js';
import { baselineRange, calculateBaseline, readBaseline, writeBaseline } from './baseline.js';
import { categories, compareRun, difference, measurements, missingLabel, reconstruct, revisionComparison, stateComparison } from './compare.js';
import { Journal, manifest } from './journal.js';
import { normalize, type Observation, type Symbol } from './model.js';
import { boundedGet, fetchAlpaca, fetchMassive, parseBar, parseMassiveBar, readReference, writeReference, type Reference, type ReferenceBar } from './reference.js';
import { sessionPlan } from './session.js';

const plan = sessionPlan('2026-09-22'), start = Date.parse(plan.openAt);
const at = (ms: number) => new Date(start + ms).toISOString();
const raw = (minute: number) => ({ t: at(minute * 60000), o: 100, h: 100.1, l: 99.9, c: 100, v: 10 });
function observation(minute: number, symbol: Symbol = 'SPY', ordinal = minute + 1, changes = {}, receipt = at((minute + 1) * 60000 + 200)): Observation {
  const parsed = normalize({ ...raw(minute), S: symbol, T: 'b', ...changes }, { runId: 'test', connectionEpoch: 1, ordinal, frameOrdinal: ordinal,
    elementIndex: 0, receivedAt: receipt, monotonicOffsetMs: ordinal });
  if ('error' in parsed) throw new Error('Fixture'); return parsed.observation;
}
function reference(minutes = Array.from({ length: 30 }, (_, i) => i)): Reference {
  return { version: 1, authority: 'RESEARCH_ONLY', provider: 'ALPACA', feed: 'IEX', fetchId: 'first', runId: 'test', sessionDate: plan.date,
    fetchedAt: at(3600000), range: { startAt: plan.openAt, endAt: at(1800000) }, complete: true, adjustment: 'raw', pages: [],
    minutes: minutes.flatMap(i => ['SPY', 'RSP'].map(s => parseBar(raw(i), s as Symbol, '1Min'))),
    bars: [0, 15].flatMap(i => ['SPY', 'RSP'].map(s => ({ ...parseBar(raw(i), s as Symbol, '15Min'), volume: minutes.filter(m => m >= i && m < i + 15).length * 10 }))) };
}
function baseline() {
  const dates = baselineRange(plan.date).dates;
  const bars = dates.map((date, i) => ({ id: i, date, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  return calculateBaseline(plan.date, { SPY: bars, RSP: bars }, { SPY: [], RSP: [] });
}
describe('Phase B provider boundaries (offline)', () => {
  it('paginates both timeframes with explicit IEX/raw and inclusive REST end converted from exclusive horizon', async () => {
    const urls: URL[] = [];
    const result = await fetchAlpaca({ key: 'secret-test', secret: 'test', feed: 'iex' }, reference().range, async url => {
      urls.push(url);
      return url.searchParams.has('page_token') ? { bars: { RSP: [raw(0)] }, next_page_token: null } : { bars: { SPY: [raw(0)] }, next_page_token: 'next' };
    });
    expect(urls).toHaveLength(4); expect(result.minutes).toHaveLength(2); expect(result.bars).toHaveLength(2);
    for (const url of urls) { expect(url.origin + url.pathname).toBe('https://data.alpaca.markets/v2/stocks/bars'); expect(url.searchParams.get('feed')).toBe('iex'); expect(url.searchParams.get('adjustment')).toBe('raw'); expect(url.searchParams.get('end')).toBe(at(1800000 - 1)); }
    expect(urls.map(u => u.searchParams.get('timeframe'))).toEqual(['1Min', '1Min', '15Min', '15Min']);
    await expect(fetchAlpaca({ key: '', secret: '', feed: 'sip' as 'iex' }, reference().range, async () => { throw new Error('Must not call'); })).rejects.toThrow('IEX');
  });
  it('rejects loops, malformed pages, duplicate bars and misaligned timestamps without fallback', async () => {
    for (const page of [{ bars: {}, next_page_token: 'same' }, { bars: { SPY: [raw(0), raw(0)] } }, { bars: { OTHER: [] } }, {}]) {
      await expect(fetchAlpaca({ key: 'x', secret: 'y', feed: 'iex' }, reference().range, async () => page)).rejects.toThrow();
    }
    expect(() => parseBar(raw(1), 'SPY', '15Min')).toThrow('Misaligned');
    expect(() => parseBar({ ...raw(0), t: at(1) }, 'SPY', '1Min')).toThrow();
    expect(() => parseBar({ ...raw(0), c: -1 }, 'SPY', '1Min')).toThrow();
  });
  it('sanitizes HTTP failure and performs no retries', async () => {
    let calls = 0;
    const get = boundedGet(async () => { calls++; throw new Error('secret-test'); });
    await expect(get(new URL('https://data.alpaca.markets/v2/stocks/bars'), {})).rejects.toThrow('Reference request failed'); expect(calls).toBe(1);
  });
  it('preserves Massive statuses and rejects unsafe pagination and adjusted data', async () => {
    expect(parseMassiveBar({ ...raw(0), v: 10.5 }, 'SPY', '15Min').volume).toBe(10.5);
    const get = async (url: URL) => ({ status: 'DELAYED', ticker: url.pathname.includes('SPY') ? 'SPY' : 'RSP', adjusted: false,
      results: [{ ...raw(0), t: start }] });
    const result = await fetchMassive('key', reference().range, get);
    expect(result.bars).toHaveLength(2); expect(result.pages.every(p => p.status === 'DELAYED')).toBe(true);
    await expect(fetchMassive('key', reference().range, async url => ({ ...await get(url), next_url: 'https://evil.example/' }))).rejects.toThrow('Unsafe');
    await expect(fetchMassive('key', reference().range, async url => ({ ...await get(url), adjusted: true }))).rejects.toThrow('adjustment');
  });
  it('writes immutable hashed snapshots and freezes the shared baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iex-phase-b-'));
    try {
      const ref = reference(); await writeReference(root, ref);
      expect((await readReference(root, 'ALPACA', 'first')).minutes).toEqual(ref.minutes);
      await expect(writeReference(root, ref)).rejects.toThrow();
      await writeReference(root, { ...ref, fetchId: 'second', fetchedAt: at(7200000) });
      expect((await readReference(root, 'ALPACA', 'latest')).fetchId).toBe('second');
      expect(await readFile(join(root, 'reference/alpaca/first/manifest.json'), 'utf8')).not.toContain('secret');
      await writeBaseline(root, baseline()); expect((await readBaseline(root)).priorAtr14Pct).toEqual({ SPY: .02, RSP: .02 });
      await expect(writeBaseline(root, baseline())).rejects.toThrow();
      await expect(readReference(root, 'ALPACA', '../first')).rejects.toThrow('Invalid');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('runs the comparison CLI offline against an archived Phase A journal without modifying source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iex-phase-b-cli-')), directory = join(root, 'run');
    try {
      const journal = await Journal.create(directory, manifest('test', at(-600000), plan, 'a'.repeat(40)));
      for (let i = 0; i < 30; i++) await journal.observation(observation(i));
      await journal.event({ type: 'shutdown_complete', at: at(2100000), connectionEpoch: 1 }); await journal.close();
      const paths = ['manifest.json', 'events.ndjson', 'observations-000001.ndjson'].map(name => join(directory, name));
      const original = await Promise.all(paths.map(path => readFile(path, 'utf8')));
      await writeReference(directory, reference());
      const massive: Reference = { ...reference(), provider: 'MASSIVE', fetchId: 'massive' }; delete massive.feed;
      await writeReference(directory, massive); await writeBaseline(directory, baseline());
      const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/compare-alpaca-iex-intraday.ts', 'compare', '--run-dir', directory,
        '--alpaca-fetch-id', 'first', '--massive-fetch-id', 'massive'], { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, ALPACA_MARKET_DATA_API_KEY: '', ALPACA_MARKET_DATA_API_SECRET: '', MASSIVE_API_KEY: '' } }).trim();
      const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
      expect(report.captureIntegrity.cleanShutdown).toBe(true); expect(report.classification[0].rawComparison.categories).toContain('UNCOMPARABLE_IEX');
      expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(original);
      expect(await readFile(join(output, 'summary.md'), 'utf8')).toContain('No production authority');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
describe('Phase B reconstruction and classification', () => {
  it('distinguishes no-bar, capture-gap and unavailable reference; strict remains strict', () => {
    const ref = reference([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const captured = ref.minutes.filter(b => b.symbol === 'SPY').map(b => observation((Date.parse(b.startAt) - start) / 60000));
    expect(missingLabel(false, ref, 'SPY', at(60000))).toBe('PROVIDER_NO_BAR');
    expect(missingLabel(false, ref, 'SPY', at(0))).toBe('CAPTURE_GAP');
    expect(missingLabel(false, null, 'SPY', at(0))).toBe('REFERENCE_UNAVAILABLE');
    expect(missingLabel(false, ref, 'SPY', at(1800000))).toBe('REFERENCE_UNAVAILABLE');
    const window = reconstruct(captured, plan, ref, at(1800000))[0]!;
    expect(window.strict.aggregate).toBeNull(); expect(window.validated).toBe(true); expect(window.aggregate?.volume).toBe(140);
    expect(window.omittedProviderNoBarMinutes).toEqual([at(60000)]);
    expect(reconstruct(captured.slice(1), plan, ref, at(1800000))[0]!.aggregate).toBeNull();
    expect(reconstruct([], plan, reference([]), at(1800000))[0]!.aggregate).toBeNull();
  });
  it('excludes future updatedBars and never fills a cutoff capture gap from REST', () => {
    const rows = Array.from({ length: 15 }, (_, i) => observation(i));
    rows.push(observation(14, 'SPY', 20, { T: 'u', c: 99.9, v: 20 }, at(931000)));
    const ref = reference(); ref.bars[0] = { ...ref.bars[0]!, close: 99.9, volume: 160 };
    expect(reconstruct(rows, plan, ref, at(930000))[0]!.aggregate?.close).toBe(100);
    expect(reconstruct(rows, plan, ref, at(931000))[0]!.validated).toBe(true);
    expect(reconstruct(rows, plan, ref, at(899000))[0]!.aggregate).toBeNull();
    // Later live evidence must not be labeled an omittable no-bar just because REST lost it.
    ref.minutes = ref.minutes.filter(b => !(b.symbol === 'SPY' && b.startAt === at(14 * 60000)));
    expect(reconstruct(rows, plan, ref, at(899000))[0]!.aggregate).toBeNull();
  });
  it('applies split normalization and refuses a missing prior completed daily baseline', () => {
    const frozen = baseline(), dates = frozen.dates;
    const executionDate = dates.at(-10)!;
    const splitBars = frozen.daily.SPY.map(b => b.date < executionDate ? { ...b, open: b.open * 2, high: b.high * 2, low: b.low * 2, close: b.close * 2, volume: b.volume / 2 } : b);
    const calculated = calculateBaseline(plan.date, { SPY: splitBars, RSP: frozen.daily.RSP }, { SPY: [{ id: 'split', executionDate, splitFrom: 1, splitTo: 2, priceFactor: .5 }], RSP: [] });
    expect(calculated.priorAtr14Pct).toEqual(frozen.priorAtr14Pct);
    expect(() => calculateBaseline(plan.date, { SPY: frozen.daily.SPY.slice(0, -1), RSP: frozen.daily.RSP }, frozen.splits)).toThrow('unavailable');
  });
  it('rejects ambiguous minutes and official mismatches as validated semantics', () => {
    const rows = Array.from({ length: 15 }, (_, i) => observation(i));
    expect(reconstruct([...rows, observation(0, 'SPY', 30, { c: 99.9 })], plan, reference(), at(1800000))[0]!.aggregate).toBeNull();
    const ref = reference(); ref.bars[0]!.volume++;
    expect(reconstruct(rows, plan, ref, at(1800000))[0]!.validated).toBe(false);
  });
  it('retains changed OHLC and volume across snapshots', () => {
    const first = reference(), later = { ...first, fetchId: 'later', fetchedAt: at(7200000), bars: first.bars.map(b => ({ ...b, close: 99.9, volume: 200 })) };
    const revisions = revisionComparison([first, later]);
    expect(revisions[0]!.elapsedMs).toBe(3600000); expect(revisions[0]!.intervals[0]!.changedOHLC).toBe(true); expect(revisions[0]!.intervals[0]!.changedVolume).toBe(true);
    expect(difference(first.bars[0]!, first.bars[0]!).exact).toBe(true);
  });
  it('reuses identical baseline and differentiates raw from effective disagreement', () => {
    const frozen = baseline();
    const bars: ReferenceBar[] = [0, 15, 30].flatMap(i => ['SPY', 'RSP'].map(s => ({ ...parseBar(raw(i), s as Symbol, '15Min'), volume: 150 })));
    const adverse = bars.map(b => b.startAt === at(0) ? { ...b, low: 96, close: 96 } : b);
    const a = measurements(plan, bars, frozen), b = measurements(plan, adverse, frozen);
    expect(a[0]![0]!.priorAtr14Pct).toBe(b[0]![0]!.priorAtr14Pct);
    const rows = stateComparison(a, b, [at(900000), at(1800000), at(2700000)]);
    expect(rows[0]!.rawComparison.highestRiskFalseNegative).toBe(true);
    expect(rows[0]!.rawComparison.categories).toContain('IEX_FALSE_NEGATIVE_CANDIDATE');
    // Isolate the existing recovery semantics independently of persistent session drawdown.
    b[0]![1]!.instrumentRawState = 'NORMAL'; b[1]![1]!.instrumentRawState = 'NORMAL';
    expect(stateComparison(a, b, [at(900000), at(1800000)])[1]!.hysteresisOnlyDisagreement).toBe(true);
    expect(categories('NORMAL', 'HIGH').highestRiskFalseNegative).toBe(true);
    expect(categories('ELEVATED', 'SEVERE').highestRiskFalseNegative).toBe(true);
    expect(categories('HIGH', 'ELEVATED').categories).toContain('IEX_FALSE_POSITIVE_CANDIDATE');
    expect(categories(null, null).categories).toEqual(['UNCOMPARABLE_IEX', 'UNCOMPARABLE_MASSIVE']);
  });
  it('preserves negative latencies and uses elapsed denominators', () => {
    const identity = manifest('test', at(-600000), plan, 'a'.repeat(40));
    const rows = [observation(0, 'SPY', 1, {}, at(59980))];
    const report = analyze(identity, rows, [], at(900000));
    expect(report.minuteCompleteness.SPY!.elapsedExpectedMinutes).toBe(15);
    expect(report.minuteCompleteness.SPY!.expected).toBe(390);
    expect(report.minuteCompleteness.SPY!.elapsedMissingMinutes).toBe(14);
    expect(report.latencyMs.initial.median).toBe(-20); expect(report.clockUncertain).toBe(false);
    expect(report.windowCompleteness.uncensoredScheduledWindows).toBe(2);
  });
  it('produces paired cutoff/classification reports for archived manifests without network calls', () => {
    const rows = Array.from({ length: 30 }, (_, i) => observation(i));
    rows.push(...Array.from({ length: 30 }, (_, i) => observation(i, 'RSP', 31 + i)));
    const ref = reference();
    const massive: Reference = { ...ref, provider: 'MASSIVE', fetchId: 'massive' }; delete massive.feed;
    const report = compareRun({ identity: manifest('test', at(-600000), plan, 'a'.repeat(40)), observations: rows, events: [], end: at(2100000), crashArtifacts: [] }, ref, massive, baseline(), [massive]);
    expect(report.classificationCounts.EXACT_STATE_AGREEMENT).toBe(2);
    expect(report.liveAsOf[0]!.uncensoredCompleteWindows).toBe(4);
    expect(report.minuteSummary.SPY!.CAPTURE_GAP).toBe(0);
    expect(report.baselineHash).toBeTruthy();
  });
});
