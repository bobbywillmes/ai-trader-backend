import {
  PositionSizingType,
  TradingAccountEnvironment,
  TradingBroker,
} from '@prisma/client';

export const REQUIRED_LEGACY_SUBSCRIPTION_COLUMNS = [
  'id',
  'key',
  'tradingAccountId',
  'enabled',
  'broker',
  'brokerMode',
  'sizingType',
  'sizingValue',
] as const;

export function assessLegacySubscriptionSourceColumns(columnNames: string[]) {
  const availableColumns = [...new Set(columnNames)].sort();
  const availableColumnSet = new Set(availableColumns);
  const missingColumns = REQUIRED_LEGACY_SUBSCRIPTION_COLUMNS.filter(
    (columnName) => !availableColumnSet.has(columnName)
  );

  return {
    availableColumns,
    requiredColumns: [...REQUIRED_LEGACY_SUBSCRIPTION_COLUMNS],
    missingColumns,
    legacySourceAvailable: missingColumns.length === 0,
  };
}

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
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  subscription: {
    key: string;
    enabled: boolean;
  };
  allocation: MigrationDiagnosticAllocation | null;
};

export type MigrationDiagnosticCatalogEvent = {
  id: number;
  subscriptionId: number | null;
  subscriptionKey: string | null;
  createdAt: Date;
  eventType: string;
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export const MIGRATION_DIVERGENCE_CLASSIFICATIONS = {
  UNCHANGED_FROM_BOOTSTRAP: 'UNCHANGED_FROM_BOOTSTRAP',
  CONFIRMED_POST_CREATION_DIVERGENCE:
    'CONFIRMED_POST_CREATION_DIVERGENCE',
  LIKELY_AUTHORIZED_DIVERGENCE: 'LIKELY_AUTHORIZED_DIVERGENCE',
  PREEXISTING_ASSIGNMENT_SKIPPED_BY_BOOTSTRAP:
    'PREEXISTING_ASSIGNMENT_SKIPPED_BY_BOOTSTRAP',
  LEGACY_SIDE_CHANGED_AFTER_ASSIGNMENT:
    'LEGACY_SIDE_CHANGED_AFTER_ASSIGNMENT',
  UNEXPLAINED: 'UNEXPLAINED',
  MALFORMED_CURRENT_STATE: 'MALFORMED_CURRENT_STATE',
} as const;

export type MigrationDivergenceClassification =
  (typeof MIGRATION_DIVERGENCE_CLASSIFICATIONS)[keyof typeof MIGRATION_DIVERGENCE_CLASSIFICATIONS];

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

function currentSizingStateReasons(assignment: MigrationDiagnosticAssignment) {
  if (assignment.sizingType === PositionSizingType.FIXED_QTY) {
    return [
      ...(!isPositive(assignment.fixedQty)
        ? ['FIXED_QTY_REQUIRES_POSITIVE_FIXED_QTY']
        : []),
      ...(assignment.maxPositionNotional !== null
        ? ['FIXED_QTY_REQUIRES_NULL_MAX_POSITION_NOTIONAL']
        : []),
    ];
  }
  if (assignment.sizingType === PositionSizingType.MAX_NOTIONAL) {
    return [
      ...(!isPositive(assignment.maxPositionNotional)
        ? ['MAX_NOTIONAL_REQUIRES_POSITIVE_MAX_POSITION_NOTIONAL']
        : []),
      ...(assignment.fixedQty !== null
        ? ['MAX_NOTIONAL_REQUIRES_NULL_FIXED_QTY']
        : []),
    ];
  }
  return ['UNSUPPORTED_CURRENT_SIZING_TYPE'];
}

function inferBootstrapBatch(assignments: MigrationDiagnosticAssignment[]) {
  const groups = new Map<number, MigrationDiagnosticAssignment[]>();
  for (const assignment of assignments) {
    const second = Math.floor(assignment.createdAt.getTime() / 1_000) * 1_000;
    groups.set(second, [...(groups.get(second) ?? []), assignment]);
  }
  const candidates = [...groups.entries()].sort(
    ([leftSecond, left], [rightSecond, right]) =>
      right.length - left.length || leftSecond - rightSecond
  );
  const batch = candidates[0]?.[1] ?? [];
  const timestamps = batch.map((assignment) => assignment.createdAt.getTime());
  return {
    inferred: batch.length > 0,
    count: batch.length,
    start: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null,
    end: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null,
    assignmentIds: batch.map((assignment) => assignment.id).sort((a, b) => a - b),
  };
}

function eventExplainsParityDifference(args: {
  event: MigrationDiagnosticCatalogEvent;
  assignment: MigrationDiagnosticAssignment;
  enablementMismatchFields: string[];
  sizingMismatchFields: string[];
}) {
  if (args.event.createdAt <= args.assignment.createdAt) return false;
  const relevantFields = new Set([
    ...args.enablementMismatchFields.map(() => 'enabled'),
    ...args.sizingMismatchFields.flatMap(() => ['sizingType', 'sizingValue']),
  ]);
  return args.event.changedFields.some((field) => relevantFields.has(field));
}

export function buildSubscriptionCatalogMigrationDiagnostic(input: {
  accounts: MigrationDiagnosticAccount[];
  legacySubscriptions: LegacySubscriptionMapping[];
  assignments: MigrationDiagnosticAssignment[];
  expectedBobbyPaperKeys: string[];
  lifecycleReferences: MigrationDiagnosticLifecycleReference[];
  catalogEvents: MigrationDiagnosticCatalogEvent[];
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
  const parityByAssignment = new Map<
    number,
    {
      legacy: LegacySubscriptionMapping;
      enablementMismatchFields: string[];
      sizingMismatchFields: string[];
      unknownLegacySizing: boolean;
    }
  >();

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
    const enablementMismatchFields: string[] = [];
    let sizingMismatchFields: string[] = [];
    let unknownLegacySizing = false;
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
        enablementMismatchFields.push(field);
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
      unknownLegacySizing = true;
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
        sizingMismatchFields = mismatchedFields;
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
    parityByAssignment.set(assignment.id, {
      legacy,
      enablementMismatchFields,
      sizingMismatchFields,
      unknownLegacySizing,
    });
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

  const bootstrapBatch = inferBootstrapBatch(mappedLegacyAssignments);
  const bootstrapBatchIds = new Set(bootstrapBatch.assignmentIds);
  const catalogEventsBySubscription = new Map<
    number,
    MigrationDiagnosticCatalogEvent[]
  >();
  for (const event of input.catalogEvents) {
    if (event.subscriptionId === null) continue;
    catalogEventsBySubscription.set(event.subscriptionId, [
      ...(catalogEventsBySubscription.get(event.subscriptionId) ?? []),
      event,
    ]);
  }

  const parityClassifications = mappedLegacyAssignments.map((assignment) => {
    const parity = parityByAssignment.get(assignment.id)!;
    const currentStateReasons = currentSizingStateReasons(assignment);
    const hasParityDifference =
      parity.enablementMismatchFields.length > 0 ||
      parity.sizingMismatchFields.length > 0 ||
      parity.unknownLegacySizing;
    const updatedAfterCreation =
      assignment.updatedAt.getTime() > assignment.createdAt.getTime();
    const hasBootstrapProvenance =
      assignment.notes?.includes(
        'Bootstrapped from legacy Subscription sizing fields.'
      ) ?? false;
    const inBootstrapBatch = bootstrapBatchIds.has(assignment.id);
    const relevantCatalogEvents = (
      catalogEventsBySubscription.get(assignment.subscriptionId) ?? []
    ).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const explainingCatalogEvents = relevantCatalogEvents.filter((event) =>
      eventExplainsParityDifference({
        event,
        assignment,
        enablementMismatchFields: parity.enablementMismatchFields,
        sizingMismatchFields: parity.sizingMismatchFields,
      })
    );

    let classification: MigrationDivergenceClassification;
    const reasons: string[] = [];
    if (currentStateReasons.length > 0) {
      classification =
        MIGRATION_DIVERGENCE_CLASSIFICATIONS.MALFORMED_CURRENT_STATE;
      reasons.push(...currentStateReasons);
    } else if (!hasParityDifference) {
      classification =
        MIGRATION_DIVERGENCE_CLASSIFICATIONS.UNCHANGED_FROM_BOOTSTRAP;
      reasons.push('CURRENT_VALUES_MATCH_BOOTSTRAP_POLICY');
    } else if (parity.unknownLegacySizing) {
      classification = MIGRATION_DIVERGENCE_CLASSIFICATIONS.UNEXPLAINED;
      reasons.push('UNKNOWN_INITIAL_SIZING_CONVERSION');
    } else if (explainingCatalogEvents.length > 0) {
      classification =
        MIGRATION_DIVERGENCE_CLASSIFICATIONS.LEGACY_SIDE_CHANGED_AFTER_ASSIGNMENT;
      reasons.push('CATALOG_EVENT_EXPLAINS_CURRENT_PARITY_DIFFERENCE');
    } else if (
      bootstrapBatch.start !== null &&
      assignment.createdAt < bootstrapBatch.start
    ) {
      classification =
        MIGRATION_DIVERGENCE_CLASSIFICATIONS.PREEXISTING_ASSIGNMENT_SKIPPED_BY_BOOTSTRAP;
      reasons.push('ASSIGNMENT_PREDATES_INFERRED_BOOTSTRAP_BATCH');
    } else if (
      hasBootstrapProvenance &&
      inBootstrapBatch &&
      updatedAfterCreation
    ) {
      classification =
        MIGRATION_DIVERGENCE_CLASSIFICATIONS.CONFIRMED_POST_CREATION_DIVERGENCE;
      reasons.push(
        'BOOTSTRAP_PROVENANCE_RETAINED',
        'UPDATED_AFTER_CREATION',
        'CURRENT_STATE_WRITER_VALID'
      );
    } else if (inBootstrapBatch && updatedAfterCreation) {
      classification =
        MIGRATION_DIVERGENCE_CLASSIFICATIONS.LIKELY_AUTHORIZED_DIVERGENCE;
      reasons.push(
        'INFERRED_BOOTSTRAP_BATCH_MEMBER',
        'UPDATED_AFTER_CREATION',
        'CURRENT_STATE_WRITER_VALID',
        'ASSIGNMENT_ACTOR_AUDIT_UNAVAILABLE'
      );
    } else {
      classification = MIGRATION_DIVERGENCE_CLASSIFICATIONS.UNEXPLAINED;
      reasons.push('AVAILABLE_CHRONOLOGY_DOES_NOT_EXPLAIN_PARITY_DIFFERENCE');
    }

    return {
      classification,
      reasons,
      assignment: {
        ...failureDetails(assignment),
        notes: assignment.notes,
        createdAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
      },
      legacy: parity.legacy,
      parity: {
        enablementMismatchFields: parity.enablementMismatchFields,
        sizingMismatchFields: parity.sizingMismatchFields,
        unknownLegacySizing: parity.unknownLegacySizing,
      },
      evidence: {
        updatedAfterCreation,
        hasBootstrapProvenance,
        inBootstrapBatch,
        currentStateWriterValid: currentStateReasons.length === 0,
        currentStateReasons,
        relevantCatalogEvents,
        explainingCatalogEvents,
        assignmentActorAuditAvailable: false,
      },
    };
  });
  const divergenceClassificationCounts = Object.fromEntries(
    Object.values(MIGRATION_DIVERGENCE_CLASSIFICATIONS).map((classification) => [
      classification,
      parityClassifications.filter(
        (item) => item.classification === classification
      ).length,
    ])
  ) as Record<MigrationDivergenceClassification, number>;
  const unexplainedDivergences = parityClassifications.filter(
    (item) =>
      item.classification ===
      MIGRATION_DIVERGENCE_CLASSIFICATIONS.UNEXPLAINED
  );
  const malformedCurrentStates = parityClassifications.filter(
    (item) =>
      item.classification ===
      MIGRATION_DIVERGENCE_CLASSIFICATIONS.MALFORMED_CURRENT_STATE
  );

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
  const initialBootstrapFidelityValid =
    legacyMappingValid &&
    legacyEnablementParityValid &&
    legacySizingParityValid &&
    legacyRoutingParityValid &&
    lifecycleReferencesValid;
  const legacyMigrationProvenanceValid =
    legacyMappingValid &&
    legacyRoutingParityValid &&
    lifecycleReferencesValid &&
    unknownLegacySizingConversions.length === 0 &&
    unexplainedDivergences.length === 0 &&
    malformedCurrentStates.length === 0;
  const schemaDropSafe =
    legacyMappingValid &&
    legacyRoutingParityValid &&
    lifecycleReferencesValid &&
    legacyMigrationProvenanceValid &&
    unknownLegacySizingConversions.length === 0 &&
    unexplainedDivergences.length === 0 &&
    malformedCurrentStates.length === 0;
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
      exactEnablementParityDifferenceCount:
        legacyEnablementMismatches.length,
      exactSizingParityDifferenceCount: legacySizingMismatches.length,
      uniqueDivergentAssignmentCount: parityClassifications.filter(
        (item) =>
          item.classification !==
          MIGRATION_DIVERGENCE_CLASSIFICATIONS.UNCHANGED_FROM_BOOTSTRAP
      ).length,
    },
    missingLegacyMappings,
    duplicateLegacyMappings,
    legacyIdentityMismatches,
    legacyEnablementMismatches,
    legacySizingMismatches,
    unknownLegacySizingConversions,
    legacyRoutingMismatches,
    bootstrapBatch,
    parityClassifications,
    divergenceClassificationCounts,
    unexplainedDivergences,
    malformedCurrentStates,
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
    initialBootstrapFidelityValid,
    legacyMigrationProvenanceValid,
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
