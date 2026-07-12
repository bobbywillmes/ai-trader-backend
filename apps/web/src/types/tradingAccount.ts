export type TradingBroker = "ALPACA";

export type TradingAccountEnvironment = "PAPER" | "LIVE";

export type TradingAccountSummary = {
  id: number;
  displayName: string;
  broker: TradingBroker;
  environment: TradingAccountEnvironment;
  status?: string | null;
};
