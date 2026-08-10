import { PlatformRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  membershipFindUnique: vi.fn(),
  membershipFindMany: vi.fn(),
  accountFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountMembership: {
      findUnique: mocks.membershipFindUnique,
      findMany: mocks.membershipFindMany,
    },
    tradingAccount: { findMany: mocks.accountFindMany },
  },
}));

import { resolveReportAccountIds } from './report-scope.service.js';

describe('report account authorization', () => {
  beforeEach(() => vi.resetAllMocks());

  it('allows an owner to select any account and ALL accounts', async () => {
    const owner = { id: 1, platformRole: PlatformRole.SYSTEM_OWNER };
    expect(await resolveReportAccountIds(owner, 9)).toEqual([9]);
    mocks.accountFindMany.mockResolvedValue([{ id: 2 }, { id: 9 }]);
    expect(await resolveReportAccountIds(owner, null)).toEqual([2, 9]);
  });

  it('limits an operator ALL scope to memberships', async () => {
    const operator = { id: 4, platformRole: PlatformRole.OPERATOR };
    mocks.membershipFindMany.mockResolvedValue([
      { tradingAccountId: 3 },
      { tradingAccountId: 8 },
    ]);
    expect(await resolveReportAccountIds(operator, null)).toEqual([3, 8]);
  });

  it('rejects an inaccessible selected account', async () => {
    mocks.membershipFindUnique.mockResolvedValue(null);
    await expect(
      resolveReportAccountIds({ id: 4, platformRole: PlatformRole.OPERATOR }, 12)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
