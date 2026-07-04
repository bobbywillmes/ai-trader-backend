export type WorkerCriticality = 'critical' | 'important' | 'informational';

export type WorkerDefinition = {
  key: string;
  displayName: string;
  description: string;
  criticality: WorkerCriticality;
  expectedIntervalMs: number;
  startupGraceMs: number;
  delayedAfterMs: number;
  staleAfterMs: number;
  maxRunDurationMs: number;
  enabledByDefault: boolean;
};

export const TRADING_WORKER_INTERVAL_MS = 2_000;
export const ACCOUNT_SNAPSHOT_WORKER_INTERVAL_MS = 60_000;
export const BROKER_ACTIVITY_WORKER_INTERVAL_MS = 60_000;
export const RECONCILIATION_SCHEDULER_INTERVAL_MS = 60_000;
export const ALPACA_API_USAGE_PERSISTENCE_INTERVAL_MS = 60_000;
export const MASSIVE_NEWS_WORKER_INTERVAL_MS = 60_000;

function thresholds(
  expectedIntervalMs: number,
  maxRunDurationMs: number
): Pick<
  WorkerDefinition,
  'startupGraceMs' | 'delayedAfterMs' | 'staleAfterMs' | 'maxRunDurationMs'
> {
  return {
    startupGraceMs: Math.max(expectedIntervalMs * 3, 15_000),
    delayedAfterMs: Math.max(Math.round(expectedIntervalMs * 2.5), 15_000),
    staleAfterMs: Math.max(expectedIntervalMs * 5, 60_000),
    maxRunDurationMs,
  };
}

export const workerDefinitions = [
  {
    key: 'pending_order_processing',
    displayName: 'Pending order processing',
    description: 'Claims pending order intents and submits eligible broker orders.',
    criticality: 'critical',
    expectedIntervalMs: TRADING_WORKER_INTERVAL_MS,
    enabledByDefault: true,
    ...thresholds(TRADING_WORKER_INTERVAL_MS, 20_000),
  },
  {
    key: 'submitted_order_sync',
    displayName: 'Submitted order sync',
    description: 'Refreshes locally submitted order status from broker open orders.',
    criticality: 'critical',
    expectedIntervalMs: TRADING_WORKER_INTERVAL_MS,
    enabledByDefault: true,
    ...thresholds(TRADING_WORKER_INTERVAL_MS, 20_000),
  },
  {
    key: 'tracked_position_sync',
    displayName: 'Tracked position sync',
    description: 'Mirrors broker positions into tracked position lifecycle state.',
    criticality: 'critical',
    expectedIntervalMs: TRADING_WORKER_INTERVAL_MS,
    enabledByDefault: true,
    ...thresholds(TRADING_WORKER_INTERVAL_MS, 45_000),
  },
  {
    key: 'exit_evaluation',
    displayName: 'Exit evaluation',
    description: 'Evaluates open tracked positions against configured exit rules.',
    criticality: 'critical',
    expectedIntervalMs: TRADING_WORKER_INTERVAL_MS,
    enabledByDefault: true,
    ...thresholds(TRADING_WORKER_INTERVAL_MS, 30_000),
  },
  {
    key: 'account_snapshot_scheduler',
    displayName: 'Account snapshot scheduler',
    description: 'Checks whether scheduled account snapshot checkpoints are due.',
    criticality: 'important',
    expectedIntervalMs: ACCOUNT_SNAPSHOT_WORKER_INTERVAL_MS,
    enabledByDefault: true,
    ...thresholds(ACCOUNT_SNAPSHOT_WORKER_INTERVAL_MS, 30_000),
  },
  {
    key: 'broker_activity_sync',
    displayName: 'Broker activity sync',
    description: 'Imports broker-confirmed fill activities into the local ledger.',
    criticality: 'critical',
    expectedIntervalMs: BROKER_ACTIVITY_WORKER_INTERVAL_MS,
    enabledByDefault: true,
    ...thresholds(BROKER_ACTIVITY_WORKER_INTERVAL_MS, 90_000),
  },
  {
    key: 'scheduled_reconciliation',
    displayName: 'Scheduled reconciliation',
    description: 'Runs optional broker/backend reconciliation checks when due.',
    criticality: 'important',
    expectedIntervalMs: RECONCILIATION_SCHEDULER_INTERVAL_MS,
    enabledByDefault: false,
    ...thresholds(RECONCILIATION_SCHEDULER_INTERVAL_MS, 120_000),
  },
  {
    key: 'alpaca_api_usage_persistence',
    displayName: 'Alpaca API usage persistence',
    description: 'Flushes in-memory Alpaca API usage aggregates and applies retention.',
    criticality: 'informational',
    expectedIntervalMs: ALPACA_API_USAGE_PERSISTENCE_INTERVAL_MS,
    enabledByDefault: true,
    ...thresholds(ALPACA_API_USAGE_PERSISTENCE_INTERVAL_MS, 30_000),
  },
  {
    key: 'massive_news_ingestion',
    displayName: 'Massive news ingestion',
    description: 'Polls Massive reference news for watched stock symbols and stores catalyst events.',
    criticality: 'informational',
    expectedIntervalMs: MASSIVE_NEWS_WORKER_INTERVAL_MS,
    enabledByDefault: false,
    ...thresholds(MASSIVE_NEWS_WORKER_INTERVAL_MS, 120_000),
  },
] as const satisfies readonly WorkerDefinition[];

export type WorkerKey = (typeof workerDefinitions)[number]['key'];

export function getWorkerDefinition(key: WorkerKey): WorkerDefinition {
  const definition = workerDefinitions.find((worker) => worker.key === key);

  if (!definition) {
    throw new Error(`Unknown worker definition: ${key}`);
  }

  return definition;
}
