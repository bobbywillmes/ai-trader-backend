import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getStrategies,
  getStrategy,
  getStrategyChangeImpact,
  updateStrategyEnabled,
  activateStrategyMarketPolicyRevision, createStrategyMarketPolicy, getStrategyMarketPolicy,
  prepareStrategyMarketPolicyRevision, saveStrategyMarketPolicyRevision, validateStrategyMarketPolicyRevision,
} from "./api";
import type { MarketPolicyRuleDraft } from "./types";

export function useStrategies(token: string | null) {
  return useQuery({
    queryKey: ["strategies"],
    queryFn: () => getStrategies(token as string),
    enabled: Boolean(token),
  });
}

export function useStrategyMarketPolicy(id: number | null, token: string | null) { return useQuery({ queryKey: ["strategyMarketPolicy", id], queryFn: () => getStrategyMarketPolicy(id as number, token as string), enabled: Boolean(id && token) }); }

export function useMarketPolicyActions(token: string | null) {
  const queryClient = useQueryClient();
  const refresh = (id: number) => queryClient.invalidateQueries({ queryKey: ["strategyMarketPolicy", id] });
  const requireToken = () => { if (!token) throw new Error("Admin session is missing. Please log in again."); return token; };
  return {
    create: useMutation({ mutationFn: (id: number) => createStrategyMarketPolicy(id, requireToken()), onSuccess: (_r, id) => refresh(id) }),
    prepare: useMutation({ mutationFn: (id: number) => prepareStrategyMarketPolicyRevision(id, requireToken()), onSuccess: (_r, id) => refresh(id) }),
    saveRevision: useMutation({ mutationFn: (v: { id: number; revisionId: number; expectedConfigurationFingerprint: string; rules: MarketPolicyRuleDraft[] }) => saveStrategyMarketPolicyRevision(v.id, v.revisionId, v.expectedConfigurationFingerprint, v.rules, requireToken()), onSuccess: (_r, v) => refresh(v.id) }),
    validate: useMutation({ mutationFn: (v: { id: number; revisionId: number }) => validateStrategyMarketPolicyRevision(v.id, v.revisionId, requireToken()) }),
    activate: useMutation({ mutationFn: (v: { id: number; revisionId: number; expectedConfigurationFingerprint: string }) => activateStrategyMarketPolicyRevision(v.id, v.revisionId, v.expectedConfigurationFingerprint, requireToken()), onSuccess: (_r, v) => refresh(v.id) }),
  };
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
