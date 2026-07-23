import { apiRequest } from "../../lib/api";
import type {
  Subscription,
  CreateSubscriptionPayload,
  SubscriptionCatalogQuery,
  SubscriptionCatalogResponse,
  UpdateSubscriptionPayload,
} from "./types";

function catalogUrl(query: SubscriptionCatalogQuery) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "" && value !== "all") {
      params.set(key, String(value));
    }
  });
  return `/api/subscriptions?${params.toString()}`;
}

export async function getSubscriptions(token: string) {
  const response = await apiRequest<SubscriptionCatalogResponse>(
    catalogUrl({ page: 1, pageSize: 250 }),
    { token }
  );
  return response.data;
}

export function getSubscriptionCatalog(
  query: SubscriptionCatalogQuery,
  token: string
) {
  return apiRequest<SubscriptionCatalogResponse>(catalogUrl(query), {
    token,
  });
}

export function createSubscription(payload: CreateSubscriptionPayload, token: string) {
  return apiRequest<Subscription>("/api/subscriptions", {
    method: "POST",
    token,
    body: payload,
  });
}

export function updateSubscription(
  id: number,
  payload: UpdateSubscriptionPayload,
  token: string
) {
  return apiRequest<Subscription>(`/api/subscriptions/${id}`, {
    method: "PATCH",
    token,
    body: payload,
  });
}

export function setSubscriptionEnabled(
  id: number,
  enabled: boolean,
  token: string
) {
  return apiRequest<Subscription>(`/api/subscriptions/${id}`, {
    method: "PATCH",
    token,
    body: { enabled },
  });
}
