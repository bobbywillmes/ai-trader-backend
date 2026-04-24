import { getRuntimeTradingConfig } from './config.service.js';
import { getNormalizedAccount } from './account.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { getNormalizedOpenOrders } from './orders.service.js';

export async function getBootstrapData() {
  const [account, positions, openOrders, runtimeConfig] = await Promise.all([
    getNormalizedAccount(),
    getNormalizedPositions(),
    getNormalizedOpenOrders(),
    getRuntimeTradingConfig()
  ]);

  return {
    account,
    positions,
    openOrders,
    config: runtimeConfig,
    risk: {
      canTrade: runtimeConfig.tradingEnabled && !account.tradingBlocked,
      reason: runtimeConfig.tradingEnabled
        ? account.tradingBlocked
          ? 'Broker account is trading blocked.'
          : null
        : 'Trading is disabled.'
    }
  };
}