import { Prisma } from '@prisma/client';
import type { AssetType } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export type GetAllSecuritiesParams = {
  page?: number | undefined;
  pageSize?: number | undefined;
  search?: string | undefined;
  sector?: string | undefined;
  industry?: string | undefined;
  enabled?: boolean | undefined;
  subscriptionStatus?: SecuritySubscriptionStatusFilter | undefined;
};

export type SecuritySubscriptionStatusFilter =
  | 'all'
  | 'configured'
  | 'unconfigured';


const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;

function normalizePositiveInt(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }

  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildSecurityWhere(params: GetAllSecuritiesParams): Prisma.SecurityWhereInput {
  const search = normalizeOptionalString(params.search);
  const sector = normalizeOptionalString(params.sector);
  const industry = normalizeOptionalString(params.industry);
  const enabled = params.enabled;
  const subscriptionStatus = params.subscriptionStatus ?? 'all';

  const where: Prisma.SecurityWhereInput = {};

  if (search) {
    where.OR = [
      {
        symbol: {
          contains: search,
          mode: 'insensitive',
        },
      },
      {
        name: {
          contains: search,
          mode: 'insensitive',
        },
      },
    ];
  }

  if (sector) {
    where.sector = sector;
  }

  if (industry) {
    where.industry = industry;
  }

  if (enabled !== undefined) {
    where.enabled = enabled;
  }

  if (subscriptionStatus === 'configured') {
    where.subscriptions = {
      some: {},
    };
  }

  if (subscriptionStatus === 'unconfigured') {
    where.subscriptions = {
      none: {},
    };
  }

  return where;
}

export async function findSecurity(symbol: string) {
  const normalizedSymbol = symbol.trim().toUpperCase();

  const security = await prisma.security.findUnique({
    where: { symbol: normalizedSymbol },
    include: {
      subscriptions: {
        orderBy: { key: 'asc' },
        include: {
          strategy: true,
          exitProfile: true,
        },
      },
    },
  });

  return security;
}

export async function getAllSecurities(params: GetAllSecuritiesParams = {}) {
  const page = normalizePositiveInt(params.page, DEFAULT_PAGE);
  const requestedPageSize = normalizePositiveInt(params.pageSize, DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  const skip = (page - 1) * pageSize;

  const where = buildSecurityWhere(params);

  const [data, total, sectorRows, industryRows] = await prisma.$transaction([
    prisma.security.findMany({
      where,
      orderBy: { symbol: 'asc' },
      skip,
      take: pageSize,
      include: {
        _count: {
          select: { subscriptions: true },
        },
      },
    }),
    prisma.security.count({ where }),
    prisma.security.findMany({
      where: {
        sector: {
          not: null,
        },
      },
      distinct: ['sector'],
      select: {
        sector: true,
      },
      orderBy: {
        sector: 'asc',
      },
    }),
    prisma.security.findMany({
      where: {
        industry: {
          not: null,
        },
      },
      distinct: ['industry'],
      select: {
        industry: true,
      },
      orderBy: {
        industry: 'asc',
      },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const mapped = data.map(({ _count, ...security }) => ({
    ...security,
    subscriptionCount: _count.subscriptions,
  }));

  return {
    data: mapped,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
    },
    filters: {
      sectors: sectorRows
        .map((row) => row.sector)
        .filter((sector): sector is string => Boolean(sector)),
      industries: industryRows
        .map((row) => row.industry)
        .filter((industry): industry is string => Boolean(industry)),
    },
  };
}

export async function addSecurity(
  symbol: string,
  name: string,
  assetType: AssetType,
  sector?: string,
  industry?: string
) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedName = name.trim();
  const normalizedAssetType = assetType.trim().toUpperCase() as AssetType;

  const security = await prisma.security.upsert({
    where: { symbol: normalizedSymbol },
    update: {},
    create: {
      symbol: normalizedSymbol,
      name: normalizedName,
      assetType: normalizedAssetType,
      sector: sector?.trim() || null,
      industry: industry?.trim() || null,
    },
  });

  return security;
}

export async function updateSecurity(
  symbol: string,
  input: {
    name?: string | undefined;
    enabled?: boolean | undefined;
    assetType?: AssetType | undefined;
    sector?: string | undefined;
    industry?: string | undefined;
  }
) {
  const normalizedSymbol = symbol.trim().toUpperCase();

  const data: Prisma.SecurityUpdateInput = {};

  if (input.name !== undefined) {
    data.name = input.name.trim();
  }

  if (input.enabled !== undefined) {
    data.enabled = input.enabled;
  }

  if (input.assetType !== undefined) {
    data.assetType = input.assetType;
  }

  if (input.sector !== undefined) {
    data.sector = input.sector.trim() || null;
  }

  if (input.industry !== undefined) {
    data.industry = input.industry.trim() || null;
  }

  const security = await prisma.security.update({
    where: { symbol: normalizedSymbol },
    data,
  });

  return security;
}