import { describe, expect, it } from 'vitest';
import { subscriptionCatalogQuerySchema } from './algo-admin.schema.js';

describe('subscriptionCatalogQuerySchema', () => {
  it('provides stable catalog pagination and sorting defaults', () => {
    expect(subscriptionCatalogQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 50,
      assignmentStatus: 'all',
      sortBy: 'key',
      sortDirection: 'asc',
    });
  });

  it('coerces pagination, identity, and boolean filters from query strings', () => {
    expect(subscriptionCatalogQuerySchema.parse({
      page: '3',
      pageSize: '100',
      enabled: 'false',
      assignmentStatus: 'assigned',
      assignmentEnabled: 'true',
      entriesEnabled: 'false',
      exitsEnabled: 'true',
      tradingAccountId: '12',
      securityId: '4',
      strategyId: '5',
      exitProfileId: '6',
      sortBy: 'assignmentCount',
      sortDirection: 'desc',
    })).toMatchObject({
      page: 3,
      pageSize: 100,
      enabled: false,
      assignmentStatus: 'assigned',
      assignmentEnabled: true,
      entriesEnabled: false,
      exitsEnabled: true,
      tradingAccountId: 12,
      securityId: 4,
      strategyId: 5,
      exitProfileId: 6,
      sortBy: 'assignmentCount',
      sortDirection: 'desc',
    });
  });

  it('rejects unsafe pagination and unsupported filter values', () => {
    expect(subscriptionCatalogQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(subscriptionCatalogQuerySchema.safeParse({ pageSize: '251' }).success).toBe(false);
    expect(subscriptionCatalogQuerySchema.safeParse({ enabled: 'all' }).success).toBe(false);
  });
});
