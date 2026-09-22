import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { etDate } from '../../services/market-calendar.js';
import { readBaseline, writeBaseline, fetchBaseline, baselineRange } from '../alpaca-iex/baseline.js';
import { boundedGet } from '../alpaca-iex/reference.js';
import { Capture } from '../alpaca-iex/capture.js';
import { parseConfig } from '../alpaca-iex/config.js';
import { acquireCaptureLock, Journal, manifest as alpacaManifest } from '../alpaca-iex/journal.js';
import { hash } from '../alpaca-iex/model.js';
import { sessionPlan } from '../alpaca-iex/session.js';
import { createNativeAlpacaIexTransport, requireNativeWebSocket } from '../alpaca-iex/transport.js';
import { ProviderCapture, nativeRequest, nativeSocket } from './capture.js';
import { exclusiveJson, ProviderJournal } from './journal.js';
import { PROVIDERS, pollSchedule, pollingBudget, type Provider, type RunManifest } from './model.js';

export type Experiment = { version: 1; authority: 'RESEARCH_ONLY'; experimentId: string; session: ReturnType<typeof sessionPlan>;
  gitCommit: string; captureCodeHash: string; symbols: readonly ['SPY', 'RSP']; startedAt: string; stopAt: string; baselineHash: string | null;
  runs: Record<Provider, string>; budgets: Record<'TIINGO' | 'TWELVE_DATA', ReturnType<typeof pollingBudget>> };
export function validateExperiment(value: Experiment) {
  if (value.version !== 1 || value.authority !== 'RESEARCH_ONLY' || hash(value.session) !== hash(sessionPlan(value.session.date))
    || !/^[a-f0-9]{40}$/.test(value.gitCommit) || !/^[\w-]{1,80}$/.test(value.experimentId)
    || !/^[a-f0-9]{64}$/.test(value.captureCodeHash)
    || JSON.stringify(value.symbols) !== '["SPY","RSP"]' || PROVIDERS.some(p => !/^[\w-]{1,80}$/.test(value.runs[p]))
    || new Set(Object.values(value.runs)).size !== 3) throw new Error('Invalid experiment');
}
export async function readExperiment(directory: string) {
  const { contentHash, ...value } = JSON.parse(await readFile(join(directory, 'experiment.json'), 'utf8'));
  if (hash(value) !== contentHash) throw new Error('Experiment hash mismatch');
  validateExperiment(value); return value as Experiment;
}
async function captureCodeHash() {
  const entries: [string, string][] = [];
  for (const directory of ['src/dev/alpaca-iex', 'src/dev/intraday-providers']) {
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts')).sort())
      entries.push([`${directory}/${name}`, await readFile(join(directory, name), 'utf8')]);
  }
  return hash(entries);
}
/** No fail-fast Promise.all: every child owns its lifecycle, even if a sibling fails. */
export async function supervise(children: { done: Promise<boolean>; stop(): void }[], onStop: (stop: () => void) => () => void) {
  const remove = onStop(() => children.forEach(child => child.stop()));
  try { return await Promise.all(children.map(child => child.done.catch(() => true))); }
  finally { remove(); }
}
export async function experimentMain(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { 'session-date': { type: 'string' }, 'duration-seconds': { type: 'string' },
    'baseline-dir': { type: 'string' }, 'output-dir': { type: 'string' } } });
  requireNativeWebSocket();
  const session = sessionPlan(values['session-date'] ?? etDate(new Date()));
  if (session.date !== etDate(new Date())) throw new Error('Capture must run on the selected session date');
  const duration = values['duration-seconds'] === undefined ? null : Number(values['duration-seconds']);
  if (duration !== null && (!Number.isSafeInteger(duration) || duration < 10 || duration > 28800)) throw new Error('Invalid duration');
  const startedAt = new Date().toISOString();
  const stopAt = new Date(duration === null ? Date.parse(session.closeAt) + 360000 : Date.now() + duration * 1000).toISOString();
  if (stopAt <= startedAt || Date.parse(stopAt) > Date.parse(session.closeAt) + 360000) throw new Error('Capture beyond bounded session horizon');
  const baseline = values['baseline-dir'] ? await readBaseline(resolve(values['baseline-dir'])) : null;
  if (baseline && (baseline.sessionDate !== session.date || baseline.calendarHash !== session.calendarHash)) throw new Error('Baseline session mismatch');
  if (!baseline && duration === null) throw new Error('Full session requires --baseline-dir; bounded smoke may omit baseline');
  const lockRoot = resolve('node_modules/.cache/intraday-stress-providers');
  const release = await acquireCaptureLock(lockRoot);
  try {
    const experimentId = randomUUID(), directory = join(resolve(values['output-dir'] ?? lockRoot), session.date, experimentId);
    const budgets = Object.fromEntries(['TIINGO', 'TWELVE_DATA'].map(p => [p, pollingBudget(pollSchedule(session, p as 'TIINGO' | 'TWELVE_DATA', startedAt).filter(t => t < Date.parse(stopAt)))])) as Experiment['budgets'];
    // Durable conservative daily reservation, shared across smoke/restarts in this checkout. Never refunds failed calls.
    const ledgerDir = join(lockRoot, 'budgets'); await mkdir(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, `${session.date}.ndjson`);
    let previous = '';
    try { previous = await readFile(ledgerPath, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const used = previous.trim() ? previous.trim().split('\n').map(line => JSON.parse(line) as { credits: number }) : [];
    if ((previous && !previous.endsWith('\n')) || used.some(r => !Number.isSafeInteger(r.credits) || r.credits < 0 || r.credits > 410)) throw new Error('Invalid budget ledger');
    if (used.reduce((n, r) => n + r.credits, 0) + budgets.TWELVE_DATA.dailyCredits > 700) throw new Error('Daily research reservation exhausted');
    const ledger = await open(ledgerPath, 'a');
    try { await ledger.writeFile(JSON.stringify({ experimentId, credits: budgets.TWELVE_DATA.dailyCredits }) + '\n'); await ledger.sync(); } finally { await ledger.close(); }
    const identity: Experiment = { version: 1, authority: 'RESEARCH_ONLY', experimentId, session, startedAt, stopAt,
      gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
      captureCodeHash: await captureCodeHash(),
      symbols: ['SPY', 'RSP'], baselineHash: baseline ? hash(baseline) : null,
      runs: { ALPACA: randomUUID(), TIINGO: randomUUID(), TWELVE_DATA: randomUUID() }, budgets };
    await mkdir(directory, { recursive: true });
    await exclusiveJson(join(directory, 'experiment.json'), { ...identity, contentHash: hash(identity) });
    if (baseline) await writeBaseline(directory, baseline);
    process.stdout.write(JSON.stringify({ authority: 'RESEARCH_ONLY', experimentId, sessionDate: session.date, providers: PROVIDERS, symbols: identity.symbols, directory, stopAt }) + '\n');
    const children = PROVIDERS.map(provider => {
      const child = fork(resolve('scripts/capture-intraday-provider.ts'), [directory, provider], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.on('message', value => {
        // Children send only allowlisted status. Do not forward raw process stderr or provider text.
        if (value && typeof value === 'object' && 'status' in value && typeof value.status === 'string'
          && /^[a-z_]{1,40}$/.test(value.status)) process.stdout.write(JSON.stringify({ provider, status: value.status }) + '\n');
      });
      const done = new Promise<boolean>(done => {
        child.on('error', () => done(true)); child.on('exit', code => {
          process.stdout.write(JSON.stringify({ provider, status: 'exited', failed: code !== 0 }) + '\n'); done(code !== 0);
        });
      });
      return { done, stop: () => { if (child.connected) child.send({ stop: true }, () => {}); } };
    });
    const failures = await supervise(children, stop => {
      const timer = setTimeout(stop, Math.max(0, Date.parse(stopAt) - Date.now()));
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      return () => { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
    });
    await exclusiveJson(join(directory, 'completion.json'), { at: new Date().toISOString(), failures: Object.fromEntries(PROVIDERS.map((p, i) => [p, failures[i]])) });
    if (failures.some(Boolean)) process.exitCode = 1;
  } finally { await release(); }
}

export async function childMain(args = process.argv.slice(2)) {
  if (args.length !== 2 || !PROVIDERS.includes(args[1] as Provider)) throw new Error('Invalid child arguments');
  requireNativeWebSocket();
  const directory = resolve(args[0]!), provider = args[1] as Provider, experiment = await readExperiment(directory);
  const runId = experiment.runs[provider], runDirectory = join(directory, runId);
  const release = await acquireCaptureLock(resolve(provider === 'ALPACA' ? 'node_modules/.cache/intraday-stress-alpaca-iex' : `node_modules/.cache/intraday-stress-providers-${provider.toLowerCase()}`)).catch(() => {
    if (process.connected) process.send?.({ status: 'capture_lock_unavailable' });
    throw new Error('Capture lock unavailable');
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => { watchdog ??= setTimeout(() => process.exit(1), 10000); };
  const status = (event: { type: string }) => {
    if (process.connected) process.send?.({ status: event.type });
    if (event.type === 'terminal_error' || event.type === 'writer_error' || event.type === 'shutdown_requested') armWatchdog();
  };
  let closeSink: (() => Promise<void>) | undefined;
  try {
    const startedAt = new Date().toISOString();
    const identity: RunManifest = { version: 1, authority: 'RESEARCH_ONLY', experimentId: experiment.experimentId, runId, provider,
      session: experiment.session, baselineHash: experiment.baselineHash, gitCommit: experiment.gitCommit, startedAt, symbols: ['SPY', 'RSP'] };
    let start: () => void, stopCapture: () => Promise<void>;
    let complete!: (failed: boolean) => void;
    const done = new Promise<boolean>(resolve => { complete = resolve; });
    if (provider === 'ALPACA') {
      const config = parseConfig(process.env);
      const sink = await Journal.create(runDirectory, alpacaManifest(runId, startedAt, experiment.session, experiment.gitCommit));
      closeSink = () => sink.close();
      await exclusiveJson(join(runDirectory, 'experiment-link.json'), identity);
      const capture = new Capture(runId, config, { transport: createNativeAlpacaIexTransport, sink, now: () => new Date(), monotonic: () => performance.now(),
        random: Math.random, schedule: (fn, ms) => setTimeout(fn, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>), status, finished: complete });
      start = () => capture.start(); stopCapture = () => capture.stop();
    } else {
      const token = process.env[provider === 'TIINGO' ? 'TIINGO_API_TOKEN' : 'TWELVE_DATA_API_KEY']?.trim();
      if (!token) throw new Error('Dedicated credential missing');
      const sink = await ProviderJournal.create(runDirectory, identity); closeSink = () => sink.close();
      const capture = new ProviderCapture(provider, runId, token, experiment.session, {
        now: Date.now, monotonic: () => performance.now(), schedule: (fn, ms) => setTimeout(fn, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>),
        socket: nativeSocket, request: nativeRequest, append: v => sink.append(v), close: () => sink.close(), status, finished: complete });
      start = () => capture.start(); stopCapture = () => capture.stop();
    }
    const stop = () => { armWatchdog(); void stopCapture(); };
    const message = (v: unknown) => { if (v && typeof v === 'object' && 'stop' in v && v.stop === true) stop(); };
    const deadline = setTimeout(stop, Math.max(0, Date.parse(experiment.stopAt) - Date.now()));
    process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('message', message); process.on('disconnect', stop);
    start(); const failed = await done; closeSink = undefined;
    clearTimeout(deadline); if (watchdog) clearTimeout(watchdog);
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('message', message); process.off('disconnect', stop);
    if (failed) process.exitCode = 1;
  } finally { if (closeSink) await closeSink().catch(() => undefined); await release(); }
}
export async function baselineMain(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { 'session-date': { type: 'string' }, 'output-dir': { type: 'string' } } });
  if (!values['session-date'] || !values['output-dir'] || !process.env.MASSIVE_API_KEY?.trim()) throw new Error('Explicit baseline config required');
  const plan = sessionPlan(values['session-date']);
  try { await readFile(join(resolve(values['output-dir']), 'reference/baseline/manifest.json')); throw new Error('Baseline already frozen'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  // Tomorrow's prior close must actually be complete before freezing it.
  if (Date.now() < Date.parse(sessionPlan(baselineRange(plan.date).previous).closeAt) + 1200000) throw new Error('Prior session not yet complete plus delay');
  await writeBaseline(resolve(values['output-dir']), await fetchBaseline(plan.date, process.env.MASSIVE_API_KEY.trim(), boundedGet()));
  process.stdout.write('Research baseline frozen.\n');
}
