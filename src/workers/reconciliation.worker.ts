import { logger } from '../config/logger.js';
import { getRuntimeTradingConfig } from '../services/config.service.js';
import { runReconciliationCheck } from '../services/reconciliation.service.js';

let running = false;
let lastRunAt: Date | null = null;

export async function runScheduledReconciliation() {
  if (running) {
    logger.debug('Reconciliation worker tick skipped because previous tick is still running.');
    return {
      skipped: true,
      reason: 'already_running' as const,
    };
  }

  running = true;

  try {
    const config = await getRuntimeTradingConfig();

    if (!config.reconciliationWorkerEnabled) {
      return {
        skipped: true,
        reason: 'disabled' as const,
      };
    }

    const intervalMinutes = Math.max(
      1,
      config.reconciliationWorkerIntervalMinutes
    );

    const now = new Date();

    if (
      lastRunAt &&
      now.getTime() - lastRunAt.getTime() < intervalMinutes * 60_000
    ) {
      return {
        skipped: true,
        reason: 'not_due' as const,
      };
    }

    lastRunAt = now;

    const result = await runReconciliationCheck({
      persistEvents: true,
      persistAttention: true,
      dedupeEvents: true,
    });

    if (result.findings.length > 0) {
      logger.warn(
        {
          findingCount: result.findings.length,
          eventCount: result.eventCount,
          skippedDuplicateEventCount: result.skippedDuplicateEventCount,
          attentionUpdateCount: result.attentionUpdateCount,
        },
        'Scheduled reconciliation found mismatches.'
      );
    }

    return {
      skipped: false,
      result,
    };
  } catch (error) {
    logger.error({ error }, 'Scheduled reconciliation worker error.');
    throw error;
  } finally {
    running = false;
  }
}