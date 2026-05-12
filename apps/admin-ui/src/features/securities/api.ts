import { apiRequest } from "../../lib/api";
import type {
  Security,
  CreateSecurityPayload,
  UpdateSecurityPayload,
  SecuritiesQueryParams,
  SecuritiesResponse,
  SecurityDetailResponse,
  SecuritiesSummaryResponse,
} from "./types";

export async function getSecurities(token: string) {
  const result = await apiRequest<{ securities: Security[] }>("/api/securities", {
    token,
  });
  return result.securities;
}

export async function createSecurity(
  payload: CreateSecurityPayload,
  token: string
) {
  const result = await apiRequest<{ security: Security }>("/api/securities", {
    method: "POST",
    token,
    body: payload,
  });
  return result.security;
}

export async function updateSecurity(
  symbol: string,
  payload: UpdateSecurityPayload,
  token: string
) {
  const result = await apiRequest<{ security: Security }>(
    `/api/securities/${encodeURIComponent(symbol)}`,
    {
      method: "PATCH",
      token,
      body: payload,
    }
  );
  return result.security;
}

function appendQueryParam(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined
) {
  if (value === undefined || value === '') {
    return;
  }

  params.set(key, String(value));
}

export async function fetchSecurities(
  query: SecuritiesQueryParams,
  token?: string | null
): Promise<SecuritiesResponse> {
  const params = new URLSearchParams();

  appendQueryParam(params, 'page', query.page);
  appendQueryParam(params, 'pageSize', query.pageSize);
  appendQueryParam(params, 'search', query.search);
  appendQueryParam(params, 'sector', query.sector);
  appendQueryParam(params, 'industry', query.industry);
  appendQueryParam(params, 'enabled', query.enabled);
  appendQueryParam(params, 'subscriptionStatus', query.subscriptionStatus);
  appendQueryParam(params, 'sortBy', query.sortBy);
  appendQueryParam(params, 'sortDirection', query.sortDirection);

  return apiRequest<SecuritiesResponse>(`/api/securities?${params.toString()}`, { token });
}

export async function fetchSecurity(symbol: string, token?: string | null): Promise<SecurityDetailResponse> {
  return apiRequest<SecurityDetailResponse>(
    `/api/securities/${encodeURIComponent(symbol)}`,
    { token }
  );
}

export function fetchSecuritiesSummary(
  token: string
): Promise<SecuritiesSummaryResponse> {
  return apiRequest<SecuritiesSummaryResponse>('/api/securities/summary', {
    token,
  });
}
