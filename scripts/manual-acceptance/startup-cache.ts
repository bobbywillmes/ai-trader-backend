const SYNTHETIC_ACCOUNT_NAME = 'Synthetic Live Acceptance';
const CLOCK_SETTING_KEY_PREFIX = 'alpacaMarketClockCache';

type StartupCacheDb = {
  tradingAccount: {
    findFirst(args: unknown): Promise<{ id: number } | null>;
  };
  setting: {
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
};

export async function clearSyntheticAcceptanceMarketClockCache(db: StartupCacheDb) {
  const account = await db.tradingAccount.findFirst({
    where: { displayName: SYNTHETIC_ACCOUNT_NAME },
    select: { id: true },
  });

  if (!account) {
    throw new Error('Synthetic Live Acceptance account was not found.');
  }

  const key = `${CLOCK_SETTING_KEY_PREFIX}:${account.id}`;
  const result = await db.setting.deleteMany({ where: { key } });

  return { accountId: account.id, key, deleted: result.count };
}
