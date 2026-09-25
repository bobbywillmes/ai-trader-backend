import { createHash } from 'node:crypto';

export const FORMAT_VERSION = 1;
export const PARSER_VERSION = 'alpaca-iex-parser-1';
export const AGGREGATOR_VERSION = 'alpaca-iex-15m-1';
export const ENDPOINT = 'wss://stream.data.alpaca.markets/v2/iex';
export const SYMBOLS = ['SPY', 'RSP'] as const;
export type Symbol = typeof SYMBOLS[number];
export type Values = { open: number; high: number; low: number; close: number; volume: number; tradeCount?: number; vwap?: number };
export type Receipt = { runId: string; connectionEpoch: number; ordinal: number; frameOrdinal: number; elementIndex: number; receivedAt: string; monotonicOffsetMs: number };
export type Observation = Receipt & Values & {
  formatVersion: 1; provider: 'ALPACA'; feed: 'IEX'; symbol: Symbol;
  channel: 'bar' | 'updated_bar'; messageType: 'b' | 'u';
  providerTimestamp: string; minuteStartAt: string; payloadHash: string;
};
export const EVENT_TYPES = ['process_started', 'socket_connected', 'auth_sent', 'authenticated', 'subscription_sent',
  'subscription_confirmed', 'reconnect_scheduled', 'socket_closed', 'socket_error', 'malformed_frame',
  'unexpected_symbol', 'unexpected_channel', 'writer_error', 'shutdown_requested', 'shutdown_complete',
  'server_error', 'terminal_error', 'clock_jump'] as const;
export type ResearchEvent = { type: typeof EVENT_TYPES[number]; at: string; connectionEpoch: number;
  code?: number; delayMs?: number; frameOrdinal?: number; elementIndex?: number };
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function values(o: Values): Values {
  return { open: o.open, high: o.high, low: o.low, close: o.close, volume: o.volume,
    ...(o.tradeCount === undefined ? {} : { tradeCount: o.tradeCount }), ...(o.vwap === undefined ? {} : { vwap: o.vwap }) };
}
export function valueHash(o: Values): string { return hash(values(o)); }
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** Strict RFC3339: reject impossible dates, leap seconds and precision hidden by Date.parse. */
export function timestamp(value: unknown, minute = false): string {
  if (typeof value !== 'string') throw new Error('Invalid timestamp');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) !== m[1] || +m[2]! > 23 || +m[3]! > 59 || +m[4]! > 59
    || (m[6] !== 'Z' && (+m[6]!.slice(1, 3) > 23 || +m[6]!.slice(4) > 59))) throw new Error('Invalid timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || (minute && (ms % 60_000 !== 0 || /[1-9]/.test(m[5] ?? '')))) throw new Error('Invalid timestamp');
  return new Date(ms).toISOString();
}
function number(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER
    || (integer && !Number.isSafeInteger(value))) throw new Error('Unsafe number');
  return value;
}
export type ParseResult = { observation: Observation } | { error: 'malformed_frame' | 'unexpected_symbol' | 'unexpected_channel' };
export function normalize(input: unknown, receipt: Receipt): ParseResult {
  if (!record(input)) return { error: 'malformed_frame' };
  if (input.T !== 'b' && input.T !== 'u') return { error: 'unexpected_channel' };
  if (input.S !== 'SPY' && input.S !== 'RSP') return { error: 'unexpected_symbol' };
  try {
    const minuteStartAt = timestamp(input.t, true);
    const v: Values = { open: number(input.o), high: number(input.h), low: number(input.l), close: number(input.c), volume: number(input.v, true) };
    if (v.volume < 0 || v.high < Math.max(v.open, v.close, v.low) || v.low > Math.min(v.open, v.close, v.high)) throw new Error('Invalid values');
    if (input.n !== undefined) { v.tradeCount = number(input.n, true); if (v.tradeCount < 0) throw new Error('Invalid count'); }
    if (input.vw !== undefined) v.vwap = number(input.vw);
    const payloadHash = hash({ symbol: input.S, minuteStartAt, ...values(v) });
    return { observation: { ...receipt, ...v, formatVersion: FORMAT_VERSION, provider: 'ALPACA', feed: 'IEX', symbol: input.S,
      channel: input.T === 'b' ? 'bar' : 'updated_bar', messageType: input.T, providerTimestamp: input.t as string, minuteStartAt, payloadHash } };
  } catch { return { error: 'malformed_frame' }; }
}
/** Journals are validated again on load; corrupt evidence must not be repaired implicitly. */
export function validateObservation(input: unknown): Observation {
  if (!record(input) || input.formatVersion !== FORMAT_VERSION || input.provider !== 'ALPACA' || input.feed !== 'IEX'
    || typeof input.runId !== 'string' || !input.runId || !Number.isSafeInteger(input.ordinal) || (input.ordinal as number) < 1
    || !Number.isSafeInteger(input.connectionEpoch) || (input.connectionEpoch as number) < 1
    || !Number.isSafeInteger(input.frameOrdinal) || (input.frameOrdinal as number) < 1
    || !Number.isSafeInteger(input.elementIndex) || (input.elementIndex as number) < 0
    || typeof input.monotonicOffsetMs !== 'number' || !Number.isFinite(input.monotonicOffsetMs) || input.monotonicOffsetMs < 0)
    throw new Error('Invalid observation envelope');
  timestamp(input.receivedAt);
  const parsed = normalize({ T: input.messageType, S: input.symbol, t: input.providerTimestamp, o: input.open,
    h: input.high, l: input.low, c: input.close, v: input.volume, n: input.tradeCount, vw: input.vwap }, input as Receipt);
  if ('error' in parsed || parsed.observation.channel !== input.channel || parsed.observation.minuteStartAt !== input.minuteStartAt
    || parsed.observation.payloadHash !== input.payloadHash) throw new Error('Invalid normalized observation');
  return parsed.observation;
}
