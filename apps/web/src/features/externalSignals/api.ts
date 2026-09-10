import { apiRequest, getApiUrl } from "../../lib/api";
import type { CreateBinding, CreateSource, ListResult, Resources, Section, Source, UpdateBinding, UpdateSource, Revision } from "./types";
const root = "/api/external-signal-admin";
export function listExternalSignals<K extends Section>(section: K, query: string, token: string | null) {
  return apiRequest<ListResult<K>>(`${root}/${section}?${query}`, { token });
}
export function getExternalSignal<K extends Section>(section: K, id: number, token: string | null) {
  return apiRequest<Resources[K]>(`${root}/${section}/${id}`, { token });
}
export async function getSourceCatalog(token: string | null) {
  const sources: Source[] = [];
  let page = 1;
  // The existing API is paginated. Never silently truncate selectors at 100.
  while (true) {
    const result = await listExternalSignals("sources", `page=${page}&pageSize=100`, token);
    sources.push(...result.sources);
    if (page >= result.pagination.totalPages) return [...new Map(sources.map(source => [source.id, source])).values()];
    page++;
  }
}
export function createSource(input: CreateSource, token: string | null) {
  return apiRequest<Source>(`${root}/sources`, { method: "POST", token, body: input });
}
export function regenerateSource(id: number, token: string | null) {
  return apiRequest<Source>(`${root}/sources/${id}/regenerate-webhook`, { method: "POST", token });
}
export function updateSource(id: number, input: UpdateSource, token: string | null) {
  return apiRequest<Source>(`${root}/sources/${id}`, { method: "PATCH", token, body: input });
}
export function createBinding(input: CreateBinding, token: string | null) {
  return apiRequest<Resources["bindings"]>(`${root}/bindings`, { method: "POST", token, body: input });
}
export function updateBinding(id: number, input: UpdateBinding, token: string | null) {
  return apiRequest<Resources["bindings"]>(`${root}/bindings/${id}`, { method: "PATCH", token, body: input });
}
export function webhookUrl(webhookKey: string) { return getApiUrl(`/api/external-signals/${encodeURIComponent(webhookKey)}`); }
export function listRevisions(id: number, token: string | null) {
  return apiRequest<Revision[]>(`${root}/bindings/${id}/revisions`, { token });
}
export function changeRevision(id: number, action: "prepare" | "activate" | "retire", revisionId: number | null, changeNote: string, token: string | null) {
  return apiRequest<Revision>(`${root}/bindings/${id}/revisions${action === "prepare" ? "" : `/${revisionId}/${action}`}`, {
    method: "POST", token, body: action === "prepare" && changeNote.trim() ? { changeNote: changeNote.trim() } : {},
  });
}

export function getSourceWebhook(id: number, token: string | null) { return apiRequest<{ webhookKey: string }>(`${root}/sources/${id}/webhook`, { token }); }
