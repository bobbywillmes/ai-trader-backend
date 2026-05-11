import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createSecurity, updateSecurity, fetchSecurities, fetchSecurity } from "./api";
import { getAdminToken } from "../../lib/api";
import type { CreateSecurityPayload, UpdateSecurityPayload, SecuritiesQueryParams } from "./types";
import { updateSubscription } from "../subscriptions/api";

export const securityKeys = {
  all: ["securities"] as const,
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