import { PlatformRole } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

export async function resolveReportAccountIds(
  user: { id: number; platformRole: PlatformRole },
  accountId: number | null
) {
  if (user.platformRole === PlatformRole.ACCOUNT_USER) {
    throw new HttpError(403, 'Admin-console reports are not available to account portal users.');
  }
  if (accountId !== null) {
    if (user.platformRole !== PlatformRole.SYSTEM_OWNER) {
      const membership = await prisma.tradingAccountMembership.findUnique({
        where: { tradingAccountId_userId: { tradingAccountId: accountId, userId: user.id } },
        select: { id: true },
      });
      if (!membership) throw new HttpError(403, 'Access to this trading account is not permitted.');
    }
    return [accountId];
  }
  if (user.platformRole === PlatformRole.SYSTEM_OWNER) {
    return (await prisma.tradingAccount.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(({ id }) => id);
  }
  return (await prisma.tradingAccountMembership.findMany({ where: { userId: user.id }, select: { tradingAccountId: true }, orderBy: { tradingAccountId: 'asc' } })).map(({ tradingAccountId }) => tradingAccountId);
}
