import crypto from 'node:crypto';
import {
  Prisma,
  TradingLifecycleExerciseLaunchOutcome,
  TradingLifecycleExerciseStatus,
  TradingLifecycleExerciseTargetStatus,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type { LifecycleExercisePreviewInput } from '../validators/trading-lifecycle-exercise.schema.js';
import type { SubscriptionEntryPreviewInput } from '../validators/trading-lifecycle-exercise.schema.js';
import { evaluateAssignmentEntry, evaluateAssignmentEntryPreviewDiagnostics } from './assignment-entry-evaluation.service.js';
import { previewTradingAccountEntryRisk } from './trading-account-entry-risk-preview.service.js';
import { processEntryForAccountSubscription } from './signal-entry.service.js';
import { createSystemEvent } from './system-event.service.js';
import { reconcileTradingAccountWithLock } from './reconciliation.service.js';
import { projectTradingLifecycleExerciseTarget } from './trading-lifecycle-exercise-projection.service.js';
import { isTerminalBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import { buildSignalEntryClientOrderId } from './client-order-id.service.js';

export const LIFECYCLE_EXERCISE_MAX_TARGETS = 25;
export const LIFECYCLE_EXERCISE_PREVIEW_TTL_MS = 5 * 60_000;
export const LIFECYCLE_EXERCISE_DISPATCH_STALE_MS = 5 * 60_000;
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
      accountHolder: { select: { enabled: true } },
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
  version?: number;
  exerciseType?: string;
  subscriptionId: number;
  selectionMode: string;
  requestedUserIds: number[];
  assignments: Awaited<ReturnType<typeof loadFingerprintAssignments>>;
}) {
  const version = args.version ?? 1;
  return fingerprint({
    version,
    ...(version >= 2 ? { exerciseType: args.exerciseType ?? 'SUBSCRIPTION_ENTRY' } : {}),
    environment: 'PAPER',
    subscriptionId: args.subscriptionId,
    selectionMode: args.selectionMode,
    requestedUserIds: args.requestedUserIds,
    ...(version >= 2 && args.selectionMode === 'EXPLICIT_ASSIGNMENTS'
      ? { frozenAssignmentIds: args.assignments.map((assignment) => assignment.id).sort((a, b) => a - b) }
      : {}),
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
  if (!account.accountHolder.enabled) blockers.push({ code: 'ACCOUNT_HOLDER_DISABLED', message: 'The account holder is disabled.' });
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

function launchOutcome(outcome: string): TradingLifecycleExerciseLaunchOutcome {
  if (outcome === 'INTENT_CREATED') return TradingLifecycleExerciseLaunchOutcome.INTENT_CREATED;
  if (outcome === 'DUPLICATE') return TradingLifecycleExerciseLaunchOutcome.DUPLICATE;
  if (outcome === 'BLOCKED') return TradingLifecycleExerciseLaunchOutcome.BLOCKED;
  return TradingLifecycleExerciseLaunchOutcome.FAILED;
}

const CANDIDATE_SELECT = {
  id: true,
  subscriptionId: true,
  tradingAccountId: true,
  allocationId: true,
  enabled: true,
  entriesEnabled: true,
  exitsEnabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  reservedNotional: true,
  minPositionNotional: true,
  maxQty: true,
  subscription: { select: {
    id: true, key: true, name: true, enabled: true,
    security: { select: { enabled: true } },
    strategy: { select: { enabled: true } },
    exitProfile: { select: { enabled: true } },
  } },
  allocation: { select: { id: true, key: true, name: true, enabled: true } },
  tradingAccount: {
    select: {
      id: true, displayName: true, environment: true, status: true,
      tradingEnabled: true, killSwitchEnabled: true,
      accountHolder: { select: { id: true, name: true, email: true, enabled: true } },
      memberships: {
        select: { user: { select: { id: true, name: true, email: true, enabled: true } } },
        orderBy: { userId: 'asc' },
      },
      credential: { select: { status: true, verifiedAt: true } },
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

export type SubscriptionEntryCandidateUnavailableReason = { code: string; message: string };
export type SubscriptionEntryCandidate = {
  tradingAccountSubscriptionId: number;
  subscriptionId: number;
  subscription: { key: string; displayName: string };
  tradingAccountId: number;
  tradingAccount: {
    displayName: string;
    environment: string;
    status: string;
    tradingEnabled: boolean;
    killSwitchEnabled: boolean;
    credentialStatus: string | null;
  };
  accountHolder: { id: number; name: string | null; email: string; enabled: boolean };
  accessMembers: Array<{ id: number; name: string | null; email: string; enabled: boolean }>;
  assignment: {
    enabled: boolean;
    entriesEnabled: boolean;
    exitsEnabled: boolean;
    sizingType: string;
    fixedQty: number | null;
    maxPositionNotional: number | null;
    reservedNotional: number | null;
    minPositionNotional: number | null;
    maxQty: number | null;
  };
  allocation: { id: number; key: string; displayName: string; enabled: boolean } | null;
  selectable: boolean;
  unavailableReasons: SubscriptionEntryCandidateUnavailableReason[];
};

export async function listSubscriptionEntryCandidates(subscriptionId: number): Promise<{
  subscription: { id: number; key: string; displayName: string };
  candidates: SubscriptionEntryCandidate[];
}> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId }, select: { id: true, key: true, name: true },
  });
  if (!subscription) throw new HttpError(404, 'Subscription not found.', { code: 'SUBSCRIPTION_NOT_FOUND', subscriptionId });

  const assignments = await prisma.tradingAccountSubscription.findMany({
    where: { subscriptionId }, select: CANDIDATE_SELECT,
    orderBy: [{ tradingAccountId: 'asc' }, { id: 'asc' }],
  });
  const candidates = assignments.map((row): SubscriptionEntryCandidate => {
    const unavailableReasons: SubscriptionEntryCandidateUnavailableReason[] = [];
    if (row.tradingAccount.environment === 'LIVE') {
      unavailableReasons.push({ code: 'LIVE_EXERCISES_NOT_SUPPORTED', message: 'Lifecycle Exercises support PAPER assignments only.' });
    }
    if (row.tradingAccount.environment !== 'LIVE') {
      if (row.tradingAccount.status !== 'ACTIVE') unavailableReasons.push({ code: 'ACCOUNT_NOT_OPERATIONAL', message: 'Trading account is not active.' });
      if (!row.tradingAccount.tradingEnabled) unavailableReasons.push({ code: 'ACCOUNT_TRADING_DISABLED', message: 'Trading is disabled for this account.' });
      if (row.tradingAccount.killSwitchEnabled) unavailableReasons.push({ code: 'ACCOUNT_KILL_SWITCH_ENABLED', message: 'The account kill switch is enabled.' });
      if (row.tradingAccount.credential?.status !== 'ACTIVE') unavailableReasons.push({ code: 'ACCOUNT_CREDENTIALS_INACTIVE', message: 'Active verified credentials are required.' });
      if (!row.enabled) unavailableReasons.push({ code: 'ASSIGNMENT_DISABLED', message: 'The assignment is disabled.' });
      if (!row.entriesEnabled) unavailableReasons.push({ code: 'ASSIGNMENT_ENTRIES_DISABLED', message: 'Entries are disabled for the assignment.' });
      if (!row.exitsEnabled) unavailableReasons.push({ code: 'ASSIGNMENT_EXITS_DISABLED', message: 'Exits must be enabled for a lifecycle exercise.' });
      if (!row.subscription.enabled) unavailableReasons.push({ code: 'SUBSCRIPTION_DISABLED', message: 'The Subscription is disabled.' });
      if (!row.subscription.security.enabled) unavailableReasons.push({ code: 'SECURITY_DISABLED', message: 'The Security is disabled.' });
      if (!row.subscription.strategy.enabled) unavailableReasons.push({ code: 'STRATEGY_DISABLED', message: 'The Strategy is disabled.' });
      if (!row.subscription.exitProfile.enabled) unavailableReasons.push({ code: 'EXIT_PROFILE_DISABLED', message: 'The Exit Profile is disabled.' });
      if (!row.allocation?.enabled) unavailableReasons.push({ code: 'ALLOCATION_INELIGIBLE', message: 'An enabled allocation is required.' });
      if (!row.tradingAccount.accountHolder.enabled) unavailableReasons.push({ code: 'ACCOUNT_HOLDER_DISABLED', message: 'The account holder is disabled.' });
    }
    return {
      tradingAccountSubscriptionId: row.id,
      subscriptionId: row.subscriptionId,
      subscription: { key: row.subscription.key, displayName: row.subscription.name },
      tradingAccountId: row.tradingAccountId,
      tradingAccount: {
        displayName: row.tradingAccount.displayName, environment: row.tradingAccount.environment,
        status: row.tradingAccount.status, tradingEnabled: row.tradingAccount.tradingEnabled,
        killSwitchEnabled: row.tradingAccount.killSwitchEnabled,
        credentialStatus: row.tradingAccount.credential?.status ?? null,
      },
      accountHolder: row.tradingAccount.accountHolder,
      accessMembers: row.tradingAccount.memberships.map(({ user }) => user),
      assignment: {
        enabled: row.enabled, entriesEnabled: row.entriesEnabled, exitsEnabled: row.exitsEnabled,
        sizingType: row.sizingType, fixedQty: row.fixedQty,
        maxPositionNotional: row.maxPositionNotional, reservedNotional: row.reservedNotional,
        minPositionNotional: row.minPositionNotional, maxQty: row.maxQty,
      },
      allocation: row.allocation ? { id: row.allocation.id, key: row.allocation.key, displayName: row.allocation.name, enabled: row.allocation.enabled } : null,
      selectable: unavailableReasons.length === 0,
      unavailableReasons,
    };
  });
  return { subscription: { id: subscription.id, key: subscription.key, displayName: subscription.name }, candidates };
}

export async function previewSubscriptionEntryLifecycleExercise(
  input: SubscriptionEntryPreviewInput,
  actorUserId: number,
  now = new Date()
) {
  const subscription = await prisma.subscription.findUnique({
    where: { id: input.subscriptionId }, select: { id: true, key: true, name: true },
  });
  if (!subscription) throw new HttpError(404, 'Subscription not found.', { code: 'SUBSCRIPTION_NOT_FOUND', subscriptionId: input.subscriptionId });

  const requestedIds = [...input.tradingAccountSubscriptionIds].sort((a, b) => a - b);
  const identityRows = await prisma.tradingAccountSubscription.findMany({
    where: { id: { in: requestedIds } },
    select: {
      id: true, subscriptionId: true,
      tradingAccount: { select: { id: true, environment: true } },
    },
    orderBy: { id: 'asc' },
  });
  const byId = new Map(identityRows.map((row) => [row.id, row]));
  const identityErrors = requestedIds.flatMap((assignmentId) => {
    const row = byId.get(assignmentId);
    if (!row) return [{ code: 'ASSIGNMENT_NOT_FOUND', tradingAccountSubscriptionId: assignmentId, message: `TradingAccountSubscription ${assignmentId} was not found.` }];
    if (row.subscriptionId !== subscription.id) return [{ code: 'ASSIGNMENT_WRONG_SUBSCRIPTION', tradingAccountSubscriptionId: assignmentId, actualSubscriptionId: row.subscriptionId, message: `TradingAccountSubscription ${assignmentId} does not belong to Subscription ${subscription.id}.` }];
    if (row.tradingAccount.environment !== 'PAPER') return [{ code: 'LIVE_EXERCISES_NOT_SUPPORTED', tradingAccountSubscriptionId: assignmentId, message: `TradingAccountSubscription ${assignmentId} is not a PAPER assignment.` }];
    return [];
  });
  if (identityErrors.length) {
    throw new HttpError(409, 'One or more selected assignments are invalid.', {
      code: 'INVALID_ASSIGNMENT_SELECTION', errors: identityErrors,
    });
  }

  const assignments = await loadFingerprintAssignments(requestedIds);
  assignments.sort((left, right) => left.tradingAccount.id - right.tradingAccount.id || left.id - right.id);
  const loadedIds = new Set(assignments.map((assignment) => assignment.id));
  if (
    assignments.length !== requestedIds.length
    || requestedIds.some((assignmentId) => !loadedIds.has(assignmentId))
    || assignments.some((assignment) => assignment.subscription.id !== subscription.id || assignment.tradingAccount.environment !== 'PAPER')
  ) {
    throw new HttpError(409, 'Selected assignment identity changed during preview creation.', {
      code: 'ASSIGNMENT_SELECTION_CHANGED', tradingAccountSubscriptionIds: requestedIds,
    });
  }
  const configFingerprint = configurationFingerprint({
    version: 2,
    exerciseType: 'SUBSCRIPTION_ENTRY',
    subscriptionId: subscription.id,
    selectionMode: 'EXPLICIT_ASSIGNMENTS',
    requestedUserIds: [],
    assignments,
  });
  const targets = [];
  for (const assignment of assignments) {
    let evaluation: Awaited<ReturnType<typeof evaluateAssignmentEntry>> | null = null;
    let blockers = staticBlockers(assignment);
    try {
      evaluation = await evaluateAssignmentEntryPreviewDiagnostics({
        input: {
          tradingAccountSubscriptionId: assignment.id,
          subscriptionKey: subscription.key,
          signalType: 'entry',
          extendedHours: false,
        },
      });
      blockers = [...blockers, ...evaluation.blockers.map((blocker) => ({
        code: blocker.code.toUpperCase(), message: blocker.message,
      }))];
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (!blockers.length) blockers.push({
        code: typeof (error.details as { rule?: unknown } | undefined)?.rule === 'string'
          ? String((error.details as { rule: string }).rule).toUpperCase()
          : 'ENTRY_EVALUATION_BLOCKED',
        message: error.message,
      });
    }
    targets.push({
      assignment, evaluation, blockers,
      status: blockers.length ? TradingLifecycleExerciseTargetStatus.BLOCKED : TradingLifecycleExerciseTargetStatus.READY,
    });
  }

  const exercise = await prisma.tradingLifecycleExercise.create({
    data: {
      name: input.name ?? null, reason: input.reason, subscriptionId: subscription.id,
      exerciseType: 'SUBSCRIPTION_ENTRY', selectionMode: 'EXPLICIT_ASSIGNMENTS', requestedUserIdsJson: json([]),
      environment: 'PAPER', containsLiveTargets: false, status: TradingLifecycleExerciseStatus.PREVIEWED,
      previewVersion: 2,
      previewFingerprint: configFingerprint, previewedAt: now,
      previewExpiresAt: new Date(now.getTime() + LIFECYCLE_EXERCISE_PREVIEW_TTL_MS),
      createdByUserId: actorUserId,
      selectionResultsJson: json(requestedIds.map((tradingAccountSubscriptionId) => ({
        tradingAccountSubscriptionId, outcome: 'SELECTED', code: 'EXPLICIT_ASSIGNMENT_SELECTED',
      }))),
      summaryJson: json({
        targetCount: targets.length,
        readyCount: targets.filter((row) => !row.blockers.length).length,
        blockedCount: targets.filter((row) => row.blockers.length).length,
      }),
      targets: {
        create: targets.map(({ assignment, evaluation, blockers, status }) => ({
          accountHolderUserId: assignment.tradingAccount.accountHolderUserId,
          tradingAccountId: assignment.tradingAccount.id,
          tradingAccountSubscriptionId: assignment.id,
          environment: 'PAPER', status, previewFingerprint: configFingerprint,
          readinessJson: json(evaluation ?? {}), blockersJson: json(blockers),
          warningsJson: json(evaluation?.warnings ?? []),
          resolvedSizingJson: evaluation ? json(evaluation.sizing) : undefined,
          estimatedPrice: evaluation?.referencePrice ?? null,
          resolvedQuantity: evaluation?.sizing.qty ?? null,
          estimatedNotional: evaluation?.estimatedNotional ?? null,
        })) as Prisma.TradingLifecycleExerciseTargetUncheckedCreateWithoutExerciseInput[],
      },
    },
    include: {
      subscription: true,
      createdByUser: { select: { id: true, name: true, email: true } },
      targets: { orderBy: [{ tradingAccountId: 'asc' }, { tradingAccountSubscriptionId: 'asc' }] },
    },
  });
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.previewed', entityType: 'tradingLifecycleExercise',
    entityId: exercise.id, actorUserId,
    message: `Paper lifecycle exercise ${exercise.id} previewed from explicit assignments.`,
    payloadJson: json({
      exerciseId: exercise.id, subscriptionId: subscription.id, subscriptionKey: subscription.key,
      environment: 'PAPER', selectionMode: 'EXPLICIT_ASSIGNMENTS',
      tradingAccountSubscriptionIds: requestedIds, targetCount: targets.length,
    }),
  });
  return exercise;
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
      exerciseType: 'SUBSCRIPTION_ENTRY', selectionMode: input.selectionMode, requestedUserIdsJson: json(requestedUserIds),
      environment: 'PAPER', containsLiveTargets: false, status: TradingLifecycleExerciseStatus.PREVIEWED,
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
          orderIntent: { include: {
            brokerActivities: { orderBy: { id: 'asc' } },
            brokerOrders: { include: { trackedPosition: { include: { exitState: true } } }, orderBy: { id: 'asc' } },
            trackedPosition: { include: { exitState: true } },
          } },
        },
        orderBy: [{ tradingAccountId: 'asc' }, { tradingAccountSubscriptionId: 'asc' }],
      },
    },
  });
  if (!exercise) throw new HttpError(404, 'Lifecycle exercise not found.');
  return {
    ...exercise,
    recoveryApplicable: exercise.targets.some((target) => target.status === TradingLifecycleExerciseTargetStatus.DISPATCHING && Boolean(target.dispatchStartedAt) && target.dispatchStartedAt!.getTime() <= Date.now() - LIFECYCLE_EXERCISE_DISPATCH_STALE_MS),
    targets: exercise.targets.map((target) => ({
      ...target,
      projection: projectTradingLifecycleExerciseTarget(target),
    })),
  };
}

export async function launchTradingLifecycleExercise(id: number, actorUserId: number, now = new Date()) {
  const claimed = await prisma.tradingLifecycleExercise.updateMany({
    where: { id, status: TradingLifecycleExerciseStatus.PREVIEWED },
    data: { status: TradingLifecycleExerciseStatus.LAUNCHING, launchedAt: now },
  });
  if (!claimed.count) throw new HttpError(409, 'Lifecycle exercise is not launchable or is already claimed.');
  let exercise = await getExerciseOrThrow(id);
  if (exercise.exerciseType !== 'SUBSCRIPTION_ENTRY' || exercise.containsLiveTargets || exercise.environment !== 'PAPER' || exercise.targets.some((target) => target.environment !== 'PAPER' || target.tradingAccount.environment !== 'PAPER')) {
    await prisma.tradingLifecycleExercise.update({ where: { id }, data: { status: TradingLifecycleExerciseStatus.FAILED } });
    throw new HttpError(409, 'LIVE_TARGET_REJECTED');
  }
  if (exercise.previewExpiresAt <= now) {
    await prisma.tradingLifecycleExercise.update({ where: { id }, data: { status: TradingLifecycleExerciseStatus.BLOCKED } });
    throw new HttpError(409, 'PREVIEW_EXPIRED');
  }
  const currentAssignments = await loadFingerprintAssignments(exercise.targets.map((target) => target.tradingAccountSubscriptionId));
  const currentFingerprint = configurationFingerprint({
    version: exercise.previewVersion,
    exerciseType: exercise.exerciseType,
    subscriptionId: exercise.subscriptionId, selectionMode: exercise.selectionMode,
    requestedUserIds: exercise.requestedUserIdsJson as number[], assignments: currentAssignments,
  });
  if (currentAssignments.length !== exercise.targets.length || currentFingerprint !== exercise.previewFingerprint) {
    await prisma.tradingLifecycleExercise.update({ where: { id }, data: { status: TradingLifecycleExerciseStatus.BLOCKED } });
    throw new HttpError(409, 'PREVIEW_STALE');
  }

  let active = 0;
  let unsuccessful = exercise.targets.filter((target) => target.status === TradingLifecycleExerciseTargetStatus.BLOCKED).length;
  for (const target of exercise.targets) {
    const dispatchClaim = await prisma.tradingLifecycleExerciseTarget.updateMany({
      where: {
        id: target.id,
        exercise: { status: TradingLifecycleExerciseStatus.LAUNCHING },
        status: { in: [TradingLifecycleExerciseTargetStatus.READY, TradingLifecycleExerciseTargetStatus.WARNING] },
      },
      data: { status: TradingLifecycleExerciseTargetStatus.DISPATCHING, dispatchStartedAt: now, launchAttemptedAt: now },
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
        launchOutcome: launchOutcome(result.outcome),
        launchResultCode: result.code,
        launchResultMessage: result.message,
        launchEvidenceJson: json({ source: 'LAUNCH', outcome: result.outcome, code: result.code, orderIntentId: result.orderIntentId }),
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

function exerciseTargetIdentity(exerciseId: number, targetId: number) {
  return `lifecycle-exercise:${exerciseId}:target:${targetId}`;
}

async function recordRecoveryEvent(args: {
  type: string; message: string; exerciseId: number; target: {
    id: number; tradingAccountId: number; tradingAccountSubscriptionId: number;
    environment: string; dispatchStartedAt: Date | null;
  }; actorUserId: number; code: string; orderIntentId?: number | null; evidence?: Record<string, unknown>;
}) {
  await createSystemEvent({
    type: args.type, entityType: 'tradingLifecycleExerciseTarget', entityId: args.target.id,
    tradingAccountId: args.target.tradingAccountId, actorUserId: args.actorUserId, message: args.message,
    payloadJson: json({
      exerciseId: args.exerciseId, targetId: args.target.id,
      tradingAccountId: args.target.tradingAccountId,
      tradingAccountSubscriptionId: args.target.tradingAccountSubscriptionId,
      environment: args.target.environment, recoveryCode: args.code,
      orderIntentId: args.orderIntentId ?? null,
      staleDispatchStartedAt: args.target.dispatchStartedAt?.toISOString() ?? null,
      ...(args.evidence ?? {}),
    }),
  });
}

export async function recoverStaleTradingLifecycleExerciseDispatches(
  exerciseId: number,
  actorUserId: number,
  now = new Date()
) {
  const staleBefore = new Date(now.getTime() - LIFECYCLE_EXERCISE_DISPATCH_STALE_MS);
  const exercise = await prisma.tradingLifecycleExercise.findUnique({
    where: { id: exerciseId },
    include: {
      targets: {
        where: { status: TradingLifecycleExerciseTargetStatus.DISPATCHING, dispatchStartedAt: { lte: staleBefore } },
        include: { orderIntent: { select: { id: true, status: true } } },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!exercise) throw new HttpError(404, 'Lifecycle exercise not found.');
  if (exercise.exerciseType !== 'SUBSCRIPTION_ENTRY' || exercise.containsLiveTargets || exercise.environment !== 'PAPER') {
    throw new HttpError(409, 'Lifecycle exercise recovery supports PAPER Subscription-entry exercises only.');
  }
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.dispatch_recovery_started', entityType: 'tradingLifecycleExercise',
    entityId: exerciseId, actorUserId, message: `Dispatch recovery started for lifecycle exercise ${exerciseId}.`,
    payloadJson: json({ exerciseId, environment: exercise.environment, staleBefore: staleBefore.toISOString(), targetCount: exercise.targets.length }),
  });
  const results: Array<{ targetId: number; code: string; orderIntentId: number | null }> = [];
  for (const target of exercise.targets) {
    const identity = exerciseTargetIdentity(exerciseId, target.id);
    const clientOrderId = buildSignalEntryClientOrderId({
      signalIdentity: identity,
      tradingAccountSubscriptionId: target.tradingAccountSubscriptionId,
    });
    let matches = target.orderIntent ? [target.orderIntent] : await prisma.orderIntent.findMany({
      where: {
        clientOrderId,
        tradingAccountId: target.tradingAccountId,
        tradingAccountSubscriptionId: target.tradingAccountSubscriptionId,
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (matches.length > 1) {
      const evidence = { clientOrderId, matchingOrderIntentIds: matches.map((row) => row.id) };
      const changed = await prisma.tradingLifecycleExerciseTarget.updateMany({
        where: { id: target.id, status: 'DISPATCHING', dispatchStartedAt: { lte: staleBefore }, orderIntentId: null },
        data: {
          status: 'ATTENTION_REQUIRED', launchOutcome: 'ATTENTION_REQUIRED',
          launchResultCode: 'RECOVERY_AMBIGUOUS_ORDER_INTENT',
          launchResultMessage: 'Recovery refused because multiple exact-scope OrderIntents matched.',
          launchEvidenceJson: json(evidence), dispatchCompletedAt: now,
        },
      });
      if (changed.count) await recordRecoveryEvent({ type: 'trading_lifecycle_exercise.dispatch_recovery_ambiguous', message: 'Ambiguous OrderIntent recovery refused.', exerciseId, target, actorUserId, code: 'RECOVERY_AMBIGUOUS_ORDER_INTENT', evidence });
      results.push({ targetId: target.id, code: 'RECOVERY_AMBIGUOUS_ORDER_INTENT', orderIntentId: null });
      continue;
    }
    if (matches.length === 1) {
      const intent = matches[0]!;
      const changed = await prisma.tradingLifecycleExerciseTarget.updateMany({
        where: { id: target.id, status: 'DISPATCHING', dispatchStartedAt: { lte: staleBefore }, ...(target.orderIntentId ? { orderIntentId: intent.id } : { orderIntentId: null }) },
        data: {
          status: 'INTENT_CREATED', orderIntentId: intent.id, launchOutcome: 'RECOVERED',
          launchResultCode: target.orderIntentId ? 'RECOVERED_LINKED_ORDER_INTENT' : 'RECOVERED_DISCOVERED_ORDER_INTENT',
          launchResultMessage: 'Existing exact-scope OrderIntent recovered without redispatch.',
          launchEvidenceJson: json({ clientOrderId, orderIntentStatus: intent.status, recovered: true }),
          dispatchCompletedAt: now, intentCreatedAt: now,
        },
      });
      const code = target.orderIntentId ? 'RECOVERED_LINKED_ORDER_INTENT' : 'RECOVERED_DISCOVERED_ORDER_INTENT';
      if (changed.count) await recordRecoveryEvent({ type: 'trading_lifecycle_exercise.dispatch_order_intent_recovered', message: 'Existing OrderIntent recovered and linked without redispatch.', exerciseId, target, actorUserId, code, orderIntentId: intent.id, evidence: { clientOrderId } });
      results.push({ targetId: target.id, code, orderIntentId: intent.id });
      continue;
    }
    const reclaimed = await prisma.tradingLifecycleExerciseTarget.updateMany({
      where: { id: target.id, status: 'DISPATCHING', dispatchStartedAt: { lte: staleBefore }, orderIntentId: null },
      data: { dispatchStartedAt: now, launchAttemptedAt: now },
    });
    if (!reclaimed.count) continue;
    await recordRecoveryEvent({ type: 'trading_lifecycle_exercise.dispatch_target_reclaimed', message: 'Stale target safely reclaimed for exact-assignment dispatch.', exerciseId, target, actorUserId, code: 'STALE_TARGET_RECLAIMED', evidence: { clientOrderId } });
    const result = await processEntryForAccountSubscription({
      tradingAccountSubscriptionId: target.tradingAccountSubscriptionId,
      source: 'LIFECYCLE_EXERCISE_RECOVERY', idempotencyKey: identity,
      signal: { signalType: 'entry', source: 'LIFECYCLE_EXERCISE_RECOVERY', reason: exercise.reason, metadata: { exerciseId, targetId: target.id, recovery: true } },
    });
    await prisma.tradingLifecycleExerciseTarget.update({
      where: { id: target.id },
      data: {
        status: result.outcome === 'INTENT_CREATED' ? 'INTENT_CREATED' : result.outcome === 'DUPLICATE' ? 'DUPLICATE' : result.outcome === 'BLOCKED' ? 'BLOCKED' : 'FAILED',
        orderIntentId: result.orderIntentId, launchOutcome: launchOutcome(result.outcome),
        launchResultCode: result.code, launchResultMessage: result.message,
        launchEvidenceJson: json({ source: 'RECOVERY', clientOrderId, outcome: result.outcome, code: result.code }),
        dispatchCompletedAt: now, intentCreatedAt: result.orderIntentId ? now : null,
      },
    });
    await recordRecoveryEvent({ type: 'trading_lifecycle_exercise.dispatch_recovery_completed', message: result.message, exerciseId, target, actorUserId, code: result.code, orderIntentId: result.orderIntentId, evidence: { clientOrderId, outcome: result.outcome } });
    results.push({ targetId: target.id, code: result.code, orderIntentId: result.orderIntentId });
  }
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.dispatch_recovery_completed', entityType: 'tradingLifecycleExercise',
    entityId: exerciseId, actorUserId, message: `Dispatch recovery completed for lifecycle exercise ${exerciseId}.`,
    payloadJson: json({ exerciseId, environment: exercise.environment, staleBefore: staleBefore.toISOString(), results }),
  });
  return { exercise: await getExerciseOrThrow(exerciseId), recovery: { staleBefore, results } };
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
  const target = await prisma.tradingLifecycleExerciseTarget.findFirst({
    where: { id: targetId, exerciseId },
    include: { exercise: true, orderIntent: { include: { trackedPosition: true, brokerOrders: true } } },
  });
  if (!target) throw new HttpError(404, 'Lifecycle exercise target not found.');
  const result = await reconcileTradingAccountWithLock(target.tradingAccountId, { persistEvents: false, persistAttention: false });
  const summary = { runIdentifier: result.runIdentifier, clean: result.findings.length === 0, findingCount: result.findings.length, findings: result.findings.map(({ code, severity, entityType, entityId, symbol, message }) => ({ code, severity, entityType, entityId, symbol, message })) };
  const position = target.orderIntent?.trackedPosition;
  const terminalWithoutPosition = Boolean(
    target.orderIntent
    && ['failed', 'blocked', 'rejected', 'canceled', 'cancelled'].includes(target.orderIntent.status.toLowerCase())
    && target.orderIntent.brokerOrders.every((order) => isTerminalBrokerOrderStatus(order.status))
  );
  const lifecycleTerminal = position?.status === 'closed' || terminalWithoutPosition;
  const reconciled = summary.clean && lifecycleTerminal;
  await prisma.tradingLifecycleExerciseTarget.update({
    where: { id: target.id },
    data: {
      reconciledAt: new Date(),
      reconciliationSummaryJson: json({ ...summary, lifecycleTerminal }),
      status: reconciled ? 'RECONCILED' : summary.clean ? target.status : 'ATTENTION_REQUIRED',
    },
  });
  const remainingTargets = await prisma.tradingLifecycleExerciseTarget.count({
    where: { exerciseId, status: { notIn: ['RECONCILED', 'CANCELLED'] } },
  });
  await prisma.tradingLifecycleExercise.update({
    where: { id: exerciseId },
    data: remainingTargets === 0
      ? { status: 'COMPLETED', completedAt: new Date() }
      : (!summary.clean ? { status: 'ATTENTION_REQUIRED' } : {}),
  });
  await createSystemEvent({
    type: 'trading_lifecycle_exercise.reconciled', entityType: 'tradingLifecycleExerciseTarget',
    entityId: target.id, tradingAccountId: target.tradingAccountId, actorUserId,
    message: reconciled ? 'Lifecycle exercise target reconciliation is clean and lifecycle-terminal.' : summary.clean ? 'Reconciliation is clean; lifecycle work remains active.' : 'Lifecycle exercise target reconciliation requires attention.',
    payloadJson: json({ exerciseId, targetId, tradingAccountId: target.tradingAccountId, environment: 'PAPER', clean: summary.clean, lifecycleTerminal, reconciled, findingCount: summary.findingCount }),
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
