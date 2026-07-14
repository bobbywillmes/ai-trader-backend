import {
  BrokerCredentialStatus,
  PositionSizingType,
  Prisma,
  TradingAccountEnvironment,
  TradingAccountStatus,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { getTickerLatestPrice } from './massive-market-data.service.js';
import { validateAccountRiskConfiguration } from './trading-account-risk-configuration.service.js';
import { resolveEffectiveAccountEntryLimits } from './trading-account-entry-risk-limits.service.js';
import { getTradingAccountEntryRiskUsage } from './trading-account-entry-risk-usage.service.js';

const ACTIVE_POSITION_STATUSES = ['open', 'closing'];
const BROKER_SYNC_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const RISK_HEALTH_ACCOUNT_SELECT = {
  id: true,
  displayName: true,
  broker: true,
  environment: true,
  status: true,
  tradingEnabled: true,
  killSwitchEnabled: true,
  estimatedTradingCapital: true,
  maxDeployableNotional: true,
  brokerAccountId: true,
  brokerAccountStatus: true,
  lastBrokerSyncAt: true,
  lastCash: true,
  lastBuyingPower: true,
  lastEquity: true,
  lastPortfolioValue: true,
  credential: {
    select: {
      status: true,
      verifiedAt: true,
      revokedAt: true,
    },
  },
  riskSettings: {
    select: {
      enabled: true,
      maxDailyEntryOrders: true,
      maxDailyEntryNotional: true,
      maxOpenPositions: true,
      maxTotalOpenNotional: true,
      maxSymbolOpenNotional: true,
      maxSubscriptionOpenNotional: true,
    },
  },
} satisfies Prisma.TradingAccountSelect;

const RISK_HEALTH_ALLOCATION_SELECT = {
  id: true,
  key: true,
  name: true,
  enabled: true,
  maxAllocatedNotional: true,
  maxOpenPositions: true,
  maxPositionNotional: true,
} satisfies Prisma.TradingAccountAllocationSelect;

const RISK_HEALTH_ACCOUNT_SUBSCRIPTION_SELECT = {
  id: true,
  tradingAccountId: true,
  subscriptionId: true,
  allocationId: true,
  enabled: true,
  entriesEnabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  minPositionNotional: true,
  maxQty: true,
  notes: true,
  allocation: {
    select: RISK_HEALTH_ALLOCATION_SELECT,
  },
  subscription: {
    select: {
      id: true,
      key: true,
      symbol: true,
      enabled: true,
      strategy: {
        select: {
          enabled: true,
        },
      },
      exitProfile: {
        select: {
          enabled: true,
        },
      },
      security: {
        select: {
          enabled: true,
        },
      },
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

type RiskHealthAccount = Prisma.TradingAccountGetPayload<{
  select: typeof RISK_HEALTH_ACCOUNT_SELECT;
}>;

type RiskHealthAllocation = Prisma.TradingAccountAllocationGetPayload<{
  select: typeof RISK_HEALTH_ALLOCATION_SELECT;
}>;

type RiskHealthAccountSubscription =
  Prisma.TradingAccountSubscriptionGetPayload<{
    select: typeof RISK_HEALTH_ACCOUNT_SUBSCRIPTION_SELECT;
  }>;

export type TradingAccountRiskHealthStatus =
  | 'READY'
  | 'READY_WITH_WARNINGS'
  | 'BLOCKED';

export type TradingAccountRiskHealthCheckSeverity =
  | 'blocker'
  | 'warning'
  | 'info';

export type TradingAccountRiskHealthCheckStatus =
  | 'pass'
  | 'fail'
  | 'warn'
  | 'info';

export type TradingAccountRiskHealthCheck = {
  id: string;
  label: string;
  severity: TradingAccountRiskHealthCheckSeverity;
  status: TradingAccountRiskHealthCheckStatus;
  message: string;
  details?: unknown;
};

type PlannedExposure = {
  accountSubscription: RiskHealthAccountSubscription;
  plannedNotional: number | null;
};

type BuildHealthOptions = {
  now?: Date;
};

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(
  value: number | null | undefined
): value is number {
  return isFiniteNumber(value) && value > 0;
}

function getPositionExposure(position: {
  marketValue: number;
  costBasis: number;
}) {
  const exposure = position.marketValue || position.costBasis || 0;

  return Math.abs(exposure);
}

function getBrokerPortfolioValue(account: RiskHealthAccount) {
  if (isFiniteNumber(account.lastPortfolioValue)) {
    return account.lastPortfolioValue;
  }

  if (isFiniteNumber(account.lastEquity)) {
    return account.lastEquity;
  }

  return null;
}

function getBrokerPortfolioValueField(account: RiskHealthAccount) {
  if (isFiniteNumber(account.lastPortfolioValue)) {
    return 'lastPortfolioValue';
  }

  if (isFiniteNumber(account.lastEquity)) {
    return 'lastEquity';
  }

  return null;
}

function isBrokerSyncStale(account: RiskHealthAccount, now: Date) {
  if (!account.lastBrokerSyncAt) {
    return true;
  }

  return now.getTime() - account.lastBrokerSyncAt.getTime() >
    BROKER_SYNC_STALE_AFTER_MS;
}

function liveSeverity(
  profile: TradingAccountEnvironment
): TradingAccountRiskHealthCheckSeverity {
  return profile === TradingAccountEnvironment.LIVE ? 'blocker' : 'warning';
}

function failingStatus(
  severity: TradingAccountRiskHealthCheckSeverity
): TradingAccountRiskHealthCheckStatus {
  return severity === 'blocker' ? 'fail' : 'warn';
}

function surplus(capital: number | null, budget: number) {
  return capital === null ? null : capital - budget;
}

function createCheck(args: TradingAccountRiskHealthCheck) {
  return args;
}

function getReadinessStatus(checks: TradingAccountRiskHealthCheck[]) {
  const hasBlocker = checks.some(
    (check) => check.severity === 'blocker' && check.status === 'fail'
  );

  if (hasBlocker) {
    return 'BLOCKED' as const;
  }

  const hasWarning = checks.some(
    (check) => check.severity === 'warning' && check.status === 'warn'
  );

  return hasWarning ? 'READY_WITH_WARNINGS' : 'READY';
}

function activeAccountSubscriptions(
  accountSubscriptions: RiskHealthAccountSubscription[]
) {
  return accountSubscriptions.filter(
    (accountSubscription) =>
      accountSubscription.enabled && accountSubscription.entriesEnabled
  );
}

async function getFixedQtyPlannedNotional(args: {
  accountSubscription: RiskHealthAccountSubscription;
  checks: TradingAccountRiskHealthCheck[];
  profile: TradingAccountEnvironment;
}) {
  const fixedQty = args.accountSubscription.fixedQty;
  const symbol = args.accountSubscription.subscription.symbol;

  if (!isPositiveFiniteNumber(fixedQty)) {
    const severity = liveSeverity(args.profile);

    args.checks.push(
      createCheck({
        id: `account_subscription_${args.accountSubscription.id}_fixed_qty`,
        label: 'FIXED_QTY sizing is valid',
        severity,
        status: failingStatus(severity),
        message: `Active subscription ${args.accountSubscription.subscription.key} is missing a valid fixed quantity.`,
        details: {
          tradingAccountSubscriptionId: args.accountSubscription.id,
          fixedQty,
        },
      })
    );

    return null;
  }

  try {
    const latest = await getTickerLatestPrice(symbol);
    const latestPrice = latest.latestPrice;

    if (!isPositiveFiniteNumber(latestPrice)) {
      const severity = liveSeverity(args.profile);

      args.checks.push(
        createCheck({
          id: `account_subscription_${args.accountSubscription.id}_latest_price`,
          label: 'FIXED_QTY latest price is available',
          severity,
          status: failingStatus(severity),
          message: `Latest price is unavailable for active FIXED_QTY subscription ${args.accountSubscription.subscription.key}.`,
          details: {
            tradingAccountSubscriptionId: args.accountSubscription.id,
            symbol,
            latestPrice,
            latestPriceAt: latest.latestPriceAt,
            latestPriceSource: latest.latestPriceSource,
          },
        })
      );

      return null;
    }

    return fixedQty * latestPrice;
  } catch (error) {
    const severity = liveSeverity(args.profile);

    args.checks.push(
      createCheck({
        id: `account_subscription_${args.accountSubscription.id}_latest_price`,
        label: 'FIXED_QTY latest price is available',
        severity,
        status: failingStatus(severity),
        message: `Latest price lookup failed for active FIXED_QTY subscription ${args.accountSubscription.subscription.key}.`,
        details: {
          tradingAccountSubscriptionId: args.accountSubscription.id,
          symbol,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'UnknownError' },
        },
      })
    );

    return null;
  }
}

async function getPlannedExposures(args: {
  accountSubscriptions: RiskHealthAccountSubscription[];
  checks: TradingAccountRiskHealthCheck[];
  profile: TradingAccountEnvironment;
}) {
  const exposures: PlannedExposure[] = [];

  for (const accountSubscription of args.accountSubscriptions) {
    if (accountSubscription.sizingType === PositionSizingType.MAX_NOTIONAL) {
      const maxPositionNotional = accountSubscription.maxPositionNotional;

      if (!isPositiveFiniteNumber(maxPositionNotional)) {
        const severity = liveSeverity(args.profile);

        args.checks.push(
          createCheck({
            id: `account_subscription_${accountSubscription.id}_max_notional`,
            label: 'MAX_NOTIONAL sizing is valid',
            severity,
            status: failingStatus(severity),
            message: `Active subscription ${accountSubscription.subscription.key} is missing maxPositionNotional.`,
            details: {
              tradingAccountSubscriptionId: accountSubscription.id,
              maxPositionNotional,
            },
          })
        );
        exposures.push({ accountSubscription, plannedNotional: null });
        continue;
      }

      exposures.push({
        accountSubscription,
        plannedNotional: maxPositionNotional,
      });
      continue;
    }

    exposures.push({
      accountSubscription,
      plannedNotional: await getFixedQtyPlannedNotional({
        accountSubscription,
        checks: args.checks,
        profile: args.profile,
      }),
    });
  }

  return exposures;
}

function sumPlannedExposure(exposures: PlannedExposure[]) {
  return exposures.reduce(
    (total, exposure) => total + (exposure.plannedNotional ?? 0),
    0
  );
}

function getMaxSimultaneousAllocationExposure(args: {
  allocations: RiskHealthAllocation[];
  exposures: PlannedExposure[];
}) {
  let total = 0;

  for (const allocation of args.allocations) {
    if (!allocation.enabled) {
      continue;
    }

    const allocationExposures = args.exposures
      .filter(
        (exposure) =>
          exposure.accountSubscription.allocationId === allocation.id &&
          exposure.plannedNotional !== null
      )
      .map((exposure) => exposure.plannedNotional as number)
      .sort((a, b) => b - a);
    const exposureCount = isPositiveFiniteNumber(allocation.maxOpenPositions)
      ? allocation.maxOpenPositions
      : allocationExposures.length;

    total += allocationExposures
      .slice(0, exposureCount)
      .reduce((sum, value) => sum + value, 0);
  }

  return total;
}

function addSharedChecks(args: {
  account: RiskHealthAccount;
  accountSubscriptions: RiskHealthAccountSubscription[];
  allocations: RiskHealthAllocation[];
  checks: TradingAccountRiskHealthCheck[];
  globalConfig: Awaited<ReturnType<typeof getRuntimeTradingConfig>>;
  openPositions: Array<{
    id: number;
    symbol: string;
    subscriptionId: number | null;
    tradingAccountSubscriptionId: number | null;
  }>;
  unattributedOpenPositions: Array<{ id: number; symbol: string }>;
  now: Date;
}) {
  const profile = args.account.environment;
  const activeSubscriptions = activeAccountSubscriptions(args.accountSubscriptions);

  args.checks.push(
    createCheck({
      id: 'trading_account_exists',
      label: 'Trading account exists',
      severity: 'info',
      status: 'pass',
      message: `TradingAccount ${args.account.id} was found.`,
    })
  );

  if (args.account.status !== TradingAccountStatus.ACTIVE) {
    args.checks.push(
      createCheck({
        id: 'trading_account_active',
        label: 'Trading account is active',
        severity: 'blocker',
        status: 'fail',
        message: `TradingAccount status is ${args.account.status}; new entries require ACTIVE.`,
      })
    );
  }

  if (!args.account.tradingEnabled) {
    args.checks.push(
      createCheck({
        id: 'trading_account_trading_enabled',
        label: 'Trading account trading is enabled',
        severity: 'blocker',
        status: 'fail',
        message: 'TradingAccount tradingEnabled is false.',
      })
    );
  }

  if (args.account.killSwitchEnabled) {
    args.checks.push(
      createCheck({
        id: 'trading_account_kill_switch_disabled',
        label: 'Trading account kill switch is off',
        severity: 'blocker',
        status: 'fail',
        message: 'TradingAccount killSwitchEnabled is true.',
      })
    );
  }

  if (!args.account.credential) {
    args.checks.push(
      createCheck({
        id: 'credential_exists',
        label: 'Broker credential exists',
        severity: 'blocker',
        status: 'fail',
        message: 'TradingAccount has no broker credential.',
      })
    );
  } else if (args.account.credential.status !== BrokerCredentialStatus.ACTIVE) {
    args.checks.push(
      createCheck({
        id: 'credential_active',
        label: 'Broker credential is active',
        severity: 'blocker',
        status: 'fail',
        message: `Broker credential status is ${args.account.credential.status}; new entries require ACTIVE.`,
      })
    );
  }

  if (!args.account.brokerAccountId || !args.account.brokerAccountStatus) {
    const severity = liveSeverity(profile);

    args.checks.push(
      createCheck({
        id: 'broker_account_metadata_synced',
        label: 'Broker account metadata is synced',
        severity,
        status: failingStatus(severity),
        message: 'Broker account metadata is incomplete.',
        details: {
          brokerAccountId: args.account.brokerAccountId,
          brokerAccountStatus: args.account.brokerAccountStatus,
        },
      })
    );
  }

  if (!args.account.riskSettings) {
    const severity = liveSeverity(profile);

    args.checks.push(
      createCheck({
        id: 'account_risk_settings_exist',
        label: 'Account risk settings exist',
        severity,
        status: failingStatus(severity),
        message: 'TradingAccount risk settings are missing.',
      })
    );
  } else if (!args.account.riskSettings.enabled) {
    const severity = liveSeverity(profile);

    args.checks.push(
      createCheck({
        id: 'account_risk_settings_enabled',
        label: 'Account risk settings are enabled',
        severity,
        status: failingStatus(severity),
        message: 'TradingAccount risk settings are disabled.',
      })
    );
  }

  if (activeSubscriptions.length === 0) {
    args.checks.push(
      createCheck({
        id: 'active_account_subscriptions_exist',
        label: 'Active entry subscriptions exist',
        severity: 'blocker',
        status: 'fail',
        message: 'No enabled, entry-enabled account subscriptions are configured.',
      })
    );
  }

  for (const accountSubscription of activeSubscriptions) {
    const severity = liveSeverity(profile);

    if (!accountSubscription.allocationId) {
      args.checks.push(
        createCheck({
          id: `account_subscription_${accountSubscription.id}_assigned`,
          label: 'Active subscription is assigned to an allocation',
          severity,
          status: failingStatus(severity),
          message: `Active subscription ${accountSubscription.subscription.key} is not assigned to an allocation.`,
          details: {
            tradingAccountSubscriptionId: accountSubscription.id,
            subscriptionId: accountSubscription.subscriptionId,
          },
        })
      );
    } else if (!accountSubscription.allocation?.enabled) {
      const disabledSeverity = liveSeverity(profile);

      args.checks.push(
        createCheck({
          id: `account_subscription_${accountSubscription.id}_allocation_enabled`,
          label: 'Assigned allocation is enabled',
          severity: disabledSeverity,
          status: failingStatus(disabledSeverity),
          message: `Active subscription ${accountSubscription.subscription.key} is assigned to a disabled allocation.`,
          details: {
            tradingAccountSubscriptionId: accountSubscription.id,
            allocationId: accountSubscription.allocationId,
          },
        })
      );
    }

    if (!accountSubscription.subscription.enabled) {
      args.checks.push(
        createCheck({
          id: `subscription_${accountSubscription.subscriptionId}_enabled`,
          label: 'Underlying subscription is enabled',
          severity,
          status: failingStatus(severity),
          message: `Underlying subscription ${accountSubscription.subscription.key} is disabled.`,
        })
      );
    }

    if (!accountSubscription.subscription.strategy?.enabled) {
      args.checks.push(
        createCheck({
          id: `subscription_${accountSubscription.subscriptionId}_strategy_enabled`,
          label: 'Underlying strategy is enabled',
          severity,
          status: failingStatus(severity),
          message: `Strategy for subscription ${accountSubscription.subscription.key} is disabled or missing.`,
        })
      );
    }

    if (!accountSubscription.subscription.exitProfile?.enabled) {
      args.checks.push(
        createCheck({
          id: `subscription_${accountSubscription.subscriptionId}_exit_profile_enabled`,
          label: 'Underlying exit profile is enabled',
          severity,
          status: failingStatus(severity),
          message: `Exit profile for subscription ${accountSubscription.subscription.key} is disabled or missing.`,
        })
      );
    }

    if (!accountSubscription.subscription.security?.enabled) {
      args.checks.push(
        createCheck({
          id: `subscription_${accountSubscription.subscriptionId}_security_enabled`,
          label: 'Underlying security is enabled',
          severity,
          status: failingStatus(severity),
          message: `Security for subscription ${accountSubscription.subscription.key} is disabled or missing.`,
        })
      );
    }
  }

  for (const allocation of args.allocations.filter(
    (allocation) => allocation.enabled
  )) {
    if (!isPositiveFiniteNumber(allocation.maxAllocatedNotional)) {
      const severity = liveSeverity(profile);

      args.checks.push(
        createCheck({
          id: `allocation_${allocation.id}_max_allocated_notional`,
          label: 'Enabled allocation has max allocated notional',
          severity,
          status: failingStatus(severity),
          message: `Enabled allocation ${allocation.key} is missing maxAllocatedNotional.`,
          details: {
            allocationId: allocation.id,
            allocationKey: allocation.key,
          },
        })
      );
    }

    if (
      profile === TradingAccountEnvironment.LIVE &&
      !isPositiveFiniteNumber(allocation.maxOpenPositions)
    ) {
      args.checks.push(
        createCheck({
          id: `allocation_${allocation.id}_max_open_positions`,
          label: 'Live allocation has max open positions',
          severity: 'blocker',
          status: 'fail',
          message: `Enabled live allocation ${allocation.key} is missing maxOpenPositions.`,
          details: {
            allocationId: allocation.id,
            allocationKey: allocation.key,
          },
        })
      );
    }
  }

  if (!args.globalConfig.tradingEnabled) {
    args.checks.push(
      createCheck({
        id: 'global_trading_enabled',
        label: 'Global trading is enabled',
        severity: 'blocker',
        status: 'fail',
        message: 'Global tradingEnabled is false.',
      })
    );
  }

  if (args.globalConfig.killSwitchEnabled) {
    args.checks.push(
      createCheck({
        id: 'global_kill_switch_disabled',
        label: 'Global kill switch is off',
        severity: 'blocker',
        status: 'fail',
        message: 'Global killSwitchEnabled is true.',
      })
    );
  }

  if (
    profile === TradingAccountEnvironment.LIVE &&
    args.globalConfig.paperMode
  ) {
    args.checks.push(
      createCheck({
        id: 'live_global_paper_mode_disabled',
        label: 'Global paper mode is disabled for live readiness',
        severity: 'blocker',
        status: 'fail',
        message: 'Global paperMode is still enabled while this account is LIVE.',
      })
    );
  }

  if (args.unattributedOpenPositions.length > 0) {
    args.checks.push(
      createCheck({
        id: 'open_positions_have_trading_account',
        label: 'Open positions have trading account attribution',
        severity: 'warning',
        status: 'warn',
        message: 'Some open positions do not have tradingAccountId attribution.',
        details: {
          count: args.unattributedOpenPositions.length,
          positions: args.unattributedOpenPositions,
        },
      })
    );
  }

  const unresolvedPositions = args.openPositions.filter(
    (position) =>
      position.subscriptionId !== null &&
      position.tradingAccountSubscriptionId === null
  );

  if (unresolvedPositions.length > 0) {
    const severity = liveSeverity(profile);

    args.checks.push(
      createCheck({
        id: 'open_positions_have_account_subscription_linkage',
        label: 'Open positions have account-subscription linkage',
        severity,
        status: failingStatus(severity),
        message:
          'Some open positions have subscription attribution but no account-subscription linkage.',
        details: {
          count: unresolvedPositions.length,
          positions: unresolvedPositions,
        },
      })
    );
  }

  args.checks.push(
    createCheck({
      id: 'broker_sync_freshness_threshold',
      label: 'Broker sync stale threshold',
      severity: 'info',
      status: 'info',
      message:
        'Broker portfolio value is treated as stale when lastBrokerSyncAt is older than 24 hours.',
      details: {
        staleAfterHours: 24,
        generatedAt: args.now.toISOString(),
      },
    })
  );
}

function addCapitalChecks(args: {
  account: RiskHealthAccount;
  allocationBudgetTotal: number;
  activeSubscriptionBudgetTotal: number;
  brokerPortfolioValue: number | null;
  checks: TradingAccountRiskHealthCheck[];
  maxSimultaneousAllocationExposure: number;
  now: Date;
}) {
  const profile = args.account.environment;
  const brokerPortfolioValueField = getBrokerPortfolioValueField(args.account);

  if (args.brokerPortfolioValue === null) {
    const severity = liveSeverity(profile);

    args.checks.push(
      createCheck({
        id: 'broker_portfolio_value_available',
        label: 'Broker portfolio value is available',
        severity,
        status: failingStatus(severity),
        message:
          'Broker portfolio value is unavailable. Readiness checks do not trust estimatedTradingCapital as capital truth.',
        details: {
          lastPortfolioValue: args.account.lastPortfolioValue,
          lastEquity: args.account.lastEquity,
          estimatedTradingCapital: args.account.estimatedTradingCapital,
        },
      })
    );
  }

  if (isBrokerSyncStale(args.account, args.now)) {
    const severity = liveSeverity(profile);

    args.checks.push(
      createCheck({
        id: 'broker_portfolio_value_fresh',
        label: 'Broker portfolio value is fresh',
        severity,
        status: failingStatus(severity),
        message: 'Broker portfolio value is missing or older than 24 hours.',
        details: {
          lastBrokerSyncAt: args.account.lastBrokerSyncAt?.toISOString() ?? null,
          staleAfterHours: 24,
        },
      })
    );
  }

  if (args.brokerPortfolioValue === null) {
    return;
  }

  const budgetChecks = [
    {
      id: 'allocation_budget_within_broker_portfolio_value',
      label: 'Allocation budget total fits broker portfolio value',
      budget: args.allocationBudgetTotal,
      message:
        'Enabled allocation budget total exceeds broker portfolio value.',
    },
    {
      id: 'active_subscription_budget_within_broker_portfolio_value',
      label: 'Active subscription budget total fits broker portfolio value',
      budget: args.activeSubscriptionBudgetTotal,
      message:
        'Active subscription budget total exceeds broker portfolio value.',
    },
    {
      id: 'max_simultaneous_exposure_within_broker_portfolio_value',
      label:
        'Max simultaneous allocation exposure fits broker portfolio value',
      budget: args.maxSimultaneousAllocationExposure,
      message:
        'Max simultaneous allocation exposure exceeds broker portfolio value.',
    },
  ];

  for (const check of budgetChecks) {
    if (check.budget <= args.brokerPortfolioValue) {
      args.checks.push(
        createCheck({
          id: check.id,
          label: check.label,
          severity: 'info',
          status: 'pass',
          message: `${check.label}.`,
          details: {
            brokerPortfolioValue: args.brokerPortfolioValue,
            brokerPortfolioValueField,
            budget: check.budget,
            surplus: args.brokerPortfolioValue - check.budget,
          },
        })
      );
      continue;
    }

    const severity = liveSeverity(profile);

    args.checks.push(
      createCheck({
        id: check.id,
        label: check.label,
        severity,
        status: failingStatus(severity),
        message: check.message,
        details: {
          brokerPortfolioValue: args.brokerPortfolioValue,
          brokerPortfolioValueField,
          budget: check.budget,
          deficit: check.budget - args.brokerPortfolioValue,
        },
      })
    );
  }
}

export async function getTradingAccountRiskHealth(
  tradingAccountId: number,
  options: BuildHealthOptions = {}
) {
  const now = options.now ?? new Date();
  const [
    account,
    allocations,
    accountSubscriptions,
    openPositions,
    unattributedOpenPositions,
    globalConfig,
    hierarchyViolations,
  ] = await Promise.all([
    prisma.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: RISK_HEALTH_ACCOUNT_SELECT,
    }),
    prisma.tradingAccountAllocation.findMany({
      where: { tradingAccountId },
      select: RISK_HEALTH_ALLOCATION_SELECT,
      orderBy: [{ enabled: 'desc' }, { key: 'asc' }],
    }),
    prisma.tradingAccountSubscription.findMany({
      where: { tradingAccountId },
      select: RISK_HEALTH_ACCOUNT_SUBSCRIPTION_SELECT,
      orderBy: [{ enabled: 'desc' }, { id: 'asc' }],
    }),
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId,
        status: {
          in: ACTIVE_POSITION_STATUSES,
        },
      },
      select: {
        id: true,
        symbol: true,
        marketValue: true,
        costBasis: true,
        subscriptionId: true,
        tradingAccountSubscriptionId: true,
      },
    }),
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId: null,
        status: {
          in: ACTIVE_POSITION_STATUSES,
        },
      },
      select: {
        id: true,
        symbol: true,
      },
    }),
    getRuntimeTradingConfig(),
    validateAccountRiskConfiguration(prisma, tradingAccountId),
  ]);

  if (!account) {
    return null;
  }

  const checks: TradingAccountRiskHealthCheck[] = [];
  const activeSubscriptions = activeAccountSubscriptions(accountSubscriptions);
  const effectiveEntryLimits = resolveEffectiveAccountEntryLimits({
    tradingAccountId,
    maxDeployableNotional: account.maxDeployableNotional,
    accountRiskSettings: account.riskSettings,
    globalConfig,
  });
  const accountUsage = await getTradingAccountEntryRiskUsage({
    tradingAccountId,
    symbol: '',
    now,
  });

  if (effectiveEntryLimits.usingLegacyGlobalFallback) {
    const severity = liveSeverity(account.environment);
    const fallbackFields = Object.entries(effectiveEntryLimits.limits)
      .filter(([, limit]) => limit.source === 'LEGACY_GLOBAL_FALLBACK')
      .map(([field]) => field);
    checks.push(
      createCheck({
        id: 'account_entry_limits_use_legacy_fallback',
        label: 'Routine entry limits are account-owned',
        severity,
        status: failingStatus(severity),
        message: `${account.environment} account uses legacy global fallback values for routine entry limits.`,
        details: { fallbackFields, effectiveEntryLimits },
      })
    );
  } else {
    checks.push(
      createCheck({
        id: 'account_entry_limits_account_owned',
        label: 'Routine entry limits are account-owned',
        severity: 'info',
        status: 'pass',
        message: 'All routine entry limits are configured on this Trading Account.',
        details: { effectiveEntryLimits },
      })
    );
  }

  if (
    activeSubscriptions.length > 0 &&
    !isPositiveFiniteNumber(account.maxDeployableNotional)
  ) {
    checks.push(
      createCheck({
        id: 'account_max_deployable_notional_configured',
        label: 'Account deployable ceiling is configured',
        severity: 'blocker',
        status: 'fail',
        message: 'Entry-enabled subscriptions require maxDeployableNotional.',
        details: { maxDeployableNotional: account.maxDeployableNotional },
      })
    );
  }

  if (
    isPositiveFiniteNumber(account.maxDeployableNotional) &&
    accountUsage.currentAccountExposure > account.maxDeployableNotional
  ) {
    checks.push(
      createCheck({
        id: 'account_current_exposure_within_deployable_notional',
        label: 'Current account exposure fits deployable capital',
        severity: 'blocker',
        status: 'fail',
        message: 'Open and pending entry exposure exceeds maxDeployableNotional.',
        details: {
          openPositionNotional: accountUsage.openPositionNotional,
          pendingEntryNotional: accountUsage.pendingEntryNotional,
          currentAccountExposure: accountUsage.currentAccountExposure,
          maxDeployableNotional: account.maxDeployableNotional,
        },
      })
    );
  }

  for (const [field, value] of Object.entries({
    maxTotalOpenNotional: account.riskSettings?.maxTotalOpenNotional ?? null,
    maxSubscriptionOpenNotional:
      account.riskSettings?.maxSubscriptionOpenNotional ?? null,
  })) {
    if (value === null) continue;
    checks.push(
      createCheck({
        id: `account_${field}_superseded`,
        label: `${field} is superseded`,
        severity: 'info',
        status: 'info',
        message: `${field} remains stored for compatibility but is not authoritative for resolved account-subscription entries.`,
        details: { field, value },
      })
    );
  }
  for (const hierarchyViolation of hierarchyViolations ?? []) {
    const affectsActiveEntries =
      hierarchyViolation.entityType === 'TradingAccountSubscription' ||
      (hierarchyViolation.entityType === 'TradingAccountAllocation'
        ? activeSubscriptions.some(
            (item) => item.allocationId === hierarchyViolation.allocationId
          )
        : activeSubscriptions.length > 0);
    const severity = affectsActiveEntries ? 'blocker' : 'warning';
    checks.push(
      createCheck({
        id: `account_risk_configuration_${hierarchyViolation.code.toLowerCase()}_${hierarchyViolation.entityId ?? 'new'}`,
        label: 'Account capital hierarchy is valid',
        severity,
        status: affectsActiveEntries ? 'fail' : 'warn',
        message: hierarchyViolation.message,
        details: hierarchyViolation,
      })
    );
  }
  const enabledAllocations = allocations.filter(
    (allocation) => allocation.enabled
  );
  const allocationBudgetTotal = enabledAllocations.reduce(
    (total, allocation) =>
      total + (isPositiveFiniteNumber(allocation.maxAllocatedNotional)
        ? allocation.maxAllocatedNotional
        : 0),
    0
  );
  const plannedExposures = await getPlannedExposures({
    accountSubscriptions: activeSubscriptions,
    checks,
    profile: account.environment,
  });
  const activeSubscriptionBudgetTotal = sumPlannedExposure(plannedExposures);
  const maxSimultaneousAllocationExposure =
    getMaxSimultaneousAllocationExposure({
      allocations,
      exposures: plannedExposures,
    });
  const brokerPortfolioValue = getBrokerPortfolioValue(account);
  addSharedChecks({
    account,
    accountSubscriptions,
    allocations,
    checks,
    globalConfig,
    openPositions,
    unattributedOpenPositions,
    now,
  });
  addCapitalChecks({
    account,
    allocationBudgetTotal,
    activeSubscriptionBudgetTotal,
    brokerPortfolioValue,
    checks,
    maxSimultaneousAllocationExposure,
    now,
  });

  const status = getReadinessStatus(checks);
  const blockers = checks.filter(
    (check) => check.severity === 'blocker' && check.status === 'fail'
  );
  const warnings = checks.filter(
    (check) => check.severity === 'warning' && check.status === 'warn'
  );
  const info = checks.filter((check) => check.severity === 'info');

  return {
    tradingAccountId: account.id,
    status,
    profile: account.environment,
    readyForEntries: status !== 'BLOCKED',
    generatedAt: now.toISOString(),
    tradingAccount: {
      id: account.id,
      displayName: account.displayName,
      broker: account.broker,
      environment: account.environment,
      status: account.status,
      tradingEnabled: account.tradingEnabled,
      killSwitchEnabled: account.killSwitchEnabled,
    },
    capital: {
      brokerPortfolioValue,
      brokerPortfolioValueAt: account.lastBrokerSyncAt?.toISOString() ?? null,
      brokerCash: account.lastCash,
      brokerBuyingPower: account.lastBuyingPower,
      estimatedTradingCapital: account.estimatedTradingCapital,
      maxDeployableNotional: account.maxDeployableNotional,
      openPositionNotional: accountUsage.openPositionNotional,
      pendingEntryNotional: accountUsage.pendingEntryNotional,
      currentAccountExposure: accountUsage.currentAccountExposure,
      remainingDeployableNotional:
        account.maxDeployableNotional === null
          ? null
          : account.maxDeployableNotional - accountUsage.currentAccountExposure,
      allocationBudgetTotal,
      activeSubscriptionBudgetTotal,
      maxSimultaneousAllocationExposure,
      allocationBudgetSurplus: surplus(
        brokerPortfolioValue,
        allocationBudgetTotal
      ),
      activeSubscriptionBudgetSurplus: surplus(
        brokerPortfolioValue,
        activeSubscriptionBudgetTotal
      ),
      maxSimultaneousExposureSurplus: surplus(
        brokerPortfolioValue,
        maxSimultaneousAllocationExposure
      ),
      capitalSource:
        brokerPortfolioValue !== null
          ? 'BROKER_PORTFOLIO_VALUE'
          : account.estimatedTradingCapital !== null
            ? 'ESTIMATED_TRADING_CAPITAL'
            : 'UNAVAILABLE',
    },
    effectiveEntryLimits,
    checks,
    blockers,
    warnings,
    info,
  };
}
