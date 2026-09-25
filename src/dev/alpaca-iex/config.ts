export type DataConfig = { key: string; secret: string; feed: 'iex' };
/** Deliberately independent from application env and all account-owned credentials. */
export function parseConfig(env: Record<string, string | undefined>): DataConfig {
  const key = env.ALPACA_MARKET_DATA_API_KEY?.trim();
  const secret = env.ALPACA_MARKET_DATA_API_SECRET?.trim();
  if (!key || !secret) throw new Error('ALPACA_MARKET_DATA_API_KEY and ALPACA_MARKET_DATA_API_SECRET are required');
  if (env.ALPACA_MARKET_DATA_FEED !== 'iex') throw new Error('ALPACA_MARKET_DATA_FEED must equal iex');
  return { key, secret, feed: 'iex' };
}
