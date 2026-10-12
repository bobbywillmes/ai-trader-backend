import { useQuery } from "@tanstack/react-query";
import { getOrderOperationalEvidence } from "./api";

export const orderOperationalEvidenceKeys = {
  detail: (orderIntentId: number | null, opportunityPage: number, eventPage: number, authorizationContext: string) =>
    ["orderOperationalEvidence", authorizationContext, orderIntentId, opportunityPage, eventPage] as const,
};

export function useOrderOperationalEvidence(orderIntentId: number | null, opportunityPage: number, eventPage: number, token: string | null, authorizationContext: string, enabled = true) {
  return useQuery({
    queryKey: orderOperationalEvidenceKeys.detail(orderIntentId, opportunityPage, eventPage, authorizationContext),
    queryFn: () => getOrderOperationalEvidence(orderIntentId as number, opportunityPage, eventPage, token as string),
    enabled: enabled && Boolean(token && orderIntentId),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}
