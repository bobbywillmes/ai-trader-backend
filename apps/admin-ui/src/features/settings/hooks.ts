import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getConfig, updateConfig } from "./api";
import { dashboardKeys } from "../dashboard/hooks";
import type { RuntimeTradingConfig } from "../dashboard/types";

export const settingsKeys = {
  config: ["settings", "config"] as const,
};

export function useConfig(token: string | null) {
  return useQuery({
    queryKey: settingsKeys.config,
    queryFn: () => getConfig(token as string),
    enabled: Boolean(token),
    staleTime: 30000,
  });
}

export function useUpdateConfig(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: Partial<RuntimeTradingConfig>) => {
      if (!token) throw new Error("Admin session is missing. Please log in again.");
      return updateConfig(token, payload);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsKeys.config, updated);
      // Keep bootstrap config in sync so the dashboard status badges update
      queryClient.invalidateQueries({ queryKey: dashboardKeys.bootstrap });
    },
  });
}
