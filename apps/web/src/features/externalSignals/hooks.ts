import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { CreateBinding, CreateSource, Credential, Section, UpdateBinding, UpdateSource } from "./types";

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
export function useSourceMutations(token: string | null, onCredential: (value: Credential) => void) {
  const client = useQueryClient();
  const invalidate = () => { void client.invalidateQueries({ queryKey: externalSignalKeys.section("sources") }); };
  // Plaintext never becomes mutation data or variables. The only owner is the
  // transient credential dialog. gcTime/reset also remove completed operations.
  const create = useMutation({ gcTime: 0, mutationFn: async (input: CreateSource) => {
    const result = await api.createSource(input, token);
    onCredential({ ...result, rotated: false });
    return result.source;
  }, onSuccess: invalidate });
  const rotate = useMutation({ gcTime: 0, mutationFn: async (id: number) => {
    const result = await api.rotateSource(id, token);
    onCredential({ ...result, rotated: true });
    return result.source;
  }, onSuccess: invalidate });
  const update = useMutation({ mutationFn: ({ id, input }: { id: number; input: UpdateSource }) => api.updateSource(id, input, token), onSuccess: invalidate });
  return { create, rotate, update };
}
export function useBindingMutations(token: string | null) {
  const client = useQueryClient();
  const invalidate = () => { void client.invalidateQueries({ queryKey: externalSignalKeys.section("bindings") }); };
  return {
    create: useMutation({ mutationFn: (input: CreateBinding) => api.createBinding(input, token), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: number; input: UpdateBinding }) => api.updateBinding(id, input, token), onSuccess: invalidate }),
  };
}
