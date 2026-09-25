import type { SessionPlan } from '../alpaca-iex/session.js';
import { Versions, pollSchedule, pollingBudget, restBars, tiingoFrame, type Event, type Observation, type Parsed, type Provider } from './model.js';

export interface Socket { send(data: string): void; close(): void; isClosed(): boolean; dispose(): void }
export type SocketFactory = (handlers: { open(): void; message(data: unknown): void; close(): void; error(): void }) => Socket;
export type Request = (url: URL, headers: Record<string, string>, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;
export type Dependencies = {
  now(): number; monotonic(): number; schedule(fn: () => void, ms: number): unknown; cancel(timer: unknown): void;
  socket: SocketFactory; request: Request;
  append(value: Observation | Event): Promise<void>; close(): Promise<void>; status(event: Event): void; finished(failed: boolean): void;
};
export const nativeSocket: SocketFactory = handlers => {
  const socket = new WebSocket('wss://api.tiingo.com/equity/intraday');
  const onOpen = () => handlers.open(), onMessage = (e: { data: unknown }) => handlers.message(e.data);
  const onClose = () => handlers.close(), onError = () => handlers.error();
  socket.addEventListener('open', onOpen); socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose); socket.addEventListener('error', onError);
  return { send: data => socket.send(data), close: () => socket.close(), isClosed: () => socket.readyState === WebSocket.CLOSED,
    dispose: () => { socket.removeEventListener('open', onOpen); socket.removeEventListener('message', onMessage); socket.removeEventListener('close', onClose); } };
};
export const nativeRequest: Request = async (url, headers, signal) => {
  const request = globalThis.fetch;
  const response = await request(url, { headers, signal, redirect: 'error' });
  // Bound body size and never let provider text/error objects escape the transport boundary.
  if (!response.ok) { await response.body?.cancel(); return { status: response.status, body: null }; }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 2 * 1024 * 1024) throw new Error('Response limit'); chunks.push(part.value); }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } finally { await reader.cancel().catch(() => undefined); }
};

/** One instance per child process. WS and REST share identity but REST failure never tears down WS. */
export class ProviderCapture {
  private readonly versions: Versions;
  private readonly origin: number;
  private epoch = 0;
  private attempts = 0;
  private socket: Socket | undefined;
  private retired: Socket | undefined;
  private timers = new Set<unknown>();
  private handshake: unknown;
  private ready = false;
  private stopped = false;
  private failed = false;
  private shutdown: Promise<void> | undefined;
  private pollTask: Promise<void> = Promise.resolve();
  private abort: AbortController | undefined;
  private lastClock: { wall: number; mono: number } | undefined;
  private restStopped = false;
  constructor(private provider: Exclude<Provider, 'ALPACA'>, runId: string, private token: string, private plan: SessionPlan, private deps: Dependencies) {
    this.versions = new Versions(runId); this.origin = deps.monotonic();
  }
  private later(fn: () => void, ms: number) {
    const timer = this.deps.schedule(() => { this.timers.delete(timer); if (!this.stopped) fn(); }, Math.max(0, ms));
    this.timers.add(timer); return timer;
  }
  private emit(type: Event['type'], code?: number) {
    const e: Event = { type, at: new Date(this.deps.now()).toISOString(), connectionEpoch: this.epoch, ...(code === undefined ? {} : { code }) };
    this.deps.status(e); void this.deps.append(e).catch(() => this.writerFailed());
  }
  private writerFailed() { this.failed = true; void this.stop(true); }
  private receipt(requestedAt: string | null) {
    const wall = this.deps.now(), mono = this.deps.monotonic() - this.origin;
    if (this.lastClock && Math.abs(wall - this.lastClock.wall - (mono - this.lastClock.mono)) > 1000) this.emit('clock_jump');
    this.lastClock = { wall, mono };
    return { receivedAt: new Date(wall).toISOString(), monotonicOffsetMs: mono, connectionEpoch: this.epoch, requestedAt };
  }
  private record(parsed: Parsed, receipt: ReturnType<ProviderCapture['receipt']>) {
    for (const event of parsed.events) this.emit(event);
    for (const d of parsed.data) void this.deps.append(this.versions.observe(d, receipt)).catch(() => this.writerFailed());
  }
  start() {
    this.emit('process_started');
    if (this.provider === 'TIINGO') this.connect();
    const slots = pollSchedule(this.plan, this.provider, new Date(this.deps.now()).toISOString());
    const budget = pollingBudget(slots);
    if (budget.dailyCredits > (this.provider === 'TWELVE_DATA' ? 410 : 60) || budget.maxPerMinute > 2) throw new Error('Unsafe polling budget');
    const next = (index: number) => {
      if (this.stopped || this.restStopped || index >= slots.length) return;
      this.later(() => {
        // A suspended host skips stale slots, never spends missed credits in a burst.
        if (this.deps.now() - slots[index]! > 60000) { this.emit('poll_skipped'); next(index + 1); return; }
        this.pollTask = this.poll().catch(() => { this.emit('rest_transport_failure'); }).finally(() => next(index + 1));
      }, slots[index]! - this.deps.now());
    };
    next(0);
  }
  private connect() {
    if (this.stopped) return;
    if (this.retired && !this.retired.isClosed()) { this.retry(); return; }
    this.retired = undefined; const epoch = ++this.epoch; this.ready = false;
    const current = () => !this.stopped && epoch === this.epoch && !!this.socket;
    try {
      this.socket = this.deps.socket({ open: () => {
        if (!current()) return; this.emit('socket_connected');
        try { this.socket!.send(JSON.stringify({ eventName: 'subscribe', authorization: this.token,
          eventData: { thresholdLevel: 6, tickers: ['spy', 'rsp'] } })); this.emit('subscription_sent'); }
        catch { this.retry(); }
      }, message: data => {
        if (!current()) return; const receipt = this.receipt(null);
        let parsed: Parsed;
        try { if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) throw new Error(); parsed = tiingoFrame(JSON.parse(data)); }
        catch { this.emit('malformed'); return; }
        if (parsed.ready) { this.ready = true; this.deps.cancel(this.handshake); this.timers.delete(this.handshake); }
        if (parsed.data.length && !this.ready) this.emit('unexpected_channel');
        this.record(parsed, receipt);
        if (parsed.terminal) { this.emit('terminal_error'); void this.stop(true); }
      }, close: () => { if (current()) { this.emit('socket_closed'); this.retry(); } },
      error: () => { if (current()) { this.emit('transport_failure'); this.retry(); } } });
      this.handshake = this.later(() => { this.emit('transport_failure'); this.retry(); }, 10000);
    } catch { this.emit('transport_failure'); this.retry(); }
  }
  private detach() {
    if (this.handshake !== undefined) { this.deps.cancel(this.handshake); this.timers.delete(this.handshake); }
    if (this.socket) { this.retired = this.socket; this.socket = undefined; this.retired.dispose(); try { this.retired.close(); } catch { /* Sanitized only. */ } }
  }
  private retry() {
    this.detach();
    if (++this.attempts > 8) { this.emit('terminal_error'); void this.stop(true); return; }
    this.emit('reconnect_scheduled'); this.later(() => this.connect(), Math.min(30000, 1000 * 2 ** (this.attempts - 1)));
  }
  private async poll() {
    const symbols = this.provider === 'TIINGO' ? ['SPY', 'RSP'] as const : ['SPY'] as const;
    for (const symbol of symbols) {
      if (this.stopped || this.restStopped) return;
      const requestedAt = new Date(this.deps.now()).toISOString();
      const url = this.provider === 'TIINGO' ? new URL(`https://api.tiingo.com/tiingo/equity/intraday/${symbol.toLowerCase()}/prices`)
        : new URL('https://api.twelvedata.com/time_series');
      url.search = new URLSearchParams(this.provider === 'TIINGO'
        ? { startDate: this.plan.date, endDate: this.plan.date, resampleFreq: '1min', columns: 'open,high,low,close,volume', afterHours: 'false', forceFill: 'false' }
        : { symbol: 'SPY,RSP', interval: '1min', outputsize: '8', timezone: 'UTC', prepost: 'false', adjust: 'none', apikey: this.token }).toString();
      const headers = this.provider === 'TIINGO' ? { Authorization: `Token ${this.token}` } : {};
      this.abort = new AbortController();
      const timeout = this.deps.schedule(() => this.abort?.abort(), 20000);
      this.emit('poll_started');
      try {
        const response = await this.deps.request(url, headers, this.abort.signal);
        const receipt = this.receipt(requestedAt);
        if (this.stopped) return;
        if (response.status === 429) { this.emit('rate_limited', 429); return; }
        if (response.status === 401 || response.status === 403) { this.emit('auth_failure', response.status); this.restStopped = true; this.failed = true; return; }
        if (response.status !== 200) { this.emit('rest_transport_failure', response.status); return; }
        const parsed = restBars(response.body, this.provider === 'TIINGO' ? 'TIINGO_REST' : 'TWELVE_DATA', symbol);
        this.record(parsed, receipt);
        if (parsed.ready) this.emit('poll_success');
        if (parsed.terminal) { this.restStopped = true; this.failed = true; }
      } catch { if (!this.stopped) this.emit('rest_transport_failure'); }
      finally { this.deps.cancel(timeout); this.abort = undefined; }
    }
  }
  stop(failed = false): Promise<void> {
    this.failed ||= failed;
    if (this.shutdown) return this.shutdown;
    this.stopped = true; for (const t of this.timers) this.deps.cancel(t); this.timers.clear(); this.detach(); this.abort?.abort();
    this.shutdown = (async () => {
      try {
        this.emit('shutdown_requested'); await this.pollTask;
        for (let i = 0; this.retired && !this.retired.isClosed() && i < 100; i++) await new Promise<void>(done => this.deps.schedule(done, 50));
        if (this.retired && !this.retired.isClosed()) throw new Error('Socket close timeout');
        await this.deps.append({ type: 'shutdown_complete', at: new Date(this.deps.now()).toISOString(), connectionEpoch: this.epoch });
      } catch { this.failed = true; }
      try { await this.deps.close(); } catch { this.failed = true; }
      this.deps.finished(this.failed);
    })();
    return this.shutdown;
  }
}
