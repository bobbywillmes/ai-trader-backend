import { useQuery } from "@tanstack/react-query";
import { getTradeCycle, getTradeCycles } from "./api";
import type { TradeCyclesQuery } from "./types";

export const tradeHistoryKeys = {
  list: (query: TradeCyclesQuery) => ["tradeCycles", query] as const,
  detail: (id: number | null) => ["tradeCycles", "detail", id] as const,
};

export function useTradeCycles(
  token: string | null,
  query: TradeCyclesQuery
) {
  return useQuery({
    queryKey: tradeHistoryKeys.list(query),
    queryFn: () => getTradeCycles(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useTradeCycle(token: string | null, id: number | null) {
  return useQuery({
    queryKey: tradeHistoryKeys.detail(id),
    queryFn: () => getTradeCycle(token as string, id as number),
    enabled: Boolean(token) && id !== null,
    staleTime: 15000,
  });
}
