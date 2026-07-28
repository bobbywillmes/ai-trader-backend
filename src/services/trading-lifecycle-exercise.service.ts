import crypto from 'node:crypto';
import {
  Prisma,
  TradingLifecycleExerciseStatus,
  TradingLifecycleExerciseTargetStatus,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type { LifecycleExercisePreviewInput } from '../validators/trading-lifecycle-exercise.schema.js';
import { previewTradingAccountEntryRisk } from './trading-account-entry-risk-preview.service.js';
import { processEntryForAccountSubscription } from './signal-entry.service.js';
import { createSystemEvent } from './system-event.service.js';
import { reconcileTradingAccountWithLock } from './reconciliation.service.js';

export const LIFECYCLE_EXERCISE_MAX_TARGETS = 25;
export const LIFECYCLE_EXERCISE_PREVIEW_TTL_MS = 5 * 60_000;
export const LIFECYCLE_EXERCISE_CONFIRMATION = 'LAUNCH PAPER EXERCISE';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

const FINGERPRINT_ASSIGNMENT_SELECT = {
  id: true,
  updatedAt: true,
  enabled: true,
  entriesEnabled: true,
  exitsEnabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  reservedNotional: true,
  minPositionNotional: true,
  maxQty: true,
  allocation: {
    select: {
      id: true, updatedAt: true, enabled: true, maxAllocatedNotional: true,
      maxOpenPositions: true, maxPositionNotional: true,
    },
  },
  tradingAccount: {
    select: {
      id: true, updatedAt: true, accountHolderUserId: true, environment: true,
      status: true, tradingEnabled: true, killSwitchEnabled: true,
      estimatedTradingCapital: true, maxDeployableNotional: true,
      credential: { select: { status: true, verifiedAt: true, updatedAt: true } },
      riskSettings: { select: {
        enabled: true, updatedAt: true, maxDailyEntryOrders: true,
        maxDailyEntryNotional: true, maxOpenPositions: true,
        maxTotalOpenNotional: true, maxSymbolOpenNotional: true,
        maxSubscriptionOpenNotional: true,
      } },
    },
  },
  subscription: {
    select: {
      id: true, key: true, updatedAt: true, enabled: true,
      security: { select: { id: true, enabled: true, updatedAt: true } },
      strategy: { select: { id: true, enabled: true, updatedAt: true } },
      exitProfile: { select: { id: true, enabled: true, updatedAt: true } },
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

async function loadFingerprintAssignments(ids: number[]) {
  return prisma.tradingAccountSubscription.findMany({
    where: { id: { in: ids } },
    select: FINGERPRINT_ASSIGNMENT_SELECT,
    orderBy: [{ tradingAccountId: 'asc' }, { id: 'asc' }],
  });
}

function configurationFingerprint(args: {
  subscriptionId: number;
  selectionMode: string;
  requestedUserIds: number[];
  assignments: Awaited<ReturnType<typeof loadFingerprintAssignments>>;
}) {
  return fingerprint({
    version: 1,
    environment: 'PAPER',
    subscriptionId: args.subscriptionId,
    selectionMode: args.selectionMode,
    requestedUserIds: args.requestedUserIds,
    assignments: args.assignments,
  });
}

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function staticBlockers(assignment: Awaited<ReturnType<typeof loadFingerprintAssignments>>[number]) {
  const blockers: Array<{ code: string; message: string }> = [];
  const account = assignment.tradingAccount;
  if (account.environment !== 'PAPER') blockers.push({ code: 'LIVE_TARGET_REJECTED', message: 'Only Paper accounts may be targeted.' });
  if (account.status !== 'ACTIVE') blockers.push({ code: 'ACCOUNT_NOT_OPERATIONAL', message: 'Trading account is not active.' });
  if (!account.tradingEnabled) blockers.push({ code: 'ACCOUNT_TRADING_DISABLED', message: 'Trading is disabled for this account.' });
  if (account.killSwitchEnabled) blockers.push({ code: 'ACCOUNT_KILL_SWITCH_ENABLED', message: 'The account kill switch is enabled.' });
  if (account.credential?.status !== 'ACTIVE') blockers.push({ code: 'ACCOUNT_CREDENTIALS_INACTIVE', message: 'Active verified credentials are required.' });
  if (!assignment.enabled) blockers.push({ code: 'ASSIGNMENT_DISABLED', message: 'The account assignment is disabled.' });
  if (!assignment.entriesEnabled) blockers.push({ code: 'ASSIGNMENT_ENTRIES_DISABLED', message: 'Entries are disabled for the assignment.' });
  if (!assignment.exitsEnabled) blockers.push({ code: 'ASSIGNMENT_EXITS_DISABLED', message: 'Exits must be enabled for a lifecycle exercise.' });
  if (!assignment.subscription.enabled) blockers.push({ code: 'SUBSCRIPTION_DISABLED', message: 'The catalog subscription is disabled.' });
  if (!assignment.subscription.security.enabled) blockers.push({ code: 'SECURITY_DISABLED', message: 'The security is disabled.' });
  if (!assignment.subscription.strategy.enabled) blockers.push({ code: 'STRATEGY_DISABLED', message: 'The strategy is disabled.' });
  if (!assignment.subscription.exitProfile.enabled) blockers.push({ code: 'EXIT_PROFILE_DISABLED', message: 'The exit profile is disabled.' });
  if (!assignment.allocation?.enabled) blockers.push({ code: 'ALLOCATION_INELIGIBLE', message: 'An enabled allocation is required.' });
  return blockers;
}

export async function previewTradingLifecycleExercise(
  input: LifecycleExercisePreviewInput,
  actorUserId: number,
  now = new Date()
) {
  if (input.environment !== 'PAPER') throw new HttpError(400, 'Only PAPER lifecycle exercises are supported.');
  const subscription = await prisma.subscription.findUnique({
    where: { id: input.subscriptionId },
    select: { id: true, key: true, name: true },
  });
  if (!subscription) throw new HttpError(404, 'Subscription not found.');

  const suppliedIds = input.userIds ?? [];
  const requestedUserIds = input.selectionMode === 'SELECTED_USERS'
    ? [...new Set(suppliedIds)].sort((a, b) => a - b)
    : [];
  const duplicates = suppliedIds.filter((id, index) => suppliedIds.indexOf(id) !== index);
  const users = await prisma.user.findMany({
    where: input.selectionMode === 'SELECTED_USERS'
      ? { id: { in: requestedUserIds } }
      : { enabled: true },
    select: { id: true, name: true, email: true, enabled: true },
    orderBy: { id: 'asc' },
  });
  const foundIds = new Set(users.map((user) => user.id));
  const selectionResults: Array<Record<string, unknown>> = [
    ...[...new Set(duplicates)].map((userId) => ({ userId, outcome: 'EXCLUDED', code: 'DUPLICATE_USER_ID' })),
    ...requestedUserIds.filter((id) => !foundIds.has(id)).map((userId) => ({ userId, outcome: 'EXCLUDED', code: 'USER_NOT_FOUND' })),
  ];

  const ownedAccounts = await prisma.tradingAccount.findMany({
    where: { accountHolderUserId: { in: users.map((user) => user.id) }, environment: 'PAPER' },
    select: { id: true, accountHolderUserId: true },
    orderBy: { id: 'asc' },
  });
  const accountsByUser = new Map<number, number[]>();
  for (const account of ownedAccounts) accountsByUser.set(account.accountHolderUserId, [...(accountsByUser.get(account.accountHolderUserId) ?? []), account.id]);
  for (const user of users) {
    if (!user.enabled) selectionResults.push({ userId: user.id, name: user.name, email: user.email, outcome: 'EXCLUDED', code: 'USER_DISABLED' });
    else if (!(accountsByUser.get(user.id)?.length)) selectionResults.push({ userId: user.id, name: user.name, email: user.email, outcome: 'EXCLUDED', code: 'NO_OWNED_PAPER_ACCOUNT' });
  }

  const assignments = await prisma.tradingAccountSubscription.findMany({
    where: {
      subscriptionId: subscription.id,
      tradingAccountId: { in: ownedAccounts.map((account) => account.id) },
      tradingAccount: { accountHolder: { enabled: true }, environment: 'PAPER' },
    },
    select: FINGERPRINT_ASSIGNMENT_SELECT,
    orderBy: [{ tradingAccountId: 'asc' }, { id: 'asc' }],
  });
  const assignmentAccountIds = new Set(assignments.map((row) => row.tradingAccount.id));
  for (const user of users.filter((row) => row.enabled)) {
    const accountIds = accountsByUser.get(user.id) ?? [];
    if (accountIds.length && !accountIds.some((id) => assignmentAccountIds.has(id))) {
      selectionResults.push({ userId: user.id, name: user.name, email: user.email, outcome: 'EXCLUDED', code: 'NO_MATCHING_ASSIGNMENT' });
    }
  }
  if (assignments.length > LIFECYCLE_EXERCISE_MAX_TARGETS) throw new HttpError(409, `Lifecycle exercises support at most ${LIFECYCLE_EXERCISE_MAX_TARGETS} targets.`);

  const configFingerprint = configurationFingerprint({
    subscriptionId: subscription.id, selectionMode: input.selectionMode,
    requestedUserIds, assignments,
  });
  const targets = [];
  for (const assignment of assignments) {
    const blockers = staticBlockers(assignment);
    const riskPreview = await previewTradingAccountEntryRisk(assignment.tradingAccount.id, {
      subscriptionKey: subscription.key,
      ignoreSession: false,
    });
    if (!riskPreview?.ok) blockers.push({
      code: String(riskPreview?.blockingCode ?? 'ENTRY_RISK_BLOCKED').toUpperCase(),
      message: String(riskPreview?.risk?.message ?? 'Current entry risk checks did not pass.'),
    });
    if (riskPreview?.session && 'wouldBlockRealEntryNow' in riskPreview.session && riskPreview.session.wouldBlockRealEntryNow) {
      blockers.push({ code: String(riskPreview.session.code ?? 'ENTRY_SESSION_BLOCKED').toUpperCase(), message: String(riskPreview.session.message ?? 'The entry session is closed.') });
    }
    const sizing = riskPreview?.sizing ?? null;
    targets.push({
      assignment, riskPreview, blockers,
      status: blockers.length ? TradingLifecycleExerciseTargetStatus.BLOCKED : TradingLifecycleExerciseTargetStatus.READY,
      sizing,
    });
  }

  const exercise = await prisma.tradingLifecycleExercise.create({
    data: {
      name: input.name ?? null, reason: input.reason, subscriptionId: subscription.id,
      selectionMode: input.selectionMode, requestedUserIdsJson: json(requestedUserIds),
      environment: 'PAPER', status: TradingLifecycleExerciseStatus.PREVIEWED,
      previewFingerprint: configFingerprint, previewedAt: now,
      previewExpiresAt: new Date(now.getTime() + LIFECYCLE_EXERCISE_PREVIEW_TTL_MS),
      createdByUserId: actorUserId, selectionResultsJson: json(selectionResults),
      summaryJson: json({ targetCount: targets.length, readyCount: targets.filter((row) => !row.blockers.length).length, blockedCount: targets.filter((row) => row.blockers.length).length }),
      targets: {
        create: targets.map(({ assignment, riskPreview, blockers, status, sizing }) => ({
          accountHolderUserId: assignment.tradingAccount.accountHolderUserId,
          tradingAccountId: assignment.tradingAccount.id,
          tradingAccountSubscriptionId: assignment.id,
          environment: 'PAPER', status, previewFingerprint: configFingerprint,
          readinessJson: json(riskPreview ?? {}), blockersJson: json(blockers), warningsJson: json([]),
          resolvedSizingJson: sizing ? json(sizing) : undefined,
          estimatedPrice: sizing?.latestPrice ?? null,
          resolvedQuantity: sizing?.calculatedQty ?? null,
          estimatedNotional: sizing?.estimatedNotional ?? null,
        })) as Prisma.TradingLifecycleExerciseTargetUncheckedCreateWithoutExerciseInput[],
      },
    },
    include: { subscription: true, createdByUser: { select: { id: true, name: true, email: true } }, targets: { orderBy: [{ tradingAccountId: 'asc' }, { tradingAccountSubscriptionId: 'asc' }] } },
  });
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.previewed', entityType: 'tradingLifecycleExercise',
    entityId: exercise.id, actorUserId,
    message: `Paper lifecycle exercise ${exercise.id} previewed.`,
    payloadJson: json({ exerciseId: exercise.id, subscriptionId: subscription.id, subscriptionKey: subscription.key, environment: 'PAPER', targetCount: targets.length }),
  });
  return exercise;
}

async function getExerciseOrThrow(id: number) {
  const exercise = await prisma.tradingLifecycleExercise.findUnique({
    where: { id },
    include: {
      subscription: true, createdByUser: { select: { id: true, name: true, email: true } },
      targets: {
        include: {
          accountHolderUser: { select: { id: true, name: true, email: true } },
          tradingAccount: { select: { id: true, displayName: true, environment: true } },
          tradingAccountSubscription: { select: { id: true, subscriptionId: true, tradingAccountId: true } },
          orderIntent: { include: { brokerOrders: { orderBy: { id: 'asc' } }, trackedPosition: { include: { exitState: true } } } },
        },
        orderBy: [{ tradingAccountId: 'asc' }, { tradingAccountSubscriptionId: 'asc' }],
      },
    },
  });
  if (!exercise) throw new HttpError(404, 'Lifecycle exercise not found.');
  return exercise;
}

export async function launchTradingLifecycleExercise(id: number, actorUserId: number, now = new Date()) {
  const claimed = await prisma.tradingLifecycleExercise.updateMany({
    where: { id, status: TradingLifecycleExerciseStatus.PREVIEWED },
    data: { status: TradingLifecycleExerciseStatus.LAUNCHING, launchedAt: now },
  });
  if (!claimed.count) throw new HttpError(409, 'Lifecycle exercise is not launchable or is already claimed.');
  let exercise = await getExerciseOrThrow(id);
  if (exercise.environment !== 'PAPER' || exercise.targets.some((target) => target.environment !== 'PAPER' || target.tradingAccount.environment !== 'PAPER')) {
    await prisma.tradingLifecycleExercise.update({ where: { id }, data: { status: TradingLifecycleExerciseStatus.FAILED } });
    throw new HttpError(409, 'LIVE_TARGET_REJECTED');
  }
  if (exercise.previewExpiresAt <= now) {
    await prisma.tradingLifecycleExercise.update({ where: { id }, data: { status: TradingLifecycleExerciseStatus.BLOCKED } });
    throw new HttpError(409, 'PREVIEW_EXPIRED');
  }
  const currentAssignments = await loadFingerprintAssignments(exercise.targets.map((target) => target.tradingAccountSubscriptionId));
  const currentFingerprint = configurationFingerprint({
    subscriptionId: exercise.subscriptionId, selectionMode: exercise.selectionMode,
    requestedUserIds: exercise.requestedUserIdsJson as number[], assignments: currentAssignments,
  });
  if (currentAssignments.length !== exercise.targets.length || currentFingerprint !== exercise.previewFingerprint) {
    await prisma.tradingLifecycleExercise.update({ where: { id }, data: { status: TradingLifecycleExerciseStatus.BLOCKED } });
    throw new HttpError(409, 'PREVIEW_STALE');
  }

  let active = 0;
  let unsuccessful = 0;
  for (const target of exercise.targets) {
    const dispatchClaim = await prisma.tradingLifecycleExerciseTarget.updateMany({
      where: { id: target.id, status: { in: [TradingLifecycleExerciseTargetStatus.READY, TradingLifecycleExerciseTargetStatus.WARNING, TradingLifecycleExerciseTargetStatus.BLOCKED] } },
      data: { status: TradingLifecycleExerciseTargetStatus.DISPATCHING, dispatchStartedAt: new Date() },
    });
    if (!dispatchClaim.count) continue;
    const result = await processEntryForAccountSubscription({
      tradingAccountSubscriptionId: target.tradingAccountSubscriptionId,
      source: 'LIFECYCLE_EXERCISE',
      idempotencyKey: `lifecycle-exercise:${id}:target:${target.id}`,
      signal: { signalType: 'entry', source: 'LIFECYCLE_EXERCISE', reason: exercise.reason, metadata: { exerciseId: id, targetId: target.id } },
    });
    const targetStatus = result.outcome === 'INTENT_CREATED'
      ? TradingLifecycleExerciseTargetStatus.INTENT_CREATED
      : result.outcome === 'DUPLICATE'
        ? TradingLifecycleExerciseTargetStatus.DUPLICATE
        : result.outcome === 'BLOCKED'
          ? TradingLifecycleExerciseTargetStatus.BLOCKED
          : TradingLifecycleExerciseTargetStatus.FAILED;
    if (result.orderIntentId) active += 1; else unsuccessful += 1;
    await prisma.tradingLifecycleExerciseTarget.update({
      where: { id: target.id },
      data: {
        status: targetStatus, orderIntentId: result.orderIntentId,
        dispatchCompletedAt: new Date(), intentCreatedAt: result.orderIntentId ? new Date() : null,
        blockersJson: result.outcome === 'BLOCKED'
          ? json([{ code: result.code, message: result.message }])
          : (target.blockersJson ?? Prisma.JsonNull),
      },
    });
    await createSystemEvent({
      type: 'trading_lifecycle_exercise.target_outcome', entityType: 'tradingLifecycleExerciseTarget',
      entityId: target.id, tradingAccountId: target.tradingAccountId, actorUserId,
      message: result.message,
      payloadJson: json({ exerciseId: id, targetId: target.id, subscriptionId: exercise.subscriptionId, environment: 'PAPER', resultCode: result.code, outcome: result.outcome, orderIntentId: result.orderIntentId, tradingAccountSubscriptionId: target.tradingAccountSubscriptionId }),
    });
  }
  const status = active > 0
    ? (unsuccessful > 0 ? TradingLifecycleExerciseStatus.PARTIAL : TradingLifecycleExerciseStatus.RUNNING)
    : TradingLifecycleExerciseStatus.BLOCKED;
  await prisma.tradingLifecycleExercise.update({ where: { id }, data: { status, summaryJson: json({ activeCount: active, blockedOrFailedCount: unsuccessful }) } });
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.launched', entityType: 'tradingLifecycleExercise',
    entityId: id, actorUserId, message: `Paper lifecycle exercise ${id} launch processed.`,
    payloadJson: json({ exerciseId: id, subscriptionId: exercise.subscriptionId, environment: 'PAPER', activeCount: active, blockedOrFailedCount: unsuccessful }),
  });
  return getExerciseOrThrow(id);
}

export async function cancelTradingLifecycleExercise(id: number, reason: string, actorUserId: number) {
  const now = new Date();
  const exercise = await getExerciseOrThrow(id);
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(exercise.status)) throw new HttpError(409, 'Lifecycle exercise cannot be cancelled in its current state.');
  await prisma.$transaction([
    prisma.tradingLifecycleExercise.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now, summaryJson: json({ cancellationReason: reason, lifecycleContinuesForDispatchedTargets: true }) } }),
    prisma.tradingLifecycleExerciseTarget.updateMany({
      where: { exerciseId: id, orderIntentId: null, status: { notIn: ['CANCELLED', 'RECONCILED'] } },
      data: { status: 'CANCELLED', cancelledAt: now },
    }),
  ]);
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.cancelled', entityType: 'tradingLifecycleExercise',
    entityId: id, actorUserId, message: reason,
    payloadJson: json({ exerciseId: id, environment: 'PAPER', reason, lifecycleContinuesForDispatchedTargets: true }),
  });
  return getExerciseOrThrow(id);
}

export async function reconcileTradingLifecycleExerciseTarget(exerciseId: number, targetId: number, actorUserId: number) {
  const target = await prisma.tradingLifecycleExerciseTarget.findFirst({ where: { id: targetId, exerciseId }, include: { exercise: true } });
  if (!target) throw new HttpError(404, 'Lifecycle exercise target not found.');
  const result = await reconcileTradingAccountWithLock(target.tradingAccountId, { persistEvents: false, persistAttention: false });
  const summary = { runIdentifier: result.runIdentifier, clean: result.findings.length === 0, findingCount: result.findings.length, findings: result.findings.map(({ code, severity, entityType, entityId, symbol, message }) => ({ code, severity, entityType, entityId, symbol, message })) };
  await prisma.tradingLifecycleExerciseTarget.update({
    where: { id: target.id },
    data: { reconciledAt: new Date(), reconciliationSummaryJson: json(summary), status: summary.clean ? 'RECONCILED' : 'ATTENTION_REQUIRED' },
  });
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.reconciled', entityType: 'tradingLifecycleExerciseTarget',
    entityId: target.id, tradingAccountId: target.tradingAccountId, actorUserId,
    message: summary.clean ? 'Lifecycle exercise target reconciliation is clean.' : 'Lifecycle exercise target reconciliation requires attention.',
    payloadJson: json({ exerciseId, targetId, tradingAccountId: target.tradingAccountId, environment: 'PAPER', clean: summary.clean, findingCount: summary.findingCount }),
  });
  return { target: (await getExerciseOrThrow(exerciseId)).targets.find((row) => row.id === targetId), reconciliation: summary };
}

export async function listTradingLifecycleExercises(limit = 50) {
  return prisma.tradingLifecycleExercise.findMany({
    take: Math.min(Math.max(limit, 1), 100), orderBy: { createdAt: 'desc' },
    include: { subscription: { select: { id: true, key: true, name: true } }, createdByUser: { select: { id: true, name: true, email: true } }, _count: { select: { targets: true } } },
  });
}

export const getTradingLifecycleExercise = getExerciseOrThrow;
