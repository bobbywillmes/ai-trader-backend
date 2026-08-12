import type { TradingAccount } from "../tradingAccounts/types";

export type TradingAccountScope =
  | { type: "ALL" }
  | { type: "ACCOUNT"; tradingAccountId: number };

export type PageScopeMode = "SYSTEM" | "ACCOUNT_FILTERABLE" | "ACCOUNT_SPECIFIC";

export type TradingAccountScopeContextValue = {
  scope: TradingAccountScope;
  selectedAccount: TradingAccount | null;
  accessibleAccounts: TradingAccount[];
  isAll: boolean;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  setScope: (scope: TradingAccountScope) => void;
  isAccountAccessible: (tradingAccountId: number) => boolean;
};
