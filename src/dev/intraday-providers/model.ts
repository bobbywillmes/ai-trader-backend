import { hash, record, timestamp, type Symbol } from '../alpaca-iex/model.js';
import type { SessionPlan } from '../alpaca-iex/session.js';

export const PROVIDERS = ['ALPACA', 'TIINGO', 'TWELVE_DATA'] as const;
export type Provider = typeof PROVIDERS[number];
export const PRODUCTS = {
  TIINGO_WS: { provider: 'TIINGO', feed: 'CONSOLIDATED_REFERENCE', sourceKind: 'DERIVED_REFERENCE_PRICE' },
  TIINGO_REST: { provider: 'TIINGO', feed: 'CONSOLIDATED_REFERENCE', sourceKind: 'PROVIDER_REFERENCE_OHLCV' },
  TWELVE_DATA: { provider: 'TWELVE_DATA', feed: 'US_EQUITIES_DEFAULT', sourceKind: 'PROVIDER_REST_MINUTE_BAR' },
} as const;
export type Product = keyof typeof PRODUCTS;
export type Prices = { open: number; high: number; low: number; close: number; volume: number | null };
export type UnavailableValues = { open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null };
export type Datum = { product: Product; symbol: Symbol; providerTimestamp: string; startAt: string;
  price: number | null; values: Prices | null; unavailableValues?: UnavailableValues };
export type Observation = Datum & { runId: string; ordinal: number; connectionEpoch: number; receivedAt: string;
  requestedAt: string | null; monotonicOffsetMs: number; firstSeenAt: string; revisionOrdinal: number;
  duplicate: boolean; payloadHash: string; valueHash: string } & (typeof PRODUCTS)[Product];
export const EVENT_TYPES = ['process_started', 'socket_connected', 'subscription_sent', 'subscription_confirmed', 'heartbeat',
  'socket_closed', 'transport_failure', 'reconnect_scheduled', 'auth_failure', 'malformed', 'unexpected_symbol',
  'unexpected_channel', 'null_bar', 'rate_limited', 'poll_started', 'poll_success', 'poll_skipped', 'budget_exhausted',
  'rest_transport_failure', 'clock_jump', 'shutdown_requested', 'shutdown_complete', 'terminal_error'] as const;
export type Event = { type: typeof EVENT_TYPES[number]; at: string; connectionEpoch: number; code?: number };
export type RunManifest = { version: 1; authority: 'RESEARCH_ONLY'; experimentId: string; runId: string; provider: Provider;
  session: SessionPlan; baselineHash: string | null; gitCommit: string; startedAt: string; symbols: readonly ['SPY', 'RSP'] };

export function numeric(value: unknown): number {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('Invalid numeric value');
  return value;
}
export function prices(row: Record<string, unknown>): Prices {
  const p = { open: numeric(row.open), high: numeric(row.high), low: numeric(row.low), close: numeric(row.close),
    volume: row.volume == null ? null : numeric(row.volume) };
  if (Math.min(p.open, p.low, p.close) <= 0 || p.high < Math.max(p.open, p.low, p.close) || p.low > Math.min(p.open, p.close)) throw new Error('Invalid OHLC');
  return p;
}
export function unavailableValues(row: Record<string, unknown>): UnavailableValues {
  return Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(k => [k, row[k] == null ? null : numeric(row[k])])) as UnavailableValues;
}
export type Parsed = { data: Datum[]; events: Event['type'][]; terminal: boolean; ready: boolean };
const result = (events: Event['type'][] = []): Parsed => ({ data: [], events, terminal: false, ready: false });
export function tiingoFrame(input: unknown): Parsed {
  if (!record(input)) return result(['malformed']);
  if (input.messageType === 'E' || (record(input.response) && typeof input.response.code === 'number' && input.response.code >= 400))
    return { ...result(['auth_failure']), terminal: true };
  if (input.messageType === 'H') return result(['heartbeat']);
  if (input.messageType === 'I') {
    const ready = record(input.response) && input.response.code === 200 && record(input.data)
      && (typeof input.data.subscriptionId === 'number' || typeof input.data.subscriptionId === 'string');
    return { ...result([ready ? 'subscription_confirmed' : 'unexpected_channel']), ready };
  }
  if (input.messageType !== 'A' || input.service !== 'cons') return result(['unexpected_channel']);
  const d = input.data;
  if (!Array.isArray(d) || d.length !== 3) return result(['malformed']);
  const symbol = typeof d[1] === 'string' ? d[1].toUpperCase() : '';
  if (symbol !== 'SPY' && symbol !== 'RSP') return result(['unexpected_symbol']);
  try {
    const at = timestamp(d[0]), price = numeric(d[2]);
    if (price <= 0) throw new Error();
    return { ...result(), data: [{ product: 'TIINGO_WS', symbol, providerTimestamp: d[0],
      startAt: new Date(Math.floor(Date.parse(at) / 60000) * 60000).toISOString(), price, values: null }] };
  } catch { return result(['malformed']); }
}
export function twelveTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error('Invalid UTC timestamp');
  return timestamp(value.replace(' ', 'T') + 'Z', true);
}
export function restBars(input: unknown, product: 'TWELVE_DATA' | 'TIINGO_REST', tiingoSymbol?: Symbol): Parsed {
  const output = result();
  const groups: [Symbol, unknown][] = product === 'TIINGO_REST' ? [[tiingoSymbol!, { values: input }]]
    : record(input) && ('SPY' in input || 'RSP' in input) ? [['SPY', input.SPY], ['RSP', input.RSP]] : [['SPY', input], ['RSP', input]];
  for (const [symbol, group] of groups) {
    if (!record(group)) { output.events.push('malformed'); continue; }
    if (group.code === 429) { output.events.push('rate_limited'); continue; }
    if (group.code === 401 || group.code === 403) { output.events.push('auth_failure'); output.terminal = true; continue; }
    if (product === 'TWELVE_DATA' && (group.status !== 'ok' || !record(group.meta) || group.meta.symbol !== symbol || group.meta.interval !== '1min')) {
      output.events.push('malformed'); continue;
    }
    if (!Array.isArray(group.values)) { output.events.push(group.values === null ? 'null_bar' : 'malformed'); continue; }
    for (const row of group.values) {
      if (!record(row)) { output.events.push('null_bar'); continue; }
      try {
        const providerTimestamp = product === 'TWELVE_DATA' ? row.datetime : row.date;
        const startAt = product === 'TWELVE_DATA' ? twelveTimestamp(providerTimestamp) : timestamp(providerTimestamp, true);
        if (['open', 'high', 'low', 'close'].some(k => row[k] == null)) {
          output.events.push('null_bar');
          output.data.push({ product, symbol, providerTimestamp: providerTimestamp as string, startAt, price: null, values: null, unavailableValues: unavailableValues(row) });
          continue;
        }
        output.data.push({ product, symbol, providerTimestamp: providerTimestamp as string, startAt, price: null, values: prices(row) });
      } catch { output.events.push('malformed'); }
    }
  }
  output.ready = output.data.some(d => d.values !== null);
  return output;
}
/** Version counters are local observations, never provider sequence numbers. All identical copies survive. */
export class Versions {
  private states = new Map<string, { firstSeenAt: string; hash: string; revision: number }>();
  private ordinal = 0;
  constructor(private runId: string) {}
  observe(d: Datum, receipt: { receivedAt: string; requestedAt: string | null; connectionEpoch: number; monotonicOffsetMs: number }): Observation {
    const key = `${d.product}/${d.symbol}/${d.startAt}`, valueHash = hash(d.unavailableValues ?? d.values ?? { price: d.price });
    const prior = this.states.get(key), duplicate = prior?.hash === valueHash;
    const state = { firstSeenAt: prior?.firstSeenAt ?? receipt.receivedAt, hash: valueHash, revision: (prior?.revision ?? 0) + (duplicate ? 0 : 1) };
    this.states.set(key, state);
    return { ...d, ...PRODUCTS[d.product], receivedAt: receipt.receivedAt, requestedAt: receipt.requestedAt,
      connectionEpoch: receipt.connectionEpoch, monotonicOffsetMs: receipt.monotonicOffsetMs, runId: this.runId, ordinal: ++this.ordinal,
      firstSeenAt: state.firstSeenAt, revisionOrdinal: state.revision, duplicate, valueHash, payloadHash: hash(d) };
  }
}
export function pollSchedule(plan: SessionPlan, provider: 'TWELVE_DATA' | 'TIINGO', startedAt: string): number[] {
  const open = Date.parse(plan.openAt), close = Date.parse(plan.closeAt), start = Date.parse(startedAt);
  // No catch-up bursts. TD: +10s every 2m through close+4m10s. Tiingo: each 15m target+2m, plus close+5m.
  const slots: number[] = [];
  if (provider === 'TWELVE_DATA') for (let t = Math.max(open + 10000, start + 120000); t <= close + 250000; t += 120000) slots.push(t);
  else { for (let t = open + 1020000; t <= close + 120000; t += 900000) slots.push(t); slots.push(close + 300000); }
  const future = slots.filter(t => t >= start);
  // One immediate authentication/data check, replacing a nearby slot rather than bursting.
  return [start, ...future.filter(t => t >= start + (provider === 'TWELVE_DATA' ? 120000 : 60000))];
}
export function pollingBudget(schedule: number[], credits = 2) {
  const maxPerMinute = Math.max(0, ...schedule.map(t => schedule.filter(s => s >= t && s < t + 60000).length * credits));
  return { requests: schedule.length, dailyCredits: schedule.length * credits, maxPerMinute };
}
