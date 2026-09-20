import { logger } from '../config/logger.js';
import type { WorkerHealthRegistry } from '../services/worker-health.service.js';
import { runParticipationAssessmentWorker } from './participation-assessment.worker.js';
import { PARTICIPATION_ASSESSMENT_WORKER_INTERVAL_MS } from './worker-health.definitions.js';

export const PARTICIPATION_STARTUP_GATE_MS = 120_000;
export const PARTICIPATION_SHUTDOWN_DRAIN_MS = 15_000;

export type ParticipationScheduler = {
  /** Starts the startup tick and the recurring interval; a second call while running is a no-op. */
  start(): void;
  /** Prevents new ticks, aborts and drains the in-flight tick, and clears the timer. Resolves true if drained in time. */
  stop(drainTimeoutMs?: number): Promise<boolean>;
  readonly running: boolean;
  readonly inFlight: boolean;
};

type Options = {
  /** One tick. Must honor the signal and settle; failures are its own responsibility (routed to worker health). */
  run: (signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
  /** Optional startup dependency (e.g. the daily MarketBar sync tick). Waited for a bounded time; never a data coupling. */
  startupGate?: Promise<unknown>;
  startupGateTimeoutMs?: number;
};

/** At most one local tick in flight; the database advisory lock remains authoritative across processes. */
export function createParticipationScheduler(options: Options): ParticipationScheduler {
  const intervalMs = options.intervalMs ?? PARTICIPATION_ASSESSMENT_WORKER_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let current: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let stopping = false;

  async function waitForStartupGate(signal: AbortSignal) {
    if (!options.startupGate) return;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        options.startupGate.catch(() => undefined),
        new Promise<void>(resolve => { gateTimer = setTimeout(resolve, options.startupGateTimeoutMs ?? PARTICIPATION_STARTUP_GATE_MS); }),
        new Promise<void>(resolve => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); }),
      ]);
    } finally {
      clearTimeout(gateTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  function tick(gated: boolean) {
    if (stopping) return;
    if (current) { logger.debug('Participation assessment tick skipped because the previous local tick is still running.'); return; }
    const own = new AbortController();
    controller = own;
    const running = (async () => {
      if (gated) await waitForStartupGate(own.signal);
      if (own.signal.aborted) return;
      await options.run(own.signal);
    })().catch(error => {
      // Health/failure state is owned by the monitored run; this only prevents an unhandled rejection.
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Participation assessment tick ended with an error.');
    }).finally(() => { if (current === running) { current = null; controller = null; } });
    current = running;
  }

  return {
    start() {
      if (timer || stopping) return;
      timer = setInterval(() => tick(false), intervalMs);
      tick(true);
    },
    async stop(drainTimeoutMs = PARTICIPATION_SHUTDOWN_DRAIN_MS) {
      stopping = true;
      if (timer) { clearInterval(timer); timer = null; }
      controller?.abort();
      const pending = current;
      let drained = true;
      if (pending) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        drained = await Promise.race([
          pending.then(() => true),
          new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), drainTimeoutMs); }),
        ]);
        clearTimeout(deadline);
      }
      if (drained) stopping = false;
      return drained;
    },
    get running() { return timer !== null; },
    get inFlight() { return current !== null; },
  };
}

/** Production composition: each tick runs through WorkerHealth; the worker is global and account-independent. */
export function createMonitoredParticipationScheduler(registry: WorkerHealthRegistry, extra: Pick<Options, 'startupGate' | 'startupGateTimeoutMs' | 'intervalMs'> = {}) {
  return createParticipationScheduler({
    ...extra,
    run: async signal => {
      try { await registry.runMonitoredWorker('participation_assessment_publication', () => runParticipationAssessmentWorker({ signal })); } catch { /* recorded by WorkerHealth */ }
    },
  });
}
