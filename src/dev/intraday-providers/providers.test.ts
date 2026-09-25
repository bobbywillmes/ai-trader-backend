import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { hash } from '../alpaca-iex/model.js';
import { sessionPlan } from '../alpaca-iex/session.js';
import { baselineRange, calculateBaseline, writeBaseline } from '../alpaca-iex/baseline.js';
import { ProviderCapture, type Dependencies, type Request, type SocketFactory } from './capture.js';
import { compareSources, minutesAt, windowsAt, agreement, type Source } from './compare.js';
import { supervise, type Experiment } from './experiment.js';
import { exclusiveJson, ProviderJournal, loadProviderRun } from './journal.js';
import { Versions, restBars, tiingoFrame, twelveTimestamp, pollSchedule, pollingBudget, type Event, type Observation, type RunManifest } from './model.js';

const plan = sessionPlan('2026-09-22'), open = Date.parse(plan.openAt);
const at = (seconds: number) => new Date(open + seconds * 1000).toISOString();
const tick = (seconds = 1, price = 100, symbol = 'spy') => ({ service: 'cons', messageType: 'A', data: [at(seconds), symbol, price] });
const bar = (minute = 0, close = '100') => ({ datetime: at(minute * 60).replace('T', ' ').slice(0, 19), open: '100', high: '101', low: '99', close, volume: '10' });
const batch = (rows: unknown[] = [bar()]) => Object.fromEntries(['SPY', 'RSP'].map(symbol => [symbol, { meta: { symbol, interval: '1min', exchange_timezone: 'America/New_York' }, status: 'ok', values: rows }]));
const receipt = (seconds: number, requested = seconds) => ({ receivedAt: at(seconds), requestedAt: at(requested), connectionEpoch: 1, monotonicOffsetMs: seconds * 1000 });
function baseline() {
  const bars = baselineRange(plan.date).dates.map((date, i) => ({ id: i, date, open: 100, high: 101, low: 99, close: 100, volume: 10 }));
  return calculateBaseline(plan.date, { SPY: bars, RSP: bars }, { SPY: [], RSP: [] });
}
function experiment(b = baseline()): Experiment {
  return { version: 1, authority: 'RESEARCH_ONLY', experimentId: 'experiment', session: plan, gitCommit: 'a'.repeat(40), captureCodeHash: 'b'.repeat(64), symbols: ['SPY', 'RSP'],
    startedAt: at(-60), stopAt: at(24000), baselineHash: hash(b), runs: { ALPACA: 'alpaca', TIINGO: 'tiingo', TWELVE_DATA: 'twelve' },
    budgets: { TIINGO: pollingBudget(pollSchedule(plan, 'TIINGO', at(-60))), TWELVE_DATA: pollingBudget(pollSchedule(plan, 'TWELVE_DATA', at(-60))) } };
}
function manifest(provider: 'TIINGO' | 'TWELVE_DATA' = 'TIINGO'): RunManifest {
  const e = experiment(); return { version: 1, authority: 'RESEARCH_ONLY', experimentId: e.experimentId, runId: e.runs[provider], provider, session: plan,
    baselineHash: e.baselineHash, gitCommit: e.gitCommit, startedAt: e.startedAt, symbols: ['SPY', 'RSP'] };
}
function source(product: 'TIINGO_WS' | 'TWELVE_DATA', observations: Observation[]): Source {
  return { key: product, product, observations, startedAt: at(-60), end: at(3600), events: [{ type: 'subscription_confirmed', at: at(-30) }] };
}
describe('provider parsers and local versions (offline)', () => {
  it('preserves consolidated reference provenance and rejects malformed, wrong-service and unexpected symbols', () => {
    const parsed = tiingoFrame(tick()); expect(parsed.data[0]).toMatchObject({ product: 'TIINGO_WS', symbol: 'SPY', price: 100, values: null, providerTimestamp: at(1) });
    expect(tiingoFrame({ ...tick(), data: [at(1), 'spy', null] }).events).toEqual(['malformed']);
    expect(tiingoFrame(tick(1, 100, 'bad')).events).toEqual(['unexpected_symbol']);
    expect(tiingoFrame({ ...tick(), service: 'iex' }).events).toEqual(['unexpected_channel']);
    expect(tiingoFrame({ messageType: 'E', response: { code: 401, message: 'SECRET' } }).terminal).toBe(true);
    expect(JSON.stringify(tiingoFrame({ messageType: 'E', response: { message: 'SECRET' } }))).not.toContain('SECRET');
    expect(tiingoFrame({ messageType: 'I', response: { code: 200 }, data: { subscriptionId: 12 } }).ready).toBe(true);
  });
  it('normalizes UTC batch timestamps, preserves null volume, and diagnoses null/malformed rows', () => {
    const parsed = restBars(batch([bar(), null, { ...bar(), close: null }, { ...bar(), datetime: 'bad' }]), 'TWELVE_DATA');
    expect(parsed.data).toHaveLength(4); expect(parsed.data[0]!.startAt).toBe(plan.openAt);
    expect(parsed.data.filter(d => d.unavailableValues)).toHaveLength(2);
    expect(parsed.events.filter(e => e === 'null_bar')).toHaveLength(4);
    expect(parsed.events.filter(e => e === 'malformed')).toHaveLength(2);
    expect(restBars(batch([{ ...bar(), volume: null }]), 'TWELVE_DATA').data[0]!.values!.volume).toBeNull();
    expect(() => twelveTimestamp('2026-02-30 13:30:00')).toThrow();
    expect(() => twelveTimestamp('2026-09-22 13:30:01')).toThrow();
    expect(restBars({ code: 429, message: 'SECRET' }, 'TWELVE_DATA').events).toContain('rate_limited');
    expect(restBars({ code: 401 }, 'TWELVE_DATA').terminal).toBe(true);
    expect(restBars({ message: 'SECRET' }, 'TWELVE_DATA').data).toEqual([]);
  });
  it('captures overlapping identical copies and changed values as separate observations with stable first seen', () => {
    const v = new Versions('twelve');
    const d = restBars(batch(), 'TWELVE_DATA').data[0]!;
    const a = v.observe(d, receipt(61)), b = v.observe(d, receipt(181));
    const c = v.observe(restBars(batch([bar(0, '100.5')]), 'TWELVE_DATA').data[0]!, receipt(301));
    const dAgain = v.observe(d, receipt(421));
    expect([a.ordinal, b.ordinal, c.ordinal, dAgain.ordinal]).toEqual([1, 2, 3, 4]);
    expect([a.revisionOrdinal, b.revisionOrdinal, c.revisionOrdinal, dAgain.revisionOrdinal]).toEqual([1, 1, 2, 3]);
    expect(b.duplicate).toBe(true); expect(c.duplicate).toBe(false); expect(c.firstSeenAt).toBe(a.receivedAt);
    expect(a.payloadHash).toBe(b.payloadHash); expect(a.valueHash).not.toBe(c.valueHash);
    expect(minutesAt(source('TWELVE_DATA', [a, b, c]), at(200))[0]).toMatchObject({ close: 100, duplicateCount: 1, revisionCount: 0 });
    expect(minutesAt(source('TWELVE_DATA', [a, b, c]), at(400))[0]!.close).toBe(100.5);
  });
  it('preserves timestamped null provider values as unavailable versions without inventing a usable bar', () => {
    const v = new Versions('twelve'), d = restBars(batch([{ ...bar(), close: null }]), 'TWELVE_DATA').data[0]!;
    const o = v.observe(d, receipt(61));
    expect(o.unavailableValues).toEqual({ open: 100, high: 101, low: 99, close: null, volume: 10 });
    expect(o.values).toBeNull(); expect(minutesAt(source('TWELVE_DATA', [o]), at(100))).toEqual([]);
    const recovered = v.observe(restBars(batch(), 'TWELVE_DATA').data[0]!, receipt(181));
    expect(recovered.revisionOrdinal).toBe(2); expect(recovered.firstSeenAt).toBe(at(61));
  });
  it('aggregates by provider time across minute boundaries without volume, filling, or receipt-order close errors', () => {
    const v = new Versions('tiingo');
    const rows = [[59, 101], [1, 100], [59, 101], [60, 102]].map(([sec, price], i) => v.observe(tiingoFrame(tick(sec, price)).data[0]!, { ...receipt(61 + i), requestedAt: null }));
    const s = source('TIINGO_WS', rows), minutes = minutesAt(s, at(180));
    expect(minutes[0]).toMatchObject({ startAt: at(0), open: 100, close: 101, high: 101, low: 100, volume: null });
    expect(minutes[1]).toMatchObject({ startAt: at(60), open: 102, close: 102, volume: null });
    expect(minutesAt(s, at(60))).toEqual([]);
    expect(minutesAt(s, at(180))).toEqual(minutesAt(s, at(180)));
    expect(windowsAt(s, plan, at(900))[0]!.values).toBeNull();
  });
  it('keeps nanosecond provider ordering and repeated identical reference events', () => {
    const v = new Versions('tiingo');
    const d1 = { ...tick(), data: ['2026-09-22T13:30:00.000000002Z', 'spy', 102] };
    const d2 = { ...tick(), data: ['2026-09-22T13:30:00.000000001Z', 'spy', 101] };
    const rows = [d1, d2, d2].map((d, i) => v.observe(tiingoFrame(d).data[0]!, { ...receipt(61 + i), requestedAt: null }));
    expect(rows[2]!.duplicate).toBe(true);
    expect(minutesAt(source('TIINGO_WS', rows), at(180))[0]).toMatchObject({ open: 101, close: 102, duplicateCount: 1, volume: null });
  });
  it('requires a closed-bar request and full Tiingo transport minute; REST failure does not create a WS gap', () => {
    const v = new Versions('twelve'), d = restBars(batch(), 'TWELVE_DATA').data[0]!;
    const partial = v.observe(d, receipt(61, 59)), complete = v.observe(d, receipt(181, 180));
    expect(minutesAt(source('TWELVE_DATA', [partial, complete]), at(120))[0]!.usableAt).toBeNull();
    expect(minutesAt(source('TWELVE_DATA', [partial, complete]), at(200))[0]!.usableAt).toBe(at(181));
    const tiingo = source('TIINGO_WS', [new Versions('tiingo').observe(tiingoFrame(tick()).data[0]!, { ...receipt(2), requestedAt: null })]);
    tiingo.events.push({ type: 'rest_transport_failure', at: at(10) });
    expect(minutesAt(tiingo, at(100))[0]!.usableAt).toBe(at(60));
    tiingo.events.push({ type: 'socket_closed', at: at(20) });
    expect(minutesAt(tiingo, at(100))[0]!.usableAt).toBeNull();
  });
  it('bounds full/shortened-session polling credits and avoids immediate catch-up bursts', () => {
    const schedule = pollSchedule(plan, 'TWELVE_DATA', at(-60)), budget = pollingBudget(schedule);
    expect(budget.dailyCredits).toBeLessThanOrEqual(400); expect(budget.maxPerMinute).toBe(2);
    expect(schedule.slice(1).every((t, i) => t - schedule[i]! >= 120000)).toBe(true);
    const tiingo = pollSchedule(plan, 'TIINGO', at(-60));
    expect(tiingo).toHaveLength(28); expect(pollingBudget(tiingo).dailyCredits).toBe(56);
    expect(Math.max(...tiingo.map(t => tiingo.filter(v => v >= t && v < t + 3600000).length * 2))).toBeLessThanOrEqual(12);
    expect(pollingBudget(pollSchedule(sessionPlan('2026-11-27'), 'TWELVE_DATA', '2026-11-27T14:29:00Z')).dailyCredits).toBeLessThan(230);
  });
});

function harness(provider: 'TIINGO' | 'TWELVE_DATA' = 'TIINGO', request: Request = async () => ({ status: 200, body: batch() })) {
  let now = open, mono = 0, timer = 0, finished: boolean | undefined;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const entries: (Event | Observation)[] = [], handlers: Parameters<SocketFactory>[0][] = [], sent: string[] = [];
  const dependencies: Dependencies = { now: () => now, monotonic: () => mono, schedule: (fn, ms) => { const id = ++timer; timers.set(id, { fn, at: now + ms }); return id; }, cancel: t => { timers.delete(t as number); },
    request, socket: h => { handlers.push(h); return { send: d => { sent.push(d); }, close: () => {}, isClosed: () => true, dispose: () => {} }; },
    append: async e => { entries.push(e); }, close: async () => {}, status: () => {}, finished: failed => { finished = failed; } };
  const capture = new ProviderCapture(provider, 'run', 'SECRET_TOKEN', plan, dependencies);
  const next = async () => { const [id, t] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]!; timers.delete(id); mono += t.at - now; now = t.at; t.fn();
    for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const frame = (value: unknown) => handlers.at(-1)!.message(JSON.stringify(value));
  const ack = () => { handlers.at(-1)!.open(); frame({ messageType: 'I', response: { code: 200 }, data: { subscriptionId: 1 } }); };
  return { capture, handlers, entries, timers, sent, next, frame, ack, result: () => finished, dependencies };
}
describe('isolated capture lifecycle (fake transports only)', () => {
  it('subscribes threshold 6, stamps reference events, reconnects with new epoch, and shuts down durably', async () => {
    const h = harness(); h.capture.start(); h.ack(); h.frame(tick()); const old = h.handlers[0]!;
    expect(JSON.parse(h.sent[0]!)).toEqual({ eventName: 'subscribe', authorization: 'SECRET_TOKEN', eventData: { thresholdLevel: 6, tickers: ['spy', 'rsp'] } });
    old.close(); old.error(); await h.next(); await h.next(); h.ack(); old.message(JSON.stringify(tick())); h.frame(tick(2));
    expect(h.entries.filter((e): e is Observation => 'product' in e).map(o => o.connectionEpoch)).toEqual([1, 2]);
    await h.capture.stop(); expect(h.result()).toBe(false); expect(h.timers.size).toBe(0);
    expect(h.entries.at(-1)).toMatchObject({ type: 'shutdown_complete' }); expect(JSON.stringify(h.entries)).not.toContain('SECRET');
  });
  it('stops independently on auth/subscription failure and malformed frames are sanitized', async () => {
    const h = harness(); h.capture.start(); h.handlers[0]!.message('SECRET not json'); h.frame({ messageType: 'E', response: { code: 403, message: 'SECRET' } });
    await h.capture.stop(); expect(h.result()).toBe(true); expect(JSON.stringify(h.entries)).not.toContain('SECRET');
    expect(h.entries).toContainEqual(expect.objectContaining({ type: 'malformed' }));
  });
  it('uses bounded REST requests, diagnoses rate limiting and resumes only on the next scheduled poll', async () => {
    const urls: URL[] = []; let calls = 0;
    const h = harness('TWELVE_DATA', async url => { urls.push(url); return ++calls === 1 ? { status: 429, body: null } : { status: 200, body: batch() }; });
    h.capture.start(); await h.next(); expect(calls).toBe(1); expect(h.entries).toContainEqual(expect.objectContaining({ type: 'rate_limited' }));
    await h.next(); expect(calls).toBe(2); expect(urls[0]!.searchParams.get('outputsize')).toBe('8'); expect(urls[0]!.searchParams.get('timezone')).toBe('UTC');
    expect(h.entries.filter(e => 'product' in e)).toHaveLength(2); await h.capture.stop();
  });
  it('survives network failure without retries or raw exceptions and cancels timers at shutdown', async () => {
    const h = harness('TWELVE_DATA', async () => { throw new Error('SECRET URL'); }); h.capture.start(); await h.next();
    expect(h.entries).toContainEqual(expect.objectContaining({ type: 'rest_transport_failure' }));
    expect(JSON.stringify(h.entries)).not.toContain('SECRET'); await h.capture.stop(); expect(h.timers.size).toBe(0);
  });
  it('does not let REST auth failure close Tiingo WS', async () => {
    const h = harness('TIINGO', async () => ({ status: 401, body: { message: 'SECRET' } })); h.capture.start(); h.ack(); await h.next();
    h.frame(tick()); expect(h.entries.filter(e => 'product' in e)).toHaveLength(1); expect(h.result()).toBeUndefined();
    await h.capture.stop(); expect(h.result()).toBe(true);
  });
  it('aborts an in-flight request before draining and records one clean shutdown', async () => {
    let aborted = false;
    const h = harness('TWELVE_DATA', async (_url, _headers, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('SECRET')); });
    }));
    h.capture.start(); await h.next(); await Promise.all([h.capture.stop(), h.capture.stop()]);
    expect(aborted).toBe(true); expect(h.entries.filter(e => 'type' in e && e.type === 'shutdown_complete')).toHaveLength(1);
    expect(h.result()).toBe(false); expect(h.timers.size).toBe(0);
  });
  it('bounds failed subscription handshakes and cancels reconnect after shutdown', async () => {
    const h = harness(); h.capture.start();
    for (let i = 0; i < 50 && h.result() === undefined; i++) {
      if (!h.timers.size) break;
      await h.next();
    }
    await h.capture.stop(); expect(h.result()).toBe(true); expect(h.handlers).toHaveLength(9);
    expect(h.timers.size).toBe(0);
  });
  it('one child failure leaves siblings running until explicit clean shutdown', async () => {
    let stop!: () => void, finish!: (failed: boolean) => void, stopped = 0, done = false;
    const healthy = new Promise<boolean>(resolve => { finish = resolve; });
    const task = supervise([{ done: Promise.resolve(true), stop() {} }, { done: healthy, stop() { stopped++; finish(false); } }], fn => { stop = fn; return () => {}; }).then(r => { done = true; return r; });
    await Promise.resolve(); expect(done).toBe(false); expect(stopped).toBe(0); stop(); expect(await task).toEqual([true, false]); expect(stopped).toBe(1);
  });
});

describe('journal integrity, experiment linkage, and deterministic offline comparison', () => {
  it('validates chain, normalized provenance and revision counters and preserves partial crash tails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-journal-'));
    try {
      const dir = join(root, 'tiingo'), identity = manifest(), sink = await ProviderJournal.create(dir, identity);
      const o = new Versions(identity.runId).observe(tiingoFrame(tick()).data[0]!, { ...receipt(2), requestedAt: null });
      await sink.append(o); await sink.append({ type: 'shutdown_complete', at: at(60), connectionEpoch: 1 }); await sink.close();
      const loaded = await loadProviderRun(dir); expect(loaded.observations).toEqual([o]); expect(loaded.cleanShutdown).toBe(true);
      await expect(ProviderJournal.create(dir, identity)).rejects.toThrow();
      const path = join(dir, 'journal.ndjson'), original = await readFile(path, 'utf8');
      await writeFile(path, original + '{partial'); expect((await loadProviderRun(dir)).truncatedFinalLine).toBe(true);
      await writeFile(path, original.replace('"price":100', '"price":101')); await expect(loadProviderRun(dir)).rejects.toThrow('chain');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('compares shared-baseline strict windows with null volume, cutoff revisions, directional disagreements and deterministic output', () => {
    const v = new Versions('tiingo'), observations: Observation[] = [];
    for (let minute = 0; minute < 30; minute++) for (const symbol of ['spy', 'rsp']) observations.push(v.observe(tiingoFrame(tick(minute * 60 + 1, 100, symbol)).data[0]!, { ...receipt(minute * 60 + 2), requestedAt: null }));
    const s = source('TIINGO_WS', observations), b = baseline(), e = experiment(b);
    const report = compareSources(e, [s], b);
    expect(report.sources[0]!.minuteCompleteness.RSP!.captured).toBe(30);
    expect(report.sources[0]!.windows[0]!.values!.volume).toBeNull();
    expect(report.sources[0]!.final[0]!.raw).toBe('NORMAL');
    expect(report.sources[0]!.final[0]!.spy.interval.volume).toBeNull();
    expect(report.sources[0]!.firstUsable[0]!.classifierFirstUsableAt).toBe(at(900));
    expect(report).toEqual(compareSources(e, [s], b));
    expect(() => compareSources({ ...e, baselineHash: 'wrong' }, [s], b)).toThrow('Baseline');
    expect(agreement('NORMAL', 'HIGH')).toEqual({ category: 'MULTI_LEVEL_DISAGREEMENT', highRiskFalseNegativeCandidate: true });
    expect(agreement('HIGH', 'NORMAL').highRiskFalseNegativeCandidate).toBe(false);
    expect(agreement('NORMAL', 'ELEVATED').category).toBe('ADJACENT_DISAGREEMENT');
  });
  it('runs the comparison CLI without credentials and rejects mismatched experiment linkage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-cli-'));
    try {
      const b = baseline(), e = experiment(b), identity = manifest('TWELVE_DATA');
      await exclusiveJson(join(root, 'experiment.json'), { ...e, contentHash: hash(e) }); await writeBaseline(root, b);
      const sink = await ProviderJournal.create(join(root, e.runs.TWELVE_DATA), identity), v = new Versions(identity.runId);
      for (const d of restBars(batch(), 'TWELVE_DATA').data) await sink.append(v.observe(d, receipt(61)));
      await sink.append({ type: 'shutdown_complete', at: at(180), connectionEpoch: 0 }); await sink.close();
      const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/compare-intraday-providers.ts', root], { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, TIINGO_API_TOKEN: '', TWELVE_DATA_API_KEY: '', MASSIVE_API_KEY: '' } }).trim();
      const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
      expect(report.integrity.ALPACA.missingRun).toBe(true); expect(report.integrity.TWELVE_DATA.cleanShutdown).toBe(true);
      expect(report.sources[0].minuteCompleteness.RSP.captured).toBe(1);
      const wrong = { ...identity, experimentId: 'wrong' };
      await writeFile(join(root, e.runs.TWELVE_DATA, 'manifest.json'), JSON.stringify({ ...wrong, contentHash: hash(wrong) }));
      expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/compare-intraday-providers.ts', root], { stdio: 'pipe', timeout: 15000 })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not use a later REST revision in an earlier target cutoff or first-available measurement', () => {
    const v = new Versions('twelve'), rows: Observation[] = [];
    const initial = restBars(batch(Array.from({ length: 15 }, (_, i) => bar(i))), 'TWELVE_DATA').data;
    for (const d of initial) rows.push(v.observe(d, receipt(910)));
    const revised = restBars(batch([{ ...bar(14), low: '90', close: '90' }]), 'TWELVE_DATA').data;
    for (const d of revised) rows.push(v.observe(d, receipt(1300)));
    const b = baseline(), report = compareSources(experiment(b), [source('TWELVE_DATA', rows)], b).sources[0]!;
    expect(report.final[0]!.raw).toBe('SEVERE');
    expect(report.asOf.find(s => s.seconds === 120)!.targets[0]!.raw).not.toBe('SEVERE');
    expect(report.firstUsable[0]!.classifierFirstUsableAt).toBe(at(910));
    expect(report.firstUsable[0]!.measurements!.spy.currentClose).toBe(100);
  });
});
