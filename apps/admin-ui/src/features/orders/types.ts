export type OpenOrder = {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty?: string | number | null;
  filledQty?: string | number | null;
  filled_qty?: string | number | null;
  limitPrice?: string | number | null;
  limit_price?: string | number | null;
  status: string;
  submittedAt?: string | null;
  submitted_at?: string | null;
  clientOrderId?: string | null;
  client_order_id?: string | null;
};
