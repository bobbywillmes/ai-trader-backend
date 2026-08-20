import { apiRequest } from '../../lib/api';
import type {
  AccountSubscriptionMarketContextResponse,
  AccountSubscriptionMarketContextStatus,
  AccountSubscriptionPriceHistoryRange,
  AccountSubscriptionPriceHistoryResponse,
  CreateTradingAccountSubscriptionInput,
  CreateTradingAccountPayload,
  EntryRiskPreviewInput,
  EntryRiskPreviewResponse,
  RevokeTradingAccountCredentialResponse,
  TradingAccountAllocationInput,
  TradingAccountAllocationResponse,
  TradingAccountAllocationsResponse,
  TradingAccountResponse,
  TradingAccountRiskHealthResponse,
  TradingAccountWorkerHealthResponse,
  TradingAccountRiskSettingsInput,
  TradingAccountRiskSettingsResponse,
  TradingAccountSubscriptionInput,
  TradingAccountSubscriptionResponse,
  TradingAccountSubscriptionsResponse,
  TradingAccountsListResponse,
  UpdateTradingAccountPayload,
  UpsertTradingAccountCredentialPayload,
  TradingAccountReadinessAssessmentResponse,
  TradingAccountReadinessHistoryResponse,
  LiveWriteApprovalStateResponse,
  LiveWriteCapability,
  ActivateTradingAccountPayload,
  ActivateTradingAccountResponse,
  CurrentLiveEntryAcceptanceResponse,
  LiveEntryAcceptanceProjection,
} from './types';

type ListMarketContextOptions = {
  status?: AccountSubscriptionMarketContextStatus;
  symbols?: string[];
};

export function getTradingAccounts(token: string) {
  return apiRequest<TradingAccountsListResponse>('/api/trading-accounts', {
    token,
  });
}

export function createTradingAccount(
  payload: CreateTradingAccountPayload,
  token: string,
) {
  return apiRequest<TradingAccountResponse>('/api/trading-accounts', {
    method: 'POST',
    token,
    body: payload,
  });
}

export function getTradingAccount(id: number, token: string) {
  return apiRequest<TradingAccountResponse>(`/api/trading-accounts/${id}`, {
    token,
  });
}

export function activateTradingAccount(
  id: number,
  payload: ActivateTradingAccountPayload,
  token: string,
) {
  return apiRequest<ActivateTradingAccountResponse>(
    `/api/trading-accounts/${id}/activate`,
    {
      method: 'POST',
      token,
      body: payload,
    },
  );
}

export type TradingAccountReadinessPurpose = 'LIVE_ACTIVATION' | 'LIVE_ENTRY_ARMING';

export function getLatestTradingAccountReadiness(id: number, token: string, purpose: TradingAccountReadinessPurpose = 'LIVE_ACTIVATION') {
  return apiRequest<TradingAccountReadinessAssessmentResponse>(
    `/api/trading-accounts/${id}/readiness-assessments/latest?purpose=${purpose}`,
    { token },
  );
}

export function listTradingAccountReadiness(id: number, token: string, purpose: TradingAccountReadinessPurpose = 'LIVE_ACTIVATION') {
  return apiRequest<TradingAccountReadinessHistoryResponse>(
    `/api/trading-accounts/${id}/readiness-assessments?purpose=${purpose}&limit=20`,
    { token },
  );
}

export function runTradingAccountReadiness(id: number, token: string, purpose: TradingAccountReadinessPurpose = 'LIVE_ACTIVATION') {
  return apiRequest<TradingAccountReadinessAssessmentResponse>(
    `/api/trading-accounts/${id}/readiness-assessments`,
    {
      method: 'POST',
      token,
      body: { purpose },
    },
  );
}

export function stageLiveEntryCanary(id: number, payload: unknown, token: string) {
  return apiRequest(`/api/trading-accounts/${id}/stage-live-entry-canary`, { method: 'POST', token, body: payload });
}

export function armLiveEntries(id: number, payload: unknown, token: string) {
  return apiRequest(`/api/trading-accounts/${id}/arm-live-entries`, { method: 'POST', token, body: payload });
}

export function disarmLiveEntries(id: number, payload: unknown, token: string) {
  return apiRequest(`/api/trading-accounts/${id}/disarm-live-entries`, { method: 'POST', token, body: payload });
}

export function getCurrentLiveEntryAcceptance(id: number, token: string) {
  return apiRequest<CurrentLiveEntryAcceptanceResponse>(`/api/trading-accounts/${id}/live-entry-acceptance-runs/current`, { token });
}

export function createLiveEntryAcceptance(id: number, payload: unknown, token: string) {
  return apiRequest<LiveEntryAcceptanceProjection>(`/api/trading-accounts/${id}/live-entry-acceptance-runs`, { method: 'POST', token, body: payload });
}

export function previewLiveEntryAcceptance(id: number, runId: number, token: string) {
  return apiRequest<LiveEntryAcceptanceProjection>(`/api/trading-accounts/${id}/live-entry-acceptance-runs/${runId}/preview`, { method: 'POST', token });
}

export function executeLiveEntryAcceptance(id: number, runId: number, payload: unknown, token: string) {
  return apiRequest<LiveEntryAcceptanceProjection>(`/api/trading-accounts/${id}/live-entry-acceptance-runs/${runId}/execute`, { method: 'POST', token, body: payload });
}

export function verifyLiveEntryAcceptance(id: number, runId: number, token: string) {
  return apiRequest<LiveEntryAcceptanceProjection>(`/api/trading-accounts/${id}/live-entry-acceptance-runs/${runId}/verify`, { method: 'POST', token });
}

export function abortLiveEntryAcceptance(id: number, runId: number, payload: unknown, token: string) {
  return apiRequest<LiveEntryAcceptanceProjection>(`/api/trading-accounts/${id}/live-entry-acceptance-runs/${runId}/abort`, { method: 'POST', token, body: payload });
}

export function getLiveWriteApprovals(id: number, token: string) {
  return apiRequest<LiveWriteApprovalStateResponse>(
    `/api/trading-accounts/${id}/live-write-approvals`,
    { token },
  );
}

export function grantLiveWriteApproval(
  id: number,
  capability: LiveWriteCapability,
  payload: unknown,
  token: string,
) {
  return apiRequest(
    `/api/trading-accounts/${id}/live-write-approvals/${capability}/grant`,
    {
      method: 'POST',
      token,
      body: payload,
    },
  );
}

export function revokeLiveWriteApproval(
  id: number,
  capability: LiveWriteCapability,
  payload: unknown,
  token: string,
) {
  return apiRequest(
    `/api/trading-accounts/${id}/live-write-approvals/${capability}/revoke`,
    {
      method: 'POST',
      token,
      body: payload,
    },
  );
}

export function updateTradingAccount(
  id: number,
  payload: UpdateTradingAccountPayload,
  token: string,
) {
  return apiRequest<TradingAccountResponse>(`/api/trading-accounts/${id}`, {
    method: 'PATCH',
    token,
    body: payload,
  });
}

export function getTradingAccountRiskSettings(id: number, token: string) {
  return apiRequest<TradingAccountRiskSettingsResponse>(
    `/api/trading-accounts/${id}/risk-settings`,
    {
      token,
    },
  );
}

export function getTradingAccountRiskHealth(id: number, token: string) {
  return apiRequest<TradingAccountRiskHealthResponse>(
    `/api/trading-accounts/${id}/risk-health`,
    {
      token,
    },
  );
}

export function getTradingAccountWorkerHealth(id: number, token: string) {
  return apiRequest<TradingAccountWorkerHealthResponse>(
    `/api/trading-accounts/${id}/worker-health`,
    { token },
  );
}

export function updateTradingAccountRiskSettings(
  id: number,
  payload: TradingAccountRiskSettingsInput,
  token: string,
) {
  return apiRequest<TradingAccountRiskSettingsResponse>(
    `/api/trading-accounts/${id}/risk-settings`,
    {
      method: 'PATCH',
      token,
      body: payload,
    },
  );
}

export function upsertTradingAccountCredential(
  id: number,
  payload: UpsertTradingAccountCredentialPayload,
  token: string,
) {
  return apiRequest<TradingAccountResponse>(
    `/api/trading-accounts/${id}/credentials`,
    {
      method: 'PUT',
      token,
      body: {
        authType: payload.authType ?? 'API_KEY',
        apiKey: payload.apiKey,
        apiSecret: payload.apiSecret,
      },
    },
  );
}

export function verifyTradingAccountCredential(id: number, token: string) {
  return apiRequest<TradingAccountResponse>(
    `/api/trading-accounts/${id}/credentials/verify`,
    {
      method: 'POST',
      token,
    },
  );
}

export function revokeTradingAccountCredential(id: number, token: string) {
  return apiRequest<RevokeTradingAccountCredentialResponse>(
    `/api/trading-accounts/${id}/credentials/revoke`,
    {
      method: 'POST',
      token,
    },
  );
}

export function listTradingAccountAllocations(id: number, token: string) {
  return apiRequest<TradingAccountAllocationsResponse>(
    `/api/trading-accounts/${id}/allocations`,
    {
      token,
    },
  );
}

export function createTradingAccountAllocation(
  id: number,
  payload: TradingAccountAllocationInput,
  token: string,
) {
  return apiRequest<TradingAccountAllocationResponse>(
    `/api/trading-accounts/${id}/allocations`,
    {
      method: 'POST',
      token,
      body: payload,
    },
  );
}

export function updateTradingAccountAllocation(
  id: number,
  allocationId: number,
  payload: TradingAccountAllocationInput,
  token: string,
) {
  return apiRequest<TradingAccountAllocationResponse>(
    `/api/trading-accounts/${id}/allocations/${allocationId}`,
    {
      method: 'PATCH',
      token,
      body: payload,
    },
  );
}

export function listTradingAccountSubscriptions(id: number, token: string) {
  return apiRequest<TradingAccountSubscriptionsResponse>(
    `/api/trading-accounts/${id}/account-subscriptions`,
    {
      token,
    },
  );
}

export function listTradingAccountSubscriptionMarketContext(
  id: number,
  token: string,
  options: ListMarketContextOptions = {},
) {
  const query = new URLSearchParams();

  if (options.status) {
    query.set('status', options.status);
  }

  if (options.symbols?.length) {
    query.set('symbols', options.symbols.join(','));
  }

  const suffix = query.toString() ? `?${query.toString()}` : '';

  return apiRequest<AccountSubscriptionMarketContextResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/market-context${suffix}`,
    {
      token,
    },
  );
}

export function getTradingAccountSubscription(
  id: number,
  accountSubscriptionId: number,
  token: string,
) {
  return apiRequest<TradingAccountSubscriptionResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/${accountSubscriptionId}`,
    {
      token,
    },
  );
}

export function getTradingAccountSubscriptionPriceHistory(
  id: number,
  accountSubscriptionId: number,
  token: string,
  range: AccountSubscriptionPriceHistoryRange = '1y',
) {
  const query = new URLSearchParams({ range });

  return apiRequest<AccountSubscriptionPriceHistoryResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/${accountSubscriptionId}/price-history?${query.toString()}`,
    {
      token,
    },
  );
}

export function createTradingAccountSubscription(
  id: number,
  payload: CreateTradingAccountSubscriptionInput,
  token: string,
) {
  return apiRequest<TradingAccountSubscriptionResponse>(
    `/api/trading-accounts/${id}/account-subscriptions`,
    {
      method: 'POST',
      token,
      body: payload,
    },
  );
}

export function updateTradingAccountSubscription(
  id: number,
  accountSubscriptionId: number,
  payload: TradingAccountSubscriptionInput,
  token: string,
) {
  return apiRequest<TradingAccountSubscriptionResponse>(
    `/api/trading-accounts/${id}/account-subscriptions/${accountSubscriptionId}`,
    {
      method: 'PATCH',
      token,
      body: payload,
    },
  );
}

export function deleteTradingAccountSubscription(
  id: number,
  accountSubscriptionId: number,
  token: string,
) {
  return apiRequest<void>(
    `/api/trading-accounts/${id}/account-subscriptions/${accountSubscriptionId}`,
    { method: 'DELETE', token },
  );
}

export function previewTradingAccountEntryRisk(
  id: number,
  payload: EntryRiskPreviewInput,
  token: string,
) {
  return apiRequest<EntryRiskPreviewResponse>(
    `/api/trading-accounts/${id}/entry-risk-preview`,
    {
      method: 'POST',
      token,
      body: payload,
    },
  );
}
