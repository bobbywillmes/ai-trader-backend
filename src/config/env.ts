import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  ALPACA_API_KEY: z.string().min(1, 'ALPACA_API_KEY is required'),
  ALPACA_API_SECRET: z.string().min(1, 'ALPACA_API_SECRET is required'),
  ALPACA_BASE_URL: z.url().default('https://paper-api.alpaca.markets')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;