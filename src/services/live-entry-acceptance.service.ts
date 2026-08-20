import { Prisma, TradingAccountEnvironment } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

export const liveEntryAcceptancePhases = [
  'SETUP',
  'AUTHORIZATION',
  'READINESS',
  'ARMING',
  'EXECUTION',
  'VERIFICATION',
  'COMPLETION',
  'ACTION_REQUIRED',
] as const;

export type LiveEntryAcceptancePhase =
  (typeof liveEntryAcceptancePhases)[number];

export type LiveEntryAcceptanceProjectionInput = {
  terminalOutcome: 'CANARY_COMPLETE' | 'FAILED_SAFE' | 'OPERATOR_ABORTED' | null;
  terminalAt: Date | null;
  executionClaimedAt: Date | null;
  executionUncertainAt: Date | null;
  previewRevision: number;
  previewFingerprint: string | null;
  liveEntryArming: {
    id: number;
    entryApprovalExpiresAt: Date;
    terminations: ReadonlyArray<{ type: string }>;
  } | null;
  orderIntent: {
    id: number;
    status: string;
    brokerOrders: ReadonlyArray<{ id: number; status: string }>;
  } | null;
  setupReady: boolean;
  authorizationReady: boolean;
  readinessReady: boolean;
};

export function deriveLiveEntryAcceptancePhase(
  input: LiveEntryAcceptanceProjectionInput,
): LiveEntryAcceptancePhase {
  if (input.terminalAt && input.terminalOutcome) return 'COMPLETION';
  if (input.executionUncertainAt) return 'ACTION_REQUIRED';
  if (input.executionClaimedAt || input.orderIntent) return 'VERIFICATION';
  if (input.liveEntryArming) return 'EXECUTION';
  if (input.readinessReady) return 'ARMING';
  if (input.authorizationReady) return 'READINESS';
  if (input.setupReady) return 'AUTHORIZATION';
  return 'SETUP';
}

const RUN_INCLUDE = {
  tradingAccount: {
    select: {
      id: true,
      displayName: true,
      environment: true,
      status: true,
      tradingEnabled: true,
      killSwitchEnabled: true,
      activeLiveEntryArmingId: true,
    },
  },
  tradingAccountSubscription: {
    include: { subscription: { include: { security: true } } },
  },
  liveEntryArming: { include: { terminations: { orderBy: { occurredAt: 'asc' as const } } } },
  orderIntent: {
    include: {
      brokerOrders: true,
      brokerActivities: true,
      trackedPosition: { include: { exitState: true } },
    },
  },
} satisfies Prisma.LiveEntryAcceptanceRunInclude;

type AcceptanceRunEvidence = Prisma.LiveEntryAcceptanceRunGetPayload<{
  include: typeof RUN_INCLUDE;
}>;

function currentApprovalRevisions(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const revisions = value.liveWriteApprovalRevisions;
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) return null;
  return revisions;
}

async function derivePrerequisites(run: AcceptanceRunEvidence) {
  const [approvals, readiness] = await Promise.all([
    prisma.tradingAccountLiveWriteApproval.findMany({
      where: { tradingAccountId: run.tradingAccountId },
      select: { capability: true, status: true, revision: true, expiresAt: true },
    }),
    prisma.tradingAccountReadinessAssessment.findFirst({
      where: { tradingAccountId: run.tradingAccountId, purpose: 'LIVE_ENTRY_ARMING' },
      orderBy: { completedAt: 'desc' },
      select: {
        id: true,
        result: true,
        expiresAt: true,
        evidenceJson: true,
      },
    }),
  ]);
  const now = new Date();
  const risk = approvals.find((item) => item.capability === 'RISK_REDUCING');
  const entry = approvals.find((item) => item.capability === 'ENTRY');
  const riskEffective = risk?.status === 'GRANTED' && (!risk.expiresAt || risk.expiresAt > now);
  const entryEffective = entry?.status === 'GRANTED' && Boolean(entry.expiresAt && entry.expiresAt > now);
  const revisions = currentApprovalRevisions(readiness?.evidenceJson ?? null);
  const readinessReady = Boolean(
    readiness?.result === 'PASSED' &&
      readiness.expiresAt > now &&
      revisions?.riskReducing === risk?.revision &&
      revisions?.entry === entry?.revision,
  );
  return {
    authorizationReady: riskEffective && entryEffective,
    readinessReady,
    approvals,
    readiness,
  };
}

export async function projectLiveEntryAcceptanceRun(run: AcceptanceRunEvidence) {
  const prerequisites = await derivePrerequisites(run);
  const assignmentMatches =
    run.tradingAccountSubscription.tradingAccountId === run.tradingAccountId &&
    run.tradingAccountSubscription.subscriptionId === run.subscriptionId &&
    run.tradingAccountSubscription.subscription.securityId === run.securityId;
  const setupReady =
    run.tradingAccount.environment === 'LIVE' &&
    run.tradingAccount.status === 'ACTIVE' &&
    assignmentMatches;
  const phase = deriveLiveEntryAcceptancePhase({
    terminalOutcome: run.terminalOutcome,
    terminalAt: run.terminalAt,
    executionClaimedAt: run.executionClaimedAt,
    executionUncertainAt: run.executionUncertainAt,
    previewRevision: run.previewRevision,
    previewFingerprint: run.previewFingerprint,
    liveEntryArming: run.liveEntryArming,
    orderIntent: run.orderIntent,
    setupReady,
    authorizationReady: prerequisites.authorizationReady,
    readinessReady: prerequisites.readinessReady,
  });
  return {
    run,
    phase,
    unresolved: phase === 'ACTION_REQUIRED',
    setup: { ready: setupReady, assignmentMatches },
    authorization: {
      ready: prerequisites.authorizationReady,
      approvals: prerequisites.approvals,
    },
    readiness: {
      ready: prerequisites.readinessReady,
      assessment: prerequisites.readiness,
    },
    execution: {
      claimed: Boolean(run.executionClaimedAt),
      uncertain: Boolean(run.executionUncertainAt),
      previewFrozen: Boolean(run.executionClaimedAt),
    },
  };
}

export async function getLiveEntryAcceptanceRun(
  tradingAccountId: number,
  runId: number,
) {
  const run = await prisma.liveEntryAcceptanceRun.findFirst({
    where: { id: runId, tradingAccountId },
    include: RUN_INCLUDE,
  });
  if (!run) throw new HttpError(404, 'Live-entry acceptance run not found.');
  return projectLiveEntryAcceptanceRun(run);
}

export async function getCurrentLiveEntryAcceptanceRun(tradingAccountId: number) {
  const run = await prisma.liveEntryAcceptanceRun.findFirst({
    where: { tradingAccountId, terminalAt: null },
    include: RUN_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return run ? projectLiveEntryAcceptanceRun(run) : null;
}

export async function createLiveEntryAcceptanceRun(args: {
  tradingAccountId: number;
  tradingAccountSubscriptionId: number;
  createdByUserId: number;
  reason: string;
}) {
  const assignment = await prisma.tradingAccountSubscription.findFirst({
    where: {
      id: args.tradingAccountSubscriptionId,
      tradingAccountId: args.tradingAccountId,
    },
    include: {
      tradingAccount: { select: { environment: true, status: true } },
      subscription: { include: { security: true } },
    },
  });
  if (!assignment) throw new HttpError(404, 'Trading account assignment not found.');
  if (assignment.tradingAccount.environment !== TradingAccountEnvironment.LIVE) {
    throw new HttpError(409, 'Live-entry acceptance applies only to LIVE accounts.');
  }
  if (assignment.tradingAccount.status !== 'ACTIVE') {
    throw new HttpError(409, 'Live-entry acceptance requires an ACTIVE account.');
  }
  try {
    const run = await prisma.liveEntryAcceptanceRun.create({
      data: {
        tradingAccountId: args.tradingAccountId,
        tradingAccountSubscriptionId: assignment.id,
        subscriptionId: assignment.subscriptionId,
        securityId: assignment.subscription.securityId,
        createdByUserId: args.createdByUserId,
        reason: args.reason.trim(),
      },
      include: RUN_INCLUDE,
    });
    return projectLiveEntryAcceptanceRun(run);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'This Live account already has an unresolved acceptance run.');
    }
    throw error;
  }
}
