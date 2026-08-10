import { PlatformRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  eventCount: vi.fn(),
  membershipFindUnique: vi.fn(),
}));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    systemEvent: { findMany: mocks.eventFindMany, count: mocks.eventCount },
    tradingAccountMembership: { findUnique: mocks.membershipFindUnique },
  },
}));
vi.mock('../config/logger.js', () => ({ logger: { trace: vi.fn() } }));
vi.mock('./trading-account.service.js', () => ({
  TRADING_ACCOUNT_SUMMARY_SELECT: { id: true, displayName: true, environment: true },
}));

import { getAccessibleSystemEvents } from './system-event.service.js';

describe('scoped system events', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.eventCount.mockResolvedValue(0);
  });

  it('uses exact attribution for a selected authorized account', async () => {
    mocks.membershipFindUnique.mockResolvedValue({ id: 1 });
    await getAccessibleSystemEvents(
      { id: 5, platformRole: PlatformRole.OPERATOR },
      7
    );
    expect(mocks.eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tradingAccountId: 7 } })
    );
  });

  it('includes attributed and null global events for owner ALL', async () => {
    await getAccessibleSystemEvents(
      { id: 1, platformRole: PlatformRole.SYSTEM_OWNER },
      null
    );
    expect(mocks.eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  it('limits operator ALL to membership-attributed events and excludes globals', async () => {
    await getAccessibleSystemEvents(
      { id: 5, platformRole: PlatformRole.OPERATOR },
      null
    );
    expect(mocks.eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tradingAccount: { memberships: { some: { userId: 5 } } } },
      })
    );
  });
});
