import crypto from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { createSystemEvent } from './system-event.service.js';
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
  lastEmittedStatus: WorkerStatus | null;
  dirty: boolean;
  forcePersist: boolean;
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
const PERSIST_INTERVAL_MS = 30_000;
const PERSIST_FAILURE_LOG_INTERVAL_MS = 5 * 60_000;
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
  private persistTimer: NodeJS.Timeout | null = null;
  private transitionEventsEnabled = true;
  private persistenceFailureLastLoggedAt = 0;
  private persisting = false;

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
      lastEmittedStatus: null,
      dirty: true,
      forcePersist: true,
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
    const state = this.getState(key);

    if (state.enabled === enabled) {
      return;
    }

    state.enabled = enabled;
    this.markDirty(state, true);
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

    this.afterStateChange(state, reason === 'disabled' ? true : false);
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
    this.markDirty(state);
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

    this.afterStateChange(state, false);
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
    this.afterStateChange(state, true);
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

  startPersistence() {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setInterval(() => {
      void this.flushDirtyStates();
    }, PERSIST_INTERVAL_MS);
  }

  stopPersistence() {
    if (!this.persistTimer) {
      return;
    }

    clearInterval(this.persistTimer);
    this.persistTimer = null;
  }

  async shutdown() {
    this.stopPersistence();
    await this.flushDirtyStates({ force: true });
  }

  async flushDirtyStates(args: { force?: boolean } = {}) {
    if (this.persisting) {
      return;
    }

    this.evaluateTimeBasedTransitions();

    const dirtyStates = Array.from(this.states.values()).filter(
      (state) => args.force || state.dirty || state.forcePersist
    );

    if (dirtyStates.length === 0) {
      return;
    }

    this.persisting = true;

    try {
      await Promise.all(
        dirtyStates.map((state) =>
          prisma.workerHealthState.upsert({
            where: { key: state.key },
            update: this.toPersistenceData(state),
            create: {
              key: state.key,
              ...this.toPersistenceData(state),
            },
          })
        )
      );

      for (const state of dirtyStates) {
        state.dirty = false;
        state.forcePersist = false;
      }
    } catch (error) {
      this.logPersistenceFailure(error);
    } finally {
      this.persisting = false;
    }
  }

  private getState(key: WorkerKey) {
    const state = this.states.get(key);

    if (!state) {
      throw new Error(`Worker is not registered: ${key}`);
    }

    return state;
  }

  private markDirty(state: WorkerRuntimeState, forcePersist = false) {
    state.dirty = true;
    state.forcePersist = state.forcePersist || forcePersist;
  }

  private evaluateTimeBasedTransitions() {
    for (const state of this.states.values()) {
      const previousStatus = state.lastEmittedStatus;
      const next = this.deriveStatus(state, this.now());

      if (previousStatus === next.status) {
        continue;
      }

      this.afterStateChange(state, this.isImportantTransition(previousStatus, next.status));
    }
  }

  private afterStateChange(state: WorkerRuntimeState, forcePersist: boolean) {
    const previousStatus = state.lastEmittedStatus;
    const next = this.deriveStatus(state, this.now());

    this.markDirty(state, forcePersist || this.isImportantTransition(previousStatus, next.status));

    if (!this.transitionEventsEnabled) {
      state.lastEmittedStatus = next.status;
      return;
    }

    if (this.shouldEmitTransition(previousStatus, next.status)) {
      void this.createTransitionEvent(state, previousStatus, next.status, next.reason)
        .catch((error) => {
          logger.warn(
            { error, workerKey: state.key },
            'Worker health transition event write failed.'
          );
        });
    }

    state.lastEmittedStatus = next.status;
  }

  private shouldEmitTransition(
    previousStatus: WorkerStatus | null,
    nextStatus: WorkerStatus
  ) {
    if (previousStatus === null || previousStatus === nextStatus) {
      return false;
    }

    if (nextStatus === 'stale') {
      return ['healthy', 'degraded', 'delayed'].includes(previousStatus);
    }

    if (nextStatus === 'failing') {
      return previousStatus !== 'failing';
    }

    return (
      nextStatus === 'healthy' &&
      (previousStatus === 'stale' || previousStatus === 'failing')
    );
  }

  private isImportantTransition(
    previousStatus: WorkerStatus | null,
    nextStatus: WorkerStatus
  ) {
    return this.shouldEmitTransition(previousStatus, nextStatus);
  }

  private async createTransitionEvent(
    state: WorkerRuntimeState,
    previousStatus: WorkerStatus | null,
    nextStatus: WorkerStatus,
    reason: WorkerStatusReason
  ) {
    await createSystemEvent({
      type:
        nextStatus === 'healthy'
          ? 'worker_health.recovered'
          : `worker_health.${nextStatus}`,
      entityType: 'worker',
      entityId: state.key,
      message:
        nextStatus === 'healthy'
          ? `${state.displayName} recovered.`
          : `${state.displayName} is ${nextStatus}.`,
      payloadJson: {
        workerKey: state.key,
        displayName: state.displayName,
        previousStatus,
        nextStatus,
        reason,
        consecutiveFailures: state.consecutiveFailures,
        lastSucceededAt: toIso(state.lastSucceededAt),
        lastFailedAt: toIso(state.lastFailedAt),
        processInstanceId: state.processInstanceId,
      } as Prisma.InputJsonValue,
    });
  }

  private toPersistenceData(state: WorkerRuntimeState) {
    return {
      processInstanceId: state.processInstanceId,
      enabled: state.enabled,
      expectedIntervalMs: state.expectedIntervalMs,
      currentRunStartedAt: state.currentRunStartedAt,
      lastTickStartedAt: state.lastTickStartedAt,
      lastTickCompletedAt: state.lastTickCompletedAt,
      lastSucceededAt: state.lastSucceededAt,
      lastWorkSucceededAt: state.lastWorkSucceededAt,
      lastFailedAt: state.lastFailedAt,
      lastDurationMs: state.lastDurationMs,
      lastOutcome: state.lastOutcome,
      lastSkipReason: state.lastSkipReason,
      consecutiveFailures: state.consecutiveFailures,
      totalRuns: state.totalRuns,
      totalFailures: state.totalFailures,
      totalSkips: state.totalSkips,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    };
  }

  private logPersistenceFailure(error: unknown) {
    const now = this.now().getTime();

    if (
      now - this.persistenceFailureLastLoggedAt <
      PERSIST_FAILURE_LOG_INTERVAL_MS
    ) {
      return;
    }

    this.persistenceFailureLastLoggedAt = now;
    logger.warn({ error }, 'Worker health persistence failed.');
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
