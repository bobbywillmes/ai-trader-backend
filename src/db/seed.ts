import { prisma } from './prisma.js';
import { Prisma, AssetType } from '@prisma/client';
import type { SeedSecurity } from '../types/securities.js';

// Set to true to seed subscriptions for all securities in the securities.json file, which will create a very large number of subscriptions and is mainly intended for testing the system's performance and scalability with a large dataset. When false, only a curated list of popular tickers and ETFs will have subscriptions created, which is more suitable for development and demonstration purposes.
const seedAllSecuritySubscriptions = process.env.SEED_ALL_SECURITY_SUBSCRIPTIONS === 'true';


const settings = [
  { key: 'tradingEnabled', value: 'true' },
  { key: 'paperMode', value: 'true' }
];

import securitiesData from './securities.json' with { type: 'json' };
const securities = securitiesData as SeedSecurity[];

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
    allowedSymbolsJson: Prisma.JsonNull
  },
  {
    key: 'momentum',
    name: 'Momentum',
    description: 'Momentum-based entry strategy.',
    allowedSymbolsJson: Prisma.JsonNull,
  },
  {
    key: 'quick_test_momentum',
    name: 'Quick Test Momentum',
    description: 'Fast test strategy for backend entry/exit loop validation.',
    allowedSymbolsJson: Prisma.JsonNull,
    enabled: true,
  }
];

const exitProfiles = [
  {
    key: 'exit_core_target',
    name: 'Core Target Exit',
    description: 'Default fixed target exit profile.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: null,
    maxHoldDays: null,
    exitMode: 'fixed_target',
    takeProfitBehavior: 'immediate',
    enabled: true,
  },
  {
    key: 'exit_core_trailing',
    name: 'Core Target Then Trail',
    description: 'Target reached first, then trailing exit logic takes over.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: 0.5,
    maxHoldDays: null,
    exitMode: 'hybrid',
    takeProfitBehavior: 'trail_after_target',
    enabled: true,
  },
  {
    key: 'exit_core_bracket',
    name: 'Core Bracket Exit',
    description: 'Fixed target with stop-loss protection.',
    targetPct: 2,
    stopLossPct: 3,
    trailingStopPct: null,
    maxHoldDays: null,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'immediate',
    enabled: true,
  },
  {
    key: 'exit_ai_assisted',
    name: 'AI Assisted Exit',
    description: 'Reserved for future AI-assisted exit decisions.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: 0.5,
    maxHoldDays: 10,
    exitMode: 'ai_assisted',
    takeProfitBehavior: 'ai_confirm',
    enabled: true,
  },
  {
    key: 'exit_quick_test',
    name: 'Quick Test Exit',
    description: 'Tiny profit/stop thresholds for fast backend exit testing.',
    targetPct: 0.05,
    stopLossPct: 0.05,
    trailingStopPct: null,
    maxHoldDays: null,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'immediate',
    enabled: true,
  },
];

const getDipStrategyKey = (security: Pick<SeedSecurity, 'assetType'>) => {
  return security.assetType === 'ETF' ? 'dip_n_ride_etf' : 'dip_n_ride_ticker';
};

// Seed subscriptions for a curated list of popular tickers and ETFs that are commonly traded and have good liquidity. This will allow us to have a solid set of active subscriptions for testing and demonstration purposes.
const curatedSubscriptionSymbols = new Set<string>([
  'SPY',
  'QQQ',
  'DIA',
  'IWM',
  'RSP',
  'AAPL',
  'AMZN',
  'GOOG',
  'META',
  'MSFT',
  'NVDA',
  'TSLA',
  'AMD',
  'INTC',
  'NFLX',
]);

const curatedSubscriptionSecurities = securities.filter((security) =>
  curatedSubscriptionSymbols.has(security.symbol)
);

const subscriptionSourceSecurities: SeedSecurity[] = seedAllSecuritySubscriptions
  ? securities
  : curatedSubscriptionSecurities;

console.log(
  [
    'Seed configuration:',
    `- securities source: ${securities.length} total securities from src/db/securities.json`,
    `- subscription mode: ${
      seedAllSecuritySubscriptions
        ? 'FULL — subscriptions will be created for every seeded security'
        : 'CURATED — subscriptions will be created only for curated symbols'
    }`,
    `- subscription source count: ${subscriptionSourceSecurities.length} securities`,
    `- expected subscriptions: ${subscriptionSourceSecurities.length * 5}`,
  ].join('\n')
);

// For each selected security, create multiple subscriptions with different exit profiles and strategies to demonstrate the flexibility of the system. The "Dip N Ride" strategies will be used for their respective asset types, and the "Quick Test Momentum" strategy will be included for testing purposes.
const subscriptions = subscriptionSourceSecurities.flatMap((security) => {
  const symbol = security.symbol;
  const symbolKey = symbol.toLowerCase();
  const dipStrategyKey = getDipStrategyKey(security);

  return [
    {
      key: `${symbolKey}_dip_core`,
      name: `${symbol} Dip Core`,
      symbol,
      broker: 'alpaca',
      brokerMode: 'paper',
      strategyKey: dipStrategyKey,
      exitProfileKey: 'exit_core_target',
      sizingType: 'fixed_qty',
      sizingValue: 1,
      enabled: true,
    },
    {
      key: `${symbolKey}_dip_conservative`,
      name: `${symbol} Dip Conservative`,
      symbol,
      broker: 'alpaca',
      brokerMode: 'paper',
      strategyKey: dipStrategyKey,
      exitProfileKey: 'exit_core_bracket',
      sizingType: 'fixed_qty',
      sizingValue: 1,
      enabled: false,
    },
    {
      key: `${symbolKey}_dip_aggressive`,
      name: `${symbol} Dip Aggressive`,
      symbol,
      broker: 'alpaca',
      brokerMode: 'paper',
      strategyKey: dipStrategyKey,
      exitProfileKey: 'exit_core_trailing',
      sizingType: 'fixed_qty',
      sizingValue: 1,
      enabled: false,
    },
    {
      key: `${symbolKey}_dip_ai_assisted`,
      name: `${symbol} Dip AI Assisted`,
      symbol,
      broker: 'alpaca',
      brokerMode: 'paper',
      strategyKey: dipStrategyKey,
      exitProfileKey: 'exit_ai_assisted',
      sizingType: 'fixed_qty',
      sizingValue: 1,
      enabled: false,
    },
    {
      key: `${symbolKey}_test_momentum`,
      name: `${symbol} Test Momentum`,
      symbol,
      broker: 'alpaca',
      brokerMode: 'paper',
      strategyKey: 'quick_test_momentum',
      exitProfileKey: 'exit_quick_test',
      sizingType: 'fixed_qty',
      sizingValue: 1,
      enabled: false,
    },
  ];
});

const toPrismaAssetType = (assetType: SeedSecurity['assetType']) => {
  return assetType === 'ETF' ? AssetType.ETF : AssetType.STOCK;
};

async function main() {
  for (const security of securities) {
    const assetType = toPrismaAssetType(security.assetType);

    await prisma.security.upsert({
      where: { symbol: security.symbol },
      update: {
        name: security.name,
        assetType,
        sector: security.sector,
        industry: security.industry,
      },
      create: {
        symbol: security.symbol,
        name: security.name,
        assetType,
        sector: security.sector,
        industry: security.industry,
      }
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

  const security = await prisma.security.findUniqueOrThrow({
    where: { symbol: subscription.symbol }
  });

  await prisma.subscription.upsert({
    where: { key: subscription.key },
    update: {
      name: subscription.name,
      symbol: subscription.symbol,
      securityId: security.id,
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
      securityId: security.id,
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

  console.log(
    [
      'Database seed completed successfully:',
      `- securities upserted: ${securities.length}`,
      `- settings upserted: ${settings.length}`,
      `- strategies upserted: ${strategies.length}`,
      `- exit profiles upserted: ${exitProfiles.length}`,
      `- subscriptions upserted: ${subscriptions.length}`,
    ].join('\n')
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());