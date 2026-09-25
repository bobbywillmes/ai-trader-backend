import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { AGGREGATOR_VERSION, ENDPOINT, FORMAT_VERSION, PARSER_VERSION, SYMBOLS } from './model.js';
import type { Observation, ResearchEvent } from './model.js';
import type { SessionPlan } from './session.js';

export type Manifest = { formatVersion: number; parserVersion: string; aggregatorVersion: string; gitCommit: string;
  nodeVersion: string; provider: 'ALPACA'; feed: 'IEX'; symbols: readonly string[]; channels: readonly string[];
  startedAt: string; runId: string; endpoint: string; session: SessionPlan; parentRunId?: string };
export function manifest(runId: string, startedAt: string, session: SessionPlan, gitCommit: string): Manifest {
  return { formatVersion: FORMAT_VERSION, parserVersion: PARSER_VERSION, aggregatorVersion: AGGREGATOR_VERSION,
    gitCommit, nodeVersion: process.version, provider: 'ALPACA', feed: 'IEX', symbols: SYMBOLS, channels: ['bars', 'updatedBars'],
    startedAt, runId, endpoint: ENDPOINT, session };
}
export interface AppendSink {
  observation(value: Observation): Promise<void>;
  event(value: ResearchEvent): Promise<void>;
  close(): Promise<void>;
}
/** Serialized fsync per record; bounded queue. Completion means the record has been flushed. */
export class Journal implements AppendSink {
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private failed = false;
  private closing = false;
  private constructor(private observations: FileHandle, private events: FileHandle) {}
  static async create(directory: string, identity: Manifest): Promise<Journal> {
    await mkdir(directory, { recursive: false }); // Unique run: never resume/overwrite an old segment.
    const metadata = await open(join(directory, 'manifest.json'), 'wx');
    try { await metadata.writeFile(JSON.stringify(identity, null, 2) + '\n'); await metadata.sync(); } finally { await metadata.close(); }
    const observations = await open(join(directory, 'observations-000001.ndjson'), 'ax');
    try { return new Journal(observations, await open(join(directory, 'events.ndjson'), 'ax')); }
    catch { await observations.close(); throw new Error('Journal creation failed'); }
  }
  private append(file: FileHandle, value: unknown): Promise<void> {
    const line = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.failed || this.closing || this.pendingBytes + bytes > 8 * 1024 * 1024) {
      this.failed = true; return Promise.reject(new Error('Journal unavailable or queue capacity exceeded'));
    }
    this.pendingBytes += bytes;
    const operation = this.tail.then(async () => {
      if (this.failed) throw new Error('Journal failed before append');
      await file.writeFile(line); await file.sync();
    });
    this.tail = operation.catch(() => { this.failed = true; }).finally(() => { this.pendingBytes -= bytes; });
    return operation;
  }
  observation(value: Observation): Promise<void> { return this.append(this.observations, value); }
  event(value: ResearchEvent): Promise<void> { return this.append(this.events, value); }
  async close(): Promise<void> {
    this.closing = true; await this.tail;
    const results = await Promise.allSettled([this.observations.close(), this.events.close()]);
    if (this.failed || results.some(r => r.status === 'rejected')) throw new Error('Journal did not close cleanly');
  }
}
/** Fail closed on a stale lock. Operator checks PID/host before manually removing it. */
export async function acquireCaptureLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const path = join(root, 'capture.lock');
  const lock = await open(path, 'wx');
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })); await lock.sync(); }
  finally { await lock.close(); }
  return () => unlink(path);
}
export async function readJournal(path: string): Promise<{ records: unknown[]; truncatedFinalLine: boolean }> {
  const content = await readFile(path, 'utf8');
  const lines = content.split('\n');
  const truncatedFinalLine = lines.pop() !== '';
  const records = lines.map(line => {
    if (!line.trim()) throw new Error('Empty interior journal record');
    try { return JSON.parse(line) as unknown; } catch { throw new Error('Corrupt interior journal record'); }
  });
  return { records, truncatedFinalLine };
}
