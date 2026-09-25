import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRun } from './cli.js';
import { parseConfig } from './config.js';
import { boundedGet, fetchAlpaca, fetchMassive, fetchIdentity, readReference, readReferences, writeReference, type Reference } from './reference.js';
import { fetchBaseline, readBaseline, writeBaseline } from './baseline.js';
import { compareRun, markdownReport } from './compare.js';

export async function phaseBMain(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'run-dir': { type: 'string' }, 'alpaca-fetch-id': { type: 'string' }, 'massive-fetch-id': { type: 'string' }, timeframes: { type: 'string' } } });
  const command = positionals[0];
  if (positionals.length !== 1 || !['alpaca', 'massive', 'baseline', 'compare'].includes(command ?? '') || !values['run-dir']) throw new Error('Expected command and --run-dir');
  if (values.timeframes && values.timeframes !== '1Min,15Min') throw new Error('Both 1Min,15Min are required');
  const directory = resolve(values['run-dir']), run = await loadRun(directory);
  const { identity, end } = run;
  if (command === 'compare') {
    if (!values['alpaca-fetch-id'] || !values['massive-fetch-id']) throw new Error('Explicit fetch IDs or latest are required');
    const alpaca = await readReference(directory, 'ALPACA', values['alpaca-fetch-id']);
    const massive = await readReference(directory, 'MASSIVE', values['massive-fetch-id']);
    const baseline = await readBaseline(directory);
    const report = compareRun(run, alpaca, massive, baseline, await readReferences(directory, 'MASSIVE'), await readReferences(directory, 'ALPACA'));
    const output = join(directory, 'derived', `phase-b-${randomUUID()}`);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(output, 'summary.md'), markdownReport(report), { flag: 'wx' });
    process.stdout.write(`${output}\n`); return;
  }
  if (run.crashArtifacts.length) throw new Error('Capture has crash tails; review before reference fetch');
  const get = boundedGet();
  if (command === 'baseline') {
    try { await access(join(directory, 'reference', 'baseline', 'manifest.json')); throw new Error('Frozen baseline already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const key = process.env.MASSIVE_API_KEY?.trim(); if (!key) throw new Error('MASSIVE_API_KEY required');
    await writeBaseline(directory, await fetchBaseline(identity.session.date, key, get));
    process.stdout.write(`${join(directory, 'reference', 'baseline', 'manifest.json')}\n`); return;
  }
  // Minute reference includes only whole elapsed minutes. Official 15m can include a partial last interval;
  // comparison excludes that interval until its target has elapsed.
  const range = { startAt: new Date(Math.max(Date.parse(identity.session.openAt), Math.ceil(Date.parse(identity.startedAt) / 60000) * 60000)).toISOString(),
    endAt: new Date(Math.min(Date.parse(identity.session.closeAt), Math.floor(Date.parse(end) / 60000) * 60000)).toISOString() };
  let data;
  if (command === 'alpaca') data = await fetchAlpaca(parseConfig(process.env), range, get);
  else { const key = process.env.MASSIVE_API_KEY?.trim(); if (!key) throw new Error('MASSIVE_API_KEY required'); data = await fetchMassive(key, range, get); }
  const reference: Reference = { version: 1, authority: 'RESEARCH_ONLY', provider: command === 'alpaca' ? 'ALPACA' : 'MASSIVE',
    ...(command === 'alpaca' ? { feed: 'IEX' as const } : {}), ...fetchIdentity(), runId: identity.runId, sessionDate: identity.session.date,
    range, complete: true, adjustment: 'raw', ...data };
  process.stdout.write(`${await writeReference(directory, reference)}\n`);
}
