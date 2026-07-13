import type { RuntimeTradingConfig } from './config.service.js';

export const ACCOUNT_ENTRY_LIMIT_FIELDS = [
  'maxDailyEntryOrders',
  'maxDailyEntryNotional',
  'maxOpenPositions',
  'maxSymbolOpenNotional',
] as const;

export type AccountEntryLimitField =
  (typeof ACCOUNT_ENTRY_LIMIT_FIELDS)[number];

export type EffectiveAccountEntryLimitSource =
  | 'ACCOUNT'
  | 'LEGACY_GLOBAL_FALLBACK';

export type AccountEntryRiskSettingsInput = {
  enabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
} | null;

export type EffectiveAccountEntryLimit = {
  value: number | null;
  source: EffectiveAccountEntryLimitSource;
};

export type EffectiveAccountEntryLimits = {
  tradingAccountId: number;
  accountRiskSettingsEnabled: boolean;
  usingLegacyGlobalFallback: boolean;
  limits: Record<AccountEntryLimitField, EffectiveAccountEntryLimit>;
  authoritativeTotalExposure: {
    field: 'maxDeployableNotional';
    value: number | null;
    source: 'TRADING_ACCOUNT';
  };
  superseded: {
    accountMaxTotalOpenNotional: number | null;
    globalMaxTotalOpenNotional: number | null;
    accountMaxSubscriptionOpenNotional: number | null;
    globalMaxSubscriptionOpenNotional: number | null;
  };
};

const NEW_YORK_TIME_ZONE = 'America/New_York';

const DAILY_ENTRY_ACTIVITY_STATUSES = new Set([
  'pending',
  'submitting',
  'submitted',
  'filled',
]);

const PENDING_ENTRY_EXPOSURE_STATUSES = new Set([
  'pending',
  'submitting',
  'submitted',
  'new',
  'accepted',
  'accepted_for_bidding',
  'pending_new',
  'partially_filled',
  'filled',
]);

function resolveField(
  field: AccountEntryLimitField,
  accountRiskSettings: AccountEntryRiskSettingsInput,
  globalConfig: RuntimeTradingConfig
): EffectiveAccountEntryLimit {
  const accountValue = accountRiskSettings?.enabled
    ? accountRiskSettings[field]
    : null;

  if (accountValue !== null && Number.isFinite(accountValue)) {
    return { value: accountValue, source: 'ACCOUNT' };
  }

  return {
    value: globalConfig[field],
    source: 'LEGACY_GLOBAL_FALLBACK',
  };
}

export function resolveEffectiveAccountEntryLimits(args: {
  tradingAccountId: number;
  maxDeployableNotional: number | null;
  accountRiskSettings: AccountEntryRiskSettingsInput;
  globalConfig: RuntimeTradingConfig;
}): EffectiveAccountEntryLimits {
  const limits = Object.fromEntries(
    ACCOUNT_ENTRY_LIMIT_FIELDS.map((field) => [
      field,
      resolveField(field, args.accountRiskSettings, args.globalConfig),
    ])
  ) as Record<AccountEntryLimitField, EffectiveAccountEntryLimit>;

  return {
    tradingAccountId: args.tradingAccountId,
    accountRiskSettingsEnabled: args.accountRiskSettings?.enabled === true,
    usingLegacyGlobalFallback: Object.values(limits).some(
      (limit) => limit.source === 'LEGACY_GLOBAL_FALLBACK'
    ),
    limits,
    authoritativeTotalExposure: {
      field: 'maxDeployableNotional',
      value: args.maxDeployableNotional,
      source: 'TRADING_ACCOUNT',
    },
    superseded: {
      accountMaxTotalOpenNotional:
        args.accountRiskSettings?.maxTotalOpenNotional ?? null,
      globalMaxTotalOpenNotional: args.globalConfig.maxTotalOpenNotional,
      accountMaxSubscriptionOpenNotional:
        args.accountRiskSettings?.maxSubscriptionOpenNotional ?? null,
      globalMaxSubscriptionOpenNotional:
        args.globalConfig.maxSubscriptionOpenNotional,
    },
  };
}

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedParts(date, timeZone);

  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) - date.getTime()
  );
}

function zonedMidnightToUtc(parts: {
  year: number;
  month: number;
  day: number;
}) {
  const utcGuess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0)
  );
  const firstPass = new Date(
    utcGuess.getTime() - getTimeZoneOffsetMs(utcGuess, NEW_YORK_TIME_ZONE)
  );

  return new Date(
    utcGuess.getTime() - getTimeZoneOffsetMs(firstPass, NEW_YORK_TIME_ZONE)
  );
}

export function getNewYorkDailyEntryWindow(now: Date = new Date()) {
  const local = getZonedParts(now, NEW_YORK_TIME_ZONE);
  const nextLocalDate = new Date(
    Date.UTC(local.year, local.month - 1, local.day + 1)
  );

  return {
    timeZone: NEW_YORK_TIME_ZONE,
    date: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
    start: zonedMidnightToUtc(local),
    nextStart: zonedMidnightToUtc({
      year: nextLocalDate.getUTCFullYear(),
      month: nextLocalDate.getUTCMonth() + 1,
      day: nextLocalDate.getUTCDate(),
    }),
  };
}

type EntryIntentLifecycleInput = {
  side?: string;
  status?: string;
  blockReason?: string | null;
  trackedPositionId?: number | null;
  brokerOrderCount?: number;
};

export function representsDailyEntryActivity(
  intent: EntryIntentLifecycleInput
) {
  if (intent.side?.toLowerCase() !== 'buy' || intent.blockReason) {
    return false;
  }

  return (
    DAILY_ENTRY_ACTIVITY_STATUSES.has(intent.status?.toLowerCase() ?? '') ||
    (intent.brokerOrderCount ?? 0) > 0
  );
}

export function representsPendingEntryExposure(
  intent: EntryIntentLifecycleInput
) {
  return (
    intent.side?.toLowerCase() === 'buy' &&
    intent.trackedPositionId == null &&
    !intent.blockReason &&
    PENDING_ENTRY_EXPOSURE_STATUSES.has(intent.status?.toLowerCase() ?? '')
  );
}
