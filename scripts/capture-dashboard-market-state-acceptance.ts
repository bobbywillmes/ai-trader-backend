/** Explicit manual read-only capture; never imported by application startup. */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { captureDashboardMarketStateAcceptance, DASHBOARD_MARKET_STATE_PHASES,
  formatDashboardMarketStateAcceptance, type DashboardMarketStatePhase } from '../src/dev/dashboard-market-state-acceptance.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]?.startsWith('--phase=')) throw new Error(`Pass exactly --phase=${DASHBOARD_MARKET_STATE_PHASES.join('|')}`);
const phase = args[0].slice('--phase='.length);
if (!DASHBOARD_MARKET_STATE_PHASES.includes(phase as DashboardMarketStatePhase)) throw new Error(`Unknown phase. Use ${DASHBOARD_MARKET_STATE_PHASES.join(', ')}.`);
const report = await captureDashboardMarketStateAcceptance(phase as DashboardMarketStatePhase);
const directory = join('.cache', 'dashboard-market-state-acceptance', `${report.startedAt.replace(/[:.]/g, '-')}-${phase.toLowerCase()}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(directory, 'summary.md'), formatDashboardMarketStateAcceptance(report), { flag: 'wx' });
process.stdout.write(`${directory}\n${formatDashboardMarketStateAcceptance(report)}`);
