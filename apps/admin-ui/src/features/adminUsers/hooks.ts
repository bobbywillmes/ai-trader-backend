import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listAdminUsers,
  getAdminUser,
  getAdminUserTradingAccountAccess,
  createAdminUserInvitation,
  regenerateAdminUserSetupLink,
  updateAdminUser,
  upsertTradingAccountAccess,
} from "./api";

export function useAdminUsers() {
  return useQuery({
    queryKey: ["adminUsers"],
    queryFn: listAdminUsers,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useAdminUser(id: number | null) {
  return useQuery({
    queryKey: ["adminUsers", id],
    queryFn: () => getAdminUser(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useAdminUserTradingAccountAccess(id: number | null) {
  return useQuery({
    queryKey: ["adminUsers", id, "tradingAccountAccess"],
    queryFn: () => getAdminUserTradingAccountAccess(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUpdateAdminUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: {
        name?: string | null;
        role?: string;
        enabled?: boolean;
      };
    }) => updateAdminUser(id, data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
      queryClient.invalidateQueries({ queryKey: ["adminUsers", data.id] });
    },
  });
}

export function useCreateAdminUserInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createAdminUserInvitation,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["adminUsers"] });
      queryClient.setQueryData(["adminUsers", data.adminUser.id], data.adminUser);
    },
  });
}

export function useRegenerateAdminUserSetupLink() {
  return useMutation({
    mutationFn: regenerateAdminUserSetupLink,
  });
}

export function useUpsertTradingAccountAccess() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      userId,
      accountId,
      data,
    }: {
      userId: number;
      accountId: number;
      data: { role: string } | null;
    }) => upsertTradingAccountAccess(userId, accountId, data),
    onSuccess: (_, { userId }) => {
      queryClient.invalidateQueries({
        queryKey: ["adminUsers", userId, "tradingAccountAccess"],
      });
    },
  });
}
