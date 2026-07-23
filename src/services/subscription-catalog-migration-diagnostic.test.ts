import {
  PositionSizingType,
  TradingAccountEnvironment,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  buildSubscriptionCatalogMigrationDiagnostic,
  type LegacySubscriptionMapping,
  type MigrationDiagnosticAccount,
  type MigrationDiagnosticAssignment,
} from './subscription-catalog-migration-diagnostic.js';

const paper: MigrationDiagnosticAccount = {
  id: 1,
  displayName: 'Bobby Paper',
  environment: TradingAccountEnvironment.PAPER,
  maxDeployableNotional: 100_000,
};
const live: MigrationDiagnosticAccount = {
  id: 2,
  displayName: 'Bobby Live',
  environment: TradingAccountEnvironment.LIVE,
  maxDeployableNotional: null,
};

function legacy(id: number): LegacySubscriptionMapping {
  return {
    id,
    tradingAccountId: paper.id,
    enabled: true,
    key: `subscription-${id}`,
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
      enabled: true,
    },
    allocation: null,
    ...overrides,
  };
}

function diagnose(values: {
  legacySubscriptions?: LegacySubscriptionMapping[];
  assignments?: MigrationDiagnosticAssignment[];
}) {
  return buildSubscriptionCatalogMigrationDiagnostic({
    accounts: [paper, live],
    legacySubscriptions: values.legacySubscriptions ?? [],
    assignments: values.assignments ?? [],
  });
}

describe('buildSubscriptionCatalogMigrationDiagnostic', () => {
  it('derives and validates all 100 mapped catalog definitions without a fixed expected count', () => {
    const legacySubscriptions = Array.from({ length: 100 }, (_, index) =>
      legacy(index + 1)
    );
    const assignments = legacySubscriptions.map((item) =>
      assignment(item.id)
    );

    const result = diagnose({ legacySubscriptions, assignments });

    expect(result.expectedLegacyMappingCount).toBe(100);
    expect(result.mappedLegacyAssignmentCount).toBe(100);
    expect(result.bobbyPaperAssignmentCount).toBe(100);
    expect(result.safeToDropLegacyFields).toBe(true);
    expect(result.productionBaselineValid).toBe(true);
  });

  it('allows retired and disabled assignments to retain valid sizing without an allocation', () => {
    const result = diagnose({
      legacySubscriptions: [legacy(1), legacy(2)],
      assignments: [
        assignment(1, {
          subscription: { key: 'retired', enabled: false },
          enabled: true,
          entriesEnabled: true,
        }),
        assignment(2, { enabled: false, entriesEnabled: false }),
      ],
    });

    expect(result.invalidMigratedSizing).toEqual([]);
    expect(result.entryCapableAssignmentCount).toBe(0);
    expect(result.entryConfigurationValid).toBe(true);
    expect(result.safeToDropLegacyFields).toBe(true);
  });

  it('requires allocation, reservation, sizing, and risk configuration for active entries', () => {
    const result = diagnose({
      legacySubscriptions: [legacy(1)],
      assignments: [
        assignment(1, {
          enabled: true,
          entriesEnabled: true,
          fixedQty: null,
        }),
      ],
    });

    expect(result.entryConfigurationValid).toBe(false);
    expect(result.entryConfigurationFailures[0]).toMatchObject({
      subscriptionKey: 'subscription-1',
      globalCatalogEnabled: true,
      enabled: true,
      entriesEnabled: true,
      exitsEnabled: true,
      allocationId: null,
      allocation: null,
      reasons: expect.arrayContaining([
        'ALLOCATION_REQUIRED',
        'RESERVED_NOTIONAL_REQUIRED',
        'FIXED_QTY_REQUIRES_POSITIVE_FIXED_QTY',
      ]),
    });
  });

  it('reports missing legacy mappings with the account and catalog identity', () => {
    const result = diagnose({
      legacySubscriptions: [legacy(1), legacy(2)],
      assignments: [assignment(1)],
    });

    expect(result.missingLegacyMappings).toEqual([
      expect.objectContaining({
        subscriptionId: 2,
        subscriptionKey: 'subscription-2',
        legacyTradingAccountId: paper.id,
        account: paper,
        enabled: null,
        entriesEnabled: null,
        exitsEnabled: null,
        allocationId: null,
        allocation: null,
      }),
    ]);
    expect(result.legacyMappingValid).toBe(false);
    expect(result.safeToDropLegacyFields).toBe(false);
  });

  it('rejects invalid sizing on mapped legacy assignments even when entries are disabled', () => {
    const result = diagnose({
      legacySubscriptions: [legacy(1)],
      assignments: [assignment(1, { fixedQty: 0 })],
    });

    expect(result.invalidMigratedSizing[0]).toMatchObject({
      subscriptionKey: 'subscription-1',
      reasons: ['FIXED_QTY_REQUIRES_POSITIVE_FIXED_QTY'],
    });
    expect(result.migratedSizingValid).toBe(false);
    expect(result.safeToDropLegacyFields).toBe(false);
  });

  it('requires Bobby Live to have zero assignments', () => {
    const result = diagnose({
      assignments: [
        assignment(1, {
          tradingAccountId: live.id,
          subscriptionId: 20,
          subscription: { key: 'live-assignment', enabled: false },
        }),
      ],
    });

    expect(result.bobbyLiveAssignmentCount).toBe(1);
    expect(result.bobbyLiveAssignmentsValid).toBe(false);
    expect(result.productionBaselineValid).toBe(false);
  });
});
