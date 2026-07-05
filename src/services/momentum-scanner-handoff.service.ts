import {
  MomentumCandidateState,
  MomentumScannerHandoffStatus,
  Prisma,
  type MomentumCandidatePriceCheck,
} from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

export type PrepareMomentumScannerHandoffOptions = {
  force?: boolean;
  minScore?: number;
  now?: Date;
  payloadVersion?: string;
};

export type PrepareReadyMomentumScannerHandoffsOptions =
  PrepareMomentumScannerHandoffOptions & {
    maxCandidates?: number;
    candidateId?: string;
  };

export type ListMomentumScannerHandoffsFilters = {
  candidateId?: string;
  symbol?: string;
  status?: MomentumScannerHandoffStatus;
  limit?: number;
};

export type MarkMomentumScannerHandoffOptions = {
  now?: Date;
  metadata?: Prisma.InputJsonValue;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const ACTIVE_HANDOFF_STATUSES = [
  MomentumScannerHandoffStatus.PENDING,
  MomentumScannerHandoffStatus.SENT,
  MomentumScannerHandoffStatus.ACKNOWLEDGED,
] as const;
const MAX_ERROR_LENGTH = 1_000;

function normalizeId(value: string, field: string) {
  const id = value.trim();

  if (id === '') {
    throw new HttpError(400, `${field} is required.`);
  }

  return id;
}

function normalizeSymbol(value: string | undefined) {
  const symbol = value?.trim().toUpperCase();

  return symbol ? symbol : undefined;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  max = MAX_LIMIT
) {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? Math.min(value, max)
    : fallback;
}

function normalizeScore(value: number | undefined) {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? Math.min(value, 100)
    : env.MOMENTUM_HANDOFF_MIN_SCORE;
}

function normalizePayloadVersion(value: string | undefined) {
  const version = value?.trim() ?? env.MOMENTUM_HANDOFF_PAYLOAD_VERSION;

  return version === '' ? env.MOMENTUM_HANDOFF_PAYLOAD_VERSION : version;
}

function iso(date: Date | null | undefined) {
  return date?.toISOString() ?? null;
}

function decimalToString(value: Prisma.Decimal | null) {
  return value === null ? null : value.toString();
}

function bigintToString(value: bigint | null) {
  return value === null ? null : value.toString();
}

function sanitizeError(error: string | Error) {
  const message = error instanceof Error ? error.message : error;

  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH);
}

function scannerHandoffInclude() {
  return {
    momentumCandidate: {
      include: {
        catalystEvent: true,
        catalystImpact: true,
      },
    },
  } satisfies Prisma.MomentumScannerHandoffInclude;
}

function candidateInclude() {
  return {
    catalystEvent: true,
    catalystImpact: true,
    priceChecks: {
      orderBy: [
        {
          observedAt: 'desc',
        },
        {
          createdAt: 'desc',
        },
      ],
      take: 1,
    },
    scannerHandoffs: {
      where: {
        status: {
          in: [...ACTIVE_HANDOFF_STATUSES],
        },
      },
      orderBy: {
        preparedAt: 'desc',
      },
      take: 1,
    },
  } satisfies Prisma.MomentumCandidateInclude;
}

type CandidateForHandoff = Prisma.MomentumCandidateGetPayload<{
  include: ReturnType<typeof candidateInclude>;
}>;

function buildIdempotencyKey(candidateId: string, payloadVersion: string) {
  return `momentum-candidate:${candidateId}:${payloadVersion}`;
}

function latestPriceCheck(candidate: CandidateForHandoff) {
  return candidate.priceChecks[0] ?? null;
}

function buildPriceConfirmationPayload(
  priceCheck: MomentumCandidatePriceCheck | null
) {
  if (!priceCheck) {
    return null;
  }

  return {
    priceCheckId: priceCheck.id,
    observedAt: iso(priceCheck.observedAt),
    lastPrice: decimalToString(priceCheck.lastPrice),
    previousClose: decimalToString(priceCheck.previousClose),
    pctFromPreviousClose: decimalToString(priceCheck.pctFromPreviousClose),
    intradayHigh: decimalToString(priceCheck.intradayHigh),
    intradayLow: decimalToString(priceCheck.intradayLow),
    distanceFromHighPct: decimalToString(priceCheck.distanceFromHighPct),
    sessionVwap: decimalToString(priceCheck.sessionVwap),
    aboveVwap: priceCheck.aboveVwap,
    dayVolume: bigintToString(priceCheck.dayVolume),
    dollarVolume: decimalToString(priceCheck.dollarVolume),
    relativeVolume: decimalToString(priceCheck.relativeVolume),
    recentMovePct: decimalToString(priceCheck.recentMovePct),
    recentVolume: bigintToString(priceCheck.recentVolume),
    confirmed: priceCheck.confirmed,
    decision: priceCheck.decision,
    blockedReason: priceCheck.blockedReason,
  };
}

export function buildMomentumScannerPayloadFromCandidate(
  candidate: CandidateForHandoff,
  payloadVersion = env.MOMENTUM_HANDOFF_PAYLOAD_VERSION
) {
  const priceCheck = latestPriceCheck(candidate);

  return {
    type: 'momentum_candidate.ready',
    version: payloadVersion,
    idempotencyKey: buildIdempotencyKey(candidate.id, payloadVersion),
    candidate: {
      id: candidate.id,
      symbol: candidate.symbol,
      state: candidate.state,
      totalScore: candidate.totalScore,
      catalystScore: candidate.catalystScore,
      priceActionScore: candidate.priceActionScore,
      volumeScore: candidate.volumeScore,
      riskScore: candidate.riskScore,
      reason: candidate.reason,
      discoveredAt: iso(candidate.discoveredAt),
      lastEvaluatedAt: iso(candidate.lastEvaluatedAt),
      expiresAt: iso(candidate.expiresAt),
    },
    catalyst: candidate.catalystEvent
      ? {
          eventId: candidate.catalystEvent.id,
          impactId: candidate.catalystImpact?.id ?? null,
          source: candidate.catalystEvent.source,
          publisher: candidate.catalystEvent.sourcePublisher,
          title: candidate.catalystEvent.title,
          summary: candidate.catalystEvent.summary,
          url: candidate.catalystEvent.sourceUrl,
          publishedAt: iso(candidate.catalystEvent.publishedAt),
          eventType: candidate.catalystEvent.eventType,
          eventTier: candidate.catalystEvent.eventTier,
          sentiment: candidate.catalystEvent.sentiment,
          sentimentReasoning:
            candidate.catalystImpact?.sentimentReasoning ?? null,
          tickerRole: candidate.catalystImpact?.catalystRole ?? null,
          totalCatalystScore:
            candidate.catalystImpact?.totalCatalystScore ??
            candidate.catalystScore,
        }
      : null,
    priceConfirmation: buildPriceConfirmationPayload(priceCheck),
    reviewGuidance: {
      recommendedAction: 'REVIEW_ONLY',
      tradingAllowed: false,
      notes: [
        'Backend handoff only. n8n should review/alert but must not create orders in this phase.',
      ],
    },
  } satisfies Prisma.InputJsonObject;
}

function getIneligibilityReason(
  candidate: CandidateForHandoff,
  options: {
    force: boolean;
    minScore: number;
    now: Date;
  }
) {
  if (candidate.state !== MomentumCandidateState.ENTRY_READY) {
    return `Candidate state ${candidate.state} is not scanner-ready.`;
  }

  if (candidate.expiresAt !== null && candidate.expiresAt <= options.now) {
    return 'Candidate is expired.';
  }

  if (candidate.totalScore < options.minScore) {
    return `Candidate totalScore ${candidate.totalScore} is below minimum ${options.minScore}.`;
  }

  if (candidate.blockedReason !== null) {
    return `Candidate is blocked: ${candidate.blockedReason}.`;
  }

  if (!options.force && candidate.scannerHandoffs.length > 0) {
    return 'Candidate already has an active scanner handoff.';
  }

  return null;
}

export async function buildMomentumScannerPayload(
  candidateId: string,
  options: Pick<PrepareMomentumScannerHandoffOptions, 'payloadVersion'> = {}
) {
  const id = normalizeId(candidateId, 'Momentum candidate id');
  const payloadVersion = normalizePayloadVersion(options.payloadVersion);
  const candidate = await prisma.momentumCandidate.findUnique({
    where: {
      id,
    },
    include: candidateInclude(),
  });

  if (!candidate) {
    throw new HttpError(404, 'Momentum candidate not found.');
  }

  return buildMomentumScannerPayloadFromCandidate(candidate, payloadVersion);
}

export async function prepareMomentumScannerHandoff(
  candidateId: string,
  options: PrepareMomentumScannerHandoffOptions = {}
) {
  const id = normalizeId(candidateId, 'Momentum candidate id');
  const now = options.now ?? new Date();
  const minScore = normalizeScore(options.minScore);
  const force = options.force ?? false;
  const payloadVersion = normalizePayloadVersion(options.payloadVersion);
  const candidate = await prisma.momentumCandidate.findUnique({
    where: {
      id,
    },
    include: candidateInclude(),
  });

  if (!candidate) {
    throw new HttpError(404, 'Momentum candidate not found.');
  }

  const skippedReason = getIneligibilityReason(candidate, {
    force,
    minScore,
    now,
  });

  if (skippedReason !== null) {
    return {
      skipped: true,
      reason: skippedReason,
      handoff: null,
      candidate,
    };
  }

  const payload = buildMomentumScannerPayloadFromCandidate(
    candidate,
    payloadVersion
  );
  const existing = await prisma.momentumScannerHandoff.findUnique({
    where: {
      idempotencyKey: payload.idempotencyKey,
    },
    include: scannerHandoffInclude(),
  });

  if (existing && !force) {
    return {
      skipped: false,
      reason: null,
      handoff: existing,
      candidate,
    };
  }

  const handoff = existing
    ? await prisma.momentumScannerHandoff.update({
        where: {
          id: existing.id,
        },
        data: {
          status: MomentumScannerHandoffStatus.PENDING,
          payload,
          preparedAt: now,
          sentAt: null,
          acknowledgedAt: null,
          failedAt: null,
          lastError: null,
          metadata: {
            forceRefreshedAt: now.toISOString(),
            previousStatus: existing.status,
          },
        },
        include: scannerHandoffInclude(),
      })
    : await prisma.momentumScannerHandoff.create({
        data: {
          momentumCandidateId: candidate.id,
          symbol: candidate.symbol,
          status: MomentumScannerHandoffStatus.PENDING,
          payloadVersion,
          payload,
          preparedAt: now,
          idempotencyKey: payload.idempotencyKey,
          metadata: {
            phase: 'momentum_scanner_handoff_phase_5',
            tradingAllowed: false,
          },
        },
        include: scannerHandoffInclude(),
      });

  return {
    skipped: false,
    reason: null,
    handoff,
    candidate,
  };
}

export async function prepareReadyMomentumScannerHandoffs(
  options: PrepareReadyMomentumScannerHandoffsOptions = {}
) {
  if (options.candidateId !== undefined) {
    const result = await prepareMomentumScannerHandoff(
      options.candidateId,
      options
    );

    return {
      prepared: result.skipped ? 0 : 1,
      skipped: result.skipped ? 1 : 0,
      handoffs: result.handoff ? [result.handoff] : [],
      skippedReasons: result.skipped
        ? [
            {
              candidateId: result.candidate.id,
              symbol: result.candidate.symbol,
              reason: result.reason ?? 'Skipped.',
            },
          ]
        : [],
    };
  }

  const now = options.now ?? new Date();
  const minScore = normalizeScore(options.minScore);
  const maxCandidates = normalizePositiveInteger(
    options.maxCandidates,
    env.MOMENTUM_HANDOFF_MAX_CANDIDATES,
    100
  );
  const candidates = await prisma.momentumCandidate.findMany({
    where: {
      state: MomentumCandidateState.ENTRY_READY,
      totalScore: {
        gte: minScore,
      },
      blockedReason: null,
      OR: [
        {
          expiresAt: null,
        },
        {
          expiresAt: {
            gt: now,
          },
        },
      ],
      ...(options.force
        ? {}
        : {
            scannerHandoffs: {
              none: {
                status: {
                  in: [...ACTIVE_HANDOFF_STATUSES],
                },
              },
            },
          }),
    },
    orderBy: [
      {
        totalScore: 'desc',
      },
      {
        lastEvaluatedAt: {
          sort: 'desc',
          nulls: 'last',
        },
      },
      {
        discoveredAt: 'asc',
      },
    ],
    take: maxCandidates,
    include: candidateInclude(),
  });
  const summary = {
    prepared: 0,
    skipped: 0,
    handoffs: [] as Array<
      NonNullable<
        Awaited<ReturnType<typeof prepareMomentumScannerHandoff>>['handoff']
      >
    >,
    skippedReasons: [] as Array<{
      candidateId: string;
      symbol: string;
      reason: string;
    }>,
  };

  for (const candidate of candidates) {
    const { maxCandidates: _maxCandidates, candidateId: _candidateId, ...prepareOptions } =
      options;
    const result = await prepareMomentumScannerHandoff(candidate.id, {
      ...prepareOptions,
      minScore,
      now,
    });

    if (result.skipped) {
      summary.skipped += 1;
      summary.skippedReasons.push({
        candidateId: result.candidate.id,
        symbol: result.candidate.symbol,
        reason: result.reason ?? 'Skipped.',
      });
      continue;
    }

    if (result.handoff) {
      summary.prepared += 1;
      summary.handoffs.push(result.handoff);
    }
  }

  return summary;
}

export async function listMomentumScannerHandoffs(
  filters: ListMomentumScannerHandoffsFilters = {}
) {
  const where: Prisma.MomentumScannerHandoffWhereInput = {};
  const symbol = normalizeSymbol(filters.symbol);

  if (filters.candidateId !== undefined) {
    where.momentumCandidateId = normalizeId(
      filters.candidateId,
      'Momentum candidate id'
    );
  }

  if (symbol !== undefined) {
    where.symbol = symbol;
  }

  if (filters.status !== undefined) {
    where.status = filters.status;
  }

  return prisma.momentumScannerHandoff.findMany({
    where,
    orderBy: [
      {
        preparedAt: 'desc',
      },
      {
        createdAt: 'desc',
      },
    ],
    take: normalizePositiveInteger(filters.limit, DEFAULT_LIMIT),
    include: scannerHandoffInclude(),
  });
}

export async function getMomentumScannerHandoffById(id: string) {
  const handoff = await prisma.momentumScannerHandoff.findUnique({
    where: {
      id: normalizeId(id, 'Momentum scanner handoff id'),
    },
    include: scannerHandoffInclude(),
  });

  if (!handoff) {
    throw new HttpError(404, 'Momentum scanner handoff not found.');
  }

  return handoff;
}

export async function markMomentumScannerHandoffSent(
  id: string,
  options: MarkMomentumScannerHandoffOptions = {}
) {
  const now = options.now ?? new Date();

  return prisma.momentumScannerHandoff.update({
    where: {
      id: normalizeId(id, 'Momentum scanner handoff id'),
    },
    data: {
      status: MomentumScannerHandoffStatus.SENT,
      sentAt: now,
      attempts: {
        increment: 1,
      },
      lastError: null,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    },
    include: scannerHandoffInclude(),
  });
}

export async function markMomentumScannerHandoffAcknowledged(
  id: string,
  options: MarkMomentumScannerHandoffOptions = {}
) {
  const now = options.now ?? new Date();

  return prisma.momentumScannerHandoff.update({
    where: {
      id: normalizeId(id, 'Momentum scanner handoff id'),
    },
    data: {
      status: MomentumScannerHandoffStatus.ACKNOWLEDGED,
      acknowledgedAt: now,
      lastError: null,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    },
    include: scannerHandoffInclude(),
  });
}

export async function markMomentumScannerHandoffFailed(
  id: string,
  error: string | Error,
  options: MarkMomentumScannerHandoffOptions = {}
) {
  const now = options.now ?? new Date();

  return prisma.momentumScannerHandoff.update({
    where: {
      id: normalizeId(id, 'Momentum scanner handoff id'),
    },
    data: {
      status: MomentumScannerHandoffStatus.FAILED,
      failedAt: now,
      lastError: sanitizeError(error),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    },
    include: scannerHandoffInclude(),
  });
}
