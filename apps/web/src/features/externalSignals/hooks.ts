import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import { useStrategies } from "../strategies/hooks";
import type { CreateBinding, CreateSource, Section, UpdateBinding, UpdateSource } from "./types";

export const externalSignalKeys = {
  section: (section: Section) => ["externalSignals", section] as const,
  catalog: ["externalSignals", "sources", "catalog"] as const,
};
export function useExternalList<K extends Section>(section: K, query: string, token: string | null) {
  return useQuery({ queryKey: [...externalSignalKeys.section(section), "list", query],
    queryFn: () => api.listExternalSignals(section, query, token), enabled: Boolean(token) });
}
export function useExternalDetail<K extends Section>(section: K, id: number | null, token: string | null) {
  return useQuery({ queryKey: [...externalSignalKeys.section(section), "detail", id],
    queryFn: () => api.getExternalSignal(section, id!, token), enabled: Boolean(token && id) });
}
export function useSourceCatalog(token: string | null) {
  return useQuery({ queryKey: externalSignalKeys.catalog, queryFn: () => api.getSourceCatalog(token), enabled: Boolean(token) });
}
export function useCatalogs(token: string | null) {
  const sources = useSourceCatalog(token);
  const strategies = useStrategies(token);
  return { sources, strategies,
    sourceName: (id: number) => sources.data?.find(source => source.id === id)?.name ?? `Source #${id}`,
    strategyName: (id: number) => strategies.data?.find(strategy => strategy.id === id)?.name ?? `Strategy #${id}`,
  };
}
export function useSourceMutations(token: string | null) {
  const client = useQueryClient();
  const invalidate = () => { void client.invalidateQueries({ queryKey: externalSignalKeys.section("sources") }); };
  return {
    create: useMutation({ mutationFn: (input: CreateSource) => api.createSource(input, token), onSuccess: invalidate }),
    regenerate: useMutation({ mutationFn: (id: number) => api.regenerateSource(id, token), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: number; input: UpdateSource }) => api.updateSource(id, input, token), onSuccess: invalidate }),
  };
}
export function useBindingMutations(token: string | null) {
  const client = useQueryClient();
  const invalidate = () => { void client.invalidateQueries({ queryKey: externalSignalKeys.section("bindings") }); };
  return {
    create: useMutation({ mutationFn: (input: CreateBinding) => api.createBinding(input, token), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: number; input: UpdateBinding }) => api.updateBinding(id, input, token), onSuccess: invalidate }),
  };
}

export function useRevisions(id: number, token: string | null) {
  return useQuery({ queryKey: [...externalSignalKeys.section("bindings"), id, "revisions"],
    queryFn: () => api.listRevisions(id, token), enabled: Boolean(token) });
}
export function useRevisionMutation(id: number, token: string | null) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: { action: "prepare" | "activate" | "retire"; revisionId: number | null; changeNote: string }) =>
    api.changeRevision(id, input.action, input.revisionId, input.changeNote, token),
    onSuccess: () => client.invalidateQueries({ queryKey: externalSignalKeys.section("bindings") }),
  });
}
