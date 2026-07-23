import { PositionSizingType, TradingAccountEnvironment } from '@prisma/client';

export type LegacySubscriptionMapping = {
  id: number;
  tradingAccountId: number;
  enabled: boolean;
  key: string;
};

export type MigrationDiagnosticAccount = {
  id: number;
  displayName: string;
  environment: TradingAccountEnvironment;
  maxDeployableNotional: number | null;
};

export type MigrationDiagnosticAllocation = {
  id: number;
  tradingAccountId: number;
  key: string;
  name: string;
  enabled: boolean;
  maxAllocatedNotional: number | null;
  maxOpenPositions: number | null;
  maxPositionNotional: number | null;
};

export type MigrationDiagnosticAssignment = {
  id: number;
  tradingAccountId: number;
  subscriptionId: number;
  allocationId: number | null;
  enabled: boolean;
  entriesEnabled: boolean;
  exitsEnabled: boolean;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  reservedNotional: number | null;
  subscription: {
    key: string;
    enabled: boolean;
  };
  allocation: MigrationDiagnosticAllocation | null;
};

type FailureDetails = {
  assignmentId: number;
  tradingAccountId: number;
  subscriptionId: number;
  subscriptionKey: string;
  globalCatalogEnabled: boolean;
  enabled: boolean;
  entriesEnabled: boolean;
  exitsEnabled: boolean;
  allocationId: number | null;
  allocation: MigrationDiagnosticAllocation | null;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  reservedNotional: number | null;
};

export type MigrationDiagnosticFailure = FailureDetails & {
  reasons: string[];
};

function isPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function sizingReasons(assignment: MigrationDiagnosticAssignment) {
  if (
    assignment.sizingType === PositionSizingType.FIXED_QTY &&
    !isPositive(assignment.fixedQty)
  ) {
    return ['FIXED_QTY_REQUIRES_POSITIVE_FIXED_QTY'];
  }
  if (
    assignment.sizingType === PositionSizingType.MAX_NOTIONAL &&
    !isPositive(assignment.maxPositionNotional)
  ) {
    return ['MAX_NOTIONAL_REQUIRES_POSITIVE_MAX_POSITION_NOTIONAL'];
  }
  return [];
}

function failureDetails(
  assignment: MigrationDiagnosticAssignment
): FailureDetails {
  return {
    assignmentId: assignment.id,
    tradingAccountId: assignment.tradingAccountId,
    subscriptionId: assignment.subscriptionId,
    subscriptionKey: assignment.subscription.key,
    globalCatalogEnabled: assignment.subscription.enabled,
    enabled: assignment.enabled,
    entriesEnabled: assignment.entriesEnabled,
    exitsEnabled: assignment.exitsEnabled,
    allocationId: assignment.allocationId,
    allocation: assignment.allocation,
    sizingType: assignment.sizingType,
    fixedQty: assignment.fixedQty,
    maxPositionNotional: assignment.maxPositionNotional,
    reservedNotional: assignment.reservedNotional,
  };
}

export function buildSubscriptionCatalogMigrationDiagnostic(input: {
  accounts: MigrationDiagnosticAccount[];
  legacySubscriptions: LegacySubscriptionMapping[];
  assignments: MigrationDiagnosticAssignment[];
}) {
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const assignmentByMapping = new Map(
    input.assignments.map((assignment) => [
      `${assignment.tradingAccountId}:${assignment.subscriptionId}`,
      assignment,
    ])
  );
  const missingLegacyMappings = input.legacySubscriptions
    .filter(
      (subscription) =>
        !assignmentByMapping.has(
          `${subscription.tradingAccountId}:${subscription.id}`
        )
    )
    .map((subscription) => ({
      subscriptionId: subscription.id,
      subscriptionKey: subscription.key,
      globalCatalogEnabled: subscription.enabled,
      legacyTradingAccountId: subscription.tradingAccountId,
      account: accountById.get(subscription.tradingAccountId) ?? null,
      enabled: null,
      entriesEnabled: null,
      exitsEnabled: null,
      allocationId: null,
      allocation: null,
    }));

  const mappedLegacyAssignments = input.legacySubscriptions
    .map((subscription) =>
      assignmentByMapping.get(
        `${subscription.tradingAccountId}:${subscription.id}`
      )
    )
    .filter(
      (assignment): assignment is MigrationDiagnosticAssignment =>
        assignment !== undefined
    );
  const invalidMigratedSizing = mappedLegacyAssignments
    .map((assignment) => ({
      ...failureDetails(assignment),
      reasons: sizingReasons(assignment),
    }))
    .filter((failure) => failure.reasons.length > 0);

  const entryConfigurationFailures: MigrationDiagnosticFailure[] = [];
  const entryCapableAssignments = input.assignments.filter(
    (assignment) =>
      assignment.subscription.enabled &&
      assignment.enabled &&
      assignment.entriesEnabled
  );

  for (const assignment of entryCapableAssignments) {
    const reasons = sizingReasons(assignment);
    const account = accountById.get(assignment.tradingAccountId);
    const allocation = assignment.allocation;

    if (assignment.allocationId === null) reasons.push('ALLOCATION_REQUIRED');
    else if (
      allocation === null ||
      allocation.tradingAccountId !== assignment.tradingAccountId
    ) {
      reasons.push('ENABLED_SAME_ACCOUNT_ALLOCATION_REQUIRED');
    } else {
      if (!allocation.enabled) reasons.push('ALLOCATION_MUST_BE_ENABLED');
      if (!isPositive(allocation.maxAllocatedNotional)) {
        reasons.push('ALLOCATION_MAX_ALLOCATED_NOTIONAL_REQUIRED');
      }
      if (!isPositive(allocation.maxOpenPositions)) {
        reasons.push('ALLOCATION_MAX_OPEN_POSITIONS_REQUIRED');
      }
      if (!isPositive(allocation.maxPositionNotional)) {
        reasons.push('ALLOCATION_MAX_POSITION_NOTIONAL_REQUIRED');
      }
      if (
        isPositive(allocation.maxAllocatedNotional) &&
        isPositive(allocation.maxPositionNotional) &&
        allocation.maxPositionNotional > allocation.maxAllocatedNotional
      ) {
        reasons.push('ALLOCATION_POSITION_LIMIT_EXCEEDS_TOTAL');
      }
      if (
        isPositive(allocation.maxPositionNotional) &&
        isPositive(assignment.reservedNotional) &&
        assignment.reservedNotional > allocation.maxPositionNotional
      ) {
        reasons.push('RESERVATION_EXCEEDS_ALLOCATION_POSITION_LIMIT');
      }
    }
    if (!isPositive(account?.maxDeployableNotional ?? null)) {
      reasons.push('ACCOUNT_MAX_DEPLOYABLE_NOTIONAL_REQUIRED');
    }
    if (!isPositive(assignment.reservedNotional)) {
      reasons.push('RESERVED_NOTIONAL_REQUIRED');
    }
    if (
      assignment.sizingType === PositionSizingType.MAX_NOTIONAL &&
      isPositive(assignment.maxPositionNotional) &&
      isPositive(assignment.reservedNotional) &&
      assignment.maxPositionNotional > assignment.reservedNotional
    ) {
      reasons.push('MAX_NOTIONAL_EXCEEDS_RESERVATION');
    }
    if (reasons.length > 0) {
      entryConfigurationFailures.push({
        ...failureDetails(assignment),
        reasons,
      });
    }
  }

  const allocationReservationFailures = new Map<number, string>();
  for (const assignment of entryCapableAssignments) {
    if (assignment.allocation) {
      const total = entryCapableAssignments
        .filter((item) => item.allocationId === assignment.allocationId)
        .reduce((sum, item) => sum + (item.reservedNotional ?? 0), 0);
      if (
        isPositive(assignment.allocation.maxAllocatedNotional) &&
        total > assignment.allocation.maxAllocatedNotional
      ) {
        allocationReservationFailures.set(
          assignment.allocation.id,
          'ALLOCATION_RESERVATIONS_EXCEED_TOTAL'
        );
      }
    }
  }
  for (const failure of entryConfigurationFailures) {
    const aggregateReason =
      failure.allocationId === null
        ? undefined
        : allocationReservationFailures.get(failure.allocationId);
    if (aggregateReason && !failure.reasons.includes(aggregateReason)) {
      failure.reasons.push(aggregateReason);
    }
  }
  for (const assignment of entryCapableAssignments) {
    const aggregateReason =
      assignment.allocationId === null
        ? undefined
        : allocationReservationFailures.get(assignment.allocationId);
    if (
      aggregateReason &&
      !entryConfigurationFailures.some(
        (failure) => failure.assignmentId === assignment.id
      )
    ) {
      entryConfigurationFailures.push({
        ...failureDetails(assignment),
        reasons: [aggregateReason],
      });
    }
  }

  const bobbyPaper = input.accounts.find(
    (account) =>
      account.displayName === 'Bobby Paper' &&
      account.environment === TradingAccountEnvironment.PAPER
  );
  const bobbyLive = input.accounts.find(
    (account) =>
      account.displayName === 'Bobby Live' &&
      account.environment === TradingAccountEnvironment.LIVE
  );
  const bobbyPaperAssignmentCount = bobbyPaper
    ? input.assignments.filter(
        (assignment) => assignment.tradingAccountId === bobbyPaper.id
      ).length
    : null;
  const bobbyLiveAssignmentCount = bobbyLive
    ? input.assignments.filter(
        (assignment) => assignment.tradingAccountId === bobbyLive.id
      ).length
    : null;
  const legacyMappingValid = missingLegacyMappings.length === 0;
  const migratedSizingValid = invalidMigratedSizing.length === 0;
  const bobbyLiveAssignmentsValid = bobbyLiveAssignmentCount === 0;
  const entryConfigurationValid = entryConfigurationFailures.length === 0;

  return {
    expectedLegacyMappingCount: input.legacySubscriptions.length,
    mappedLegacyAssignmentCount: mappedLegacyAssignments.length,
    missingLegacyMappings,
    invalidMigratedSizing,
    entryCapableAssignmentCount: entryCapableAssignments.length,
    entryConfigurationFailures,
    bobbyPaperAssignmentCount,
    bobbyLiveAssignmentCount,
    legacyMappingValid,
    migratedSizingValid,
    bobbyLiveAssignmentsValid,
    entryConfigurationValid,
    productionBaselineValid:
      legacyMappingValid && migratedSizingValid && bobbyLiveAssignmentsValid,
    safeToDropLegacyFields: legacyMappingValid && migratedSizingValid,
  };
}
