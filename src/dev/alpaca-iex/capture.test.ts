import { describe, expect, it } from 'vitest';
import { Capture } from './capture.js';
import { parseConfig } from './config.js';
import type { Observation, ResearchEvent } from './model.js';
import type { TransportHandlers } from './transport.js';

function harness() {
  const events: ResearchEvent[] = [], observations: Observation[] = [], sent: unknown[] = [], handlers: TransportHandlers[] = [];
  const timers = new Map<number, { fn: () => void; delay: number }>();
  let timerId = 0, finished: boolean | undefined, closed = 0, failWriter = false;
  const capture = new Capture('fixture', { key: 'never-log-key', secret: 'never-log-secret', feed: 'iex' }, {
    transport: h => { handlers.push(h); return { send: s => { sent.push(JSON.parse(s)); }, close: () => { closed++; }, dispose: () => {}, isClosed: () => true }; },
    sink: { event: async e => { if (failWriter) throw new Error('secret'); events.push(e); },
      observation: async o => { if (failWriter) throw new Error('secret'); observations.push(o); }, close: async () => {} },
    now: () => new Date('2026-09-22T13:45:01Z'), monotonic: () => 42, random: () => .5,
    schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, cancel: t => { timers.delete(t as number); },
    status: () => {}, finished: failed => { finished = failed; },
  });
  const frame = (value: unknown) => handlers.at(-1)!.message(JSON.stringify(value));
  const ack = () => {
    frame([{ T: 'success', msg: 'connected' }]); frame([{ T: 'success', msg: 'authenticated' }]);
    frame([{ T: 'subscription', bars: ['SPY', 'RSP'], updatedBars: ['RSP', 'SPY'], trades: [], quotes: [] }]);
  };
  const tick = () => { const [id, timer] = [...timers][0]!; timers.delete(id); timer.fn(); };
  return { capture, events, observations, sent, handlers, timers, frame, ack, tick,
    result: () => ({ finished, closed }), failWriter: () => { failWriter = true; } };
}
const bar = { T: 'b', S: 'SPY', t: '2026-09-22T13:30:00Z', o: 1, h: 2, l: 1, c: 2, v: 10 };
describe('offline capture protocol', () => {
  it('authenticates, verifies exact channels, processes batched data and shuts down', async () => {
    const h = harness(); h.capture.start(); h.ack(); h.frame([bar, { ...bar, T: 'u', v: 20 }, { ...bar, S: 'RSP' }]);
    expect(h.sent).toEqual([{ action: 'auth', key: 'never-log-key', secret: 'never-log-secret' }, { action: 'subscribe', bars: ['SPY', 'RSP'], updatedBars: ['SPY', 'RSP'] }]);
    expect(h.observations.map(o => o.elementIndex)).toEqual([0, 1, 2]); expect(new Set(h.observations.map(o => o.frameOrdinal)).size).toBe(1);
    expect(h.timers.size).toBe(0); await h.capture.stop(); expect(h.result().finished).toBe(false);
    expect(h.events.at(-1)!.type).toBe('shutdown_complete'); expect(JSON.stringify(h.events)).not.toContain('never-log');
  });
  it.each([402, 409, 405, 410, 404])('terminates visibly on non-transient provider error %s', async code => {
    const h = harness(); h.capture.start(); h.frame([{ T: 'error', code, msg: 'never-log-secret' }]); await h.capture.stop();
    expect(h.result().finished).toBe(true); expect(h.timers.size).toBe(0); expect(JSON.stringify(h.events)).not.toContain('never-log');
  });
  it.each([
    { bars: ['SPY'], updatedBars: ['SPY', 'RSP'] },
    { bars: ['SPY', 'RSP'], updatedBars: ['SPY', 'RSP'], trades: ['SPY'] },
    { bars: ['SPY', 'SPY'], updatedBars: ['SPY', 'RSP'] },
  ])('rejects inaccurate subscriptions %j', async ack => {
    const h = harness(); h.capture.start(); h.frame([{ T: 'success', msg: 'connected' }]); h.frame([{ T: 'success', msg: 'authenticated' }]);
    h.frame([{ T: 'subscription', ...ack }]); await h.capture.stop(); expect(h.result().finished).toBe(true);
  });
  it('reconnects once for error/close, ignores stale callbacks, reauthenticates and changes epoch', async () => {
    const h = harness(); h.capture.start(); h.ack(); h.frame([bar]); const old = h.handlers[0]!;
    old.error(); old.close(1006); expect(h.timers.size).toBe(1); h.tick(); old.message(JSON.stringify([bar])); h.ack(); h.frame([bar]);
    expect(h.observations.map(o => o.connectionEpoch)).toEqual([1, 2]); expect(h.sent).toHaveLength(4);
    expect(h.events.filter(e => e.type === 'reconnect_scheduled')).toHaveLength(1); await h.capture.stop();
  });
  it('bounds repeated connection conflicts and cancels pending reconnect on shutdown', async () => {
    const h = harness(); h.capture.start();
    for (let i = 0; i < 9; i++) { h.frame([{ T: 'error', code: 406 }]); if (i < 8) h.tick(); }
    await h.capture.stop(); expect(h.result().finished).toBe(true); expect(h.handlers).toHaveLength(9);
    const second = harness(); second.capture.start(); second.handlers[0]!.error(); await second.capture.stop(); expect(second.timers.size).toBe(0);
  });
  it('times out a missing handshake with bounded retries', async () => {
    const h = harness(); h.capture.start(); h.tick(); expect(h.events.some(e => e.type === 'reconnect_scheduled')).toBe(true); await h.capture.stop();
  });
  it('sanitizes malformed frames, unknown types and symbols', async () => {
    const h = harness(); h.capture.start(); h.ack(); h.handlers[0]!.message('secret-not-json');
    h.frame([null, { ...bar, S: 'secret-symbol' }, { T: 'secret-channel' }, { ...bar, t: 'bad' }]);
    expect(h.observations).toHaveLength(0); expect(h.events.filter(e => e.type === 'malformed_frame')).toHaveLength(3);
    expect(JSON.stringify(h.events)).not.toContain('secret'); await h.capture.stop();
  });
  it('stops capture on injected disk failure', async () => {
    const h = harness(); h.capture.start(); h.ack(); h.failWriter(); h.frame([bar]);
    await Promise.resolve(); await h.capture.stop(); expect(h.result().finished).toBe(true); expect(h.timers.size).toBe(0);
  });
  it('requires the dedicated config and rejects legacy fallback or other feed', () => {
    expect(() => parseConfig({ ALPACA_API_KEY: 'x', ALPACA_API_SECRET: 'y', ALPACA_MARKET_DATA_FEED: 'iex' })).toThrow();
    expect(() => parseConfig({ ALPACA_MARKET_DATA_API_KEY: 'x', ALPACA_MARKET_DATA_API_SECRET: 'y', ALPACA_MARKET_DATA_FEED: 'sip' })).toThrow();
    expect(parseConfig({ ALPACA_MARKET_DATA_API_KEY: 'x', ALPACA_MARKET_DATA_API_SECRET: 'y', ALPACA_MARKET_DATA_FEED: 'iex' }).feed).toBe('iex');
  });
});
