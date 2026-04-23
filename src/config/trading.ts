import { env } from './env.js';

export const tradingConfig = {
  tradingEnabled: true,
  paperMode: env.ALPACA_BASE_URL.includes('paper'),
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
} as const;