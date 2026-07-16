import { MomentumCandidateState, Prisma, type MomentumCandidate } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  ACTIVE_MOMENTUM_CANDIDATE_STATES,
  isMomentumCandidateExpired,
} from './momentum-candidate-lifecycle.js';
import { evaluateMomentumPriceConfirmationEligibility } from './momentum-candidate-eligibility.service.js';
import { momentumSubscriptionEligibilitySelect } from './momentum-subscription-eligibility.service.js';
import {
  getTickerPriceConfirmationMarketData,
  type TickerPriceConfirmationMarketData,
} from './massive-market-data.service.js';
import { getNewYorkMarketTiming, scoreMomentumPriceAction } from './momentum-scoring/momentum-price-score.js';
import { scoreMomentumVolume } from './momentum-scoring/momentum-volume-score.js';

export type ConfirmCandidatePriceOptions = {
  now?: Date;
  recentWindowMinutes?: number;
  lookbackMinutes?: number;
};

export type ConfirmActiveCandidatesOptions = ConfirmCandidatePriceOptions & {
  maxCandidates?: number;
  state?: MomentumCandidateState;
  minCatalystScore?: number;
};

export type ListMomentumCandidatePriceChecksOptions = {
  limit?: number;
};

export type PriceConfirmationSnapshot = {
  symbol: string;
  observedAt: Date;
  sourceObservedAt: Date | null;
  lastPrice: number | null;
  previousClose: number | null;
  pctFromPreviousClose: number | null;
  intradayHigh: number | null;
  intradayLow: number | null;
  distanceFromHighPct: number | null;
  sessionVwap: number | null;
  aboveVwap: boolean | null;
  dayVolume: number | null;
  dollarVolume: number | null;
  relativeVolume: number | null;
  recentMovePct: number | null;
  recentVolume: number | null;
  rawPayload: TickerPriceConfirmationMarketData['rawPayload'];
};

export type PriceConfirmationScores = {
  priceActionScore: number;
  volumeScore: number;
  riskScore: number;
  totalConfirmationScore: number;
  confirmed: boolean;
  decision: string;
  blockedReason: string | null;
  hardBlocks: string[];
  reasons: string[];
  volumeMetricType: string;
  volumeIntensity: number | null;
};

export const MOMENTUM_CONFIRMATION_SCORING_VERSION = 'momentum_confirmation_v3';

const priceEligibilityInclude = {
  security: {
    select: {
      id: true,
      momentumUniverseMember: {
        select: {
          enabled: true,
          priceScanningEnabled: true,
        },
      },
      subscriptions: {
        select: momentumSubscriptionEligibilitySelect,
        orderBy: { id: 'asc' as const },
      },
    },
  },
} satisfies Prisma.MomentumCandidateInclude;
const MAX_ELIGIBILITY_SCAN_MULTIPLIER = 5;
const MAX_ELIGIBILITY_SCAN_CANDIDATES = 500;

type PriceEligibilityCandidate = Prisma.MomentumCandidateGetPayload<{
  include: typeof priceEligibilityInclude;
}>;

function priceEligibilityContext(candidate: PriceEligibilityCandidate) {
  return {
    state: candidate.state,
    expiresAt: candidate.expiresAt,
    blockedReason: candidate.blockedReason,
    security: candidate.security,
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number
) {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function toBigIntOrNull(value: number | null) {
  return value === null ? null : BigInt(Math.trunc(value));
}

function toDecimalOrNull(value: number | null) {
  return value === null || !Number.isFinite(value) ? null : value;
}

function pctChange(current: number | null, base: number | null) {
  return current !== null && base !== null && base > 0
    ? ((current - base) / base) * 100
    : null;
}

function sumVolumes(
  bars: TickerPriceConfirmationMarketData['minuteBars']
) {
  const values = bars.flatMap((bar) =>
    bar.volume !== null && bar.volume > 0 ? [bar.volume] : []
  );

  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0);
}

function weightedVwap(
  bars: TickerPriceConfirmationMarketData['minuteBars']
) {
  const weighted = bars.flatMap((bar) =>
    bar.vwap !== null && bar.volume !== null && bar.volume > 0
      ? [
          {
            value: bar.vwap * bar.volume,
            volume: bar.volume,
          },
        ]
      : []
  );
  const totalVolume = weighted.reduce((total, bar) => total + bar.volume, 0);

  return totalVolume === 0
    ? null
    : weighted.reduce((total, bar) => total + bar.value, 0) / totalVolume;
}

function filterRecentBars(
  data: TickerPriceConfirmationMarketData,
  now: Date,
  recentWindowMinutes: number
) {
  const cutoff = now.getTime() - recentWindowMinutes * 60_000;

  return data.minuteBars.filter((bar) => {
    const timestamp = new Date(bar.time).getTime();

    return !Number.isNaN(timestamp) && timestamp >= cutoff;
  });
}

function scoreRiskQuality(snapshot: PriceConfirmationSnapshot) {
  let score = 0;

  if (
    snapshot.lastPrice !== null &&
    snapshot.lastPrice >= env.MOMENTUM_CONFIRMATION_MIN_PRICE
  ) {
    score += 25;
  }

  if (
    snapshot.pctFromPreviousClose !== null &&
    snapshot.pctFromPreviousClose <= 15
  ) {
    score += 25;
  }

  if (
    snapshot.lastPrice !== null &&
    snapshot.sessionVwap !== null &&
    snapshot.sessionVwap > 0 &&
    ((snapshot.lastPrice - snapshot.sessionVwap) / snapshot.sessionVwap) *
      100 <=
      6
  ) {
    score += 25;
  }

  // Phase 4 does not yet call a regular-hours helper. Keep timing neutral.
  score += 25;

  return score;
}

function getHardBlockReason(
  candidate: MomentumCandidate,
  snapshot: PriceConfirmationSnapshot,
  now: Date
) {
  if (isMomentumCandidateExpired(candidate.expiresAt, now)) {
    return 'CANDIDATE_EXPIRED';
  }

  if (snapshot.lastPrice === null) {
    return 'MISSING_LAST_PRICE';
  }

  if (
    snapshot.previousClose === null ||
    snapshot.pctFromPreviousClose === null
  ) {
    return 'MISSING_PREVIOUS_CLOSE';
  }

  if (snapshot.lastPrice < env.MOMENTUM_CONFIRMATION_MIN_PRICE) {
    return 'PRICE_BELOW_MINIMUM';
  }

  if (
    snapshot.pctFromPreviousClose >
    env.MOMENTUM_CONFIRMATION_MAX_PCT_FROM_PREV_CLOSE
  ) {
    return 'EXTREME_OVEREXTENSION';
  }

  if (snapshot.recentVolume === null && snapshot.dayVolume === null) {
    return 'STALE_OR_EMPTY_AGGREGATE_DATA';
  }

  return null;
}

function nextStateForDecision(
  currentState: MomentumCandidateState,
  scores: PriceConfirmationScores
) {
  if (scores.blockedReason !== null) {
    return MomentumCandidateState.ENTRY_BLOCKED;
  }

  if (scores.totalConfirmationScore >= env.MOMENTUM_CONFIRMATION_ENTRY_READY_THRESHOLD) {
    return MomentumCandidateState.ENTRY_READY;
  }

  if (scores.totalConfirmationScore >= env.MOMENTUM_CONFIRMATION_WATCHING_THRESHOLD) {
    return MomentumCandidateState.WATCHING;
  }

  return currentState === MomentumCandidateState.DISCOVERED
    ? MomentumCandidateState.DISCOVERED
    : MomentumCandidateState.WATCHING;
}

function isJsonObject(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractCandidateBaseSnapshot(
  existing: Prisma.JsonValue | null
): Prisma.InputJsonObject {
  let current: Prisma.JsonValue | null = existing;
  const base: Record<string, Prisma.InputJsonValue> = {};

  while (isJsonObject(current)) {
    if (base.catalystEvent === undefined && current.catalystEvent !== undefined) {
      base.catalystEvent = current.catalystEvent as Prisma.InputJsonValue;
    }

    if (base.catalystImpact === undefined && current.catalystImpact !== undefined) {
      base.catalystImpact = current.catalystImpact as Prisma.InputJsonValue;
    }

    if (base.catalystEvent !== undefined && base.catalystImpact !== undefined) {
      break;
    }

    current = current.previous ?? null;
  }

  return base as Prisma.InputJsonObject;
}

function buildRawSnapshot(
  existing: Prisma.JsonValue | null,
  snapshot: PriceConfirmationSnapshot,
  scores: PriceConfirmationScores
): Prisma.InputJsonValue {
  return {
    ...extractCandidateBaseSnapshot(existing),
    latestPriceConfirmation: {
      observedAt: snapshot.observedAt.toISOString(),
      symbol: snapshot.symbol,
      lastPrice: snapshot.lastPrice,
      previousClose: snapshot.previousClose,
      pctFromPreviousClose: snapshot.pctFromPreviousClose,
      intradayHigh: snapshot.intradayHigh,
      intradayLow: snapshot.intradayLow,
      distanceFromHighPct: snapshot.distanceFromHighPct,
      sessionVwap: snapshot.sessionVwap,
      aboveVwap: snapshot.aboveVwap,
      dayVolume: snapshot.dayVolume,
      dollarVolume: snapshot.dollarVolume,
      relativeVolume: snapshot.relativeVolume,
      recentMovePct: snapshot.recentMovePct,
      recentVolume: snapshot.recentVolume,
      scores,
    },
  } satisfies Prisma.InputJsonValue;
}

export async function buildPriceConfirmationSnapshot(
  symbol: string,
  options: ConfirmCandidatePriceOptions = {}
): Promise<PriceConfirmationSnapshot> {
  const now = options.now ?? new Date();
  const recentWindowMinutes = normalizePositiveInteger(
    options.recentWindowMinutes,
    env.MOMENTUM_CONFIRMATION_RECENT_WINDOW_MINUTES
  );
  const data = await getTickerPriceConfirmationMarketData(symbol, {
    now,
    lookbackMinutes: normalizePositiveInteger(
      options.lookbackMinutes,
      env.MOMENTUM_CONFIRMATION_LOOKBACK_MINUTES
    ),
  });
  const lastPrice = data.snapshot.lastPrice;
  const previousClose = data.snapshot.previousClose;
  const pctFromPreviousClose = pctChange(lastPrice, previousClose);
  const barHighs = data.minuteBars.map((bar) => bar.high);
  const barLows = data.minuteBars.map((bar) => bar.low);
  const highCandidates = [
    data.snapshot.intradayHigh,
    barHighs.length > 0 ? Math.max(...barHighs) : null,
  ].flatMap((value) => (value === null ? [] : [value]));
  const lowCandidates = [
    data.snapshot.intradayLow,
    barLows.length > 0 ? Math.min(...barLows) : null,
  ].flatMap((value) => (value === null ? [] : [value]));
  const intradayHigh =
    highCandidates.length === 0 ? null : Math.max(...highCandidates);
  const intradayLow =
    lowCandidates.length === 0 ? null : Math.min(...lowCandidates);
  const distanceFromHighPct =
    lastPrice !== null && intradayHigh !== null && intradayHigh > 0
      ? ((intradayHigh - lastPrice) / intradayHigh) * 100
      : null;
  const sessionVwap =
    data.snapshot.sessionVwap ?? weightedVwap(data.minuteBars);
  const dayVolume = data.snapshot.dayVolume ?? sumVolumes(data.minuteBars);
  const dollarVolume =
    lastPrice !== null && dayVolume !== null ? lastPrice * dayVolume : null;
  const recentBars = filterRecentBars(data, now, recentWindowMinutes);
  const firstRecent = recentBars[0];
  const lastRecent = recentBars.at(-1);
  const recentMovePct =
    firstRecent && lastRecent
      ? pctChange(lastRecent.close, firstRecent.open)
      : null;

  return {
    symbol: data.symbol,
    observedAt: now,
    sourceObservedAt: data.snapshot.updatedTime === null
      ? null
      : new Date(data.snapshot.updatedTime),
    lastPrice,
    previousClose,
    pctFromPreviousClose,
    intradayHigh,
    intradayLow,
    distanceFromHighPct,
    sessionVwap,
    aboveVwap:
      lastPrice !== null && sessionVwap !== null ? lastPrice > sessionVwap : null,
    dayVolume,
    dollarVolume,
    relativeVolume: null,
    recentMovePct,
    recentVolume: sumVolumes(recentBars),
    rawPayload: data.rawPayload,
  };
}

export function scorePriceConfirmation(
  candidate: MomentumCandidate,
  snapshot: PriceConfirmationSnapshot,
  now = new Date()
): PriceConfirmationScores {
  const extensionFromVwapPct = snapshot.lastPrice !== null && snapshot.sessionVwap !== null && snapshot.sessionVwap > 0
    ? ((snapshot.lastPrice - snapshot.sessionVwap) / snapshot.sessionVwap) * 100
    : null;
  const priceResult = scoreMomentumPriceAction({
    percentFromPreviousClose: snapshot.pctFromPreviousClose,
    aboveVwap: snapshot.aboveVwap,
    distanceFromHighPct: snapshot.distanceFromHighPct,
    recentMovePct: snapshot.recentMovePct,
    extensionFromVwapPct,
    observedAt: now,
    sourceObservedAt: snapshot.sourceObservedAt,
    ...getNewYorkMarketTiming(now),
  });
  const priceActionScore = priceResult.score;
  const volumeResult = scoreMomentumVolume({
    dayVolume: snapshot.dayVolume,
    recentVolume: snapshot.recentVolume,
    dollarVolume: snapshot.dollarVolume,
    relativeVolume: snapshot.relativeVolume,
    minimumDollarVolume: env.MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME,
  });
  const volumeScore = volumeResult.score;
  const riskScore = scoreRiskQuality(snapshot);
  const totalConfirmationScore = Math.round(
    candidate.catalystScore * 0.45 +
      priceActionScore * 0.3 +
      volumeScore * 0.2 +
      riskScore * 0.05
  );
  const legacyBlock = getHardBlockReason(candidate, snapshot, now);
  const hardBlocks = [...new Set([
    ...(legacyBlock === null ? [] : [legacyBlock]),
    ...priceResult.hardBlocks,
    ...volumeResult.hardBlocks,
  ])];
  const blockedReason = hardBlocks[0] ?? null;
  const confirmed =
    blockedReason === null &&
    totalConfirmationScore >= env.MOMENTUM_CONFIRMATION_ENTRY_READY_THRESHOLD;

  return {
    priceActionScore,
    volumeScore,
    riskScore,
    totalConfirmationScore,
    confirmed,
    decision: blockedReason ?? (confirmed ? 'ENTRY_READY' : 'PRICE_CONFIRMED'),
    blockedReason,
    hardBlocks,
    reasons: [...priceResult.reasons, ...volumeResult.reasons],
    volumeMetricType: volumeResult.volumeMetricType,
    volumeIntensity: volumeResult.volumeIntensity,
  };
}

function buildScoringInputs(snapshot: PriceConfirmationSnapshot): Prisma.InputJsonValue {
  const marketTiming = getNewYorkMarketTiming(snapshot.observedAt);
  return {
    lastPrice: snapshot.lastPrice,
    previousClose: snapshot.previousClose,
    percentFromPreviousClose: snapshot.pctFromPreviousClose,
    storedVwap: snapshot.sessionVwap,
    aboveVwap: snapshot.aboveVwap,
    intradayHigh: snapshot.intradayHigh,
    intradayLow: snapshot.intradayLow,
    distanceFromHighPct: snapshot.distanceFromHighPct,
    recentMovePct: snapshot.recentMovePct,
    dayVolume: snapshot.dayVolume?.toString() ?? null,
    recentVolume: snapshot.recentVolume?.toString() ?? null,
    relativeVolume: snapshot.relativeVolume,
    volumeIntensity: snapshot.dayVolume !== null && snapshot.dayVolume > 0 && snapshot.recentVolume !== null
      ? snapshot.recentVolume / snapshot.dayVolume
      : null,
    volumeMetricType: 'VOLUME_INTENSITY_V1',
    dollarVolume: snapshot.dollarVolume,
    observedAt: snapshot.observedAt.toISOString(),
    sourceObservedAt: snapshot.sourceObservedAt?.toISOString() ?? null,
    marketSession: marketTiming.marketSession,
    newYorkMinuteOfDay: marketTiming.newYorkMinuteOfDay,
  };
}

function buildScoreReasons(snapshot: PriceConfirmationSnapshot, scores: PriceConfirmationScores) {
  const reasons: string[] = [];
  if (snapshot.pctFromPreviousClose !== null && snapshot.pctFromPreviousClose >= 2) reasons.push('Positive move from previous close contributed to price action.');
  if (snapshot.aboveVwap === true) reasons.push('Price above session VWAP contributed to price action.');
  if (snapshot.distanceFromHighPct !== null && snapshot.distanceFromHighPct <= 1.5) reasons.push('Price near the intraday high contributed to price action.');
  if (snapshot.recentMovePct !== null && snapshot.recentMovePct > 0) reasons.push('Positive recent move contributed to price action.');
  if (snapshot.dayVolume !== null && snapshot.dayVolume > 0) reasons.push('Positive cumulative day volume contributed to volume confirmation.');
  if (snapshot.dollarVolume !== null && snapshot.dollarVolume >= env.MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME) reasons.push('Dollar volume met the configured liquidity threshold.');
  if (snapshot.recentVolume !== null && snapshot.recentVolume > 0) reasons.push('Positive recent volume contributed to volume confirmation.');
  if (snapshot.relativeVolume === null) reasons.push('Relative volume was unavailable and contributed no points.');
  if (scores.blockedReason !== null) reasons.push(`Hard block applied: ${scores.blockedReason}.`);
  if (reasons.length === 0) reasons.push('Available observations did not satisfy a scoring rule.');
  return reasons;
}

function buildScoreExplanation(
  snapshot: PriceConfirmationSnapshot,
  scores: PriceConfirmationScores
): Prisma.InputJsonValue {
  const missingInputs = Object.entries({
    lastPrice: snapshot.lastPrice,
    previousClose: snapshot.previousClose,
    percentFromPreviousClose: snapshot.pctFromPreviousClose,
    storedVwap: snapshot.sessionVwap,
    intradayHigh: snapshot.intradayHigh,
    recentMovePct: snapshot.recentMovePct,
    dayVolume: snapshot.dayVolume,
    recentVolume: snapshot.recentVolume,
  }).flatMap(([field, value]) => value === null ? [field] : []);

  return {
    scoringVersion: MOMENTUM_CONFIRMATION_SCORING_VERSION,
    scoreRanges: {
      catalyst: { min: 0, max: 90 },
      priceAction: { min: 0, max: 100 },
      volume: { min: 0, max: 100, currentlyAttainableMax: 90 },
      setupQuality: { min: 0, max: 100, storedField: 'riskScore' },
      totalConfirmation: { min: 0, max: 96 },
    },
    componentScores: {
      priceAction: scores.priceActionScore,
      volume: scores.volumeScore,
      setupQuality: scores.riskScore,
      totalConfirmation: scores.totalConfirmationScore,
    },
    volumeMetric: {
      type: scores.volumeMetricType,
      intensity: scores.volumeIntensity,
      relativeVolume: snapshot.relativeVolume,
      relativeVolumeImplemented: snapshot.relativeVolume !== null,
    },
    hardBlocks: scores.hardBlocks,
    reasons: [...scores.reasons, ...buildScoreReasons(snapshot, scores)],
    decision: scores.decision,
    confirmed: scores.confirmed,
    dataCompleteness: {
      complete: missingInputs.length === 0,
      missingInputs,
    },
    formula: {
      catalystWeight: 0.45,
      priceActionWeight: 0.3,
      volumeWeight: 0.2,
      setupQualityWeight: 0.05,
      rounding: 'nearest_integer',
    },
  };
}

export async function applyPriceConfirmationDecision(
  candidate: MomentumCandidate,
  snapshot: PriceConfirmationSnapshot,
  scores: PriceConfirmationScores
) {
  const state = nextStateForDecision(candidate.state, scores);
  const check = await prisma.momentumCandidatePriceCheck.create({
    data: {
      momentumCandidateId: candidate.id,
      symbol: snapshot.symbol,
      observedAt: snapshot.observedAt,
      lastPrice: toDecimalOrNull(snapshot.lastPrice),
      previousClose: toDecimalOrNull(snapshot.previousClose),
      pctFromPreviousClose: toDecimalOrNull(snapshot.pctFromPreviousClose),
      intradayHigh: toDecimalOrNull(snapshot.intradayHigh),
      intradayLow: toDecimalOrNull(snapshot.intradayLow),
      distanceFromHighPct: toDecimalOrNull(snapshot.distanceFromHighPct),
      sessionVwap: toDecimalOrNull(snapshot.sessionVwap),
      aboveVwap: snapshot.aboveVwap,
      dayVolume: toBigIntOrNull(snapshot.dayVolume),
      dollarVolume: toDecimalOrNull(snapshot.dollarVolume),
      relativeVolume: toDecimalOrNull(snapshot.relativeVolume),
      recentMovePct: toDecimalOrNull(snapshot.recentMovePct),
      recentVolume: toBigIntOrNull(snapshot.recentVolume),
      priceActionScore: scores.priceActionScore,
      volumeScore: scores.volumeScore,
      riskScore: scores.riskScore,
      totalConfirmationScore: scores.totalConfirmationScore,
      confirmed: scores.confirmed,
      decision: scores.decision,
      blockedReason: scores.blockedReason,
      scoringVersion: MOMENTUM_CONFIRMATION_SCORING_VERSION,
      scoringInputs: buildScoringInputs(snapshot),
      scoreExplanation: buildScoreExplanation(snapshot, scores),
      rawPayload: snapshot.rawPayload as Prisma.InputJsonValue,
      metadata: {
        phase: 'momentum_price_confirmation_phase_4',
        scoringModel: 'simple_weighted_catalyst_price_volume_risk_v1',
      },
    },
  });
  const updatedCandidate = await prisma.momentumCandidate.update({
    where: {
      id: candidate.id,
    },
    data: {
      state,
      priceActionScore: scores.priceActionScore,
      volumeScore: scores.volumeScore,
      riskScore: scores.riskScore,
      totalScore: scores.totalConfirmationScore,
      blockedReason: scores.blockedReason,
      lastEvaluatedAt: snapshot.observedAt,
      rawSnapshot: buildRawSnapshot(candidate.rawSnapshot, snapshot, scores),
      metadata: {
        priceVolumeConfirmation: 'phase_4_manual',
        lastPriceConfirmationDecision: scores.decision,
      },
    },
  });

  return {
    candidate: updatedCandidate,
    priceCheck: check,
  };
}

export async function confirmCandidatePrice(
  candidateId: string,
  options: ConfirmCandidatePriceOptions = {}
) {
  const id = candidateId.trim();

  if (id === '') {
    throw new HttpError(400, 'Momentum candidate id is required.');
  }

  const candidate = await prisma.momentumCandidate.findUnique({
    where: { id },
    include: priceEligibilityInclude,
  });

  if (!candidate) {
    throw new HttpError(404, 'Momentum candidate not found.');
  }

  const eligibility = evaluateMomentumPriceConfirmationEligibility(
    priceEligibilityContext(candidate),
    options.now ?? new Date()
  );

  if (!eligibility.eligible) {
    return {
      skipped: true,
      reason: eligibility.reasons.join(', '),
      eligibility,
      candidate,
      priceCheck: null,
    };
  }

  const snapshot = await buildPriceConfirmationSnapshot(
    candidate.symbol,
    options
  );
  const scores = scorePriceConfirmation(
    candidate,
    snapshot,
    options.now ?? new Date()
  );
  const result = await applyPriceConfirmationDecision(
    candidate,
    snapshot,
    scores
  );

  return {
    skipped: false,
    eligibility,
    ...result,
  };
}

export async function confirmActiveCandidates(
  options: ConfirmActiveCandidatesOptions = {}
) {
  const maxCandidates = normalizePositiveInteger(
    options.maxCandidates,
    env.MOMENTUM_CONFIRMATION_MAX_SYMBOLS_PER_RUN
  );
  const states = options.state
    ? [options.state]
    : [...ACTIVE_MOMENTUM_CANDIDATE_STATES];
  const where: Prisma.MomentumCandidateWhereInput = {
    state: {
      in: states,
    },
  };

  if (options.minCatalystScore !== undefined) {
    where.catalystScore = {
      gte: options.minCatalystScore,
    };
  }

  const candidates = await prisma.momentumCandidate.findMany({
    where,
    orderBy: [
      {
        totalScore: 'desc',
      },
      {
        discoveredAt: 'asc',
      },
    ],
    take: Math.min(
      maxCandidates * MAX_ELIGIBILITY_SCAN_MULTIPLIER,
      MAX_ELIGIBILITY_SCAN_CANDIDATES
    ),
    include: priceEligibilityInclude,
  });
  const summary = {
    evaluated: 0,
    entryReady: 0,
    watching: 0,
    blocked: 0,
    skipped: 0,
    skipCounts: {} as Record<string, number>,
    errors: [] as Array<{ candidateId: string; symbol: string; message: string }>,
    results: [] as Awaited<ReturnType<typeof confirmCandidatePrice>>[],
  };
  let selectedForConfirmation = 0;

  for (const candidate of candidates) {
    try {
      const eligibility = evaluateMomentumPriceConfirmationEligibility(
        priceEligibilityContext(candidate),
        options.now ?? new Date()
      );

      if (!eligibility.eligible) {
        summary.skipped += 1;
        for (const reason of eligibility.reasons) {
          summary.skipCounts[reason] = (summary.skipCounts[reason] ?? 0) + 1;
        }
        summary.results.push({
          skipped: true,
          reason: eligibility.reasons.join(', '),
          eligibility,
          candidate,
          priceCheck: null,
        });
        continue;
      }

      if (selectedForConfirmation >= maxCandidates) break;
      selectedForConfirmation += 1;

      const result = await confirmCandidatePrice(candidate.id, options);
      summary.results.push(result);

      if (result.skipped) {
        summary.skipped += 1;
        continue;
      }

      summary.evaluated += 1;

      if (result.candidate.state === MomentumCandidateState.ENTRY_READY) {
        summary.entryReady += 1;
      } else if (
        result.candidate.state === MomentumCandidateState.ENTRY_BLOCKED
      ) {
        summary.blocked += 1;
      } else if (result.candidate.state === MomentumCandidateState.WATCHING) {
        summary.watching += 1;
      }
    } catch (error) {
      summary.errors.push({
        candidateId: candidate.id,
        symbol: candidate.symbol,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return summary;
}

export async function listMomentumCandidatePriceChecks(
  candidateId: string,
  options: ListMomentumCandidatePriceChecksOptions = {}
) {
  const id = candidateId.trim();

  if (id === '') {
    throw new HttpError(400, 'Momentum candidate id is required.');
  }

  const candidate = await prisma.momentumCandidate.findUnique({
    where: {
      id,
    },
    select: {
      id: true,
    },
  });

  if (!candidate) {
    throw new HttpError(404, 'Momentum candidate not found.');
  }

  return prisma.momentumCandidatePriceCheck.findMany({
    where: {
      momentumCandidateId: id,
    },
    orderBy: {
      observedAt: 'desc',
    },
    take: Math.min(
      normalizePositiveInteger(options.limit, 25),
      100
    ),
  });
}
