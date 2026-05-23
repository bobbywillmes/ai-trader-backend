import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

const CURRENT_MARKET_STATE_ID = 1;

type UpdateCurrentMarketStateInput = {
  marketBias?: string;
  riskMode?: string;
  macroSummary?: string | null;
  watchFor?: string | null;
  avoidBecause?: string | null;
  notes?: string | null;
  source?: string;
  validUntil?: Date | null;
  lastLlmRunAt?: Date | null;
  payloadJson?: Prisma.InputJsonValue | null;
};

type CreateMarketDiaryEventInput = {
  eventType: string;
  source?: string;
  symbol?: string | null;
  summary: string;
  details?: string | null;
  symbolsJson?: Prisma.InputJsonValue | null;
  payloadJson?: Prisma.InputJsonValue | null;
};

type GetMarketDiaryEventsInput = {
  limit?: number;
  eventType?: string;
  source?: string;
  symbol?: string;
};

export async function getCurrentMarketState() {
  return prisma.currentMarketState.upsert({
    where: { id: CURRENT_MARKET_STATE_ID },
    create: {
      id: CURRENT_MARKET_STATE_ID,
      marketBias: 'neutral',
      riskMode: 'normal',
      source: 'system',
    },
    update: {},
  });
}

export async function updateCurrentMarketState(
  input: UpdateCurrentMarketStateInput
) {
  const data: Prisma.CurrentMarketStateUpdateInput = {};

  if (input.marketBias !== undefined)     data.marketBias   = input.marketBias;
  if (input.riskMode !== undefined)       data.riskMode     = input.riskMode;
  if (input.macroSummary !== undefined)   data.macroSummary = input.macroSummary;
  if (input.watchFor !== undefined)       data.watchFor     = input.watchFor;
  if (input.avoidBecause !== undefined)   data.avoidBecause = input.avoidBecause;
  if (input.notes !== undefined)          data.notes        = input.notes;
  if (input.source !== undefined)         data.source       = input.source;
  if (input.validUntil !== undefined)     data.validUntil   = input.validUntil;
  if (input.lastLlmRunAt !== undefined)   data.lastLlmRunAt = input.lastLlmRunAt;
  if (input.payloadJson !== undefined) {
    data.payloadJson = input.payloadJson as Prisma.InputJsonValue;
  }

  return prisma.currentMarketState.upsert({
    where: { id: CURRENT_MARKET_STATE_ID },
    create: {
      id: CURRENT_MARKET_STATE_ID,
      marketBias:   input.marketBias    ?? 'neutral',
      riskMode:     input.riskMode      ?? 'normal',
      macroSummary: input.macroSummary  ?? null,
      watchFor:     input.watchFor      ?? null,
      avoidBecause: input.avoidBecause  ?? null,
      notes:        input.notes         ?? null,
      source:       input.source        ?? 'system',
      validUntil:   input.validUntil    ?? null,
      lastLlmRunAt: input.lastLlmRunAt  ?? null,
      ...(input.payloadJson !== undefined
        ? { payloadJson: input.payloadJson as Prisma.InputJsonValue }
        : {}),
    },
    update: data,
  });
}

export async function createMarketDiaryEvent(input: CreateMarketDiaryEventInput) {
  return prisma.marketDiaryEvent.create({
    data: {
      eventType: input.eventType,
      summary: input.summary,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.symbol !== undefined ? { symbol: input.symbol ?? null } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.symbolsJson !== undefined
        ? { symbolsJson: input.symbolsJson as Prisma.InputJsonValue }
        : {}),
      ...(input.payloadJson !== undefined
        ? { payloadJson: input.payloadJson as Prisma.InputJsonValue }
        : {}),
    },
  });
}

export async function getMarketDiaryEvents(input: GetMarketDiaryEventsInput) {
  const where: Prisma.MarketDiaryEventWhereInput = {};

  if (input.eventType) where.eventType = input.eventType;
  if (input.source) where.source = input.source;
  if (input.symbol) where.symbol = input.symbol;

  return prisma.marketDiaryEvent.findMany({
    where,
    orderBy: {
      createdAt: 'desc',
    },
    take: Math.min(input.limit ?? 100, 500),
  });
}