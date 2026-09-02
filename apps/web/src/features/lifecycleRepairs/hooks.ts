import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyLifecycleRepair, applyLifecycleRepairAction, decideLifecycleRepairAction, diagnosePositionAttribution, listLifecycleRepairs, previewHistoricalEntryLifecycle } from "./api";

export const lifecycleRepairKeys = { all: ["lifecycleRepairs"] as const, list: (accountId?: number) => ["lifecycleRepairs", accountId ?? "all"] as const };
export function useLifecycleRepairs(token: string | null, accountId?: number) {
  return useQuery({ queryKey: lifecycleRepairKeys.list(accountId), queryFn: () => listLifecycleRepairs(token!, accountId), enabled: Boolean(token) });
}
export function usePreviewHistoricalEntryLifecycle(token: string | null) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (attentionId: number) => previewHistoricalEntryLifecycle(token!, attentionId), onSuccess: () => client.invalidateQueries({ queryKey: lifecycleRepairKeys.all }) });
}
export function useDecideLifecycleRepairAction(token: string | null) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: Parameters<typeof decideLifecycleRepairAction>[1]) => decideLifecycleRepairAction(token!, input), onSuccess: () => client.invalidateQueries({ queryKey: lifecycleRepairKeys.all }) });
}
export function useApplyLifecycleRepairAction(token: string | null) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: Parameters<typeof applyLifecycleRepairAction>[1]) => applyLifecycleRepairAction(token!, input), onSuccess: () => client.invalidateQueries({ queryKey: lifecycleRepairKeys.all }) });
}
export function useDiagnoseLifecycleRepair(token: string | null) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: { tradingAccountId: number; trackedPositionId: number }) => diagnosePositionAttribution(token!, input.tradingAccountId, input.trackedPositionId), onSuccess: () => client.invalidateQueries({ queryKey: lifecycleRepairKeys.all }) });
}
export function useApplyLifecycleRepair(token: string | null) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: { caseId: number; reason: string; confirmation: string; attemptKey: string }) => applyLifecycleRepair(token!, input), onSuccess: () => client.invalidateQueries({ queryKey: lifecycleRepairKeys.all }) });
}
