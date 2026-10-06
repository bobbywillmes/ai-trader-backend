/** Explicit manual, read-only provider comparison. Never imported by application startup. */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { calendarExceptions } from '../src/services/market-calendar.service.js';
import { etDate } from '../src/services/market-calendar.js';
import { tiingoSymbol } from '../src/integrations/tiingo/rest.client.js';
import { captureTradingReferencePrices, formatTradingReferencePriceAcceptance,
  TRADING_PRICE_CAPTURE_PHASES, type TradingPriceCapturePhase } from '../src/dev/trading-reference-price-acceptance.js';

const args = process.argv.slice(2);
const phaseArg = args.find(value => value.startsWith('--phase='));
const symbolsArg = args.find(value => value.startsWith('--symbols='));
if (args.length !== 2 || !phaseArg || !symbolsArg) throw new Error('Pass --phase=AFTER_OPEN|MIDDAY|NEAR_CLOSE|POSTMARKET|CLOSED|PREMARKET and --symbols=SPY,QQQ (1-20).');
const phase = phaseArg.slice('--phase='.length);
if (!TRADING_PRICE_CAPTURE_PHASES.includes(phase as TradingPriceCapturePhase)) throw new Error('Unknown capture phase.');
const symbols = symbolsArg.slice('--symbols='.length).split(',').map(value => value.trim().toUpperCase());
if (symbols.length < 1 || symbols.length > 20 || new Set(symbols).size !== symbols.length || symbols.some(value => !value))
  throw new Error('Pass 1-20 distinct explicit symbols.');
for (const symbol of symbols) tiingoSymbol(symbol);

try {
  const today = etDate(new Date());
  const exceptions = await calendarExceptions(today, today);
  const report = await captureTradingReferencePrices(symbols, phase as TradingPriceCapturePhase, exceptions);
  const directory = join('.cache', 'trading-reference-price-acceptance', `${report.startedAt.replace(/[:.]/g, '-')}-${phase.toLowerCase()}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(directory, 'summary.md'), formatTradingReferencePriceAcceptance(report), { flag: 'wx' });
  process.stdout.write(`${directory}\n`);
} finally {
  await prisma.$disconnect();
}
