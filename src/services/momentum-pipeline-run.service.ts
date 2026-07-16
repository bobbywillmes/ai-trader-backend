import {
  MomentumPipelineRunSource,
  MomentumPipelineRunStatus,
  MomentumPipelineStage,
  Prisma,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

const ABANDONED_AFTER_MS = 30 * 60_000;
const REQUIRED_RESULT_FIELDS = [
  'newsResult',
  'expirationResult',
  'candidateResult',
  'priceResult',
  'handoffResult',
] as const;

const stageResultField = {
  NEWS: 'newsResult',
  EXPIRATION: 'expirationResult',
  CANDIDATE_GENERATION: 'candidateResult',
  PRICE_CONFIRMATION: 'priceResult',
  HANDOFF_PREPARATION: 'handoffResult',
  HANDOFF_DELIVERY: 'deliveryResult',
} satisfies Record<MomentumPipelineStage, keyof Prisma.MomentumPipelineRunUpdateInput>;

function boundedJson(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (value === null) return null as unknown as Prisma.InputJsonValue;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundedJson(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [key.slice(0, 100), boundedJson(item, depth + 1)])
    );
  }
  return String(value).slice(0, 2_000);
}

function safeMessage(value: string) {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1_000);
}

function effectiveStatus<T extends { status: MomentumPipelineRunStatus; startedAt: Date }>(
  run: T,
  now: Date
) {
  return run.status === MomentumPipelineRunStatus.RUNNING &&
    now.getTime() - run.startedAt.getTime() > ABANDONED_AFTER_MS
    ? MomentumPipelineRunStatus.ABANDONED
    : run.status;
}

export function serializeMomentumPipelineRun<T extends {
  status: MomentumPipelineRunStatus;
  startedAt: Date;
  completedAt: Date | null;
}>(run: T, now = new Date()) {
  const status = effectiveStatus(run, now);
  return {
    ...run,
    status,
    durationMs: run.completedAt
      ? run.completedAt.getTime() - run.startedAt.getTime()
      : status === MomentumPipelineRunStatus.RUNNING
        ? now.getTime() - run.startedAt.getTime()
        : null,
  };
}

async function requiredRun(id: string) {
  const run = await prisma.momentumPipelineRun.findUnique({ where: { id } });
  if (!run) throw new HttpError(404, 'Momentum pipeline run not found.');
  return run;
}

export async function startMomentumPipelineRun(args: {
  source: MomentumPipelineRunSource;
  metadata?: unknown;
  now?: Date;
}) {
  return prisma.momentumPipelineRun.create({
    data: {
      source: args.source,
      status: MomentumPipelineRunStatus.RUNNING,
      startedAt: args.now ?? new Date(),
      ...(args.metadata === undefined ? {} : { metadata: boundedJson(args.metadata) }),
    },
  });
}

export async function recordMomentumPipelineStage(args: {
  runId: string;
  stage: MomentumPipelineStage;
  status: 'SUCCEEDED' | 'FAILED';
  result?: unknown;
  now?: Date;
}) {
  const run = await requiredRun(args.runId);
  if (run.status !== MomentumPipelineRunStatus.RUNNING) {
    throw new HttpError(409, 'Completed momentum pipeline runs cannot accept stage updates.');
  }
  const recordedAt = args.now ?? new Date();
  const field = stageResultField[args.stage];
  return prisma.momentumPipelineRun.update({
    where: { id: run.id },
    data: {
      currentStage: args.stage,
      [field]: boundedJson({ status: args.status, result: args.result ?? {}, recordedAt }),
    },
  });
}

export async function completeMomentumPipelineRun(args: {
  runId: string;
  status?: 'SUCCEEDED' | 'PARTIAL';
  now?: Date;
}) {
  const run = await requiredRun(args.runId);
  const targetStatus = args.status === 'PARTIAL'
    ? MomentumPipelineRunStatus.PARTIAL
    : MomentumPipelineRunStatus.SUCCEEDED;
  if (run.status === targetStatus) return run;
  if (run.status !== MomentumPipelineRunStatus.RUNNING) {
    throw new HttpError(409, 'Momentum pipeline run is already complete.');
  }
  const missing = REQUIRED_RESULT_FIELDS.filter((field) => run[field] === null);
  if (missing.length > 0) {
    throw new HttpError(409, `Momentum pipeline run is missing required stages: ${missing.join(', ')}.`);
  }
  return prisma.momentumPipelineRun.update({
    where: { id: run.id },
    data: { status: targetStatus, completedAt: args.now ?? new Date() },
  });
}

export async function failMomentumPipelineRun(args: {
  runId: string;
  stage: MomentumPipelineStage;
  errorCode: string;
  errorMessage: string;
  now?: Date;
}) {
  const run = await requiredRun(args.runId);
  if (run.status === MomentumPipelineRunStatus.FAILED) return run;
  if (run.status !== MomentumPipelineRunStatus.RUNNING) {
    throw new HttpError(409, 'Momentum pipeline run is already complete.');
  }
  return prisma.momentumPipelineRun.update({
    where: { id: run.id },
    data: {
      status: MomentumPipelineRunStatus.FAILED,
      currentStage: args.stage,
      errorStage: args.stage,
      errorCode: safeMessage(args.errorCode).slice(0, 100),
      errorMessage: safeMessage(args.errorMessage),
      completedAt: args.now ?? new Date(),
    },
  });
}

export async function getMomentumPipelineRun(id: string, now = new Date()) {
  return serializeMomentumPipelineRun(await requiredRun(id), now);
}

export async function getLatestMomentumPipelineRuns(now = new Date()) {
  const [latestAttempt, latestSuccessful, currentRun] = await Promise.all([
    prisma.momentumPipelineRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.momentumPipelineRun.findFirst({
      where: { status: MomentumPipelineRunStatus.SUCCEEDED },
      orderBy: { startedAt: 'desc' },
    }),
    prisma.momentumPipelineRun.findFirst({
      where: { status: MomentumPipelineRunStatus.RUNNING },
      orderBy: { startedAt: 'desc' },
    }),
  ]);
  return {
    latestAttempt: latestAttempt ? serializeMomentumPipelineRun(latestAttempt, now) : null,
    latestSuccessful: latestSuccessful ? serializeMomentumPipelineRun(latestSuccessful, now) : null,
    currentRun: currentRun && effectiveStatus(currentRun, now) === MomentumPipelineRunStatus.RUNNING
      ? serializeMomentumPipelineRun(currentRun, now)
      : null,
  };
}

export async function listMomentumPipelineRuns(args: {
  page: number;
  pageSize: number;
  status?: MomentumPipelineRunStatus;
  source?: MomentumPipelineRunSource;
  from?: Date;
  to?: Date;
}, now = new Date()) {
  const where: Prisma.MomentumPipelineRunWhereInput = {
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.from || args.to ? {
      startedAt: {
        ...(args.from === undefined ? {} : { gte: args.from }),
        ...(args.to === undefined ? {} : { lte: args.to }),
      },
    } : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.momentumPipelineRun.count({ where }),
    prisma.momentumPipelineRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (args.page - 1) * args.pageSize,
      take: args.pageSize,
    }),
  ]);
  return {
    data: rows.map((run) => serializeMomentumPipelineRun(run, now)),
    pagination: {
      page: args.page,
      pageSize: args.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / args.pageSize)),
    },
  };
}
