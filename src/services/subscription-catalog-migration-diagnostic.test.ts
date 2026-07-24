import {
  PositionSizingType,
  TradingAccountEnvironment,
  TradingBroker,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  buildSubscriptionCatalogMigrationDiagnostic,
  type LegacySubscriptionMapping,
  type MigrationDiagnosticAccount,
  type MigrationDiagnosticAssignment,
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
  });
}

describe('subscription catalog migration diagnostic', () => {
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
