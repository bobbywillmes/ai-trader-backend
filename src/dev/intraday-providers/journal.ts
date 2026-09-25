import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, record, timestamp } from '../alpaca-iex/model.js';
import { readJournal } from '../alpaca-iex/journal.js';
import { sessionPlan } from '../alpaca-iex/session.js';
import { EVENT_TYPES, PRODUCTS, Versions, prices, unavailableValues, tiingoFrame, twelveTimestamp, type Datum, type Event, type Observation, type RunManifest } from './model.js';

export async function exclusiveJson(path: string, value: unknown) {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
}
export type Entry = { ordinal: number; previousHash: string; contentHash: string; value: Observation | Event };
/** Separate durable, hash-chained provider journal. Queue overflow fails that provider only. */
export class ProviderJournal {
  private tail = Promise.resolve();
  private pending = 0;
  private ordinal = 0;
  private previous = '';
  private failed = false;
  private closing = false;
  private constructor(private file: FileHandle) {}
  static async create(directory: string, manifest: RunManifest) {
    await mkdir(directory);
    await exclusiveJson(join(directory, 'manifest.json'), { ...manifest, contentHash: hash(manifest) });
    return new ProviderJournal(await open(join(directory, 'journal.ndjson'), 'ax'));
  }
  append(value: Observation | Event): Promise<void> {
    const body = { ordinal: ++this.ordinal, previousHash: this.previous, value };
    const entry = { ...body, contentHash: hash(body) }; this.previous = entry.contentHash;
    const line = JSON.stringify(entry) + '\n', bytes = Buffer.byteLength(line);
    if (this.failed || this.closing || this.pending + bytes > 8 * 1024 * 1024) {
      this.failed = true; return Promise.reject(new Error('Journal unavailable'));
    }
    this.pending += bytes;
    const operation = this.tail.then(async () => { if (this.failed) throw new Error('Journal failed'); await this.file.writeFile(line); await this.file.sync(); });
    this.tail = operation.catch(() => { this.failed = true; }).finally(() => { this.pending -= bytes; });
    return operation;
  }
  async close() { this.closing = true; await this.tail; await this.file.close(); if (this.failed) throw new Error('Journal failed'); }
}
export async function loadProviderRun(directory: string) {
  const { contentHash, ...raw } = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (hash(raw) !== contentHash || raw.version !== 1 || raw.authority !== 'RESEARCH_ONLY' || !['TIINGO', 'TWELVE_DATA'].includes(raw.provider)
    || !/^[a-f0-9]{40}$/.test(raw.gitCommit) || JSON.stringify(raw.symbols) !== '["SPY","RSP"]'
    || hash(raw.session) !== hash(sessionPlan(raw.session.date))) throw new Error('Invalid run manifest');
  timestamp(raw.startedAt);
  const manifest = raw as RunManifest, versions = new Versions(manifest.runId);
  const journal = await readJournal(join(directory, 'journal.ndjson'));
  const observations: Observation[] = [], events: Event[] = [];
  let previous = '';
  for (const [i, input] of journal.records.entries()) {
    if (!record(input)) throw new Error('Invalid journal');
    const { contentHash: checksum, ...body } = input;
    if (hash(body) !== checksum || body.previousHash !== previous || body.ordinal !== i + 1 || !record(body.value)) throw new Error('Journal chain mismatch');
    previous = checksum as string;
    const v = body.value;
    if ('type' in v) {
      if (!EVENT_TYPES.includes(v.type as Event['type']) || Object.keys(v).some(k => !['type', 'at', 'connectionEpoch', 'code'].includes(k))) throw new Error('Invalid event');
      timestamp(v.at); if (!Number.isSafeInteger(v.connectionEpoch) || (v.connectionEpoch as number) < 0 || (v.code !== undefined && !Number.isSafeInteger(v.code))) throw new Error('Invalid event envelope');
      events.push(v as Event); continue;
    }
    if (typeof v.product !== 'string' || !(v.product in PRODUCTS) || (v.symbol !== 'SPY' && v.symbol !== 'RSP')
      || !Number.isSafeInteger(v.connectionEpoch) || (v.connectionEpoch as number) < 0 || typeof v.monotonicOffsetMs !== 'number' || !Number.isFinite(v.monotonicOffsetMs) || v.monotonicOffsetMs < 0) throw new Error('Invalid observation');
    timestamp(v.receivedAt); if (v.requestedAt !== null) timestamp(v.requestedAt);
    let d: Datum;
    if (v.product === 'TIINGO_WS') {
      const parsed = tiingoFrame({ service: 'cons', messageType: 'A', data: [v.providerTimestamp, v.symbol, v.price] });
      if (!parsed.data[0]) throw new Error('Invalid reference price'); d = parsed.data[0];
    } else {
      if ((!record(v.values) && !record(v.unavailableValues)) || !['TIINGO_REST', 'TWELVE_DATA'].includes(v.product)) throw new Error('Invalid bar');
      if (record(v.values) && v.unavailableValues !== undefined) throw new Error('Conflicting value availability');
      if (record(v.unavailableValues) && !['open', 'high', 'low', 'close'].some(k => v.unavailableValues && (v.unavailableValues as Record<string, unknown>)[k] === null)) throw new Error('Invalid unavailable values');
      d = { product: v.product as 'TIINGO_REST' | 'TWELVE_DATA', symbol: v.symbol, providerTimestamp: v.providerTimestamp as string,
        startAt: v.product === 'TWELVE_DATA' ? twelveTimestamp(v.providerTimestamp) : timestamp(v.providerTimestamp, true), price: null,
        values: record(v.values) ? prices(v.values) : null,
        ...(record(v.unavailableValues) ? { unavailableValues: unavailableValues(v.unavailableValues) } : {}) };
    }
    const normalized = versions.observe(d, v as Observation);
    if (normalized.provider !== manifest.provider || hash(normalized) !== hash(v)) throw new Error('Observation provenance/version mismatch');
    observations.push(normalized);
  }
  return { manifest, observations, events, journalHash: previous, truncatedFinalLine: journal.truncatedFinalLine,
    cleanShutdown: !journal.truncatedFinalLine && events.at(-1)?.type === 'shutdown_complete',
    end: [manifest.startedAt, ...observations.map(o => o.receivedAt), ...events.map(e => e.at)].sort().at(-1)! };
}
