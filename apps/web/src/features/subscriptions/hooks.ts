import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSubscription,
  getSubscriptions,
  setSubscriptionEnabled,
  updateSubscription,
} from "./api";
import type { CreateSubscriptionPayload, UpdateSubscriptionPayload } from "./types";

export const subscriptionKeys = {
  all: ["subscriptions"] as const,
};

export function useSubscriptions(token: string | null) {
  return useQuery({
    queryKey: subscriptionKeys.all,
    queryFn: () => getSubscriptions(token as string),
    enabled: Boolean(token),
  });
}

export function useUpdateSubscription(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: UpdateSubscriptionPayload;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return updateSubscription(id, payload, token);
    },

    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: subscriptionKeys.all,
      });
    },
  });
}

export function useSetSubscriptionEnabled(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return setSubscriptionEnabled(id, enabled, token);
    },

    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: subscriptionKeys.all,
      });
    },
  });
}

export function useCreateSubscription(token: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSubscriptionPayload) => {
      if (!token) throw new Error("Admin session is missing. Please log in again.");
      return createSubscription(payload, token);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}
