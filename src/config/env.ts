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

const optionalSessionDate = z.preprocess(value => value === '' ? undefined : value,
  z.string().refine(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, 'Expected a valid YYYY-MM-DD session date.').optional());

const paperBrokerWriteAuthorization = z.object({
  brokerAccountId: z.string().trim().min(1),
  keyFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

const paperBrokerWriteAuthorizations = z.preprocess(value => {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.array(paperBrokerWriteAuthorization));

const paperBrokerWriteOwnership = z.object({
  tradingAccountId: z.number().int().positive(),
  role: z.enum(['OBSERVER', 'EXECUTOR']),
  expectedBrokerAccountId: z.string().trim().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.role === 'EXECUTOR' && value.expectedBrokerAccountId === undefined) {
    context.addIssue({ code: 'custom', path: ['expectedBrokerAccountId'],
      message: 'An EXECUTOR ownership declaration requires the expected Alpaca account_number.' });
  }
});

const paperBrokerWriteOwnerships = z.preprocess(value => {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.array(paperBrokerWriteOwnership));

export const envSchema = z.object({
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
  // Optional until an explicit Tiingo-backed production path is configured.
  TIINGO_API_TOKEN: z.string().min(1).optional(),
  TIINGO_BASE_URL: z.url().default('https://api.tiingo.com'),
  TIINGO_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  TIINGO_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  INTRADAY_STRESS_TIINGO_CUTOVER_SESSION: optionalSessionDate,
  MARKET_DAILY_TIINGO_CUTOVER_SESSION: optionalSessionDate,
  MARKET_DAILY_MASSIVE_RESUME_SESSION: optionalSessionDate,
  BREADTH_V2_SHADOW_WORKER_ENABLED: envBoolean.default(false),
  ORDER_INTENT_MARKET_POLICY_COMPARISON_WORKER_ENABLED: envBoolean.default(false),
  ORDER_INTENT_BROKER_COMPARISON_WORKER_ENABLED: envBoolean.default(false),
  BROKER_OBSERVATION_POOL_MAX: z.coerce.number().int().min(1).max(8).default(2),
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
  ALLOW_LIVE_RISK_REDUCING_WRITES: envBoolean.default(false),
  LIVE_WRITE_DEPLOYMENT_ROLE: z
    .enum(['OBSERVATION_ONLY', 'PRODUCTION_EXECUTOR'])
    .default('OBSERVATION_ONLY'),
  PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: z
    .enum(['OBSERVATION_ONLY', 'PAPER_EXECUTOR'])
    .default('OBSERVATION_ONLY'),
  PAPER_BROKER_WRITE_AUTHORIZATIONS: paperBrokerWriteAuthorizations.default([]),
  PAPER_BROKER_WRITE_OWNERSHIP: paperBrokerWriteOwnerships.default([]),
  ALLOW_TRADING_ENABLED_ON_START: envBoolean.default(false),
}).superRefine((value, context) => {
  if (value.MARKET_DAILY_MASSIVE_RESUME_SESSION !== undefined && value.MARKET_DAILY_TIINGO_CUTOVER_SESSION === undefined) {
    context.addIssue({ code: 'custom', path: ['MARKET_DAILY_MASSIVE_RESUME_SESSION'],
      message: 'MARKET_DAILY_MASSIVE_RESUME_SESSION requires MARKET_DAILY_TIINGO_CUTOVER_SESSION.' });
  } else if (value.MARKET_DAILY_MASSIVE_RESUME_SESSION !== undefined && value.MARKET_DAILY_TIINGO_CUTOVER_SESSION !== undefined
    && value.MARKET_DAILY_MASSIVE_RESUME_SESSION <= value.MARKET_DAILY_TIINGO_CUTOVER_SESSION) {
    context.addIssue({ code: 'custom', path: ['MARKET_DAILY_MASSIVE_RESUME_SESSION'],
      message: 'MARKET_DAILY_MASSIVE_RESUME_SESSION must be later than MARKET_DAILY_TIINGO_CUTOVER_SESSION.' });
  }
  if (value.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR' && value.NODE_ENV !== 'production') {
    context.addIssue({
      code: 'custom',
      path: ['LIVE_WRITE_DEPLOYMENT_ROLE'],
      message: 'PRODUCTION_EXECUTOR is only valid when NODE_ENV=production.',
    });
  }
  const paperIdentities = value.PAPER_BROKER_WRITE_AUTHORIZATIONS.map(
    item => `${item.brokerAccountId}\u0000${item.keyFingerprint}`,
  );
  if (new Set(paperIdentities).size !== paperIdentities.length) {
    context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_AUTHORIZATIONS'],
      message: 'PAPER broker-write authorizations must be unique brokerage identity pairs.' });
  }
  const paperAccounts = value.PAPER_BROKER_WRITE_AUTHORIZATIONS.map(item => item.brokerAccountId);
  const paperFingerprints = value.PAPER_BROKER_WRITE_AUTHORIZATIONS.map(item => item.keyFingerprint);
  if (new Set(paperAccounts).size !== paperAccounts.length) {
    context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_AUTHORIZATIONS'],
      message: 'A PAPER brokerage account may have only one authorized credential fingerprint.' });
  }
  if (new Set(paperFingerprints).size !== paperFingerprints.length) {
    context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_AUTHORIZATIONS'],
      message: 'A PAPER credential fingerprint may authorize only one brokerage account.' });
  }
  if (value.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'OBSERVATION_ONLY' && paperIdentities.length > 0) {
    context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_AUTHORIZATIONS'],
      message: 'OBSERVATION_ONLY cannot declare PAPER broker-write authorizations.' });
  }
  if (value.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'PAPER_EXECUTOR' && paperIdentities.length === 0) {
    context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_AUTHORIZATIONS'],
      message: 'PAPER_EXECUTOR requires at least one exact brokerage identity authorization.' });
  }
  const ownershipAccountIds = value.PAPER_BROKER_WRITE_OWNERSHIP.map(item => item.tradingAccountId);
  if (new Set(ownershipAccountIds).size !== ownershipAccountIds.length) {
    context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_OWNERSHIP'],
      message: 'A TradingAccount may have only one PAPER ownership declaration.' });
  }
  const executorBrokerIds = value.PAPER_BROKER_WRITE_OWNERSHIP
    .filter(item => item.role === 'EXECUTOR').map(item => item.expectedBrokerAccountId!);
  if (new Set(executorBrokerIds).size !== executorBrokerIds.length) {
    context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_OWNERSHIP'],
      message: 'An Alpaca PAPER account_number may have only one expected executor.' });
  }
  const authorizationBrokerIds = value.PAPER_BROKER_WRITE_AUTHORIZATIONS.map(item => item.brokerAccountId);
  const executorBrokerIdSet = new Set(executorBrokerIds);
  const authorizationBrokerIdSet = new Set(authorizationBrokerIds);
  for (const brokerAccountId of executorBrokerIdSet) {
    if (!authorizationBrokerIdSet.has(brokerAccountId)) {
      context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_AUTHORIZATIONS'],
        message: `EXECUTOR ownership for ${brokerAccountId} requires one matching broker-write authorization.` });
    }
  }
  for (const brokerAccountId of authorizationBrokerIdSet) {
    if (!executorBrokerIdSet.has(brokerAccountId)) {
      context.addIssue({ code: 'custom', path: ['PAPER_BROKER_WRITE_AUTHORIZATIONS'],
        message: `PAPER broker-write authorization for ${brokerAccountId} requires one matching EXECUTOR ownership declaration.` });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
