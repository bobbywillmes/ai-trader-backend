import type { TradingAccountSummary } from "../../types/tradingAccount";

export type OpenOrder = {
  id: string;
  tradingAccountId: number | null;
  tradingAccount: TradingAccountSummary | null;
  symbol: string;
  side: string;
  orderType?: string | null;
  type?: string | null;
  timeInForce?: string | null;
  time_in_force?: string | null;
  qty?: string | number | null;
  filledQty?: string | number | null;
  filled_qty?: string | number | null;
  limitPrice?: string | number | null;
  limit_price?: string | number | null;
  stopPrice?: string | number | null;
  stop_price?: string | number | null;
  filledAvgPrice?: string | number | null;
  filled_avg_price?: string | number | null;
  status: string;
  submittedAt?: string | null;
  submitted_at?: string | null;
  clientOrderId?: string | null;
  client_order_id?: string | null;
};

export type OpenOrdersAccountResult = {
  account: TradingAccountSummary;
  availability: "AVAILABLE" | "UNAVAILABLE";
  reason: "CREDENTIALS_MISSING" | "CREDENTIALS_UNUSABLE" | "BROKER_REQUEST_FAILED" | null;
  message: string | null;
  orders: OpenOrder[] | null;
};
