import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import { recordAccountSnapshot } from '../services/account-snapshot.service.js';
import { runTradingAccountWorkflow } from '../services/trading-account-workflow-runner.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES } from '../services/trading-account-workflow-lock.service.js';
import { enumerateLifecycleAccounts } from '../services/lifecycle-account-eligibility.service.js';

const EASTERN_TIME_ZONE = 'America/New_York';

const CHECKPOINTS = [
  {
    reason: 'scheduled_morning' as const,
    hour: 9,
    minute: 35,
  },
  {
    reason: 'scheduled_midday' as const,
    hour: 12,
    minute: 30,
  },
  {
    reason: 'scheduled_after_close' as const,
    hour: 16,
    minute: 5,
  },
];

function getEasternDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const weekday = getPart('weekday');

  return {
    dateKey: `${year}-${month}-${day}`,
    weekday,
    hour: Number(getPart('hour')),
    minute: Number(getPart('minute')),
  };
}

function isWeekday(weekday: string) {
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function isWithinCheckpointWindow(args: {
  currentHour: number;
  currentMinute: number;
  checkpointHour: number;
  checkpointMinute: number;
}) {
  const currentMinutes = args.currentHour * 60 + args.currentMinute;
  const checkpointMinutes = args.checkpointHour * 60 + args.checkpointMinute;

  return currentMinutes >= checkpointMinutes && currentMinutes <= checkpointMinutes + 5;
}

export async function runScheduledAccountSnapshots() {
  const eastern = getEasternDateParts();

  if (!isWeekday(eastern.weekday)) {
    return {
      due: false,
      recorded: 0,
      deferred: false,
      results: [],
    };
  }

  let due = false;
  let recorded = 0;
  const results = [];
  const accounts = await enumerateLifecycleAccounts('scheduled_snapshots');

  for (const checkpoint of CHECKPOINTS) {
    const checkpointDue = isWithinCheckpointWindow({
      currentHour: eastern.hour,
      currentMinute: eastern.minute,
      checkpointHour: checkpoint.hour,
      checkpointMinute: checkpoint.minute,
    });

    if (!checkpointDue) {
      continue;
    }

    due = true;

    const runKey = `${checkpoint.reason}:${eastern.dateKey}`;
    for (const account of accounts) {
      if (!account.eligible) {
        results.push({
          account,
          runKey,
          outcome:
            account.reason === 'credentials_unavailable_with_exposure'
              ? 'CREDENTIALS_UNAVAILABLE' as const
              : 'SKIPPED' as const,
        });
        continue;
      }

      try {
        const run = await runTradingAccountWorkflow({
          tradingAccountId: account.tradingAccountId,
          workerKey: 'account_snapshot_scheduler',
          lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.ACCOUNT_SNAPSHOT,
          execute: () => recordAccountSnapshot(account.tradingAccountId, {
            reason: checkpoint.reason,
            force: false,
            runKey,
          }),
        });
        if (run.outcome === 'FAILED') throw run.error;
        if (run.outcome !== 'PROCESSED') {
          results.push({ account, runKey, outcome: 'SKIPPED' as const });
          continue;
        }
        const result = run.value;

        if (result.created) recorded += 1;
        results.push({
          account,
          runKey,
          outcome: 'PROCESSED' as const,
          result,
        });
      } catch (error) {
        if (error instanceof AlpacaRateLimitDeferredError) {
          results.push({
            account,
            runKey,
            outcome: 'SKIPPED' as const,
            deferred: true,
            backoffUntil: error.backoffUntil?.toISOString() ?? null,
          });
          continue;
        }

        const message =
          error instanceof Error ? error.message : 'Unknown worker error.';
        results.push({
          account,
          runKey,
          outcome: 'FAILED' as const,
          error: message,
        });
        console.error({
          workflow: 'scheduled_snapshots',
          tradingAccountId: account.tradingAccountId,
          displayName: account.displayName,
          environment: account.environment,
          outcome: 'FAILED',
          error: message,
        });
      }
    }
  }

  return {
    due,
    recorded,
    deferred: false,
    results,
  };
}
