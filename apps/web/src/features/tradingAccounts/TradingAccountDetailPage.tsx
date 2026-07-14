import { useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Modal,
  NumberInput,
  PasswordInput,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ApiError, getAdminToken } from "../../lib/api";
import { useOpenOrders } from "../orders/hooks";
import type { OpenOrder } from "../orders/types";
import { useOpenPositions } from "../positions/hooks";
import type { TrackedPosition } from "../positions/types";
import {
  useCreateTradingAccountAllocation,
  usePreviewTradingAccountEntryRisk,
  useRevokeTradingAccountCredential,
  useTradingAccount,
  useTradingAccountAllocations,
  useTradingAccountRiskHealth,
  useTradingAccountRiskSettings,
  useTradingAccountSubscriptionMarketContext,
  useTradingAccountSubscriptionPriceHistory,
  useTradingAccountSubscriptions,
  useUpdateTradingAccount,
  useUpdateTradingAccountAllocation,
  useUpdateTradingAccountRiskSettings,
  useUpdateTradingAccountSubscription,
  useUpsertTradingAccountCredential,
  useVerifyTradingAccountCredential,
} from "./hooks";
import type {
  AccountSubscriptionMarketContextItem,
  AccountSubscriptionPriceHistoryRange,
  AccountSubscriptionPriceHistoryResponse,
  BrokerCredentialStatus,
  EntryRiskPreview,
  PositionSizingType,
  TradingAccount,
  TradingAccountAllocation,
  TradingAccountAllocationInput,
  TradingAccountEnvironment,
  TradingAccountRiskSettings,
  TradingAccountRiskSettingsInput,
  TradingAccountRiskHealth,
  TradingAccountRiskHealthCheck,
  TradingAccountRiskHealthStatus,
  TradingAccountSubscription,
  TradingAccountSubscriptionInput,
  TradingAccountStatus,
} from "./types";

type DetailItemProps = {
  label: string;
  value: ReactNode;
};

type AccountSettingsDraft = {
  displayName: string;
  estimatedTradingCapital: number | null;
  maxDeployableNotional: number | null;
  status: TradingAccountStatus;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
  pausedReason: string;
  notes: string;
};

type CredentialDraft = {
  apiKey: string;
  apiSecret: string;
};

type AccountRiskSettingsDraft = {
  enabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
  notes: string;
};

type AllocationDraft = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  maxAllocatedNotional: number | null;
  maxOpenPositions: number | null;
  maxPositionNotional: number | null;
  notes: string;
};

type AllocationModalState =
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

type AccountSubscriptionDraft = {
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

type AccountSubscriptionStatusFilter = "all" | "active" | "disabled";
type AccountSubscriptionSizingFilter = "all" | PositionSizingType;
type TradingAccountDetailTab =
  | "overview"
  | "positions"
  | "orders"
  | "subscriptions"
  | "risk-health"
  | "activity";

const tradingAccountDetailTabs: {
  value: TradingAccountDetailTab;
  label: string;
}[] = [
  { value: "overview", label: "Overview" },
  { value: "positions", label: "Positions" },
  { value: "orders", label: "Orders" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "risk-health", label: "Risk Health" },
  { value: "activity", label: "Activity" },
];

const tradingAccountDetailTabValues: ReadonlySet<string> = new Set(
  tradingAccountDetailTabs.map((tab) => tab.value)
);

function isTradingAccountDetailTab(
  value: string | null
): value is TradingAccountDetailTab {
  return value !== null && tradingAccountDetailTabValues.has(value);
}

const priceHistoryRangeOptions: {
  value: AccountSubscriptionPriceHistoryRange;
  label: string;
}[] = [
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1Y" },
];

const tradingAccountStatusOptions: {
  value: TradingAccountStatus;
  label: string;
}[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
  { value: "NEEDS_CREDENTIALS", label: "Needs credentials" },
  { value: "ERROR", label: "Error" },
  { value: "ARCHIVED", label: "Archived" },
];

const emptyAllocationDraft: AllocationDraft = {
  key: "",
  name: "",
  description: "",
  enabled: true,
  maxAllocatedNotional: null,
  maxOpenPositions: null,
  maxPositionNotional: null,
  notes: "",
};

function accountToSettingsDraft(account: TradingAccount): AccountSettingsDraft {
  return {
    displayName: account.displayName,
    estimatedTradingCapital: account.estimatedTradingCapital,
    maxDeployableNotional: account.maxDeployableNotional,
    status: account.status,
    tradingEnabled: account.tradingEnabled,
    killSwitchEnabled: account.killSwitchEnabled,
    pausedReason: account.pausedReason ?? "",
    notes: account.notes ?? "",
  };
}

function riskSettingsToDraft(
  riskSettings: TradingAccountRiskSettings
): AccountRiskSettingsDraft {
  return {
    enabled: riskSettings.enabled,
    maxDailyEntryOrders: riskSettings.maxDailyEntryOrders,
    maxDailyEntryNotional: riskSettings.maxDailyEntryNotional,
    maxOpenPositions: riskSettings.maxOpenPositions,
    maxTotalOpenNotional: riskSettings.maxTotalOpenNotional,
    maxSymbolOpenNotional: riskSettings.maxSymbolOpenNotional,
    maxSubscriptionOpenNotional: riskSettings.maxSubscriptionOpenNotional,
    notes: riskSettings.notes ?? "",
  };
}

function normalizeOptionalText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumberInput(value: string | number) {
  if (value === "") return null;

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function actionableErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.data && typeof error.data === "object") {
    const details = "details" in error.data ? error.data.details : null;
    if (details && typeof details === "object" && "violations" in details) {
      const violations = Array.isArray(details.violations)
        ? details.violations
        : [];
      const messages = violations.flatMap((item) =>
        item && typeof item === "object" && "message" in item &&
        typeof item.message === "string"
          ? [item.message]
          : []
      );
      if (messages.length > 0) return messages.join(" ");
    }
  }
  return error instanceof Error ? error.message : fallback;
}

function accountSubscriptionHierarchyWarning(
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

function suggestAllocationKey(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
}

function allocationToDraft(
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

function allocationDraftToPayload(
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

function validateAllocationDraft(draft: AllocationDraft) {
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

function accountSubscriptionToDraft(
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

function accountSubscriptionDraftToPayload(
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

function validateAccountSubscriptionDraft(
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

function formatQuantity(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString();
}

function formatSizing(
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

function formatLimits(
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

function sizingTypeLabel(value: PositionSizingType) {
  return value === "FIXED_QTY"
    ? "Fixed share quantity"
    : "Max position dollars";
}

function accountSubscriptionMatchesSearch(
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

function settingsDraftChanged(
  account: TradingAccount,
  draft: AccountSettingsDraft
) {
  return (
    account.displayName !== draft.displayName ||
    account.estimatedTradingCapital !== draft.estimatedTradingCapital ||
    account.maxDeployableNotional !== draft.maxDeployableNotional ||
    account.status !== draft.status ||
    account.tradingEnabled !== draft.tradingEnabled ||
    account.killSwitchEnabled !== draft.killSwitchEnabled ||
    (account.pausedReason ?? "") !== draft.pausedReason ||
    (account.notes ?? "") !== draft.notes
  );
}

function riskSettingsDraftChanged(
  riskSettings: TradingAccountRiskSettings,
  draft: AccountRiskSettingsDraft
) {
  return (
    riskSettings.enabled !== draft.enabled ||
    riskSettings.maxDailyEntryOrders !== draft.maxDailyEntryOrders ||
    riskSettings.maxDailyEntryNotional !== draft.maxDailyEntryNotional ||
    riskSettings.maxOpenPositions !== draft.maxOpenPositions ||
    riskSettings.maxTotalOpenNotional !== draft.maxTotalOpenNotional ||
    riskSettings.maxSymbolOpenNotional !== draft.maxSymbolOpenNotional ||
    riskSettings.maxSubscriptionOpenNotional !==
      draft.maxSubscriptionOpenNotional ||
    (riskSettings.notes ?? "") !== draft.notes
  );
}

function validateAccountRiskSettingsDraft(draft: AccountRiskSettingsDraft) {
  if (
    draft.maxDailyEntryOrders !== null &&
    (!Number.isInteger(draft.maxDailyEntryOrders) ||
      draft.maxDailyEntryOrders <= 0)
  ) {
    return "Account max daily entry orders must be empty or a positive whole number.";
  }

  if (
    draft.maxOpenPositions !== null &&
    (!Number.isInteger(draft.maxOpenPositions) || draft.maxOpenPositions <= 0)
  ) {
    return "Account max open positions must be empty or a positive whole number.";
  }

  const dollarLimits = [
    draft.maxDailyEntryNotional,
    draft.maxTotalOpenNotional,
    draft.maxSymbolOpenNotional,
    draft.maxSubscriptionOpenNotional,
  ];

  if (dollarLimits.some((value) => value !== null && value <= 0)) {
    return "Account dollar limits must be empty or greater than zero.";
  }

  return null;
}

function riskSettingsDraftToPayload(
  draft: AccountRiskSettingsDraft
): TradingAccountRiskSettingsInput {
  return {
    enabled: draft.enabled,
    maxDailyEntryOrders: draft.maxDailyEntryOrders,
    maxDailyEntryNotional: draft.maxDailyEntryNotional,
    maxOpenPositions: draft.maxOpenPositions,
    maxTotalOpenNotional: draft.maxTotalOpenNotional,
    maxSymbolOpenNotional: draft.maxSymbolOpenNotional,
    maxSubscriptionOpenNotional: draft.maxSubscriptionOpenNotional,
    notes: normalizeOptionalText(draft.notes),
  };
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatMoney(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatMarketDate(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatShareLabel(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${formatQuantity(value)} ${value === 1 ? "share" : "shares"}`;
}

function previewLayerLabel(layer: EntryRiskPreview["risk"]["layer"]) {
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

function previewSessionLabel(session: EntryRiskPreview["session"]) {
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

function PreviewMetric({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <Box>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value}
      </Text>
    </Box>
  );
}

function MarketContextCell({
  context,
  currency,
  loading,
}: {
  context: AccountSubscriptionMarketContextItem | undefined;
  currency: string;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Group gap="xs" wrap="nowrap">
        <Loader size="xs" color="cyan" />
        <Text size="xs" c="dimmed">
          Loading...
        </Text>
      </Group>
    );
  }

  if (!context) {
    return (
      <Text size="sm" c="dimmed">
        Price unavailable
      </Text>
    );
  }

  if (context.latestPrice === null) {
    return (
      <Stack gap={2}>
        <Text size="sm" c="dimmed">
          Price unavailable
        </Text>
        {context.warnings.slice(0, 1).map((warning) => (
          <Text key={warning} size="xs" c="orange">
            {warning}
          </Text>
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        Latest: {formatMoney(context.latestPrice, currency)}
      </Text>
      <Text size="xs" c="dimmed">
        52W: {formatMoney(context.week52Low, currency)} -{" "}
        {formatMoney(context.week52High, currency)}
      </Text>
      {context.sizingType === "MAX_NOTIONAL" ? (
        <>
          <Text size="xs">
            Budget: {formatMoney(context.maxPositionNotional, currency)}{" "}
            {"->"}{" "}
            {formatShareLabel(context.estimatedQty)}
          </Text>
          {context.dollarsToNextShare !== null &&
            context.nextShareQty !== null &&
            context.dollarsToNextShare > 0 && (
              <Text size="xs" c="dimmed">
                +{formatMoney(context.dollarsToNextShare, currency)} to reach{" "}
                {formatShareLabel(context.nextShareQty)}
              </Text>
            )}
        </>
      ) : (
        <>
          <Text size="xs">
            Fixed qty: {formatQuantity(context.fixedQty)}
          </Text>
          <Text size="xs" c="dimmed">
            Estimated notional:{" "}
            {formatMoney(context.estimatedNotional, currency)}
          </Text>
        </>
      )}
      {context.latestPriceAt && (
        <Text size="xs" c="dimmed">
          As of {formatMarketDate(context.latestPriceAt)}
        </Text>
      )}
      {context.warnings.slice(0, 1).map((warning) => (
        <Text key={warning} size="xs" c="orange">
          {warning}
        </Text>
      ))}
    </Stack>
  );
}

function PriceHistoryTooltip({
  active,
  label,
  payload,
  currency,
}: {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ value?: number | string | null }>;
  currency: string;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const value = payload[0]?.value;
  const close = value === null || value === undefined ? null : Number(value);

  return (
    <Box
      p="xs"
      style={{
        background: "#111827",
        border: "1px solid rgba(148, 163, 184, 0.28)",
        borderRadius: 8,
        boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
      }}
    >
      <Text size="xs" fw={700} c="gray.2">
        {label}
      </Text>
      <Text size="xs" c="gray.2">
        Close: {Number.isFinite(close) ? formatMoney(close, currency) : "-"}
      </Text>
    </Box>
  );
}

function PriceHistoryChart({
  currency,
  data,
  isError,
  isLoading,
  range,
  onRangeChange,
}: {
  currency: string;
  data: AccountSubscriptionPriceHistoryResponse | undefined;
  isError: boolean;
  isLoading: boolean;
  range: AccountSubscriptionPriceHistoryRange;
  onRangeChange: (range: AccountSubscriptionPriceHistoryRange) => void;
}) {
  const candles = data?.candles ?? [];

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={700} size="sm">
              Price history
            </Text>
            <Text size="xs" c="dimmed">
              Daily close from backend market data.
            </Text>
          </div>
          <SegmentedControl
            size="xs"
            value={range}
            onChange={(value) =>
              onRangeChange(value as AccountSubscriptionPriceHistoryRange)
            }
            data={priceHistoryRangeOptions}
          />
        </Group>

        {isError && (
          <Alert color="yellow">Price history is unavailable.</Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading price history...
            </Text>
          </Group>
        )}

        {!isLoading && !isError && candles.length === 0 && (
          <Alert color="gray">No daily candles are available.</Alert>
        )}

        {!isLoading && !isError && candles.length > 0 && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <DetailItem
                label="Latest close"
                value={formatMoney(data?.summary.latestClose, currency)}
              />
              <DetailItem
                label="52-week high"
                value={formatMoney(data?.summary.week52High, currency)}
              />
              <DetailItem
                label="52-week low"
                value={formatMoney(data?.summary.week52Low, currency)}
              />
            </SimpleGrid>
            <Box h={220}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={candles}
                  margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                >
                  <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatMarketDate}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    width={72}
                    tickFormatter={(value) =>
                      formatMoney(Number(value), currency)
                    }
                    tickLine={false}
                    axisLine={false}
                    domain={["dataMin", "dataMax"]}
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(203, 213, 225, 0.24)" }}
                    content={<PriceHistoryTooltip currency={currency} />}
                  />
                  <Line
                    type="monotone"
                    dataKey="close"
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Box>
          </>
        )}
      </Stack>
    </Card>
  );
}

function MarketContextPanel({
  context,
  currency,
  draft,
  loading,
}: {
  context: AccountSubscriptionMarketContextItem | undefined;
  currency: string;
  draft: AccountSubscriptionDraft;
  loading: boolean;
}) {
  const latestPrice = context?.latestPrice ?? null;
  const fixedQty = draft.sizingType === "FIXED_QTY" ? draft.fixedQty : null;
  const budget = draft.sizingType === "MAX_NOTIONAL"
    ? draft.maxPositionNotional
    : context?.maxPositionNotional ?? null;
  const estimatedQty =
    latestPrice === null
      ? null
      : draft.sizingType === "FIXED_QTY"
        ? fixedQty
        : budget === null || budget <= 0
          ? null
          : Math.floor(budget / latestPrice);
  const estimatedNotional =
    latestPrice !== null && estimatedQty !== null
      ? estimatedQty * latestPrice
      : null;
  const nextShareQty =
    latestPrice !== null &&
    draft.sizingType === "MAX_NOTIONAL" &&
    estimatedQty !== null
      ? estimatedQty + 1
      : null;
  const nextShareNotional =
    latestPrice !== null && nextShareQty !== null
      ? nextShareQty * latestPrice
      : null;
  const dollarsToNextShare =
    budget !== null && nextShareNotional !== null
      ? Math.max(0, nextShareNotional - budget)
      : null;

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="md">
        <div>
          <Text fw={700} size="sm">
            Market context
          </Text>
          <Text size="xs" c="dimmed">
            Runtime entry sizing uses this account-subscription configuration.
            MAX_NOTIONAL uses backend-owned latest market data to calculate a
            whole-share quantity.
          </Text>
        </div>

        {loading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading market context...
            </Text>
          </Group>
        )}

        {!loading && !context && (
          <Alert color="gray">Price context is unavailable.</Alert>
        )}

        {!loading && context && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <DetailItem
                label="Latest price"
                value={formatMoney(context.latestPrice, currency)}
              />
              <DetailItem
                label="Current budget"
                value={formatMoney(budget, currency)}
              />
              <DetailItem
                label="Estimated shares"
                value={formatShareLabel(estimatedQty)}
              />
              <DetailItem
                label="Estimated notional"
                value={formatMoney(estimatedNotional, currency)}
              />
              <DetailItem
                label="Next share requires"
                value={formatMoney(nextShareNotional, currency)}
              />
              <DetailItem
                label="Additional dollars needed"
                value={formatMoney(dollarsToNextShare, currency)}
              />
            </SimpleGrid>
            {context.warnings.length > 0 && (
              <Alert color="yellow">
                {context.warnings.slice(0, 2).join(" ")}
              </Alert>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "-";
  return value.replace(/_/g, " ");
}

function accountStatusColor(status: TradingAccountStatus) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "PAUSED":
      return "yellow";
    case "NEEDS_CREDENTIALS":
      return "orange";
    case "ERROR":
      return "red";
    case "ARCHIVED":
      return "gray";
    default:
      return "gray";
  }
}

function credentialStatusColor(status: BrokerCredentialStatus | null) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "NEEDS_VERIFICATION":
      return "yellow";
    case "INVALID":
      return "red";
    case "REVOKED":
      return "gray";
    default:
      return "orange";
  }
}

function environmentColor(environment: TradingAccountEnvironment) {
  return environment === "LIVE" ? "red" : "blue";
}

function riskHealthStatusColor(status: TradingAccountRiskHealthStatus) {
  switch (status) {
    case "READY":
      return "teal";
    case "READY_WITH_WARNINGS":
      return "yellow";
    case "BLOCKED":
      return "red";
    default:
      return "gray";
  }
}

function riskHealthStatusLabel(status: TradingAccountRiskHealthStatus) {
  switch (status) {
    case "READY":
      return "Ready";
    case "READY_WITH_WARNINGS":
      return "Ready with warnings";
    case "BLOCKED":
      return "Blocked";
    default:
      return status;
  }
}

function formatSurplus(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "-";

  const formatted = formatMoney(Math.abs(value), currency);

  return value >= 0 ? `${formatted} surplus` : `${formatted} deficit`;
}

function DetailItem({ label, value }: DetailItemProps) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value ?? "-"}
      </Text>
    </Stack>
  );
}

function HealthCheckList({
  title,
  checks,
  color,
}: {
  title: string;
  checks: TradingAccountRiskHealthCheck[];
  color: string;
}) {
  if (checks.length === 0) {
    return null;
  }

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Text size="sm" fw={700}>
          {title}
        </Text>
        <Badge color={color} variant="light">
          {checks.length}
        </Badge>
      </Group>
      <Stack gap={6}>
        {checks.map((check) => (
          <Box
            key={check.id}
            p="xs"
            style={{
              border: "1px solid var(--mantine-color-gray-3)",
              borderRadius: 8,
            }}
          >
            <Group justify="space-between" gap="xs" align="flex-start">
              <Text size="sm" fw={600}>
                {check.label}
              </Text>
              <Badge size="xs" color={color} variant="light">
                {check.status}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {check.message}
            </Text>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}

function AccountSummaryCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Account Summary</Title>
            <Text size="sm" c="dimmed">
              Broker identity and account-level safety posture.
            </Text>
          </div>
          <Group gap="xs">
            <Badge color={environmentColor(account.environment)} variant="light">
              {account.environment}
            </Badge>
            <Badge color={accountStatusColor(account.status)} variant="light">
              {formatStatus(account.status)}
            </Badge>
          </Group>
        </Group>

        {account.environment === "LIVE" && (
          <Alert color="red" title="Live account">
            Treat every credential and trading-control change for this account as
            broker-facing real-money risk.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Display name" value={account.displayName} />
          <DetailItem label="Broker" value={account.broker} />
          <DetailItem label="Environment" value={account.environment} />
          <DetailItem label="Status" value={formatStatus(account.status)} />
          <DetailItem
            label="Trading enabled"
            value={
              <Badge color={account.tradingEnabled ? "teal" : "gray"}>
                {account.tradingEnabled ? "Enabled" : "Disabled"}
              </Badge>
            }
          />
          <DetailItem
            label="Kill switch"
            value={
              <Badge color={account.killSwitchEnabled ? "orange" : "teal"}>
                {account.killSwitchEnabled ? "Enabled" : "Off"}
              </Badge>
            }
          />
          <DetailItem
            label="Estimated capital"
            value={formatMoney(
              account.estimatedTradingCapital,
              account.baseCurrency
            )}
          />
          <DetailItem label="Base currency" value={account.baseCurrency} />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function BrokerSnapshotCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <div>
          <Title order={3}>Broker Account Snapshot</Title>
          <Text size="sm" c="dimmed">
            Latest metadata and balances synced from the broker.
          </Text>
        </div>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Broker account id" value={account.brokerAccountId} />
          <DetailItem
            label="Account number"
            value={account.brokerAccountNumberMasked}
          />
          <DetailItem
            label="Broker status"
            value={account.brokerAccountStatus}
          />
          <DetailItem
            label="Last broker sync"
            value={formatDateTime(account.lastBrokerSyncAt)}
          />
          <DetailItem
            label="Cash"
            value={formatMoney(account.lastCash, account.baseCurrency)}
          />
          <DetailItem
            label="Buying power"
            value={formatMoney(account.lastBuyingPower, account.baseCurrency)}
          />
          <DetailItem
            label="Equity"
            value={formatMoney(account.lastEquity, account.baseCurrency)}
          />
          <DetailItem
            label="Portfolio value"
            value={formatMoney(account.lastPortfolioValue, account.baseCurrency)}
          />
          <DetailItem
            label="Open position notional"
            value={formatMoney(
              account.totalOpenPositionNotional,
              account.baseCurrency
            )}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function CredentialStatusCard({ account }: { account: TradingAccount }) {
  const credential = account.credential;

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Credential Status</Title>
            <Text size="sm" c="dimmed">
              Safe credential summary only. Secrets and ciphertext are never
              displayed.
            </Text>
          </div>
          <Badge color={credentialStatusColor(credential.status)} variant="light">
            {credential.exists ? formatStatus(credential.status) : "No credentials"}
          </Badge>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Exists" value={credential.exists ? "Yes" : "No"} />
          <DetailItem label="Status" value={formatStatus(credential.status)} />
          <DetailItem label="Auth type" value={credential.authType ?? "-"} />
          <DetailItem
            label="Key fingerprint"
            value={credential.keyFingerprint ?? "-"}
          />
          <DetailItem
            label="Verified at"
            value={formatDateTime(credential.verifiedAt)}
          />
          <DetailItem
            label="Last used"
            value={formatDateTime(credential.lastUsedAt)}
          />
          <DetailItem
            label="Last failed"
            value={formatDateTime(credential.lastFailedAt)}
          />
          <DetailItem
            label="Revoked at"
            value={formatDateTime(credential.revokedAt)}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function TradingAccountHealthCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useTradingAccountRiskHealth(account.id, token);
  const riskHealth = data?.riskHealth;

  function metricItems(health: TradingAccountRiskHealth) {
    return [
      {
        label: "Broker portfolio value",
        value: formatMoney(
          health.capital.brokerPortfolioValue,
          account.baseCurrency
        ),
      },
      {
        label: "Open position notional",
        value: formatMoney(
          health.capital.openPositionNotional,
          account.baseCurrency
        ),
      },
      {
        label: "Pending entry notional",
        value: formatMoney(
          health.capital.pendingEntryNotional,
          account.baseCurrency
        ),
      },
      {
        label: "Current account exposure",
        value: formatMoney(
          health.capital.currentAccountExposure,
          account.baseCurrency
        ),
      },
      {
        label: "Remaining deployable capacity",
        value: formatSurplus(
          health.capital.remainingDeployableNotional,
          account.baseCurrency
        ),
      },
      {
        label: "Allocation budget total",
        value: formatMoney(
          health.capital.allocationBudgetTotal,
          account.baseCurrency
        ),
      },
      {
        label: "Active subscription budget",
        value: formatMoney(
          health.capital.activeSubscriptionBudgetTotal,
          account.baseCurrency
        ),
      },
      {
        label: "Max simultaneous exposure",
        value: formatMoney(
          health.capital.maxSimultaneousAllocationExposure,
          account.baseCurrency
        ),
      },
      {
        label: "Allocation budget surplus",
        value: formatSurplus(
          health.capital.allocationBudgetSurplus,
          account.baseCurrency
        ),
      },
      {
        label: "Active subscription surplus",
        value: formatSurplus(
          health.capital.activeSubscriptionBudgetSurplus,
          account.baseCurrency
        ),
      },
      {
        label: "Max exposure surplus",
        value: formatSurplus(
          health.capital.maxSimultaneousExposureSurplus,
          account.baseCurrency
        ),
      },
    ];
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Entry Readiness</Title>
            <Text size="sm" c="dimmed">
              Read-only ownership, configuration, and projected exposure
              diagnostics. Pending entries consume capital and position capacity.
            </Text>
          </div>
          <Group gap="xs">
            {riskHealth && (
              <>
                <Badge
                  color={riskHealthStatusColor(riskHealth.status)}
                  variant="light"
                >
                  {riskHealthStatusLabel(riskHealth.status)}
                </Badge>
                <Badge color={environmentColor(riskHealth.profile)} variant="light">
                  {riskHealth.profile}
                </Badge>
              </>
            )}
            <Button
              size="xs"
              variant="default"
              onClick={() => void refetch()}
              loading={isFetching && !isLoading}
            >
              Refresh
            </Button>
          </Group>
        </Group>

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading entry readiness...
            </Text>
          </Group>
        )}

        {isError && (
          <Alert color="red" title="Failed to load entry readiness">
            {error instanceof Error ? error.message : "Unknown error."}
          </Alert>
        )}

        {!isLoading && !isError && !riskHealth && (
          <Alert color="yellow">Entry readiness is unavailable.</Alert>
        )}

        {riskHealth && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              <DetailItem
                label="Status"
                value={
                  <Badge color={riskHealthStatusColor(riskHealth.status)}>
                    {riskHealthStatusLabel(riskHealth.status)}
                  </Badge>
                }
              />
              <DetailItem
                label="Ready for entries"
                value={
                  <Badge color={riskHealth.readyForEntries ? "teal" : "red"}>
                    {riskHealth.readyForEntries ? "Yes" : "No"}
                  </Badge>
                }
              />
              <DetailItem label="Profile" value={riskHealth.profile} />
              <DetailItem
                label="Generated"
                value={formatDateTime(riskHealth.generatedAt)}
              />
              <DetailItem
                label="Broker sync"
                value={formatDateTime(riskHealth.capital.brokerPortfolioValueAt)}
              />
              <DetailItem
                label="Broker cash"
                value={formatMoney(
                  riskHealth.capital.brokerCash,
                  account.baseCurrency
                )}
              />
              <DetailItem
                label="Broker buying power"
                value={formatMoney(
                  riskHealth.capital.brokerBuyingPower,
                  account.baseCurrency
                )}
              />
              <DetailItem
                label="Capital source"
                value={formatStatus(riskHealth.capital.capitalSource)}
              />
            </SimpleGrid>

            {riskHealth.effectiveEntryLimits.usingLegacyGlobalFallback && (
              <Alert color="yellow" title="Routine limits use legacy fallback">
                Configure all four routine fields in Account Risk Controls to
                remove global fallback ownership for this account.
              </Alert>
            )}

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              {metricItems(riskHealth).map((item) => (
                <DetailItem
                  key={item.label}
                  label={item.label}
                  value={item.value}
                />
              ))}
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, lg: 3 }}>
              <HealthCheckList
                title="Blockers"
                checks={riskHealth.blockers}
                color="red"
              />
              <HealthCheckList
                title="Warnings"
                checks={riskHealth.warnings}
                color="yellow"
              />
              <HealthCheckList
                title="Info"
                checks={riskHealth.info.slice(0, 6)}
                color="blue"
              />
            </SimpleGrid>
          </>
        )}
      </Stack>
    </Card>
  );
}

function NotesCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <div>
          <Title order={3}>Safety Notes</Title>
          <Text size="sm" c="dimmed">
            Current paused reason and admin notes.
          </Text>
        </div>
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <DetailItem
              label="Paused reason"
              value={account.pausedReason || "-"}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <DetailItem label="Notes" value={account.notes || "-"} />
          </Grid.Col>
        </Grid>
      </Stack>
    </Card>
  );
}

function SizingAndAllocationsSection({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  return (
    <Stack gap="md">
      <div>
        <Title order={3}>Sizing & Allocations</Title>
        <Text size="sm" c="dimmed">
          Account-specific capital buckets used to group subscription budgets.
        </Text>
      </div>

      <Alert color="blue" title="Runtime sizing note">
        New entry orders now use account-specific sizing from
        TradingAccountSubscription. FIXED_QTY buys a fixed share quantity.
        MAX_NOTIONAL calculates a whole-share quantity from backend-owned latest
        market data. Allocation bucket limits are enforced for new entries
        assigned to that allocation.
      </Alert>

      <AllocationManagementCard account={account} token={token} />
    </Stack>
  );
}

function AccountSubscriptionsSection({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  return (
    <Stack gap="md">
      <Alert color="cyan" title="Market context note">
        Market context is used to preview share quantities and budget
        thresholds. Runtime entry sizing uses backend-owned market data when
        MAX_NOTIONAL sizing is selected. Allocation bucket limits are enforced
        for new entries assigned to that allocation.
      </Alert>

      <AccountSubscriptionsManagementCard account={account} token={token} />
    </Stack>
  );
}

function AllocationManagementCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [modalState, setModalState] = useState<AllocationModalState | null>(
    null
  );
  const { data, isLoading, isError, error } = useTradingAccountAllocations(
    account.id,
    token
  );
  const createMutation = useCreateTradingAccountAllocation(token);
  const updateMutation = useUpdateTradingAccountAllocation(token);
  const allocations = data?.allocations ?? [];
  const saving = createMutation.isPending || updateMutation.isPending;
  const candidateEnabledAllocatedNotional = modalState
    ? allocations.reduce(
        (total, allocation) =>
          total +
          (modalState.mode === "edit" && allocation.id === modalState.allocation.id
            ? 0
            : allocation.enabled
              ? allocation.maxAllocatedNotional ?? 0
              : 0),
        modalState.draft.enabled
          ? modalState.draft.maxAllocatedNotional ?? 0
          : 0
      )
    : account.enabledAllocatedNotional;
  const draftError = modalState
    ? validateAllocationDraft(modalState.draft) ??
      (account.maxDeployableNotional !== null &&
      candidateEnabledAllocatedNotional > account.maxDeployableNotional
        ? "Enabled allocation budgets would exceed account deployable capital."
        : null)
    : null;

  function startCreate() {
    setModalState({
      mode: "create",
      allocation: null,
      keyManuallyEdited: false,
      draft: emptyAllocationDraft,
    });
  }

  function startEdit(allocation: TradingAccountAllocation) {
    setModalState({
      mode: "edit",
      allocation,
      keyManuallyEdited: true,
      draft: allocationToDraft(allocation),
    });
  }

  function closeModal() {
    if (!saving) {
      setModalState(null);
    }
  }

  function updateDraft(next: Partial<AllocationDraft>) {
    setModalState((current) =>
      current
        ? {
            ...current,
            draft: {
              ...current.draft,
              ...next,
            },
          }
        : current
    );
  }

  function updateName(name: string) {
    setModalState((current) => {
      if (!current) return current;

      return {
        ...current,
        draft: {
          ...current.draft,
          name,
          key:
            current.mode === "create" && !current.keyManuallyEdited
              ? suggestAllocationKey(name)
              : current.draft.key,
        },
      };
    });
  }

  function updateKey(key: string) {
    setModalState((current) =>
      current
        ? {
            ...current,
            keyManuallyEdited: true,
            draft: {
              ...current.draft,
              key: key.toLowerCase(),
            },
          }
        : current
    );
  }

  async function saveAllocation() {
    if (!modalState) return;

    const validationError = validateAllocationDraft(modalState.draft);
    if (validationError) {
      notifications.show({
        message: validationError,
        color: "red",
      });
      return;
    }

    try {
      const payload = allocationDraftToPayload(modalState.draft);

      if (modalState.mode === "create") {
        await createMutation.mutateAsync({
          id: account.id,
          payload,
        });
        notifications.show({
          message: "Allocation created.",
          color: "teal",
        });
      } else {
        await updateMutation.mutateAsync({
          id: account.id,
          allocationId: modalState.allocation.id,
          payload,
        });
        notifications.show({
          message: "Allocation updated.",
          color: "teal",
        });
      }

      setModalState(null);
    } catch (error) {
      notifications.show({
        message: actionableErrorMessage(error, "Failed to save allocation."),
        color: "red",
      });
    }
  }

  return (
    <>
      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={4}>Allocation Buckets</Title>
              <Text size="sm" c="dimmed">
                Optional budgets and default limits for groups of account
                subscriptions.
              </Text>
            </div>
            <Button onClick={startCreate}>Create allocation</Button>
          </Group>

          {isError && (
            <Alert color="red" title="Failed to load allocations">
              {error instanceof Error ? error.message : "Unknown error."}
            </Alert>
          )}

          {isLoading && (
            <Group gap="sm">
              <Loader size="sm" color="cyan" />
              <Text size="sm" c="dimmed">
                Loading allocations...
              </Text>
            </Group>
          )}

          {!isLoading && !isError && allocations.length === 0 && (
            <Alert color="gray">
              No allocation buckets exist for this trading account yet.
            </Alert>
          )}

          {allocations.length > 0 && (
            <ScrollArea>
              <Table striped highlightOnHover style={{ minWidth: 980 }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Key</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Max allocated dollars
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Reserved / remaining
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Max open positions
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Default max position dollars
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Assigned subscriptions
                    </Table.Th>
                    <Table.Th>Updated</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {allocations.map((allocation) => (
                    <Table.Tr
                      key={allocation.id}
                      style={{ opacity: allocation.enabled ? 1 : 0.68 }}
                    >
                      <Table.Td>
                        <div>
                          <Text fw={600} size="sm">
                            {allocation.name}
                          </Text>
                          {allocation.description && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {allocation.description}
                            </Text>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace">
                          {allocation.key}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={allocation.enabled ? "teal" : "gray"}
                          variant="light"
                        >
                          {allocation.enabled ? "Active" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          allocation.maxAllocatedNotional,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        <Text size="sm">
                          {formatMoney(allocation.reservedNotional, account.baseCurrency)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatMoney(
                            allocation.remainingAllocatedNotional,
                            account.baseCurrency
                          )} remaining
                        </Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {allocation.maxOpenPositions ?? "-"}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          allocation.maxPositionNotional,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {allocation.entryEnabledSubscriptionCount} entry-enabled
                        <Text size="xs" c="dimmed">
                          {allocation.accountSubscriptionCount ?? 0} assigned total
                        </Text>
                      </Table.Td>
                      <Table.Td>{formatDateTime(allocation.updatedAt)}</Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => startEdit(allocation)}
                        >
                          Edit
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <Modal
        opened={modalState !== null}
        onClose={closeModal}
        title={
          modalState?.mode === "edit"
            ? `Edit allocation: ${modalState.allocation.name}`
            : "Create allocation"
        }
        size="lg"
        centered
      >
        {modalState && (
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Name"
                value={modalState.draft.name}
                onChange={(event) => updateName(event.currentTarget.value)}
                error={
                  modalState.draft.name.trim()
                    ? undefined
                    : "Name is required."
                }
                disabled={saving}
                required
              />

              <TextInput
                label="Key"
                description="Lowercase letters, numbers, hyphens, and underscores."
                value={modalState.draft.key}
                onChange={(event) => updateKey(event.currentTarget.value)}
                error={
                  modalState.draft.key.trim() &&
                  /^[a-z0-9_-]+$/.test(modalState.draft.key.trim())
                    ? undefined
                    : "Use lowercase letters, numbers, hyphens, or underscores."
                }
                disabled={saving}
                required
              />
            </SimpleGrid>

            <Textarea
              label="Description"
              value={modalState.draft.description}
              onChange={(event) =>
                updateDraft({ description: event.currentTarget.value })
              }
              autosize
              minRows={2}
              disabled={saving}
            />

            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Enabled
                </Text>
                <Text size="sm" c="dimmed">
                  Disabled allocations remain visible and can stay assigned, but
                  should not be used for new planning.
                </Text>
              </div>
              <Switch
                checked={modalState.draft.enabled}
                onChange={(event) =>
                  updateDraft({ enabled: event.currentTarget.checked })
                }
                color="teal"
                disabled={saving}
              />
            </Group>

            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <NumberInput
                label="Max allocated dollars"
                value={modalState.draft.maxAllocatedNotional ?? ""}
                onChange={(value) =>
                  updateDraft({
                    maxAllocatedNotional: normalizeNumberInput(value),
                  })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  modalState.draft.maxAllocatedNotional === null ||
                  modalState.draft.maxAllocatedNotional > 0
                    ? undefined
                    : "Must be greater than zero."
                }
                disabled={saving}
              />

              <NumberInput
                label="Max open positions"
                value={modalState.draft.maxOpenPositions ?? ""}
                onChange={(value) =>
                  updateDraft({
                    maxOpenPositions: normalizeNumberInput(value),
                  })
                }
                min={1}
                allowDecimal={false}
                error={
                  modalState.draft.maxOpenPositions === null ||
                  (Number.isInteger(modalState.draft.maxOpenPositions) &&
                    modalState.draft.maxOpenPositions > 0)
                    ? undefined
                    : "Must be a positive whole number."
                }
                disabled={saving}
              />

              <NumberInput
                label="Default max position dollars"
                value={modalState.draft.maxPositionNotional ?? ""}
                onChange={(value) =>
                  updateDraft({
                    maxPositionNotional: normalizeNumberInput(value),
                  })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  modalState.draft.maxPositionNotional === null ||
                  modalState.draft.maxPositionNotional > 0
                    ? undefined
                    : "Must be greater than zero."
                }
                disabled={saving}
              />
            </SimpleGrid>

            <Alert color={draftError ? "yellow" : "blue"} title="Resulting capacity">
              Account enabled allocation total: {formatMoney(
                candidateEnabledAllocatedNotional,
                account.baseCurrency
              )} of {formatMoney(account.maxDeployableNotional, account.baseCurrency)}.
              {modalState.mode === "edit" && (
                <> This allocation currently reserves {formatMoney(
                  modalState.allocation.reservedNotional,
                  account.baseCurrency
                )}; resulting remaining allocation capacity is {formatMoney(
                  modalState.draft.maxAllocatedNotional === null
                    ? null
                    : modalState.draft.maxAllocatedNotional -
                        modalState.allocation.reservedNotional,
                  account.baseCurrency
                )}.</>
              )}
            </Alert>

            <Textarea
              label="Notes"
              value={modalState.draft.notes}
              onChange={(event) =>
                updateDraft({ notes: event.currentTarget.value })
              }
              autosize
              minRows={3}
              disabled={saving}
            />

            <Group justify="flex-end">
              <Button variant="default" onClick={closeModal} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={saveAllocation}
                loading={saving}
                disabled={draftError !== null}
              >
                Save allocation
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function EntryRiskPreviewModal({
  currency,
  onClose,
  preview,
}: {
  currency: string;
  onClose: () => void;
  preview: EntryRiskPreview | null;
}) {
  const allowed = preview?.ok ?? false;
  const blockingLayer =
    preview?.blockingLayer ??
    preview?.risk.layer ??
    (preview && !preview.allocationRisk.ok ? preview.allocationRisk.layer : null);
  const blockingCode =
    preview?.blockingCode ??
    preview?.risk.code ??
    (preview && !preview.allocationRisk.ok ? preview.allocationRisk.code : null);
  const blockingMessage =
    preview?.risk.message ??
    (preview && !preview.allocationRisk.ok
      ? preview.allocationRisk.message
      : null) ??
    preview?.sizing.message;

  return (
    <Modal
      opened={preview !== null}
      onClose={onClose}
      title={
        preview
          ? `Entry risk preview: ${preview.subscription.symbol} / ${preview.subscription.key}`
          : "Entry risk preview"
      }
      size="lg"
      centered
    >
      {preview && (
        <Stack gap="md">
          <Alert
            color={allowed ? "teal" : "red"}
            title={allowed ? "Allowed" : "Blocked"}
          >
            {allowed
              ? "Sizing and risk checks allow this entry when session timing is ignored."
              : blockingMessage ??
                "A sizing, risk, or allocation layer blocked this preview."}
          </Alert>

          <Alert color="blue" title="Dry run only">
            No order intent will be created and no broker order will be
            submitted.
          </Alert>

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <PreviewMetric
              label="Blocking layer"
              value={previewLayerLabel(blockingLayer)}
            />
            <PreviewMetric label="Block code" value={blockingCode ?? "-"} />
            <PreviewMetric
              label="Calculated quantity"
              value={formatQuantity(preview.sizing.calculatedQty)}
            />
            <PreviewMetric
              label="Estimated notional"
              value={formatMoney(preview.sizing.estimatedNotional, currency)}
            />
            <PreviewMetric
              label="Latest price"
              value={formatMoney(preview.sizing.latestPrice, currency)}
            />
            <PreviewMetric
              label="Latest price source"
              value={preview.sizing.latestPriceSource ?? "-"}
            />
            <PreviewMetric
              label="Latest price time"
              value={formatDateTime(preview.sizing.latestPriceAt)}
            />
            <PreviewMetric
              label="Sizing type"
              value={
                preview.sizing.sizingType
                  ? sizingTypeLabel(preview.sizing.sizingType)
                  : "-"
              }
            />
          </SimpleGrid>

          {preview.accountUsage && (
            <>
              <Text fw={600}>Account exposure</Text>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
                <PreviewMetric
                  label="Open exposure"
                  value={formatMoney(
                    preview.accountUsage.openPositionNotional,
                    currency
                  )}
                />
                <PreviewMetric
                  label="Pending entry exposure"
                  value={formatMoney(
                    preview.accountUsage.pendingEntryNotional,
                    currency
                  )}
                />
                <PreviewMetric
                  label="Current account exposure"
                  value={formatMoney(
                    preview.accountUsage.currentAccountExposure,
                    currency
                  )}
                />
                <PreviewMetric
                  label="Projected account exposure"
                  value={formatMoney(
                    preview.accountUsage.projectedAccountExposure,
                    currency
                  )}
                />
              </SimpleGrid>
            </>
          )}

          {preview.effectiveEntryLimits && (
            <>
              <Text fw={600}>Effective account limits</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                {Object.entries(preview.effectiveEntryLimits.limits).map(
                  ([field, limit]) => (
                    <PreviewMetric
                      key={field}
                      label={`${formatStatus(field)} (${limit.source === "ACCOUNT" ? "Account" : "Legacy fallback"})`}
                      value={
                        field === "maxDailyEntryOrders" || field === "maxOpenPositions"
                          ? formatQuantity(limit.value)
                          : formatMoney(limit.value, currency)
                      }
                    />
                  )
                )}
                <PreviewMetric
                  label="Max deployable notional (Trading Account)"
                  value={formatMoney(
                    preview.effectiveEntryLimits.authoritativeTotalExposure.value,
                    currency
                  )}
                />
              </SimpleGrid>
            </>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <PreviewMetric
              label="Account subscription"
              value={
                preview.accountSubscription
                  ? preview.accountSubscription.enabled
                    ? "Active"
                    : "Disabled"
                  : "Missing"
              }
            />
            <PreviewMetric
              label="Entries"
              value={
                preview.accountSubscription
                  ? preview.accountSubscription.entriesEnabled
                    ? "Enabled"
                    : "Disabled"
                  : "-"
              }
            />
            <PreviewMetric
              label="Allocation"
              value={preview.allocation ? preview.allocation.name : "Unassigned"}
            />
            <PreviewMetric
              label="Allocation status"
              value={
                preview.allocation
                  ? preview.allocation.enabled
                    ? "Enabled"
                    : "Disabled"
                  : "-"
              }
            />
            <PreviewMetric
              label="Allocation risk"
              value={
                preview.allocationRisk.checked
                  ? preview.allocationRisk.ok
                    ? "Pass"
                    : "Blocked"
                  : "Not assigned"
              }
            />
            <PreviewMetric
              label="Allocation block code"
              value={preview.allocationRisk.code ?? "-"}
            />
            <PreviewMetric
              label="Max allocated notional"
              value={formatMoney(
                preview.allocation?.maxAllocatedNotional,
                currency
              )}
            />
            <PreviewMetric
              label="Max position notional"
              value={formatMoney(
                preview.allocation?.maxPositionNotional,
                currency
              )}
            />
            <PreviewMetric
              label="Max open positions"
              value={formatQuantity(preview.allocation?.maxOpenPositions)}
            />
          </SimpleGrid>

          {preview.allocationRisk.checked && !preview.allocationRisk.ok && (
            <Alert color="red" title="Parent allocation would block">
              {preview.allocationRisk.message ??
                "An allocation-level rule would block this entry."}
            </Alert>
          )}

          <Alert
            color={preview.session.wouldBlockRealEntryNow ? "yellow" : "gray"}
            title="Session context"
          >
            {previewSessionLabel(preview.session)}
          </Alert>

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function AccountSubscriptionsManagementCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [editing, setEditing] = useState<TradingAccountSubscription | null>(
    null
  );
  const [draft, setDraft] = useState<AccountSubscriptionDraft | null>(null);
  const [preview, setPreview] = useState<EntryRiskPreview | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<AccountSubscriptionStatusFilter>("active");
  const [sizingFilter, setSizingFilter] =
    useState<AccountSubscriptionSizingFilter>("all");
  const [allocationFilter, setAllocationFilter] = useState("all");
  const [priceHistoryRange, setPriceHistoryRange] =
    useState<AccountSubscriptionPriceHistoryRange>("1y");
  const { data, isLoading, isError, error } = useTradingAccountSubscriptions(
    account.id,
    token
  );
  const { data: allocationData } = useTradingAccountAllocations(
    account.id,
    token
  );
  const {
    data: marketContextData,
    isLoading: marketContextLoading,
    isError: marketContextIsError,
    error: marketContextError,
  } = useTradingAccountSubscriptionMarketContext(
    account.id,
    token,
    statusFilter
  );
  const {
    data: priceHistoryData,
    isLoading: priceHistoryLoading,
    isError: priceHistoryIsError,
  } = useTradingAccountSubscriptionPriceHistory(
    account.id,
    editing?.id,
    token,
    priceHistoryRange
  );
  const updateMutation = useUpdateTradingAccountSubscription(token);
  const previewMutation = usePreviewTradingAccountEntryRisk(token);
  const accountSubscriptions = data?.accountSubscriptions ?? [];
  const allocations = allocationData?.allocations ?? [];
  const marketContextByAccountSubscriptionId = new Map(
    (marketContextData?.items ?? []).map((item) => [
      item.accountSubscriptionId,
      item,
    ])
  );
  const draftError = draft
    ? validateAccountSubscriptionDraft(draft, allocations, editing)
    : null;
  const selectedDraftAllocation = allocations.find(
    (allocation) => allocation.id === draft?.allocationId
  );
  const invalidHierarchyCount = accountSubscriptions.filter(
    accountSubscriptionHierarchyWarning
  ).length;
  const filteredAccountSubscriptions = accountSubscriptions.filter(
    (accountSubscription) => {
      if (!accountSubscriptionMatchesSearch(accountSubscription, search)) {
        return false;
      }

      if (
        statusFilter === "active" &&
        !accountSubscription.enabled
      ) {
        return false;
      }

      if (
        statusFilter === "disabled" &&
        accountSubscription.enabled
      ) {
        return false;
      }

      if (
        sizingFilter !== "all" &&
        accountSubscription.sizingType !== sizingFilter
      ) {
        return false;
      }

      if (
        allocationFilter === "unassigned" &&
        accountSubscription.allocationId !== null
      ) {
        return false;
      }

      if (
        allocationFilter !== "all" &&
        allocationFilter !== "unassigned" &&
        accountSubscription.allocationId !== Number(allocationFilter)
      ) {
        return false;
      }

      return true;
    }
  );

  function startEdit(accountSubscription: TradingAccountSubscription) {
    setEditing(accountSubscription);
    setDraft(accountSubscriptionToDraft(accountSubscription));
    setPriceHistoryRange("1y");
  }

  function closeModal() {
    if (!updateMutation.isPending) {
      setEditing(null);
      setDraft(null);
    }
  }

  function updateDraft(next: Partial<AccountSubscriptionDraft>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            ...next,
          }
        : current
    );
  }

  function updateSizingType(sizingType: PositionSizingType) {
    setDraft((current) => {
      if (!current) return current;

      return {
        ...current,
        sizingType,
        fixedQty: sizingType === "FIXED_QTY" ? (current.fixedQty ?? 1) : null,
        maxPositionNotional:
          sizingType === "MAX_NOTIONAL"
            ? current.maxPositionNotional
            : null,
      };
    });
  }

  async function saveAccountSubscription() {
    if (!editing || !draft) return;

    const validationError = validateAccountSubscriptionDraft(
      draft,
      allocations,
      editing
    );
    if (validationError) {
      notifications.show({
        message: validationError,
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: account.id,
        accountSubscriptionId: editing.id,
        payload: accountSubscriptionDraftToPayload(draft),
      });

      notifications.show({
        message: "Account subscription settings saved.",
        color: "teal",
      });
      closeModal();
    } catch (error) {
      notifications.show({
        message: actionableErrorMessage(
          error,
          "Failed to save account subscription settings."
        ),
        color: "red",
      });
    }
  }

  async function previewEntryRisk(
    accountSubscription: TradingAccountSubscription
  ) {
    try {
      const result = await previewMutation.mutateAsync({
        id: account.id,
        payload: {
          subscriptionKey: accountSubscription.subscription.key,
        },
      });

      setPreview(result.preview);
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to preview entry risk.",
        color: "red",
      });
    }
  }

  return (
    <>
      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={4}>Account Subscriptions</Title>
              <Text size="sm" c="dimmed">
                Account-specific subscription activation, allocation assignment,
                and sizing configuration.
              </Text>
            </div>
            <Badge color="blue" variant="light">
              {filteredAccountSubscriptions.length.toLocaleString()} of{" "}
              {accountSubscriptions.length.toLocaleString()} subscriptions
            </Badge>
          </Group>

          {accountSubscriptions.length > 0 && (
            <SimpleGrid cols={{ base: 1, md: 4 }}>
              <TextInput
                label="Search"
                placeholder="Symbol, subscription, strategy, exit profile"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />

              <Select
                label="Status"
                value={statusFilter}
                onChange={(value) =>
                  setStatusFilter(
                    (value ?? "all") as AccountSubscriptionStatusFilter
                  )
                }
                data={[
                  { value: "all", label: "All statuses" },
                  { value: "active", label: "Active" },
                  { value: "disabled", label: "Disabled" },
                ]}
              />

              <Select
                label="Sizing"
                value={sizingFilter}
                onChange={(value) =>
                  setSizingFilter(
                    (value ?? "all") as AccountSubscriptionSizingFilter
                  )
                }
                data={[
                  { value: "all", label: "All sizing types" },
                  { value: "FIXED_QTY", label: "Fixed share quantity" },
                  { value: "MAX_NOTIONAL", label: "Max position dollars" },
                ]}
              />

              <Select
                label="Allocation"
                value={allocationFilter}
                onChange={(value) => setAllocationFilter(value ?? "all")}
                data={[
                  { value: "all", label: "All allocations" },
                  { value: "unassigned", label: "Unassigned" },
                  ...allocations.map((allocation) => ({
                    value: String(allocation.id),
                    label: `${allocation.name} (${allocation.key})${
                      allocation.enabled ? "" : " - disabled"
                    }`,
                  })),
                ]}
              />
            </SimpleGrid>
          )}

          {invalidHierarchyCount > 0 && (
            <Alert color="yellow" title="Legacy configuration needs attention">
              {invalidHierarchyCount} active account subscription
              {invalidHierarchyCount === 1 ? " has" : "s have"} incomplete or
              invalid capital hierarchy settings. These rows remain visible and
              editable, but new entries are blocked until corrected.
            </Alert>
          )}

          {isError && (
            <Alert color="red" title="Failed to load account subscriptions">
              {error instanceof Error ? error.message : "Unknown error."}
            </Alert>
          )}

          {marketContextIsError && (
            <Alert color="yellow" title="Failed to load market context">
              {marketContextError instanceof Error
                ? marketContextError.message
                : "Price context is unavailable."}
            </Alert>
          )}

          {isLoading && (
            <Group gap="sm">
              <Loader size="sm" color="cyan" />
              <Text size="sm" c="dimmed">
                Loading account subscriptions...
              </Text>
            </Group>
          )}

          {!isLoading && !isError && accountSubscriptions.length === 0 && (
            <Alert color="gray">
              No account subscriptions exist for this trading account yet.
            </Alert>
          )}

          {!isLoading &&
            !isError &&
            accountSubscriptions.length > 0 &&
            filteredAccountSubscriptions.length === 0 && (
              <Alert color="gray">
                No account subscriptions match the current filters.
              </Alert>
            )}

          {filteredAccountSubscriptions.length > 0 && (
            <ScrollArea>
              <Table striped highlightOnHover style={{ minWidth: 1460 }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Symbol</Table.Th>
                    <Table.Th>Subscription</Table.Th>
                    <Table.Th>Strategy</Table.Th>
                    <Table.Th>Exit profile</Table.Th>
                    <Table.Th>Allocation</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Entries</Table.Th>
                    <Table.Th>Exits</Table.Th>
                    <Table.Th>Sizing</Table.Th>
                    <Table.Th>Reserved capital</Table.Th>
                    <Table.Th>Market context</Table.Th>
                    <Table.Th>Limits</Table.Th>
                    <Table.Th>Updated</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {filteredAccountSubscriptions.map((accountSubscription) => (
                    <Table.Tr
                      key={accountSubscription.id}
                      style={{
                        opacity: accountSubscription.enabled ? 1 : 0.68,
                      }}
                    >
                      <Table.Td>
                        <Text fw={700} size="sm">
                          {accountSubscription.subscription.symbol}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <div>
                          <Text size="sm" ff="monospace">
                            {accountSubscription.subscription.key}
                          </Text>
                          {!accountSubscription.subscription.enabled && (
                            <Badge color="gray" variant="light" size="xs">
                              Legacy disabled
                            </Badge>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        {accountSubscription.subscription.strategy ? (
                          <div>
                            <Text size="sm">
                              {accountSubscription.subscription.strategy.name}
                            </Text>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {accountSubscription.subscription.strategy.key}
                            </Text>
                          </div>
                        ) : (
                          "-"
                        )}
                      </Table.Td>
                      <Table.Td>
                        {accountSubscription.subscription.exitProfile ? (
                          <div>
                            <Text size="sm">
                              {accountSubscription.subscription.exitProfile.name}
                            </Text>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {accountSubscription.subscription.exitProfile.key}
                            </Text>
                          </div>
                        ) : (
                          "-"
                        )}
                      </Table.Td>
                      <Table.Td>
                        {accountSubscription.allocation ? (
                          <Stack gap={2}>
                            <Group gap="xs">
                              <Text size="sm">
                                {accountSubscription.allocation.name}
                              </Text>
                              {!accountSubscription.allocation.enabled && (
                                <Badge color="gray" variant="light" size="xs">
                                  Disabled
                                </Badge>
                              )}
                            </Group>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {accountSubscription.allocation.key}
                            </Text>
                          </Stack>
                        ) : (
                          <Text size="sm" c="dimmed">
                            Unassigned
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={accountSubscription.enabled ? "teal" : "gray"}
                          variant="light"
                        >
                          {accountSubscription.enabled ? "Active" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={
                            accountSubscription.entriesEnabled ? "teal" : "gray"
                          }
                          variant="light"
                        >
                          {accountSubscription.entriesEnabled
                            ? "Entries on"
                            : "Entries off"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={
                            accountSubscription.exitsEnabled ? "teal" : "gray"
                          }
                          variant="light"
                        >
                          {accountSubscription.exitsEnabled
                            ? "Exits on"
                            : "Exits off"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={2}>
                          <Badge color="blue" variant="light" size="xs">
                            {sizingTypeLabel(accountSubscription.sizingType)}
                          </Badge>
                          <Text size="sm">
                            {formatSizing(
                              accountSubscription,
                              account.baseCurrency
                            )}
                          </Text>
                          {accountSubscriptionHierarchyWarning(accountSubscription) && (
                            <Badge color="yellow" variant="light" size="xs">
                              Needs correction
                            </Badge>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {formatMoney(
                            accountSubscription.reservedNotional,
                            account.baseCurrency
                          )}
                        </Text>
                        {accountSubscriptionHierarchyWarning(accountSubscription) && (
                          <Text size="xs" c="orange">
                            {accountSubscriptionHierarchyWarning(accountSubscription)}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td style={{ minWidth: 230 }}>
                        <MarketContextCell
                          context={marketContextByAccountSubscriptionId.get(
                            accountSubscription.id
                          )}
                          currency={account.baseCurrency}
                          loading={marketContextLoading}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {formatLimits(
                            accountSubscription,
                            account.baseCurrency
                          )}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {formatDateTime(accountSubscription.updatedAt)}
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Button
                            size="xs"
                            variant="default"
                            loading={
                              previewMutation.isPending &&
                              previewMutation.variables?.payload
                                .subscriptionKey ===
                                accountSubscription.subscription.key
                            }
                            onClick={() => previewEntryRisk(accountSubscription)}
                          >
                            Preview risk
                          </Button>
                          <Button
                            size="xs"
                            variant="subtle"
                            onClick={() => startEdit(accountSubscription)}
                          >
                            Edit
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <EntryRiskPreviewModal
        currency={account.baseCurrency}
        preview={preview}
        onClose={() => setPreview(null)}
      />

      <Modal
        opened={editing !== null && draft !== null}
        onClose={closeModal}
        title={
          editing
            ? `Edit settings: ${editing.subscription.symbol} / ${editing.subscription.key}`
            : "Edit account subscription"
        }
        size="lg"
        centered
      >
        {editing && draft && (
          <Stack gap="md">
            <Select
              label="Allocation"
              value={draft.allocationId === null ? "none" : String(draft.allocationId)}
              onChange={(value) =>
                updateDraft({
                  allocationId:
                    !value || value === "none" ? null : Number(value),
                })
              }
              data={[
                { value: "none", label: "Unassigned" },
                ...allocations.map((allocation) => ({
                  value: String(allocation.id),
                  label: `${allocation.name} (${allocation.key})${
                    allocation.enabled ? "" : " - disabled"
                  }`,
                })),
              ]}
              disabled={updateMutation.isPending}
              required={draft.enabled && draft.entriesEnabled}
              error={
                draft.enabled && draft.entriesEnabled && draft.allocationId === null
                  ? "Allocation is required for new entries."
                  : undefined
              }
            />

            {selectedDraftAllocation && (
              <Alert
                color={selectedDraftAllocation.enabled ? "blue" : "yellow"}
                title="Selected allocation capacity"
              >
                Budget {formatMoney(
                  selectedDraftAllocation.maxAllocatedNotional,
                  account.baseCurrency
                )}; reserved {formatMoney(
                  selectedDraftAllocation.reservedNotional,
                  account.baseCurrency
                )}; remaining {formatMoney(
                  selectedDraftAllocation.remainingAllocatedNotional,
                  account.baseCurrency
                )}; per-position ceiling {formatMoney(
                  selectedDraftAllocation.maxPositionNotional,
                  account.baseCurrency
                )}; max open positions {formatQuantity(
                  selectedDraftAllocation.maxOpenPositions
                )}.
              </Alert>
            )}

            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">
                    Active
                  </Text>
                  <Text size="sm" c="dimmed">
                    Controls whether this account uses this subscription at all.
                  </Text>
                </div>
                <Switch
                  checked={draft.enabled}
                  onChange={(event) =>
                    updateDraft({ enabled: event.currentTarget.checked })
                  }
                  color="teal"
                  disabled={updateMutation.isPending}
                />
              </Group>

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">
                    Allow new entries
                  </Text>
                  <Text size="sm" c="dimmed">
                    Allows this subscription to open new positions.
                  </Text>
                </div>
                <Switch
                  checked={draft.entriesEnabled}
                  onChange={(event) =>
                    updateDraft({ entriesEnabled: event.currentTarget.checked })
                  }
                  color="teal"
                  disabled={updateMutation.isPending}
                />
              </Group>

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">
                    Allow exit management
                  </Text>
                  <Text size="sm" c="dimmed">
                    Allows this subscription to manage or close positions that
                    already exist.
                  </Text>
                </div>
                <Switch
                  checked={draft.exitsEnabled}
                  onChange={(event) =>
                    updateDraft({ exitsEnabled: event.currentTarget.checked })
                  }
                  color="teal"
                  disabled={updateMutation.isPending}
                />
              </Group>
            </SimpleGrid>

            <Select
              label="Sizing type"
              value={draft.sizingType}
              onChange={(value) => {
                if (value === "FIXED_QTY" || value === "MAX_NOTIONAL") {
                  updateSizingType(value);
                }
              }}
              data={[
                { value: "FIXED_QTY", label: "Fixed share quantity" },
                { value: "MAX_NOTIONAL", label: "Max position dollars" },
              ]}
              disabled={updateMutation.isPending}
            />

            {draft.sizingType === "FIXED_QTY" ? (
              <Alert color="blue">
                Fixed quantity is required. Max position dollars will be cleared
                when this sizing type is saved.
              </Alert>
            ) : (
              <Alert color="blue">
                Max position dollars is required. Fixed quantity will be cleared
                when this sizing type is saved.
              </Alert>
            )}

            <MarketContextPanel
              context={marketContextByAccountSubscriptionId.get(editing.id)}
              currency={account.baseCurrency}
              draft={draft}
              loading={marketContextLoading}
            />

            <PriceHistoryChart
              currency={account.baseCurrency}
              data={priceHistoryData}
              isError={priceHistoryIsError}
              isLoading={priceHistoryLoading}
              range={priceHistoryRange}
              onRangeChange={setPriceHistoryRange}
            />

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput
                label="Reserved capital"
                description="Capital reserved inside the allocation; separate from MAX_NOTIONAL sizing."
                value={draft.reservedNotional ?? ""}
                onChange={(value) =>
                  updateDraft({ reservedNotional: normalizeNumberInput(value) })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  draft.enabled && draft.entriesEnabled &&
                  (draft.reservedNotional === null || draft.reservedNotional <= 0)
                    ? "Reserved capital is required for new entries."
                    : undefined
                }
                disabled={updateMutation.isPending}
                required={draft.enabled && draft.entriesEnabled}
              />

              {draft.sizingType === "FIXED_QTY" ? (
                <NumberInput
                  label="Fixed quantity"
                  value={draft.fixedQty ?? ""}
                  onChange={(value) =>
                    updateDraft({ fixedQty: normalizeNumberInput(value) })
                  }
                  min={0}
                  thousandSeparator=","
                  error={
                    draft.fixedQty !== null && draft.fixedQty > 0
                      ? undefined
                      : "Fixed quantity is required."
                  }
                  disabled={updateMutation.isPending}
                  required
                />
              ) : (
                <NumberInput
                  label="Max position dollars"
                  value={draft.maxPositionNotional ?? ""}
                  onChange={(value) =>
                    updateDraft({
                      maxPositionNotional: normalizeNumberInput(value),
                    })
                  }
                  min={0}
                  thousandSeparator=","
                  prefix="$"
                  error={
                    draft.maxPositionNotional !== null &&
                    draft.maxPositionNotional > 0
                      ? undefined
                      : "Max position dollars is required."
                  }
                  disabled={updateMutation.isPending}
                  required
                />
              )}

              <NumberInput
                label="Min position dollars"
                value={draft.minPositionNotional ?? ""}
                onChange={(value) =>
                  updateDraft({
                    minPositionNotional: normalizeNumberInput(value),
                  })
                }
                min={0}
                thousandSeparator=","
                prefix="$"
                error={
                  draft.minPositionNotional === null ||
                  draft.minPositionNotional >= 0
                    ? undefined
                    : "Must be zero or greater."
                }
                disabled={updateMutation.isPending}
              />

              <NumberInput
                label="Max quantity"
                value={draft.maxQty ?? ""}
                onChange={(value) =>
                  updateDraft({ maxQty: normalizeNumberInput(value) })
                }
                min={0}
                thousandSeparator=","
                error={
                  draft.maxQty === null || draft.maxQty > 0
                    ? undefined
                    : "Must be greater than zero."
                }
                disabled={updateMutation.isPending}
              />
            </SimpleGrid>

            <Textarea
              label="Notes"
              value={draft.notes}
              onChange={(event) =>
                updateDraft({ notes: event.currentTarget.value })
              }
              autosize
              minRows={3}
              disabled={updateMutation.isPending}
            />

            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={closeModal}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={saveAccountSubscription}
                loading={updateMutation.isPending}
                disabled={draftError !== null}
              >
                Save settings
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function SafetySettingsCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [draft, setDraft] = useState<AccountSettingsDraft>(() =>
    accountToSettingsDraft(account)
  );
  const updateMutation = useUpdateTradingAccount(token);
  const hasChanges = settingsDraftChanged(account, draft);
  const displayNameValid = draft.displayName.trim().length > 0;
  const capitalValid =
    draft.estimatedTradingCapital === null || draft.estimatedTradingCapital >= 0;
  const deployableCapitalValid =
    draft.maxDeployableNotional !== null
      ? draft.maxDeployableNotional > 0
      : account.enabledAllocatedNotional === 0;

  function resetDraft() {
    setDraft(accountToSettingsDraft(account));
  }

  async function saveSettings() {
    if (!displayNameValid) {
      notifications.show({
        message: "Display name is required.",
        color: "red",
      });
      return;
    }

    if (!capitalValid) {
      notifications.show({
        message: "Estimated trading capital must be zero or greater.",
        color: "red",
      });
      return;
    }
    if (!deployableCapitalValid) {
      notifications.show({
        message: "Max deployable notional must be empty or greater than zero.",
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: account.id,
        payload: {
          displayName: draft.displayName.trim(),
          estimatedTradingCapital: draft.estimatedTradingCapital,
          maxDeployableNotional: draft.maxDeployableNotional,
          status: draft.status,
          tradingEnabled: draft.tradingEnabled,
          killSwitchEnabled: draft.killSwitchEnabled,
          pausedReason: normalizeOptionalText(draft.pausedReason),
          notes: normalizeOptionalText(draft.notes),
        },
      });

      notifications.show({
        message: "Trading account settings saved.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message: actionableErrorMessage(
          error,
          "Failed to save trading account settings."
        ),
        color: "red",
      });
    }
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs">
              <Title order={3}>Safety / Status Controls</Title>
              {hasChanges && (
                <Badge color="blue" variant="light">
                  Unsaved changes
                </Badge>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              Save-gated account settings. Broker identity and broker metadata
              are read-only.
            </Text>
          </div>
          <Group>
            <Button
              variant="default"
              onClick={resetDraft}
              disabled={!hasChanges || updateMutation.isPending}
            >
              Reset
            </Button>
            <Button
              onClick={saveSettings}
              loading={updateMutation.isPending}
              disabled={
                !hasChanges ||
                !displayNameValid ||
                !capitalValid ||
                !deployableCapitalValid
              }
            >
              Save Settings
            </Button>
          </Group>
        </Group>

        {account.environment === "LIVE" && draft.tradingEnabled && (
          <Alert color="red" title="Live trading enablement">
            This would mark a live account as trading-enabled. Credential
            verification does not turn this on automatically.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <TextInput
            label="Display name"
            value={draft.displayName}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                displayName: value,
              }));
            }}
            error={displayNameValid ? undefined : "Display name is required."}
            disabled={updateMutation.isPending}
          />

          <NumberInput
            label="Estimated trading capital"
            value={draft.estimatedTradingCapital ?? ""}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                estimatedTradingCapital: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={capitalValid ? undefined : "Must be zero or greater."}
            disabled={updateMutation.isPending}
          />

          <NumberInput
            label="Max deployable notional"
            description="Authoritative ceiling for enabled allocation budgets."
            value={draft.maxDeployableNotional ?? ""}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                maxDeployableNotional: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={deployableCapitalValid ? undefined : "Must be greater than zero."}
            disabled={updateMutation.isPending}
          />

          <Alert
            color={
              account.remainingDeployableNotional !== null &&
              account.remainingDeployableNotional < 0
                ? "red"
                : "blue"
            }
            title="Allocation capacity"
          >
            Enabled allocation budgets: {formatMoney(
              account.enabledAllocatedNotional,
              account.baseCurrency
            )}. Remaining deployable capacity: {formatMoney(
              account.remainingDeployableNotional,
              account.baseCurrency
            )}.
          </Alert>

          <Select
            label="Status"
            data={tradingAccountStatusOptions}
            value={draft.status}
            onChange={(value) => {
              if (!value) return;

              setDraft((current) => ({
                ...current,
                status: value as TradingAccountStatus,
              }));
            }}
            disabled={updateMutation.isPending}
          />

          <Stack gap="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Automated trading
                </Text>
                <Text size="sm" c="dimmed">
                  Account-level master switch for broker-facing automation.
                </Text>
              </div>
              <Switch
                checked={draft.tradingEnabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;

                  setDraft((current) => ({
                    ...current,
                    tradingEnabled: checked,
                  }));
                }}
                disabled={updateMutation.isPending}
                color="teal"
              />
            </Group>

            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Kill switch
                </Text>
                <Text size="sm" c="dimmed">
                  Blocks new account-scoped broker access when enabled.
                </Text>
              </div>
              <Switch
                checked={draft.killSwitchEnabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;

                  setDraft((current) => ({
                    ...current,
                    killSwitchEnabled: checked,
                  }));
                }}
                disabled={updateMutation.isPending}
                color="orange"
              />
            </Group>
          </Stack>

          <Textarea
            label="Paused reason"
            value={draft.pausedReason}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                pausedReason: value,
              }));
            }}
            autosize
            minRows={3}
            disabled={updateMutation.isPending}
          />

          <Textarea
            label="Notes"
            value={draft.notes}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                notes: value,
              }));
            }}
            autosize
            minRows={3}
            disabled={updateMutation.isPending}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function AccountRiskControlsForm({
  account,
  riskSettings,
  token,
}: {
  account: TradingAccount;
  riskSettings: TradingAccountRiskSettings;
  token: string | null;
}) {
  const [draft, setDraft] = useState<AccountRiskSettingsDraft>(() =>
    riskSettingsToDraft(riskSettings)
  );
  const updateMutation = useUpdateTradingAccountRiskSettings(token);
  const hasChanges = riskSettingsDraftChanged(riskSettings, draft);
  const draftError = validateAccountRiskSettingsDraft(draft);

  function resetDraft() {
    setDraft(riskSettingsToDraft(riskSettings));
  }

  async function saveRiskSettings() {
    if (draftError) {
      notifications.show({
        message: draftError,
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: account.id,
        payload: riskSettingsDraftToPayload(draft),
      });

      notifications.show({
        message: "Account risk controls saved.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to save account risk controls.",
        color: "red",
      });
    }
  }

  function updateDraft(patch: Partial<AccountRiskSettingsDraft>) {
    setDraft((current) => ({
      ...current,
      ...patch,
    }));
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Title order={3}>Account Risk Controls</Title>
            {hasChanges && (
              <Badge color="blue" variant="light">
                Unsaved changes
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            These are the primary routine entry limits for this Trading Account.
            A blank field temporarily uses the matching legacy global fallback.
            Allocation and account-subscription controls remain enforced beneath
            this account layer.
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            onClick={resetDraft}
            disabled={!hasChanges || updateMutation.isPending}
          >
            Reset
          </Button>
          <Button
            onClick={saveRiskSettings}
            loading={updateMutation.isPending}
            disabled={!hasChanges || draftError !== null}
          >
            Save Controls
          </Button>
        </Group>
      </Group>

      {draftError && (
        <Alert color="yellow">
          {draftError}
        </Alert>
      )}

      {riskSettings.effectiveEntryLimits.usingLegacyGlobalFallback && (
        <Alert color="yellow" title="Legacy fallback is active">
          One or more routine limits are inherited from Global Settings. PAPER
          accounts receive a readiness warning; LIVE accounts remain blocked
          until all four account-owned fields are configured.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <DetailItem
          label="Authoritative account exposure ceiling"
          value={formatMoney(account.maxDeployableNotional, account.baseCurrency)}
        />
        {Object.entries(riskSettings.effectiveEntryLimits.limits).map(
          ([field, limit]) => (
            <DetailItem
              key={field}
              label={formatStatus(field)}
              value={
                <Stack gap={2}>
                  <Text size="sm" fw={600}>
                    {field === "maxDailyEntryOrders" || field === "maxOpenPositions"
                      ? formatQuantity(limit.value)
                      : formatMoney(limit.value, account.baseCurrency)}
                  </Text>
                  <Badge
                    size="xs"
                    color={limit.source === "ACCOUNT" ? "teal" : "yellow"}
                    variant="light"
                  >
                    {limit.source === "ACCOUNT" ? "Account" : "Legacy fallback"}
                  </Badge>
                </Stack>
              }
            />
          )
        )}
      </SimpleGrid>

      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fw={600} size="sm">
            Account risk controls enabled
          </Text>
          <Text size="sm" c="dimmed">
            When disabled, account-specific values are ignored and all four
            routine limits use their legacy global fallbacks.
          </Text>
        </div>
        <Switch
          checked={draft.enabled}
          onChange={(event) =>
            updateDraft({ enabled: event.currentTarget.checked })
          }
          disabled={updateMutation.isPending}
          color="teal"
        />
      </Group>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <NumberInput
          label="Max daily entry orders"
          description="Counted by America/New_York trading date."
          value={draft.maxDailyEntryOrders ?? ""}
          onChange={(value) =>
            updateDraft({ maxDailyEntryOrders: normalizeNumberInput(value) })
          }
          min={1}
          step={1}
          thousandSeparator=","
          error={
            draft.maxDailyEntryOrders === null ||
            (Number.isInteger(draft.maxDailyEntryOrders) &&
              draft.maxDailyEntryOrders > 0)
              ? undefined
              : "Must be a positive whole number."
          }
          disabled={updateMutation.isPending}
        />

        <NumberInput
          label="Max daily entry notional"
          description="Accepted entries count even after they fill."
          value={draft.maxDailyEntryNotional ?? ""}
          onChange={(value) =>
            updateDraft({ maxDailyEntryNotional: normalizeNumberInput(value) })
          }
          min={1}
          thousandSeparator=","
          prefix="$"
          error={
            draft.maxDailyEntryNotional === null ||
            draft.maxDailyEntryNotional > 0
              ? undefined
              : "Must be greater than zero."
          }
          disabled={updateMutation.isPending}
        />

        <NumberInput
          label="Max open positions"
          description="Active positions and unmaterialized pending entries consume slots."
          value={draft.maxOpenPositions ?? ""}
          onChange={(value) =>
            updateDraft({ maxOpenPositions: normalizeNumberInput(value) })
          }
          min={1}
          step={1}
          thousandSeparator=","
          error={
            draft.maxOpenPositions === null ||
            (Number.isInteger(draft.maxOpenPositions) &&
              draft.maxOpenPositions > 0)
              ? undefined
              : "Must be a positive whole number."
          }
          disabled={updateMutation.isPending}
        />

        <NumberInput
          label="Max symbol open notional"
          description="Open, pending, and proposed exposure for the symbol."
          value={draft.maxSymbolOpenNotional ?? ""}
          onChange={(value) =>
            updateDraft({ maxSymbolOpenNotional: normalizeNumberInput(value) })
          }
          min={1}
          thousandSeparator=","
          prefix="$"
          error={
            draft.maxSymbolOpenNotional === null ||
            draft.maxSymbolOpenNotional > 0
              ? undefined
              : "Must be greater than zero."
          }
          disabled={updateMutation.isPending}
        />

      </SimpleGrid>

      <Alert color="blue" title="Superseded account fields">
        maxTotalOpenNotional ({formatMoney(
          riskSettings.maxTotalOpenNotional,
          account.baseCurrency
        )}) and maxSubscriptionOpenNotional ({formatMoney(
          riskSettings.maxSubscriptionOpenNotional,
          account.baseCurrency
        )}) remain stored for Phase 2B compatibility. maxDeployableNotional and
        resolved subscription reservations are authoritative for normal entries.
      </Alert>

      <Textarea
        label="Notes"
        value={draft.notes}
        onChange={(event) =>
          updateDraft({ notes: event.currentTarget.value })
        }
        autosize
        minRows={3}
        disabled={updateMutation.isPending}
      />
    </Stack>
  );
}

function AccountRiskControlsCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data, isLoading, isError, error } = useTradingAccountRiskSettings(
    account.id,
    token
  );
  const riskSettings = data?.riskSettings;

  return (
    <Card withBorder radius="md" p="lg">
      {isLoading && (
        <Group gap="sm">
          <Loader size="sm" color="cyan" />
          <Text size="sm" c="dimmed">
            Loading account risk controls...
          </Text>
        </Group>
      )}

      {isError && (
        <Alert color="red" title="Failed to load account risk controls">
          {error instanceof Error ? error.message : "Unknown error."}
        </Alert>
      )}

      {!isLoading && !isError && !riskSettings && (
        <Alert color="yellow">Account risk controls are unavailable.</Alert>
      )}

      {riskSettings && (
        <AccountRiskControlsForm
          key={`${riskSettings.id}-${riskSettings.updatedAt}`}
          account={account}
          riskSettings={riskSettings}
          token={token}
        />
      )}
    </Card>
  );
}

function CredentialManagementCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [draft, setDraft] = useState<CredentialDraft>({
    apiKey: "",
    apiSecret: "",
  });
  const upsertMutation = useUpsertTradingAccountCredential(token);
  const verifyMutation = useVerifyTradingAccountCredential(token);
  const revokeMutation = useRevokeTradingAccountCredential(token);
  const hasCredentialDraft =
    draft.apiKey.trim().length > 0 || draft.apiSecret.trim().length > 0;
  const canSaveCredential =
    draft.apiKey.trim().length > 0 && draft.apiSecret.trim().length > 0;
  const credentialBusy =
    upsertMutation.isPending ||
    verifyMutation.isPending ||
    revokeMutation.isPending;

  async function saveCredentials() {
    if (!canSaveCredential) {
      notifications.show({
        message: "API key and API secret are both required.",
        color: "red",
      });
      return;
    }

    try {
      await upsertMutation.mutateAsync({
        id: account.id,
        payload: {
          authType: "API_KEY",
          apiKey: draft.apiKey.trim(),
          apiSecret: draft.apiSecret.trim(),
        },
      });

      setDraft({ apiKey: "", apiSecret: "" });
      notifications.show({
        message:
          "Credentials saved. Verify them before account-scoped broker access can use them.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error ? error.message : "Failed to save credentials.",
        color: "red",
      });
    }
  }

  async function verifyCredentials() {
    try {
      await verifyMutation.mutateAsync(account.id);
      notifications.show({
        message:
          "Credentials verified. Trading remains controlled by the account safety settings.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to verify credentials.",
        color: "red",
      });
    }
  }

  function confirmRevokeCredentials() {
    modals.openConfirmModal({
      title: "Revoke broker credentials",
      children: (
        <Stack gap="sm">
          <Text size="sm">
            Revoke broker credentials for <strong>{account.displayName}</strong>?
          </Text>
          <Text size="sm" c="dimmed">
            This marks the credential revoked, disables trading, enables the kill
            switch, and requires new credentials before account-scoped broker
            access can work.
          </Text>
        </Stack>
      ),
      labels: { confirm: "Revoke credentials", cancel: "Keep credentials" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await revokeMutation.mutateAsync(account.id);
          setDraft({ apiKey: "", apiSecret: "" });
          notifications.show({
            message:
              "Credentials revoked. Trading was disabled and the kill switch was enabled.",
            color: "teal",
          });
        } catch (error) {
          notifications.show({
            message:
              error instanceof Error
                ? error.message
                : "Failed to revoke credentials.",
            color: "red",
          });
        }
      },
    });
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Credential Management</Title>
            <Text size="sm" c="dimmed">
              Existing credentials cannot be viewed after saving. Enter new
              values only when replacing credentials.
            </Text>
          </div>
          <Badge
            color={credentialStatusColor(account.credential.status)}
            variant="light"
          >
            {account.credential.exists
              ? formatStatus(account.credential.status)
              : "No credentials"}
          </Badge>
        </Group>

        <Alert color="blue" title="Credential safety">
          API key and secret values are submitted only to the backend credential
          endpoint. They are cleared from this form after a successful save and
          are never prefilled.
        </Alert>

        {account.environment === "LIVE" && (
          <Alert color="red" title="Live credential risk">
            Live account credentials can access real funds. Verification does
            not enable trading automatically.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <PasswordInput
            label="API key"
            value={draft.apiKey}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                apiKey: value,
              }));
            }}
            disabled={credentialBusy}
            autoComplete="off"
          />

          <PasswordInput
            label="API secret"
            value={draft.apiSecret}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                apiSecret: value,
              }));
            }}
            disabled={credentialBusy}
            autoComplete="off"
          />
        </SimpleGrid>

        <Group justify="space-between" align="flex-start">
          <Text size="sm" c="dimmed">
            Verification refreshes broker metadata and credential status, but it
            does not turn on trading or turn off the kill switch.
          </Text>
          <Group>
            <Button
              variant="default"
              onClick={() => setDraft({ apiKey: "", apiSecret: "" })}
              disabled={!hasCredentialDraft || credentialBusy}
            >
              Clear
            </Button>
            <Button
              onClick={saveCredentials}
              loading={upsertMutation.isPending}
              disabled={!canSaveCredential || credentialBusy}
            >
              Save Credentials
            </Button>
            <Button
              variant="light"
              onClick={verifyCredentials}
              loading={verifyMutation.isPending}
              disabled={!account.credential.exists || credentialBusy}
            >
              Verify
            </Button>
            <Button
              color="red"
              variant="light"
              onClick={confirmRevokeCredentials}
              loading={revokeMutation.isPending}
              disabled={!account.credential.exists || credentialBusy}
            >
              Revoke
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}

function AccountTabPlaceholder({
  title,
  description,
  actionLabel,
  actionTo,
  secondaryActionLabel,
  secondaryActionTo,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: string;
  secondaryActionLabel?: string;
  secondaryActionTo?: string;
}) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="sm" align="flex-start">
        <Title order={3}>{title}</Title>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
        {(actionLabel && actionTo) ||
        (secondaryActionLabel && secondaryActionTo) ? (
          <Group gap="xs">
            {actionLabel && actionTo && (
              <Button component={Link} to={actionTo} variant="light" size="xs">
                {actionLabel}
              </Button>
            )}
            {secondaryActionLabel && secondaryActionTo && (
              <Button
                component={Link}
                to={secondaryActionTo}
                variant="default"
                size="xs"
              >
                {secondaryActionLabel}
              </Button>
            )}
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}

function formatSignedMoney(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "-";

  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMoney(value, currency)}`;
}

function formatPercentValue(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${value.toFixed(2)}%`;
}

function formatOrderValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-";

  return String(value);
}

function AccountPositionsSection({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data: positions = [], isLoading, isError, error } =
    useOpenPositions(token);
  const accountPositions = positions.filter(
    (position: TrackedPosition) => position.tradingAccountId === account.id
  );

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Open Positions</Title>
            <Text size="sm" c="dimmed">
              Open tracked positions attributed to this trading account.
            </Text>
          </div>
          <Button component={Link} to="/positions/open" variant="light" size="xs">
            Open global positions
          </Button>
        </Group>

        {isError && (
          <Alert color="red" title="Failed to load open positions">
            {error instanceof Error ? error.message : "Unknown error."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading open positions...
            </Text>
          </Group>
        )}

        {!isLoading && !isError && accountPositions.length === 0 && (
          <Alert color="gray">
            No open positions are currently attributed to this trading account.
          </Alert>
        )}

        {accountPositions.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 980 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Symbol</Table.Th>
                  <Table.Th>Side</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Avg entry</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Current</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Market value</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>P/L</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>P/L %</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Opened</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accountPositions.map((position) => (
                  <Table.Tr key={position.id}>
                    <Table.Td>
                      <Text fw={700} size="sm">
                        {position.symbol}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        color={position.side === "long" ? "teal" : "red"}
                        variant="light"
                      >
                        {position.side}
                      </Badge>
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatQuantity(position.qty)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(position.avgEntryPrice, account.baseCurrency)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(position.currentPrice, account.baseCurrency)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(position.marketValue, account.baseCurrency)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      <Text
                        size="sm"
                        fw={600}
                        c={
                          position.unrealizedPnL > 0
                            ? "teal"
                            : position.unrealizedPnL < 0
                              ? "red"
                              : "dimmed"
                        }
                      >
                        {formatSignedMoney(
                          position.unrealizedPnL,
                          account.baseCurrency
                        )}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      <Text
                        size="sm"
                        fw={600}
                        c={
                          position.unrealizedPnLPct > 0
                            ? "teal"
                            : position.unrealizedPnLPct < 0
                              ? "red"
                              : "dimmed"
                        }
                      >
                        {formatPercentValue(position.unrealizedPnLPct * 100)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" color="teal" variant="light">
                        {position.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatDateTime(position.openedAt)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Stack>
    </Card>
  );
}

function AccountOrdersSection({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data: orders = [], isLoading, isError, error } = useOpenOrders(token);
  const accountOrders = orders.filter(
    (order: OpenOrder) => order.tradingAccountId === account.id
  );

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Open Orders</Title>
            <Text size="sm" c="dimmed">
              Open broker orders attributed to this trading account.
            </Text>
          </div>
          <Button component={Link} to="/orders/open" variant="light" size="xs">
            Open global orders
          </Button>
        </Group>

        {isError && (
          <Alert color="red" title="Failed to load open orders">
            {error instanceof Error ? error.message : "Unknown error."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading open orders...
            </Text>
          </Group>
        )}

        {!isLoading && !isError && accountOrders.length === 0 && (
          <Alert color="gray">
            No open orders are currently attributed to this trading account.
          </Alert>
        )}

        {accountOrders.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 860 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Symbol</Table.Th>
                  <Table.Th>Side</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Filled</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Limit</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Submitted</Table.Th>
                  <Table.Th>Client order id</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accountOrders.map((order) => {
                  const filledQty = order.filled_qty ?? order.filledQty ?? "0";
                  const limitPrice = order.limit_price ?? order.limitPrice ?? null;
                  const submittedAt = order.submitted_at ?? order.submittedAt;
                  const clientOrderId =
                    order.client_order_id ?? order.clientOrderId ?? null;

                  return (
                    <Table.Tr key={order.id}>
                      <Table.Td>
                        <Text fw={700} size="sm">
                          {order.symbol}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          color={order.side === "buy" ? "teal" : "red"}
                          variant="light"
                        >
                          {order.side}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" tt="capitalize">
                          {order.type}
                        </Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatOrderValue(order.qty)}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatOrderValue(filledQty)}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {limitPrice !== null && limitPrice !== undefined
                          ? formatMoney(Number(limitPrice), account.baseCurrency)
                          : "-"}
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" color="yellow" variant="light">
                          {order.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {formatDateTime(submittedAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {clientOrderId ?? "-"}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Stack>
    </Card>
  );
}

export function TradingAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [token] = useState<string | null>(() => getAdminToken());
  const accountId = id ? Number(id) : undefined;
  const requestedTab = searchParams.get("tab");
  const activeTab: TradingAccountDetailTab =
    isTradingAccountDetailTab(requestedTab) ? requestedTab : "overview";
  const validAccountId =
    accountId !== undefined && Number.isInteger(accountId) && accountId > 0
      ? accountId
      : undefined;
  const { data, isLoading, isError, error } = useTradingAccount(
    validAccountId,
    token
  );
  const account = data?.account;

  function setActiveTab(value: string | null) {
    if (!isTradingAccountDetailTab(value)) return;

    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      if (value === "overview") {
        next.delete("tab");
      } else {
        next.set("tab", value);
      }

      return next;
    });
  }

  if (!validAccountId) {
    return (
      <Stack gap="md">
        <Button variant="subtle" onClick={() => navigate("/trading-accounts")}>
          Back to Trading Accounts
        </Button>
        <Alert color="red">Invalid trading account id.</Alert>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Button
            component={Link}
            to="/trading-accounts"
            variant="subtle"
            size="xs"
            mb="xs"
          >
            Back to Trading Accounts
          </Button>
          <Title order={2} size="h3">
            {account?.displayName ?? "Trading Account"}
          </Title>
          <Text size="sm" c="dimmed">
            Account-scoped broker metadata, credential status, and safety
            controls.
          </Text>
        </div>
      </Group>

      {isError && (
        <Alert color="red" title="Failed to load trading account">
          {error instanceof Error ? error.message : "Unknown error."}
        </Alert>
      )}

      {isLoading && (
        <Card withBorder radius="md" p="md">
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading trading account...
            </Text>
          </Group>
        </Card>
      )}

      {!isLoading && !isError && !account && (
        <Alert color="red">Trading account not found.</Alert>
      )}

      {account && (
        <Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
          <Tabs.List>
            {tradingAccountDetailTabs.map((tab) => (
              <Tabs.Tab key={tab.value} value={tab.value}>
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          <Tabs.Panel value="overview" pt="lg">
            <Stack gap="lg">
              <AccountSummaryCard account={account} />
              <BrokerSnapshotCard account={account} />
              <CredentialStatusCard account={account} />
              <SafetySettingsCard
                key={`settings-${account.id}-${account.updatedAt}`}
                account={account}
                token={token}
              />
              <SizingAndAllocationsSection account={account} token={token} />
              <CredentialManagementCard account={account} token={token} />
              <NotesCard account={account} />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="positions" pt="lg">
            <AccountPositionsSection account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="orders" pt="lg">
            <AccountOrdersSection account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="subscriptions" pt="lg">
            <AccountSubscriptionsSection account={account} token={token} />
          </Tabs.Panel>

          <Tabs.Panel value="risk-health" pt="lg">
            <Stack gap="lg">
              <AccountRiskControlsCard account={account} token={token} />
              <TradingAccountHealthCard account={account} token={token} />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="activity" pt="lg">
            <AccountTabPlaceholder
              title="Activity"
              description="There is not currently an account-scoped activity feed wired for this page. Use the global System Events and Trade History pages for lifecycle and audit review."
              actionLabel="Open System Events"
              actionTo="/system/events"
              secondaryActionLabel="Open Trade History"
              secondaryActionTo="/trade-history"
            />
          </Tabs.Panel>
        </Tabs>
      )}
    </Stack>
  );
}
