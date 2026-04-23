import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { getAlpacaPositions } from '../integrations/alpaca/positions.adapter.js';

export async function getBootstrapData() {
  const [account, positions, openOrders] = await Promise.all([
    getAlpacaAccount(),
    getAlpacaPositions(),
    getOpenAlpacaOrders()
  ]);

  return {
    account,
    positions,
    openOrders,
    config: {
      tradingEnabled: true,
      paperMode: true,
      allowedTickers: ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP', 'AAPL', 'AMZN', 'GOOG', 'META', 'MSFT']
    },
    risk: {
      canTrade: true,
      reason: null
    }
  };
}