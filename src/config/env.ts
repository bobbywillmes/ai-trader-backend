import 'dotenv/config';
import { z } from 'zod';

const envBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off', ''].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:4173'),

  ALPACA_API_KEY: z.string().min(1, 'ALPACA_API_KEY is required'),
  ALPACA_API_SECRET: z.string().min(1, 'ALPACA_API_SECRET is required'),
  ALPACA_BASE_URL: z.url().default('https://paper-api.alpaca.markets'),
  ALPACA_API_USAGE_WARNING_REQUESTS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(120),
  ALPACA_API_USAGE_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30),
  DEFAULT_TRADING_ACCOUNT_ID: z.coerce.number().int().min(1).optional(),
  TRADING_CREDENTIAL_ENCRYPTION_KEY: z.string().min(1).optional(),
  TRADING_CREDENTIAL_ENCRYPTION_KEY_ID: z.string().min(1).optional(),

  MASSIVE_API_KEY: z.string().min(1, 'MASSIVE_API_KEY is required'),
  MASSIVE_BASE_URL: z.url().default('https://api.massive.com'),
  MASSIVE_NEWS_WORKER_ENABLED: envBoolean.default(false),
  MASSIVE_NEWS_WORKER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(60_000),
  MASSIVE_NEWS_LOOKBACK_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(240),
  MASSIVE_NEWS_LIMIT_PER_SYMBOL: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(50),
  MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(5),
  MOMENTUM_CONFIRMATION_MIN_PRICE: z.coerce
    .number()
    .positive()
    .default(5),
  MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME: z.coerce
    .number()
    .positive()
    .default(5_000_000),
  MOMENTUM_CONFIRMATION_WATCHING_THRESHOLD: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(60),
  MOMENTUM_CONFIRMATION_ENTRY_READY_THRESHOLD: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(80),
  MOMENTUM_CONFIRMATION_MAX_SYMBOLS_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),
  MOMENTUM_CONFIRMATION_RECENT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(30),
  MOMENTUM_CONFIRMATION_LOOKBACK_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(390),
  MOMENTUM_CONFIRMATION_MAX_PCT_FROM_PREV_CLOSE: z.coerce
    .number()
    .positive()
    .default(20),
  MOMENTUM_HANDOFF_MIN_SCORE: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(80),
  MOMENTUM_HANDOFF_MAX_CANDIDATES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),
  MOMENTUM_HANDOFF_PAYLOAD_VERSION: z.string().min(1).default('v1'),

  AI_TRADER_SIGNAL_API_KEY: z
    .string()
    .min(16, 'AI_TRADER_SIGNAL_API_KEY must be at least 16 characters'),

  AI_TRADER_ADMIN_API_KEY: z
    .string()
    .min(16, 'AI_TRADER_ADMIN_API_KEY must be at least 16 characters'),

  // Production safety overrides.
  //
  // Keep both false for the first production launch.
  // Set explicitly only when you intentionally want production startup to allow
  // live trading mode or an already-enabled trading system.
  ALLOW_LIVE_TRADING: envBoolean.default(false),
  ALLOW_TRADING_ENABLED_ON_START: envBoolean.default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
