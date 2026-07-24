import {
  PositionSizingType,
  TradingAccountEnvironment,
  TradingBroker,
} from '@prisma/client';

export type LegacySubscriptionMapping = {
  id: number;
  key: string;
  tradingAccountId: number;
  enabled: boolean;
  broker: unknown;
  brokerMode: unknown;
  sizingType: unknown;
  sizingValue: unknown;
  sizingValueRaw: string | null;
};

export type MigrationDiagnosticRiskSettings = {
  enabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
};

export type MigrationDiagnosticAccount = {
  id: number;
  displayName: string;
  broker: TradingBroker;
  environment: TradingAccountEnvironment;
  maxDeployableNotional: number | null;
  riskSettings: MigrationDiagnosticRiskSettings | null;
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

export type MigrationDiagnosticLifecycleReference = {
  model: 'OrderIntent' | 'TrackedPosition' | 'EntryDecision';
  id: number | string;
  tradingAccountSubscriptionId: number;
  tradingAccountId: number | null;
  subscriptionId: number | null;
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

function isPositive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function asTrimmedLower(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function parseLegacyNumber(legacy: LegacySubscriptionMapping) {
  const raw = legacy.sizingValueRaw ?? legacy.sizingValue;
  if (
    (typeof raw !== 'string' && typeof raw !== 'number') ||
    (typeof raw === 'string' && raw.trim() === '')
  ) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function equalStoredFloat(left: number | null, right: number | null) {
  // Prisma Float maps to PostgreSQL double precision. Both sides are compared as
  // the exact IEEE-754 values returned by the database, not with an epsilon.
  return left === right;
}

function normalizeLegacySizing(legacy: LegacySubscriptionMapping) {
  const rawType = asTrimmedLower(legacy.sizingType);
  const value = parseLegacyNumber(legacy);
  if (['fixed_qty', 'fixedqty', 'qty'].includes(rawType ?? '')) {
    return {
      recognized: true as const,
      sizingType: PositionSizingType.FIXED_QTY,
      fixedQty: value,
      maxPositionNotional: null,
    };
  }
  if (
    ['max_notional', 'maxnotional', 'max_capital', 'maxcapital'].includes(
      rawType ?? ''
    )
  ) {
    return {
      recognized: true as const,
      sizingType: PositionSizingType.MAX_NOTIONAL,
      fixedQty: null,
      maxPositionNotional: value,
    };
  }
  return {
    recognized: false as const,
    rawSizingType: legacy.sizingType,
    rawSizingValue: legacy.sizingValue,
    rawSizingValueText: legacy.sizingValueRaw,
  };
}

function normalizeLegacyBroker(value: unknown) {
  return asTrimmedLower(value) === 'alpaca' ? TradingBroker.ALPACA : null;
}

function normalizeLegacyEnvironment(value: unknown) {
  const normalized = asTrimmedLower(value);
  if (normalized === 'paper') return TradingAccountEnvironment.PAPER;
  if (normalized === 'live') return TradingAccountEnvironment.LIVE;
  return null;
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

function failureDetails(assignment: MigrationDiagnosticAssignment): FailureDetails {
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

function duplicates(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function completeRiskSettings(settings: MigrationDiagnosticRiskSettings | null) {
  return (
    settings !== null &&
    settings.enabled &&
    isPositive(settings.maxDailyEntryOrders) &&
    isPositive(settings.maxDailyEntryNotional) &&
    isPositive(settings.maxOpenPositions) &&
    isPositive(settings.maxTotalOpenNotional) &&
    isPositive(settings.maxSymbolOpenNotional) &&
    isPositive(settings.maxSubscriptionOpenNotional)
  );
}

export function buildSubscriptionCatalogMigrationDiagnostic(input: {
  accounts: MigrationDiagnosticAccount[];
  legacySubscriptions: LegacySubscriptionMapping[];
  assignments: MigrationDiagnosticAssignment[];
  expectedBobbyPaperKeys: string[];
  lifecycleReferences: MigrationDiagnosticLifecycleReference[];
}) {
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const assignmentGroups = new Map<string, MigrationDiagnosticAssignment[]>();
  const assignmentById = new Map<number, MigrationDiagnosticAssignment[]>();
  for (const assignment of input.assignments) {
    const mappingKey = `${assignment.tradingAccountId}:${assignment.subscriptionId}`;
    assignmentGroups.set(mappingKey, [
      ...(assignmentGroups.get(mappingKey) ?? []),
      assignment,
    ]);
    assignmentById.set(assignment.id, [
      ...(assignmentById.get(assignment.id) ?? []),
      assignment,
    ]);
  }

  const missingLegacyMappings: object[] = [];
  const duplicateLegacyMappings: object[] = [];
  const legacyIdentityMismatches: object[] = [];
  const legacyEnablementMismatches: object[] = [];
  const legacySizingMismatches: object[] = [];
  const unknownLegacySizingConversions: object[] = [];
  const legacyRoutingMismatches: object[] = [];
  const mappedLegacyAssignments: MigrationDiagnosticAssignment[] = [];

  for (const legacy of input.legacySubscriptions) {
    const mappingKey = `${legacy.tradingAccountId}:${legacy.id}`;
    const matches = assignmentGroups.get(mappingKey) ?? [];
    if (matches.length === 0) {
      missingLegacyMappings.push({
        subscriptionId: legacy.id,
        subscriptionKey: legacy.key,
        legacyTradingAccountId: legacy.tradingAccountId,
        account: accountById.get(legacy.tradingAccountId) ?? null,
      });
      continue;
    }
    if (matches.length > 1) {
      duplicateLegacyMappings.push({
        subscriptionId: legacy.id,
        subscriptionKey: legacy.key,
        legacyTradingAccountId: legacy.tradingAccountId,
        assignmentIds: matches.map((assignment) => assignment.id),
      });
      continue;
    }

    const assignment = matches[0]!;
    mappedLegacyAssignments.push(assignment);
    if (
      assignment.tradingAccountId !== legacy.tradingAccountId ||
      assignment.subscriptionId !== legacy.id
    ) {
      legacyIdentityMismatches.push({
        subscriptionId: legacy.id,
        subscriptionKey: legacy.key,
        legacyTradingAccountId: legacy.tradingAccountId,
        assignmentId: assignment.id,
        migratedTradingAccountId: assignment.tradingAccountId,
        migratedSubscriptionId: assignment.subscriptionId,
      });
    }

    for (const [field, migratedValue, expectedPolicyValue] of [
      ['enabled', assignment.enabled, legacy.enabled],
      ['entriesEnabled', assignment.entriesEnabled, legacy.enabled],
      ['exitsEnabled', assignment.exitsEnabled, true],
    ] as const) {
      if (migratedValue !== expectedPolicyValue) {
        legacyEnablementMismatches.push({
          subscriptionId: legacy.id,
          subscriptionKey: legacy.key,
          tradingAccountId: legacy.tradingAccountId,
          field,
          legacyEnabled: legacy.enabled,
          migratedValue,
          expectedPolicyValue,
        });
      }
    }

    const normalizedSizing = normalizeLegacySizing(legacy);
    if (!normalizedSizing.recognized) {
      unknownLegacySizingConversions.push({
        subscriptionId: legacy.id,
        subscriptionKey: legacy.key,
        tradingAccountId: legacy.tradingAccountId,
        ...normalizedSizing,
      });
    } else {
      const mismatchedFields: string[] = [];
      if (assignment.sizingType !== normalizedSizing.sizingType) {
        mismatchedFields.push('sizingType');
      }
      if (!equalStoredFloat(assignment.fixedQty, normalizedSizing.fixedQty)) {
        mismatchedFields.push('fixedQty');
      }
      if (
        !equalStoredFloat(
          assignment.maxPositionNotional,
          normalizedSizing.maxPositionNotional
        )
      ) {
        mismatchedFields.push('maxPositionNotional');
      }
      if (mismatchedFields.length > 0) {
        legacySizingMismatches.push({
          subscriptionId: legacy.id,
          subscriptionKey: legacy.key,
          tradingAccountId: legacy.tradingAccountId,
          rawSizingType: legacy.sizingType,
          rawSizingValue: legacy.sizingValue,
          rawSizingValueText: legacy.sizingValueRaw,
          expected: normalizedSizing,
          migrated: {
            sizingType: assignment.sizingType,
            fixedQty: assignment.fixedQty,
            maxPositionNotional: assignment.maxPositionNotional,
          },
          mismatchedFields,
        });
      }
    }

    const account = accountById.get(legacy.tradingAccountId);
    const expectedBroker = normalizeLegacyBroker(legacy.broker);
    const expectedEnvironment = normalizeLegacyEnvironment(legacy.brokerMode);
    const routingReasons: string[] = [];
    if (expectedBroker === null) routingReasons.push('UNKNOWN_LEGACY_BROKER');
    else if (account?.broker !== expectedBroker) routingReasons.push('BROKER_MISMATCH');
    if (expectedEnvironment === null) {
      routingReasons.push('UNKNOWN_LEGACY_BROKER_MODE');
    } else if (account?.environment !== expectedEnvironment) {
      routingReasons.push('ENVIRONMENT_MISMATCH');
    }
    if (!account) routingReasons.push('LEGACY_ACCOUNT_NOT_FOUND');
    if (routingReasons.length > 0) {
      legacyRoutingMismatches.push({
        subscriptionId: legacy.id,
        subscriptionKey: legacy.key,
        tradingAccountId: legacy.tradingAccountId,
        rawBroker: legacy.broker,
        rawBrokerMode: legacy.brokerMode,
        expectedBroker,
        expectedEnvironment,
        account: account ?? null,
        reasons: routingReasons,
      });
    }
  }

  const lifecycleReferenceFailures: object[] = [];
  for (const reference of input.lifecycleReferences) {
    const matches = assignmentById.get(reference.tradingAccountSubscriptionId) ?? [];
    const reasons: string[] = [];
    const assignment = matches.length === 1 ? matches[0]! : null;
    if (matches.length === 0) reasons.push('ASSIGNMENT_NOT_FOUND');
    if (matches.length > 1) reasons.push('DUPLICATE_ASSIGNMENT_ID_INPUT');
    if (
      assignment &&
      reference.tradingAccountId !== null &&
      assignment.tradingAccountId !== reference.tradingAccountId
    ) {
      reasons.push('TRADING_ACCOUNT_MISMATCH');
    }
    if (
      assignment &&
      reference.subscriptionId !== null &&
      assignment.subscriptionId !== reference.subscriptionId
    ) {
      reasons.push('SUBSCRIPTION_MISMATCH');
    }
    if (reasons.length > 0) {
      lifecycleReferenceFailures.push({ ...reference, assignment, reasons });
    }
  }

  const entryConfigurationFailures: MigrationDiagnosticFailure[] = [];
  const entryCapableAssignments = input.assignments.filter(
    (assignment) =>
      assignment.subscription.enabled &&
      assignment.enabled &&
      assignment.entriesEnabled
  );
  const allocationReservationFailures = new Map<number, string>();

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
      ) reasons.push('ALLOCATION_POSITION_LIMIT_EXCEEDS_TOTAL');
      if (
        isPositive(allocation.maxPositionNotional) &&
        isPositive(assignment.reservedNotional) &&
        assignment.reservedNotional > allocation.maxPositionNotional
      ) reasons.push('RESERVATION_EXCEEDS_ALLOCATION_POSITION_LIMIT');
    }
    if (!isPositive(account?.maxDeployableNotional)) {
      reasons.push('ACCOUNT_MAX_DEPLOYABLE_NOTIONAL_REQUIRED');
    }
    if (!completeRiskSettings(account?.riskSettings ?? null)) {
      reasons.push('ACCOUNT_ENTRY_RISK_CONFIGURATION_REQUIRED');
    }
    if (!isPositive(assignment.reservedNotional)) {
      reasons.push('RESERVED_NOTIONAL_REQUIRED');
    }
    if (
      assignment.sizingType === PositionSizingType.MAX_NOTIONAL &&
      isPositive(assignment.maxPositionNotional) &&
      isPositive(assignment.reservedNotional) &&
      assignment.maxPositionNotional > assignment.reservedNotional
    ) reasons.push('MAX_NOTIONAL_EXCEEDS_RESERVATION');
    if (reasons.length > 0) {
      entryConfigurationFailures.push({ ...failureDetails(assignment), reasons });
    }
  }

  for (const allocationId of new Set(
    entryCapableAssignments
      .map((assignment) => assignment.allocationId)
      .filter((id): id is number => id !== null)
  )) {
    const assignments = entryCapableAssignments.filter(
      (assignment) => assignment.allocationId === allocationId
    );
    const allocation = assignments[0]?.allocation;
    const total = assignments.reduce(
      (sum, assignment) => sum + (assignment.reservedNotional ?? 0),
      0
    );
    if (allocation && isPositive(allocation.maxAllocatedNotional) &&
        total > allocation.maxAllocatedNotional) {
      allocationReservationFailures.set(
        allocationId,
        'ALLOCATION_RESERVATIONS_EXCEED_TOTAL'
      );
    }
  }
  for (const assignment of entryCapableAssignments) {
    const aggregateReason =
      assignment.allocationId === null
        ? undefined
        : allocationReservationFailures.get(assignment.allocationId);
    if (!aggregateReason) continue;
    const existing = entryConfigurationFailures.find(
      (failure) => failure.assignmentId === assignment.id
    );
    if (existing) existing.reasons.push(aggregateReason);
    else {
      entryConfigurationFailures.push({
        ...failureDetails(assignment),
        reasons: [aggregateReason],
      });
    }
  }

  const paperMatches = input.accounts.filter(
    (account) =>
      account.displayName === 'Bobby Paper' &&
      account.environment === TradingAccountEnvironment.PAPER
  );
  const liveMatches = input.accounts.filter(
    (account) =>
      account.displayName === 'Bobby Live' &&
      account.environment === TradingAccountEnvironment.LIVE
  );
  const bobbyPaperAccountDiscovery =
    paperMatches.length === 1
      ? { status: 'FOUND' as const, account: paperMatches[0]!, matches: paperMatches }
      : {
          status: paperMatches.length === 0 ? ('MISSING' as const) : ('AMBIGUOUS' as const),
          account: null,
          matches: paperMatches,
        };
  const bobbyLiveAccountDiscovery =
    liveMatches.length === 1
      ? { status: 'FOUND' as const, account: liveMatches[0]!, matches: liveMatches }
      : {
          status: liveMatches.length === 0 ? ('MISSING' as const) : ('AMBIGUOUS' as const),
          account: null,
          matches: liveMatches,
        };

  const expectedKeys = [...input.expectedBobbyPaperKeys].sort();
  const paperAssignments = bobbyPaperAccountDiscovery.account
    ? input.assignments.filter(
        (assignment) =>
          assignment.tradingAccountId === bobbyPaperAccountDiscovery.account!.id
      )
    : [];
  const actualPaperKeys = paperAssignments
    .map((assignment) => assignment.subscription.key)
    .sort();
  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualPaperKeys);
  const paperCatalogBaseline = {
    expectedCount: expectedKeys.length,
    actualCount: actualPaperKeys.length,
    missingKeys: [...expectedSet].filter((key) => !actualSet.has(key)).sort(),
    unexpectedKeys: [...actualSet].filter((key) => !expectedSet.has(key)).sort(),
    duplicateKeys: duplicates(actualPaperKeys),
    expectedDuplicateKeys: duplicates(expectedKeys),
  };
  const bobbyPaperCatalogValid =
    bobbyPaperAccountDiscovery.status === 'FOUND' &&
    paperCatalogBaseline.missingKeys.length === 0 &&
    paperCatalogBaseline.unexpectedKeys.length === 0 &&
    paperCatalogBaseline.duplicateKeys.length === 0 &&
    paperCatalogBaseline.expectedDuplicateKeys.length === 0 &&
    paperCatalogBaseline.actualCount === paperCatalogBaseline.expectedCount;

  const bobbyLiveAssignmentCount = bobbyLiveAccountDiscovery.account
    ? input.assignments.filter(
        (assignment) =>
          assignment.tradingAccountId === bobbyLiveAccountDiscovery.account!.id
      ).length
    : null;
  const liveAccountBaselineValid =
    bobbyLiveAccountDiscovery.status === 'FOUND' &&
    bobbyLiveAssignmentCount === 0;

  const legacyMappingValid =
    missingLegacyMappings.length === 0 &&
    duplicateLegacyMappings.length === 0 &&
    legacyIdentityMismatches.length === 0;
  const legacyEnablementParityValid = legacyEnablementMismatches.length === 0;
  const legacySizingParityValid =
    legacySizingMismatches.length === 0 &&
    unknownLegacySizingConversions.length === 0;
  const legacyRoutingParityValid = legacyRoutingMismatches.length === 0;
  const lifecycleReferencesValid = lifecycleReferenceFailures.length === 0;
  const expectedCatalogBaselineValid = bobbyPaperCatalogValid;
  const entryConfigurationValid = entryConfigurationFailures.length === 0;
  const schemaDropSafe =
    legacyMappingValid &&
    legacyEnablementParityValid &&
    legacySizingParityValid &&
    legacyRoutingParityValid &&
    lifecycleReferencesValid;
  const productionBaselineValid =
    expectedCatalogBaselineValid && liveAccountBaselineValid;
  const runtimeEntryReady = entryConfigurationValid;
  const overallDiagnosticPassed =
    schemaDropSafe && productionBaselineValid && runtimeEntryReady;

  return {
    summary: {
      legacySubscriptionCount: input.legacySubscriptions.length,
      mappedLegacyAssignmentCount: mappedLegacyAssignments.length,
      assignmentCount: input.assignments.length,
      entryCapableAssignmentCount: entryCapableAssignments.length,
      lifecycleReferenceCount: input.lifecycleReferences.length,
      lifecycleReferenceFailureCount: lifecycleReferenceFailures.length,
    },
    missingLegacyMappings,
    duplicateLegacyMappings,
    legacyIdentityMismatches,
    legacyEnablementMismatches,
    legacySizingMismatches,
    unknownLegacySizingConversions,
    legacyRoutingMismatches,
    lifecycleReferenceFailures,
    entryConfigurationFailures,
    bobbyPaperAccountDiscovery,
    bobbyLiveAccountDiscovery,
    paperCatalogBaseline,
    bobbyLiveAssignmentCount,
    legacyMappingValid,
    legacyEnablementParityValid,
    legacySizingParityValid,
    legacyRoutingParityValid,
    lifecycleReferencesValid,
    expectedCatalogBaselineValid,
    liveAccountBaselineValid,
    entryConfigurationValid,
    schemaDropSafe,
    productionBaselineValid,
    runtimeEntryReady,
    overallDiagnosticPassed,
    /** @deprecated Use schemaDropSafe. */
    safeToDropLegacyFields: schemaDropSafe,
  };
}
