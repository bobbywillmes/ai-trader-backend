import { Prisma, type PrismaClient } from '@prisma/client';

import { ACCOUNT_ENTRY_LIMIT_FIELDS } from './trading-account-entry-risk-limits.service.js';

const LEGACY_GLOBAL_DEFAULTS = {
  maxDailyEntryOrders: 5,
  maxDailyEntryNotional: 10_000,
  maxOpenPositions: 5,
  maxSymbolOpenNotional: 5_000,
} as const;

type RoutineLimitField = (typeof ACCOUNT_ENTRY_LIMIT_FIELDS)[number];

type RoutineLimits = Record<RoutineLimitField, number | null>;

type BootstrapAccount = {
  id: number;
  displayName: string;
  riskSettings: ({ id: number } & RoutineLimits) | null;
};

export type TradingAccountRiskSettingsBootstrapPlan = {
  tradingAccountId: number;
  displayName: string;
  createsRiskSettings: boolean;
  fields: Partial<RoutineLimits>;
  unresolvedFields: RoutineLimitField[];
};

function parseNullableNumber(
  value: string | undefined,
  fallback: number | null
) {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'null') return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildTradingAccountRiskSettingsBootstrapPlan(args: {
  accounts: BootstrapAccount[];
  globalLimits: RoutineLimits;
}) {
  return args.accounts.map((account) => {
    const fields: Partial<RoutineLimits> = {};

    for (const field of ACCOUNT_ENTRY_LIMIT_FIELDS) {
      if (account.riskSettings?.[field] == null) {
        const globalValue = args.globalLimits[field];

        if (globalValue !== null) {
          fields[field] = globalValue;
        }
      }
    }

    return {
      tradingAccountId: account.id,
      displayName: account.displayName,
      createsRiskSettings: account.riskSettings === null,
      fields,
      unresolvedFields: ACCOUNT_ENTRY_LIMIT_FIELDS.filter(
        (field) =>
          account.riskSettings?.[field] == null &&
          args.globalLimits[field] === null
      ),
    } satisfies TradingAccountRiskSettingsBootstrapPlan;
  });
}

async function loadGlobalRoutineLimits(prisma: PrismaClient) {
  const settings = await prisma.setting.findMany({
    where: { key: { in: [...ACCOUNT_ENTRY_LIMIT_FIELDS] } },
    select: { key: true, value: true },
  });
  const values = new Map(settings.map((setting) => [setting.key, setting.value]));

  return Object.fromEntries(
    ACCOUNT_ENTRY_LIMIT_FIELDS.map((field) => [
      field,
      parseNullableNumber(values.get(field), LEGACY_GLOBAL_DEFAULTS[field]),
    ])
  ) as RoutineLimits;
}

async function populateNullField(
  prisma: PrismaClient,
  tradingAccountId: number,
  field: RoutineLimitField,
  value: number | null
) {
  await prisma.tradingAccountRiskSettings.updateMany({
    where: {
      tradingAccountId,
      [field]: null,
    } as Prisma.TradingAccountRiskSettingsWhereInput,
    data: {
      [field]: value,
    } as Prisma.TradingAccountRiskSettingsUpdateManyMutationInput,
  });
}

export async function bootstrapTradingAccountRiskSettings(
  prisma: PrismaClient,
  options: { apply: boolean }
) {
  const [accounts, globalLimits] = await Promise.all([
    prisma.tradingAccount.findMany({
      select: {
        id: true,
        displayName: true,
        riskSettings: {
          select: {
            id: true,
            maxDailyEntryOrders: true,
            maxDailyEntryNotional: true,
            maxOpenPositions: true,
            maxSymbolOpenNotional: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    }),
    loadGlobalRoutineLimits(prisma),
  ]);
  const plans = buildTradingAccountRiskSettingsBootstrapPlan({
    accounts,
    globalLimits,
  });

  if (options.apply) {
    for (const plan of plans) {
      if (Object.keys(plan.fields).length === 0) continue;

      await prisma.tradingAccountRiskSettings.upsert({
        where: { tradingAccountId: plan.tradingAccountId },
        update: {},
        create: { tradingAccountId: plan.tradingAccountId },
      });

      for (const field of ACCOUNT_ENTRY_LIMIT_FIELDS) {
        if (Object.hasOwn(plan.fields, field)) {
          await populateNullField(
            prisma,
            plan.tradingAccountId,
            field,
            plan.fields[field] as number
          );
        }
      }
    }
  }

  return {
    mode: options.apply ? ('APPLY' as const) : ('DRY_RUN' as const),
    globalLimits,
    accounts: plans,
    accountCount: plans.length,
    changedAccountCount: plans.filter(
      (plan) => Object.keys(plan.fields).length > 0
    ).length,
  };
}
