import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publish: vi.fn(), persist: vi.fn(), event: vi.fn() }));
vi.mock('../services/participation-assessment.service.js', () => ({ publishParticipationAssessments: mocks.publish }));
vi.mock('../db/prisma.js', () => ({ prisma: { workerHealthState: { upsert: mocks.persist, findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock('../services/system-event.service.js', () => ({ createSystemEvent: mocks.event }));
vi.mock('../config/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { createMonitoredParticipationScheduler, createParticipationScheduler } from './participation-assessment.scheduler.js';
import { WorkerHealthRegistry } from '../services/worker-health.service.js';
import { getWorkerDefinition, PARTICIPATION_ASSESSMENT_WORKER_INTERVAL_MS } from './worker-health.definitions.js';
import { HttpError } from '../errors/http-error.js';

const INTERVAL = PARTICIPATION_ASSESSMENT_WORKER_INTERVAL_MS;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.persist.mockResolvedValue({}); mocks.event.mockResolvedValue({}); });
afterEach(() => { vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('Participation scheduler lifecycle', () => {
  it('runs a tracked startup tick and then every fifteen minutes', async () => {
    const run = vi.fn().mockResolvedValue(undefined); const scheduler = createParticipationScheduler({ run });
    scheduler.start(); await flush(); expect(run).toHaveBeenCalledTimes(1); expect(scheduler.running).toBe(true);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL); expect(run).toHaveBeenCalledTimes(3);
    await scheduler.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('never starts a second local tick while one is in flight and does not duplicate intervals on repeated start', async () => {
    let release!: () => void; const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const scheduler = createParticipationScheduler({ run }); scheduler.start(); scheduler.start(); await flush();
    expect(run).toHaveBeenCalledTimes(1); expect(scheduler.inFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3); expect(run).toHaveBeenCalledTimes(1);
    release(); await flush(); expect(scheduler.inFlight).toBe(false);
    await vi.advanceTimersByTimeAsync(INTERVAL); expect(run).toHaveBeenCalledTimes(2);
    release(); await scheduler.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('stop prevents future ticks, aborts the in-flight tick, awaits its settlement and clears every timer', async () => {
    let aborted = false, settled = false;
    const run = vi.fn((signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; setTimeout(() => { settled = true; resolve(); }, 50); }, { once: true })));
    const scheduler = createParticipationScheduler({ run }); scheduler.start(); await flush();
    const stopping = scheduler.stop(); await flush(); expect(aborted).toBe(true); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50); expect(await stopping).toBe(true); expect(settled).toBe(true);
    expect(scheduler.running).toBe(false); expect(scheduler.inFlight).toBe(false); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3); expect(run).toHaveBeenCalledTimes(1);
  });
  it('bounds the drain when a tick does not settle and blocks new ticks until it does', async () => {
    const run = vi.fn(() => new Promise<void>(() => undefined)); const scheduler = createParticipationScheduler({ run });
    scheduler.start(); await flush();
    const stopping = scheduler.stop(1_000); await vi.advanceTimersByTimeAsync(1_000); expect(await stopping).toBe(false);
    scheduler.start(); await vi.advanceTimersByTimeAsync(INTERVAL * 2); expect(run).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('supports a clean restart after a drained stop without duplicating timers', async () => {
    const run = vi.fn().mockResolvedValue(undefined); const scheduler = createParticipationScheduler({ run });
    scheduler.start(); await flush(); await scheduler.stop(); scheduler.start(); await flush();
    expect(run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1); await scheduler.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('routes tick errors away from unhandled rejections and keeps scheduling', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom')); const scheduler = createParticipationScheduler({ run });
    scheduler.start(); await flush(); await vi.advanceTimersByTimeAsync(INTERVAL); expect(run).toHaveBeenCalledTimes(2); await scheduler.stop();
  });
  it('gives a startup dependency a bounded head start without coupling to its result', async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const run = vi.fn().mockResolvedValue(undefined); const scheduler = createParticipationScheduler({ run, startupGate: gate, startupGateTimeoutMs: 60_000 });
    scheduler.start(); await flush(); expect(run).not.toHaveBeenCalled(); finish(); await flush(); expect(run).toHaveBeenCalledTimes(1); await scheduler.stop();
    const never = new Promise<void>(() => undefined); const run2 = vi.fn().mockResolvedValue(undefined);
    const slow = createParticipationScheduler({ run: run2, startupGate: never, startupGateTimeoutMs: 60_000 }); slow.start(); await vi.advanceTimersByTimeAsync(59_999); expect(run2).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(run2).toHaveBeenCalledTimes(1); await slow.stop();
    const failing = createParticipationScheduler({ run: run2, startupGate: Promise.reject(new Error('sync failed')) }); failing.start(); await flush(); expect(run2).toHaveBeenCalledTimes(2); await failing.stop();
  });
  it('stopping during the startup gate never runs the publisher', async () => {
    const run = vi.fn().mockResolvedValue(undefined); const scheduler = createParticipationScheduler({ run, startupGate: new Promise<void>(() => undefined) });
    scheduler.start(); await flush(); expect(await scheduler.stop()).toBe(true); expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('monitored Participation scheduler composition', () => {
  const registry = () => { const r = new WorkerHealthRegistry({ processInstanceId: 'scheduler-test' }); r.registerWorker(getWorkerDefinition('participation_assessment_publication')); return r; };
  const item = (r: WorkerHealthRegistry) => r.getSnapshot().items.find(i => i.key === 'participation_assessment_publication')!;
  it('records a startup not_due skip, a blocked failure and a recovery through WorkerHealth without unhandled rejections', async () => {
    const r = registry(); const scheduler = createMonitoredParticipationScheduler(r);
    mocks.publish.mockResolvedValue({ notDue: true, published: 0, attempts: 0, suppressed: false, blocked: null });
    scheduler.start(); await flush(); expect(item(r)).toMatchObject({ lastOutcome: 'skipped', consecutiveFailures: 0 });
    mocks.publish.mockResolvedValue({ published: 0, attempts: 1, suppressed: false, notDue: false, blocked: { sessionDate: '2026-09-21', status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA' } });
    await vi.advanceTimersByTimeAsync(INTERVAL); expect(item(r)).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: 1 });
    mocks.publish.mockResolvedValue({ published: 1, attempts: 1, suppressed: false, notDue: false, blocked: null });
    await vi.advanceTimersByTimeAsync(INTERVAL); expect(item(r)).toMatchObject({ lastOutcome: 'success', consecutiveFailures: 0 });
    mocks.publish.mockRejectedValue(new HttpError(409, 'locked'));
    await vi.advanceTimersByTimeAsync(INTERVAL); expect(item(r)).toMatchObject({ lastOutcome: 'skipped' });
    await scheduler.stop(); await r.shutdown();
  });
  it('passes the shutdown signal to the publisher and aborts it on stop', async () => {
    let seen: AbortSignal | undefined;
    mocks.publish.mockImplementation((options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => { seen = options?.signal; seen?.addEventListener('abort', () => reject(seen!.reason), { once: true }); }));
    const r = registry(); const scheduler = createMonitoredParticipationScheduler(r); scheduler.start(); await flush();
    expect(seen).toBeInstanceOf(AbortSignal); expect(seen!.aborted).toBe(false);
    expect(await scheduler.stop()).toBe(true); expect(seen!.aborted).toBe(true); expect(scheduler.inFlight).toBe(false); expect(vi.getTimerCount()).toBe(0);
    await r.shutdown();
  });
});

describe('server wiring', () => {
  const server = readFileSync('src/app/server.ts', 'utf8');
  it('starts exactly one Participation scheduler after the market-data startup tick and stops/drains it before teardown', () => {
    expect(server.match(/createMonitoredParticipationScheduler\(/g)).toHaveLength(1);
    expect(server.match(/participationScheduler\.start\(\)/g)).toHaveLength(1);
    expect(server).toMatch(/const marketDataStartup = runWorker\('market_daily_evidence_sync'[\s\S]*createMonitoredParticipationScheduler\(workerHealthRegistry, \{ startupGate: marketDataStartup \}\)/);
    expect(server).not.toMatch(/setInterval\([^)]*[Pp]articipation/);
    expect(server.indexOf('participationScheduler.stop()')).toBeGreaterThan(server.indexOf('async function shutdown'));
    expect(server.indexOf('participationScheduler.stop()')).toBeLessThan(server.indexOf('workerHealthRegistry.stopPersistence()', server.indexOf('async function shutdown')));
    expect(server).not.toMatch(/publishParticipationAssessments|syncDailyBars/);
  });
  it('is global and account-independent with no trading imports', () => {
    const sources = ['src/workers/participation-assessment.worker.ts', 'src/workers/participation-assessment.scheduler.ts'].map(path => readFileSync(path, 'utf8')).join('\n');
    expect(sources).not.toMatch(/tradingAccount|accountId|alpaca|OrderIntent|EntryDecision|SignalEvaluation|StrategyMarketRegimePolicy|orders?\.service/i);
  });
});
