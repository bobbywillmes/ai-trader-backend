import { PlatformRole, SystemEventSeverity } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  eventCount: vi.fn(),
  eventCreate: vi.fn(),
  membershipFindUnique: vi.fn(),
}));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    systemEvent: { findMany: mocks.eventFindMany, count: mocks.eventCount, create: mocks.eventCreate },
    tradingAccountMembership: { findUnique: mocks.membershipFindUnique },
  },
}));
vi.mock('../config/logger.js', () => ({ logger: { trace: vi.fn() } }));
vi.mock('./trading-account.service.js', () => ({
  TRADING_ACCOUNT_SUMMARY_SELECT: { id: true, displayName: true, environment: true },
}));

import { createSystemEvent, getAccessibleSystemEvents } from './system-event.service.js';

describe('scoped system events', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.eventFindMany.mockResolvedValue([]);
    mocks.eventCount.mockResolvedValue(0);
    mocks.eventCreate.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
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

  it('persists INFO by default without assigning the deprecated processed flag', async () => {
    await createSystemEvent({ type: 'position.opened', entityType: 'trackedPosition', entityId: 1, payloadJson: {} });
    expect(mocks.eventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ severity: SystemEventSeverity.INFO }) });
    expect(mocks.eventCreate.mock.calls[0]?.[0].data).not.toHaveProperty('processed');
  });

  it('persists explicit severity and supports a transaction-scoped writer', async () => {
    const create = vi.fn().mockResolvedValue({ id: 2 });
    await createSystemEvent({ type: 'test.failed', entityType: 'test', entityId: 2, severity: SystemEventSeverity.ERROR, payloadJson: {} }, { systemEvent: { create } } as never);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ severity: SystemEventSeverity.ERROR }) });
  });

  it('filters by persisted severity and selects no processed field', async () => {
    await getAccessibleSystemEvents({ id: 1, platformRole: PlatformRole.SYSTEM_OWNER }, null, { severity: SystemEventSeverity.CRITICAL });
    expect(mocks.eventFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { severity: SystemEventSeverity.CRITICAL },
      select: expect.not.objectContaining({ processed: true }),
    }));
  });
});
