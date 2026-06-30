import { apiRequest } from "../../lib/api";
import type {
  RevokeTradingAccountCredentialResponse,
  TradingAccountAllocationInput,
  TradingAccountAllocationResponse,
  TradingAccountAllocationsResponse,
  TradingAccountResponse,
  TradingAccountsListResponse,
  UpdateTradingAccountPayload,
  UpsertTradingAccountCredentialPayload,
} from "./types";

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
