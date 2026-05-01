import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  ALPACA_API_KEY: z.string().min(1, 'ALPACA_API_KEY is required'),
  ALPACA_API_SECRET: z.string().min(1, 'ALPACA_API_SECRET is required'),
  ALPACA_BASE_URL: z.url().default('https://paper-api.alpaca.markets'),

  AI_TRADER_SIGNAL_API_KEY: z.string().min(16, 'AI_TRADER_SIGNAL_API_KEY must be at least 16 characters'),
  AI_TRADER_ADMIN_API_KEY: z.string().min(16, 'AI_TRADER_ADMIN_API_KEY must be at least 16 characters'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;