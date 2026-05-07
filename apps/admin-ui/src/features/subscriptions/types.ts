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
  sizingValue?: number;
  exitProfileKey?: string | null;
  enabled?: boolean;
};