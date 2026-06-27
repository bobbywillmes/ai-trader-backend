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

  MASSIVE_API_KEY: z.string().min(1, 'MASSIVE_API_KEY is required'),
  MASSIVE_BASE_URL: z.url().default('https://api.massive.com'),

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
