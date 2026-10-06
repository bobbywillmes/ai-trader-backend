/** Explicit manual read-only capture; never imported by application startup. */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { captureDashboardPriceAcceptance, DASHBOARD_PRICE_PHASES, formatDashboardPriceAcceptance } from '../src/dev/dashboard-price-acceptance.js';
import type { DashboardPricePhase } from '../src/dev/dashboard-price-acceptance.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]?.startsWith('--phase=')) throw new Error(`Pass exactly --phase=${DASHBOARD_PRICE_PHASES.join('|')}`);
const phase = args[0].slice('--phase='.length);
if (!DASHBOARD_PRICE_PHASES.includes(phase as DashboardPricePhase)) throw new Error(`Unknown phase. Use ${DASHBOARD_PRICE_PHASES.join(', ')}.`);
const report = await captureDashboardPriceAcceptance(phase as DashboardPricePhase);
const directory = join('.cache', 'dashboard-price-acceptance', `${report.startedAt.replace(/[:.]/g, '-')}-${phase.toLowerCase()}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(directory, 'summary.md'), formatDashboardPriceAcceptance(report), { flag: 'wx' });
process.stdout.write(`${directory}\n${formatDashboardPriceAcceptance(report)}`);
