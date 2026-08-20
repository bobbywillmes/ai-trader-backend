import crypto from 'node:crypto';
import { Prisma, TradingAccountEnvironment } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { evaluateAssignmentEntry } from './assignment-entry-evaluation.service.js';
import { validateActiveLiveEntryArming } from './live-entry-arming.service.js';
import { submitOrder } from './place-order.service.js';
import { disarmLiveEntries } from './live-entry-arming.service.js';
import { syncSubmittedOrdersForAccount } from '../workers/order.worker.js';
import { syncBrokerActivitiesForAccount } from './broker-activity.service.js';
import { syncTrackedPositionsForAccount } from './position-tracking.service.js';
import { reconcileTradingAccount } from './reconciliation.service.js';
import { computeReadinessFingerprints } from './trading-account-readiness.service.js';

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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function liveEntryAcceptancePreviewFingerprint(value: unknown) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

function previewOrder(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const order = value.order;
  return order && typeof order === 'object' && !Array.isArray(order) ? order : null;
}

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
  const [approvals, readiness, fingerprints] = await Promise.all([
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
        configurationFingerprint: true,
        credentialFingerprint: true,
        policyFingerprint: true,
      },
    }),
    computeReadinessFingerprints(run.tradingAccountId),
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
      fingerprints !== null &&
      readiness.configurationFingerprint === fingerprints.configurationFingerprint &&
      readiness.credentialFingerprint === fingerprints.credentialFingerprint &&
      readiness.policyFingerprint === fingerprints.policyFingerprint &&
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

export async function listLiveEntryAcceptanceRuns(tradingAccountId: number) {
  const runs = await prisma.liveEntryAcceptanceRun.findMany({
    where: { tradingAccountId },
    include: RUN_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return Promise.all(runs.map(projectLiveEntryAcceptanceRun));
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

export async function previewLiveEntryAcceptanceRun(args: {
  tradingAccountId: number;
  runId: number;
}) {
  const run = await prisma.liveEntryAcceptanceRun.findFirst({
    where: { id: args.runId, tradingAccountId: args.tradingAccountId },
    include: RUN_INCLUDE,
  });
  if (!run) throw new HttpError(404, 'Live-entry acceptance run not found.');
  if (run.terminalAt) throw new HttpError(409, 'A completed acceptance run cannot be previewed again.');
  if (run.executionClaimedAt || run.orderIntent) {
    throw new HttpError(409, 'The executed acceptance preview is immutable.');
  }
  if (run.executionUncertainAt) {
    throw new HttpError(409, 'An unresolved acceptance execution cannot be previewed again.');
  }
  const authority = await validateActiveLiveEntryArming(args.tradingAccountId);
  if (!authority.valid) {
    throw new HttpError(409, `A valid active Live-entry arming is required: ${authority.reason}.`);
  }
  if (authority.arming.liveEntryAcceptanceRunId !== run.id) {
    throw new HttpError(409, 'The active Live-entry arming is not bound to this acceptance run.');
  }
  const evaluation = await evaluateAssignmentEntry({
    input: {
      tradingAccountSubscriptionId: run.tradingAccountSubscriptionId,
      subscriptionKey: run.tradingAccountSubscription.subscription.key,
      signalType: 'entry',
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
      signalMetadata: {
        source: 'live_entry_acceptance',
        liveEntryAcceptanceRunId: run.id,
      },
    },
  });
  if (!evaluation.risk.allowed) {
    throw new HttpError(
      evaluation.risk.statusCode,
      evaluation.risk.reason,
      evaluation.risk.details,
    );
  }
  const nextRevision = run.previewRevision + 1;
  const preview = {
    version: 1,
    revision: nextRevision,
    environment: 'LIVE',
    tradingAccount: {
      id: run.tradingAccount.id,
      displayName: run.tradingAccount.displayName,
    },
    assignment: {
      id: run.tradingAccountSubscriptionId,
      subscriptionId: run.subscriptionId,
      subscriptionKey: run.tradingAccountSubscription.subscription.key,
      securityId: run.securityId,
    },
    order: {
      symbol: evaluation.input.symbol,
      side: 'buy',
      qty: evaluation.sizing.qty,
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
      referencePrice: evaluation.referencePrice,
      referencePriceAt: evaluation.priceEvidence.observedAt,
      referencePriceSource: evaluation.priceEvidence.source,
      estimatedNotional: evaluation.estimatedNotional,
    },
    arming: {
      id: authority.arming.id,
      expiresAt: authority.arming.entryApprovalExpiresAt.toISOString(),
      entryApprovalId: authority.arming.entryApprovalId,
      entryApprovalRevision: authority.arming.entryApprovalRevision,
      riskReducingApprovalId: authority.arming.riskReducingApprovalId,
      riskReducingApprovalRevision: authority.arming.riskReducingApprovalRevision,
      readinessAssessmentId: authority.arming.readinessAssessmentId,
      readinessVersion: authority.arming.readinessVersion,
    },
    fingerprints: {
      configuration: authority.arming.configurationFingerprint,
      credential: authority.arming.credentialFingerprint,
      policy: authority.arming.policyFingerprint,
    },
    sizing: evaluation.sizing.snapshot,
    risk: {
      allowed: evaluation.risk.allowed,
      details: evaluation.risk.details,
    },
  } satisfies Prisma.InputJsonObject;
  const fingerprint = liveEntryAcceptancePreviewFingerprint(preview);
  const updated = await prisma.liveEntryAcceptanceRun.updateMany({
    where: {
      id: run.id,
      tradingAccountId: args.tradingAccountId,
      terminalAt: null,
      executionClaimedAt: null,
      previewRevision: run.previewRevision,
    },
    data: {
      previewRevision: nextRevision,
      previewFingerprint: fingerprint,
      previewJson: preview,
      previewedAt: new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new HttpError(409, 'Acceptance run changed while the preview was generated. Refresh and retry.');
  }
  return getLiveEntryAcceptanceRun(args.tradingAccountId, run.id);
}

export async function executeLiveEntryAcceptanceRun(args: {
  tradingAccountId: number;
  runId: number;
  actorUserId: number;
  requestKey: string;
  expectedPreviewRevision: number;
  expectedPreviewFingerprint: string;
  typedConfirmation: string;
}) {
  const run = await prisma.liveEntryAcceptanceRun.findFirst({
    where: { id: args.runId, tradingAccountId: args.tradingAccountId },
    include: RUN_INCLUDE,
  });
  if (!run) throw new HttpError(404, 'Live-entry acceptance run not found.');
  if (run.orderIntent) {
    if (run.executionRequestKey !== args.requestKey) {
      throw new HttpError(409, 'Acceptance execution was already claimed by another request.');
    }
    return getLiveEntryAcceptanceRun(args.tradingAccountId, run.id);
  }
  const reviewed = previewOrder(run.previewJson);
  const symbol = typeof reviewed?.symbol === 'string' ? reviewed.symbol : null;
  if (!symbol || args.typedConfirmation !== `BUY ${symbol}`) {
    throw new HttpError(400, `Typed confirmation must exactly match "BUY ${symbol ?? 'SYMBOL'}".`);
  }
  const clientOrderId = `ai-accept-run${run.id}-rev${run.previewRevision}`;
  await submitOrder(
    {
      tradingAccountSubscriptionId: run.tradingAccountSubscriptionId,
      subscriptionKey: run.tradingAccountSubscription.subscription.key,
      signalType: 'entry',
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
      signalMetadata: {
        source: 'live_entry_acceptance',
        liveEntryAcceptanceRunId: run.id,
        previewRevision: args.expectedPreviewRevision,
        previewFingerprint: args.expectedPreviewFingerprint,
      },
    },
    {
      clientOrderId,
      liveEntryAcceptanceExecution: {
        runId: run.id,
        actorUserId: args.actorUserId,
        requestKey: args.requestKey,
        expectedPreviewRevision: args.expectedPreviewRevision,
        expectedPreviewFingerprint: args.expectedPreviewFingerprint,
      },
    },
  );
  return getLiveEntryAcceptanceRun(args.tradingAccountId, run.id);
}

function safeFailureClassification(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const classification = value.classification;
  return classification === 'BROKER_REJECTED' ||
    classification === 'NOT_SENT_BLOCKED' ||
    classification === 'NOT_SENT_RETRYABLE' ||
    classification === 'LOCAL_FAILURE'
    ? classification
    : null;
}

export async function abortLiveEntryAcceptanceRun(args: {
  tradingAccountId: number;
  runId: number;
  actorUserId: number;
  reason: string;
}) {
  const projection = await getLiveEntryAcceptanceRun(args.tradingAccountId, args.runId);
  const run = projection.run;
  if (run.terminalAt) return projection;
  if (run.executionClaimedAt || run.orderIntent) {
    throw new HttpError(409, 'Abort is unavailable after acceptance execution begins.');
  }
  const cleanup = await disarmLiveEntries(
    args.tradingAccountId,
    args.actorUserId,
    `Acceptance run ${run.id} aborted: ${args.reason}`,
  );
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: args.tradingAccountId },
    select: { tradingEnabled: true, killSwitchEnabled: true, activeLiveEntryArmingId: true },
  });
  const enabledEntries = await prisma.tradingAccountSubscription.count({
    where: { tradingAccountId: args.tradingAccountId, entriesEnabled: true },
  });
  if (
    cleanup.attentionRequired ||
    account.tradingEnabled ||
    !account.killSwitchEnabled ||
    account.activeLiveEntryArmingId ||
    enabledEntries > 0
  ) {
    throw new HttpError(409, 'Acceptance abort cleanup could not be proven safe.');
  }
  await prisma.liveEntryAcceptanceRun.updateMany({
    where: { id: run.id, terminalAt: null, executionClaimedAt: null },
    data: {
      terminalOutcome: 'OPERATOR_ABORTED',
      terminalReason: args.reason,
      terminalEvidenceJson: {
        cleanup,
        account,
        enabledEntryAssignmentCount: enabledEntries,
      },
      terminalAt: new Date(),
      terminatedByUserId: args.actorUserId,
    },
  });
  return getLiveEntryAcceptanceRun(args.tradingAccountId, run.id);
}

export async function verifyLiveEntryAcceptanceRun(args: {
  tradingAccountId: number;
  runId: number;
  actorUserId: number;
}) {
  const before = await getLiveEntryAcceptanceRun(args.tradingAccountId, args.runId);
  if (before.run.terminalAt) return before;
  if (!before.run.executionClaimedAt || !before.run.orderIntent) {
    throw new HttpError(409, 'Acceptance verification requires an executed OrderIntent.');
  }
  try {
    await syncSubmittedOrdersForAccount(args.tradingAccountId);
    await syncBrokerActivitiesForAccount(args.tradingAccountId);
    await syncTrackedPositionsForAccount(args.tradingAccountId);
  } catch (error) {
    await prisma.liveEntryAcceptanceRun.updateMany({
      where: { id: args.runId, tradingAccountId: args.tradingAccountId, terminalAt: null },
      data: {
        executionUncertainAt: new Date(),
        executionFailureJson: {
          classification: 'DELIVERY_UNCERTAIN',
          source: 'acceptance_verification_observation',
          message: error instanceof Error ? error.message : 'Verification observation failed.',
        },
      },
    });
    return getLiveEntryAcceptanceRun(args.tradingAccountId, args.runId);
  }
  let reconciliation;
  try {
    reconciliation = await reconcileTradingAccount(args.tradingAccountId);
  } catch (error) {
    await prisma.liveEntryAcceptanceRun.updateMany({
      where: { id: args.runId, tradingAccountId: args.tradingAccountId, terminalAt: null },
      data: {
        executionUncertainAt: new Date(),
        executionFailureJson: {
          classification: 'DELIVERY_UNCERTAIN',
          source: 'acceptance_reconciliation',
          message: error instanceof Error ? error.message : 'Reconciliation failed.',
        },
      },
    });
    return getLiveEntryAcceptanceRun(args.tradingAccountId, args.runId);
  }
  const after = await getLiveEntryAcceptanceRun(args.tradingAccountId, args.runId);
  const run = after.run;
  const intent = run.orderIntent!;
  const brokerOrder = intent.brokerOrders[0] ?? null;
  const position = intent.trackedPosition;
  const consumed = run.liveEntryArming?.terminations.some((item) => item.type === 'CONSUMED') === true;
  const enabledEntries = await prisma.tradingAccountSubscription.count({
    where: { tradingAccountId: args.tradingAccountId, entriesEnabled: true },
  });
  const relevantFindings = reconciliation.findings.filter((finding) =>
    finding.symbol === run.tradingAccountSubscription.subscription.security.symbol ||
    (finding.entityType === 'orderIntent' && finding.entityId === String(intent.id)) ||
    (position && finding.entityType === 'trackedPosition' && finding.entityId === String(position.id)),
  );
  const safePosture =
    !run.tradingAccount.tradingEnabled &&
    run.tradingAccount.killSwitchEnabled &&
    run.tradingAccount.activeLiveEntryArmingId === null &&
    enabledEntries === 0;
  const positionAttributed = Boolean(
    position &&
      position.tradingAccountId === run.tradingAccountId &&
      position.subscriptionId === run.subscriptionId &&
      position.tradingAccountSubscriptionId === run.tradingAccountSubscriptionId,
  );
  const lifecycleHealthy = Boolean(position && !position.exitState?.attentionRequired);
  const complete =
    brokerOrder?.status === 'filled' &&
    intent.status === 'filled' &&
    positionAttributed &&
    lifecycleHealthy &&
    consumed &&
    safePosture &&
    relevantFindings.length === 0;
  const evidence = {
    orderIntentId: intent.id,
    orderIntentStatus: intent.status,
    brokerOrderId: brokerOrder?.brokerOrderId ?? null,
    brokerClientOrderId: brokerOrder?.clientOrderId ?? intent.clientOrderId,
    brokerOrderStatus: brokerOrder?.status ?? null,
    trackedPositionId: position?.id ?? null,
    positionAttributed,
    lifecycleHealthy,
    armingConsumed: consumed,
    activeArmingAbsent: run.tradingAccount.activeLiveEntryArmingId === null,
    accountTradingDisabled: !run.tradingAccount.tradingEnabled,
    killSwitchEnabled: run.tradingAccount.killSwitchEnabled,
    enabledEntryAssignmentCount: enabledEntries,
    reconciliationRunIdentifier: reconciliation.runIdentifier,
    relevantReconciliationFindings:
      relevantFindings as unknown as Prisma.InputJsonArray,
  } satisfies Prisma.InputJsonObject;
  if (complete) {
    await prisma.liveEntryAcceptanceRun.updateMany({
      where: { id: run.id, terminalAt: null },
      data: {
        terminalOutcome: 'CANARY_COMPLETE',
        terminalReason: 'The Live-entry canary and all required safety invariants were verified.',
        terminalEvidenceJson: evidence,
        terminalAt: new Date(),
        terminatedByUserId: args.actorUserId,
      },
    });
  } else if (
    safeFailureClassification(run.executionFailureJson) &&
    !brokerOrder &&
    safePosture &&
    relevantFindings.length === 0
  ) {
    await prisma.liveEntryAcceptanceRun.updateMany({
      where: { id: run.id, terminalAt: null },
      data: {
        terminalOutcome: 'FAILED_SAFE',
        terminalReason: 'Broker non-execution and fail-closed cleanup were verified.',
        terminalEvidenceJson: evidence,
        terminalAt: new Date(),
        terminatedByUserId: args.actorUserId,
      },
    });
  } else if (!run.executionUncertainAt) {
    await prisma.liveEntryAcceptanceRun.updateMany({
      where: { id: run.id, terminalAt: null },
      data: {
        executionUncertainAt: new Date(),
        executionFailureJson: {
          classification: 'INVARIANT_UNPROVEN',
          source: 'acceptance_verification',
          evidence,
        },
      },
    });
  }
  return getLiveEntryAcceptanceRun(args.tradingAccountId, run.id);
}
