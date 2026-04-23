import { getNormalizedAccount } from './account.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { getNormalizedOpenOrders } from './orders.service.js';

export async function getBootstrapData() {
  const [account, positions, openOrders] = await Promise.all([
    getNormalizedAccount(),
    getNormalizedPositions(),
    getNormalizedOpenOrders()
  ]);

  return {
    account,
    positions,
    openOrders,
    config: {
      tradingEnabled: true,
      paperMode: true,
      allowedTickers: [
        'SPY',
        'QQQ',
        'DIA',
        'IWM',
        'RSP',
        'AAPL',
        'AMZN',
        'GOOG',
        'META',
        'MSFT'
      ]
    },
    risk: {
      canTrade: true,
      reason: null as string | null
    }
  };
}