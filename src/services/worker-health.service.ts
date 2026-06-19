import crypto from 'node:crypto';

import {
  type WorkerDefinition,
  type WorkerKey,
  workerDefinitions,
} from '../workers/worker-health.definitions.js';

export type WorkerOutcome = 'success' | 'idle' | 'skipped' | 'failed';
export type WorkerSkipReason = 'disabled' | 'not_due' | 'already_running';
export type WorkerStatus =
  | 'disabled'
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'delayed'
  | 'stale'
  | 'failing';
export type WorkerStatusReason =
  | 'disabled'
  | 'within_startup_grace'
  | 'recent_success'
  | 'recent_skip'
  | 'consecutive_failures'
  | 'heartbeat_delayed'
  | 'heartbeat_overdue'
  | 'never_succeeded'
  | 'run_timeout';

export type WorkerTickResult = {
  outcome?: Exclude<WorkerOutcome, 'failed'>;
  skipReason?: WorkerSkipReason;
  workSucceeded?: boolean;
};

type WorkerRuntimeState = WorkerDefinition & {
  enabled: boolean;
  registeredAt: Date;
  currentRunStartedAt: Date | null;
  lastTickStartedAt: Date | null;
  lastTickCompletedAt: Date | null;
  lastSucceededAt: Date | null;
  lastWorkSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastDurationMs: number | null;
  lastOutcome: WorkerOutcome | null;
  lastSkipReason: WorkerSkipReason | null;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
  totalSkips: number;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  processInstanceId: string;
};

export type WorkerHealthItem = Omit<
  WorkerRuntimeState,
  | 'registeredAt'
  | 'currentRunStartedAt'
  | 'lastTickStartedAt'
  | 'lastTickCompletedAt'
  | 'lastSucceededAt'
  | 'lastWorkSucceededAt'
  | 'lastFailedAt'
  | 'lastErrorAt'
> & {
  status: WorkerStatus;
  statusReason: WorkerStatusReason;
  running: boolean;
  registeredAt: string;
  currentRunStartedAt: string | null;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastSucceededAt: string | null;
  lastWorkSucceededAt: string | null;
  lastFailedAt: string | null;
  lastErrorAt: string | null;
  ageSinceLastSuccessMs: number | null;
};

export type WorkerHealthSummary = {
  status: WorkerStatus;
  total: number;
  enabled: number;
  disabled: number;
  healthy: number;
  degraded: number;
  delayed: number;
  stale: number;
  failing: number;
  starting: number;
  criticalHealthy: boolean;
  needsAttention: boolean;
  processInstanceId: string;
  processStartedAt: string;
  evaluatedAt: string;
};

export type WorkerHealthSnapshot = {
  summary: WorkerHealthSummary;
  items: WorkerHealthItem[];
};

const MAX_ERROR_LENGTH = 500;
const STATUS_PRIORITY: WorkerStatus[] = [
  'disabled',
  'failing',
  'stale',
  'delayed',
  'degraded',
  'starting',
  'healthy',
];

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function sanitizeError(error: unknown): {
  message: string;
  code: string | null;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const normalized = rawMessage
    .replace(/\s+/g, ' ')
    .replace(/(password|token|secret|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .slice(0, MAX_ERROR_LENGTH);
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code.slice(0, 100)
      : null;

  return {
    message: normalized,
    code,
  };
}

function isSuccessfulSchedulerOutcome(
  outcome: WorkerOutcome,
  skipReason: WorkerSkipReason | null
) {
  if (outcome === 'success' || outcome === 'idle') {
    return true;
  }

  return outcome === 'skipped' && skipReason === 'not_due';
}

export class WorkerHealthRegistry {
  readonly processInstanceId: string;
  readonly processStartedAt: Date;

  private readonly states = new Map<WorkerKey, WorkerRuntimeState>();
  private readonly now: () => Date;

  constructor(args: { now?: () => Date; processInstanceId?: string } = {}) {
    this.processInstanceId = args.processInstanceId ?? crypto.randomUUID();
    this.processStartedAt = args.now?.() ?? new Date();
    this.now = args.now ?? (() => new Date());
  }

  registerWorker(definition: WorkerDefinition) {
    const now = this.now();
    const key = definition.key as WorkerKey;
    const existing = this.states.get(key);

    if (existing) {
      existing.enabled = definition.enabledByDefault;
      return existing;
    }

    const state: WorkerRuntimeState = {
      ...definition,
      enabled: definition.enabledByDefault,
      registeredAt: now,
      currentRunStartedAt: null,
      lastTickStartedAt: null,
      lastTickCompletedAt: null,
      lastSucceededAt: null,
      lastWorkSucceededAt: null,
      lastFailedAt: null,
      lastDurationMs: null,
      lastOutcome: null,
      lastSkipReason: null,
      consecutiveFailures: 0,
      totalRuns: 0,
      totalFailures: 0,
      totalSkips: 0,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      processInstanceId: this.processInstanceId,
    };

    this.states.set(key, state);
    return state;
  }

  registerWorkers(definitions: readonly WorkerDefinition[]) {
    for (const definition of definitions) {
      this.registerWorker(definition);
    }
  }

  setWorkerEnabled(key: WorkerKey, enabled: boolean) {
    this.getState(key).enabled = enabled;
  }

  skipWorkerTick(key: WorkerKey, reason: WorkerSkipReason) {
    const state = this.getState(key);
    const now = this.now();

    state.enabled = reason === 'disabled' ? false : state.enabled;
    state.lastOutcome = 'skipped';
    state.lastSkipReason = reason;
    state.totalSkips += 1;

    if (reason === 'not_due') {
      state.lastTickStartedAt = now;
      state.lastTickCompletedAt = now;
      state.lastSucceededAt = now;
      state.consecutiveFailures = 0;
      state.lastError = null;
      state.lastErrorCode = null;
    }
  }

  beginWorkerTick(key: WorkerKey) {
    const state = this.getState(key);
    const now = this.now();

    if (!state.enabled) {
      this.skipWorkerTick(key, 'disabled');
      return false;
    }

    if (state.currentRunStartedAt) {
      this.skipWorkerTick(key, 'already_running');
      return false;
    }

    state.currentRunStartedAt = now;
    state.lastTickStartedAt = now;
    state.lastSkipReason = null;
    state.totalRuns += 1;
    return true;
  }

  completeWorkerTick(key: WorkerKey, result: WorkerTickResult = {}) {
    const state = this.getState(key);
    const now = this.now();
    const startedAt = state.currentRunStartedAt ?? state.lastTickStartedAt ?? now;
    const outcome = result.outcome ?? 'success';
    const skipReason = result.skipReason ?? null;

    state.currentRunStartedAt = null;
    state.lastTickCompletedAt = now;
    state.lastDurationMs = now.getTime() - startedAt.getTime();
    state.lastOutcome = outcome;
    state.lastSkipReason = skipReason;

    if (outcome === 'skipped') {
      state.totalSkips += 1;
      if (skipReason === 'disabled') {
        state.enabled = false;
      }
    }

    if (isSuccessfulSchedulerOutcome(outcome, skipReason)) {
      state.lastSucceededAt = now;
      state.consecutiveFailures = 0;
      state.lastError = null;
      state.lastErrorCode = null;
    }

    if (result.workSucceeded) {
      state.lastWorkSucceededAt = now;
    }
  }

  failWorkerTick(key: WorkerKey, error: unknown) {
    const state = this.getState(key);
    const now = this.now();
    const startedAt = state.currentRunStartedAt ?? state.lastTickStartedAt ?? now;
    const sanitized = sanitizeError(error);

    state.currentRunStartedAt = null;
    state.lastTickCompletedAt = now;
    state.lastDurationMs = now.getTime() - startedAt.getTime();
    state.lastOutcome = 'failed';
    state.lastSkipReason = null;
    state.lastFailedAt = now;
    state.lastErrorAt = now;
    state.lastError = sanitized.message;
    state.lastErrorCode = sanitized.code;
    state.consecutiveFailures += 1;
    state.totalFailures += 1;
  }

  async runMonitoredWorker(
    key: WorkerKey,
    execute: () => Promise<WorkerTickResult | void>,
    options: { enabled?: boolean } = {}
  ) {
    if (options.enabled !== undefined) {
      this.setWorkerEnabled(key, options.enabled);
    }

    if (!this.beginWorkerTick(key)) {
      return;
    }

    try {
      const result = await execute();
      this.completeWorkerTick(key, result ?? {});
    } catch (error) {
      this.failWorkerTick(key, error);
      throw error;
    }
  }

  getSnapshot(now = this.now()): WorkerHealthSnapshot {
    const items = Array.from(this.states.values())
      .map((state) => this.toHealthItem(state, now))
      .sort((a, b) => a.key.localeCompare(b.key));
    const counts = {
      healthy: items.filter((item) => item.status === 'healthy').length,
      degraded: items.filter((item) => item.status === 'degraded').length,
      delayed: items.filter((item) => item.status === 'delayed').length,
      stale: items.filter((item) => item.status === 'stale').length,
      failing: items.filter((item) => item.status === 'failing').length,
      starting: items.filter((item) => item.status === 'starting').length,
      disabled: items.filter((item) => item.status === 'disabled').length,
    };
    const enabledItems = items.filter((item) => item.enabled);
    const criticalEnabledItems = enabledItems.filter(
      (item) => item.criticality === 'critical'
    );
    const criticalHealthy = criticalEnabledItems.every(
      (item) => item.status === 'healthy'
    );
    const needsAttention = enabledItems.some((item) =>
      ['degraded', 'delayed', 'stale', 'failing'].includes(item.status)
    );
    const status = this.summarizeStatus(items);

    return {
      summary: {
        status,
        total: items.length,
        enabled: enabledItems.length,
        ...counts,
        criticalHealthy,
        needsAttention,
        processInstanceId: this.processInstanceId,
        processStartedAt: this.processStartedAt.toISOString(),
        evaluatedAt: now.toISOString(),
      },
      items,
    };
  }

  private getState(key: WorkerKey) {
    const state = this.states.get(key);

    if (!state) {
      throw new Error(`Worker is not registered: ${key}`);
    }

    return state;
  }

  private deriveStatus(
    state: WorkerRuntimeState,
    now: Date
  ): { status: WorkerStatus; reason: WorkerStatusReason } {
    if (!state.enabled) {
      return { status: 'disabled', reason: 'disabled' };
    }

    if (state.consecutiveFailures >= 3) {
      return { status: 'failing', reason: 'consecutive_failures' };
    }

    if (
      state.currentRunStartedAt &&
      now.getTime() - state.currentRunStartedAt.getTime() >
        state.maxRunDurationMs
    ) {
      return { status: 'stale', reason: 'run_timeout' };
    }

    if (state.lastSucceededAt) {
      const age = now.getTime() - state.lastSucceededAt.getTime();

      if (age > state.staleAfterMs) {
        return { status: 'stale', reason: 'heartbeat_overdue' };
      }

      if (age > state.delayedAfterMs) {
        return { status: 'delayed', reason: 'heartbeat_delayed' };
      }
    } else {
      const age = now.getTime() - state.registeredAt.getTime();

      if (age > state.startupGraceMs + state.staleAfterMs) {
        return { status: 'stale', reason: 'never_succeeded' };
      }
    }

    if (state.consecutiveFailures > 0) {
      return { status: 'degraded', reason: 'consecutive_failures' };
    }

    if (!state.lastSucceededAt) {
      return { status: 'starting', reason: 'within_startup_grace' };
    }

    return {
      status: 'healthy',
      reason: state.lastOutcome === 'skipped' ? 'recent_skip' : 'recent_success',
    };
  }

  private toHealthItem(state: WorkerRuntimeState, now: Date): WorkerHealthItem {
    const derived = this.deriveStatus(state, now);
    const ageSinceLastSuccessMs = state.lastSucceededAt
      ? now.getTime() - state.lastSucceededAt.getTime()
      : null;

    return {
      ...state,
      status: derived.status,
      statusReason: derived.reason,
      running: state.currentRunStartedAt !== null,
      registeredAt: state.registeredAt.toISOString(),
      currentRunStartedAt: toIso(state.currentRunStartedAt),
      lastTickStartedAt: toIso(state.lastTickStartedAt),
      lastTickCompletedAt: toIso(state.lastTickCompletedAt),
      lastSucceededAt: toIso(state.lastSucceededAt),
      lastWorkSucceededAt: toIso(state.lastWorkSucceededAt),
      lastFailedAt: toIso(state.lastFailedAt),
      lastErrorAt: toIso(state.lastErrorAt),
      ageSinceLastSuccessMs,
    };
  }

  private summarizeStatus(items: WorkerHealthItem[]): WorkerStatus {
    for (const status of STATUS_PRIORITY) {
      if (items.some((item) => item.enabled && item.status === status)) {
        return status;
      }
    }

    if (items.every((item) => item.status === 'disabled')) {
      return 'disabled';
    }

    return 'healthy';
  }
}

export const workerHealthRegistry = new WorkerHealthRegistry();
workerHealthRegistry.registerWorkers(workerDefinitions);
