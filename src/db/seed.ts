import { prisma } from './prisma.js';
import { Prisma, AssetType } from '@prisma/client';
import type { SeedSecurity } from '../types/securities.js';
import { STRATEGY_KEYS } from '../types/strategies.js';
import {
  assertStrategyAllowedForAssetType,
  getDefaultDipStrategyForAssetType,
} from '../types/securityPolicies.js';
import {
  EXIT_PROFILE_KEYS,
  EXIT_PROFILE_SEEDS,
  getDipExitProfileForAssetTypeAndRiskMode,
} from '../types/exitProfiles.js';
import { buildSubscriptionsForSecurity } from '../types/subscriptionTemplates.js';

import { SUBSCRIPTION_RISK_MODES } from '../types/securityPolicies.js';

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
    key: STRATEGY_KEYS.DIP_N_RIDE_ETF,
    name: 'Dip N Ride - ETF',
    description: 'Dip-buying strategy for major ETFs.',
    allowedSymbolsJson: ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'],
    enabled: true,
  },
  {
    key: STRATEGY_KEYS.DIP_N_RIDE_STOCK,
    name: 'Dip N Ride - Stock',
    description: 'Dip-buying strategy for large-cap individual stocks.',
    allowedSymbolsJson: Prisma.JsonNull,
    enabled: true,
  },
  {
    key: STRATEGY_KEYS.MOMENTUM_ETF,
    name: 'Momentum - ETF',
    description: 'Production-intended momentum strategy for ETFs.',
    allowedSymbolsJson: Prisma.JsonNull,
    enabled: false,
  },
  {
    key: STRATEGY_KEYS.MOMENTUM_STOCK,
    name: 'Momentum - Stock',
    description: 'Production-intended momentum strategy for individual stocks.',
    allowedSymbolsJson: Prisma.JsonNull,
    enabled: false,
  },
  {
    key: STRATEGY_KEYS.AI_CONFIRMED_DIP_STOCK,
    name: 'AI Confirmed Dip - Stock',
    description:
      'Single-stock dip strategy that requires AI/news/context confirmation before entry.',
    allowedSymbolsJson: Prisma.JsonNull,
    enabled: false,
  },
  {
    key: STRATEGY_KEYS.QUICK_TEST_MOMENTUM,
    name: 'Quick Test Momentum',
    description: 'Fast test strategy for backend entry/exit loop validation.',
    allowedSymbolsJson: Prisma.JsonNull,
    enabled: true,
  },
];

const exitProfiles = EXIT_PROFILE_SEEDS;

// Seed subscriptions for a curated list of popular stocks and ETFs that are commonly traded and have good liquidity. This will allow us to have a solid set of active subscriptions for testing and demonstration purposes.
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
  ].join('\n')
);

// For each selected security, create multiple subscriptions with different exit profiles and strategies to demonstrate the flexibility of the system. The "Dip N Ride" strategies will be used for their respective asset types, and the "Quick Test Momentum" strategy will be included for testing purposes.
const subscriptions = subscriptionSourceSecurities.flatMap((security) =>
  buildSubscriptionsForSecurity({
    symbol: security.symbol,
    assetType: security.assetType,
  }),
);

const toPrismaAssetType = (assetType: SeedSecurity['assetType']) => {
  if (assetType === 'ETF') {
    return AssetType.ETF;
  }

  if (assetType === 'STOCK') {
    return AssetType.STOCK;
  }

  throw new Error(`Unsupported asset type: ${assetType}`);
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

  assertStrategyAllowedForAssetType(security.assetType, subscription.strategyKey);

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
      enabled: subscription.enabled,
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
      enabled: subscription.enabled,
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