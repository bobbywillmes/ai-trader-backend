import { useMutation } from "@tanstack/react-query";

import { runTradingAccountReconciliation, type RunReconciliationPayload } from "./api";

export const reconciliationKeys = {
  account: (tradingAccountId: number) => ["reconciliation", "account", tradingAccountId] as const,
};

export function useRunReconciliation(tradingAccountId: number, token: string | null) {
  return useMutation({
    mutationKey: [...reconciliationKeys.account(tradingAccountId), "run"],
    mutationFn: (payload: RunReconciliationPayload = {}) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return runTradingAccountReconciliation(token, tradingAccountId, payload);
    },
  });
}
