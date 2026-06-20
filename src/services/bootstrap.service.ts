import { getRuntimeTradingConfig } from './config.service.js';
import { getNormalizedAccount } from './account.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { getNormalizedOpenOrders } from './orders.service.js';
import { getRiskStatus } from './risk-gate.service.js';

export async function getBootstrapData() {
  const [account, positions, openOrders, runtimeConfig, risk] =
    await Promise.all([
      getNormalizedAccount('bootstrap_snapshot'),
      getNormalizedPositions('bootstrap_snapshot'),
      getNormalizedOpenOrders('bootstrap_snapshot'),
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
