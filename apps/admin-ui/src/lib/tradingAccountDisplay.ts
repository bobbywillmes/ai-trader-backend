import type { TradingAccountSummary } from "../types/tradingAccount";

export function formatTradingAccountLabel(
  account?: TradingAccountSummary | null,
  tradingAccountId?: number | null,
  emptyLabel: "Global" | "Unassigned" = "Unassigned"
) {
  if (account) {
    return `${account.displayName} - ${account.environment}`;
  }

  if (tradingAccountId !== null && tradingAccountId !== undefined) {
    return `Account #${tradingAccountId}`;
  }

  return emptyLabel;
}
