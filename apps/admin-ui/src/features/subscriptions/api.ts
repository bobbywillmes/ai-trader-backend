import { apiRequest } from "../../lib/api";
import type { Subscription, UpdateSubscriptionPayload } from "./types";

export function getSubscriptions(token: string) {
  return apiRequest<Subscription[]>("/api/subscriptions", {
    token,
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