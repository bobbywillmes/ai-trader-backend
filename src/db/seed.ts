import { prisma } from './prisma.js';

const tickers = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'RSP',
  'AAPL', 'AMZN', 'GOOG', 'META', 'MSFT'
];

const settings = [
  { key: 'tradingEnabled', value: 'true' },
  { key: 'paperMode', value: 'true' }
];

async function main() {
  for (const symbol of tickers) {
    await prisma.allowedTicker.upsert({
      where: { symbol },
      update: {},
      create: { symbol }
    });
  }

  for (const setting of settings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {},
      create: setting
    });
  }

  console.log('Seeded tickers and settings');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());