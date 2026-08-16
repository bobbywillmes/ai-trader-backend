import {
  BrokerCredentialStatus,
  Prisma,
  TradingAccountEnvironment,
  TradingAccountReadinessPurpose,
  TradingAccountReadinessResult,
  TradingAccountStatus,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type {
  CreateTradingAccountInput,
  ActivateTradingAccountInput,
  DeactivateTradingAccountInput,
  UpdateTradingAccountInput,
} from '../validators/trading-account.schema.js';
import { HttpError } from '../errors/http-error.js';
import {
  assertAccountRiskConfiguration,
  withAccountRiskConfigurationTransaction,
} from './trading-account-risk-configuration.service.js';
import {
  invalidateLiveWriteApprovals,
  LiveWriteCapability,
} from './live-write-approval.service.js';
import { getLiveWriteApprovalState } from './live-write-approval.service.js';
import {
  CREDENTIAL_VERIFICATION_MAX_AGE_MS,
  READINESS_ASSESSMENT_VERSION,
  computeReadinessFingerprints,
} from './trading-account-readiness.service.js';
import {
  ACCOUNT_WORKFLOW_LOCK_FAMILIES,
  withTradingAccountWorkflowLock,
} from './trading-account-workflow-lock.service.js';

const LEGACY_DEFAULT_TRADING_ACCOUNT = {
  broker: TradingBroker.ALPACA,
  environment: TradingAccountEnvironment.PAPER,
  displayName: 'Bobby Paper',
} as const;

const ACTIVE_POSITION_STATUSES = ['open', 'closing'];

const TRADING_ACCOUNT_ADMIN_SELECT = {
  id: true,
  accountHolderUserId: true,
  accountHolder: {
    select: {
      name: true,
    },
  },
  displayName: true,
  broker: true,
  environment: true,
  status: true,
  tradingEnabled: true,
  killSwitchEnabled: true,
  estimatedTradingCapital: true,
  maxDeployableNotional: true,
  baseCurrency: true,
  brokerAccountId: true,
  brokerAccountNumberMasked: true,
  brokerAccountStatus: true,
  lastBrokerSyncAt: true,
  lastCash: true,
  lastBuyingPower: true,
  lastEquity: true,
  lastPortfolioValue: true,
  pausedReason: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  credential: {
    select: {
      status: true,
      authType: true,
      keyFingerprint: true,
      verifiedAt: true,
      lastUsedAt: true,
      lastFailedAt: true,
      revokedAt: true,
    },
  },
  allocations: {
    where: { enabled: true },
    select: { maxAllocatedNotional: true },
  },
} satisfies Prisma.TradingAccountSelect;

export const TRADING_ACCOUNT_SUMMARY_SELECT = {
  id: true,
  displayName: true,
  broker: true,
  environment: true,
  status: true,
} satisfies Prisma.TradingAccountSelect;

type TradingAccountAdminRecord = Prisma.TradingAccountGetPayload<{
  select: typeof TRADING_ACCOUNT_ADMIN_SELECT;
}>;

type TradingAccountOpenPositionExposure = {
  tradingAccountId: number | null;
  marketValue: number;
  costBasis: number;
};

export type TradingAccountSummaryResponse = Prisma.TradingAccountGetPayload<{
  select: typeof TRADING_ACCOUNT_SUMMARY_SELECT;
}>;

export type TradingAccountAdminResponse = ReturnType<
  typeof serializeTradingAccountForAdmin
>;

const TRADING_ACCOUNT_OPERATIONAL_STATE_SELECT = {
  status: true,
  tradingEnabled: true,
  killSwitchEnabled: true,
} satisfies Prisma.TradingAccountSelect;

type TradingAccountOperationalState = Prisma.TradingAccountGetPayload<{
  select: typeof TRADING_ACCOUNT_OPERATIONAL_STATE_SELECT;
}>;

function missingDefaultTradingAccountError() {
  return new Error(
    'Default trading account could not be resolved. Set DEFAULT_TRADING_ACCOUNT_ID to a valid TradingAccount id or run scripts/bootstrap-default-trading-account.ts to create the Bobby Paper default account.',
  );
}

export async function getTradingAccountById(id: number) {
  return prisma.tradingAccount.findUnique({
    where: { id },
  });
}

export function serializeTradingAccountForAdmin(
  account: TradingAccountAdminRecord,
  totalOpenPositionNotional = 0,
) {
  const credential = account.credential;
  const enabledAllocatedNotional = (account.allocations ?? []).reduce(
    (total, allocation) => total + (allocation.maxAllocatedNotional ?? 0),
    0,
  );
  const remainingDeployableNotional =
    account.maxDeployableNotional === null
      ? null
      : account.maxDeployableNotional - enabledAllocatedNotional;

  return {
    id: account.id,
    accountHolderUserId: account.accountHolderUserId,
    accountHolderName: account.accountHolder.name,
    displayName: account.displayName,
    broker: account.broker,
    environment: account.environment,
    status: account.status,
    tradingEnabled: account.tradingEnabled,
    killSwitchEnabled: account.killSwitchEnabled,
    estimatedTradingCapital: account.estimatedTradingCapital,
    maxDeployableNotional: account.maxDeployableNotional,
    enabledAllocatedNotional,
    remainingDeployableNotional,
    baseCurrency: account.baseCurrency,
    brokerAccountId: account.brokerAccountId,
    brokerAccountNumberMasked: account.brokerAccountNumberMasked,
    brokerAccountStatus: account.brokerAccountStatus,
    lastBrokerSyncAt: account.lastBrokerSyncAt,
    lastCash: account.lastCash,
    lastBuyingPower: account.lastBuyingPower,
    lastEquity: account.lastEquity,
    lastPortfolioValue: account.lastPortfolioValue,
    totalOpenPositionNotional,
    pausedReason: account.pausedReason,
    notes: account.notes,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    credential: {
      exists: credential !== null,
      status: credential?.status ?? null,
      authType: credential?.authType ?? null,
      keyFingerprint: credential?.keyFingerprint ?? null,
      verifiedAt: credential?.verifiedAt ?? null,
      lastUsedAt: credential?.lastUsedAt ?? null,
      lastFailedAt: credential?.lastFailedAt ?? null,
      revokedAt: credential?.revokedAt ?? null,
    },
  };
}

function duplicateTradingAccountError(environment: TradingAccountEnvironment) {
  return new HttpError(
    409,
    `The selected User already has an Alpaca ${environment === TradingAccountEnvironment.PAPER ? 'Paper' : 'Live'} Trading Account.`,
  );
}

export async function createTradingAccountForAdmin(
  input: CreateTradingAccountInput,
) {
  try {
    const accountId = await prisma.$transaction(async (tx) => {
      const holder = await tx.user.findUnique({
        where: { id: input.accountHolderUserId },
        select: { id: true, enabled: true },
      });
      if (!holder) throw new HttpError(404, 'Account holder User not found.');
      if (!holder.enabled)
        throw new HttpError(400, 'Account holder User must be enabled.');

      const duplicate = await tx.tradingAccount.findFirst({
        where: {
          accountHolderUserId: input.accountHolderUserId,
          broker: TradingBroker.ALPACA,
          environment: input.environment,
        },
        select: { id: true },
      });
      if (duplicate) throw duplicateTradingAccountError(input.environment);

      const created = await tx.tradingAccount.create({
        data: {
          accountHolderUserId: input.accountHolderUserId,
          displayName: input.displayName,
          broker: TradingBroker.ALPACA,
          environment: input.environment,
          status: TradingAccountStatus.NEEDS_CREDENTIALS,
          tradingEnabled: false,
          killSwitchEnabled: true,
          baseCurrency: 'USD',
          ...(input.estimatedTradingCapital !== undefined && {
            estimatedTradingCapital: input.estimatedTradingCapital,
          }),
          ...(input.maxDeployableNotional !== undefined && {
            maxDeployableNotional: input.maxDeployableNotional,
          }),
          ...(input.notes !== undefined && { notes: input.notes }),
          memberships: { create: { userId: input.accountHolderUserId } },
        },
        select: { id: true },
      });
      return created.id;
    });
    const account = await getTradingAccountForAdmin(accountId);
    if (!account)
      throw new Error('Created Trading Account could not be loaded.');
    return account;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw duplicateTradingAccountError(input.environment);
    }
    throw error;
  }
}

function getPositionExposure(position: {
  marketValue: number;
  costBasis: number;
}) {
  const exposure = position.marketValue || position.costBasis || 0;
  return Math.abs(exposure);
}

function sumOpenPositionNotional(
  positions: TradingAccountOpenPositionExposure[],
) {
  return positions.reduce(
    (total, position) => total + getPositionExposure(position),
    0,
  );
}

async function getOpenPositionNotionalByTradingAccountId(
  tradingAccountIds: number[],
) {
  if (tradingAccountIds.length === 0) {
    return new Map<number, number>();
  }

  const positions = await prisma.trackedPosition.findMany({
    where: {
      tradingAccountId: {
        in: tradingAccountIds,
      },
      status: {
        in: ACTIVE_POSITION_STATUSES,
      },
    },
    select: {
      tradingAccountId: true,
      marketValue: true,
      costBasis: true,
    },
  });

  const totals = new Map<number, number>();

  for (const position of positions) {
    if (position.tradingAccountId === null) {
      continue;
    }

    totals.set(
      position.tradingAccountId,
      (totals.get(position.tradingAccountId) ?? 0) +
        getPositionExposure(position),
    );
  }

  return totals;
}

export async function listTradingAccountsForAdmin() {
  const accounts = await prisma.tradingAccount.findMany({
    select: TRADING_ACCOUNT_ADMIN_SELECT,
    orderBy: {
      id: 'asc',
    },
  });
  const openPositionNotionalByAccount =
    await getOpenPositionNotionalByTradingAccountId(
      accounts.map((account) => account.id),
    );

  return accounts.map((account) =>
    serializeTradingAccountForAdmin(
      account,
      openPositionNotionalByAccount.get(account.id) ?? 0,
    ),
  );
}

export async function listTradingAccountsForUser(args: {
  userId: number;
  isSystemOwner: boolean;
}) {
  const accounts = await listTradingAccountsForAdmin();

  // System owners, including the static admin context, can see all accounts.
  if (args.isSystemOwner) {
    return accounts;
  }

  const memberships = await prisma.tradingAccountMembership.findMany({
    where: {
      userId: args.userId,
    },
    select: {
      tradingAccountId: true,
    },
  });

  const allowedAccountIds = new Set(
    memberships.map((membership) => membership.tradingAccountId),
  );

  return accounts.filter((account) => allowedAccountIds.has(account.id));
}

export async function getTradingAccountForAdmin(id: number) {
  const [account, positions] = await Promise.all([
    prisma.tradingAccount.findUnique({
      where: { id },
      select: TRADING_ACCOUNT_ADMIN_SELECT,
    }),
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId: id,
        status: {
          in: ACTIVE_POSITION_STATUSES,
        },
      },
      select: {
        tradingAccountId: true,
        marketValue: true,
        costBasis: true,
      },
    }),
  ]);

  return account
    ? serializeTradingAccountForAdmin(
        account,
        sumOpenPositionNotional(positions),
      )
    : null;
}

export async function getTradingAccountSummaryById(id: number) {
  return prisma.tradingAccount.findUnique({
    where: { id },
    select: TRADING_ACCOUNT_SUMMARY_SELECT,
  });
}

export async function updateTradingAccountForAdmin(
  id: number,
  input: UpdateTradingAccountInput,
) {
  const data: Prisma.TradingAccountUpdateInput = {
    ...(input.displayName !== undefined && { displayName: input.displayName }),
    ...(input.estimatedTradingCapital !== undefined && {
      estimatedTradingCapital: input.estimatedTradingCapital,
    }),
    ...(input.maxDeployableNotional !== undefined && {
      maxDeployableNotional: input.maxDeployableNotional,
    }),
    ...(input.pausedReason !== undefined && {
      pausedReason: input.pausedReason,
    }),
    ...(input.notes !== undefined && { notes: input.notes }),
  };

  return withAccountRiskConfigurationTransaction(async (tx) => {
    const existing = await tx.tradingAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) return null;

    if (input.maxDeployableNotional !== undefined) {
      await assertAccountRiskConfiguration(tx, id, {
        account: { maxDeployableNotional: input.maxDeployableNotional },
      });
    }

    const account = await tx.tradingAccount.update({
      where: { id },
      data,
      select: TRADING_ACCOUNT_ADMIN_SELECT,
    });
    if (input.maxDeployableNotional !== undefined) {
      await invalidateLiveWriteApprovals(
        tx,
        id,
        [LiveWriteCapability.ENTRY],
        'Account deployable notional changed.',
      );
    }
    return serializeTradingAccountForAdmin(account);
  });
}

function changedOperationalFields(
  before: TradingAccountOperationalState,
  after: TradingAccountOperationalState,
) {
  return (
    Object.keys(after) as Array<keyof TradingAccountOperationalState>
  ).filter((field) => before[field] !== after[field]);
}

export async function deactivateTradingAccountForAdmin(
  id: number,
  input: DeactivateTradingAccountInput,
  actorUserId: number,
) {
  const locked = await withTradingAccountWorkflowLock({
    tradingAccountId: id,
    workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.OPERATIONAL_STATE,
    processInstanceId: `deactivate:${actorUserId}`,
    execute: () =>
      withAccountRiskConfigurationTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${id} FOR UPDATE`;
        const account = await tx.tradingAccount.findUnique({
          where: { id },
          select: {
            id: true,
            environment: true,
            ...TRADING_ACCOUNT_OPERATIONAL_STATE_SELECT,
          },
        });
        if (!account) return null;

        const before: TradingAccountOperationalState = {
          status: account.status,
          tradingEnabled: account.tradingEnabled,
          killSwitchEnabled: account.killSwitchEnabled,
        };
        const after: TradingAccountOperationalState = {
          status: TradingAccountStatus.PAUSED,
          tradingEnabled: false,
          killSwitchEnabled: true,
        };

        await tx.tradingAccount.update({
          where: { id },
          data: after,
        });

        const disabledAssignments =
          account.environment === TradingAccountEnvironment.LIVE
            ? await tx.tradingAccountSubscription.updateMany({
                where: { tradingAccountId: id, entriesEnabled: true },
                data: { entriesEnabled: false },
              })
            : { count: 0 };

        const blockedEntries = await tx.orderIntent.updateMany({
          where: {
            tradingAccountId: id,
            status: 'pending',
            side: 'buy',
          },
          data: {
            status: 'blocked',
            blockReason: `Trading account deactivated: ${input.reason}`,
          },
        });
        await invalidateLiveWriteApprovals(
          tx,
          id,
          [LiveWriteCapability.ENTRY],
          'Trading account was deactivated.',
        );

        const occurredAt = new Date();
        await tx.systemEvent.create({
          data: {
            type: 'trading_account.deactivated',
            entityType: 'tradingAccount',
            entityId: String(id),
            tradingAccountId: id,
            actorUserId: actorUserId > 0 ? actorUserId : null,
            message: `Trading account ${id} was deactivated.`,
            payloadJson: {
              actorUserId,
              tradingAccountId: id,
              occurredAt: occurredAt.toISOString(),
              reason: input.reason,
              before,
              after,
              changedFields: changedOperationalFields(before, after),
              affectedPendingEntryIntentCount: blockedEntries.count,
              affectedEntryEnabledAssignmentCount: disabledAssignments.count,
            },
          },
        });

        return {
          before,
          after,
          affectedPendingEntryIntentCount: blockedEntries.count,
          affectedEntryEnabledAssignmentCount: disabledAssignments.count,
        };
      }),
  });
  if (locked.outcome === 'ACQUIRED_AND_COMPLETED') return locked.value;
  if (locked.outcome === 'NOT_ACQUIRED') {
    throw new HttpError(
      409,
      'A Trading Account operational-state change is already running.',
    );
  }
  throw locked.error;
}

export async function activateTradingAccountForAdmin(
  id: number,
  input: ActivateTradingAccountInput,
  actorUserId: number,
) {
  const locked = await withTradingAccountWorkflowLock({
    tradingAccountId: id,
    workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.OPERATIONAL_STATE,
    processInstanceId: `activate:${actorUserId}`,
    execute: () =>
      withAccountRiskConfigurationTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${id} FOR UPDATE`;
        const account = await tx.tradingAccount.findUnique({
          where: { id },
          include: {
            credential: true,
            accountSubscriptions: {
              where: { enabled: true },
              select: { id: true, entriesEnabled: true, exitsEnabled: true },
            },
          },
        });
        if (!account) return null;
        if (account.environment !== TradingAccountEnvironment.LIVE) {
          throw new HttpError(
            400,
            'Activation is available only for LIVE Trading Accounts.',
          );
        }
        if (
          account.status === TradingAccountStatus.ACTIVE &&
          !account.tradingEnabled &&
          account.killSwitchEnabled
        ) {
          return {
            outcome: 'already_active_disarmed' as const,
            before: {
              status: account.status,
              tradingEnabled: account.tradingEnabled,
              killSwitchEnabled: account.killSwitchEnabled,
            },
            after: {
              status: account.status,
              tradingEnabled: account.tradingEnabled,
              killSwitchEnabled: account.killSwitchEnabled,
            },
            readinessAssessmentId: input.readinessAssessmentId,
          };
        }
        if (
          account.status !== TradingAccountStatus.PAUSED ||
          account.tradingEnabled ||
          !account.killSwitchEnabled
        ) {
          throw new HttpError(
            409,
            'Activation requires the exact PAUSED / trading disabled / kill switch enabled starting posture.',
          );
        }
        if (account.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new HttpError(
            409,
            'Trading Account changed; refresh and retry activation.',
          );
        }
        if (
          env.NODE_ENV !== 'production' ||
          env.LIVE_WRITE_DEPLOYMENT_ROLE !== 'PRODUCTION_EXECUTOR'
        ) {
          throw new HttpError(
            403,
            'Activation requires a production executor deployment.',
          );
        }
        if (!env.ALLOW_LIVE_RISK_REDUCING_WRITES || env.ALLOW_LIVE_TRADING) {
          throw new HttpError(
            409,
            'Activation requires risk-reducing writes enabled and Live entry writes disabled.',
          );
        }
        const assessment = await tx.tradingAccountReadinessAssessment.findFirst(
          {
            where: {
              id: input.readinessAssessmentId,
              tradingAccountId: id,
              purpose: TradingAccountReadinessPurpose.LIVE_ACTIVATION,
            },
          },
        );
        if (!assessment)
          throw new HttpError(
            409,
            'A same-account LIVE_ACTIVATION readiness assessment is required.',
          );
        if (assessment.result !== TradingAccountReadinessResult.PASSED) {
          throw new HttpError(
            409,
            'Activation readiness assessment did not pass.',
          );
        }
        if (assessment.assessmentVersion !== READINESS_ASSESSMENT_VERSION) {
          throw new HttpError(
            409,
            'Activation readiness assessment version is unsupported.',
          );
        }
        if (assessment.expiresAt.getTime() <= Date.now()) {
          throw new HttpError(
            409,
            'Activation readiness assessment has expired.',
          );
        }
        const fingerprints = await computeReadinessFingerprints(id, tx);
        if (
          !fingerprints ||
          fingerprints.configurationFingerprint !==
            assessment.configurationFingerprint ||
          fingerprints.credentialFingerprint !==
            assessment.credentialFingerprint ||
          fingerprints.policyFingerprint !== assessment.policyFingerprint
        ) {
          throw new HttpError(
            409,
            'Activation readiness evidence is stale. Run a new assessment.',
          );
        }
        const credential = account.credential;
        if (
          !credential ||
          credential.status !== BrokerCredentialStatus.ACTIVE ||
          credential.revokedAt ||
          !credential.verifiedAt ||
          Date.now() - credential.verifiedAt.getTime() >
            CREDENTIAL_VERIFICATION_MAX_AGE_MS
        ) {
          throw new HttpError(
            409,
            'Current usable and recently verified credentials are required.',
          );
        }
        if (
          !account.accountSubscriptions.length ||
          account.accountSubscriptions.some(
            (assignment) =>
              assignment.entriesEnabled || !assignment.exitsEnabled,
          )
        ) {
          throw new HttpError(
            409,
            'Enabled assignments must keep entries disabled and exits enabled.',
          );
        }
        const approvalState = await getLiveWriteApprovalState(id, tx);
        const riskApproval = approvalState.capabilities.find(
          (item) => item.capability === LiveWriteCapability.RISK_REDUCING,
        )!;
        const entryApproval = approvalState.capabilities.find(
          (item) => item.capability === LiveWriteCapability.ENTRY,
        )!;
        if (!riskApproval.effective)
          throw new HttpError(
            409,
            'Effective RISK_REDUCING approval is required.',
          );
        if (entryApproval.effective)
          throw new HttpError(
            409,
            'ENTRY approval must remain ineffective during activation.',
          );
        const [
          openPositions,
          closingPositions,
          nonterminalIntents,
          nonterminalOrders,
          exitAttention,
        ] = await Promise.all([
          tx.trackedPosition.count({
            where: { tradingAccountId: id, status: 'open' },
          }),
          tx.trackedPosition.count({
            where: { tradingAccountId: id, status: 'closing' },
          }),
          tx.orderIntent.count({
            where: {
              tradingAccountId: id,
              status: {
                in: ['received', 'pending', 'submitting', 'submitted'],
              },
            },
          }),
          tx.brokerOrder.count({
            where: {
              tradingAccountId: id,
              status: {
                notIn: [
                  'filled',
                  'canceled',
                  'cancelled',
                  'expired',
                  'rejected',
                  'replaced',
                  'done_for_day',
                  'calculated',
                ],
              },
            },
          }),
          tx.positionExitState.count({
            where: {
              attentionRequired: true,
              trackedPosition: { tradingAccountId: id },
            },
          }),
        ]);
        if (
          openPositions ||
          closingPositions ||
          nonterminalIntents ||
          nonterminalOrders ||
          exitAttention
        ) {
          throw new HttpError(
            409,
            'First activation requires zero current local lifecycle exposure.',
          );
        }
        const before = {
          status: account.status,
          tradingEnabled: account.tradingEnabled,
          killSwitchEnabled: account.killSwitchEnabled,
        };
        const after = {
          status: TradingAccountStatus.ACTIVE,
          tradingEnabled: false,
          killSwitchEnabled: true,
        };
        await tx.tradingAccount.update({
          where: { id },
          data: { ...after, pausedReason: null },
        });
        await tx.systemEvent.create({
          data: {
            type: 'trading_account.activated',
            entityType: 'tradingAccount',
            entityId: String(id),
            tradingAccountId: id,
            actorUserId,
            message: `Trading account ${id} activated with entries disarmed.`,
            payloadJson: {
              actorUserId,
              reason: input.reason,
              typedConfirmation: input.typedConfirmation,
              before,
              after,
              readinessAssessmentId: assessment.id,
              assessmentVersion: assessment.assessmentVersion,
              assessmentCompletedAt: assessment.completedAt.toISOString(),
              assessmentExpiresAt: assessment.expiresAt.toISOString(),
              fingerprintPrefixes: {
                configuration: assessment.configurationFingerprint.slice(0, 12),
                credential: assessment.credentialFingerprint.slice(0, 12),
                policy: assessment.policyFingerprint.slice(0, 12),
              },
              deploymentPolicy: {
                role: env.LIVE_WRITE_DEPLOYMENT_ROLE,
                allowLiveRiskReducingWrites:
                  env.ALLOW_LIVE_RISK_REDUCING_WRITES,
                allowLiveTrading: env.ALLOW_LIVE_TRADING,
              },
              liveWriteApprovals: {
                riskReducing: {
                  effective: riskApproval.effective,
                  revision: riskApproval.approval?.revision ?? null,
                },
                entry: {
                  effective: entryApproval.effective,
                  reason: entryApproval.reason,
                },
              },
              enabledAssignments: account.accountSubscriptions,
              localEvidence: {
                openPositions,
                closingPositions,
                nonterminalIntents,
                nonterminalOrders,
                exitAttention,
              },
            },
          },
        });
        return {
          outcome: 'activated' as const,
          before,
          after,
          readinessAssessmentId: assessment.id,
        };
      }),
  });
  if (locked.outcome === 'ACQUIRED_AND_COMPLETED') return locked.value;
  if (locked.outcome === 'NOT_ACQUIRED')
    throw new HttpError(
      409,
      'A Trading Account operational-state change is already running.',
    );
  throw locked.error;
}

export async function resolveDefaultTradingAccount(): Promise<TradingAccount> {
  if (env.DEFAULT_TRADING_ACCOUNT_ID !== undefined) {
    const configured = await getTradingAccountById(
      env.DEFAULT_TRADING_ACCOUNT_ID,
    );

    if (!configured) {
      throw missingDefaultTradingAccountError();
    }

    return configured;
  }

  const fallback = await prisma.tradingAccount.findFirst({
    where: {
      ...LEGACY_DEFAULT_TRADING_ACCOUNT,
      status: TradingAccountStatus.ACTIVE,
    },
    orderBy: {
      id: 'asc',
    },
  });

  if (!fallback) {
    throw missingDefaultTradingAccountError();
  }

  return fallback;
}

export async function resolveDefaultTradingAccountId() {
  const account = await resolveDefaultTradingAccount();
  return account.id;
}
