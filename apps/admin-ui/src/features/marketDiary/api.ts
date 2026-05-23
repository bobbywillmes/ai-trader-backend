import { apiRequest } from '../../lib/api';
import type { CurrentMarketState, MarketDiaryEvent } from './types';

export function getCurrentMarketState(token: string) {
  return apiRequest<CurrentMarketState>('/api/market-state/current', {
    token,
  });
}

export function getMarketDiaryEvents(token: string) {
  return apiRequest<MarketDiaryEvent[]>('/api/market-diary/events?limit=25', {
    token,
  });
}