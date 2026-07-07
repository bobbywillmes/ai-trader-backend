import { apiRequest } from "../../lib/api";
import type {
  TradeCycleDetailResponse,
  TradeCyclesQuery,
  TradeCyclesResponse,
} from "./types";

function buildQuery(params: TradeCyclesQuery) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }

  const query = search.toString();

  return query ? `?${query}` : "";
}

export function getTradeCycles(token: string, query: TradeCyclesQuery = {}) {
  return apiRequest<TradeCyclesResponse>(
    `/api/trade-cycles${buildQuery(query)}`,
    { token }
  );
}

export function getTradingAccountTradeCycles(
  token: string,
  tradingAccountId: number,
  query: TradeCyclesQuery = {}
) {
  return apiRequest<TradeCyclesResponse>(
    `/api/trading-accounts/${tradingAccountId}/trade-cycles${buildQuery(query)}`,
    { token }
  );
}

export function getTradeCycle(token: string, id: number) {
  return apiRequest<TradeCycleDetailResponse>(`/api/trade-cycles/${id}`, {
    token,
  });
}
