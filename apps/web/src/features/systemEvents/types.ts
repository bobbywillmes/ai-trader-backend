import type { TradingAccountSummary } from "../../types/tradingAccount";

export type SystemEvent = {
  id: number;
  tradingAccountId: number | null;
  tradingAccount: TradingAccountSummary | null;
  type: string;
  entityType: string;
  entityId: string;
  message: string | null;
  payloadJson: unknown;
  processed: boolean;
  createdAt: string;
};

export type SecurityActivityResponse = {
  events: SystemEvent[];
};
