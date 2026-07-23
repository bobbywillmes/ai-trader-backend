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

export type SubscriptionAssignmentStatus = "all" | "assigned" | "unassigned";
export type SubscriptionSortBy =
  | "key"
  | "name"
  | "symbol"
  | "enabled"
  | "assignmentCount";
export type SubscriptionSortDirection = "asc" | "desc";

export type SubscriptionCatalogQuery = {
  page: number;
  pageSize: number;
  search?: string;
  enabled?: boolean;
  assignmentStatus?: SubscriptionAssignmentStatus;
  assignmentEnabled?: boolean;
  entriesEnabled?: boolean;
  exitsEnabled?: boolean;
  tradingAccountId?: number;
  securityId?: number;
  strategyId?: number;
  exitProfileId?: number;
  sortBy?: SubscriptionSortBy;
  sortDirection?: SubscriptionSortDirection;
};

export type SubscriptionCatalogResponse = {
  subscriptions: Subscription[];
  data: Subscription[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  summary: {
    total: number;
    globallyEnabled: number;
    globallyRetired: number;
    assigned: number;
    unassigned: number;
  };
  filters: {
    tradingAccounts: Array<{
      id: number;
      displayName: string;
      environment: "PAPER" | "LIVE";
      status: string;
    }>;
    securities: Array<{ id: number; symbol: string; name: string }>;
    strategies: Array<{ id: number; key: string; name: string }>;
    exitProfiles: Array<{ id: number; key: string; name: string }>;
  };
};
