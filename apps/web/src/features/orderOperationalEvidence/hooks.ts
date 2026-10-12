import { useQuery } from "@tanstack/react-query";
import { getOrderOperationalEvidence } from "./api";

export const orderOperationalEvidenceKeys = {
  detail: (orderIntentId: number | null, opportunityPage: number, authorizationContext: string) =>
    ["orderOperationalEvidence", authorizationContext, orderIntentId, opportunityPage] as const,
};

export function useOrderOperationalEvidence(orderIntentId: number | null, opportunityPage: number, token: string | null, authorizationContext: string, enabled = true) {
  return useQuery({
    queryKey: orderOperationalEvidenceKeys.detail(orderIntentId, opportunityPage, authorizationContext),
    queryFn: () => getOrderOperationalEvidence(orderIntentId as number, opportunityPage, token as string),
    enabled: enabled && Boolean(token && orderIntentId),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}
