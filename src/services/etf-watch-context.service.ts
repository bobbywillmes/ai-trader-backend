import { prisma } from '../db/prisma.js';
import { getCurrentMarketState, getMarketDiaryEvents } from './market-state.service.js';
import { getOpenTrackedPositions } from './position-tracking.service.js';

const ETF_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'];

export async function getEtfWatchContext() {
  const [marketState, openPositions, diaryEvents, etfSubscriptions] =
    await Promise.all([
      getCurrentMarketState(),
      getOpenTrackedPositions(),
      getMarketDiaryEvents({ limit: 10 }),
      prisma.subscription.findMany({
        where: {
          enabled: true,
          symbol: {
            in: ETF_SYMBOLS,
          },
          strategy: {
            key: 'dip_n_ride_etf',
          },
        },
        include: {
          strategy: true,
          exitProfile: true,
          security: true,
        },
        orderBy: {
          symbol: 'asc',
        },
      }),
    ]);

  return {
    symbols: ETF_SYMBOLS,
    marketState,
    openPositions,
    etfSubscriptions,
    diaryEvents,
  };
}