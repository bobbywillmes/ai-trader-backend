import { tradingConfig } from '../config/trading.js';
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
      tradingEnabled: tradingConfig.tradingEnabled,
      paperMode: tradingConfig.paperMode,
      allowedTickers: [...tradingConfig.allowedTickers]
    },
    risk: {
      canTrade: tradingConfig.tradingEnabled && !account.tradingBlocked,
      reason: tradingConfig.tradingEnabled
        ? account.tradingBlocked
          ? 'Broker account is trading blocked.'
          : null
        : 'Trading is disabled.'
    }
  };
}