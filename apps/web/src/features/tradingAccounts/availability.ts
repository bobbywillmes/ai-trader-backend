import type { TradingAccount, TradingAccountEnvironment } from "./types";

export function getOccupiedAlpacaAccount(accounts: TradingAccount[], holderId: number, environment: TradingAccountEnvironment) {
  return accounts.find((account) => account.accountHolderUserId === holderId && account.broker === "ALPACA" && account.environment === environment);
}
