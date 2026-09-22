import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { etDate } from '../../services/market-calendar.js';
import { analyze } from './analyze.js';
import { Capture } from './capture.js';
import { parseConfig } from './config.js';
import { acquireCaptureLock, Journal, manifest, readJournal } from './journal.js';
import type { Manifest } from './journal.js';
import { AGGREGATOR_VERSION, ENDPOINT, EVENT_TYPES, FORMAT_VERSION, PARSER_VERSION, hash, record, timestamp, validateObservation } from './model.js';
import type { Observation, ResearchEvent } from './model.js';
import { sessionPlan } from './session.js';
import { createNativeAlpacaIexTransport, requireNativeWebSocket } from './transport.js';

export async function captureMain(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { 'session-date': { type: 'string' }, 'output-dir': { type: 'string' }, 'parent-run-id': { type: 'string' } } });
  requireNativeWebSocket();
  const config = parseConfig(process.env);
  const plan = sessionPlan(values['session-date'] ?? etDate(new Date()));
  const root = resolve(values['output-dir'] ?? 'node_modules/.cache/intraday-stress-alpaca-iex');
  // Lock ownership is repository-local even when output is redirected.
  const release = await acquireCaptureLock(resolve('node_modules/.cache/intraday-stress-alpaca-iex'));
  let sink: Journal | undefined;
  try {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const identity = manifest(runId, startedAt, plan, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    if (values['parent-run-id']) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(values['parent-run-id'])) throw new Error('Invalid parent run ID');
      identity.parentRunId = values['parent-run-id'];
    }
    await mkdir(join(root, plan.date), { recursive: true });
    const directory = join(root, plan.date, runId);
    sink = await Journal.create(directory, identity);
    process.stderr.write(`Research-only capture: ${directory}\n`);
    const journal = sink;
    await new Promise<void>(resolveDone => {
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const armShutdownWatchdog = () => {
        if (!shutdownTimer) shutdownTimer = setTimeout(() => {
          process.stderr.write('Research shutdown timed out; preserve the run and inspect its journal.\n');
          process.exit(1); // Deliberately leaves a lock/crash artifact if filesystem drain hangs.
        }, 10_000);
      };
      const capture = new Capture(runId, config, { transport: createNativeAlpacaIexTransport, sink: journal,
        now: () => new Date(), monotonic: () => performance.now(), random: Math.random,
        schedule: (fn, delay) => setTimeout(fn, delay), cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
        status: event => {
          process.stderr.write(`${JSON.stringify(event)}\n`);
          if (event.type === 'terminal_error' || event.type === 'writer_error') armShutdownWatchdog();
        },
        finished: failed => {
          if (shutdownTimer) clearTimeout(shutdownTimer);
          process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
          process.exitCode = failed ? 1 : 0; resolveDone();
        } });
      const stop = () => {
        armShutdownWatchdog();
        void capture.stop();
      };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      capture.start();
    });
    sink = undefined;
  } finally {
    if (sink) await sink.close().catch(() => undefined);
    await release();
  }
}
export async function analyzeMain(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { cutoff: { type: 'string' } } });
  if (positionals.length !== 1) throw new Error('Usage: analyze <run-directory> [--cutoff RFC3339]');
  const directory = resolve(positionals[0]!);
  const { identity, observations, events, end, crashArtifacts } = await loadRun(directory);
  const cutoff = values.cutoff ? timestamp(values.cutoff) : end;
  if (Date.parse(cutoff) > Date.parse(end)) throw new Error('Cutoff exceeds recorded observation horizon');
  const report = analyze(identity, observations, events, cutoff);
  process.stdout.write(JSON.stringify({ ...report, eventHash: hash(events), crashArtifacts,
    cleanShutdown: events.at(-1)?.type === 'shutdown_complete' }, null, 2) + '\n');
}
export async function loadRun(directory: string) {
  const raw: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (!record(raw) || raw.formatVersion !== FORMAT_VERSION || raw.parserVersion !== PARSER_VERSION || raw.aggregatorVersion !== AGGREGATOR_VERSION
    || raw.provider !== 'ALPACA' || raw.feed !== 'IEX' || raw.endpoint !== ENDPOINT || typeof raw.runId !== 'string'
    || typeof raw.gitCommit !== 'string' || !/^[a-f0-9]{40}$/.test(raw.gitCommit) || typeof raw.nodeVersion !== 'string'
    || !record(raw.session) || typeof raw.session.date !== 'string'
    || JSON.stringify(raw.symbols) !== '["SPY","RSP"]' || JSON.stringify(raw.channels) !== '["bars","updatedBars"]') throw new Error('Unsupported manifest');
  timestamp(raw.startedAt);
  const plan = sessionPlan(raw.session.date);
  if (JSON.stringify(raw.session) !== JSON.stringify(plan)) throw new Error('Calendar snapshot mismatch');
  const identity = raw as Manifest;
  const names = (await readdir(directory)).filter(n => /^observations-\d{6}\.ndjson$/.test(n)).sort();
  if (!names.length) throw new Error('No observation segments');
  if (names.some((name, i) => name !== `observations-${String(i + 1).padStart(6, '0')}.ndjson`)) throw new Error('Missing observation segment');
  const observations: Observation[] = [];
  const crashArtifacts: string[] = [];
  for (const name of names) {
    const journal = await readJournal(join(directory, name));
    if (journal.truncatedFinalLine) crashArtifacts.push(name);
    observations.push(...journal.records.map(validateObservation));
  }
  if (observations.some((o, i) => o.runId !== identity.runId || (i > 0 && o.ordinal <= observations[i - 1]!.ordinal))) throw new Error('Journal order/identity mismatch');
  const eventJournal = await readJournal(join(directory, 'events.ndjson'));
  if (eventJournal.truncatedFinalLine) crashArtifacts.push('events.ndjson');
  const events = eventJournal.records.map(value => {
    if (!record(value) || !EVENT_TYPES.includes(value.type as ResearchEvent['type']) || !Number.isSafeInteger(value.connectionEpoch)
      || Object.keys(value).some(k => !['type', 'at', 'connectionEpoch', 'code', 'delayMs', 'frameOrdinal', 'elementIndex'].includes(k))) throw new Error('Invalid event record');
    timestamp(value.at);
    for (const key of ['code', 'delayMs', 'frameOrdinal', 'elementIndex']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw new Error('Invalid event number');
    return value as ResearchEvent;
  });
  const end = [identity.startedAt, ...observations.map(o => o.receivedAt), ...events.map(e => e.at)].sort().at(-1)!;
  return { identity, observations, events, end, crashArtifacts };
}
