/** Manual, read-only live comparison. Never imported by production startup. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredTiingoRestClient, tiingoSymbol } from '../src/integrations/tiingo/rest.client.js';
import { getTickerPriceConfirmationMarketData } from '../src/services/massive-market-data.service.js';
import { compareRealtimeEvidence } from '../src/services/realtime-market-data-comparison.js';

const arg = process.argv.slice(2).find(value => value.startsWith('--symbols='));
if (!arg) throw new Error('Pass --symbols=SPY,RSP,AAPL,MSFT (maximum 20 symbols)');
const symbols = [...new Set(arg.slice('--symbols='.length).split(',').map(value => value.trim().toUpperCase()))];
if (!symbols.length || symbols.length > 20 || symbols.some(symbol => !symbol)) {
  throw new Error('Pass 1–20 valid explicit symbols');
}
for (const symbol of symbols) tiingoSymbol(symbol);
const client = configuredTiingoRestClient();
const capturedAt = new Date();
const sessionParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(capturedAt);
const sessionPart = (type: string) => sessionParts.find(part => part.type === type)?.value ?? '';
const sessionDate = `${sessionPart('year')}-${sessionPart('month')}-${sessionPart('day')}`;
// Upstream error text can contain arbitrary response data. Persist only a bounded status class.
const settled = async <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({
  ok: false as const,
  error: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? `HTTP_${error.status}` : 'REQUEST_FAILED',
}));

const results = [];
// Four symbols at a time, with the REST client's own concurrency bound across Tiingo calls.
for (let i = 0; i < symbols.length; i += 4) {
  const batch = symbols.slice(i, i + 4);
  results.push(...await Promise.all(batch.map(async symbol => {
    const [massive, consolidated, history, iex] = await Promise.all([
      settled(getTickerPriceConfirmationMarketData(symbol, { now: capturedAt })),
      settled(client.consolidatedSnapshot(symbol)),
      settled(client.intradayHistory(symbol, sessionDate, sessionDate, { resampleFreq: '1min', afterHours: true })),
      settled(client.iexSnapshot(symbol)),
    ]);
    return compareRealtimeEvidence({ symbol, capturedAt, massive, consolidated, history, iex });
  })));
}
const outputDirectory = join('.cache', 'realtime-market-data');
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, `${capturedAt.toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(outputPath, JSON.stringify({ schemaVersion: 1, productionAuthority: 'MASSIVE',
  sessionDate, symbols, results }, null, 2) + '\n', { flag: 'wx' });
console.log(outputPath);
