import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createUserInvitation,
  getUser,
  listUsers,
  listUserTradingAccountMemberships,
  regenerateUserSetupLink,
  replaceUserTradingAccountMemberships,
  updateUser,
} from "./api";
import type {
  CreateUserInvitationInput,
  ReplaceTradingAccountMembershipsInput,
  UpdateUserInput,
} from "./types";

export const userKeys = {
  all: ["users"] as const,
  detail: (id: number | null) => ["users", id] as const,
  memberships: (id: number | null) => ["users", id, "tradingAccountMemberships"] as const,
};

export function useUsers() {
  return useQuery({ queryKey: userKeys.all, queryFn: listUsers, staleTime: 300_000 });
}

export function useUser(id: number | null) {
  return useQuery({
    queryKey: userKeys.detail(id),
    queryFn: () => getUser(id as number),
    enabled: id !== null,
    staleTime: 300_000,
  });
}

export function useUserTradingAccountMemberships(id: number | null) {
  return useQuery({
    queryKey: userKeys.memberships(id),
    queryFn: () => listUserTradingAccountMemberships(id as number),
    enabled: id !== null,
    staleTime: 300_000,
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateUserInput }) =>
      updateUser(id, data),
    onSuccess: (user) => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
      queryClient.setQueryData(userKeys.detail(user.id), user);
    },
  });
}

export function useCreateUserInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUserInvitationInput) => createUserInvitation(data),
    onSuccess: ({ user }) => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
      queryClient.setQueryData(userKeys.detail(user.id), user);
    },
  });
}

export function useRegenerateUserSetupLink() {
  return useMutation({ mutationFn: regenerateUserSetupLink });
}

export function useReplaceUserTradingAccountMemberships() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      data,
    }: {
      userId: number;
      data: ReplaceTradingAccountMembershipsInput;
    }) => replaceUserTradingAccountMemberships(userId, data),
    onSuccess: (memberships, { userId }) => {
      queryClient.setQueryData(userKeys.memberships(userId), memberships);
    },
  });
}
