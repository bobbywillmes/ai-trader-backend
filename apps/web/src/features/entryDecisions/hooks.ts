import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getEntryDecision, getEntryDecisions } from "./api";
import type { EntryDecisionQuery } from "./types";

export const entryDecisionKeys = {
  list: (query: EntryDecisionQuery) => ["entryDecisions", query] as const,
  detail: (id: number | null) => ["entryDecisions", "detail", id] as const,
};

export function useEntryDecisions(
  token: string | null,
  query: EntryDecisionQuery
) {
  return useQuery({
    queryKey: entryDecisionKeys.list(query),
    queryFn: () => getEntryDecisions(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useEntryDecision(token: string | null, id: number | null) {
  return useQuery({
    queryKey: entryDecisionKeys.detail(id),
    queryFn: () => getEntryDecision(token as string, id as number),
    enabled: Boolean(token) && id !== null,
    staleTime: 15000,
  });
}

export function useEntryDecisionDrawer(token: string | null) {
  const [selectedDecisionId, setSelectedDecisionId] = useState<number | null>(
    null
  );
  const detailQuery = useEntryDecision(token, selectedDecisionId);

  return {
    selectedDecisionId,
    openDecision: setSelectedDecisionId,
    closeDecision: () => setSelectedDecisionId(null),
    drawerProps: {
      opened: selectedDecisionId !== null,
      decision: detailQuery.data?.decision ?? null,
      isLoading: detailQuery.isLoading,
      isError: detailQuery.isError,
      error: detailQuery.error,
    },
    detailQuery,
  };
}
