import { CatalystSource, MomentumUniverseReason } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  memberCount: vi.fn(),
  memberCreate: vi.fn(),
  memberDelete: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  cursorFindMany: vi.fn(),
  securityFindUnique: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    momentumUniverseMember: {
      count: mocks.memberCount,
      create: mocks.memberCreate,
      delete: mocks.memberDelete,
      findMany: mocks.memberFindMany,
      findUnique: mocks.memberFindUnique,
      update: mocks.memberUpdate,
    },
    newsPullCursor: { findMany: mocks.cursorFindMany },
    security: { findUnique: mocks.securityFindUnique },
  },
}));

import {
  createMomentumUniverseMember,
  deleteMomentumUniverseMember,
  listMomentumUniverseMembers,
  updateMomentumUniverseMember,
} from './momentum-universe.service.js';

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member-1',
    securityId: 1,
    enabled: true,
    priority: 5,
    newsEnabled: true,
    priceScanningEnabled: true,
    pullIntervalMin: 15,
    addedReason: MomentumUniverseReason.MANUAL,
    notes: null,
    metadata: null,
    createdAt: new Date('2026-07-10T00:00:00Z'),
    updatedAt: new Date('2026-07-10T00:00:00Z'),
    security: {
      id: 1,
      symbol: 'AAPL',
      name: 'Apple Inc',
      enabled: true,
      assetType: 'STOCK',
      sector: 'Information Technology',
      industry: 'Hardware',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      _count: { subscriptions: 2 },
      subscriptions: [],
    },
    ...overrides,
  };
}

describe('momentum universe service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (queries: Promise<unknown>[]) =>
      Promise.all(queries)
    );
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.memberCount.mockResolvedValue(0);
    mocks.cursorFindMany.mockResolvedValue([]);
  });

  it('lists members with enabled and security search filters plus cursor health', async () => {
    mocks.memberFindMany.mockResolvedValue([member()]);
    mocks.memberCount.mockResolvedValue(1);
    mocks.cursorFindMany.mockResolvedValue([
      {
        symbol: 'AAPL',
        source: CatalystSource.MASSIVE_NEWS,
        enabled: true,
        lastPulledAt: new Date('2026-07-10T01:00:00Z'),
        lastPublishedAt: new Date('2026-07-10T00:55:00Z'),
        consecutiveErrors: 0,
        lastError: null,
      },
    ]);

    await expect(
      listMomentumUniverseMembers({
        enabled: true,
        search: 'apple',
        page: 1,
        pageSize: 25,
      })
    ).resolves.toMatchObject({
      data: [
        {
          id: 'member-1',
          subscriptionCount: 2,
          momentumSubscriptionEligibility: { eligible: false, reasons: ['NO_SUBSCRIPTION'] },
          security: { symbol: 'AAPL', name: 'Apple Inc' },
          cursor: { source: CatalystSource.MASSIVE_NEWS, enabled: true },
        },
      ],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    });

    expect(mocks.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          enabled: true,
          security: {
            OR: [
              { symbol: { contains: 'apple', mode: 'insensitive' } },
              { name: { contains: 'apple', mode: 'insensitive' } },
            ],
          },
        },
        skip: 0,
        take: 25,
      })
    );
  });

  it('rejects a missing security when adding membership', async () => {
    mocks.securityFindUnique.mockResolvedValue(null);

    await expect(
      createMomentumUniverseMember({ securityId: 999 })
    ).rejects.toMatchObject({ statusCode: 404, message: 'Security not found.' });

    expect(mocks.memberCreate).not.toHaveBeenCalled();
  });

  it('prevents duplicate universe membership', async () => {
    mocks.securityFindUnique.mockResolvedValue({ id: 1 });
    mocks.memberFindUnique.mockResolvedValue({ id: 'member-1' });

    await expect(
      createMomentumUniverseMember({ securityId: 1 })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Security is already a momentum universe member.',
    });

    expect(mocks.memberCreate).not.toHaveBeenCalled();
  });

  it('adds an existing security with validated scanner settings', async () => {
    mocks.securityFindUnique.mockResolvedValue({ id: 1 });
    mocks.memberFindUnique.mockResolvedValue(null);
    mocks.memberCreate.mockResolvedValue(member({ pullIntervalMin: 30 }));

    await expect(
      createMomentumUniverseMember({
        securityId: 1,
        pullIntervalMin: 30,
        newsEnabled: false,
      })
    ).resolves.toMatchObject({ id: 'member-1', pullIntervalMin: 30 });

    expect(mocks.memberCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          securityId: 1,
          pullIntervalMin: 30,
          newsEnabled: false,
        },
      })
    );
  });

  it('updates membership controls without changing its security', async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: 'member-1' });
    mocks.memberUpdate.mockResolvedValue(member({ enabled: false, priority: 10 }));

    await updateMomentumUniverseMember('member-1', {
      enabled: false,
      priority: 10,
      notes: 'Paused for review',
    });

    expect(mocks.memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'member-1' },
        data: {
          enabled: false,
          priority: 10,
          notes: 'Paused for review',
        },
      })
    );
  });

  it('hard deletes only an existing membership', async () => {
    mocks.memberFindUnique.mockResolvedValue(member());
    mocks.memberDelete.mockResolvedValue(member());

    await expect(deleteMomentumUniverseMember('member-1')).resolves.toMatchObject({
      id: 'member-1',
      security: { symbol: 'AAPL' },
    });

    expect(mocks.memberDelete).toHaveBeenCalledWith({ where: { id: 'member-1' } });
  });
});
