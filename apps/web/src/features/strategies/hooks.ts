import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getStrategies,
  getStrategy,
  getStrategyChangeImpact,
  updateStrategyEnabled,
} from "./api";

export function useStrategies(token: string | null) {
  return useQuery({
    queryKey: ["strategies"],
    queryFn: () => getStrategies(token as string),
    enabled: Boolean(token),
  });
}

export function useStrategy(id: number | null, page: number, token: string | null) {
  return useQuery({
    queryKey: ["strategy", id, page],
    queryFn: () => getStrategy(id as number, page, token as string),
    enabled: Boolean(token && id),
  });
}

export function useStrategyChangeImpact(id: number | null, token: string | null) {
  return useQuery({
    queryKey: ["strategyImpact", id],
    queryFn: () => getStrategyChangeImpact(id as number, token as string),
    enabled: Boolean(token && id),
  });
}

export function useUpdateStrategyEnabled(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => {
      if (!token) throw new Error("Admin session is missing. Please log in again.");
      return updateStrategyEnabled(id, enabled, token);
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["strategies"] });
      queryClient.invalidateQueries({ queryKey: ["strategy", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["strategyImpact", variables.id] });
    },
  });
}
