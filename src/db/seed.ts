import { prisma } from './prisma.js';

const tickers = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'RSP',
  'AAPL', 'AMZN', 'GOOG', 'META', 'MSFT'
];

const settings = [
  { key: 'tradingEnabled', value: 'true' },
  { key: 'paperMode', value: 'true' }
];

const strategies = [
  {
    key: 'dip_n_ride_etf',
    name: 'Dip N Ride - ETF',
    description: 'Dip-buying strategy for major ETFs.',
    allowedSymbolsJson: ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP']
  },
  {
    key: 'dip_n_ride_ticker',
    name: 'Dip N Ride - Ticker',
    description: 'Dip-buying strategy for large-cap individual tickers.',
    allowedSymbolsJson: ['AAPL', 'AMZN', 'GOOG', 'META', 'MSFT']
  },
  {
    key: 'momentum',
    name: 'Momentum',
    description: 'Momentum-based entry strategy.',
    allowedSymbolsJson: null
  }
];

const exitProfiles = [
  {
    key: 'fixed_2pct_no_stop',
    name: 'Fixed 2% Target - No Stop',
    description: 'Basic fixed profit target with no stop-loss.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: null,
    maxHoldDays: null,
    exitMode: 'fixed_target',
    takeProfitBehavior: 'immediate'
  },
  {
    key: 'target_2pct_trail_0_5pct',
    name: '2% Target Then 0.5% Trail',
    description: 'Begin trailing after target is reached.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: 0.5,
    maxHoldDays: null,
    exitMode: 'hybrid',
    takeProfitBehavior: 'trail_after_target'
  },
  {
    key: 'stop_3pct_target_2pct',
    name: '3% Stop / 2% Target',
    description: 'Fixed stop-loss and fixed target.',
    targetPct: 2,
    stopLossPct: 3,
    trailingStopPct: null,
    maxHoldDays: null,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'immediate'
  },
  {
    key: 'ai_assisted_profit_protection',
    name: 'AI-Assisted Profit Protection',
    description: 'Template for future AI-assisted exit decisions.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: 0.5,
    maxHoldDays: 10,
    exitMode: 'ai_assisted',
    takeProfitBehavior: 'ai_confirm'
  }
];

const subscriptions = [
  {
    key: 'dip_n_ride_spy_paper',
    name: 'Dip N Ride - SPY Paper',
    symbol: 'SPY',
    broker: 'alpaca',
    brokerMode: 'paper',
    strategyKey: 'dip_n_ride_etf',
    exitProfileKey: 'target_2pct_trail_0_5pct',
    sizingType: 'fixed_qty',
    sizingValue: 1
  },
  {
    key: 'dip_n_ride_qqq_paper',
    name: 'Dip N Ride - QQQ Paper',
    symbol: 'QQQ',
    broker: 'alpaca',
    brokerMode: 'paper',
    strategyKey: 'dip_n_ride_etf',
    exitProfileKey: 'target_2pct_trail_0_5pct',
    sizingType: 'fixed_qty',
    sizingValue: 1
  },
  {
    key: 'dip_n_ride_aapl_paper',
    name: 'Dip N Ride - AAPL Paper',
    symbol: 'AAPL',
    broker: 'alpaca',
    brokerMode: 'paper',
    strategyKey: 'dip_n_ride_ticker',
    exitProfileKey: 'stop_3pct_target_2pct',
    sizingType: 'fixed_qty',
    sizingValue: 1
  }
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

  for (const strategy of strategies) {
  await prisma.strategy.upsert({
    where: { key: strategy.key },
    update: strategy,
    create: strategy
  });
}

for (const exitProfile of exitProfiles) {
  await prisma.exitProfile.upsert({
    where: { key: exitProfile.key },
    update: exitProfile,
    create: exitProfile
  });
}

for (const subscription of subscriptions) {
  const strategy = await prisma.strategy.findUniqueOrThrow({
    where: { key: subscription.strategyKey }
  });

  const exitProfile = await prisma.exitProfile.findUniqueOrThrow({
    where: { key: subscription.exitProfileKey }
  });

  await prisma.subscription.upsert({
    where: { key: subscription.key },
    update: {
      name: subscription.name,
      symbol: subscription.symbol,
      broker: subscription.broker,
      brokerMode: subscription.brokerMode,
      sizingType: subscription.sizingType,
      sizingValue: subscription.sizingValue,
      strategyId: strategy.id,
      exitProfileId: exitProfile.id,
      enabled: true
    },
    create: {
      key: subscription.key,
      name: subscription.name,
      symbol: subscription.symbol,
      broker: subscription.broker,
      brokerMode: subscription.brokerMode,
      sizingType: subscription.sizingType,
      sizingValue: subscription.sizingValue,
      strategyId: strategy.id,
      exitProfileId: exitProfile.id,
      enabled: true
    }
  });
}

  console.log('Seeded database with tickers, settings, strategies, exit profiles, and subscriptions.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());