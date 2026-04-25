import { prisma } from '../db/prisma.js';

export type RuntimeTradingConfig = {
  tradingEnabled: boolean;
  paperMode: boolean;
  allowedTickers: string[];
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

export async function getAllowedTickers(): Promise<string[]> {
  const rows = await prisma.allowedTicker.findMany({
    orderBy: { symbol: 'asc' }
  });

  return rows.map((row) => row.symbol);
}

export async function getRuntimeTradingConfig(): Promise<RuntimeTradingConfig> {
  const [settings, allowedTickers] = await Promise.all([
    prisma.setting.findMany(),
    getAllowedTickers()
  ]);

  const map = new Map(settings.map((s) => [s.key, s.value]));

  return {
    tradingEnabled: parseBoolean(map.get('tradingEnabled'), false),
    paperMode: parseBoolean(map.get('paperMode'), true),
    allowedTickers
  };
}

export async function updateRuntimeSettings(input: {
  tradingEnabled?: boolean | undefined;
  paperMode?: boolean | undefined;
}) {
  const updates = [];

  if (input.tradingEnabled !== undefined) {
    updates.push(
      prisma.setting.upsert({
        where: { key: 'tradingEnabled' },
        update: { value: String(input.tradingEnabled) },
        create: { key: 'tradingEnabled', value: String(input.tradingEnabled) }
      })
    );
  }

  if (input.paperMode !== undefined) {
    updates.push(
      prisma.setting.upsert({
        where: { key: 'paperMode' },
        update: { value: String(input.paperMode) },
        create: { key: 'paperMode', value: String(input.paperMode) }
      })
    );
  }

  await Promise.all(updates);

  return getRuntimeTradingConfig();
}

export async function addAllowedTicker(symbol: string) {
  const normalized = symbol.trim().toUpperCase();

  await prisma.allowedTicker.upsert({
    where: { symbol: normalized },
    update: {},
    create: { symbol: normalized }
  });

  return getAllowedTickers();
}

export async function removeAllowedTicker(symbol: string) {
  const normalized = symbol.trim().toUpperCase();

  await prisma.allowedTicker.deleteMany({
    where: { symbol: normalized }
  });

  return getAllowedTickers();
}