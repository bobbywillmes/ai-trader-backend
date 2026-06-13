import { apiRequest } from "../../lib/api";
import type {
  BootstrapResponse,
  IndexIntradayResponse,
  IndexPerformanceResponse,
  SystemEvent,
} from "./types";

export function getBootstrap(token: string) {
  return apiRequest<BootstrapResponse>("/api/bootstrap", { token });
}

export function getSystemEvents(token: string, limit = 20) {
  return apiRequest<SystemEvent[]>(`/api/system-events?limit=${limit}`, { token });
}

export function getIndexPerformance(token: string) {
  return apiRequest<IndexPerformanceResponse>(
    "/api/dashboard/index-performance",
    { token }
  );
}

export function getIndexIntraday(token: string) {
  return apiRequest<IndexIntradayResponse>(
    "/api/dashboard/index-intraday",
    { token }
  );
}
