import type {
  PositionSizingType,
  TradingAccountAllocation,
} from "../../../types";

export type AllocationDraft = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  maxAllocatedNotional: number | null;
  maxOpenPositions: number | null;
  maxPositionNotional: number | null;
  notes: string;
};

export type AllocationModalState =
  | {
      mode: "create";
      allocation: null;
      keyManuallyEdited: boolean;
      draft: AllocationDraft;
    }
  | {
      mode: "edit";
      allocation: TradingAccountAllocation;
      keyManuallyEdited: boolean;
      draft: AllocationDraft;
    };

export type AccountSubscriptionDraft = {
  allocationId: number | null;
  enabled: boolean;
  entriesEnabled: boolean;
  exitsEnabled: boolean;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  reservedNotional: number | null;
  minPositionNotional: number | null;
  maxQty: number | null;
  notes: string;
};

export type AccountSubscriptionStatusFilter = "all" | "active" | "disabled";
export type AccountSubscriptionSizingFilter = "all" | PositionSizingType;
