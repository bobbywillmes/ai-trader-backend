import { apiRequest } from "../../lib/api";
import type {
  EntryDecisionDetailResponse,
  EntryDecisionListResponse,
  EntryDecisionQuery,
} from "./types";

function buildQuery(params: EntryDecisionQuery) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }

  const query = search.toString();

  return query ? `?${query}` : "";
}

export function getEntryDecisions(
  token: string,
  query: EntryDecisionQuery = {}
) {
  return apiRequest<EntryDecisionListResponse>(
    `/api/entry-decisions${buildQuery(query)}`,
    { token }
  );
}

export function getEntryDecision(token: string, id: number) {
  return apiRequest<EntryDecisionDetailResponse>(`/api/entry-decisions/${id}`, {
    token,
  });
}
