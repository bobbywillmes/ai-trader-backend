import { useQuery } from '@tanstack/react-query';
import { getCurrentMarketState, getMarketDiaryEvents } from './api';

export function useCurrentMarketState(token: string | null) {
  return useQuery({
    queryKey: ['market-state', 'current'],
    queryFn: () => getCurrentMarketState(token ?? ''),
    enabled: Boolean(token),
    refetchInterval: 60_000,
  });
}

export function useMarketDiaryEvents(token: string | null) {
  return useQuery({
    queryKey: ['market-diary', 'events'],
    queryFn: () => getMarketDiaryEvents(token ?? ''),
    enabled: Boolean(token),
    refetchInterval: 60_000,
  });
}