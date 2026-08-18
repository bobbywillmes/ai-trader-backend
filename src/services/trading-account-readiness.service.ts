import { createHash, randomUUID } from 'node:crypto';
import {
  BrokerCredentialStatus,
  Prisma,
  TradingAccountEnvironment,
  TradingAccountReadinessPurpose,
  TradingAccountReadinessResult,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { NONTERMINAL_BROKER_ORDER_PRISMA_FILTER } from './broker-order-lifecycle-status.service.js';
import { recordAccountSnapshot } from './account-snapshot.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { reconcileSnapshots } from './reconciliation.service.js';
import { listTradingAccountWorkerHealth } from './trading-account-worker-health.service.js';
import { getLiveWriteApprovalState } from './live-write-approval.service.js';
import {
  ACCOUNT_WORKFLOW_LOCK_FAMILIES,
  withTradingAccountWorkflowLock,
} from './trading-account-workflow-lock.service.js';

export const READINESS_ASSESSMENT_VERSION = 1;
export const LIVE_ENTRY_ARMING_READINESS_VERSION = 2;
export const LIVE_ACTIVATION_ASSESSMENT_LIFETIME_MS = 5 * 60_000;
export const LIVE_ENTRY_ARMING_ASSESSMENT_LIFETIME_MS = 15 * 60_000;
export const CREDENTIAL_VERIFICATION_MAX_AGE_MS = 15 * 60_000;
export const READINESS_HISTORY_MAX_LIMIT = 100;

export type ReadinessGateOutcome =
  'PASSED' | 'BLOCKED' | 'WARNING' | 'NOT_APPLICABLE';
export type ReadinessStageKey =
  | 'CREDENTIALS_CONFIGURED'
  | 'CREDENTIALS_VERIFIED'
  | 'READ_ONLY_READY'
  | 'CONFIGURATION_READY'
  | 'RISK_REDUCING_READY'
  | 'ACTIVATION_READY'
  | 'LIVE_ENTRY_ARMING_READY'
  | 'ENTRY_READY';
export type ReadinessGate = {
  code: string;
  outcome: ReadinessGateOutcome;
  message: string;
  evidence?: Record<string, unknown>;
};
export type ReadinessStage = {
  key: ReadinessStageKey;
  outcome: ReadinessGateOutcome;
  summary: string;
  gates: ReadinessGate[];
  blockerCount: number;
  warningCount: number;
};

const CONFIGURATION_SELECT = {
  id: true,
  broker: true,
  environment: true,
  baseCurrency: true,
  status: true,
  tradingEnabled: true,
  killSwitchEnabled: true,
  activeLiveEntryArmingId: true,
  maxDeployableNotional: true,
  brokerAccountId: true,
  riskSettings: true,
  allocations: { orderBy: { id: 'asc' as const } },
  accountSubscriptions: {
    orderBy: { id: 'asc' as const },
    include: {
      subscription: {
        include: { security: true, strategy: true, exitProfile: true },
      },
      allocation: true,
    },
  },
} satisfies Prisma.TradingAccountSelect;

const CREDENTIAL_SELECT = {
  id: true,
  authType: true,
  status: true,
  keyFingerprint: true,
  encryptionVersion: true,
  verifiedAt: true,
  revokedAt: true,
  updatedAt: true,
  apiKeyCiphertext: true,
  apiSecretCiphertext: true,
  accessTokenCiphertext: true,
  refreshTokenCiphertext: true,
} satisfies Prisma.TradingAccountCredentialSelect;

type ReadinessDbClient = Prisma.TransactionClient | typeof prisma;

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function readinessFingerprint(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function withoutAuditTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAuditTimestamps);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'createdAt' && key !== 'updatedAt')
        .map(([key, child]) => [key, withoutAuditTimestamps(child)]),
    );
  }
  return value;
}

function safeCredentialMetadata(
  credential: Awaited<ReturnType<typeof loadCredential>>,
) {
  if (!credential) return null;
  return {
    id: credential.id,
    authType: credential.authType,
    status: credential.status,
    keyFingerprint: credential.keyFingerprint,
    encryptionVersion: credential.encryptionVersion,
    verifiedAt: credential.verifiedAt,
    revokedAt: credential.revokedAt,
    updatedAt: credential.updatedAt,
  };
}

async function loadConfiguration(
  tradingAccountId: number,
  db: ReadinessDbClient = prisma,
) {
  return db.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: CONFIGURATION_SELECT,
  });
}

async function loadCredential(
  tradingAccountId: number,
  db: ReadinessDbClient = prisma,
) {
  return db.tradingAccountCredential.findUnique({
    where: { tradingAccountId },
    select: CREDENTIAL_SELECT,
  });
}

export async function computeReadinessFingerprints(
  tradingAccountId: number,
  db: ReadinessDbClient = prisma,
) {
  const [configuration, credential] = await Promise.all([
    loadConfiguration(tradingAccountId, db),
    loadCredential(tradingAccountId, db),
  ]);
  if (!configuration) return null;
  return {
    configurationFingerprint: readinessFingerprint(
      withoutAuditTimestamps(configuration),
    ),
    credentialFingerprint: readinessFingerprint(
      safeCredentialMetadata(credential),
    ),
    policyFingerprint: readinessFingerprint({
      ALLOW_LIVE_RISK_REDUCING_WRITES: env.ALLOW_LIVE_RISK_REDUCING_WRITES,
      ALLOW_LIVE_TRADING: env.ALLOW_LIVE_TRADING,
      LIVE_WRITE_DEPLOYMENT_ROLE: env.LIVE_WRITE_DEPLOYMENT_ROLE,
    }),
  };
}

function gate(
  code: string,
  passed: boolean,
  passMessage: string,
  blockMessage: string,
  evidence?: Record<string, unknown>,
): ReadinessGate {
  return {
    code,
    outcome: passed ? 'PASSED' : 'BLOCKED',
    message: passed ? passMessage : blockMessage,
    ...(evidence ? { evidence } : {}),
  };
}

export function isCredentialVerificationCurrent(
  verifiedAt: Date | null | undefined,
  now = new Date(),
) {
  return Boolean(
    verifiedAt &&
    now.getTime() - verifiedAt.getTime() <= CREDENTIAL_VERIFICATION_MAX_AGE_MS,
  );
}

export function readinessAssessmentLifetimeMs(
  purpose: TradingAccountReadinessPurpose,
) {
  return purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING
    ? LIVE_ENTRY_ARMING_ASSESSMENT_LIFETIME_MS
    : LIVE_ACTIVATION_ASSESSMENT_LIFETIME_MS;
}

const LIVE_ENTRY_ARMING_ALWAYS_APPLICABLE_WORKERS = new Set([
  'broker_activity_sync',
  'tracked_position_sync',
  'account_snapshot_scheduler',
]);

const LIVE_ENTRY_ARMING_WORK_DEPENDENT_WORKERS = new Set([
  'pending_order_processing',
  'submitted_order_sync',
  'exit_evaluation',
]);

export type LiveEntryArmingWorkerEvidence = {
  workerKey: string;
  applicable: boolean;
  status: string;
  eligibilityReason?: string | null;
};

export function liveEntryArmingWorkerGate(
  workerKey: string,
  row: LiveEntryArmingWorkerEvidence | undefined,
) {
  const healthy = Boolean(row?.applicable && row.status === 'HEALTHY');
  const safelyDormant = Boolean(
    row &&
    LIVE_ENTRY_ARMING_WORK_DEPENDENT_WORKERS.has(workerKey) &&
    !row.applicable &&
    row.status === 'DORMANT' &&
    row.eligibilityReason === 'no_work_for_workflow'
  );
  const passed = healthy || safelyDormant;
  const requirement = LIVE_ENTRY_ARMING_ALWAYS_APPLICABLE_WORKERS.has(workerKey)
    ? `${workerKey} must be applicable and healthy.`
    : `${workerKey} must be healthy when applicable or dormant because no work exists.`;
  return gate(
    `ARMING_WORKER_${workerKey.toUpperCase()}`,
    passed,
    safelyDormant
      ? `${workerKey} is safely dormant because no account work exists.`
      : `${workerKey} is applicable and healthy.`,
    requirement,
    row ? {
      applicable: row.applicable,
      status: row.status,
      eligibilityReason: row.eligibilityReason ?? null,
    } : undefined,
  );
}

export function liveEntryArmingRiskReducingPrerequisitesPassed(
  gates: readonly ReadinessGate[],
) {
  const expectedAuthorizationBlockers = new Set([
    'ARMING_RISK_REDUCING_APPROVAL',
    'ARMING_ENTRY_APPROVAL_CURRENT',
  ]);
  return gates.every(
    (item) =>
      item.outcome === 'PASSED' ||
      (item.outcome === 'BLOCKED' &&
        expectedAuthorizationBlockers.has(item.code)),
  );
}

function stage(
  key: ReadinessStageKey,
  gates: ReadinessGate[],
  summary: string,
): ReadinessStage {
  const blockerCount = gates.filter(
    (item) => item.outcome === 'BLOCKED',
  ).length;
  const warningCount = gates.filter(
    (item) => item.outcome === 'WARNING',
  ).length;
  const applicable = gates.filter((item) => item.outcome !== 'NOT_APPLICABLE');
  const outcome: ReadinessGateOutcome = blockerCount
    ? 'BLOCKED'
    : warningCount
      ? 'WARNING'
      : applicable.length
        ? 'PASSED'
        : 'NOT_APPLICABLE';
  return { key, outcome, summary, gates, blockerCount, warningCount };
}

function configurationGates(
  account: NonNullable<Awaited<ReturnType<typeof loadConfiguration>>>,
) {
  const enabledAllocations = account.allocations.filter((item) => item.enabled);
  const enabledAssignments = account.accountSubscriptions.filter(
    (item) => item.enabled,
  );
  const allocationTotal = enabledAllocations.reduce(
    (sum, item) => sum + (item.maxAllocatedNotional ?? 0),
    0,
  );
  const assignmentOwnershipValid = enabledAssignments.every(
    (item) =>
      item.allocation === null ||
      item.allocation.tradingAccountId === account.id,
  );
  const reservationsValid = enabledAssignments.every((item) => {
    if (
      !item.allocation ||
      item.reservedNotional === null ||
      item.reservedNotional <= 0
    )
      return false;
    return (
      item.allocation.maxAllocatedNotional !== null &&
      item.reservedNotional <= item.allocation.maxAllocatedNotional
    );
  });
  const sizingValid = enabledAssignments.every((item) =>
    item.sizingType === 'FIXED_QTY'
      ? item.fixedQty !== null && item.fixedQty > 0
      : item.maxPositionNotional !== null && item.maxPositionNotional > 0,
  );
  const catalogEnabled = enabledAssignments.every(
    (item) =>
      item.subscription.enabled &&
      item.subscription.security.enabled &&
      item.subscription.strategy.enabled &&
      item.subscription.exitProfile.enabled,
  );
  return [
    gate(
      'MAX_DEPLOYABLE_NOTIONAL_CONFIGURED',
      account.maxDeployableNotional !== null &&
        account.maxDeployableNotional > 0,
      'Account deployment ceiling is positive.',
      'A positive maxDeployableNotional is required.',
    ),
    gate(
      'RISK_SETTINGS_CONFIGURED',
      Boolean(account.riskSettings?.enabled),
      'Account risk settings are enabled.',
      'Enabled account risk settings are required.',
    ),
    gate(
      'RISK_LIMITS_CONFIGURED',
      Boolean(
        account.riskSettings &&
        [
          account.riskSettings.maxDailyEntryOrders,
          account.riskSettings.maxDailyEntryNotional,
          account.riskSettings.maxOpenPositions,
          account.riskSettings.maxSymbolOpenNotional,
        ].every((value) => value !== null && value > 0),
      ),
      'Required risk limits are positive.',
      'Required risk limits are missing or invalid.',
    ),
    gate(
      'ENABLED_ALLOCATION_PRESENT',
      enabledAllocations.length > 0,
      'At least one enabled allocation is provisioned.',
      'An enabled allocation is required.',
    ),
    gate(
      'ALLOCATION_LIMITS_VALID',
      enabledAllocations.length > 0 &&
        enabledAllocations.every(
          (item) =>
            item.maxAllocatedNotional !== null && item.maxAllocatedNotional > 0,
        ),
      'Enabled allocation limits are positive.',
      'Enabled allocations require positive limits.',
    ),
    gate(
      'ALLOCATION_TOTAL_WITHIN_ACCOUNT',
      account.maxDeployableNotional !== null &&
        allocationTotal <= account.maxDeployableNotional,
      'Allocation total fits within the account ceiling.',
      'Allocation total exceeds or cannot be compared with the account ceiling.',
      { allocationTotal, accountCeiling: account.maxDeployableNotional },
    ),
    gate(
      'ENABLED_ASSIGNMENT_PRESENT',
      enabledAssignments.length > 0,
      'At least one enabled assignment is provisioned.',
      'An enabled account subscription is required.',
    ),
    gate(
      'ASSIGNMENT_ALLOCATION_OWNERSHIP_VALID',
      assignmentOwnershipValid,
      'Assignment allocation ownership is valid.',
      'An assignment references an invalid allocation owner.',
    ),
    gate(
      'ASSIGNMENT_RESERVATIONS_VALID',
      enabledAssignments.length > 0 && reservationsValid,
      'Assignment reservations fit allocation limits.',
      'Assignment reservations are missing or invalid.',
    ),
    gate(
      'ASSIGNMENT_SIZING_VALID',
      enabledAssignments.length > 0 && sizingValid,
      'Assignment sizing is valid.',
      'Enabled assignments require valid sizing.',
    ),
    gate(
      'CATALOG_RECORDS_ENABLED',
      enabledAssignments.length > 0 && catalogEnabled,
      'Relevant catalog records are enabled.',
      'A relevant subscription, security, strategy, or exit profile is disabled.',
    ),
    gate(
      'ACTIVATION_ENTRIES_DISARMED',
      enabledAssignments.length > 0 &&
        enabledAssignments.every((item) => !item.entriesEnabled),
      'All provisioned assignments have entries disabled.',
      'Live activation requires entriesEnabled=false for every provisioned assignment.',
    ),
    gate(
      'ACTIVATION_EXITS_ENABLED',
      enabledAssignments.length > 0 &&
        enabledAssignments.every((item) => item.exitsEnabled),
      'All provisioned assignments can manage exits.',
      'Provisioned assignments must have exitsEnabled=true.',
    ),
  ];
}

function mapAssessment(
  record: Prisma.TradingAccountReadinessAssessmentGetPayload<{}>,
  fingerprints: Awaited<ReturnType<typeof computeReadinessFingerprints>>,
  now = new Date(),
) {
  const { validity, staleReasons } = deriveReadinessValidity(
    record,
    fingerprints,
    now,
  );
  return {
    ...record,
    stages: record.stageResultsJson,
    gates: record.gateResultsJson,
    blockers: record.blockersJson,
    warnings: record.warningsJson,
    evidence: record.evidenceJson,
    reconciliationSummary: record.reconciliationSummaryJson,
    validity,
    staleReasons,
  };
}

export function deriveReadinessValidity(
  input: {
    expiresAt: Date;
    configurationFingerprint: string;
    credentialFingerprint: string;
    policyFingerprint: string;
  },
  current: {
    configurationFingerprint: string;
    credentialFingerprint: string;
    policyFingerprint: string;
  } | null,
  now = new Date(),
) {
  const staleReasons: string[] = [];
  if (current) {
    if (input.configurationFingerprint !== current.configurationFingerprint)
      staleReasons.push('CONFIGURATION_CHANGED');
    if (input.credentialFingerprint !== current.credentialFingerprint)
      staleReasons.push('CREDENTIAL_CHANGED');
    if (input.policyFingerprint !== current.policyFingerprint)
      staleReasons.push('POLICY_CHANGED');
  }
  return {
    validity:
      input.expiresAt <= now
        ? ('EXPIRED' as const)
        : staleReasons.length
          ? ('STALE' as const)
          : ('CURRENT' as const),
    staleReasons,
  };
}

const BLOCKING_ACCOUNT_WORKER_STATUSES = new Set([
  'FAILING',
  'STALE',
  'BACKING_OFF',
  'DEGRADED',
]);

export function blockingAccountWorkers<
  T extends {
    applicable: boolean;
    status: string;
  },
>(workers: readonly T[]): T[] {
  return workers.filter(
    (worker) =>
      worker.applicable && BLOCKING_ACCOUNT_WORKER_STATUSES.has(worker.status),
  );
}

async function gatherAndPersist(
  tradingAccountId: number,
  requestedByUserId: number,
  purpose: TradingAccountReadinessPurpose,
) {
  const startedAt = new Date();
  const [account, credential] = await Promise.all([
    loadConfiguration(tradingAccountId),
    loadCredential(tradingAccountId),
  ]);
  if (!account) throw new HttpError(404, 'Trading account not found.');
  const fingerprints = (await computeReadinessFingerprints(tradingAccountId))!;
  const encryptedFieldsPresent =
    credential?.authType === 'API_KEY'
      ? Boolean(credential.apiKeyCiphertext && credential.apiSecretCiphertext)
      : Boolean(credential?.accessTokenCiphertext);
  const credentialUsable = Boolean(
    credential &&
    encryptedFieldsPresent &&
    credential.status === BrokerCredentialStatus.ACTIVE &&
    !credential.revokedAt &&
    credential.keyFingerprint,
  );
  const verifiedFresh = credentialUsable &&
    isCredentialVerificationCurrent(credential?.verifiedAt, startedAt);

  const [
    localOpenPositionCount,
    localClosingPositionCount,
    localNonterminalIntentCount,
    localNonterminalOrderCount,
    attentionCount,
    missingAttributionCount,
    unresolvedBrokerActivityCount,
    workerHealth,
  ] = await Promise.all([
    prisma.trackedPosition.count({
      where: { tradingAccountId, status: 'open' },
    }),
    prisma.trackedPosition.count({
      where: { tradingAccountId, status: 'closing' },
    }),
    prisma.orderIntent.count({
      where: {
        tradingAccountId,
        status: { in: ['received', 'pending', 'submitting', 'submitted'] },
      },
    }),
    prisma.brokerOrder.count({
      where: {
        tradingAccountId,
        status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
      },
    }),
    prisma.positionExitState.count({
      where: { attentionRequired: true, trackedPosition: { tradingAccountId } },
    }),
    prisma.trackedPosition.count({
      where: {
        tradingAccountId,
        status: { in: ['open', 'closing'] },
        tradingAccountSubscriptionId: null,
      },
    }),
    prisma.brokerActivity.count({
      where: {
        tradingAccountId,
        OR: [{ trackedPositionId: null }, { brokerOrderRecordId: null }],
      },
    }),
    listTradingAccountWorkerHealth(tradingAccountId),
  ]);

  let snapshotId: number | null = null;
  let brokerAccountStatus: string | null = null;
  let tradingBlocked: boolean | null = null;
  let brokerAccountId: string | null = null;
  let brokerCurrency: string | null = null;
  let brokerPositions: Awaited<ReturnType<typeof getNormalizedPositions>> = [];
  let brokerOrders: Awaited<ReturnType<typeof getOpenAlpacaOrders>> = [];
  let brokerError: string | null = null;
  if (credentialUsable) {
    try {
      const [snapshotResult, positions, orders] = await Promise.all([
        recordAccountSnapshot(tradingAccountId, {
          reason: 'readiness_assessment',
          force: true,
          runKey: `readiness:${tradingAccountId}:${randomUUID()}`,
          sourceEntityType: 'TradingAccountReadinessAssessment',
        }),
        getNormalizedPositions(tradingAccountId, 'reconciliation_check'),
        getOpenAlpacaOrders(tradingAccountId, 'reconciliation_check'),
      ]);
      snapshotId = snapshotResult.snapshot.id;
      brokerAccountStatus = snapshotResult.snapshot.accountStatus;
      tradingBlocked = snapshotResult.snapshot.tradingBlocked;
      brokerAccountId = snapshotResult.snapshot.accountNumber;
      brokerCurrency = snapshotResult.snapshot.currency;
      brokerPositions = positions;
      brokerOrders = orders;
      const conflictingIdentity = brokerAccountId
        ? await prisma.tradingAccount.findFirst({
            where: {
              id: { not: tradingAccountId },
              broker: account.broker,
              environment: account.environment,
              brokerAccountId,
            },
            select: { id: true },
          })
        : null;
      if (conflictingIdentity) {
        brokerError = `Broker account identity conflicts with TradingAccount ${conflictingIdentity.id}.`;
      }
    } catch (error) {
      brokerError =
        error instanceof Error
          ? error.message.slice(0, 300)
          : 'Broker read failed.';
    }
  }
  const localTracked = await prisma.trackedPosition.findMany({
    where: { tradingAccountId, status: { in: ['open', 'closing'] } },
    include: { exitState: true },
  });
  const localOrders = await prisma.brokerOrder.findMany({
    where: { tradingAccountId, status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER },
  });
  const findings =
    credentialUsable && !brokerError
      ? reconcileSnapshots({
          trackedPositions: localTracked,
          brokerPositions,
          brokerOrders,
          localOrders: localOrders.map((item) => ({
            broker: item.broker,
            id: item.brokerOrderId,
            clientOrderId: item.clientOrderId,
            symbol: item.symbol,
            side: item.side,
            status: item.status,
          })),
        })
      : [];
  const workerBlockers = blockingAccountWorkers(workerHealth?.workers ?? []);

  const credentialsConfigured = [
    gate(
      'CREDENTIAL_ROW_PRESENT',
      Boolean(credential),
      'Credential record exists.',
      'Credential record is missing.',
    ),
    gate(
      'CREDENTIAL_FIELDS_PRESENT',
      encryptedFieldsPresent,
      'Required encrypted credential fields exist.',
      'Required encrypted credential fields are missing.',
    ),
    gate(
      'CREDENTIAL_STATUS_USABLE',
      credential?.status === BrokerCredentialStatus.ACTIVE,
      'Credential status is ACTIVE.',
      'Credential status is not ACTIVE.',
    ),
    gate(
      'CREDENTIAL_NOT_REVOKED',
      Boolean(credential && !credential.revokedAt),
      'Credential is not revoked.',
      'Credential is missing or revoked.',
    ),
    gate(
      'CREDENTIAL_KEY_FINGERPRINT_PRESENT',
      Boolean(credential?.keyFingerprint),
      'Credential key fingerprint exists.',
      'Credential key fingerprint is missing.',
    ),
  ];
  const credentialsVerified = [
    gate(
      'CREDENTIAL_VERIFICATION_CURRENT',
      verifiedFresh,
      'Explicit credential verification is current.',
      'Credential verification is missing or older than 15 minutes.',
      { verifiedAt: credential?.verifiedAt?.toISOString() ?? null },
    ),
  ];
  const identityGates = [
    gate(
      'ACCOUNT_ENVIRONMENT_LIVE',
      account.environment === TradingAccountEnvironment.LIVE,
      'Account environment is LIVE.',
      'Account environment must be LIVE.',
    ),
    gate(
      'BROKER_ALPACA',
      account.broker === 'ALPACA',
      'Broker is Alpaca.',
      'Broker must be Alpaca.',
    ),
    gate(
      'BASE_CURRENCY_USD',
      account.baseCurrency === 'USD',
      'Base currency is USD.',
      'Base currency must be USD.',
    ),
    gate(
      'OPERATIONAL_POSTURE_VALID',
      !account.tradingEnabled && account.killSwitchEnabled,
      'Account is entry-disarmed with the kill switch enabled.',
      'Activation assessment requires trading disabled and the kill switch enabled.',
    ),
    gate(
      'ACTIVATION_STARTING_STATUS_PAUSED',
      account.status === 'PAUSED',
      'Account is PAUSED before first activation.',
      'First activation requires PAUSED account status.',
    ),
  ];
  const lifecycleGates = [
    gate(
      'LOCAL_OPEN_POSITIONS_EMPTY',
      localOpenPositionCount === 0,
      'No local open positions.',
      'Local open positions require resolution.',
      { count: localOpenPositionCount },
    ),
    gate(
      'LOCAL_CLOSING_POSITIONS_EMPTY',
      localClosingPositionCount === 0,
      'No local closing positions.',
      'Local closing positions require resolution.',
      { count: localClosingPositionCount },
    ),
    gate(
      'LOCAL_NONTERMINAL_INTENTS_EMPTY',
      localNonterminalIntentCount === 0,
      'No local nonterminal intents.',
      'Local nonterminal intents require resolution.',
      { count: localNonterminalIntentCount },
    ),
    gate(
      'LOCAL_NONTERMINAL_ORDERS_EMPTY',
      localNonterminalOrderCount === 0,
      'No local nonterminal orders.',
      'Local nonterminal orders require resolution.',
      { count: localNonterminalOrderCount },
    ),
    gate(
      'EXIT_ATTENTION_EMPTY',
      attentionCount === 0,
      'No position exit attention is unresolved.',
      'Position exit attention requires resolution.',
      { count: attentionCount },
    ),
    gate(
      'LIFECYCLE_ATTRIBUTION_COMPLETE',
      missingAttributionCount === 0,
      'Active lifecycle attribution is complete.',
      'Active lifecycle rows have missing attribution.',
      { count: missingAttributionCount },
    ),
  ];
  const brokerGates = [
    gate(
      'BROKER_READ_SUCCEEDED',
      credentialUsable && !brokerError,
      'Read-only broker probe succeeded.',
      credentialUsable
        ? 'Read-only broker probe failed.'
        : 'Broker probe was not attempted without usable credentials.',
    ),
    gate(
      'BROKER_ACCOUNT_ID_MATCH',
      Boolean(
        !brokerError &&
        brokerAccountId &&
        (!account.brokerAccountId ||
          account.brokerAccountId === brokerAccountId),
      ),
      'Broker account identity matches.',
      'Broker account identity is unavailable or conflicts.',
      {
        storedBrokerAccountId: account.brokerAccountId,
        observedBrokerAccountId: brokerAccountId,
      },
    ),
    gate(
      'BROKER_ACCOUNT_STATUS_ACCEPTABLE',
      Boolean(
        brokerAccountStatus &&
        ['ACTIVE'].includes(brokerAccountStatus.toUpperCase()),
      ),
      'Broker account status is acceptable.',
      'Broker account status is unavailable or not active.',
    ),
    gate(
      'BROKER_TRADING_NOT_BLOCKED',
      tradingBlocked === false,
      'Broker reports trading is not blocked.',
      'Broker trading is blocked or unavailable.',
    ),
    gate(
      'BROKER_CURRENCY_USD',
      brokerCurrency === 'USD',
      'Broker currency is USD.',
      'Broker currency is unavailable or not USD.',
    ),
    gate(
      'BROKER_POSITIONS_EMPTY',
      credentialUsable && !brokerError && brokerPositions.length === 0,
      'Broker positions are empty.',
      'Broker positions are present or could not be observed.',
      {
        count: credentialUsable && !brokerError ? brokerPositions.length : null,
      },
    ),
    gate(
      'BROKER_OPEN_ORDERS_EMPTY',
      credentialUsable && !brokerError && brokerOrders.length === 0,
      'Broker open orders are empty.',
      'Broker open orders are present or could not be observed.',
      { count: credentialUsable && !brokerError ? brokerOrders.length : null },
    ),
  ];
  const workerGates = [
    gate(
      'ACCOUNT_WORKERS_HEALTHY',
      workerBlockers.length === 0,
      'Applicable account workers have no blocking health state.',
      'One or more applicable account workers is failing, stale, backing off, or degraded.',
      {
        blockingWorkers: workerBlockers.map((item) => ({
          workerKey: item.workerKey,
          status: item.status,
        })),
      },
    ),
  ];
  const activationConfigGates = configurationGates(account);
  const enabledEntryAssignments = account.accountSubscriptions.filter(
    (item) => item.enabled && item.entriesEnabled,
  );
  const canary = enabledEntryAssignments[0] ?? null;
  const canaryGates = [
    gate('CANARY_EXACTLY_ONE_ENTRY_ASSIGNMENT', enabledEntryAssignments.length === 1,
      'Exactly one entry-enabled canary assignment is staged.',
      'Exactly one entry-enabled assignment is required.', { count: enabledEntryAssignments.length }),
    gate('CANARY_RSP_DIP_CORE', canary?.subscription.key === 'rsp_dip_core' && canary.subscription.symbol === 'RSP' && canary.subscription.security.symbol === 'RSP',
      'The rsp_dip_core RSP canary is selected.', 'The selected canary must be rsp_dip_core for RSP.'),
    gate('CANARY_ENABLED_WITH_EXITS', Boolean(canary?.enabled && canary.entriesEnabled && canary.exitsEnabled),
      'The canary is enabled for entries and exits.', 'The canary must be enabled with entriesEnabled=true and exitsEnabled=true.'),
    gate('CANARY_CATALOG_ENABLED', Boolean(canary?.subscription.enabled && canary.subscription.security.enabled && canary.subscription.strategy.enabled && canary.subscription.exitProfile.enabled),
      'The canary catalog hierarchy is enabled.', 'The canary subscription, security, strategy, and exit profile must be enabled.'),
    gate('CANARY_CORE_ETF_ALLOCATION', canary?.allocation?.key === 'core_etf' && canary.allocation.enabled,
      'The canary uses the enabled core_etf allocation.', 'The canary must use the enabled core_etf allocation.'),
    gate('CANARY_MAX_NOTIONAL_SIZING', canary?.sizingType === 'MAX_NOTIONAL' && Number(canary.maxPositionNotional) === 1_000,
      'The canary uses $1,000 MAX_NOTIONAL sizing.', 'The canary must use MAX_NOTIONAL sizing capped at $1,000.'),
    gate('CANARY_RESERVATION_LIMIT', Number(canary?.reservedNotional) === 1_000 && Number(canary?.allocation?.maxAllocatedNotional) === 1_000,
      'The canary reservation and allocation ceiling are $1,000.', 'The canary reservation and allocation ceiling must be $1,000.'),
    gate('CANARY_ACCOUNT_RISK_LIMITS', Boolean(account.riskSettings?.enabled && account.riskSettings.maxDailyEntryOrders === 1 && Number(account.riskSettings.maxDailyEntryNotional) === 1_000 && account.riskSettings.maxOpenPositions === 1 && Number(account.riskSettings.maxSymbolOpenNotional) === 1_000),
      'Account first-canary risk limits are configured.', 'Account risk limits must enforce one entry, one position, and $1,000 daily/symbol ceilings.'),
  ];
  const baseConfigGates = activationConfigGates.filter((item) =>
    item.code !== 'ACTIVATION_ENTRIES_DISARMED' && item.code !== 'ACTIVATION_EXITS_ENABLED');
  const configGates = purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING
    ? [...baseConfigGates, ...canaryGates]
    : activationConfigGates;
  const configurationReady = configGates.every(
    (item) => item.outcome === 'PASSED',
  );
  const readOnlyGates = [
    ...identityGates,
    ...lifecycleGates,
    ...brokerGates,
    ...workerGates,
  ];
  const readOnlyReady = readOnlyGates.every(
    (item) => item.outcome === 'PASSED',
  );
  const approvalState = await getLiveWriteApprovalState(tradingAccountId);
  const riskReducingApproval = approvalState.capabilities.find(
    (item) => item.capability === 'RISK_REDUCING',
  )!;
  const entryApproval = approvalState.capabilities.find(
    (item) => item.capability === 'ENTRY',
  )!;
  const riskReducingGates = [
    gate(
      'RISK_REDUCING_CREDENTIALS_USABLE',
      credentialUsable,
      'Credentials are usable.',
      'Usable credentials are required.',
    ),
    gate(
      'RISK_REDUCING_READ_ONLY_READY',
      readOnlyReady,
      'Read-only posture is ready.',
      'Read-only posture is blocked.',
    ),
    gate(
      'RISK_REDUCING_CONFIGURATION_READY',
      configurationReady,
      'Configuration is ready.',
      'Configuration is blocked.',
    ),
    gate(
      'LIVE_RISK_REDUCING_POLICY_ENABLED',
      env.ALLOW_LIVE_RISK_REDUCING_WRITES,
      'Live risk-reducing environment permission is enabled.',
      'ALLOW_LIVE_RISK_REDUCING_WRITES is false.',
    ),
    gate(
      'LIVE_ENTRY_POLICY_DISABLED',
      !env.ALLOW_LIVE_TRADING,
      'Live entry environment permission remains disabled.',
      'ALLOW_LIVE_TRADING must remain false for activation readiness.',
    ),
    gate(
      'LIVE_WRITE_DEPLOYMENT_EXECUTOR',
      env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR',
      'Deployment role is PRODUCTION_EXECUTOR.',
      'LIVE_WRITE_DEPLOYMENT_ROLE must be PRODUCTION_EXECUTOR for activation readiness.',
    ),
    gate(
      'ACCOUNT_SCOPED_RISK_REDUCING_APPROVAL_CURRENT',
      riskReducingApproval.effective,
      'Account-scoped risk-reducing approval is current.',
      `Account-scoped risk-reducing approval is blocked: ${riskReducingApproval.reason ?? 'missing'}.`,
    ),
  ];
  const riskReducingReady = riskReducingGates.every(
    (item) => item.outcome === 'PASSED',
  );
  const activationGates = [
    gate(
      'ACTIVATION_CREDENTIALS_CONFIGURED',
      credentialsConfigured.every((item) => item.outcome === 'PASSED'),
      'Credentials are configured.',
      'Credential configuration is blocked.',
    ),
    gate(
      'ACTIVATION_CREDENTIALS_VERIFIED',
      verifiedFresh,
      'Credentials are recently verified.',
      'Recent explicit credential verification is required.',
    ),
    gate(
      'ACTIVATION_READ_ONLY_READY',
      readOnlyReady,
      'Read-only posture is ready.',
      'Read-only posture is blocked.',
    ),
    gate(
      'ACTIVATION_CONFIGURATION_READY',
      configurationReady,
      'Configuration is ready.',
      'Configuration is blocked.',
    ),
    gate(
      'ACTIVATION_RISK_REDUCING_READY',
      riskReducingReady,
      'Risk-reducing capability is ready.',
      'Risk-reducing capability is blocked.',
    ),
  ];
  const requiredArmingWorkers = new Set([
    'pending_order_processing', 'submitted_order_sync', 'broker_activity_sync',
    'tracked_position_sync', 'exit_evaluation', 'account_snapshot_scheduler',
  ]);
  const workerRows = workerHealth?.workers ?? [];
  const armingWorkerGates = Array.from(requiredArmingWorkers).map((workerKey) => {
    const row = workerRows.find((item) => item.workerKey === workerKey);
    return liveEntryArmingWorkerGate(workerKey, row);
  });
  const armingPrerequisiteGates = [
    ...identityGates.filter((item) => !['OPERATIONAL_POSTURE_VALID', 'ACTIVATION_STARTING_STATUS_PAUSED'].includes(item.code)),
    gate('ARMING_ACCOUNT_ACTIVE_DISARMED', account.status === 'ACTIVE' && !account.tradingEnabled && account.killSwitchEnabled,
      'Account is ACTIVE with entry latches closed.', 'Arming readiness requires ACTIVE / trading disabled / kill switch enabled.'),
    gate('ARMING_NO_ACTIVE_BINDING', account.activeLiveEntryArmingId === null,
      'No prior Live entry arming is active.', 'A prior Live entry arming must be terminated first.'),
    gate('ARMING_BROKER_IDENTITY_EXACT', Boolean(account.brokerAccountId && brokerAccountId && account.brokerAccountId === brokerAccountId),
      'Stored and observed broker identities match exactly.', 'A stored broker identity must exactly match the observed account.'),
    gate('ARMING_UNRESOLVED_BROKER_ACTIVITY_EMPTY', unresolvedBrokerActivityCount === 0,
      'No unresolved broker activity attribution exists.', 'Unresolved broker activity attribution must be resolved.', { count: unresolvedBrokerActivityCount }),
    ...lifecycleGates,
    ...brokerGates,
    ...armingWorkerGates,
    gate('ARMING_RECONCILIATION_CLEAN', credentialUsable && !brokerError && findings.length === 0,
      'Diagnostic reconciliation is clean.', 'Diagnostic reconciliation must complete without findings.'),
    ...configGates,
    gate('ARMING_NODE_ENV_PRODUCTION', env.NODE_ENV === 'production', 'Runtime is production.', 'Live entry arming requires NODE_ENV=production.'),
    gate('ARMING_DEPLOYMENT_EXECUTOR', env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR', 'Deployment role is PRODUCTION_EXECUTOR.', 'Live entry arming requires PRODUCTION_EXECUTOR.'),
    gate('ARMING_RISK_REDUCING_POLICY', env.ALLOW_LIVE_RISK_REDUCING_WRITES, 'Risk-reducing deployment permission is enabled.', 'ALLOW_LIVE_RISK_REDUCING_WRITES must be true.'),
    gate('ARMING_ENTRY_POLICY', env.ALLOW_LIVE_TRADING, 'Live entry deployment permission is enabled.', 'ALLOW_LIVE_TRADING must be true.'),
    gate('ARMING_RISK_REDUCING_APPROVAL', riskReducingApproval.effective, 'RISK_REDUCING approval is effective.', `RISK_REDUCING approval is ${riskReducingApproval.reason ?? 'missing'}.`),
    gate('ARMING_CREDENTIAL_VERIFICATION_CURRENT', verifiedFresh, 'Credential verification is current.', 'Credential verification must be less than 15 minutes old.'),
  ];
  const entryApprovalGate = gate('ARMING_ENTRY_APPROVAL_CURRENT', entryApproval.effective,
    'ENTRY approval is effective.', `ENTRY approval is ${entryApproval.reason ?? 'missing'}.`);
  const armingGates = [...armingPrerequisiteGates, entryApprovalGate];
  const entryGates = [
    gate(
      'ENTRY_ACCOUNT_ACTIVE',
      account.status === 'ACTIVE',
      'Account is ACTIVE.',
      'Account is not ACTIVE.',
    ),
    gate(
      'ENTRY_TRADING_ENABLED',
      account.tradingEnabled,
      'Account trading is enabled.',
      'Account trading is disabled.',
    ),
    gate(
      'ENTRY_KILL_SWITCH_DISABLED',
      !account.killSwitchEnabled,
      'Kill switch is disabled.',
      'Kill switch is enabled.',
    ),
    gate(
      'ENTRY_LIVE_POLICY_ENABLED',
      env.ALLOW_LIVE_TRADING,
      'Live entry policy is enabled.',
      'ALLOW_LIVE_TRADING is false.',
    ),
    gate(
      'ENTRY_RISK_REDUCING_POLICY_ENABLED',
      env.ALLOW_LIVE_RISK_REDUCING_WRITES,
      'Live risk-reducing policy is enabled.',
      'ALLOW_LIVE_RISK_REDUCING_WRITES is false.',
    ),
    gate(
      'ENTRY_ASSIGNMENTS_ENABLED',
      account.accountSubscriptions.some(
        (item) => item.enabled && item.entriesEnabled,
      ),
      'An enabled assignment allows entries.',
      'No enabled assignment allows entries.',
    ),
    gate(
      'ENTRY_CONFIGURATION_READY',
      configurationReady,
      'Configuration is ready.',
      'Configuration is blocked.',
    ),
    gate(
      'ENTRY_RISK_REDUCING_APPROVAL_CURRENT',
      riskReducingApproval.effective,
      'Risk-reducing approval is current.',
      `Risk-reducing approval is blocked: ${riskReducingApproval.reason ?? 'missing'}.`,
    ),
    gate(
      'ENTRY_ACCOUNT_APPROVAL_CURRENT',
      entryApproval.effective,
      'Entry approval is current.',
      `Entry approval is blocked: ${entryApproval.reason ?? 'missing'}.`,
    ),
  ];
  const stages = [
    stage(
      'CREDENTIALS_CONFIGURED',
      credentialsConfigured,
      'Safe credential configuration checks.',
    ),
    stage(
      'CREDENTIALS_VERIFIED',
      credentialsVerified,
      'Explicit verification freshness.',
    ),
    stage(
      'READ_ONLY_READY',
      readOnlyGates,
      'Broker and lifecycle read-only posture.',
    ),
    stage(
      'CONFIGURATION_READY',
      configGates,
      'Account risk and assignment configuration.',
    ),
    stage(
      'RISK_REDUCING_READY',
      riskReducingGates,
      'Future risk-reducing capability prerequisites.',
    ),
    stage(
      'ACTIVATION_READY',
      activationGates,
      'Capability and posture required for later activation.',
    ),
    stage(
      'ENTRY_READY',
      entryGates,
      'Informational entry posture; no entry is attempted.',
    ),
  ];
  if (purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING) {
    stages.push(stage('LIVE_ENTRY_ARMING_READY', armingGates,
      'First-Live RSP canary authorization and operational prerequisites.'));
  }
  const allGates = stages.flatMap((item) => item.gates);
  const blockers = allGates.filter((item) => item.outcome === 'BLOCKED');
  const warnings = allGates.filter((item) => item.outcome === 'WARNING');
  const activation = stages.find((item) => item.key === 'ACTIVATION_READY')!;
  const completedAt = new Date();
  const assessedStage = purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING
    ? stages.find((item) => item.key === 'LIVE_ENTRY_ARMING_READY')!
    : activation;
  const prerequisitesForEntryGrantPassed = purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING &&
    armingPrerequisiteGates.every((item) => item.outcome === 'PASSED') && !entryApproval.effective;
  const prerequisitesForRiskReducingGrantPassed =
    purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING &&
    liveEntryArmingRiskReducingPrerequisitesPassed(armingGates);
  const result =
    assessedStage.outcome === 'PASSED'
      ? TradingAccountReadinessResult.PASSED
      : TradingAccountReadinessResult.BLOCKED;
  const reconciliationSummary =
    credentialUsable && !brokerError
      ? {
          mode: 'DIAGNOSTIC_READ_ONLY',
          findingCount: findings.length,
          criticalCount: findings.filter((item) => item.severity === 'critical')
            .length,
          warningCount: findings.filter((item) => item.severity === 'warn')
            .length,
          findingCodes: findings.map((item) => item.code),
        }
      : {
          mode: 'NOT_RUN',
          reason: credentialUsable
            ? 'BROKER_READ_FAILED'
            : 'CREDENTIALS_UNAVAILABLE',
        };
  const created = await prisma.tradingAccountReadinessAssessment.create({
    data: {
      tradingAccountId,
      purpose,
      result,
      assessmentVersion: purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING
        ? LIVE_ENTRY_ARMING_READINESS_VERSION : READINESS_ASSESSMENT_VERSION,
      startedAt,
      completedAt,
      expiresAt: new Date(
        completedAt.getTime() + readinessAssessmentLifetimeMs(purpose),
      ),
      ...fingerprints,
      credentialVerifiedAt: credential?.verifiedAt ?? null,
      accountSnapshotId: snapshotId,
      brokerAccountId,
      brokerAccountStatus,
      tradingBlocked,
      brokerPositionCount:
        credentialUsable && !brokerError ? brokerPositions.length : null,
      brokerOpenOrderCount:
        credentialUsable && !brokerError ? brokerOrders.length : null,
      localOpenPositionCount,
      localClosingPositionCount,
      localNonterminalIntentCount,
      localNonterminalOrderCount,
      reconciliationSummaryJson: reconciliationSummary,
      stageResultsJson: stages as unknown as Prisma.InputJsonValue,
      gateResultsJson: allGates as unknown as Prisma.InputJsonValue,
      blockersJson: blockers as unknown as Prisma.InputJsonValue,
      warningsJson: warnings as unknown as Prisma.InputJsonValue,
      evidenceJson: {
        brokerRouting: {
          source: 'TradingAccount.environment',
          environment: account.environment,
        },
        policy: {
          allowLiveTrading: env.ALLOW_LIVE_TRADING,
          allowLiveRiskReducingWrites: env.ALLOW_LIVE_RISK_REDUCING_WRITES,
          liveWriteDeploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE,
        },
        brokerReadAttempted: credentialUsable,
        brokerError,
        workerHealth:
          workerHealth?.workers.map((item) => ({
            workerKey: item.workerKey,
            status: item.status,
            applicable: item.applicable,
            eligible: item.eligible,
            expectedIntervalMs: item.expectedIntervalMs,
          })) ?? [],
        prerequisitesForEntryGrantPassed,
        prerequisitesForRiskReducingGrantPassed,
        liveWriteApprovalRevisions: {
          riskReducing: riskReducingApproval.approval?.revision ?? null,
          entry: entryApproval.approval?.revision ?? null,
        },
        selectedCanary: canary ? {
          tradingAccountSubscriptionId: canary.id,
          subscriptionId: canary.subscriptionId,
          securityId: canary.subscription.securityId,
          symbol: canary.subscription.security.symbol,
          sizingType: canary.sizingType,
          maxPositionNotional: canary.maxPositionNotional,
          reservedNotional: canary.reservedNotional,
          accountLimits: account.riskSettings,
          allocation: canary.allocation,
        } : null,
      },
      requestedByUserId,
    },
  });
  await prisma.systemEvent.create({
    data: {
      type: 'trading_account.readiness_assessed',
      entityType: 'TradingAccountReadinessAssessment',
      entityId: String(created.id),
      tradingAccountId,
      actorUserId: requestedByUserId,
      message: `Trading account ${tradingAccountId} readiness assessed as ${result}.`,
      payloadJson: {
        assessmentId: created.id,
        tradingAccountId,
        purpose: created.purpose,
        result,
        startedAt,
        completedAt,
        expiresAt: created.expiresAt,
        stageOutcomes: Object.fromEntries(
          stages.map((item) => [item.key, item.outcome]),
        ),
        blockerCount: blockers.length,
        warningCount: warnings.length,
        fingerprintPrefixes: {
          configuration: fingerprints.configurationFingerprint.slice(0, 12),
          credential: fingerprints.credentialFingerprint.slice(0, 12),
          policy: fingerprints.policyFingerprint.slice(0, 12),
        },
        actorUserId: requestedByUserId,
      },
    },
  });
  return mapAssessment(created, fingerprints);
}

export async function runTradingAccountReadinessAssessment(
  tradingAccountId: number,
  purpose: TradingAccountReadinessPurpose,
  requestedByUserId: number,
) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { environment: true },
  });
  if (!account) throw new HttpError(404, 'Trading account not found.');
  if (
    (purpose === TradingAccountReadinessPurpose.LIVE_ACTIVATION ||
      purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING) &&
    account.environment !== TradingAccountEnvironment.LIVE
  ) {
    throw new HttpError(
      400,
      'LIVE_ACTIVATION readiness assessments require a LIVE Trading Account.',
    );
  }
  const locked = await withTradingAccountWorkflowLock({
    tradingAccountId,
    workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.READINESS_ASSESSMENT,
    processInstanceId: `manual-readiness:${requestedByUserId}`,
    execute: async () => {
      try {
        return await gatherAndPersist(tradingAccountId, requestedByUserId, purpose);
      } catch (error) {
        const startedAt = new Date();
        const completedAt = new Date();
        const safeMessage = (
          error instanceof Error ? error.message : 'Unexpected readiness error.'
        )
          .replace(
            /(api[_ -]?key|secret|token|authorization)\s*[:=]\s*\S+/gi,
            '$1=[redacted]',
          )
          .slice(0, 300);
        try {
          const fingerprints =
            await computeReadinessFingerprints(tradingAccountId);
          if (!fingerprints) throw error;
          const errorGate: ReadinessGate = {
            code: 'ASSESSMENT_UNEXPECTED_ERROR',
            outcome: 'BLOCKED',
            message: 'The readiness assessment could not complete.',
            evidence: {
              errorCode: 'READINESS_ASSESSMENT_ERROR',
              message: safeMessage,
            },
          };
          const errorStage = stage(
            'ACTIVATION_READY',
            [errorGate],
            'Assessment ended with a sanitized unexpected error.',
          );
          const created = await prisma.tradingAccountReadinessAssessment.create(
            {
              data: {
                tradingAccountId,
                purpose,
                result: TradingAccountReadinessResult.ERROR,
                assessmentVersion: purpose === TradingAccountReadinessPurpose.LIVE_ENTRY_ARMING
                  ? LIVE_ENTRY_ARMING_READINESS_VERSION
                  : READINESS_ASSESSMENT_VERSION,
                startedAt,
                completedAt,
                expiresAt: new Date(
                  completedAt.getTime() +
                    readinessAssessmentLifetimeMs(purpose),
                ),
                ...fingerprints,
                localOpenPositionCount: 0,
                localClosingPositionCount: 0,
                localNonterminalIntentCount: 0,
                localNonterminalOrderCount: 0,
                stageResultsJson: [
                  errorStage,
                ] as unknown as Prisma.InputJsonValue,
                gateResultsJson: [
                  errorGate,
                ] as unknown as Prisma.InputJsonValue,
                blockersJson: [errorGate] as unknown as Prisma.InputJsonValue,
                warningsJson: [],
                evidenceJson: {
                  partial: true,
                  errorCode: 'READINESS_ASSESSMENT_ERROR',
                  message: safeMessage,
                },
                requestedByUserId,
              },
            },
          );
          await prisma.systemEvent.create({
            data: {
              type: 'trading_account.readiness_assessed',
              entityType: 'TradingAccountReadinessAssessment',
              entityId: String(created.id),
              tradingAccountId,
              actorUserId: requestedByUserId,
              message: `Trading account ${tradingAccountId} readiness assessment ended with ERROR.`,
              payloadJson: {
                assessmentId: created.id,
                tradingAccountId,
                purpose,
                result: TradingAccountReadinessResult.ERROR,
                startedAt,
                completedAt,
                expiresAt: created.expiresAt,
                errorCode: 'READINESS_ASSESSMENT_ERROR',
              },
            },
          });
          return mapAssessment(created, fingerprints);
        } catch {
          throw error;
        }
      }
    },
  });
  if (locked.outcome === 'NOT_ACQUIRED') {
    throw new HttpError(
      409,
      'A readiness assessment is already running for this Trading Account.',
    );
  }
  if (locked.outcome === 'LOCK_ERROR') throw locked.error;
  if (locked.outcome === 'WORKFLOW_ERROR') throw locked.error;
  return locked.value;
}

export async function getTradingAccountReadinessAssessment(
  tradingAccountId: number,
  assessmentId: number,
) {
  const record = await prisma.tradingAccountReadinessAssessment.findFirst({
    where: { id: assessmentId, tradingAccountId },
  });
  return record
    ? mapAssessment(
        record,
        await computeReadinessFingerprints(tradingAccountId),
      )
    : null;
}

export async function getLatestTradingAccountReadinessAssessment(
  tradingAccountId: number,
  purpose: TradingAccountReadinessPurpose,
) {
  const record = await prisma.tradingAccountReadinessAssessment.findFirst({
    where: { tradingAccountId, purpose },
    orderBy: { completedAt: 'desc' },
  });
  return record
    ? mapAssessment(
        record,
        await computeReadinessFingerprints(tradingAccountId),
      )
    : null;
}

export async function listTradingAccountReadinessAssessments(
  tradingAccountId: number,
  purpose: TradingAccountReadinessPurpose,
  limit = 20,
) {
  const records = await prisma.tradingAccountReadinessAssessment.findMany({
    where: { tradingAccountId, purpose },
    orderBy: { completedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), READINESS_HISTORY_MAX_LIMIT),
  });
  const fingerprints = await computeReadinessFingerprints(tradingAccountId);
  return records.map((record) => mapAssessment(record, fingerprints));
}
