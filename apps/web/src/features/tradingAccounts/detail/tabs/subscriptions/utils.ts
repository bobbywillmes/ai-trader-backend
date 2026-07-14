import type {
  AccountSubscriptionPriceHistoryRange,
  EntryRiskPreview,
  PositionSizingType,
  TradingAccountAllocation,
  TradingAccountAllocationInput,
  TradingAccountSubscription,
  TradingAccountSubscriptionInput,
} from "../../../types";
import { formatMoney, formatQuantity } from "../../utils/formatters";
import type { AccountSubscriptionDraft, AllocationDraft } from "./types";
export { actionableErrorMessage } from "../../utils/errors";

export function normalizeOptionalText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeNumberInput(value: string | number) {
  if (value === "") return null;

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const priceHistoryRangeOptions: {
  value: AccountSubscriptionPriceHistoryRange;
  label: string;
}[] = [
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1Y" },
];



export const emptyAllocationDraft: AllocationDraft = {
  key: "",
  name: "",
  description: "",
  enabled: true,
  maxAllocatedNotional: null,
  maxOpenPositions: null,
  maxPositionNotional: null,
  notes: "",
};



export function accountSubscriptionHierarchyWarning(
  accountSubscription: TradingAccountSubscription
) {
  if (!accountSubscription.enabled || !accountSubscription.entriesEnabled) {
    return null;
  }
  const allocation = accountSubscription.allocation;
  if (!allocation) return "Assign an allocation before allowing new entries.";
  if (!allocation.enabled) return "Assigned allocation is disabled.";
  if (
    allocation.maxAllocatedNotional === null ||
    allocation.maxOpenPositions === null ||
    allocation.maxPositionNotional === null
  ) {
    return "Assigned allocation has incomplete limits.";
  }
  if (accountSubscription.reservedNotional === null) {
    return "Reserved capital is required for new entries.";
  }
  if (accountSubscription.reservedNotional > allocation.maxPositionNotional) {
    return "Reservation exceeds the allocation per-position ceiling.";
  }
  if (
    accountSubscription.sizingType === "MAX_NOTIONAL" &&
    accountSubscription.maxPositionNotional !== null &&
    accountSubscription.maxPositionNotional > accountSubscription.reservedNotional
  ) {
    return "MAX_NOTIONAL sizing exceeds reserved capital.";
  }
  return null;
}

export function suggestAllocationKey(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
}

export function allocationToDraft(
  allocation: TradingAccountAllocation
): AllocationDraft {
  return {
    key: allocation.key,
    name: allocation.name,
    description: allocation.description ?? "",
    enabled: allocation.enabled,
    maxAllocatedNotional: allocation.maxAllocatedNotional,
    maxOpenPositions: allocation.maxOpenPositions,
    maxPositionNotional: allocation.maxPositionNotional,
    notes: allocation.notes ?? "",
  };
}

export function allocationDraftToPayload(
  draft: AllocationDraft
): TradingAccountAllocationInput {
  return {
    key: draft.key.trim().toLowerCase(),
    name: draft.name.trim(),
    description: normalizeOptionalText(draft.description),
    enabled: draft.enabled,
    maxAllocatedNotional: draft.maxAllocatedNotional,
    maxOpenPositions: draft.maxOpenPositions,
    maxPositionNotional: draft.maxPositionNotional,
    notes: normalizeOptionalText(draft.notes),
  };
}

export function validateAllocationDraft(draft: AllocationDraft) {
  const key = draft.key.trim();
  const name = draft.name.trim();

  if (!name) return "Name is required.";
  if (!key) return "Key is required.";
  if (!/^[a-z0-9_-]+$/.test(key)) {
    return "Key may only contain lowercase letters, numbers, hyphens, and underscores.";
  }
  if (
    draft.maxAllocatedNotional !== null &&
    draft.maxAllocatedNotional <= 0
  ) {
    return "Max allocated dollars must be empty or greater than zero.";
  }
  if (
    draft.maxPositionNotional !== null &&
    draft.maxPositionNotional <= 0
  ) {
    return "Default max position dollars must be empty or greater than zero.";
  }
  if (
    draft.maxOpenPositions !== null &&
    (!Number.isInteger(draft.maxOpenPositions) || draft.maxOpenPositions <= 0)
  ) {
    return "Max open positions must be empty or a positive whole number.";
  }
  if (
    draft.enabled &&
    (draft.maxAllocatedNotional === null ||
      draft.maxOpenPositions === null ||
      draft.maxPositionNotional === null)
  ) {
    return "Enabled allocations require a total budget, max open positions, and per-position ceiling.";
  }
  if (
    draft.maxAllocatedNotional !== null &&
    draft.maxPositionNotional !== null &&
    draft.maxPositionNotional > draft.maxAllocatedNotional
  ) {
    return "Per-position ceiling cannot exceed the allocation budget.";
  }

  return null;
}

export function accountSubscriptionToDraft(
  accountSubscription: TradingAccountSubscription
): AccountSubscriptionDraft {
  return {
    allocationId: accountSubscription.allocationId,
    enabled: accountSubscription.enabled,
    entriesEnabled: accountSubscription.entriesEnabled,
    exitsEnabled: accountSubscription.exitsEnabled,
    sizingType: accountSubscription.sizingType,
    fixedQty: accountSubscription.fixedQty,
    maxPositionNotional: accountSubscription.maxPositionNotional,
    reservedNotional: accountSubscription.reservedNotional,
    minPositionNotional: accountSubscription.minPositionNotional,
    maxQty: accountSubscription.maxQty,
    notes: accountSubscription.notes ?? "",
  };
}

export function accountSubscriptionDraftToPayload(
  draft: AccountSubscriptionDraft
): TradingAccountSubscriptionInput {
  return {
    allocationId: draft.allocationId,
    enabled: draft.enabled,
    entriesEnabled: draft.entriesEnabled,
    exitsEnabled: draft.exitsEnabled,
    sizingType: draft.sizingType,
    fixedQty: draft.sizingType === "FIXED_QTY" ? draft.fixedQty : null,
    maxPositionNotional:
      draft.sizingType === "MAX_NOTIONAL" ? draft.maxPositionNotional : null,
    reservedNotional: draft.reservedNotional,
    minPositionNotional: draft.minPositionNotional,
    maxQty: draft.maxQty,
    notes: normalizeOptionalText(draft.notes),
  };
}

export function validateAccountSubscriptionDraft(
  draft: AccountSubscriptionDraft,
  allocations: TradingAccountAllocation[],
  editing: TradingAccountSubscription | null
) {
  const entryActive = draft.enabled && draft.entriesEnabled;
  const allocation = allocations.find((item) => item.id === draft.allocationId);
  if (entryActive && !allocation) {
    return "Active subscriptions that allow entries require an allocation.";
  }
  if (entryActive && (draft.reservedNotional === null || draft.reservedNotional <= 0)) {
    return "Active subscriptions that allow entries require reserved capital.";
  }
  if (entryActive && allocation && !allocation.enabled) {
    return "The selected allocation is disabled for new entries.";
  }
  if (
    entryActive &&
    allocation &&
    (allocation.maxAllocatedNotional === null ||
      allocation.maxOpenPositions === null ||
      allocation.maxPositionNotional === null)
  ) {
    return "The selected allocation is missing required limits.";
  }
  if (draft.sizingType === "FIXED_QTY") {
    if (draft.fixedQty === null || draft.fixedQty <= 0) {
      return "Fixed quantity is required and must be greater than zero.";
    }
  }

  if (draft.sizingType === "MAX_NOTIONAL") {
    if (
      draft.maxPositionNotional === null ||
      draft.maxPositionNotional <= 0
    ) {
      return "Max position dollars is required and must be greater than zero.";
    }
    if (
      draft.reservedNotional !== null &&
      draft.maxPositionNotional > draft.reservedNotional
    ) {
      return "Max position dollars cannot exceed reserved capital.";
    }
  }

  if (
    entryActive &&
    allocation?.maxPositionNotional !== null &&
    allocation?.maxPositionNotional !== undefined &&
    draft.reservedNotional !== null &&
    draft.reservedNotional > allocation.maxPositionNotional
  ) {
    return "Reserved capital cannot exceed the allocation per-position ceiling.";
  }

  const editableReservation =
    editing?.allocationId === allocation?.id
      ? editing?.reservedNotional ?? 0
      : 0;
  const availableReservation =
    allocation?.remainingAllocatedNotional === null ||
    allocation?.remainingAllocatedNotional === undefined
      ? null
      : allocation.remainingAllocatedNotional + editableReservation;
  if (
    entryActive &&
    availableReservation !== null &&
    draft.reservedNotional !== null &&
    draft.reservedNotional > availableReservation
  ) {
    return "Reserved capital would exceed the allocation's remaining capacity.";
  }

  if (
    draft.minPositionNotional !== null &&
    draft.minPositionNotional < 0
  ) {
    return "Min position dollars must be empty or zero or greater.";
  }

  if (draft.maxQty !== null && draft.maxQty <= 0) {
    return "Max quantity must be empty or greater than zero.";
  }

  return null;
}

export function formatSizing(
  accountSubscription: TradingAccountSubscription,
  currency: string
) {
  if (accountSubscription.sizingType === "FIXED_QTY") {
    return `Fixed qty: ${formatQuantity(accountSubscription.fixedQty)}`;
  }

  return `Max position dollars: ${formatMoney(
    accountSubscription.maxPositionNotional,
    currency
  )}`;
}

export function formatLimits(
  accountSubscription: TradingAccountSubscription,
  currency: string
) {
  const limits = [];

  if (accountSubscription.minPositionNotional !== null) {
    limits.push(
      `Min dollars: ${formatMoney(
        accountSubscription.minPositionNotional,
        currency
      )}`
    );
  }

  if (accountSubscription.maxQty !== null) {
    limits.push(`Max qty: ${formatQuantity(accountSubscription.maxQty)}`);
  }

  return limits.length > 0 ? limits.join(" | ") : "-";
}

export function sizingTypeLabel(value: PositionSizingType) {
  return value === "FIXED_QTY"
    ? "Fixed share quantity"
    : "Max position dollars";
}

export function accountSubscriptionMatchesSearch(
  accountSubscription: TradingAccountSubscription,
  search: string
) {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) return true;

  const values = [
    accountSubscription.subscription.symbol,
    accountSubscription.subscription.key,
    accountSubscription.subscription.strategy?.key,
    accountSubscription.subscription.strategy?.name,
    accountSubscription.subscription.exitProfile?.key,
    accountSubscription.subscription.exitProfile?.name,
    accountSubscription.allocation?.key,
    accountSubscription.allocation?.name,
  ];

  return values.some((value) =>
    value?.toLowerCase().includes(normalizedSearch)
  );
}



export function formatMarketDate(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatShareLabel(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${formatQuantity(value)} ${value === 1 ? "share" : "shares"}`;
}

export function previewLayerLabel(layer: EntryRiskPreview["risk"]["layer"]) {
  if (!layer) return "-";

  switch (layer) {
    case "global":
      return "Global";
    case "account":
      return "Account";
    case "allocation":
      return "Allocation";
    case "subscription":
      return "Subscription";
    case "session":
      return "Session";
    case "unknown":
    default:
      return "Unknown";
  }
}

export function previewSessionLabel(session: EntryRiskPreview["session"]) {
  if (!session.checked) {
    return session.note ?? "Session checks were not enforced for preview.";
  }

  if (session.wouldBlockRealEntryNow) {
    return session.message ?? session.code ?? "Real entry would be blocked now.";
  }

  return session.entryWindowOpen
    ? "Entry window is open now."
    : "Session did not block this preview.";
}
