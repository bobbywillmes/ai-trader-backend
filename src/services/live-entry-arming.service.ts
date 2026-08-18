import {
  LiveEntryArmingTerminationType,
  LiveWriteCapability,
  Prisma,
  TradingAccountEnvironment,
  TradingAccountReadinessPurpose,
  TradingAccountReadinessResult,
  TradingAccountStatus,
} from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  computeLiveWriteApprovalFingerprints,
  getLiveWriteApprovalState,
  invalidateLiveWriteApprovals,
} from './live-write-approval.service.js';
import {
  computeReadinessFingerprints,
  isCredentialVerificationCurrent,
  LIVE_ENTRY_ARMING_READINESS_VERSION,
} from './trading-account-readiness.service.js';
import {
  assertAccountRiskConfiguration,
  withAccountRiskConfigurationTransaction,
} from './trading-account-risk-configuration.service.js';
import {
  ACCOUNT_WORKFLOW_LOCK_FAMILIES,
  withTradingAccountWorkflowLock,
} from './trading-account-workflow-lock.service.js';

const ENTRY_INTENT_STATUSES = ['received', 'pending'] as const;
const NONTERMINAL_INTENT_STATUSES = ['received', 'pending', 'submitting', 'submitted'] as const;
const TERMINAL_BROKER_ORDER_STATUSES = [
  'filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced',
  'done_for_day', 'calculated',
] as const;

export type NewPositionEntryAuthorizationContext = {
  subtype: 'NEW_POSITION_ENTRY';
  orderIntentId: number;
  tradingAccountSubscriptionId: number;
  subscriptionId: number;
  symbol: string;
  side: 'buy';
  clientOrderId: string;
};

export function evaluateLiveEntryArmingBinding(args: {
  arming: { entryApprovalId: number; entryApprovalRevision: number; riskReducingApprovalId: number; riskReducingApprovalRevision: number; configurationFingerprint: string; credentialFingerprint: string; policyFingerprint: string; tradingAccountSubscriptionId: number };
  entryApproval: { id: number; revision: number } | null;
  riskReducingApproval: { id: number; revision: number } | null;
  fingerprints: { configurationFingerprint: string; credentialFingerprint: string; policyFingerprint: string };
  tradingAccountSubscriptionId: number;
}) {
  if (!args.entryApproval || args.entryApproval.id !== args.arming.entryApprovalId || args.entryApproval.revision !== args.arming.entryApprovalRevision) return { valid: false as const, reason: 'ENTRY_APPROVAL_MISMATCH' as const };
  if (!args.riskReducingApproval || args.riskReducingApproval.id !== args.arming.riskReducingApprovalId || args.riskReducingApproval.revision !== args.arming.riskReducingApprovalRevision) return { valid: false as const, reason: 'RISK_REDUCING_APPROVAL_MISMATCH' as const };
  if (args.fingerprints.configurationFingerprint !== args.arming.configurationFingerprint || args.fingerprints.credentialFingerprint !== args.arming.credentialFingerprint || args.fingerprints.policyFingerprint !== args.arming.policyFingerprint) return { valid: false as const, reason: 'ARMING_FINGERPRINT_STALE' as const };
  if (args.tradingAccountSubscriptionId !== args.arming.tradingAccountSubscriptionId) return { valid: false as const, reason: 'ASSIGNMENT_NOT_ARMED' as const };
  return { valid: true as const };
}

function policyFingerprint() {
  return import('./trading-account-readiness.service.js').then(({ readinessFingerprint }) =>
    readinessFingerprint({
      ALLOW_LIVE_RISK_REDUCING_WRITES: env.ALLOW_LIVE_RISK_REDUCING_WRITES,
      ALLOW_LIVE_TRADING: env.ALLOW_LIVE_TRADING,
      LIVE_WRITE_DEPLOYMENT_ROLE: env.LIVE_WRITE_DEPLOYMENT_ROLE,
    }),
  );
}

async function terminateArming(
  tx: Prisma.TransactionClient,
  args: {
    armingId: number;
    type: LiveEntryArmingTerminationType;
    reason: string;
    actorUserId?: number | null;
    orderIntentId?: number | null;
    clientOrderId?: string | null;
    evidence?: Prisma.InputJsonValue;
  },
) {
  return tx.liveEntryArmingTermination.upsert({
    where: { liveEntryArmingId_type: { liveEntryArmingId: args.armingId, type: args.type } },
    update: {},
    create: {
      liveEntryArmingId: args.armingId,
      type: args.type,
      actorUserId: args.actorUserId ?? null,
      reason: args.reason,
      orderIntentId: args.orderIntentId ?? null,
      clientOrderId: args.clientOrderId ?? null,
      evidenceJson: args.evidence ?? {},
    },
  });
}

async function closeEntryAuthority(
  tx: Prisma.TransactionClient,
  tradingAccountId: number,
  args: { reason: string; actorUserId?: number | null; type: LiveEntryArmingTerminationType },
) {
  const account = await tx.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { activeLiveEntryArmingId: true },
  });
  if (!account) throw new HttpError(404, 'Trading account not found.');
  await tx.tradingAccount.update({
    where: { id: tradingAccountId },
    data: { tradingEnabled: false, killSwitchEnabled: true, activeLiveEntryArmingId: null },
  });
  const assignments = await tx.tradingAccountSubscription.updateMany({
    where: { tradingAccountId, entriesEnabled: true },
    data: { entriesEnabled: false },
  });
  const intents = await tx.orderIntent.updateMany({
    where: {
      tradingAccountId,
      side: 'buy',
      status: { in: [...ENTRY_INTENT_STATUSES] },
    },
    data: { status: 'blocked', blockReason: args.reason },
  });
  if (account.activeLiveEntryArmingId) {
    await terminateArming(tx, {
      armingId: account.activeLiveEntryArmingId,
      type: args.type,
      reason: args.reason,
      ...(args.actorUserId !== undefined ? { actorUserId: args.actorUserId } : {}),
      evidence: { assignmentsDisabled: assignments.count, entryIntentsBlocked: intents.count },
    });
  }
  return { armingId: account.activeLiveEntryArmingId, assignmentsDisabled: assignments.count, entryIntentsBlocked: intents.count };
}

export async function stageLiveEntryCanary(args: {
  tradingAccountId: number;
  tradingAccountSubscriptionId: number;
  actorUserId: number;
  reason: string;
}) {
  const locked = await withTradingAccountWorkflowLock({
    tradingAccountId: args.tradingAccountId,
    workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.OPERATIONAL_STATE,
    processInstanceId: `stage-live-entry:${args.actorUserId}`,
    execute: () => withAccountRiskConfigurationTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${args.tradingAccountId} FOR UPDATE`;
      const account = await tx.tradingAccount.findUnique({ where: { id: args.tradingAccountId } });
      if (!account) throw new HttpError(404, 'Trading account not found.');
      if (account.environment !== TradingAccountEnvironment.LIVE || account.status !== TradingAccountStatus.ACTIVE || account.tradingEnabled || !account.killSwitchEnabled) {
        throw new HttpError(409, 'Canary staging requires LIVE ACTIVE / trading disabled / kill switch enabled.');
      }
      const assignment = await tx.tradingAccountSubscription.findFirst({
        where: { id: args.tradingAccountSubscriptionId, tradingAccountId: args.tradingAccountId },
        include: { subscription: { include: { security: true, strategy: true, exitProfile: true } }, allocation: true },
      });
      if (!assignment || assignment.subscription.key !== 'rsp_dip_core' || assignment.subscription.security.symbol !== 'RSP') {
        throw new HttpError(409, 'The first Live canary must be the account rsp_dip_core RSP assignment.');
      }
      if (!assignment.enabled || !assignment.exitsEnabled || !assignment.subscription.enabled || !assignment.subscription.security.enabled || !assignment.subscription.strategy.enabled || !assignment.subscription.exitProfile.enabled || assignment.allocation?.key !== 'core_etf' || !assignment.allocation.enabled) {
        throw new HttpError(409, 'The rsp_dip_core assignment hierarchy is not ready for canary staging.');
      }
      const old = await closeEntryAuthority(tx, args.tradingAccountId, {
        reason: 'Prior Live entry authority invalidated by canary staging.', actorUserId: args.actorUserId,
        type: LiveEntryArmingTerminationType.INVALIDATED,
      });
      await assertAccountRiskConfiguration(tx, args.tradingAccountId, {
        accountSubscription: {
          id: assignment.id,
          allocationId: assignment.allocationId,
          enabled: assignment.enabled,
          entriesEnabled: true,
          sizingType: assignment.sizingType,
          fixedQty: assignment.fixedQty,
          maxPositionNotional: assignment.maxPositionNotional,
          reservedNotional: assignment.reservedNotional,
        },
      });
      await tx.tradingAccountSubscription.update({
        where: { id: assignment.id }, data: { entriesEnabled: true },
      });
      await invalidateLiveWriteApprovals(tx, args.tradingAccountId, [LiveWriteCapability.ENTRY], 'Live entry canary was staged.');
      await tx.systemEvent.create({ data: {
        type: 'trading_account.live_entry_canary_staged', entityType: 'TradingAccount', entityId: String(args.tradingAccountId),
        tradingAccountId: args.tradingAccountId, actorUserId: args.actorUserId,
        message: `Trading account ${args.tradingAccountId} staged rsp_dip_core as its sole Live entry canary.`,
        payloadJson: { reason: args.reason, tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId, securityId: assignment.subscription.securityId, previousArmingId: old.armingId, entryIntentsBlocked: old.entryIntentsBlocked },
      }});
      return { tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId, symbol: 'RSP' };
    }),
  });
  if (locked.outcome === 'ACQUIRED_AND_COMPLETED') return locked.value;
  if (locked.outcome === 'NOT_ACQUIRED') throw new HttpError(409, 'An account operational-state change is already running.');
  throw locked.error;
}

export type ArmLiveEntriesInput = {
  reason: string;
  typedConfirmation: 'ARM LIVE ENTRIES';
  readinessAssessmentId: number;
  tradingAccountSubscriptionId: number;
  entryApprovalId: number;
  entryApprovalRevision: number;
  expectedUpdatedAt: Date;
};

export function assertArmingCredentialVerificationCurrent(
  credentialVerifiedAt: Date | null,
  now = new Date(),
) {
  if (!isCredentialVerificationCurrent(credentialVerifiedAt, now)) {
    throw new HttpError(
      409,
      'Credential verification is no longer current. Verify credentials and run a new readiness assessment before ARM.',
    );
  }
}

async function armInsideTransaction(tx: Prisma.TransactionClient, tradingAccountId: number, actorUserId: number, input: ArmLiveEntriesInput) {
  await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${tradingAccountId} FOR UPDATE`;
  const account = await tx.tradingAccount.findUnique({ where: { id: tradingAccountId }, include: {
    accountSubscriptions: { include: { subscription: { include: { security: true, strategy: true, exitProfile: true } }, allocation: true } },
  }});
  if (!account) throw new HttpError(404, 'Trading account not found.');
  if (account.environment !== 'LIVE' || account.status !== 'ACTIVE' || account.tradingEnabled || !account.killSwitchEnabled || account.activeLiveEntryArmingId) throw new HttpError(409, 'ARM requires exact ACTIVE / entry-disarmed posture with no active binding.');
  if (account.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) throw new HttpError(409, 'Trading Account changed; refresh and retry ARM.');
  const assessment = await tx.tradingAccountReadinessAssessment.findFirst({ where: {
    id: input.readinessAssessmentId, tradingAccountId, purpose: TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING,
  }});
  if (!assessment || assessment.result !== TradingAccountReadinessResult.PASSED || assessment.assessmentVersion !== LIVE_ENTRY_ARMING_READINESS_VERSION || assessment.expiresAt <= new Date()) throw new HttpError(409, 'A current passing supported post-grant LIVE_ENTRY_ARMING assessment is required.');
  assertArmingCredentialVerificationCurrent(assessment.credentialVerifiedAt);
  const readiness = await computeReadinessFingerprints(tradingAccountId, tx);
  if (!readiness || assessment.configurationFingerprint !== readiness.configurationFingerprint || assessment.credentialFingerprint !== readiness.credentialFingerprint || assessment.policyFingerprint !== readiness.policyFingerprint) throw new HttpError(409, 'LIVE_ENTRY_ARMING readiness evidence is stale.');
  const approvals = await getLiveWriteApprovalState(tradingAccountId, tx);
  const entry = approvals.capabilities.find((item) => item.capability === LiveWriteCapability.ENTRY)!;
  const risk = approvals.capabilities.find((item) => item.capability === LiveWriteCapability.RISK_REDUCING)!;
  if (!entry.effective || !entry.approval?.expiresAt || entry.approval.id !== input.entryApprovalId || entry.approval.revision !== input.entryApprovalRevision) throw new HttpError(409, 'The exact effective ENTRY approval revision is required.');
  if (!risk.effective || !risk.approval) throw new HttpError(409, 'The exact effective RISK_REDUCING approval is required.');
  const assignment = account.accountSubscriptions.find((item) => item.id === input.tradingAccountSubscriptionId);
  const enabledEntries = account.accountSubscriptions.filter((item) => item.enabled && item.entriesEnabled);
  if (!assignment || enabledEntries.length !== 1 || enabledEntries[0]?.id !== assignment.id || assignment.subscription.key !== 'rsp_dip_core' || assignment.subscription.security.symbol !== 'RSP' || !assignment.exitsEnabled) throw new HttpError(409, 'The exact sole staged rsp_dip_core assignment is required.');
  const [positions, intents, orders] = await Promise.all([
    tx.trackedPosition.count({ where: { tradingAccountId, status: { in: ['open', 'closing'] } } }),
    tx.orderIntent.count({ where: { tradingAccountId, side: 'buy', status: { in: [...NONTERMINAL_INTENT_STATUSES] } } }),
    tx.brokerOrder.count({ where: { tradingAccountId, status: { notIn: [...TERMINAL_BROKER_ORDER_STATUSES] } } }),
  ]);
  if (positions || intents || orders) throw new HttpError(409, 'ARM requires zero local exposure and nonterminal entry work.');
  const fingerprints = await computeLiveWriteApprovalFingerprints(tradingAccountId, LiveWriteCapability.ENTRY, tx);
  if (!fingerprints) throw new HttpError(409, 'ENTRY fingerprints are unavailable.');
  const arming = await tx.liveEntryArming.create({ data: {
    tradingAccountId, entryApprovalId: entry.approval.id, entryApprovalRevision: entry.approval.revision,
    riskReducingApprovalId: risk.approval.id, riskReducingApprovalRevision: risk.approval.revision,
    readinessAssessmentId: assessment.id, readinessVersion: assessment.assessmentVersion,
    tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId,
    securityId: assignment.subscription.securityId,
    configurationFingerprint: fingerprints.configurationFingerprint,
    credentialFingerprint: fingerprints.credentialFingerprint,
    policyFingerprint: assessment.policyFingerprint,
    entryApprovalExpiresAt: entry.approval.expiresAt,
    accountUpdatedAtEvidence: account.updatedAt, armedByUserId: actorUserId,
    reason: input.reason, typedConfirmation: input.typedConfirmation,
  }});
  await tx.tradingAccount.update({ where: { id: tradingAccountId }, data: {
    status: TradingAccountStatus.ACTIVE, tradingEnabled: true, killSwitchEnabled: false,
    activeLiveEntryArmingId: arming.id,
  }});
  await tx.systemEvent.create({ data: {
    type: 'trading_account.live_entries_armed', entityType: 'LiveEntryArming', entityId: String(arming.id), tradingAccountId, actorUserId,
    message: `Trading account ${tradingAccountId} armed one-shot Live entries for rsp_dip_core.`,
    payloadJson: { armingId: arming.id, readinessAssessmentId: assessment.id, entryApprovalId: entry.approval.id, entryApprovalRevision: entry.approval.revision, riskReducingApprovalId: risk.approval.id, riskReducingApprovalRevision: risk.approval.revision, tradingAccountSubscriptionId: assignment.id, entryApprovalExpiresAt: entry.approval.expiresAt, fingerprintPrefixes: { configuration: fingerprints.configurationFingerprint.slice(0, 12), credential: fingerprints.credentialFingerprint.slice(0, 12), policy: assessment.policyFingerprint.slice(0, 12) } },
  }});
  return arming;
}

export async function armLiveEntries(tradingAccountId: number, actorUserId: number, input: ArmLiveEntriesInput) {
  if (input.typedConfirmation !== 'ARM LIVE ENTRIES') throw new HttpError(400, 'Typed confirmation must exactly match "ARM LIVE ENTRIES".');
  const orderLock = await withTradingAccountWorkflowLock({ tradingAccountId, workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.ORDER_LIFECYCLE, processInstanceId: `arm-entry:${actorUserId}`, execute: async () => {
    const operational = await withTradingAccountWorkflowLock({ tradingAccountId, workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.OPERATIONAL_STATE, processInstanceId: `arm-entry:${actorUserId}`, execute: () => withAccountRiskConfigurationTransaction((tx) => armInsideTransaction(tx, tradingAccountId, actorUserId, input)) });
    if (operational.outcome !== 'ACQUIRED_AND_COMPLETED') throw operational.outcome === 'NOT_ACQUIRED' ? new HttpError(409, 'An account operational-state change is already running.') : operational.error;
    return operational.value;
  }});
  if (orderLock.outcome === 'ACQUIRED_AND_COMPLETED') return orderLock.value;
  if (orderLock.outcome === 'NOT_ACQUIRED') throw new HttpError(409, 'Order lifecycle activity is in progress; retry ARM.');
  throw orderLock.error;
}

async function acquireDrain(tradingAccountId: number, actorUserId: number) {
  const deadline = Date.now() + 5_000;
  do {
    const result = await withTradingAccountWorkflowLock({ tradingAccountId, workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.ORDER_LIFECYCLE, processInstanceId: `disarm-drain:${actorUserId}`, execute: async () => true });
    if (result.outcome === 'ACQUIRED_AND_COMPLETED') return true;
    if (result.outcome !== 'NOT_ACQUIRED') return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

export async function disarmLiveEntries(
  tradingAccountId: number,
  actorUserId: number | null,
  reason: string,
  type: LiveEntryArmingTerminationType = LiveEntryArmingTerminationType.DISARMED,
) {
  const local = await withAccountRiskConfigurationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${tradingAccountId} FOR UPDATE`;
    const account = await tx.tradingAccount.findUnique({ where: { id: tradingAccountId }, select: { id: true, environment: true, status: true } });
    if (!account) throw new HttpError(404, 'Trading account not found.');
    if (account.environment !== 'LIVE') throw new HttpError(409, 'Live entry disarm applies only to LIVE accounts.');
    const result = await closeEntryAuthority(tx, tradingAccountId, { reason, actorUserId, type });
    await invalidateLiveWriteApprovals(tx, tradingAccountId, [LiveWriteCapability.ENTRY], reason);
    await tx.systemEvent.create({ data: {
      type: type === LiveEntryArmingTerminationType.EXPIRED ? 'trading_account.live_entry_approval_expired_while_armed' : type === LiveEntryArmingTerminationType.INVALIDATED ? 'trading_account.live_entry_arming_invalidated' : 'trading_account.live_entries_disarmed',
      entityType: 'TradingAccount', entityId: String(tradingAccountId), tradingAccountId, actorUserId,
      message: `Trading account ${tradingAccountId} Live entries were locally disarmed.`,
      payloadJson: { reason, previousArmingId: result.armingId, assignmentsDisabled: result.assignmentsDisabled, entryIntentsBlocked: result.entryIntentsBlocked, statusPreserved: account.status },
    }});
    return result;
  });
  const drained = await acquireDrain(tradingAccountId, actorUserId ?? 0);
  if (!drained) {
    await prisma.systemEvent.create({ data: { type: 'trading_account.live_entry_disarm_drain_attention', entityType: 'TradingAccount', entityId: String(tradingAccountId), tradingAccountId, actorUserId, message: 'Local Live entry disarm succeeded, but order-lifecycle drain timed out.', payloadJson: { reason, localDisarmApplied: true } } });
  }
  return { ...local, localDisarmApplied: true, lifecycleDrained: drained, attentionRequired: !drained };
}

export async function validateActiveLiveEntryArming(tradingAccountId: number, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const account = await db.tradingAccount.findUnique({ where: { id: tradingAccountId }, include: {
    credential: true,
    activeLiveEntryArming: { include: { terminations: true } },
  }});
  if (!account?.activeLiveEntryArming) return { valid: false as const, reason: 'MISSING_ARMING' };
  const arming = account.activeLiveEntryArming;
  if (arming.terminations.length) return { valid: false as const, reason: 'ARMING_TERMINATED' };
  if (account.status !== 'ACTIVE' || !account.tradingEnabled || account.killSwitchEnabled) return { valid: false as const, reason: 'ACCOUNT_LATCH_MISMATCH' };
  if (arming.entryApprovalExpiresAt <= new Date()) return { valid: false as const, reason: 'ENTRY_EXPIRED' };
  if (!account.credential || account.credential.status !== 'ACTIVE' || account.credential.revokedAt) return { valid: false as const, reason: 'CREDENTIAL_INEFFECTIVE' };
  if (env.NODE_ENV !== 'production' || env.LIVE_WRITE_DEPLOYMENT_ROLE !== 'PRODUCTION_EXECUTOR' || !env.ALLOW_LIVE_TRADING || !env.ALLOW_LIVE_RISK_REDUCING_WRITES) return { valid: false as const, reason: 'DEPLOYMENT_POLICY_MISMATCH' };
  const state = await getLiveWriteApprovalState(tradingAccountId, db);
  const entry = state.capabilities.find((item) => item.capability === LiveWriteCapability.ENTRY)!;
  const risk = state.capabilities.find((item) => item.capability === LiveWriteCapability.RISK_REDUCING)!;
  if (!entry.effective || !entry.approval) return { valid: false as const, reason: 'ENTRY_APPROVAL_MISMATCH' };
  if (!risk.effective || !risk.approval) return { valid: false as const, reason: 'RISK_REDUCING_APPROVAL_MISMATCH' };
  const fingerprints = await computeLiveWriteApprovalFingerprints(tradingAccountId, LiveWriteCapability.ENTRY, db);
  if (!fingerprints) return { valid: false as const, reason: 'ARMING_FINGERPRINT_STALE' };
  const binding = evaluateLiveEntryArmingBinding({ arming, entryApproval: entry.approval, riskReducingApproval: risk.approval, fingerprints: { ...fingerprints, policyFingerprint: await policyFingerprint() }, tradingAccountSubscriptionId: arming.tradingAccountSubscriptionId });
  if (!binding.valid) return binding;
  return { valid: true as const, arming, account, entry, risk };
}

export async function authorizeAndConsumeNewPositionEntry(tradingAccountId: number, context: NewPositionEntryAuthorizationContext) {
  return withAccountRiskConfigurationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${tradingAccountId} FOR UPDATE`;
    const authority = await validateActiveLiveEntryArming(tradingAccountId, tx);
    if (!authority.valid) throw new HttpError(403, `LIVE NEW_POSITION_ENTRY blocked: ${authority.reason}.`);
    const intent = await tx.orderIntent.findFirst({ where: { id: context.orderIntentId, tradingAccountId, tradingAccountSubscriptionId: context.tradingAccountSubscriptionId, subscriptionId: context.subscriptionId, status: 'submitting', side: 'buy', clientOrderId: context.clientOrderId } });
    if (!intent) throw new HttpError(403, 'LIVE NEW_POSITION_ENTRY blocked: intent identity or state mismatch.');
    const assignment = await tx.tradingAccountSubscription.findFirst({ where: { id: context.tradingAccountSubscriptionId, tradingAccountId }, include: { subscription: { include: { security: true } } } });
    if (!assignment || !assignment.enabled || !assignment.entriesEnabled || assignment.subscriptionId !== context.subscriptionId || assignment.subscription.security.symbol !== context.symbol || assignment.id !== authority.arming.tradingAccountSubscriptionId || assignment.subscriptionId !== authority.arming.subscriptionId || assignment.subscription.securityId !== authority.arming.securityId) throw new HttpError(403, 'LIVE NEW_POSITION_ENTRY blocked: assignment is not the exact armed canary.');
    await terminateArming(tx, { armingId: authority.arming.id, type: LiveEntryArmingTerminationType.CONSUMED, reason: 'One-shot authority consumed before outbound broker submission attempt.', orderIntentId: intent.id, clientOrderId: context.clientOrderId, evidence: { tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId, securityId: assignment.subscription.securityId, symbol: context.symbol } });
    await tx.tradingAccount.update({ where: { id: tradingAccountId }, data: { activeLiveEntryArmingId: null, tradingEnabled: false, killSwitchEnabled: true } });
    await tx.tradingAccountSubscription.updateMany({ where: { tradingAccountId, entriesEnabled: true }, data: { entriesEnabled: false } });
    await tx.systemEvent.create({ data: { type: 'trading_account.live_entry_one_shot_consumed', entityType: 'LiveEntryArming', entityId: String(authority.arming.id), tradingAccountId, message: `One-shot Live entry arming ${authority.arming.id} was consumed before broker submission.`, payloadJson: { armingId: authority.arming.id, orderIntentId: intent.id, clientOrderId: context.clientOrderId, tradingAccountSubscriptionId: assignment.id } } });
    return { armingId: authority.arming.id };
  });
}

export async function monitorLiveEntryArmings() {
  const accounts = await prisma.tradingAccount.findMany({ where: { activeLiveEntryArmingId: { not: null } }, select: { id: true } });
  const results = [];
  for (const account of accounts) {
    const validity = await validateActiveLiveEntryArming(account.id);
    if (validity.valid) { results.push({ tradingAccountId: account.id, valid: true }); continue; }
    const type = validity.reason === 'ENTRY_EXPIRED' ? LiveEntryArmingTerminationType.EXPIRED : LiveEntryArmingTerminationType.INVALIDATED;
    await disarmLiveEntries(account.id, null, `Automatic Live entry disarm: ${validity.reason}.`, type);
    results.push({ tradingAccountId: account.id, valid: false, reason: validity.reason });
  }
  return results;
}
