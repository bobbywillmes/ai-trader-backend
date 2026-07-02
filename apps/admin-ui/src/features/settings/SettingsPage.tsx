import { useMemo, useState } from "react";
import type { SetStateAction } from "react";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Grid,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  useMantineTheme,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { ChangePasswordModal } from "../auth/ChangePasswordModal";
import { useConfig, useSystemStatus, useUpdateConfig } from "./hooks";
import type { RuntimeTradingConfig } from "../dashboard/types";
import type { SystemStatusResponse } from "./api";

type RiskLimitKey =
  | "maxDailyEntryOrders"
  | "maxDailyEntryNotional"
  | "maxOpenPositions"
  | "maxTotalOpenNotional"
  | "maxSymbolOpenNotional"
  | "maxSubscriptionOpenNotional";

type RiskLimitForm = Pick<RuntimeTradingConfig, RiskLimitKey>;

type ReconciliationSettingsDraft = {
  reconciliationWorkerEnabled: boolean;
  reconciliationWorkerIntervalMinutes: number;
};

type EntrySessionSettingsDraft = {
  entrySessionGuardEnabled: boolean;
  entryStartMinutesAfterOpen: number;
  entryCutoffMinutesBeforeClose: number | null;
  failClosedOnMarketClockError: boolean;
};

const riskLimitDefinitions: {
  key: RiskLimitKey;
  label: string;
  badge: string;
  description: string;
  placeholder: string;
}[] = [
  {
    key: "maxDailyEntryOrders",
    label: "Max Daily Entry Orders",
    badge: "daily count",
    description:
      "Maximum number of buy-side entry orders the system may create in one UTC day. This helps prevent signal storms from opening too many trades.",
    placeholder: "Example: 5",
  },
  {
    key: "maxDailyEntryNotional",
    label: "Max Daily Entry Notional",
    badge: "daily dollars",
    description:
      "Maximum total dollar value of entry orders allowed in one UTC day. Existing open exposure is not counted here; this only limits today's new entries.",
    placeholder: "Example: 10000",
  },
  {
    key: "maxOpenPositions",
    label: "Max Open Positions",
    badge: "portfolio count",
    description:
      "Maximum number of active tracked positions allowed at the same time. This protects against the system spreading across too many tickers.",
    placeholder: "Example: 5",
  },
  {
    key: "maxTotalOpenNotional",
    label: "Max Total Open Notional",
    badge: "portfolio dollars",
    description:
      "Maximum projected total open exposure after a new entry. This is the broad portfolio-level exposure cap.",
    placeholder: "Example: 25000",
  },
  {
    key: "maxSymbolOpenNotional",
    label: "Max Symbol Open Notional",
    badge: "ticker dollars",
    description:
      "Maximum dollar exposure allowed for a single ticker. This prevents one symbol from becoming too large.",
    placeholder: "Example: 5000",
  },
  {
    key: "maxSubscriptionOpenNotional",
    label: "Max Subscription Open Notional",
    badge: "strategy dollars",
    description:
      "Maximum dollar exposure allowed for one subscription. This helps separate risk between strategy/ticker subscriptions.",
    placeholder: "Example: 5000",
  },
];

function configToRiskForm(config: RuntimeTradingConfig): RiskLimitForm {
  return {
    maxDailyEntryOrders: config.maxDailyEntryOrders,
    maxDailyEntryNotional: config.maxDailyEntryNotional,
    maxOpenPositions: config.maxOpenPositions,
    maxTotalOpenNotional: config.maxTotalOpenNotional,
    maxSymbolOpenNotional: config.maxSymbolOpenNotional,
    maxSubscriptionOpenNotional: config.maxSubscriptionOpenNotional,
  };
}

function configToEntrySessionDraft(
  config: RuntimeTradingConfig
): EntrySessionSettingsDraft {
  return {
    entrySessionGuardEnabled: config.entrySessionGuardEnabled,
    entryStartMinutesAfterOpen: config.entryStartMinutesAfterOpen,
    entryCutoffMinutesBeforeClose: config.entryCutoffMinutesBeforeClose,
    failClosedOnMarketClockError: config.failClosedOnMarketClockError,
  };
}

function configToReconciliationDraft(
  config: RuntimeTradingConfig
): ReconciliationSettingsDraft {
  return {
    reconciliationWorkerEnabled: config.reconciliationWorkerEnabled,
    reconciliationWorkerIntervalMinutes:
      config.reconciliationWorkerIntervalMinutes,
  };
}

function normalizeNumberInput(value: string | number): number | null {
  if (value === "") return null;

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function formatLimit(value: number | null) {
  return value === null ? "No limit" : value.toLocaleString();
}

function riskLimitChanged(
  config: RuntimeTradingConfig,
  riskForm: RiskLimitForm,
  key: RiskLimitKey
) {
  return config[key] !== riskForm[key];
}

function hasRiskLimitChanges(
  config: RuntimeTradingConfig,
  riskForm: RiskLimitForm | null
) {
  if (!riskForm) return false;

  return riskLimitDefinitions.some((definition) =>
    riskLimitChanged(config, riskForm, definition.key)
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";

  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function formatRelativeFuture(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (seconds <= 0) return "Due now";
  if (seconds < 60) return `In ${seconds} seconds`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `In ${minutes} minutes`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `In ${hours} hours`;

  const days = Math.round(hours / 24);
  return `In ${days} days`;
}

function formatDurationMs(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 1_000) return `${value} ms`;

  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  return `${Math.round(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatCadence(value: number) {
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function formatStatusLabel(value: string) {
  return value.replace(/_/g, " ").toUpperCase();
}

function useConfigDraft<T>(source: T | null) {
  const [draft, setDraftState] = useState<T | null>(null);

  const value = draft ?? source;

  function setDraft(next: SetStateAction<T | null>) {
    setDraftState((currentDraft) => {
      const currentValue = currentDraft ?? source;

      return typeof next === "function"
        ? (next as (previous: T | null) => T | null)(currentValue)
        : next;
    });
  }

  function resetDraft() {
    setDraftState(null);
  }

  return [value, setDraft, resetDraft] as const;
}

function workerStatusColor(status: string) {
  switch (status) {
    case "healthy":
      return "teal";
    case "starting":
      return "blue";
    case "degraded":
    case "delayed":
      return "yellow";
    case "stale":
    case "failing":
      return "red";
    case "disabled":
      return "gray";
    default:
      return "gray";
  }
}

function criticalityColor(criticality: string) {
  switch (criticality) {
    case "critical":
      return "red";
    case "important":
      return "yellow";
    default:
      return "gray";
  }
}

function alpacaApiUsageStatusColor(
  status: SystemStatusResponse["alpacaApiUsage"]["status"]
) {
  switch (status) {
    case "normal":
      return "teal";
    case "elevated":
      return "yellow";
    case "rate_limited":
      return "orange";
    case "degraded":
      return "red";
    default:
      return "gray";
  }
}

function adaptivePollingStatusColor(
  status: SystemStatusResponse["adaptivePolling"]["status"]
) {
  return status === "normal" ? "teal" : "orange";
}

function DetailPurpose({
  label,
  description,
  color = "blue",
}: {
  label: string;
  description: string;
  color?: string;
}) {
  return (
    <Group gap="xs" align="center">
      <Badge color={color} variant="light">
        {label}
      </Badge>
      <Text size="sm" c="dimmed">
        {description}
      </Text>
    </Group>
  );
}

function formatMarketState(
  marketState: SystemStatusResponse["adaptivePolling"]["marketState"]
) {
  switch (marketState) {
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    case "unknown":
      return "Unknown";
    default:
      return "-";
  }
}

function formatModeReason(
  adaptivePolling: SystemStatusResponse["adaptivePolling"]
) {
  const activity = adaptivePolling.localActivity;

  if (adaptivePolling.marketState === "unknown") {
    return "Conservative polling";
  }

  const activePositionCount =
    activity.openPositionCount + activity.closingPositionCount;

  if (activePositionCount > 0) {
    return `${activePositionCount} open or closing positions`;
  }

  if (activity.submittedOrderCount > 0) {
    return `${activity.submittedOrderCount} submitted orders`;
  }

  if (activity.nonterminalBrokerOrderCount > 0) {
    return `${activity.nonterminalBrokerOrderCount} active broker orders`;
  }

  return "No active local lifecycle";
}

const adaptivePollingModeRows = [
  {
    state: "Open + active",
    mode: "market_open_active",
    color: "teal",
    submittedOrders: "10s when submitted orders exist",
    trackedPositions: "15s",
  },
  {
    state: "Open + idle",
    mode: "market_open_idle",
    color: "blue",
    submittedOrders: "Not scheduled",
    trackedPositions: "60s",
  },
  {
    state: "Closed + active",
    mode: "market_closed_active",
    color: "orange",
    submittedOrders: "60s when submitted orders exist",
    trackedPositions: "2m",
  },
  {
    state: "Closed + idle",
    mode: "market_closed_idle",
    color: "gray",
    submittedOrders: "Not scheduled",
    trackedPositions: "5m",
  },
  {
    state: "Unknown",
    mode: "market_unknown",
    color: "red",
    submittedOrders: "10s when submitted orders exist",
    trackedPositions: "15s active / 60s idle",
  },
  {
    state: "Forced write follow-up",
    mode: "Any mode",
    color: "violet",
    submittedOrders: "Next scheduler tick",
    trackedPositions: "Next scheduler tick when relevant",
  },
];

function panelStyle(color: string) {
  return {
    borderColor: `var(--mantine-color-${color}-7)`,
    background: `linear-gradient(135deg, color-mix(in srgb, var(--mantine-color-${color}-9) 18%, transparent), transparent 42%)`,
  };
}

function summaryTileStyle(color: string) {
  return {
    border: `1px solid var(--mantine-color-${color}-8)`,
    borderLeft: `4px solid var(--mantine-color-${color}-5)`,
    borderRadius: 8,
    background: `color-mix(in srgb, var(--mantine-color-${color}-9) 22%, transparent)`,
  };
}

function sectionPanelStyle(color: string) {
  return {
    border: `1px solid var(--mantine-color-${color}-8)`,
    borderTop: `3px solid var(--mantine-color-${color}-5)`,
    borderRadius: 8,
    background: `color-mix(in srgb, var(--mantine-color-${color}-9) 12%, transparent)`,
  };
}

function tableHeaderStyle(color: string) {
  return {
    background: `color-mix(in srgb, var(--mantine-color-${color}-9) 24%, transparent)`,
  };
}

function usageTableRowStyle(index: number) {
  return {
    background:
      index % 2 === 0
        ? "color-mix(in srgb, var(--mantine-color-dark-6) 24%, transparent)"
        : "color-mix(in srgb, var(--mantine-color-dark-5) 18%, transparent)",
  };
}

function modeRowStyle(color: string, isCurrent: boolean) {
  return {
    background: isCurrent
      ? `color-mix(in srgb, var(--mantine-color-${color}-9) 35%, transparent)`
      : undefined,
  };
}

function formatAdaptiveCadence(
  worker: SystemStatusResponse["adaptivePolling"]["workers"]["submittedOrderSync"],
  idleLabel = "Not scheduled"
) {
  if (worker.forced) return "Next scheduler tick";
  if (worker.effectiveIntervalMs === null) return idleLabel;
  return `Every ${formatCadence(worker.effectiveIntervalMs)}`;
}

function formatEntryMarketState(
  entrySession: SystemStatusResponse["trading"]["risk"]["entrySession"]
) {
  if (entrySession.marketOpen === null) return "Unknown";
  return entrySession.marketOpen ? "Open" : "Closed";
}

function BrokerMonitoringSummary({
  status,
}: {
  status: SystemStatusResponse;
}) {
  const usage = status.alpacaApiUsage;
  const adaptivePolling = status.adaptivePolling;
  const entrySession = status.trading.risk.entrySession;
  const submittedWorker = adaptivePolling.workers.submittedOrderSync;
  const positionWorker = adaptivePolling.workers.trackedPositionSync;
  const requestCount = usage.rolling.fiveMinutes.requestCount;
  const rateLimited = usage.rateLimit.active;
  const openOrClosing =
    adaptivePolling.localActivity.openPositionCount +
    adaptivePolling.localActivity.closingPositionCount;

  return (
    <Card withBorder radius="md" p="md" style={panelStyle("cyan")}>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={700}>Broker Monitoring</Text>
            <Text size="sm" c="dimmed">
              One view for Alpaca traffic, adaptive polling, and market-entry state.
            </Text>
          </div>
          <Group gap="xs">
            <Badge color={alpacaApiUsageStatusColor(usage.status)} variant="light">
              API {formatStatusLabel(usage.status)}
            </Badge>
            <Badge
              color={adaptivePollingStatusColor(adaptivePolling.status)}
              variant="light"
            >
              Polling {formatStatusLabel(adaptivePolling.status)}
            </Badge>
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }}>
          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(
              adaptivePolling.marketState === "unknown"
                ? "red"
                : adaptivePolling.marketState === "open"
                  ? "teal"
                  : "orange"
            )}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Current State
            </Text>
            <Text size="sm" fw={700}>
              {formatMarketState(adaptivePolling.marketState)} /{" "}
              {adaptivePolling.mode.replace(/_/g, " ")}
            </Text>
            <Text size="xs" c="dimmed">
              {openOrClosing} open or closing positions,{" "}
              {adaptivePolling.localActivity.submittedOrderCount} submitted orders
            </Text>
          </Stack>

          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle("blue")}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Alpaca Reads
            </Text>
            <Text size="sm" fw={700}>
              Orders: {formatAdaptiveCadence(submittedWorker)}
            </Text>
            <Text size="xs" c="dimmed">
              Positions: {formatAdaptiveCadence(positionWorker)}
            </Text>
          </Stack>

          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(rateLimited ? "orange" : "teal")}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              API Pressure
            </Text>
            <Text size="sm" fw={700}>
              {formatNumber(requestCount)} requests in 5m
            </Text>
            <Text size="xs" c={rateLimited ? "orange" : "dimmed"}>
              {rateLimited
                ? `Backoff until ${formatDateTime(usage.rateLimit.backoffUntil)}`
                : "No active rate-limit backoff"}
            </Text>
          </Stack>

          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(entrySession.canEnterNow ? "teal" : "violet")}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Entry Window
            </Text>
            <Text size="sm" fw={700}>
              {formatEntryMarketState(entrySession)} /{" "}
              {formatEntrySessionStatus(entrySession.status)}
            </Text>
            <Text size="xs" c="dimmed">
              {entrySession.marketOpen ? "Next close" : "Next open"}:{" "}
              {formatMarketDateTime(
                entrySession.marketOpen
                  ? entrySession.nextCloseAt
                  : entrySession.nextOpenAt
              )}
            </Text>
          </Stack>
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString();
}

function formatWindowCounts(
  oneMinuteValue: number | null | undefined,
  fiveMinuteValue: number | null | undefined
) {
  return `Last 1 minute: ${formatNumber(oneMinuteValue)} | Last 5 minutes: ${formatNumber(
    fiveMinuteValue
  )}`;
}

function AlpacaUsageGroupTable({
  title,
  groups,
  color = "blue",
}: {
  title: string;
  groups: SystemStatusResponse["alpacaApiUsage"]["topOperations"];
  color?: string;
}) {
  return (
    <Stack gap="xs" p="md" style={sectionPanelStyle(color)}>
      <Group justify="space-between" align="center">
        <Text fw={600} size="sm">
          {title}
        </Text>
        <Badge color={color} variant="light" size="xs">
          Top {Math.min(groups.length, 5)}
        </Badge>
      </Group>
      {groups.length > 0 ? (
        <ScrollArea>
          <Table highlightOnHover withRowBorders={false} style={{ minWidth: 520 }}>
            <Table.Thead style={tableHeaderStyle(color)}>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Requests</Table.Th>
                <Table.Th>Failures</Table.Th>
                <Table.Th>429s</Table.Th>
                <Table.Th>Avg</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {groups.slice(0, 5).map((group, index) => (
                <Table.Tr key={group.key} style={usageTableRowStyle(index)}>
                  <Table.Td>
                    <Tooltip label={group.key} multiline maw={420}>
                      <Text size="sm" truncate="end" maw={220}>
                        {group.key}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{formatNumber(group.requestCount)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      size="sm"
                      c={group.failureCount > 0 ? "red" : undefined}
                    >
                      {formatNumber(group.failureCount)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      size="sm"
                      c={group.rateLimitCount > 0 ? "orange" : undefined}
                    >
                      {formatNumber(group.rateLimitCount)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {formatDurationMs(Math.round(group.averageDurationMs))}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      ) : (
        <Text size="sm" c="dimmed">
          No requests observed.
        </Text>
      )}
    </Stack>
  );
}

function AlpacaApiUsagePanel({
  usage,
}: {
  usage: SystemStatusResponse["alpacaApiUsage"];
}) {
  const oneMinute = usage.rolling.oneMinute;
  const fiveMinutes = usage.rolling.fiveMinutes;
  const latestLimitReset = usage.rateLimit.latestKnownResetAt
    ? formatDateTime(usage.rateLimit.latestKnownResetAt)
    : "-";

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600}>Alpaca API Usage</Text>
            <Text size="sm" c="dimmed">
              Tracks broker API traffic so the backend can spot request spikes,
              avoid rate-limit loops, and confirm usage data is being saved.
            </Text>
            <Text size="xs" c="dimmed" mt={2}>
              Process {usage.processInstanceId.slice(0, 8)} started{" "}
              {formatRelativeTime(usage.processStartedAt)}
            </Text>
          </div>
          <Badge color={alpacaApiUsageStatusColor(usage.status)} variant="light">
            {formatStatusLabel(usage.status)}
          </Badge>
        </Group>

        <DetailPurpose
          label="Traffic"
          description="Is Alpaca request volume normal?"
          color="teal"
        />

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <Stack gap={2} p="sm" style={summaryTileStyle("blue")}>
            <Text size="xs" c="dimmed" tt="uppercase">
              Alpaca Requests
            </Text>
            <Text size="sm">
              {formatWindowCounts(
                oneMinute.requestCount,
                fiveMinutes.requestCount
              )}
            </Text>
            <Text size="xs" c="dimmed">
              Since backend start: {formatNumber(usage.totalRequestsSinceStartup)}
            </Text>
          </Stack>

          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(fiveMinutes.failureCount > 0 ? "red" : "gray")}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Failed Requests
            </Text>
            <Text size="sm">
              {formatWindowCounts(
                oneMinute.failureCount,
                fiveMinutes.failureCount
              )}
            </Text>
            <Text size="xs" c="dimmed">
              Network failures in last 5 minutes:{" "}
              {formatNumber(fiveMinutes.networkErrorCount)}
            </Text>
          </Stack>

          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(
              fiveMinutes.rateLimitCount > 0 || usage.rateLimit.active
                ? "orange"
                : "gray"
            )}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Rate-Limited Requests
            </Text>
            <Text size="sm">
              {formatWindowCounts(
                oneMinute.rateLimitCount,
                fiveMinutes.rateLimitCount
              )}
            </Text>
            <Text size="xs" c="dimmed">
              Rate-limit incidents since backend start:{" "}
              {formatNumber(usage.rateLimit.incidentCount)}
            </Text>
          </Stack>

          <Stack gap={2} p="sm" style={summaryTileStyle("teal")}>
            <Text size="xs" c="dimmed" tt="uppercase">
              Saved Usage Data
            </Text>
            <Tooltip label={formatDateTime(usage.persistence.lastFlushSucceededAt)}>
              <Text size="sm">
                Last database save:{" "}
                {formatRelativeTime(usage.persistence.lastFlushSucceededAt)}
              </Text>
            </Tooltip>
            <Text size="xs" c="dimmed">
              Waiting to save:{" "}
              {formatNumber(usage.persistence.pendingAggregateCount)} buckets |
              retention: {usage.persistence.retentionDays} days
            </Text>
          </Stack>
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Stack gap="sm" p="md" style={sectionPanelStyle("orange")}>
            <Group justify="space-between" align="center">
              <Text fw={600} size="sm">
                Rate-Limit State
              </Text>
              <Badge
                color={usage.rateLimit.active ? "orange" : "gray"}
                variant="light"
                size="xs"
              >
                {usage.rateLimit.active ? "Backoff active" : "No backoff"}
              </Badge>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Text size="sm">
                Backoff: {usage.rateLimit.active ? "active" : "inactive"}
              </Text>
              <Tooltip label={formatDateTime(usage.rateLimit.backoffUntil)}>
                <Text size="sm">
                  Backoff ends: {formatDateTime(usage.rateLimit.backoffUntil)}
                </Text>
              </Tooltip>
              <Text size="sm">
                Latest remaining calls:{" "}
                {formatNumber(usage.rateLimit.latestKnownRemaining)}
              </Text>
              <Text size="sm">
                Latest reported limit:{" "}
                {formatNumber(usage.rateLimit.latestKnownLimit)}
              </Text>
              <Text size="sm">Reset: {latestLimitReset}</Text>
              <Text size="sm">
                Latest 429:{" "}
                {formatRelativeTime(usage.rateLimit.lastRateLimitedAt)}
              </Text>
            </SimpleGrid>
          </Stack>

          <Stack gap="sm" p="md" style={sectionPanelStyle("violet")}>
            <Group justify="space-between" align="center">
              <Text fw={600} size="sm">
                Warning State
              </Text>
              <Badge
                color={usage.warning.active ? "orange" : "gray"}
                variant="light"
                size="xs"
              >
                {usage.warning.active ? "Warning active" : "Quiet"}
              </Badge>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Text size="sm">
                Warning: {usage.warning.active ? "active" : "inactive"}
              </Text>
              <Text size="sm">
                Threshold: {formatNumber(usage.warning.thresholdPerMinute)}/m
              </Text>
              <Text size="sm">
                Active requests: {formatNumber(usage.activeRequestCount)}
              </Text>
              <Text size="sm">
                Peak concurrent: {formatNumber(usage.peakConcurrentRequests)}
              </Text>
            </SimpleGrid>
          </Stack>
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, lg: 2 }}>
          <AlpacaUsageGroupTable
            title="Top Operations"
            groups={usage.topOperations}
            color="blue"
          />
          <AlpacaUsageGroupTable
            title="Top Endpoints"
            groups={usage.topEndpoints}
            color="cyan"
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}

function AdaptiveWorkerStatus({
  title,
  worker,
  idleMessage,
  accentColor = "blue",
}: {
  title: string;
  worker: SystemStatusResponse["adaptivePolling"]["workers"]["submittedOrderSync"];
  idleMessage?: string;
  accentColor?: string;
}) {
  const cadence =
    worker.effectiveIntervalMs === null
      ? "Not scheduled"
      : `Every ${formatCadence(worker.effectiveIntervalMs)}`;

  return (
    <Card
      withBorder
      radius="md"
      p="md"
      style={summaryTileStyle(worker.forced ? "violet" : accentColor)}
    >
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Text fw={600}>{title}</Text>
          {worker.forced && (
            <Badge color="blue" variant="light">
              Forced
            </Badge>
          )}
        </Group>

        {worker.effectiveIntervalMs === null && idleMessage ? (
          <Text size="sm">{idleMessage}</Text>
        ) : (
          <Text size="sm">Cadence: {cadence}</Text>
        )}

        <Tooltip label={formatDateTime(worker.lastSuccessAt)}>
          <Text size="sm" c="dimmed">
            Last broker sync: {formatRelativeTime(worker.lastSuccessAt)}
          </Text>
        </Tooltip>

        <Tooltip label={formatDateTime(worker.nextDueAt)}>
          <Text size="sm" c="dimmed">
            Next sync: {formatRelativeFuture(worker.nextDueAt)}
          </Text>
        </Tooltip>

        <Text size="xs" c="dimmed">
          Reason: {worker.decisionReason.replace(/_/g, " ")}
          {worker.forceReason ? ` | ${worker.forceReason.replace(/_/g, " ")}` : ""}
        </Text>
      </Stack>
    </Card>
  );
}

function AdaptivePollingPanel({
  adaptivePolling,
}: {
  adaptivePolling: SystemStatusResponse["adaptivePolling"];
}) {
  const activity = adaptivePolling.localActivity;

  return (
    <Card
      withBorder
      radius="md"
      p="md"
      style={panelStyle(adaptivePolling.status === "degraded" ? "orange" : "blue")}
    >
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600}>Adaptive Polling</Text>
            <Text size="sm" c="dimmed">
              Effective Alpaca REST cadence for broker-state synchronization.
            </Text>
          </div>
          <Badge
            color={adaptivePollingStatusColor(adaptivePolling.status)}
            variant="light"
          >
            {formatStatusLabel(adaptivePolling.status)}
          </Badge>
        </Group>

        <DetailPurpose
          label="Cadence"
          description="How often are broker-state reads happening?"
          color="blue"
        />

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(
              adaptivePolling.marketState === "unknown"
                ? "red"
                : adaptivePolling.marketState === "open"
                  ? "teal"
                  : "orange"
            )}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Market
            </Text>
            <Text size="sm">{formatMarketState(adaptivePolling.marketState)}</Text>
            <Text size="xs" c="dimmed">
              Clock: {adaptivePolling.marketSession.clockCacheStatus ?? "-"}
            </Text>
          </Stack>

          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(
              adaptivePolling.mode === "market_unknown"
                ? "red"
                : adaptivePolling.mode.includes("active")
                  ? "orange"
                  : "blue"
            )}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Mode
            </Text>
            <Text size="sm">{adaptivePolling.mode.replace(/_/g, " ")}</Text>
            <Text size="xs" c="dimmed">
              {formatModeReason(adaptivePolling)}
            </Text>
          </Stack>

          <Stack
            gap={2}
            p="sm"
            style={summaryTileStyle(
              activity.submittedOrderCount > 0 ? "violet" : "gray"
            )}
          >
            <Text size="xs" c="dimmed" tt="uppercase">
              Orders
            </Text>
            <Text size="sm">
              Submitted: {activity.submittedOrderCount}
            </Text>
            <Text size="xs" c="dimmed">
              Submitting: {activity.submittingOrderCount} | broker orders:{" "}
              {activity.nonterminalBrokerOrderCount}
            </Text>
          </Stack>

          <Stack gap={2} p="sm" style={summaryTileStyle("teal")}>
            <Text size="xs" c="dimmed" tt="uppercase">
              Positions
            </Text>
            <Text size="sm">
              Open/closing:{" "}
              {activity.openPositionCount + activity.closingPositionCount}
            </Text>
            <Text size="xs" c="dimmed">
              Exit states: {activity.activeExitCount} | protective:{" "}
              {activity.activeProtectiveOrderCount}
            </Text>
          </Stack>
        </SimpleGrid>

        {adaptivePolling.status === "degraded" && (
          <Alert color="orange" title="Market session unavailable">
            {adaptivePolling.marketSession.lastError ??
              "Alpaca market-session state is unavailable; conservative polling is active."}
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <AdaptiveWorkerStatus
            title="Submitted orders"
            worker={adaptivePolling.workers.submittedOrderSync}
            idleMessage="Status: Idle - no submitted orders. Broker request: not scheduled."
            accentColor="violet"
          />
          <AdaptiveWorkerStatus
            title="Tracked positions"
            worker={adaptivePolling.workers.trackedPositionSync}
            accentColor="blue"
          />
        </SimpleGrid>

        <Accordion variant="contained">
          <Accordion.Item value="cadence-reference">
            <Accordion.Control>
              <Group gap="xs">
                <Text fw={600} size="sm">
                  Cadence reference
                </Text>
                <Badge color="blue" variant="light" size="xs">
                  Static
                </Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <ScrollArea>
                <Table striped highlightOnHover style={{ minWidth: 720 }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>State</Table.Th>
                      <Table.Th>Mode</Table.Th>
                      <Table.Th>Submitted orders</Table.Th>
                      <Table.Th>Tracked positions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {adaptivePollingModeRows.map((row) => {
                      const isCurrent = row.mode === adaptivePolling.mode;

                      return (
                        <Table.Tr
                          key={row.state}
                          style={modeRowStyle(row.color, isCurrent)}
                        >
                          <Table.Td
                            style={{
                              borderLeft: `4px solid var(--mantine-color-${row.color}-5)`,
                            }}
                          >
                            <Group gap="xs" wrap="nowrap">
                              {isCurrent && (
                                <Badge color={row.color} variant="light" size="xs">
                                  Current
                                </Badge>
                              )}
                              <Text size="sm" fw={isCurrent ? 700 : 500}>
                                {row.state}
                              </Text>
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{row.mode}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{row.submittedOrders}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{row.trackedPositions}</Text>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Card>
  );
}

function WorkerHealthTable({
  health,
}: {
  health: SystemStatusResponse["workers"]["health"];
}) {
  const evaluatedAtMs = new Date(health.summary.evaluatedAt).getTime();

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600}>Worker Health</Text>
            <Text size="sm" c="dimmed">
              Process {health.summary.processInstanceId.slice(0, 8)} started{" "}
              {formatRelativeTime(health.summary.processStartedAt)}
            </Text>
          </div>
          <Badge color={workerStatusColor(health.summary.status)} variant="light">
            {formatStatusLabel(health.summary.status)}
          </Badge>
        </Group>

        <DetailPurpose
          label="Scheduler"
          description="Is each background worker alive and completing work?"
          color="gray"
        />

        <ScrollArea>
          <Table striped highlightOnHover style={{ minWidth: 980 }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Worker</Table.Th>
                <Table.Th>Criticality</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Cadence</Table.Th>
                <Table.Th>Running</Table.Th>
                <Table.Th>Last Success</Table.Th>
                <Table.Th>Last Work</Table.Th>
                <Table.Th>Duration</Table.Th>
                <Table.Th>Failures</Table.Th>
                <Table.Th>Error</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {health.items.map((worker) => (
                <Table.Tr key={worker.key}>
                  <Table.Td>
                    <Stack gap={2}>
                      <Text size="sm" fw={600}>
                        {worker.displayName}
                      </Text>
                      <Text size="xs" c="dimmed" maw={260}>
                        {worker.description}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      color={criticalityColor(worker.criticality)}
                      variant="light"
                    >
                      {worker.criticality}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Badge
                        color={workerStatusColor(worker.status)}
                        variant="light"
                      >
                        {formatStatusLabel(worker.status)}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {worker.statusReason.replace(/_/g, " ")}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{formatCadence(worker.expectedIntervalMs)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {worker.running && worker.currentRunStartedAt ? (
                      <Tooltip label={formatDateTime(worker.currentRunStartedAt)}>
                        <Badge color="blue" variant="light">
                          Running for{" "}
                          {formatDurationMs(
                            evaluatedAtMs -
                              new Date(worker.currentRunStartedAt).getTime()
                          )}
                        </Badge>
                      </Tooltip>
                    ) : worker.enabled ? (
                      <Text size="sm">No</Text>
                    ) : (
                      <Text size="sm" c="dimmed">
                        Disabled
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={formatDateTime(worker.lastSucceededAt)}>
                      <Text size="sm">{formatRelativeTime(worker.lastSucceededAt)}</Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={formatDateTime(worker.lastWorkSucceededAt)}>
                      <Text size="sm">
                        {worker.lastWorkSucceededAt
                          ? formatRelativeTime(worker.lastWorkSucceededAt)
                          : worker.enabled
                            ? "No work yet"
                            : "Disabled"}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{formatDurationMs(worker.lastDurationMs)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      size="sm"
                      c={worker.consecutiveFailures > 0 ? "red" : undefined}
                    >
                      {worker.consecutiveFailures}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {worker.lastError ? (
                      <Tooltip label={worker.lastError} multiline maw={420}>
                        <Text size="sm" c="red" maw={220} truncate="end">
                          {worker.lastError}
                        </Text>
                      </Tooltip>
                    ) : (
                      <Text size="sm" c="dimmed">
                        -
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Stack>
    </Card>
  );
}

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function StatusBadge({
  ok,
  trueLabel = "OK",
  falseLabel = "Issue",
}: {
  ok: boolean;
  trueLabel?: string;
  falseLabel?: string;
}) {
  return (
    <Badge color={ok ? "teal" : "red"} variant="light">
      {ok ? trueLabel : falseLabel}
    </Badge>
  );
}

export function SettingsPage() {
  const theme = useMantineTheme();
  const [token] = useState<string | null>(() => getAdminToken());
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  const systemStatusQuery = useSystemStatus(token);
  const systemStatus = systemStatusQuery.data;

  const { data: config, isLoading, isError } = useConfig(token);
  const updateMutation = useUpdateConfig(token);

  const [riskForm, setRiskForm, resetRiskFormDraft] = useConfigDraft(
    config ? configToRiskForm(config) : null
  );

  const [
    reconciliationDraft,
    setReconciliationDraft,
    resetReconciliationDraft,
  ] = useConfigDraft(
    config ? configToReconciliationDraft(config) : null
  );

  const [
    entrySessionDraft,
    setEntrySessionDraft,
    resetEntrySessionDraft,
  ] = useConfigDraft(
    config ? configToEntrySessionDraft(config) : null
  );

  const entryStatus = useMemo(() => {
    if (!config) return null;

    if (!config.tradingEnabled) {
      return {
        color: "red",
        label: "Trading disabled",
        message:
          "The global trading master switch is off. Treat this as the broadest shutdown state for order submission.",
      };
    }

    if (config.killSwitchEnabled) {
      return {
        color: "orange",
        label: "Entries paused",
        message:
          "Trading is enabled, but the kill switch is active. New entries are blocked while the system can remain online for monitoring and exit handling.",
      };
    }

    return {
      color: "teal",
      label: "Entries allowed",
      message:
        "Trading is enabled and the kill switch is off. Entry signals may pass through if they also satisfy security, subscription, broker, and exposure checks.",
    };
  }, [config]);

  const riskLimitsHaveChanges = config
    ? hasRiskLimitChanges(config, riskForm)
    : false;

  async function applyUpdate(payload: Partial<RuntimeTradingConfig>) {
    try {
      await updateMutation.mutateAsync(payload);
      notifications.show({ message: "Settings saved.", color: "teal" });
    } catch (err) {
      notifications.show({
        message: err instanceof Error ? err.message : "Failed to save settings.",
        color: "red",
      });
    }
  }

  function handleTradingToggle(enabled: boolean) {
    if (enabled) {
      modals.openConfirmModal({
        title: "Enable trading",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              This turns on the global trading master switch.
            </Text>
            <Text size="sm">
              Entry signals may be accepted if the kill switch is off and all
              risk checks pass.
            </Text>
            <Text size="sm" c="dimmed">
              Use this only after subscriptions, exit profiles, securities, and
              risk limits are configured correctly.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Enable trading", cancel: "Cancel" },
        confirmProps: { color: "teal" },
        onConfirm: () => applyUpdate({ tradingEnabled: true }),
      });
    } else {
      modals.openConfirmModal({
        title: "Disable trading",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              This turns off the global trading master switch.
            </Text>
            <Text size="sm">
              Use this when you want the backend to reject new order submission
              broadly, regardless of the kill switch setting.
            </Text>
            <Text size="sm" c="dimmed">
              For a softer entry-only pause, leave Trading Enabled on and turn
              on the Kill Switch instead.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Disable trading", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => applyUpdate({ tradingEnabled: false }),
      });
    }
  }

  function handleKillSwitchToggle(enabled: boolean) {
    if (enabled) {
      modals.openConfirmModal({
        title: "Activate kill switch",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              This blocks new entry orders while keeping the system online.
            </Text>
            <Text size="sm">
              This is the preferred production pause when you want to stop new
              buys but still allow monitoring and exit workflows to continue.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Activate kill switch", cancel: "Cancel" },
        confirmProps: { color: "orange" },
        onConfirm: () => applyUpdate({ killSwitchEnabled: true }),
      });
    } else {
      modals.openConfirmModal({
        title: "Deactivate kill switch",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              New entry signals may be accepted again if Trading Enabled is on
              and all risk checks pass.
            </Text>
            <Text size="sm" c="dimmed">
              Daily order limits, exposure limits, security status,
              subscription status, broker mode, and broker trading-blocked
              checks still apply.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Deactivate kill switch", cancel: "Cancel" },
        confirmProps: { color: "teal" },
        onConfirm: () => applyUpdate({ killSwitchEnabled: false }),
      });
    }
  }

  function handlePaperModeToggle(paperMode: boolean) {
    if (!paperMode) {
      modals.openConfirmModal({
        title: "Switch to live trading",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              Live trading uses real money. Orders will be executed against your
              live Alpaca account.
            </Text>
            <Text size="sm" c="red">
              Only switch this after the backend environment variables and
              Alpaca account mode are confirmed.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Switch to live", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => applyUpdate({ paperMode: false }),
      });
    } else {
      applyUpdate({ paperMode: true });
    }
  }

  async function handleSaveRiskLimits() {
    if (!riskForm) return;

    await applyUpdate(riskForm);
    resetRiskFormDraft();
  }

  function handleResetRiskForm() {
    resetRiskFormDraft();
  }

  const reconciliationSettingsChanged =
    Boolean(config && reconciliationDraft) &&
    (reconciliationDraft?.reconciliationWorkerEnabled !==
      config?.reconciliationWorkerEnabled ||
      reconciliationDraft?.reconciliationWorkerIntervalMinutes !==
        config?.reconciliationWorkerIntervalMinutes);

  const entrySessionSettingsChanged =
    Boolean(config && entrySessionDraft) &&
    (entrySessionDraft?.entrySessionGuardEnabled !==
      config?.entrySessionGuardEnabled ||
      entrySessionDraft?.entryStartMinutesAfterOpen !==
        config?.entryStartMinutesAfterOpen ||
      entrySessionDraft?.entryCutoffMinutesBeforeClose !==
        config?.entryCutoffMinutesBeforeClose ||
      entrySessionDraft?.failClosedOnMarketClockError !==
        config?.failClosedOnMarketClockError);

  const entrySessionSettingsValid =
    entrySessionDraft !== null &&
    Number.isInteger(entrySessionDraft.entryStartMinutesAfterOpen) &&
    entrySessionDraft.entryStartMinutesAfterOpen >= 0 &&
    entrySessionDraft.entryStartMinutesAfterOpen <= 390 &&
    (entrySessionDraft.entryCutoffMinutesBeforeClose === null ||
      (Number.isInteger(entrySessionDraft.entryCutoffMinutesBeforeClose) &&
        entrySessionDraft.entryCutoffMinutesBeforeClose >= 0 &&
        entrySessionDraft.entryCutoffMinutesBeforeClose <= 390 &&
        entrySessionDraft.entryStartMinutesAfterOpen +
          entrySessionDraft.entryCutoffMinutesBeforeClose <
          390));

  const reconciliationIntervalValid =
    reconciliationDraft !== null &&
    Number.isInteger(reconciliationDraft.reconciliationWorkerIntervalMinutes) &&
    reconciliationDraft.reconciliationWorkerIntervalMinutes >= 1 &&
    reconciliationDraft.reconciliationWorkerIntervalMinutes <= 1440;

  function resetReconciliationSettings() {
    resetReconciliationDraft();
  }

  async function saveReconciliationSettings() {
    if (!reconciliationDraft) {
      return;
    }

    await applyUpdate({
      reconciliationWorkerEnabled:
        reconciliationDraft.reconciliationWorkerEnabled,
      reconciliationWorkerIntervalMinutes:
        reconciliationDraft.reconciliationWorkerIntervalMinutes,
    });

    resetReconciliationDraft();
  }

  function resetEntrySessionSettings() {
    resetEntrySessionDraft();
  }

  async function saveEntrySessionSettings() {
    if (!entrySessionDraft) {
      return;
    }

    await applyUpdate(entrySessionDraft);
    resetEntrySessionDraft();
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Settings</Title>
          <Text c="dimmed">
            Runtime trading configuration, risk controls, and admin account
            management.
          </Text>
        </div>

        {entryStatus && (
          <Badge color={entryStatus.color} size="lg" variant="light">
            {entryStatus.label}
          </Badge>
        )}
      </Group>

      {isError && (
        <Alert color="red" title="Failed to load settings">
          Check the backend connection and admin session.
        </Alert>
      )}

      {isLoading && (
        <Group>
          <Loader size="sm" />
          <Text>Loading settings…</Text>
        </Group>
      )}

      {config && (
        <>
          {entryStatus && (
            <Alert color={entryStatus.color} variant="light">
              {entryStatus.message}
            </Alert>
          )}


          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={3}>System Status</Title>
                  <Text c="dimmed" size="sm">
                    Production readiness snapshot for the app, database, broker mode,
                    workers, and trading entry state.
                  </Text>
                </div>

                <Group>
                  {systemStatus && (
                    <Badge
                      color={systemStatus.health.ok ? "teal" : "red"}
                      size="lg"
                      variant="light"
                    >
                      {systemStatus.health.ok ? "Healthy" : "Health Issue"}
                    </Badge>
                  )}

                  {systemStatus && (
                    <Badge
                      color={systemStatus.trading.risk.canEnter ? "teal" : "orange"}
                      size="lg"
                      variant="light"
                    >
                      {systemStatus.trading.risk.canEnter
                        ? "Entries Allowed"
                        : "Entries Blocked"}
                    </Badge>
                  )}

                  <Button
                    variant="default"
                    onClick={() => systemStatusQuery.refetch()}
                    loading={systemStatusQuery.isFetching}
                  >
                    Refresh
                  </Button>
                </Group>
              </Group>

              <Divider />

              {systemStatusQuery.isLoading && (
                <Group>
                  <Loader size="sm" />
                  <Text>Loading system status…</Text>
                </Group>
              )}

              {systemStatusQuery.isError && (
                <Alert color="red" title="Failed to load system status">
                  Check the backend connection and admin session.
                </Alert>
              )}

              {systemStatus && (
                <Stack gap="md">
                  {!systemStatus.trading.risk.canEnter &&
                    systemStatus.trading.risk.reasons.length > 0 && (
                      <Group
                        gap="sm"
                        p="sm"
                        style={{
                          border: `1px solid ${theme.colors.blue[8]}`,
                          borderRadius: theme.radius.sm,
                          background: "rgba(59, 130, 246, 0.08)",
                        }}
                      >
                        <ThemeIcon color="blue" variant="light" size="sm">
                          i
                        </ThemeIcon>
                        <Text size="sm" c="dimmed">
                          {systemStatus.trading.risk.reasons[0]}
                        </Text>
                      </Group>
                    )}

                  <SimpleGrid cols={{ base: 1, md: 2, xl: 4 }}>
                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>App / DB</Text>
                        <StatusBadge ok={systemStatus.health.ok} />
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Env: {systemStatus.environment.nodeEnv}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Uptime: {formatUptime(systemStatus.health.uptimeSeconds)}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Database:{" "}
                        {systemStatus.health.database.ok ? "reachable" : "unreachable"}
                      </Text>
                    </Card>

                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>Broker Mode</Text>
                        <Badge
                          color={
                            systemStatus.trading.risk.broker.mode ===
                            systemStatus.trading.risk.broker.expectedMode
                              ? "teal"
                              : "red"
                          }
                          variant="light"
                        >
                          {systemStatus.trading.risk.broker.mode}
                        </Badge>
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Expected: {systemStatus.trading.risk.broker.expectedMode}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Trading blocked:{" "}
                        {systemStatus.trading.risk.broker.tradingBlocked ? "yes" : "no"}
                      </Text>
                    </Card>

                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>Workers</Text>
                        <Badge
                          color={workerStatusColor(
                            systemStatus.workers.health.summary.status
                          )}
                          variant="light"
                        >
                          {formatStatusLabel(
                            systemStatus.workers.health.summary.status
                          )}
                        </Badge>
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Pending: {systemStatus.workers.pendingOrderCount}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Submitting: {systemStatus.workers.submittingOrderCount}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Submitted: {systemStatus.workers.submittedOrderCount}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Attention:{" "}
                        {systemStatus.workers.health.summary.needsAttention
                          ? "yes"
                          : "no"}
                      </Text>
                    </Card>

                    <Card withBorder radius="md" p="md">
                      <Group justify="space-between">
                        <Text fw={600}>Positions</Text>
                        <Badge color="blue" variant="light">
                          {systemStatus.workers.openTrackedPositionCount} open
                        </Badge>
                      </Group>
                      <Text size="sm" c="dimmed" mt="xs">
                        Closing: {systemStatus.workers.closingTrackedPositionCount}
                      </Text>
                      <Text size="sm" c="dimmed">
                        Unprocessed events:{" "}
                        {systemStatus.workers.unprocessedSystemEventCount}
                      </Text>
                    </Card>
                  </SimpleGrid>

                  <BrokerMonitoringSummary status={systemStatus} />

                  <Accordion
                    multiple
                    defaultValue={["api-usage", "adaptive-polling"]}
                    variant="contained"
                  >
                    <Accordion.Item value="api-usage">
                      <Accordion.Control>
                        <Group gap="xs">
                          <Text fw={600}>API Usage Details</Text>
                          <Badge
                            color={alpacaApiUsageStatusColor(
                              systemStatus.alpacaApiUsage.status
                            )}
                            variant="light"
                            size="xs"
                          >
                            {formatStatusLabel(systemStatus.alpacaApiUsage.status)}
                          </Badge>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <AlpacaApiUsagePanel usage={systemStatus.alpacaApiUsage} />
                      </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="adaptive-polling">
                      <Accordion.Control>
                        <Group gap="xs">
                          <Text fw={600}>Adaptive Polling Details</Text>
                          <Badge
                            color={adaptivePollingStatusColor(
                              systemStatus.adaptivePolling.status
                            )}
                            variant="light"
                            size="xs"
                          >
                            {formatStatusLabel(systemStatus.adaptivePolling.status)}
                          </Badge>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <AdaptivePollingPanel
                          adaptivePolling={systemStatus.adaptivePolling}
                        />
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>

                  <WorkerHealthTable health={systemStatus.workers.health} />

                  <Grid>
                    <Grid.Col span={{ base: 12, md: 6 }}>
                      <Card withBorder radius="md" p="md">
                        <Title order={4}>Environment</Title>

                        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
                          <Group justify="space-between">
                            <Text size="sm">DATABASE_URL</Text>
                            <StatusBadge ok={systemStatus.environment.hasDatabaseUrl} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">ALPACA_API_KEY</Text>
                            <StatusBadge ok={systemStatus.environment.hasAlpacaApiKey} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">ALPACA_SECRET_KEY</Text>
                            <StatusBadge
                              ok={systemStatus.environment.hasAlpacaSecretKey}
                            />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">ALPACA_BASE_URL</Text>
                            <StatusBadge ok={systemStatus.environment.hasAlpacaBaseUrl} />
                          </Group>

                          <Group justify="space-between" py="sm">
                            <div>
                              <Text size="sm" fw={500}>Admin session token</Text>
                              <Text size="xs" c="dimmed">BEARER TOKEN</Text>
                            </div>
                            <StatusBadge ok={systemStatusQuery.isSuccess} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">SIGNAL_API_KEY</Text>
                            <StatusBadge ok={systemStatus.environment.hasSignalApiKey} />
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">CORS allowed origins</Text>
                            <StatusBadge ok={systemStatus.environment.hasCorsAllowedOrigins} />
                          </Group>

                        </SimpleGrid>
                      </Card>
                    </Grid.Col>


                    <Text size="xs" c="dimmed" mt="sm">
                      CORS origins:{" "}
                      {systemStatus.environment.corsAllowedOrigins.length > 0
                        ? systemStatus.environment.corsAllowedOrigins.join(", ")
                        : "-"}
                    </Text>


                    <Grid.Col span={{ base: 12, md: 6 }}>
                      <Card withBorder radius="md" p="md">
                        <Title order={4}>Audit Freshness</Title>

                        <Stack gap="xs" mt="sm">
                          <Group justify="space-between">
                            <Text size="sm">Latest account snapshot</Text>
                            <Text size="sm" c="dimmed">
                              {formatDateTime(
                                systemStatus.audit.latestAccountSnapshot?.createdAt
                              )}
                            </Text>
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">Snapshot reason</Text>
                            <Badge variant="light">
                              {systemStatus.audit.latestAccountSnapshot?.reason ?? "-"}
                            </Badge>
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">Latest broker activity</Text>
                            <Text size="sm" c="dimmed">
                              {formatDateTime(
                                systemStatus.audit.latestBrokerActivity?.transactionTime
                              )}
                            </Text>
                          </Group>

                          <Group justify="space-between">
                            <Text size="sm">Last broker event</Text>
                            <Text size="sm" c="dimmed">
                              {[
                                systemStatus.audit.latestBrokerActivity?.activityType,
                                systemStatus.audit.latestBrokerActivity?.side,
                                systemStatus.audit.latestBrokerActivity?.symbol,
                              ]
                                .filter(Boolean)
                                .join(" ") || "-"}
                            </Text>
                          </Group>
                        </Stack>
                      </Card>
                    </Grid.Col>
                  </Grid>

                  <Text size="xs" c="dimmed">
                    Last checked: {formatDateTime(systemStatus.timestamp)}
                  </Text>
                </Stack>
              )}
            </Stack>
          </Card>

          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={3}>Entry Trading Window</Title>
                  <Text c="dimmed" size="sm" maw={760}>
                    Controls new entries only. Exits and protective orders remain
                    permitted. The backend uses Alpaca's actual daily market
                    schedule, including holidays and early closes. Leaving the
                    close cutoff blank disables only the pre-close buffer.
                  </Text>
                </div>

                <Group>
                  {entrySessionSettingsChanged && (
                    <Badge color="blue" variant="light">
                      Unsaved changes
                    </Badge>
                  )}
                  <Badge
                    color={
                      entrySessionDraft?.entrySessionGuardEnabled ? "teal" : "gray"
                    }
                  >
                    {entrySessionDraft?.entrySessionGuardEnabled
                      ? "Enabled"
                      : "Disabled"}
                  </Badge>
                  <Switch
                    checked={entrySessionDraft?.entrySessionGuardEnabled ?? false}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setEntrySessionDraft((current) =>
                        current
                          ? {
                              ...current,
                              entrySessionGuardEnabled: checked,
                            }
                          : current
                      );
                    }}
                    disabled={updateMutation.isPending || !entrySessionDraft}
                    color="teal"
                    size="md"
                  />
                </Group>
              </Group>

              <SimpleGrid
                cols={{ base: 1, md: 3 }}
                style={{
                  opacity: entrySessionDraft?.entrySessionGuardEnabled ? 1 : 0.62,
                }}
              >
                <NumberInput
                  label="Wait after market open"
                  description="Minutes after the regular-session open before entries are allowed."
                  min={0}
                  max={390}
                  step={1}
                  value={entrySessionDraft?.entryStartMinutesAfterOpen ?? 15}
                  onChange={(value) => {
                    const minutes =
                      typeof value === "number"
                        ? value
                        : Number.parseInt(value, 10);

                    if (!Number.isFinite(minutes)) {
                      return;
                    }

                    setEntrySessionDraft((current) =>
                      current
                        ? {
                            ...current,
                            entryStartMinutesAfterOpen: minutes,
                          }
                        : current
                    );
                  }}
                  disabled={
                    updateMutation.isPending ||
                    !entrySessionDraft ||
                    !entrySessionDraft.entrySessionGuardEnabled
                  }
                />

                <NumberInput
                  label="Stop entries before close"
                  description="Blank disables only the pre-close buffer."
                  min={0}
                  max={390}
                  step={1}
                  value={entrySessionDraft?.entryCutoffMinutesBeforeClose ?? ""}
                  onChange={(value) => {
                    const minutes = normalizeNumberInput(value);
                    setEntrySessionDraft((current) =>
                      current
                        ? {
                            ...current,
                            entryCutoffMinutesBeforeClose: minutes,
                          }
                        : current
                    );
                  }}
                  disabled={
                    updateMutation.isPending ||
                    !entrySessionDraft ||
                    !entrySessionDraft.entrySessionGuardEnabled
                  }
                />

                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <div>
                    <Text fw={600} size="sm">
                      Fail closed on session error
                    </Text>
                    <Text size="sm" c="dimmed">
                      Blocks entries if Alpaca clock or calendar data cannot be
                      verified.
                    </Text>
                  </div>
                  <Switch
                    checked={
                      entrySessionDraft?.failClosedOnMarketClockError ?? true
                    }
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setEntrySessionDraft((current) =>
                        current
                          ? {
                              ...current,
                              failClosedOnMarketClockError: checked,
                            }
                          : current
                      );
                    }}
                    disabled={
                      updateMutation.isPending ||
                      !entrySessionDraft ||
                      !entrySessionDraft.entrySessionGuardEnabled
                    }
                    color="orange"
                    size="md"
                  />
                </Group>
              </SimpleGrid>

              {!entrySessionSettingsValid && (
                <Alert color="red" title="Invalid entry window">
                  Opening and closing buffers must be between 0 and 390 minutes,
                  and together must leave part of a normal 390-minute session
                  available.
                </Alert>
              )}

              <Group justify="flex-end">
                <Button
                  variant="subtle"
                  onClick={resetEntrySessionSettings}
                  disabled={
                    !entrySessionSettingsChanged || updateMutation.isPending
                  }
                >
                  Reset
                </Button>
                <Button
                  onClick={saveEntrySessionSettings}
                  loading={updateMutation.isPending}
                  disabled={
                    !entrySessionSettingsChanged || !entrySessionSettingsValid
                  }
                >
                  Save Entry Window
                </Button>
              </Group>
            </Stack>
          </Card>

          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Group gap="xs">
                    <Title order={3}>Trading Controls</Title>
                    <ThemeIcon color="blue" variant="light" size="sm">
                      i
                    </ThemeIcon>
                  </Group>
                  <Text c="dimmed" size="sm">
                    These are the highest-level runtime controls. They affect
                    whether the backend accepts trading activity before the
                    detailed risk limits are even considered.
                  </Text>
                </div>
              </Group>

              <Divider />

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>Automated Trading</Text>
                    <Badge color={config.tradingEnabled ? "teal" : "red"}>
                      {config.tradingEnabled ? "On" : "Off"}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" maw={720}>
                    Master switch for automated order submission. When this is off, the
                     backend rejects automated trading requests even if subscriptions, 
                    securities, strategies, and exit profiles are enabled. 
                    Use this when the trading system should not place orders.
                  </Text>
                </div>

                <Switch
                  checked={config.tradingEnabled}
                  onChange={(e) => handleTradingToggle(e.currentTarget.checked)}
                  disabled={updateMutation.isPending}
                  color="teal"
                  size="md"
                />
              </Group>

              <Divider />

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>Kill Switch - Block new entries</Text>
                    <Badge color={config.killSwitchEnabled ? "orange" : "teal"}>
                      {config.killSwitchEnabled ? "Entries Blocked" : "Off"}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" maw={720}>
                    Entry-only safety pause. When this is on, the backend blocks new buy-side entries while allowing the system to stay online for monitoring, syncing, and position management. 
                    Use this when you want to stop opening new positions without shutting down the whole trading system.
                  </Text>
                </div>

                <Switch
                  checked={config.killSwitchEnabled}
                  onChange={(e) =>
                    handleKillSwitchToggle(e.currentTarget.checked)
                  }
                  disabled={updateMutation.isPending}
                  color="orange"
                  size="md"
                />
              </Group>

              <Divider />

              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div>
                  <Group gap="xs">
                    <Text fw={600}>Paper Trading Mode</Text>
                    <Badge color={config.paperMode ? "blue" : "red"}>
                      {config.paperMode ? "Paper" : "Live"}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" maw={720}>
                    When enabled, runtime config expects the Alpaca paper
                    trading environment. Disable only when connected to a live
                    Alpaca account and ready to trade real funds.
                  </Text>
                  {!config.paperMode && (
                    <Text size="sm" c="red" fw={600} mt="xs">
                      Live trading is active — real money at risk.
                    </Text>
                  )}
                </div>

                <Switch
                  checked={config.paperMode}
                  onChange={(e) =>
                    handlePaperModeToggle(e.currentTarget.checked)
                  }
                  disabled={updateMutation.isPending}
                  color="yellow"
                  size="md"
                />
              </Group>
            </Stack>
          </Card>

          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={3}>Entry Risk Limits</Title>
                  <Text c="dimmed" size="sm">
                    These are global emergency entry caps checked only after
                    trading is enabled and the kill switch is off.
                    Account-specific sizing lives on trading account
                    subscriptions. Allocation bucket limits are configured on
                    trading account allocations but are not enforced yet.
                    Clearing a value removes that specific limit.
                  </Text>
                </div>

                <Group>
                  <Button
                    variant="default"
                    onClick={handleResetRiskForm}
                    disabled={updateMutation.isPending || !riskLimitsHaveChanges}
                  >
                    Reset
                  </Button>
                  <Button
                    onClick={handleSaveRiskLimits}
                    loading={updateMutation.isPending}
                    disabled={!riskForm || !riskLimitsHaveChanges}
                  >
                    Save Risk Limits
                  </Button>
                </Group>
              </Group>

              <Divider />

              {riskForm && (
                <SimpleGrid cols={{ base: 1, md: 2 }}>
                  {riskLimitDefinitions.map((definition) => {
                    const changed = riskLimitChanged(config, riskForm, definition.key);

                    return (
                      <Card
                        key={definition.key}
                        withBorder
                        radius="md"
                        p="md"
                        style={{
                          borderColor: changed ? theme.colors.blue[6] : undefined,
                          boxShadow: changed
                            ? `0 0 0 1px ${theme.colors.blue[6]}`
                            : undefined,
                        }}
                      >
                        <Stack gap="xs">
                          <Group justify="space-between" align="flex-start">
                            <div>
                              <Group gap="xs">
                                <Text fw={600}>{definition.label}</Text>
                              </Group>

                              <Badge variant="light" color="gray">
                                {definition.badge}
                              </Badge>
                            </div>

                            <Stack gap={2} align="flex-end">
                              <Text size="sm" c="dimmed">
                                Current: {formatLimit(config[definition.key])}
                              </Text>

                              {changed && (
                                <Text size="sm" c="blue" fw={600}>
                                  New: {formatLimit(riskForm[definition.key])}
                                </Text>
                              )}
                            </Stack>
                          </Group>

                          <Text size="sm" c="dimmed">
                            {definition.description}
                          </Text>

                          <NumberInput
                            value={riskForm[definition.key] ?? ""}
                            onChange={(value) =>
                              setRiskForm((current) =>
                                current
                                  ? {
                                      ...current,
                                      [definition.key]: normalizeNumberInput(value),
                                    }
                                  : current
                              )
                            }
                            min={0}
                            placeholder={definition.placeholder}
                            disabled={updateMutation.isPending}
                            thousandSeparator=","
                          />
                        </Stack>
                      </Card>
                    );
                  })}
                </SimpleGrid>
              )}
            </Stack>
          </Card>

          <Card withBorder>
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Text fw={700}>Scheduled Reconciliation</Text>
                  <Text size="sm" c="dimmed">
                    Runs broker/backend reconciliation automatically and applies
                    attention states for critical tracked-position findings.
                  </Text>
                </div>

                <Group>
                  {reconciliationSettingsChanged && (
                    <Badge color="blue" variant="light">
                      Unsaved changes
                    </Badge>
                  )}

                  <Badge
                    color={
                      reconciliationDraft?.reconciliationWorkerEnabled ? "teal" : "gray"
                    }
                  >
                    {reconciliationDraft?.reconciliationWorkerEnabled
                      ? "Enabled"
                      : "Disabled"}
                  </Badge>

                  <Switch
                    checked={reconciliationDraft?.reconciliationWorkerEnabled ?? false}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;

                      setReconciliationDraft((current) =>
                        current
                          ? {
                              ...current,
                              reconciliationWorkerEnabled: checked,
                            }
                          : current
                      );
                    }}
                    disabled={updateMutation.isPending || !reconciliationDraft}
                    color="teal"
                    size="md"
                  />
                </Group>
              </Group>

              <NumberInput
                label="Interval minutes"
                description="How often the scheduled reconciliation worker is allowed to run when enabled."
                min={1}
                max={1440}
                step={1}
                value={
                  reconciliationDraft?.reconciliationWorkerIntervalMinutes ?? 15
                }
                onChange={(value) => {
                  const interval =
                    typeof value === "number"
                      ? value
                      : Number.parseInt(value, 10);

                  if (!Number.isFinite(interval)) {
                    return;
                  }

                  setReconciliationDraft((current) =>
                    current
                      ? {
                          ...current,
                          reconciliationWorkerIntervalMinutes: interval,
                        }
                      : current
                  );
                }}
                error={
                  reconciliationIntervalValid
                    ? undefined
                    : "Interval must be between 1 and 1440 minutes."
                }
                disabled={updateMutation.isPending || !reconciliationDraft}
              />

              <Group justify="flex-end">
                <Button
                  variant="subtle"
                  onClick={resetReconciliationSettings}
                  disabled={!reconciliationSettingsChanged || updateMutation.isPending}
                >
                  Reset
                </Button>

                <Button
                  onClick={saveReconciliationSettings}
                  loading={updateMutation.isPending}
                  disabled={
                    !reconciliationSettingsChanged || !reconciliationIntervalValid
                  }
                >
                  Save Reconciliation Settings
                </Button>
              </Group>

              <Alert color="blue" title="Recommended starting point">
                Keep this disabled until you are ready for automatic checks. When enabled,
                a 15 minute interval is a reasonable starting point for paper production.
              </Alert>
            </Stack>
          </Card>

        </>
      )}

      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Title order={3}>Security</Title>

          <Group justify="space-between" align="flex-start">
            <div>
              <Text fw={600}>Admin Password</Text>
              <Text size="sm" c="dimmed">
                Change the password used to log in to this admin panel.
              </Text>
            </div>

            <Button variant="default" onClick={() => setChangePasswordOpen(true)}>
              Change Password
            </Button>
          </Group>
        </Stack>
      </Card>

      {token && (
        <ChangePasswordModal
          opened={changePasswordOpen}
          onClose={() => setChangePasswordOpen(false)}
          token={token}
        />
      )}
    </Stack>
  );
}

function formatMarketDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(date);
}

function formatEntrySessionStatus(status: string) {
  return status.replace(/_/g, " ");
}
