import { apiRequest } from "../../lib/api";
import type {
  AccountSubscriptionMarketContextResponse,
  AccountSubscriptionMarketContextStatus,
  AccountSubscriptionPriceHistoryRange,
  AccountSubscriptionPriceHistoryResponse,
  CreateTradingAccountSubscriptionInput,
  RevokeTradingAccountCredentialResponse,
  TradingAccountAllocationInput,
  TradingAccountAllocationResponse,
  TradingAccountAllocationsResponse,
  TradingAccountResponse,
  TradingAccountRiskSettingsInput,
  TradingAccountRiskSettingsResponse,
  TradingAccountSubscriptionInput,
  TradingAccountSubscriptionResponse,
  TradingAccountSubscriptionsResponse,
  TradingAccountsListResponse,
  UpdateTradingAccountPayload,
  UpsertTradingAccountCredentialPayload,
} from "./types";

type ListMarketContextOptions = {
  status?: AccountSubscriptionMarketContextStatus;
  symbols?: string[];
};

export function getTradingAccounts(token: string) {
  return apiRequest<TradingAccountsListResponse>("/api/trading-accounts", {
    token,
  });
}

export function getTradingAccount(id: number, token: string) {
  return apiRequest<TradingAccountResponse>(`/api/trading-accounts/${id}`, {
    token,
  });
}

export function updateTradingAccount(
  id: number,
  payload: UpdateTradingAccountPayload,
  token: string
) {
  return apiRequest<TradingAccountResponse>(`/api/trading-accounts/${id}`, {
    method: "PATCH",
    token,
    body: payload,
  });
}

export function getTradingAccountRiskSettings(id: number, token: string) {
  return apiRequest<TradingAccountRiskSettingsResponse>(
    `/api/trading-accounts/${id}/risk-settings`,
    {
      token,
    }
  );
}

export function updateTradingAccountRiskSettings(
  id: number,
  payload: TradingAccountRiskSettingsInput,
  token: string
) {
  return apiRequest<TradingAccountRiskSettingsResponse>(
    `/api/trading-accounts/${id}/risk-settings`,
    {
      method: "PATCH",
      token,
      body: payload,
    }
  );
}

export function upsertTradingAccountCredential(
  id: number,
  payload: UpsertTradingAccountCredentialPayload,
  token: string
) {
  return apiRequest<TradingAccountResponse>(
    `/api/trading-accounts/${id}/credentials`,
    {
      method: "PUT",
      token,
      body: {
        authType: payload.authType ?? "API_KEY",
        apiKey: payload.apiKey,
        apiSecret: payload.apiSecret,
      },
    }
  );
}

export function verifyTradingAccountCredential(id: number, token: string) {
  return apiRequest<TradingAccountResponse>(
    `/api/trading-accounts/${id}/credentials/verify`,
    {
      method: "POST",
      token,
    }
  );
}

export function revokeTradingAccountCredential(id: number, token: string) {
  return apiRequest<RevokeTradingAccountCredentialResponse>(
    `/api/trading-accounts/${id}/credentials/revoke`,
    {
      method: "POST",
      token,
    }
  );
}

export function listTradingAccountAllocations(id: number, token: string) {
  return apiRequest<TradingAccountAllocationsResponse>(
    `/api/trading-accounts/${id}/allocations`,
    {
      token,
    }
  );
}

export function createTradingAccountAllocation(
  id: number,
  payload: TradingAccountAllocationInput,
  token: string
) {
  return apiRequest<TradingAccountAllocationResponse>(
    `/api/trading-accounts/${id}/allocations`,
    {
      method: "POST",
      token,
      body: payload,
    }
  );
}

export function updateTradingAccountAllocation(
  id: number,
  allocationId: number,
  payload: TradingAccountAllocationInput,
  token: string
) {
  return apiRequest<TradingAccountAllocationResponse>(
    `/api/trading-accounts/${id}/allocations/${allocationId}`,
    {
      method: "PATCH",
      token,
      body: payload,
    }
  );
}

export function listTradingAccountSubscriptions(id: number, token: string) {
  return apiRequest<TradingAccountSubscriptionsResponse>(
    `/api/trading-accounts/${id}/account-subscriptions`,
    {
      token,
    }
  );
}

export function listTradingAccountSubscriptionMarketContext(
  id: number,
  token: string,
  options: ListMarketContextOptions = {}
) {
  const query = new URLSearchParams();

  if (options.status) {
    query.set("status", options.status);
  }

  if (options.symbols?.length) {
    query.set("symbols", options.symbols.join(","));
  }

  const suffix = query.toString() ? `?${query.toString()}` : "";

  return apiRequest<AccountSubscriptionMarketContextResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/market-context${suffix}`,
    {
      token,
    }
  );
}

export function getTradingAccountSubscription(
  id: number,
  accountSubscriptionId: number,
  token: string
) {
  return apiRequest<TradingAccountSubscriptionResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/${accountSubscriptionId}`,
    {
      token,
    }
  );
}

export function getTradingAccountSubscriptionPriceHistory(
  id: number,
  accountSubscriptionId: number,
  token: string,
  range: AccountSubscriptionPriceHistoryRange = "1y"
) {
  const query = new URLSearchParams({ range });

  return apiRequest<AccountSubscriptionPriceHistoryResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/${accountSubscriptionId}/price-history?${query.toString()}`,
    {
      token,
    }
  );
}

export function createTradingAccountSubscription(
  id: number,
  payload: CreateTradingAccountSubscriptionInput,
  token: string
) {
  return apiRequest<TradingAccountSubscriptionResponse>(
    `/api/trading-accounts/${id}/account-subscriptions`,
    {
      method: "POST",
      token,
      body: payload,
    }
  );
}

export function updateTradingAccountSubscription(
  id: number,
  accountSubscriptionId: number,
  payload: TradingAccountSubscriptionInput,
  token: string
) {
  return apiRequest<TradingAccountSubscriptionResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/${accountSubscriptionId}`,
    {
      method: "PATCH",
      token,
      body: payload,
    }
  );
}
