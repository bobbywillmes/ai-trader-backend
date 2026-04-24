import { env } from './env.js';

export const tradingConfig = {
  tradingEnabled: true,
  paperMode: env.ALPACA_BASE_URL.includes('paper'),
} as const;