import { getRuntimeTradingConfig } from './config.service.js';
import { getNormalizedAccount } from './account.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { getNormalizedOpenOrders } from './orders.service.js';
import { getRiskStatus } from './risk-gate.service.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';

export async function getBootstrapData() {
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const [account, positions, openOrders, runtimeConfig, risk] =
    await Promise.all([
      getNormalizedAccount('bootstrap_snapshot', { tradingAccountId }),
      getNormalizedPositions('bootstrap_snapshot', { tradingAccountId }),
      getNormalizedOpenOrders('bootstrap_snapshot', { tradingAccountId }),
      getRuntimeTradingConfig(),
      getRiskStatus(),
    ]);

  return {
    account,
    positions,
    openOrders,
    config: runtimeConfig,
    risk,
  };
}
