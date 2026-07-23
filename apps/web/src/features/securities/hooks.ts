import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createSecurity, updateSecurity, fetchSecurities, fetchSecurity, fetchSecuritiesSummary } from "./api";
import { getAdminToken } from "../../lib/api";
import type { CreateSecurityPayload, UpdateSecurityPayload, SecuritiesQueryParams } from "./types";
import { createSubscription, updateSubscription } from "../subscriptions/api";
import type { CreateSubscriptionPayload } from "../subscriptions/types";

export const securityKeys = {
  all: ["securities"] as const,
};

export const securitiesSummaryKeys = {
  all: ['securitiesSummary'] as const,
};

export function useSecurities(query: SecuritiesQueryParams, token?: string | null) {
  return useQuery({
    queryKey: ['securities', query],
    queryFn: () => fetchSecurities(query, token),
    placeholderData: (previousData) => previousData,
  });
}

export function useCreateSecurity(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateSecurityPayload) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return createSecurity(payload, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: securityKeys.all });
    },
  });
}

export function useSecurity(symbol: string | undefined) {
  return useQuery({
    queryKey: ['security', symbol],
    queryFn: () => fetchSecurity(symbol as string, getAdminToken()),
    enabled: Boolean(symbol),
  });
}

export function useUpdateSecurity(symbol: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateSecurityPayload) => {
      if (!symbol) {
        throw new Error('Symbol is required.');
      }
      const token = getAdminToken();
      if (!token) {
        throw new Error('Admin session is missing. Please log in again.');
      }
      return updateSecurity(symbol, payload, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security', symbol] });
      queryClient.invalidateQueries({ queryKey: securityKeys.all });
      queryClient.invalidateQueries({ queryKey: ['securityActivity', symbol] });
    },
  });
}

export function useUpdateSecuritySubscription(symbol: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { subscriptionId: number; enabled: boolean }) => {
      const token = getAdminToken();
      if (!token) {
        throw new Error('Admin session is missing. Please log in again.');
      }
      return updateSubscription(input.subscriptionId, {
        enabled: input.enabled,
      }, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security', symbol] });
      queryClient.invalidateQueries({ queryKey: ['securities'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    },
  });
}

export function useCreateSecuritySubscription(symbol: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateSubscriptionPayload) => {
      const token = getAdminToken();
      if (!token) {
        throw new Error('Admin session is missing. Please log in again.');
      }
      return createSubscription(payload, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security', symbol] });
      queryClient.invalidateQueries({ queryKey: ['securities'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    },
  });
}

export function useEditSecuritySubscription(symbol: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      subscriptionId: number;
      exitProfileId: number;
    }) => {
      const token = getAdminToken();
      if (!token) {
        throw new Error('Admin session is missing. Please log in again.');
      }
      return updateSubscription(input.subscriptionId, {
        exitProfileId: input.exitProfileId,
      }, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security', symbol] });
      queryClient.invalidateQueries({ queryKey: ['securities'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['securityActivity', symbol] });
    },
  });
}

export function useSecuritiesSummary(token: string | null) {
  return useQuery({
    queryKey: securitiesSummaryKeys.all,
    queryFn: () => fetchSecuritiesSummary(token as string),
    enabled: Boolean(token),
  });
}
