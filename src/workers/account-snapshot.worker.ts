import { recordAccountSnapshot } from '../services/account-snapshot.service.js';

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
    };
  }

  let due = false;
  let recorded = 0;

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

    const result = await recordAccountSnapshot({
      reason: checkpoint.reason,
      force: false,
      runKey: `${checkpoint.reason}:${eastern.dateKey}`,
    });

    if (result.created) {
      recorded += 1;
    }
  }

  return {
    due,
    recorded,
  };
}
