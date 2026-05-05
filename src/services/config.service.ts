import { prisma } from '../db/prisma.js';

export type RuntimeTradingConfig = {
  tradingEnabled: boolean;
  paperMode: boolean;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}


export async function getRuntimeTradingConfig(): Promise<RuntimeTradingConfig> {
  const [settings] = await Promise.all([
    prisma.setting.findMany(),
  ]);

  const map = new Map(settings.map((s) => [s.key, s.value]));

  return {
    tradingEnabled: parseBoolean(map.get('tradingEnabled'), false),
    paperMode: parseBoolean(map.get('paperMode'), true),
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
