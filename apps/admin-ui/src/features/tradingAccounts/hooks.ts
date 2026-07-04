import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTradingAccountAllocation,
  createTradingAccountSubscription,
  getTradingAccount,
  getTradingAccounts,
  getTradingAccountRiskHealth,
  getTradingAccountRiskSettings,
  getTradingAccountSubscription,
  getTradingAccountSubscriptionPriceHistory,
  listTradingAccountAllocations,
  listTradingAccountSubscriptionMarketContext,
  listTradingAccountSubscriptions,
  previewTradingAccountEntryRisk,
  revokeTradingAccountCredential,
  updateTradingAccount,
  updateTradingAccountAllocation,
  updateTradingAccountRiskSettings,
  updateTradingAccountSubscription,
  upsertTradingAccountCredential,
  verifyTradingAccountCredential,
} from "./api";
import type {
  AccountSubscriptionMarketContextStatus,
  AccountSubscriptionPriceHistoryRange,
  CreateTradingAccountSubscriptionInput,
  EntryRiskPreviewInput,
  TradingAccountAllocationInput,
  TradingAccountRiskSettingsInput,
  TradingAccountSubscriptionInput,
  UpdateTradingAccountPayload,
  UpsertTradingAccountCredentialPayload,
} from "./types";

export const tradingAccountKeys = {
  all: ["tradingAccounts"] as const,
  lists: () => [...tradingAccountKeys.all, "list"] as const,
  details: () => [...tradingAccountKeys.all, "detail"] as const,
  detail: (id: number) => [...tradingAccountKeys.details(), id] as const,
  riskSettings: (id: number) =>
    [...tradingAccountKeys.detail(id), "riskSettings"] as const,
  riskHealth: (id: number) =>
    [...tradingAccountKeys.detail(id), "riskHealth"] as const,
  allocations: (id: number) =>
    [...tradingAccountKeys.detail(id), "allocations"] as const,
  accountSubscriptions: (id: number) =>
    [...tradingAccountKeys.detail(id), "accountSubscriptions"] as const,
  accountSubscription: (id: number, accountSubscriptionId: number) =>
    [
      ...tradingAccountKeys.accountSubscriptions(id),
      accountSubscriptionId,
    ] as const,
  accountSubscriptionMarketContext: (
    id: number,
    status: AccountSubscriptionMarketContextStatus,
    symbolsKey: string
  ) =>
    [
      ...tradingAccountKeys.accountSubscriptions(id),
      "marketContext",
      status,
      symbolsKey,
    ] as const,
  accountSubscriptionPriceHistory: (
    id: number,
    accountSubscriptionId: number,
    range: AccountSubscriptionPriceHistoryRange
  ) =>
    [
      ...tradingAccountKeys.accountSubscription(id, accountSubscriptionId),
      "priceHistory",
      range,
    ] as const,
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

export function useTradingAccountRiskSettings(
  id: number | undefined,
  token: string | null
) {
  return useQuery({
    queryKey: id
      ? tradingAccountKeys.riskSettings(id)
      : [...tradingAccountKeys.details(), "riskSettings"],
    queryFn: () => getTradingAccountRiskSettings(id as number, token as string),
    enabled: Boolean(token && id),
  });
}

export function useTradingAccountRiskHealth(
  id: number | undefined,
  token: string | null
) {
  return useQuery({
    queryKey: id
      ? tradingAccountKeys.riskHealth(id)
      : [...tradingAccountKeys.details(), "riskHealth"],
    queryFn: () => getTradingAccountRiskHealth(id as number, token as string),
    enabled: Boolean(token && id),
    staleTime: 60000,
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

export function useTradingAccountSubscriptions(
  id: number | undefined,
  token: string | null
) {
  return useQuery({
    queryKey: id
      ? tradingAccountKeys.accountSubscriptions(id)
      : [...tradingAccountKeys.details(), "accountSubscriptions"],
    queryFn: () => listTradingAccountSubscriptions(id as number, token as string),
    enabled: Boolean(token && id),
  });
}

export function useTradingAccountSubscription(
  id: number | undefined,
  accountSubscriptionId: number | undefined,
  token: string | null
) {
  return useQuery({
    queryKey:
      id && accountSubscriptionId
        ? tradingAccountKeys.accountSubscription(id, accountSubscriptionId)
        : [...tradingAccountKeys.details(), "accountSubscriptions", "detail"],
    queryFn: () =>
      getTradingAccountSubscription(
        id as number,
        accountSubscriptionId as number,
        token as string
      ),
    enabled: Boolean(token && id && accountSubscriptionId),
  });
}

export function useTradingAccountSubscriptionMarketContext(
  id: number | undefined,
  token: string | null,
  status: AccountSubscriptionMarketContextStatus = "active",
  symbols: string[] = []
) {
  const symbolsKey = symbols.map((symbol) => symbol.toUpperCase()).join(",");

  return useQuery({
    queryKey: id
      ? tradingAccountKeys.accountSubscriptionMarketContext(
          id,
          status,
          symbolsKey
        )
      : [...tradingAccountKeys.details(), "accountSubscriptions", "marketContext"],
    queryFn: () =>
      listTradingAccountSubscriptionMarketContext(id as number, token as string, {
        status,
        ...(symbols.length > 0 && { symbols }),
      }),
    enabled: Boolean(token && id),
    staleTime: 60000,
    refetchInterval: 120000,
  });
}

export function useTradingAccountSubscriptionPriceHistory(
  id: number | undefined,
  accountSubscriptionId: number | undefined,
  token: string | null,
  range: AccountSubscriptionPriceHistoryRange = "1y"
) {
  return useQuery({
    queryKey:
      id && accountSubscriptionId
        ? tradingAccountKeys.accountSubscriptionPriceHistory(
            id,
            accountSubscriptionId,
            range
          )
        : [
            ...tradingAccountKeys.details(),
            "accountSubscriptions",
            "priceHistory",
            range,
          ],
    queryFn: () =>
      getTradingAccountSubscriptionPriceHistory(
        id as number,
        accountSubscriptionId as number,
        token as string,
        range
      ),
    enabled: Boolean(token && id && accountSubscriptionId),
    staleTime: 300000,
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
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.riskHealth(account.id),
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
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.riskHealth(account.id),
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
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.riskHealth(account.id),
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
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.riskHealth(account.id),
      });
      queryClient.invalidateQueries({ queryKey: tradingAccountKeys.lists() });
    },
  });
}

export function useUpdateTradingAccountRiskSettings(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: TradingAccountRiskSettingsInput;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return updateTradingAccountRiskSettings(id, payload, token);
    },
    onSuccess: ({ riskSettings }) => {
      queryClient.setQueryData(
        tradingAccountKeys.riskSettings(riskSettings.tradingAccountId),
        { riskSettings }
      );
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.riskHealth(riskSettings.tradingAccountId),
      });
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
        queryKey: tradingAccountKeys.riskHealth(allocation.tradingAccountId),
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
        queryKey: tradingAccountKeys.riskHealth(allocation.tradingAccountId),
      });
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.accountSubscriptions(
          allocation.tradingAccountId
        ),
      });
    },
  });
}

export function useCreateTradingAccountSubscription(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: CreateTradingAccountSubscriptionInput;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return createTradingAccountSubscription(id, payload, token);
    },
    onSuccess: ({ accountSubscription }) => {
      queryClient.setQueryData(
        tradingAccountKeys.accountSubscription(
          accountSubscription.tradingAccountId,
          accountSubscription.id
        ),
        { accountSubscription }
      );
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.accountSubscriptions(
          accountSubscription.tradingAccountId
        ),
      });
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.riskHealth(
          accountSubscription.tradingAccountId
        ),
      });
      queryClient.invalidateQueries({
        queryKey: [
          ...tradingAccountKeys.accountSubscriptions(
            accountSubscription.tradingAccountId
          ),
          "marketContext",
        ],
      });
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.allocations(
          accountSubscription.tradingAccountId
        ),
      });
    },
  });
}

export function useUpdateTradingAccountSubscription(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      accountSubscriptionId,
      payload,
    }: {
      id: number;
      accountSubscriptionId: number;
      payload: TradingAccountSubscriptionInput;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return updateTradingAccountSubscription(
        id,
        accountSubscriptionId,
        payload,
        token
      );
    },
    onSuccess: ({ accountSubscription }) => {
      queryClient.setQueryData(
        tradingAccountKeys.accountSubscription(
          accountSubscription.tradingAccountId,
          accountSubscription.id
        ),
        { accountSubscription }
      );
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.accountSubscriptions(
          accountSubscription.tradingAccountId
        ),
      });
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.riskHealth(
          accountSubscription.tradingAccountId
        ),
      });
      queryClient.invalidateQueries({
        queryKey: [
          ...tradingAccountKeys.accountSubscriptions(
            accountSubscription.tradingAccountId
          ),
          "marketContext",
        ],
      });
      queryClient.invalidateQueries({
        queryKey: tradingAccountKeys.allocations(
          accountSubscription.tradingAccountId
        ),
      });
    },
  });
}

export function usePreviewTradingAccountEntryRisk(token: string | null) {
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: EntryRiskPreviewInput;
    }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return previewTradingAccountEntryRisk(id, payload, token);
    },
  });
}
