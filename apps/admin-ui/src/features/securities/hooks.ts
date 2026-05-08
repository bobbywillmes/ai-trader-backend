import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSecurities, createSecurity, updateSecurity } from "./api";
import type { CreateSecurityPayload, UpdateSecurityPayload } from "./types";

export const securityKeys = {
  all: ["securities"] as const,
};

export function useSecurities(token: string | null) {
  return useQuery({
    queryKey: securityKeys.all,
    queryFn: () => getSecurities(token as string),
    enabled: Boolean(token),
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

export function useUpdateSecurity(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      symbol,
      payload,
    }: {
      symbol: string;
      payload: UpdateSecurityPayload;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return updateSecurity(symbol, payload, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: securityKeys.all });
    },
  });
}
