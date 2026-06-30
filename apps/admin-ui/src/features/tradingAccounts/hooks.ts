import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTradingAccountAllocation,
  getTradingAccount,
  getTradingAccounts,
  listTradingAccountAllocations,
  revokeTradingAccountCredential,
  updateTradingAccount,
  updateTradingAccountAllocation,
  upsertTradingAccountCredential,
  verifyTradingAccountCredential,
} from "./api";
import type {
  TradingAccountAllocationInput,
  UpdateTradingAccountPayload,
  UpsertTradingAccountCredentialPayload,
} from "./types";

export const tradingAccountKeys = {
  all: ["tradingAccounts"] as const,
  lists: () => [...tradingAccountKeys.all, "list"] as const,
  details: () => [...tradingAccountKeys.all, "detail"] as const,
  detail: (id: number) => [...tradingAccountKeys.details(), id] as const,
  allocations: (id: number) =>
    [...tradingAccountKeys.detail(id), "allocations"] as const,
  accountSubscriptions: (id: number) =>
    [...tradingAccountKeys.detail(id), "accountSubscriptions"] as const,
};

export function useTradingAccounts(token: string | null) {
  return useQuery({
    queryKey: tradingAccountKeys.lists(),
    queryFn: () => getTradingAccounts(token as string),
    enabled: Boolean(token),
  });
}

export function useTradingAccount(id: number | undefined, token: string | null) {
  return useQuery({
    queryKey: id ? tradingAccountKeys.detail(id) : tradingAccountKeys.details(),
    queryFn: () => getTradingAccount(id as number, token as string),
    enabled: Boolean(token && id),
  });
}

export function useTradingAccountAllocations(
  id: number | undefined,
  token: string | null
) {
  return useQuery({
    queryKey: id
      ? tradingAccountKeys.allocations(id)
      : [...tradingAccountKeys.details(), "allocations"],
    queryFn: () => listTradingAccountAllocations(id as number, token as string),
    enabled: Boolean(token && id),
  });
}

export function useUpdateTradingAccount(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: UpdateTradingAccountPayload;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return updateTradingAccount(id, payload, token);
    },
    onSuccess: ({ account }) => {
      queryClient.setQueryData(tradingAccountKeys.detail(account.id), {
        account,
      });
      queryClient.invalidateQueries({ queryKey: tradingAccountKeys.lists() });
    },
  });
}

export function useUpsertTradingAccountCredential(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: UpsertTradingAccountCredentialPayload;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return upsertTradingAccountCredential(id, payload, token);
    },
    onSuccess: ({ account }) => {
      queryClient.setQueryData(tradingAccountKeys.detail(account.id), {
        account,
      });
      queryClient.invalidateQueries({ queryKey: tradingAccountKeys.lists() });
    },
  });
}

export function useVerifyTradingAccountCredential(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return verifyTradingAccountCredential(id, token);
    },
    onSuccess: ({ account }) => {
      queryClient.setQueryData(tradingAccountKeys.detail(account.id), {
        account,
      });
      queryClient.invalidateQueries({ queryKey: tradingAccountKeys.lists() });
    },
  });
}

export function useRevokeTradingAccountCredential(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return revokeTradingAccountCredential(id, token);
    },
    onSuccess: ({ account }) => {
      queryClient.setQueryData(tradingAccountKeys.detail(account.id), {
        account,
      });
      queryClient.invalidateQueries({ queryKey: tradingAccountKeys.lists() });
    },
  });
}

export function useCreateTradingAccountAllocation(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: TradingAccountAllocationInput;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return createTradingAccountAllocation(id, payload, token);
    },
    onSuccess: ({ allocation }) => {
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.allocations(allocation.tradingAccountId),
      });
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.accountSubscriptions(
          allocation.tradingAccountId
        ),
      });
    },
  });
}

export function useUpdateTradingAccountAllocation(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      allocationId,
      payload,
    }: {
      id: number;
      allocationId: number;
      payload: TradingAccountAllocationInput;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return updateTradingAccountAllocation(id, allocationId, payload, token);
    },
    onSuccess: ({ allocation }) => {
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.allocations(allocation.tradingAccountId),
      });
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.accountSubscriptions(
          allocation.tradingAccountId
        ),
      });
    },
  });
}
