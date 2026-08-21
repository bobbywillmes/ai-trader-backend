import {
  LiveWriteApprovalAction,
  LiveWriteApprovalStatus,
  LiveWriteCapability,
  Prisma,
  TradingAccountEnvironment,
  TradingAccountReadinessPurpose,
} from '@prisma/client';
import { createHash } from 'node:crypto';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { isIsolatedManualAcceptanceEnvironment } from './manual-acceptance-environment.js';
import type { AlpacaBrokerOperationClass } from '../integrations/alpaca/request-metadata.js';
import { getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { getAlpacaPositions } from '../integrations/alpaca/positions.adapter.js';
import { getAlpacaMarketSessionSnapshot } from '../integrations/alpaca/market-session.adapter.js';

export { LiveWriteCapability };

const APPROVAL_CONFIGURATION_SELECT = {
  id: true,
  broker: true,
  environment: true,
  baseCurrency: true,
  maxDeployableNotional: true,
  brokerAccountId: true,
  riskSettings: true,
  allocations: { orderBy: { id: 'asc' as const } },
  accountSubscriptions: {
    orderBy: { id: 'asc' as const },
    include: {
      allocation: true,
      subscription: {
        include: { security: true, strategy: true, exitProfile: true },
      },
    },
  },
} satisfies Prisma.TradingAccountSelect;

const APPROVAL_CREDENTIAL_SELECT = {
  id: true,
  authType: true,
  status: true,
  keyFingerprint: true,
  encryptionVersion: true,
  verifiedAt: true,
  revokedAt: true,
  updatedAt: true,
} satisfies Prisma.TradingAccountCredentialSelect;

type DbClient = Prisma.TransactionClient | typeof prisma;

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  return value;
}

function approvalFingerprint(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

export type ApprovalFingerprints = {
  configurationFingerprint: string;
  credentialFingerprint: string;
};

export async function computeLiveWriteApprovalFingerprints(
  tradingAccountId: number,
  capability: LiveWriteCapability,
  db: DbClient = prisma,
): Promise<ApprovalFingerprints | null> {
  const [account, credential] = await Promise.all([
    db.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: APPROVAL_CONFIGURATION_SELECT,
    }),
    db.tradingAccountCredential.findUnique({
      where: { tradingAccountId },
      select: APPROVAL_CREDENTIAL_SELECT,
    }),
  ]);
  if (!account) return null;

  const configuration =
    capability === LiveWriteCapability.ENTRY
      ? account
      : {
          id: account.id,
          broker: account.broker,
          environment: account.environment,
          baseCurrency: account.baseCurrency,
          brokerAccountId: account.brokerAccountId,
          accountSubscriptions: account.accountSubscriptions.map(
            (assignment) => ({
              id: assignment.id,
              subscriptionId: assignment.subscriptionId,
              enabled: assignment.enabled,
              exitsEnabled: assignment.exitsEnabled,
              subscription: {
                id: assignment.subscription.id,
                symbol: assignment.subscription.symbol,
                enabled: assignment.subscription.enabled,
                security: assignment.subscription.security,
                exitProfile: assignment.subscription.exitProfile,
              },
            }),
          ),
        };

  return {
    configurationFingerprint: approvalFingerprint(configuration),
    credentialFingerprint: approvalFingerprint(credential),
  };
}

function effectiveState(
  approval: Awaited<ReturnType<typeof loadApproval>>,
  fingerprints: ApprovalFingerprints | null,
): { effective: boolean; reason: string | null } {
  if (!approval) return { effective: false, reason: 'MISSING' as const };
  if (approval.status !== LiveWriteApprovalStatus.GRANTED) {
    return {
      effective: false,
      reason: approval.status as 'REVOKED' | 'INVALIDATED',
    };
  }
  if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
    return { effective: false, reason: 'EXPIRED' as const };
  }
  if (
    !fingerprints ||
    approval.configurationFingerprint !==
      fingerprints.configurationFingerprint ||
    approval.credentialFingerprint !== fingerprints.credentialFingerprint
  ) {
    return { effective: false, reason: 'STALE_FINGERPRINT' as const };
  }
  return { effective: true, reason: null };
}

function loadApproval(
  tradingAccountId: number,
  capability: LiveWriteCapability,
  db: DbClient = prisma,
) {
  return db.tradingAccountLiveWriteApproval.findUnique({
    where: { tradingAccountId_capability: { tradingAccountId, capability } },
    include: {
      grantedByUser: { select: { id: true, name: true, email: true } },
      revokedByUser: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getLiveWriteApprovalState(
  tradingAccountId: number,
  db: DbClient = prisma,
) {
  const account = await db.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true, environment: true },
  });
  if (!account) throw new HttpError(404, 'Trading account not found.');
  const capabilities = await Promise.all(
    Object.values(LiveWriteCapability).map(async (capability) => {
      const [approval, fingerprints] = await Promise.all([
        loadApproval(tradingAccountId, capability, db),
        computeLiveWriteApprovalFingerprints(tradingAccountId, capability, db),
      ]);
      return {
        capability,
        approval,
        fingerprints,
        ...effectiveState(approval, fingerprints),
      };
    }),
  );
  const risk = capabilities.find(
    (item) => item.capability === LiveWriteCapability.RISK_REDUCING,
  )!;
  const entry = capabilities.find(
    (item) => item.capability === LiveWriteCapability.ENTRY,
  )!;
  if (entry.effective && !risk.effective) {
    entry.effective = false;
    entry.reason = 'RISK_REDUCING_DEPENDENCY_MISSING';
  }
  return {
    tradingAccountId,
    environment: account.environment,
    deploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE,
    deploymentCanWrite:
      env.NODE_ENV === 'production' &&
      env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR',
    manualAcceptanceHarness: isIsolatedManualAcceptanceEnvironment({
      sentinel: process.env.MANUAL_ACCEPTANCE_HARNESS,
      entrypoint: process.env.MANUAL_ACCEPTANCE_ENTRYPOINT,
      databaseUrl: env.DATABASE_URL ?? '',
      allowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    }),
    capabilities,
  };
}

export async function listLiveWriteApprovalHistory(tradingAccountId: number) {
  return prisma.tradingAccountLiveWriteApprovalDecision.findMany({
    where: { tradingAccountId },
    orderBy: { createdAt: 'desc' },
    include: { actorUser: { select: { id: true, name: true, email: true } } },
  });
}

export async function authorizeLiveBrokerWrite(
  tradingAccountId: number,
  operationClass: AlpacaBrokerOperationClass,
  db: DbClient = prisma,
) {
  const account = await db.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: {
      environment: true,
      status: true,
      tradingEnabled: true,
      killSwitchEnabled: true,
    },
  });
  if (!account) throw new HttpError(404, 'Trading account not found.');
  if (account.environment !== TradingAccountEnvironment.LIVE) return;
  if (
    env.NODE_ENV !== 'production' ||
    env.LIVE_WRITE_DEPLOYMENT_ROLE !== 'PRODUCTION_EXECUTOR'
  ) {
    throw new HttpError(
      403,
      `LIVE ${operationClass} blocked: this deployment is observation-only.`,
    );
  }
  const capability =
    operationClass === 'RISK_REDUCING_WRITE'
      ? LiveWriteCapability.RISK_REDUCING
      : operationClass === 'ENTRY_WRITE'
        ? LiveWriteCapability.ENTRY
        : null;
  if (!capability)
    throw new HttpError(
      403,
      `Unknown Live write classification ${operationClass}.`,
    );
  if (
    capability === LiveWriteCapability.ENTRY &&
    (account.status !== 'ACTIVE' ||
      !account.tradingEnabled ||
      account.killSwitchEnabled)
  ) {
    throw new HttpError(
      403,
      `LIVE ENTRY_WRITE blocked: TradingAccount ${tradingAccountId} is not ACTIVE with trading enabled and the kill switch disabled.`,
    );
  }
  if (
    !env.ALLOW_LIVE_RISK_REDUCING_WRITES ||
    (capability === LiveWriteCapability.ENTRY && !env.ALLOW_LIVE_TRADING)
  ) {
    throw new HttpError(
      403,
      `LIVE ${operationClass} blocked by deployment policy flags.`,
    );
  }
  const state = await getLiveWriteApprovalState(tradingAccountId, db);
  const approval = state.capabilities.find(
    (item) => item.capability === capability,
  )!;
  if (!approval.effective) {
    throw new HttpError(
      403,
      `LIVE ${operationClass} blocked: account approval is ${approval.reason}.`,
    );
  }
}

export type GrantLiveWriteApprovalInput = {
  reason: string;
  typedConfirmation: string;
  readinessAssessmentId: number;
  expectedConfigurationFingerprint: string;
  expectedCredentialFingerprint: string;
  expectedRevision: number;
  expiresAt?: Date | null | undefined;
};

type GrantAccountPosture = {
  status: string;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
};

export function resolveGrantReadinessPurpose(
  capability: LiveWriteCapability,
  account: GrantAccountPosture,
) {
  if (capability === LiveWriteCapability.ENTRY) {
    return TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING;
  }
  if (
    account.status === 'PAUSED' &&
    !account.tradingEnabled &&
    account.killSwitchEnabled
  ) {
    return TradingAccountReadinessPurpose.LIVE_ACTIVATION;
  }
  if (
    account.status === 'ACTIVE' &&
    !account.tradingEnabled &&
    account.killSwitchEnabled
  ) {
    return TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING;
  }
  throw new HttpError(
    409,
    'RISK_REDUCING approval requires exact PAUSED or ACTIVE entry-disarmed posture.',
  );
}

export async function grantLiveWriteApproval(args: {
  tradingAccountId: number;
  capability: LiveWriteCapability;
  actorUserId: number;
  input: GrantLiveWriteApprovalInput;
}) {
  if (
    env.NODE_ENV !== 'production' ||
    env.LIVE_WRITE_DEPLOYMENT_ROLE !== 'PRODUCTION_EXECUTOR'
  ) {
    throw new HttpError(
      403,
      'Live write approvals may only be granted by a production executor deployment.',
    );
  }
  const expectedConfirmation = `APPROVE LIVE ${args.capability}`;
  if (args.input.typedConfirmation !== expectedConfirmation) {
    throw new HttpError(
      400,
      `Typed confirmation must exactly match "${expectedConfirmation}".`,
    );
  }
  if (args.capability === LiveWriteCapability.ENTRY && !args.input.expiresAt) {
    throw new HttpError(400, 'ENTRY approval requires expiresAt.');
  }
  if (args.input.expiresAt && args.input.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'Approval expiration must be in the future.');
  }
  if (args.capability === LiveWriteCapability.ENTRY) {
    if (!args.input.expiresAt) {
      throw new HttpError(400, 'ENTRY approval requires an exact session-bounded expiration.');
    }
    const session = await getAlpacaMarketSessionSnapshot(args.tradingAccountId);
    const sessionCloseAt = session.sessionCloseAt ?? session.nextCloseAt;
    const sessionOpenAt = session.sessionOpenAt ?? session.nextOpenAt;
    if (!sessionCloseAt || !sessionOpenAt) {
      throw new HttpError(409, 'The intended regular U.S. trading session could not be determined.');
    }
    if (args.input.expiresAt.getTime() <= new Date(sessionOpenAt).getTime()) {
      throw new HttpError(409, 'ENTRY approval expiration must fall within the intended regular U.S. trading session.');
    }
    if (args.input.expiresAt.getTime() > new Date(sessionCloseAt).getTime()) {
      throw new HttpError(409, 'ENTRY approval expiration must not extend beyond the intended regular U.S. trading session.');
    }
  }

  return prisma.$transaction(
    async (tx) => {
      const account = await tx.tradingAccount.findUnique({
        where: { id: args.tradingAccountId },
        select: {
          environment: true,
          status: true,
          tradingEnabled: true,
          killSwitchEnabled: true,
        },
      });
      if (!account) throw new HttpError(404, 'Trading account not found.');
      if (account.environment !== TradingAccountEnvironment.LIVE) {
        throw new HttpError(
          400,
          'Live write approval can only be granted to a LIVE Trading Account.',
        );
      }
      const {
        computeReadinessFingerprints,
        isCredentialVerificationCurrent,
        LIVE_ENTRY_ARMING_READINESS_VERSION,
        READINESS_ASSESSMENT_VERSION,
      } = await import('./trading-account-readiness.service.js');
      const requiredPurpose = resolveGrantReadinessPurpose(
        args.capability,
        account,
      );
      const assessment = await tx.tradingAccountReadinessAssessment.findFirst({
        where: {
          id: args.input.readinessAssessmentId,
          tradingAccountId: args.tradingAccountId,
          purpose: requiredPurpose,
        },
      });
      if (!assessment)
        throw new HttpError(
          409,
          'A fresh same-account readiness assessment is required.',
        );
      if (assessment.expiresAt.getTime() <= Date.now())
        throw new HttpError(409, 'The readiness assessment has expired.');
      const supportedVersion = requiredPurpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING
        ? LIVE_ENTRY_ARMING_READINESS_VERSION
        : READINESS_ASSESSMENT_VERSION;
      if (assessment.assessmentVersion !== supportedVersion) {
        throw new HttpError(409, 'The readiness assessment version is not supported.');
      }
      if (!isCredentialVerificationCurrent(assessment.credentialVerifiedAt)) {
        throw new HttpError(
          409,
          'Credential verification is no longer current. Verify credentials and run a new readiness assessment.',
        );
      }
      if (args.capability === LiveWriteCapability.ENTRY) {
        const evidence = assessment.evidenceJson as Record<string, unknown>;
        if (assessment.result !== 'BLOCKED' || evidence.prerequisitesForEntryGrantPassed !== true) {
          throw new HttpError(409, 'ENTRY approval requires LIVE_ENTRY_ARMING readiness with every prerequisite passed and ENTRY as the sole expected blocker.');
        }
      }
      if (
        args.capability === LiveWriteCapability.RISK_REDUCING &&
        requiredPurpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING
      ) {
        const evidence = assessment.evidenceJson as Record<string, unknown>;
        if (evidence.prerequisitesForRiskReducingGrantPassed !== true) {
          throw new HttpError(
            409,
            'RISK_REDUCING approval requires LIVE_ENTRY_ARMING readiness with every non-authorization prerequisite passed.',
          );
        }
      }
      const currentReadinessFingerprints = await computeReadinessFingerprints(
        args.tradingAccountId,
        tx,
      );
      if (
        !currentReadinessFingerprints ||
        assessment.configurationFingerprint !==
          currentReadinessFingerprints.configurationFingerprint ||
        assessment.credentialFingerprint !==
          currentReadinessFingerprints.credentialFingerprint ||
        assessment.policyFingerprint !==
          currentReadinessFingerprints.policyFingerprint
      ) {
        throw new HttpError(
          409,
          'The readiness assessment is stale. Run a new assessment before granting approval.',
        );
      }
      const fingerprints = await computeLiveWriteApprovalFingerprints(
        args.tradingAccountId,
        args.capability,
        tx,
      );
      if (
        !fingerprints ||
        fingerprints.configurationFingerprint !==
          args.input.expectedConfigurationFingerprint ||
        fingerprints.credentialFingerprint !==
          args.input.expectedCredentialFingerprint
      ) {
        throw new HttpError(
          409,
          'Approval evidence changed; refresh before granting approval.',
        );
      }
      if (args.capability === LiveWriteCapability.ENTRY) {
        const risk = await loadApproval(
          args.tradingAccountId,
          LiveWriteCapability.RISK_REDUCING,
          tx,
        );
        const riskFingerprints = await computeLiveWriteApprovalFingerprints(
          args.tradingAccountId,
          LiveWriteCapability.RISK_REDUCING,
          tx,
        );
        if (!effectiveState(risk, riskFingerprints).effective) {
          throw new HttpError(
            409,
            'RISK_REDUCING approval must be effective before ENTRY approval can be granted.',
          );
        }
      }
      const current = await tx.tradingAccountLiveWriteApproval.findUnique({
        where: {
          tradingAccountId_capability: {
            tradingAccountId: args.tradingAccountId,
            capability: args.capability,
          },
        },
      });
      const priorRevision = current?.revision ?? 0;
      if (priorRevision !== args.input.expectedRevision)
        throw new HttpError(
          409,
          'Approval revision changed; refresh and retry.',
        );
      const now = new Date();
      const resultingRevision = priorRevision + 1;
      const data = {
        status: LiveWriteApprovalStatus.GRANTED,
        revision: resultingRevision,
        ...fingerprints,
        readinessAssessmentId: assessment.id,
        grantedByUserId: args.actorUserId,
        grantedAt: now,
        grantReason: args.input.reason,
        revokedByUserId: null,
        revokedAt: null,
        invalidationReason: null,
        expiresAt: args.input.expiresAt ?? null,
      };
      const approval = current
        ? await tx.tradingAccountLiveWriteApproval.update({
            where: { id: current.id },
            data,
          })
        : await tx.tradingAccountLiveWriteApproval.create({
            data: {
              tradingAccountId: args.tradingAccountId,
              capability: args.capability,
              ...data,
            },
          });
      await tx.tradingAccountLiveWriteApprovalDecision.create({
        data: {
          tradingAccountId: args.tradingAccountId,
          capability: args.capability,
          action: LiveWriteApprovalAction.GRANT,
          actorUserId: args.actorUserId,
          reason: args.input.reason,
          ...fingerprints,
          readinessAssessmentId: assessment.id,
          deploymentEnvironment: env.NODE_ENV,
          priorRevision,
          resultingRevision,
          expiresAt: args.input.expiresAt ?? null,
        },
      });
      await tx.systemEvent.create({
        data: {
          type: 'trading_account.live_write_approval_granted',
          entityType: 'TradingAccount',
          entityId: String(args.tradingAccountId),
          tradingAccountId: args.tradingAccountId,
          actorUserId: args.actorUserId,
          message: `${args.capability} Live write approval granted.`,
          payloadJson: {
            capability: args.capability,
            revision: resultingRevision,
            readinessAssessmentId: assessment.id,
            expiresAt: args.input.expiresAt?.toISOString() ?? null,
            fingerprintPrefixes: {
              configuration: fingerprints.configurationFingerprint.slice(0, 12),
              credential: fingerprints.credentialFingerprint.slice(0, 12),
            },
          },
        },
      });
      return approval;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function revokeLiveWriteApproval(args: {
  tradingAccountId: number;
  capability: LiveWriteCapability;
  actorUserId: number;
  reason: string;
  expectedRevision: number;
}) {
  if (args.capability === LiveWriteCapability.RISK_REDUCING) {
    const [positions, orders, localPositions, localOrders] = await Promise.all([
      getAlpacaPositions(args.tradingAccountId, 'manual_admin_action'),
      getOpenAlpacaOrders(args.tradingAccountId, 'manual_admin_action'),
      prisma.trackedPosition.count({
        where: {
          tradingAccountId: args.tradingAccountId,
          status: { in: ['open', 'closing'] },
        },
      }),
      prisma.brokerOrder.count({
        where: {
          tradingAccountId: args.tradingAccountId,
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
    ]);
    if (positions.length || orders.length || localPositions || localOrders) {
      throw new HttpError(
        409,
        'RISK_REDUCING approval cannot be revoked while broker or local exposure exists. Resolve exposure or use a future break-glass workflow.',
      );
    }
  }
  return changeApprovalState({
    ...args,
    status: LiveWriteApprovalStatus.REVOKED,
    action: LiveWriteApprovalAction.REVOKE,
  });
}

async function changeApprovalState(
  args: {
    tradingAccountId: number;
    capability: LiveWriteCapability;
    actorUserId: number | null;
    reason: string;
    expectedRevision?: number;
    status: LiveWriteApprovalStatus;
    action: LiveWriteApprovalAction;
  },
  db: DbClient = prisma,
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const current = await tx.tradingAccountLiveWriteApproval.findUnique({
      where: {
        tradingAccountId_capability: {
          tradingAccountId: args.tradingAccountId,
          capability: args.capability,
        },
      },
    });
    if (!current)
      throw new HttpError(404, 'Live write approval was not found.');
    if (
      args.expectedRevision !== undefined &&
      current.revision !== args.expectedRevision
    )
      throw new HttpError(409, 'Approval revision changed; refresh and retry.');
    const resultingRevision = current.revision + 1;
    const now = new Date();
    const approval = await tx.tradingAccountLiveWriteApproval.update({
      where: { id: current.id },
      data: {
        status: args.status,
        revision: resultingRevision,
        revokedByUserId: args.actorUserId,
        revokedAt: now,
        invalidationReason:
          args.status === LiveWriteApprovalStatus.INVALIDATED
            ? args.reason
            : null,
      },
    });
    await tx.tradingAccountLiveWriteApprovalDecision.create({
      data: {
        tradingAccountId: args.tradingAccountId,
        capability: args.capability,
        action: args.action,
        actorUserId: args.actorUserId,
        reason: args.reason,
        configurationFingerprint: current.configurationFingerprint,
        credentialFingerprint: current.credentialFingerprint,
        readinessAssessmentId: current.readinessAssessmentId,
        deploymentEnvironment: env.NODE_ENV,
        priorRevision: current.revision,
        resultingRevision,
        expiresAt: current.expiresAt,
      },
    });
    await tx.systemEvent.create({
      data: {
        type:
          args.action === LiveWriteApprovalAction.REVOKE
            ? 'trading_account.live_write_approval_revoked'
            : 'trading_account.live_write_approval_invalidated',
        entityType: 'TradingAccount',
        entityId: String(args.tradingAccountId),
        tradingAccountId: args.tradingAccountId,
        actorUserId: args.actorUserId,
        message: `${args.capability} Live write approval ${args.action.toLowerCase()}d.`,
        payloadJson: {
          capability: args.capability,
          revision: resultingRevision,
          reason: args.reason,
        },
      },
    });
    return approval;
  };
  return '$transaction' in db
    ? (db as typeof prisma).$transaction(execute, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    : execute(db as Prisma.TransactionClient);
}

export async function invalidateLiveWriteApprovals(
  db: Prisma.TransactionClient,
  tradingAccountId: number,
  capabilities: LiveWriteCapability[],
  reason: string,
) {
  for (const capability of capabilities) {
    const current = await db.tradingAccountLiveWriteApproval.findUnique({
      where: { tradingAccountId_capability: { tradingAccountId, capability } },
      select: { status: true },
    });
    if (current?.status === LiveWriteApprovalStatus.GRANTED) {
      await changeApprovalState(
        {
          tradingAccountId,
          capability,
          actorUserId: null,
          reason,
          status: LiveWriteApprovalStatus.INVALIDATED,
          action: LiveWriteApprovalAction.INVALIDATE,
        },
        db,
      );
    }
  }
}

export async function invalidateLiveWriteApprovalsForExitProfile(
  db: Prisma.TransactionClient,
  exitProfileId: number,
  reason: string,
) {
  const subscriptions = await db.subscription.findMany({
    where: { exitProfileId },
    select: { accountSubscriptions: { select: { tradingAccountId: true } } },
  });
  const accountIds = new Set(
    subscriptions.flatMap((subscription) =>
      subscription.accountSubscriptions.map(
        (assignment) => assignment.tradingAccountId,
      ),
    ),
  );
  for (const tradingAccountId of accountIds) {
    await invalidateLiveWriteApprovals(
      db,
      tradingAccountId,
      [LiveWriteCapability.RISK_REDUCING, LiveWriteCapability.ENTRY],
      reason,
    );
  }
}

export async function invalidateEntryApprovalsForSubscriptions(
  db: Prisma.TransactionClient,
  where: Prisma.SubscriptionWhereInput,
  reason: string,
) {
  const subscriptions = await db.subscription.findMany({
    where,
    select: { accountSubscriptions: { select: { tradingAccountId: true } } },
  });
  const accountIds = new Set(
    subscriptions.flatMap((subscription) =>
      subscription.accountSubscriptions.map(
        (assignment) => assignment.tradingAccountId,
      ),
    ),
  );
  for (const tradingAccountId of accountIds) {
    await invalidateLiveWriteApprovals(
      db,
      tradingAccountId,
      [LiveWriteCapability.ENTRY],
      reason,
    );
  }
}
