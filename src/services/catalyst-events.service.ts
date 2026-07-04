import {
  CatalystEventType,
  CatalystSource,
  CatalystTier,
  Prisma,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

export type CatalystEventFilters = {
  limit?: number;
  symbol?: string;
  source?: CatalystSource;
  eventType?: CatalystEventType;
  eventTier?: CatalystTier;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

function normalizeLimit(limit: number | undefined) {
  if (!Number.isInteger(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(limit, MAX_LIMIT);
}

export async function listCatalystEvents(filters: CatalystEventFilters = {}) {
  const where: Prisma.CatalystEventWhereInput = {};

  if (filters.source !== undefined) {
    where.source = filters.source;
  }

  if (filters.eventType !== undefined) {
    where.eventType = filters.eventType;
  }

  if (filters.eventTier !== undefined) {
    where.eventTier = filters.eventTier;
  }

  if (filters.symbol !== undefined) {
    where.tickerImpacts = {
      some: {
        symbol: filters.symbol.trim().toUpperCase(),
      },
    };
  }

  return prisma.catalystEvent.findMany({
    where,
    orderBy: [
      {
        publishedAt: {
          sort: 'desc',
          nulls: 'last',
        },
      },
      {
        receivedAt: 'desc',
      },
    ],
    take: normalizeLimit(filters.limit),
    include: {
      tickerImpacts: {
        orderBy: [
          {
            totalCatalystScore: 'desc',
          },
          {
            symbol: 'asc',
          },
        ],
      },
    },
  });
}

export async function getCatalystEventById(id: string) {
  const catalystEvent = await prisma.catalystEvent.findUnique({
    where: { id },
    include: {
      tickerImpacts: {
        orderBy: [
          {
            totalCatalystScore: 'desc',
          },
          {
            symbol: 'asc',
          },
        ],
      },
    },
  });

  if (!catalystEvent) {
    throw new HttpError(404, 'Catalyst event not found.');
  }

  return catalystEvent;
}
