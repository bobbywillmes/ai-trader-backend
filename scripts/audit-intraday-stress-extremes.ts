import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { massiveEvidenceGet } from '../src/integrations/massive/evidence.client.js';
import { cached } from '../src/dev/intraday-stress-data.js';
import { etInstant } from '../src/services/market-calendar.js';
/** Four bounded, post-distribution diagnostic queries. Never replace authoritative 15-minute evidence. */
const cases = [
  { symbol: 'SPY', date: '2021-12-02', index: 13 }, { symbol: 'SPY', date: '2021-12-07', index: 23 },
  { symbol: 'QQQ', date: '2024-08-07', index: 20 }, { symbol: 'IWM', date: '2025-02-21', index: 7 },
];
const result = [];
for (const item of cases) {
  const response = await cached(`${item.symbol}-minute-audit-${item.date}`, async () => {
    const page = await massiveEvidenceGet(`/v2/aggs/ticker/${item.symbol}/range/1/minute/${item.date}/${item.date}?adjusted=false&sort=asc&limit=50000`);
    if (page.status !== 'OK' || page.ticker !== item.symbol || page.adjusted !== false || page.next_url || !Array.isArray(page.results)) throw new Error('Invalid minute diagnostic response.');
    return page.results;
  }, process.argv.includes('--fetch'));
  const start = etInstant(item.date, 570 + (item.index - 1) * 15).getTime();
  result.push({ ...item, ...(response.ok ? { minutes: response.value.filter(r => r.t >= start && r.t < start + 900000) } : { error: response.error }) });
}
await writeFile('docs/development/intraday-stress/extreme-minute-audit.json', JSON.stringify(result, null, 2) + '\n');
