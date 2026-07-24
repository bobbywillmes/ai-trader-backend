import {
  PositionSizingType,
  TradingAccountEnvironment,
  TradingBroker,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  assessLegacySubscriptionSourceColumns,
  buildSubscriptionCatalogMigrationDiagnostic,
  type LegacySubscriptionMapping,
  type MigrationDiagnosticAccount,
  type MigrationDiagnosticAssignment,
  type MigrationDiagnosticCatalogEvent,
  type MigrationDiagnosticLifecycleReference,
} from './subscription-catalog-migration-diagnostic.js';

const completeRiskSettings = {
  enabled: true,
  maxDailyEntryOrders: 5,
  maxDailyEntryNotional: 10_000,
  maxOpenPositions: 5,
  maxTotalOpenNotional: 25_000,
  maxSymbolOpenNotional: 5_000,
  maxSubscriptionOpenNotional: 5_000,
};

const paper: MigrationDiagnosticAccount = {
  id: 1,
  displayName: 'Bobby Paper',
  broker: TradingBroker.ALPACA,
  environment: TradingAccountEnvironment.PAPER,
  maxDeployableNotional: 100_000,
  riskSettings: completeRiskSettings,
};
const live: MigrationDiagnosticAccount = {
  id: 2,
  displayName: 'Bobby Live',
  broker: TradingBroker.ALPACA,
  environment: TradingAccountEnvironment.LIVE,
  maxDeployableNotional: null,
  riskSettings: null,
};
const bootstrapCreatedAt = new Date('2026-06-30T18:57:06.500Z');

function legacy(
  id: number,
  overrides: Partial<LegacySubscriptionMapping> = {}
): LegacySubscriptionMapping {
  return {
    id,
    key: `subscription-${id}`,
    tradingAccountId: paper.id,
    enabled: false,
    broker: 'alpaca',
    brokerMode: 'paper',
    sizingType: 'fixed_qty',
    sizingValue: 1,
    sizingValueRaw: '1',
    ...overrides,
  };
}

function assignment(
  id: number,
  overrides: Partial<MigrationDiagnosticAssignment> = {}
): MigrationDiagnosticAssignment {
  return {
    id,
    tradingAccountId: paper.id,
    subscriptionId: id,
    allocationId: null,
    enabled: false,
    entriesEnabled: false,
    exitsEnabled: true,
    sizingType: PositionSizingType.FIXED_QTY,
    fixedQty: 1,
    maxPositionNotional: null,
    reservedNotional: null,
    notes:
      'Bootstrapped from legacy Subscription sizing fields. Allocation intentionally left unset.',
    createdAt: bootstrapCreatedAt,
    updatedAt: bootstrapCreatedAt,
    subscription: {
      key: `subscription-${id}`,
      enabled: false,
    },
    allocation: null,
    ...overrides,
  };
}

function validActiveAssignment(id: number) {
  return assignment(id, {
    allocationId: 10,
    enabled: true,
    entriesEnabled: true,
    reservedNotional: 1_000,
    subscription: { key: `subscription-${id}`, enabled: true },
    allocation: {
      id: 10,
      tradingAccountId: paper.id,
      key: 'core',
      name: 'Core',
      enabled: true,
      maxAllocatedNotional: 10_000,
      maxOpenPositions: 5,
      maxPositionNotional: 2_000,
    },
  });
}

function diagnose(input: {
  accounts?: MigrationDiagnosticAccount[];
  legacySubscriptions?: LegacySubscriptionMapping[];
  assignments?: MigrationDiagnosticAssignment[];
  expectedBobbyPaperKeys?: string[];
  lifecycleReferences?: MigrationDiagnosticLifecycleReference[];
  catalogEvents?: MigrationDiagnosticCatalogEvent[];
}) {
  const assignments = input.assignments ?? [assignment(1)];
  return buildSubscriptionCatalogMigrationDiagnostic({
    accounts: input.accounts ?? [paper, live],
    legacySubscriptions: input.legacySubscriptions ?? [legacy(1)],
    assignments,
    expectedBobbyPaperKeys:
      input.expectedBobbyPaperKeys ??
      assignments
        .filter((item) => item.tradingAccountId === paper.id)
        .map((item) => item.subscription.key),
    lifecycleReferences: input.lifecycleReferences ?? [],
    catalogEvents: input.catalogEvents ?? [],
  });
}

describe('subscription catalog migration diagnostic', () => {
  it('detects a post-migration database before querying legacy source values', () => {
    const result = assessLegacySubscriptionSourceColumns([
      'id',
      'key',
      'enabled',
      'description',
    ]);

    expect(result.legacySourceAvailable).toBe(false);
    expect(result.missingColumns).toEqual([
      'tradingAccountId',
      'broker',
      'brokerMode',
      'sizingType',
      'sizingValue',
    ]);
  });

  it('accepts a complete pre-migration legacy source schema', () => {
    const result = assessLegacySubscriptionSourceColumns([
      'sizingValue',
      'brokerMode',
      'enabled',
      'id',
      'tradingAccountId',
      'key',
      'sizingType',
      'broker',
    ]);

    expect(result.legacySourceAvailable).toBe(true);
    expect(result.missingColumns).toEqual([]);
  });

  it('accepts the exact curated 100-key baseline', () => {
    const legacies = Array.from({ length: 100 }, (_, index) => legacy(index + 1));
    const assignments = legacies.map((item) => assignment(item.id));
    const result = diagnose({
      legacySubscriptions: legacies,
      assignments,
      expectedBobbyPaperKeys: legacies.map((item) => item.key),
    });
    expect(result.paperCatalogBaseline).toMatchObject({
      expectedCount: 100,
      actualCount: 100,
      missingKeys: [],
      unexpectedKeys: [],
      duplicateKeys: [],
    });
    expect(result.overallDiagnosticPassed).toBe(true);
  });

  it('rejects a missing expected key plus unrelated extra while count remains 100', () => {
    const assignments = Array.from({ length: 100 }, (_, index) =>
      assignment(index + 1)
    );
    assignments[99] = assignment(100, {
      subscription: { key: 'unrelated-extra', enabled: false },
    });
    const result = diagnose({
      legacySubscriptions: [],
      assignments,
      expectedBobbyPaperKeys: Array.from(
        { length: 100 },
        (_, index) => `subscription-${index + 1}`
      ),
    });
    expect(result.paperCatalogBaseline.missingKeys).toEqual(['subscription-100']);
    expect(result.paperCatalogBaseline.unexpectedKeys).toEqual(['unrelated-extra']);
    expect(result.expectedCatalogBaselineValid).toBe(false);
  });

  it('rejects an unexpected Bobby Paper assignment', () => {
    const result = diagnose({
      assignments: [
        assignment(1),
        assignment(2, { subscription: { key: 'extra', enabled: false } }),
      ],
      expectedBobbyPaperKeys: ['subscription-1'],
    });
    expect(result.paperCatalogBaseline.unexpectedKeys).toEqual(['extra']);
  });

  it('rejects Bobby Live assignments', () => {
    const result = diagnose({
      assignments: [
        assignment(1),
        assignment(2, {
          tradingAccountId: live.id,
          subscription: { key: 'live-key', enabled: false },
        }),
      ],
    });
    expect(result.liveAccountBaselineValid).toBe(false);
    expect(result.bobbyLiveAssignmentCount).toBe(1);
  });

  it.each([
    ['Bobby Paper', [live]],
    ['Bobby Live', [paper]],
  ])('reports missing %s discovery', (_name, accounts) => {
    const result = diagnose({ accounts });
    expect(
      _name === 'Bobby Paper'
        ? result.bobbyPaperAccountDiscovery.status
        : result.bobbyLiveAccountDiscovery.status
    ).toBe('MISSING');
    expect(result.productionBaselineValid).toBe(false);
  });

  it.each([
    ['Bobby Paper', [paper, { ...paper, id: 3 }]],
    ['Bobby Live', [live, { ...live, id: 4 }]],
  ])('reports ambiguous %s discovery', (_name, accounts) => {
    const result = diagnose({ accounts: accounts as MigrationDiagnosticAccount[] });
    expect(
      _name === 'Bobby Paper'
        ? result.bobbyPaperAccountDiscovery.status
        : result.bobbyLiveAccountDiscovery.status
    ).toBe('AMBIGUOUS');
  });

  it.each([
    ['enabled', { enabled: true }],
    ['entriesEnabled', { entriesEnabled: true }],
    ['exitsEnabled', { exitsEnabled: false }],
  ])('rejects %s bootstrap-policy mismatch', (field, overrides) => {
    const result = diagnose({ assignments: [assignment(1, overrides)] });
    expect(result.legacyEnablementParityValid).toBe(false);
    expect(result.legacyEnablementMismatches[0]).toMatchObject({ field });
    expect(result.schemaDropSafe).toBe(false);
  });

  it.each([
    [
      'FIXED_QTY type',
      legacy(1),
      assignment(1, {
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 1,
      }),
    ],
    ['FIXED_QTY value', legacy(1), assignment(1, { fixedQty: 2 })],
    [
      'MAX_NOTIONAL type',
      legacy(1, { sizingType: 'max_notional', sizingValue: 50, sizingValueRaw: '50' }),
      assignment(1),
    ],
    [
      'MAX_NOTIONAL value',
      legacy(1, { sizingType: 'max_notional', sizingValue: 50, sizingValueRaw: '50' }),
      assignment(1, {
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 51,
      }),
    ],
  ])('rejects %s mismatch', (_name, legacyRow, migrated) => {
    const result = diagnose({
      legacySubscriptions: [legacyRow],
      assignments: [migrated],
    });
    expect(result.legacySizingParityValid).toBe(false);
    expect(result.legacySizingMismatches).toHaveLength(1);
  });

  it('reports unknown legacy sizing without certifying fallback', () => {
    const result = diagnose({
      legacySubscriptions: [
        legacy(1, { sizingType: 'mystery', sizingValue: 7, sizingValueRaw: '7' }),
      ],
    });
    expect(result.unknownLegacySizingConversions[0]).toMatchObject({
      rawSizingType: 'mystery',
      rawSizingValue: 7,
      rawSizingValueText: '7',
    });
    expect(result.schemaDropSafe).toBe(false);
  });

  it.each([
    ['broker', legacy(1, { broker: 'other' })],
    ['environment', legacy(1, { brokerMode: 'live' })],
  ])('rejects legacy %s routing mismatch', (_name, legacyRow) => {
    const result = diagnose({ legacySubscriptions: [legacyRow] });
    expect(result.legacyRoutingParityValid).toBe(false);
  });

  it('reports a missing migrated assignment', () => {
    const result = diagnose({
      legacySubscriptions: [legacy(1), legacy(2)],
      assignments: [assignment(1)],
    });
    expect(result.missingLegacyMappings[0]).toMatchObject({ subscriptionId: 2 });
    expect(result.legacyMappingValid).toBe(false);
  });

  it('reports duplicate fixture mappings instead of overwriting them', () => {
    const result = diagnose({
      assignments: [assignment(1), assignment(2, { id: 2, subscriptionId: 1 })],
    });
    expect(result.duplicateLegacyMappings[0]).toMatchObject({
      subscriptionId: 1,
      assignmentIds: [1, 2],
    });
    expect(result.legacyMappingValid).toBe(false);
  });

  it('rejects a cross-account allocation on an active assignment', () => {
    const active = validActiveAssignment(1);
    active.allocation = { ...active.allocation!, tradingAccountId: live.id };
    const result = diagnose({
      legacySubscriptions: [legacy(1, { enabled: true })],
      assignments: [active],
    });
    expect(result.entryConfigurationFailures[0]).toMatchObject({
      reasons: expect.arrayContaining(['ENABLED_SAME_ACCOUNT_ALLOCATION_REQUIRED']),
    });
  });

  it('rejects an active null allocation but allows dormant null allocation', () => {
    const active = assignment(1, {
      enabled: true,
      entriesEnabled: true,
      subscription: { key: 'subscription-1', enabled: true },
    });
    expect(
      diagnose({
        legacySubscriptions: [legacy(1, { enabled: true })],
        assignments: [active],
      }).runtimeEntryReady
    ).toBe(false);
    expect(diagnose({}).runtimeEntryReady).toBe(true);
  });

  it('rejects invalid reservation and aggregate allocation capacity', () => {
    const first = validActiveAssignment(1);
    const second = validActiveAssignment(2);
    first.reservedNotional = 6_000;
    second.reservedNotional = 6_000;
    const result = diagnose({
      legacySubscriptions: [
        legacy(1, { enabled: true }),
        legacy(2, { enabled: true }),
      ],
      assignments: [first, second],
      expectedBobbyPaperKeys: ['subscription-1', 'subscription-2'],
    });
    expect(result.entryConfigurationFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasons: expect.arrayContaining([
            'RESERVATION_EXCEEDS_ALLOCATION_POSITION_LIMIT',
            'ALLOCATION_RESERVATIONS_EXCEED_TOTAL',
          ]),
        }),
      ])
    );
  });

  it.each([
    [
      'account',
      {
        model: 'OrderIntent',
        id: 20,
        tradingAccountSubscriptionId: 1,
        tradingAccountId: live.id,
        subscriptionId: 1,
      },
      'TRADING_ACCOUNT_MISMATCH',
    ],
    [
      'subscription',
      {
        model: 'TrackedPosition',
        id: 21,
        tradingAccountSubscriptionId: 1,
        tradingAccountId: paper.id,
        subscriptionId: 99,
      },
      'SUBSCRIPTION_MISMATCH',
    ],
  ] as const)('rejects lifecycle assignment/%s mismatch', (_name, reference, reason) => {
    const result = diagnose({
      lifecycleReferences: [
        reference as MigrationDiagnosticLifecycleReference,
      ],
    });
    expect(result.lifecycleReferenceFailures[0]).toMatchObject({
      reasons: [reason],
    });
    expect(result.schemaDropSafe).toBe(false);
  });

  it('can be schema-drop safe while runtime is not ready', () => {
    const result = diagnose({
      legacySubscriptions: [legacy(1, { enabled: true })],
      assignments: [
        assignment(1, {
          enabled: true,
          entriesEnabled: true,
          subscription: { key: 'subscription-1', enabled: true },
        }),
      ],
    });
    expect(result.schemaDropSafe).toBe(true);
    expect(result.runtimeEntryReady).toBe(false);
    expect(result.overallDiagnosticPassed).toBe(false);
  });

  it('can be runtime ready while schema drop is unsafe', () => {
    const result = diagnose({
      legacySubscriptions: [legacy(1, { sizingType: 'unknown' })],
    });
    expect(result.runtimeEntryReady).toBe(true);
    expect(result.schemaDropSafe).toBe(false);
    expect(result.overallDiagnosticPassed).toBe(false);
  });

  it('classifies unchanged immediate post-bootstrap state with exact fidelity', () => {
    const result = diagnose({});
    expect(result.initialBootstrapFidelityValid).toBe(true);
    expect(result.legacyMigrationProvenanceValid).toBe(true);
    expect(result.parityClassifications[0]).toMatchObject({
      classification: 'UNCHANGED_FROM_BOOTSTRAP',
    });
  });

  it('accepts confirmed post-creation divergence without preserving exact parity', () => {
    const result = diagnose({
      assignments: [
        assignment(1, {
          enabled: true,
          entriesEnabled: false,
          updatedAt: new Date('2026-07-02T18:00:00.000Z'),
        }),
      ],
    });
    expect(result.initialBootstrapFidelityValid).toBe(false);
    expect(result.parityClassifications[0]).toMatchObject({
      classification: 'CONFIRMED_POST_CREATION_DIVERGENCE',
    });
    expect(result.legacyMigrationProvenanceValid).toBe(true);
    expect(result.schemaDropSafe).toBe(true);
  });

  it('accepts likely authorized divergence when the bootstrap note was cleared', () => {
    const result = diagnose({
      assignments: [
        assignment(1, {
          notes: null,
          enabled: true,
          entriesEnabled: false,
          updatedAt: new Date('2026-07-13T21:45:09.296Z'),
        }),
      ],
    });
    expect(result.parityClassifications[0]).toMatchObject({
      classification: 'LIKELY_AUTHORIZED_DIVERGENCE',
      evidence: {
        hasBootstrapProvenance: false,
        updatedAfterCreation: true,
        currentStateWriterValid: true,
      },
    });
    expect(result.schemaDropSafe).toBe(true);
  });

  it('rejects unexplained divergence', () => {
    const result = diagnose({
      assignments: [
        assignment(1, { enabled: true, entriesEnabled: false }),
      ],
    });
    expect(result.parityClassifications[0]).toMatchObject({
      classification: 'UNEXPLAINED',
    });
    expect(result.legacyMigrationProvenanceValid).toBe(false);
    expect(result.schemaDropSafe).toBe(false);
  });

  it('rejects malformed current sizing independently of entry readiness', () => {
    const result = diagnose({
      assignments: [
        assignment(1, {
          sizingType: PositionSizingType.MAX_NOTIONAL,
          fixedQty: 1,
          maxPositionNotional: 1_000,
          updatedAt: new Date('2026-07-02T18:00:00.000Z'),
        }),
      ],
    });
    expect(result.parityClassifications[0]).toMatchObject({
      classification: 'MALFORMED_CURRENT_STATE',
      evidence: {
        currentStateWriterValid: false,
        currentStateReasons: [
          'MAX_NOTIONAL_REQUIRES_NULL_FIXED_QTY',
        ],
      },
    });
    expect(result.runtimeEntryReady).toBe(true);
    expect(result.schemaDropSafe).toBe(false);
  });

  it('accepts the established restored-backup provenance shape', () => {
    const legacies = Array.from({ length: 100 }, (_, index) =>
      legacy(index + 1)
    );
    const assignments = legacies.map((item) => assignment(item.id));
    const later = new Date('2026-07-18T00:22:38.140Z');
    const allocation = {
      id: 10,
      tradingAccountId: paper.id,
      key: 'configured',
      name: 'Configured',
      enabled: true,
      maxAllocatedNotional: 100_000,
      maxOpenPositions: 100,
      maxPositionNotional: 10_000,
    };

    for (const id of [1, 2, 3, 4, 5]) {
      Object.assign(assignments[id - 1]!, {
        enabled: true,
        entriesEnabled: true,
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 2_500,
        allocationId: allocation.id,
        allocation,
        reservedNotional: 2_500,
        updatedAt: later,
        subscription: { key: `subscription-${id}`, enabled: true },
      });
      legacies[id - 1]!.enabled = true;
    }
    for (const id of [6, 7, 8, 9, 10, 11]) {
      Object.assign(assignments[id - 1]!, {
        enabled: true,
        entriesEnabled: true,
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 1_000,
        allocationId: allocation.id,
        allocation,
        reservedNotional: 1_000,
        updatedAt: later,
        subscription: { key: `subscription-${id}`, enabled: true },
      });
    }
    Object.assign(assignments[11]!, {
      enabled: true,
      entriesEnabled: true,
      sizingType: PositionSizingType.MAX_NOTIONAL,
      fixedQty: null,
      maxPositionNotional: 1_000,
      allocationId: allocation.id,
      allocation,
      reservedNotional: 1_000,
      updatedAt: later,
      subscription: { key: 'subscription-12', enabled: true },
    });
    legacies[11]!.enabled = true;
    for (const id of [13, 14, 15, 16, 17, 18, 19, 20, 21]) {
      legacies[id - 1]!.enabled = true;
      Object.assign(assignments[id - 1]!, {
        enabled: false,
        entriesEnabled: true,
        updatedAt: later,
        subscription: { key: `subscription-${id}`, enabled: true },
      });
    }
    Object.assign(assignments[21]!, {
      notes: null,
      enabled: true,
      entriesEnabled: true,
      sizingType: PositionSizingType.MAX_NOTIONAL,
      fixedQty: null,
      maxPositionNotional: 1_000,
      allocationId: allocation.id,
      allocation,
      reservedNotional: 1_000,
      updatedAt: later,
      subscription: { key: 'subscription-22', enabled: true },
    });
    legacies[21]!.enabled = true;

    const result = diagnose({
      legacySubscriptions: legacies,
      assignments,
      expectedBobbyPaperKeys: legacies.map((item) => item.key),
    });

    expect(result.summary).toMatchObject({
      exactEnablementParityDifferenceCount: 21,
      exactSizingParityDifferenceCount: 13,
      uniqueDivergentAssignmentCount: 22,
    });
    expect(result.divergenceClassificationCounts).toMatchObject({
      CONFIRMED_POST_CREATION_DIVERGENCE: 21,
      LIKELY_AUTHORIZED_DIVERGENCE: 1,
      UNEXPLAINED: 0,
      MALFORMED_CURRENT_STATE: 0,
    });
    expect(result.initialBootstrapFidelityValid).toBe(false);
    expect(result.legacyMigrationProvenanceValid).toBe(true);
    expect(result.schemaDropSafe).toBe(true);
    expect(result.productionBaselineValid).toBe(true);
    expect(result.runtimeEntryReady).toBe(true);
    expect(result.overallDiagnosticPassed).toBe(true);
  });

  it.each([
    ['schema', { legacySubscriptions: [legacy(1, { sizingType: 'unknown' })] }],
    ['baseline', { accounts: [paper] }],
    [
      'runtime',
      {
        legacySubscriptions: [legacy(1, { enabled: true })],
        assignments: [
          assignment(1, {
            enabled: true,
            entriesEnabled: true,
            subscription: { key: 'subscription-1', enabled: true },
          }),
        ],
      },
    ],
  ])('makes overall preflight fail when the %s gate fails', (_name, input) => {
    expect(diagnose(input).overallDiagnosticPassed).toBe(false);
  });
});
