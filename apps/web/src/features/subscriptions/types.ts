export type CatalogAssignment = {
  id: number;
  enabled: boolean;
  entriesEnabled: boolean;
  exitsEnabled: boolean;
  tradingAccount: {
    id: number;
    displayName: string;
    environment: "PAPER" | "LIVE";
    status: string;
  };
};

export type Subscription = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  symbol: string;
  enabled: boolean;
  security: { id: number; symbol: string; name: string; enabled: boolean };
  strategyId: number;
  strategy: { id: number; key: string; name: string; enabled: boolean };
  exitProfileId: number;
  exitProfile: { id: number; key: string; name: string; enabled: boolean };
  accountSubscriptions: CatalogAssignment[];
};

export type CreateSubscriptionPayload = {
  key: string;
  name: string;
  description?: string | null;
  symbol: string;
  strategyId: number;
  exitProfileId: number;
  enabled?: boolean;
};

export type UpdateSubscriptionPayload = Partial<CreateSubscriptionPayload>;
export type UpdateSubscriptionInput = UpdateSubscriptionPayload;
