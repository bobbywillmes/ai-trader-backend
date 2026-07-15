import { CatalystSource, type NewsPullCursor, type Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

const MAX_CURSOR_ERROR_LENGTH = 500;
const DEFAULT_PULL_INTERVAL_MIN = 15;
const MASSIVE_NEWS_COVERAGE_OWNER = 'momentum_universe_sync';
const LEGACY_MASSIVE_NEWS_SEED = 'phase_2_massive_news_worker';

type MassiveNewsCoverage = {
  symbol: string;
  priority: number;
  pullIntervalMin: number;
  sources: Array<'universe' | 'position'>;
};

type EnsureNewsPullCursorsArgs = {
  source: CatalystSource;
  symbols: string[];
  priority?: number;
  pullIntervalMin?: number;
  metadata?: Prisma.InputJsonValue;
};

type ListDueNewsPullCursorsArgs = {
  source: CatalystSource;
  now?: Date;
  take?: number;
};

type RecordCursorSuccessArgs = {
  source: CatalystSource;
  symbol: string;
  pulledAt?: Date;
  newestPublishedAt?: Date | null;
};

type RecordCursorErrorArgs = {
  source: CatalystSource;
  symbol: string;
  error: unknown;
  pulledAt?: Date | null;
};

function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase();

  return symbol === '' ? null : symbol;
}

function uniqueNormalizedSymbols(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeSymbol(value))
        .filter((value): value is string => value !== null)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function isCursorDue(cursor: Pick<NewsPullCursor, 'lastPulledAt' | 'pullIntervalMin'>, now: Date) {
  if (!cursor.lastPulledAt) {
    return true;
  }

  return (
    now.getTime() - cursor.lastPulledAt.getTime() >=
    Math.max(1, cursor.pullIntervalMin) * 60_000
  );
}

function sortDueCursors<T extends Pick<NewsPullCursor, 'priority' | 'lastPulledAt' | 'symbol'>>(
  cursors: T[]
) {
  return [...cursors].sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }

    if (!a.lastPulledAt && b.lastPulledAt) {
      return -1;
    }

    if (a.lastPulledAt && !b.lastPulledAt) {
      return 1;
    }

    const aTime = a.lastPulledAt?.getTime() ?? 0;
    const bTime = b.lastPulledAt?.getTime() ?? 0;

    if (aTime !== bTime) {
      return aTime - bTime;
    }

    return a.symbol.localeCompare(b.symbol);
  });
}

function sanitizeCursorError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return message.replace(/\s+/g, ' ').slice(0, MAX_CURSOR_ERROR_LENGTH);
}

export function getNewestPublishedAtFromMassiveNewsPayload(payload: {
  results?: unknown;
}) {
  if (!Array.isArray(payload.results)) {
    return null;
  }

  const newest = payload.results
    .flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return [];
      }

      const raw = 'published_utc' in item ? item.published_utc : null;

      if (typeof raw !== 'string' || raw.trim() === '') {
        return [];
      }

      const publishedAt = new Date(raw);

      return Number.isNaN(publishedAt.getTime()) ? [] : [publishedAt];
    })
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return newest ?? null;
}

export async function getMassiveNewsSeedSymbols() {
  const coverage = await getMassiveNewsCoverage();

  return coverage.map((item) => item.symbol);
}

export async function getMassiveNewsCoverage(): Promise<MassiveNewsCoverage[]> {
  const [universeMembers, openPositions] = await Promise.all([
    prisma.momentumUniverseMember.findMany({
      where: {
        enabled: true,
        newsEnabled: true,
      },
      select: {
        priority: true,
        pullIntervalMin: true,
        security: {
          select: {
            symbol: true,
          },
        },
      },
    }),
    prisma.trackedPosition.findMany({
      where: {
        status: {
          in: ['open', 'closing'],
        },
      },
      select: {
        symbol: true,
      },
    }),
  ]);

  const coverageBySymbol = new Map<string, MassiveNewsCoverage>();

  function addCoverage(
    rawSymbol: string,
    source: MassiveNewsCoverage['sources'][number],
    options: { priority?: number; pullIntervalMin?: number } = {}
  ) {
    const symbol = normalizeSymbol(rawSymbol);

    if (!symbol) {
      return;
    }

    const priority = options.priority ?? 0;
    const pullIntervalMin = Math.max(
      1,
      options.pullIntervalMin ?? DEFAULT_PULL_INTERVAL_MIN
    );
    const existing = coverageBySymbol.get(symbol);

    if (!existing) {
      coverageBySymbol.set(symbol, {
        symbol,
        priority,
        pullIntervalMin,
        sources: [source],
      });
      return;
    }

    existing.priority = Math.max(existing.priority, priority);
    existing.pullIntervalMin = Math.min(existing.pullIntervalMin, pullIntervalMin);

    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
  }

  for (const member of universeMembers) {
    addCoverage(member.security.symbol, 'universe', {
      priority: member.priority,
      pullIntervalMin: member.pullIntervalMin,
    });
  }

  for (const position of openPositions) {
    addCoverage(position.symbol, 'position');
  }

  return [...coverageBySymbol.values()]
    .map((item) => ({
      ...item,
      sources: [...item.sources].sort() as MassiveNewsCoverage['sources'],
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function ensureNewsPullCursors(args: EnsureNewsPullCursorsArgs) {
  const symbols = uniqueNormalizedSymbols(args.symbols);
  const metadataData =
    args.metadata === undefined ? {} : { metadata: args.metadata };

  await Promise.all(
    symbols.map((symbol) =>
      prisma.newsPullCursor.upsert({
        where: {
          source_symbol: {
            source: args.source,
            symbol,
          },
        },
        create: {
          source: args.source,
          symbol,
          enabled: true,
          priority: args.priority ?? 0,
          pullIntervalMin: args.pullIntervalMin ?? 15,
          ...metadataData,
        },
        update: metadataData,
      })
    )
  );

  return {
    source: args.source,
    ensured: symbols.length,
    symbols,
  };
}

export async function ensureMassiveNewsPullCursors() {
  const coverage = await getMassiveNewsCoverage();
  const desiredSymbols = new Set(coverage.map((item) => item.symbol));
  const existingCursors = await prisma.newsPullCursor.findMany({
    where: {
      source: CatalystSource.MASSIVE_NEWS,
    },
  });

  await Promise.all([
    ...coverage.map((item) =>
      prisma.newsPullCursor.upsert({
        where: {
          source_symbol: {
            source: CatalystSource.MASSIVE_NEWS,
            symbol: item.symbol,
          },
        },
        create: {
          source: CatalystSource.MASSIVE_NEWS,
          symbol: item.symbol,
          enabled: true,
          priority: item.priority,
          pullIntervalMin: item.pullIntervalMin,
          metadata: {
            coverageOwner: MASSIVE_NEWS_COVERAGE_OWNER,
            coverageSources: item.sources,
          },
        },
        update: {
          enabled: true,
          priority: item.priority,
          pullIntervalMin: item.pullIntervalMin,
          metadata: {
            coverageOwner: MASSIVE_NEWS_COVERAGE_OWNER,
            coverageSources: item.sources,
          },
        },
      })
    ),
    ...existingCursors
      .filter(
        (cursor) =>
          isManagedMassiveNewsCursor(cursor.metadata) &&
          !desiredSymbols.has(cursor.symbol)
      )
      .map((cursor) =>
        prisma.newsPullCursor.update({
          where: { id: cursor.id },
          data: {
            enabled: false,
            metadata: {
              coverageOwner: MASSIVE_NEWS_COVERAGE_OWNER,
              coverageSources: [],
            },
          },
        })
      ),
  ]);

  return {
    source: CatalystSource.MASSIVE_NEWS,
    ensured: coverage.length,
    disabled: existingCursors.filter(
      (cursor) =>
        isManagedMassiveNewsCursor(cursor.metadata) &&
        !desiredSymbols.has(cursor.symbol)
    ).length,
    symbols: coverage.map((item) => item.symbol),
  };
}

function isManagedMassiveNewsCursor(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }

  return (
    metadata.coverageOwner === MASSIVE_NEWS_COVERAGE_OWNER ||
    metadata.seedUniverse === LEGACY_MASSIVE_NEWS_SEED
  );
}

export async function listDueNewsPullCursors(args: ListDueNewsPullCursorsArgs) {
  const now = args.now ?? new Date();
  const cursors = await prisma.newsPullCursor.findMany({
    where: {
      source: args.source,
      enabled: true,
    },
  });
  const due = sortDueCursors(
    cursors.filter((cursor) => isCursorDue(cursor, now))
  );

  return args.take === undefined ? due : due.slice(0, args.take);
}

export async function recordNewsPullCursorSuccess(
  args: RecordCursorSuccessArgs
) {
  const symbol = normalizeSymbol(args.symbol);

  if (!symbol) {
    throw new Error('News pull cursor symbol is required.');
  }

  const pulledAt = args.pulledAt ?? new Date();

  return prisma.newsPullCursor.update({
    where: {
      source_symbol: {
        source: args.source,
        symbol,
      },
    },
    data: {
      lastPulledAt: pulledAt,
      ...(args.newestPublishedAt ? { lastPublishedAt: args.newestPublishedAt } : {}),
      consecutiveErrors: 0,
      lastError: null,
    },
  });
}

export async function recordNewsPullCursorError(args: RecordCursorErrorArgs) {
  const symbol = normalizeSymbol(args.symbol);

  if (!symbol) {
    throw new Error('News pull cursor symbol is required.');
  }

  return prisma.newsPullCursor.update({
    where: {
      source_symbol: {
        source: args.source,
        symbol,
      },
    },
    data: {
      ...(args.pulledAt ? { lastPulledAt: args.pulledAt } : {}),
      consecutiveErrors: {
        increment: 1,
      },
      lastError: sanitizeCursorError(args.error),
    },
  });
}
