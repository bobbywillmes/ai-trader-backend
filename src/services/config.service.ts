import { prisma } from '../db/prisma.js';

export type RuntimeTradingConfig = {
  tradingEnabled: boolean;
  paperMode: boolean;
  killSwitchEnabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
  reconciliationWorkerEnabled: boolean;
  reconciliationWorkerIntervalMinutes: number;
};

export type UpdateRuntimeSettingsInput = {
  tradingEnabled?: boolean | undefined;
  paperMode?: boolean | undefined;
  killSwitchEnabled?: boolean | undefined;
  maxDailyEntryOrders?: number | null | undefined;
  maxDailyEntryNotional?: number | null | undefined;
  maxOpenPositions?: number | null | undefined;
  maxTotalOpenNotional?: number | null | undefined;
  maxSymbolOpenNotional?: number | null | undefined;
  maxSubscriptionOpenNotional?: number | null | undefined;
  reconciliationWorkerEnabled?: boolean | undefined;
  reconciliationWorkerIntervalMinutes?: number | null | undefined;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

function parseNullableNumber(
  value: string | undefined,
  fallback: number | null
): number | null {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();

  if (normalized === '' || normalized === 'null') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function serializeSettingValue(value: boolean | number | null): string {
  return value === null ? '' : String(value);
}

function upsertSetting(key: string, value: boolean | number | null) {
  return prisma.setting.upsert({
    where: { key },
    update: { value: serializeSettingValue(value) },
    create: { key, value: serializeSettingValue(value) },
  });
}

export async function getRuntimeTradingConfig(): Promise<RuntimeTradingConfig> {
  const settings = await prisma.setting.findMany();
  const map = new Map(settings.map((setting) => [setting.key, setting.value]));

  return {
    tradingEnabled: parseBoolean(map.get('tradingEnabled'), false),
    paperMode: parseBoolean(map.get('paperMode'), true),
    killSwitchEnabled: parseBoolean(map.get('killSwitchEnabled'), false),

    maxDailyEntryOrders: parseNullableNumber(map.get('maxDailyEntryOrders'), 5),
    maxDailyEntryNotional: parseNullableNumber(
      map.get('maxDailyEntryNotional'),
      10_000
    ),
    maxOpenPositions: parseNullableNumber(map.get('maxOpenPositions'), 5),
    maxTotalOpenNotional: parseNullableNumber(
      map.get('maxTotalOpenNotional'),
      25_000
    ),
    maxSymbolOpenNotional: parseNullableNumber(
      map.get('maxSymbolOpenNotional'),
      5_000
    ),
    maxSubscriptionOpenNotional: parseNullableNumber(
      map.get('maxSubscriptionOpenNotional'),
      5_000
    ),
    reconciliationWorkerEnabled: parseBoolean(
      map.get('reconciliationWorkerEnabled'),
      false
    ),
    reconciliationWorkerIntervalMinutes:
      parseNullableNumber(map.get('reconciliationWorkerIntervalMinutes'), 15) ?? 15,
  };
}

export async function updateRuntimeSettings(input: UpdateRuntimeSettingsInput) {
  const updates: Promise<unknown>[] = [];

  if (input.tradingEnabled !== undefined) {
    updates.push(upsertSetting('tradingEnabled', input.tradingEnabled));
  }

  if (input.paperMode !== undefined) {
    updates.push(upsertSetting('paperMode', input.paperMode));
  }

  if (input.killSwitchEnabled !== undefined) {
    updates.push(upsertSetting('killSwitchEnabled', input.killSwitchEnabled));
  }

  if (input.maxDailyEntryOrders !== undefined) {
    updates.push(upsertSetting('maxDailyEntryOrders', input.maxDailyEntryOrders));
  }

  if (input.maxDailyEntryNotional !== undefined) {
    updates.push(
      upsertSetting('maxDailyEntryNotional', input.maxDailyEntryNotional)
    );
  }

  if (input.maxOpenPositions !== undefined) {
    updates.push(upsertSetting('maxOpenPositions', input.maxOpenPositions));
  }

  if (input.maxTotalOpenNotional !== undefined) {
    updates.push(
      upsertSetting('maxTotalOpenNotional', input.maxTotalOpenNotional)
    );
  }

  if (input.maxSymbolOpenNotional !== undefined) {
    updates.push(
      upsertSetting('maxSymbolOpenNotional', input.maxSymbolOpenNotional)
    );
  }

  if (input.maxSubscriptionOpenNotional !== undefined) {
    updates.push(
      upsertSetting(
        'maxSubscriptionOpenNotional',
        input.maxSubscriptionOpenNotional
      )
    );
  }

  if (input.reconciliationWorkerEnabled !== undefined) {
    updates.push(
      upsertSetting(
        'reconciliationWorkerEnabled',
        input.reconciliationWorkerEnabled
      )
    );
  }

  if (input.reconciliationWorkerIntervalMinutes !== undefined) {
    updates.push(
      upsertSetting(
        'reconciliationWorkerIntervalMinutes',
        input.reconciliationWorkerIntervalMinutes
      )
    );
  }

  await Promise.all(updates);

  return getRuntimeTradingConfig();
}