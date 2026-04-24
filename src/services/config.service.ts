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