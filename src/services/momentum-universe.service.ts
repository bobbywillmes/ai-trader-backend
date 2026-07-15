import { CatalystSource, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { serializeMomentumUniverseMember } from '../serializers/momentum-universe.serializer.js';
import { momentumSubscriptionEligibilitySelect } from './momentum-subscription-eligibility.service.js';
import type {
  CreateMomentumUniverseMemberInput,
  ListMomentumUniverseInput,
  UpdateMomentumUniverseMemberInput,
} from '../validators/momentum-universe.schema.js';

const memberInclude = {
  security: {
    include: {
      _count: {
        select: { subscriptions: true },
      },
      subscriptions: { select: momentumSubscriptionEligibilitySelect },
    },
  },
} as const satisfies Prisma.MomentumUniverseMemberInclude;

function toMemberData(input: UpdateMomentumUniverseMemberInput) {
  const data: Prisma.MomentumUniverseMemberUpdateInput = {};

  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.newsEnabled !== undefined) data.newsEnabled = input.newsEnabled;
  if (input.priceScanningEnabled !== undefined) {
    data.priceScanningEnabled = input.priceScanningEnabled;
  }
  if (input.pullIntervalMin !== undefined) {
    data.pullIntervalMin = input.pullIntervalMin;
  }
  if (input.addedReason !== undefined) data.addedReason = input.addedReason;
  if (input.notes !== undefined) data.notes = input.notes;

  return data;
}

function toCreateMemberData(input: CreateMomentumUniverseMemberInput) {
  const data: Prisma.MomentumUniverseMemberUncheckedCreateInput = {
    securityId: input.securityId,
  };

  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.newsEnabled !== undefined) data.newsEnabled = input.newsEnabled;
  if (input.priceScanningEnabled !== undefined) {
    data.priceScanningEnabled = input.priceScanningEnabled;
  }
  if (input.pullIntervalMin !== undefined) {
    data.pullIntervalMin = input.pullIntervalMin;
  }
  if (input.addedReason !== undefined) data.addedReason = input.addedReason;
  if (input.notes !== undefined) data.notes = input.notes;

  return data;
}

function buildWhere(
  filters: Pick<ListMomentumUniverseInput, 'enabled' | 'search'>
): Prisma.MomentumUniverseMemberWhereInput {
  return {
    ...(filters.enabled === undefined ? {} : { enabled: filters.enabled }),
    ...(filters.search
      ? {
          security: {
            OR: [
              { symbol: { contains: filters.search, mode: 'insensitive' as const } },
              { name: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          },
        }
      : {}),
  };
}

async function attachCursorSummaries(
  members: Array<Prisma.MomentumUniverseMemberGetPayload<{ include: typeof memberInclude }>>
) {
  const cursors = await prisma.newsPullCursor.findMany({
    where: {
      source: CatalystSource.MASSIVE_NEWS,
      symbol: { in: members.map((member) => member.security.symbol) },
    },
    select: {
      symbol: true,
      source: true,
      enabled: true,
      lastPulledAt: true,
      lastPublishedAt: true,
      consecutiveErrors: true,
      lastError: true,
    },
  });
  const cursorBySymbol = new Map(cursors.map(({ symbol, ...cursor }) => [symbol, cursor]));

  return members.map((member) =>
    serializeMomentumUniverseMember(
      member,
      cursorBySymbol.get(member.security.symbol) ?? null
    )
  );
}

export async function listMomentumUniverseMembers(filters: ListMomentumUniverseInput) {
  const where = buildWhere(filters);
  const skip = (filters.page - 1) * filters.pageSize;
  const [members, total] = await prisma.$transaction([
    prisma.momentumUniverseMember.findMany({
      where,
      include: memberInclude,
      orderBy: [{ priority: 'desc' }, { security: { symbol: 'asc' } }],
      skip,
      take: filters.pageSize,
    }),
    prisma.momentumUniverseMember.count({ where }),
  ]);

  return {
    data: await attachCursorSummaries(members),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

export async function createMomentumUniverseMember(
  input: CreateMomentumUniverseMemberInput
) {
  const security = await prisma.security.findUnique({
    where: { id: input.securityId },
    select: { id: true },
  });

  if (!security) {
    throw new HttpError(404, 'Security not found.');
  }

  const existing = await prisma.momentumUniverseMember.findUnique({
    where: { securityId: input.securityId },
    select: { id: true },
  });

  if (existing) {
    throw new HttpError(409, 'Security is already a momentum universe member.');
  }

  let member: Prisma.MomentumUniverseMemberGetPayload<{
    include: typeof memberInclude;
  }>;

  try {
    member = await prisma.momentumUniverseMember.create({
      data: toCreateMemberData(input),
      include: memberInclude,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new HttpError(409, 'Security is already a momentum universe member.');
    }

    throw error;
  }

  return (await attachCursorSummaries([member]))[0];
}

export async function updateMomentumUniverseMember(
  id: string,
  input: UpdateMomentumUniverseMemberInput
) {
  const existing = await prisma.momentumUniverseMember.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    throw new HttpError(404, 'Momentum universe member not found.');
  }

  const member = await prisma.momentumUniverseMember.update({
    where: { id },
    data: toMemberData(input),
    include: memberInclude,
  });

  return (await attachCursorSummaries([member]))[0];
}

export async function deleteMomentumUniverseMember(id: string) {
  const existing = await prisma.momentumUniverseMember.findUnique({
    where: { id },
    include: memberInclude,
  });

  if (!existing) {
    throw new HttpError(404, 'Momentum universe member not found.');
  }

  await prisma.momentumUniverseMember.delete({ where: { id } });

  return serializeMomentumUniverseMember(existing, null);
}
