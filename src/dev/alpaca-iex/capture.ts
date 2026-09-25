import type { DataConfig } from './config.js';
import type { AppendSink } from './journal.js';
import { normalize, record, SYMBOLS } from './model.js';
import type { ResearchEvent } from './model.js';
import type { AlpacaIexTransport, TransportFactory } from './transport.js';

export type CaptureDependencies = {
  transport: TransportFactory; sink: AppendSink; now(): Date; monotonic(): number; random(): number;
  schedule(callback: () => void, delayMs: number): unknown; cancel(timer: unknown): void;
  status(event: ResearchEvent): void; finished(failed: boolean): void;
};
/** Single-process, bounded reconnect budget. No heartbeat or provider sequence assumptions. */
export class Capture {
  private epoch = 0;
  private ordinal = 0;
  private frame = 0;
  private attempts = 0;
  private socket: AlpacaIexTransport | undefined;
  private retiringSocket: AlpacaIexTransport | undefined;
  private reconnect: unknown;
  private handshake: unknown;
  private stopped = false;
  private failed = false;
  private shutdown: Promise<void> | undefined;
  private stage: 'connecting' | 'auth' | 'subscribe' | 'active' = 'connecting';
  private readonly origin: number;
  private lastReceipt: { wall: number; mono: number } | undefined;
  constructor(private runId: string, private config: DataConfig, private deps: CaptureDependencies) { this.origin = deps.monotonic(); }
  private event(type: ResearchEvent['type'], detail: Partial<Pick<ResearchEvent, 'code' | 'delayMs' | 'frameOrdinal' | 'elementIndex'>> = {}): void {
    const event: ResearchEvent = { type, at: this.deps.now().toISOString(), connectionEpoch: this.epoch, ...detail };
    this.deps.status(event);
    void this.deps.sink.event(event).catch(() => this.writerFailure());
  }
  private writerFailure(): void {
    if (this.failed && this.stopped) return;
    this.failed = true;
    // A failed disk cannot reliably journal its own failure; stderr/status is the fallback.
    this.deps.status({ type: 'writer_error', at: this.deps.now().toISOString(), connectionEpoch: this.epoch });
    void this.stop(true);
  }
  start(): void { if (this.epoch || this.stopped) throw new Error('Capture already started'); this.event('process_started'); this.connect(); }
  private connect(): void {
    if (this.stopped) return;
    // Native close is asynchronous. Never open another socket until the old one is closed.
    if (this.retiringSocket && !this.retiringSocket.isClosed()) { this.event('socket_error'); this.retry(); return; }
    this.retiringSocket = undefined;
    this.epoch++; this.stage = 'connecting';
    const epoch = this.epoch;
    try {
      this.socket = this.deps.transport({
        message: data => { if (!this.stopped && epoch === this.epoch && this.socket) this.message(data); },
        close: code => { if (!this.stopped && epoch === this.epoch && this.socket) { this.event('socket_closed', { code }); this.retry(); } },
        error: () => { if (!this.stopped && epoch === this.epoch && this.socket) { this.event('socket_error'); this.retry(); } },
      });
      this.handshake = this.deps.schedule(() => { this.handshake = undefined; this.event('socket_error'); this.retry(); }, 10_000);
    } catch { this.event('socket_error'); this.retry(); }
  }
  private detach(): void {
    if (this.handshake !== undefined) this.deps.cancel(this.handshake);
    this.handshake = undefined;
    const socket = this.socket; this.socket = undefined;
    if (socket) this.retiringSocket = socket;
    socket?.dispose();
    try { socket?.close(); } catch { /* No exception payload leaves the transport boundary. */ }
  }
  private retry(): void {
    if (this.stopped || this.reconnect !== undefined) return;
    this.detach();
    if (++this.attempts > 8) { this.event('terminal_error'); void this.stop(true); return; }
    const delayMs = Math.floor(Math.min(30_000, 500 * 2 ** (this.attempts - 1)) * (0.5 + this.deps.random() * 0.5));
    this.event('reconnect_scheduled', { delayMs });
    this.reconnect = this.deps.schedule(() => { this.reconnect = undefined; this.connect(); }, delayMs);
  }
  private send(payload: unknown): boolean {
    try { this.socket!.send(JSON.stringify(payload)); return true; }
    catch { this.event('socket_error'); this.retry(); return false; }
  }
  private message(data: unknown): void {
    // One receipt stamp per frame, before JSON parsing or append work.
    const receivedAt = this.deps.now().toISOString();
    const monotonicOffsetMs = this.deps.monotonic() - this.origin;
    const wall = Date.parse(receivedAt);
    if (this.lastReceipt && Math.abs(wall - this.lastReceipt.wall - (monotonicOffsetMs - this.lastReceipt.mono)) > 1_000) this.event('clock_jump');
    this.lastReceipt = { wall, mono: monotonicOffsetMs };
    const frameOrdinal = ++this.frame;
    let elements: unknown;
    try { if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) throw new Error(); elements = JSON.parse(data); }
    catch { this.event('malformed_frame', { frameOrdinal }); return; }
    if (!Array.isArray(elements)) { this.event('malformed_frame', { frameOrdinal }); return; }
    for (const [elementIndex, element] of elements.entries()) {
      if (this.stopped || !this.socket) break;
      if (!record(element)) { this.event('malformed_frame', { frameOrdinal, elementIndex }); continue; }
      if (element.T === 'success') {
        if (element.msg === 'connected' && this.stage === 'connecting') {
          this.event('socket_connected'); this.stage = 'auth';
          if (this.send({ action: 'auth', key: this.config.key, secret: this.config.secret })) this.event('auth_sent');
        } else if (element.msg === 'authenticated' && this.stage === 'auth') {
          this.event('authenticated'); this.stage = 'subscribe';
          if (this.send({ action: 'subscribe', bars: SYMBOLS, updatedBars: SYMBOLS })) this.event('subscription_sent');
        } else { this.event('terminal_error'); void this.stop(true); }
      } else if (element.T === 'subscription') {
        const exact = (v: unknown) => Array.isArray(v) && v.length === 2 && [...v].sort().join(',') === 'RSP,SPY';
        const otherChannelsEmpty = Object.entries(element).every(([key, value]) => ['T', 'bars', 'updatedBars'].includes(key) || (Array.isArray(value) && value.length === 0));
        if (this.stage !== 'subscribe' || !exact(element.bars) || !exact(element.updatedBars) || !otherChannelsEmpty) {
          this.event('terminal_error'); void this.stop(true);
        } else {
          this.stage = 'active'; if (this.handshake !== undefined) this.deps.cancel(this.handshake); this.handshake = undefined;
          this.event('subscription_confirmed');
        }
      } else if (element.T === 'error') {
        const code = typeof element.code === 'number' && Number.isSafeInteger(element.code) ? element.code : 0;
        this.event('server_error', { code });
        if ([406, 407, 500].includes(code)) this.retry(); else { this.event('terminal_error', { code }); void this.stop(true); }
      } else {
        const result = normalize(element, { runId: this.runId, connectionEpoch: this.epoch, ordinal: ++this.ordinal,
          frameOrdinal, elementIndex, receivedAt, monotonicOffsetMs });
        if ('error' in result) this.event(result.error, { frameOrdinal, elementIndex });
        else {
          // Preserve valid evidence even if the provider violates acknowledgment ordering; flag the anomaly.
          if (this.stage !== 'active') this.event('unexpected_channel', { frameOrdinal, elementIndex });
          void this.deps.sink.observation(result.observation).catch(() => this.writerFailure());
        }
      }
    }
  }
  stop(failed = false): Promise<void> {
    this.failed ||= failed;
    if (this.shutdown) return this.shutdown;
    this.stopped = true;
    if (this.reconnect !== undefined) this.deps.cancel(this.reconnect);
    this.reconnect = undefined; this.detach();
    this.shutdown = (async () => {
      try {
        await this.deps.sink.event({ type: 'shutdown_requested', at: this.deps.now().toISOString(), connectionEpoch: this.epoch });
        // Native WebSocket has no terminate API. Bound close-wait before the final journal record.
        for (let i = 0; this.retiringSocket && !this.retiringSocket.isClosed() && i < 100; i++) {
          await new Promise<void>(resolve => { this.deps.schedule(resolve, 50); });
        }
        if (this.retiringSocket && !this.retiringSocket.isClosed()) throw new Error('Socket close timeout');
        await this.deps.sink.event({ type: 'shutdown_complete', at: this.deps.now().toISOString(), connectionEpoch: this.epoch });
      } catch { this.failed = true; }
      try { await this.deps.sink.close(); } catch { this.failed = true; }
      this.deps.finished(this.failed);
    })();
    return this.shutdown;
  }
}
