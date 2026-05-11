export type Subscription = {
  id: number;
  key: string;
  symbol: string;
  sizingType: string;
  sizingValue: number;
  enabled: boolean;
  exitProfileId?: number | null;
  exitProfile?: {
    id: number;
    key: string;
  } | null;
};

export type UpdateSubscriptionPayload = {
  sizingType?: 'fixed_qty' | 'dollar_amount';
  sizingValue?: number;
  exitProfileId?: number;
  exitProfileKey?: string | null;
  enabled?: boolean;
};

export type UpdateSubscriptionInput = {
  enabled?: boolean;
  name?: string;
  broker?: string;
  brokerMode?: string;
  sizingType?: 'fixed_qty' | 'dollar_amount';
  sizingValue?: number;
  strategyId?: number;
  exitProfileId?: number;
};