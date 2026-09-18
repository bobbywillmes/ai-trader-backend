import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api';
import type { CalendarInput, TrendProfile } from './types';
export const useCalendar = (year: number) => useQuery({ queryKey: ['market-calendar', year], queryFn: () => api.getCalendar(year) });
export function useSaveCalendar() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ input, id }: { input: CalendarInput; id?: number }) => api.saveCalendar(input, id), onSuccess: () => { void client.invalidateQueries({ queryKey: ['market-calendar'] }); void client.invalidateQueries({ queryKey: ['market-data-status'] }); } });
}
export function useDeleteCalendar() {
  const client = useQueryClient();
  return useMutation({ mutationFn: api.deleteCalendar, onSuccess: () => { void client.invalidateQueries({ queryKey: ['market-calendar'] }); void client.invalidateQueries({ queryKey: ['market-data-status'] }); } });
}
export const useMarketDataStatus = () => useQuery({ queryKey: ['market-data-status'], queryFn: api.getMarketDataStatus, refetchInterval: 60_000 });
export const useTrendLab = (from: string, to: string) => useQuery({ queryKey: ['trend-lab', from, to], queryFn: () => api.getTrendLab(from, to), retry: false, staleTime: 60_000 });
export const useTrendDay = (datasetId: string | undefined, profile: TrendProfile, date: string | undefined, from: string, to: string) => useQuery({ queryKey: ['trend-day', datasetId, profile, date, from, to], queryFn: () => api.getTrendDay(datasetId!, profile, date!, from, to), enabled: Boolean(datasetId && date), retry: false });

export function useRefreshTrendLab(from: string, to: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await client.cancelQueries({ queryKey: ['trend-lab', from, to], exact: true });
      return { data: await api.getTrendLab(from, to, true), from, to };
    },
    onSuccess: async ({ data, from: refreshedFrom, to: refreshedTo }) => {
      client.setQueryData(['trend-lab', refreshedFrom, refreshedTo], data);
      await client.invalidateQueries({ queryKey: ['trend-day'], predicate: query => query.queryKey[4] === refreshedFrom && query.queryKey[5] === refreshedTo });
    },
  });
}
