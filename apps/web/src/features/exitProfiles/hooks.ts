import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getExitProfiles,
  createExitProfile,
  updateExitProfile,
  setExitProfileEnabled,
} from "./api";
import type { CreateExitProfilePayload, UpdateExitProfilePayload } from "./types";

export const exitProfileKeys = {
  all: ["exitProfiles"] as const,
};

export function useExitProfiles(token: string | null) {
  return useQuery({
    queryKey: exitProfileKeys.all,
    queryFn: () => getExitProfiles(token as string),
    enabled: Boolean(token),
  });
}

export function useCreateExitProfile(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateExitProfilePayload) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return createExitProfile(payload, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: exitProfileKeys.all });
    },
  });
}

export function useUpdateExitProfile(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: UpdateExitProfilePayload;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return updateExitProfile(id, payload, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: exitProfileKeys.all });
    },
  });
}

export function useSetExitProfileEnabled(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return setExitProfileEnabled(id, enabled, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: exitProfileKeys.all });
    },
  });
}
