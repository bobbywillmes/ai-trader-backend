import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFileAnalytics } from "@tabler/icons-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getAdminToken } from "../../lib/api";
import { useExitProfiles } from "../exitProfiles/hooks";
import { TradeCycleDrawer } from "../tradeHistory/TradeCycleDrawer";
import { useTradeCycleDrawer } from "../tradeHistory/hooks";
import { useStrategies } from "../strategies/hooks";
import { useSubscriptions } from "../subscriptions/hooks";
import {
  useAccountSnapshotTrends,
  useAccountSnapshots,
  useBrokerActivities,
  useCreateManualAccountSnapshot,
  useSyncBrokerActivities,
  useTradePerformance,
} from "./hooks";
import type {
  AccountSnapshot,
  BrokerActivitiesQuery,
  TradePerformanceGroup,
  TradePerformanceOutcome,
  TradePerformanceQuery,
  TradePerformanceSortBy,
  TradePerformanceSortDirection,
  TradePerformanceTradeRow,
} from "./types";

function formatDate(value: string | null) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatExposurePercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`;
}

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  const minutes = Math.round(value / 60000);

  if (minutes < 60) return `${minutes}m`;

  const hours = minutes / 60;

  if (hours < 48) {
    return `${hours.toLocaleString(undefined, {
      maximumFractionDigits: 1,
    })}h`;
  }

  return `${(hours / 24).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}d`;
}

function getTimespanDateFrom(timespan: string) {
  const now = new Date();

  if (timespan === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }

  if (timespan === "7d") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (timespan === "30d") {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (timespan === "90d") {
    return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  if (timespan === "ytd") {
    return new Date(now.getFullYear(), 0, 1).toISOString();
  }

  if (timespan === "1y") {
    return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  }

  return undefined;
}

function normalizeLimit(value: string | number, fallback: number) {
  if (value === "") return fallback;

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sideColor(side: string | null) {
  if (side === "buy") return "teal";
  if (side === "sell") return "red";
  return "gray";
}

function performanceColor(value: number) {
  if (value > 0) return "#12b886";
  if (value < 0) return "#fa5252";
  return "#868e96";
}

function pnlTextColor(value: number | null | undefined) {
  if (value === null || value === undefined) return "dimmed";
  if (value > 0) return "teal";
  if (value < 0) return "red";
  return "dimmed";
}

function decisionColor(state: string) {
  if (state.includes("allow") || state.includes("eligible")) return "teal";
  if (state.includes("block") || state.includes("deny")) return "red";
  if (state.includes("watch") || state.includes("cooldown")) return "yellow";
  return "blue";
}

function getSortLabel(
  column: TradePerformanceSortBy,
  sortBy: TradePerformanceSortBy,
  sortDirection: TradePerformanceSortDirection
) {
  if (column !== sortBy) return "";
  return sortDirection === "asc" ? " ↑" : " ↓";
}

function PerformanceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TradePerformanceGroup }>;
}) {
  if (!active || !payload?.length) return null;

  const group = payload[0].payload;

  return (
    <Card withBorder shadow="sm" radius="md" p="sm">
      <Text fw={700}>{group.label}</Text>
      <Text size="sm">P/L: {formatMoney(group.totalRealizedPnl)}</Text>
      <Text size="sm">Trades: {group.reportableTradeCount}</Text>
      <Text size="sm">Win rate: {formatPercent(group.winRate)}</Text>
      <Text size="sm">Return: {formatPercent(group.averageReturnPct)}</Text>
    </Card>
  );
}

function PerformanceBarChart({
  data,
  emptyLabel,
}: {
  data: TradePerformanceGroup[];
  emptyLabel: string;
}) {
  const chartData = data.slice(0, 8);

  if (chartData.length === 0) {
    return <Text c="dimmed">{emptyLabel}</Text>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart
        data={chartData}
        margin={{ top: 8, right: 16, bottom: 48, left: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          interval={0}
          angle={-35}
          textAnchor="end"
          height={64}
          tick={{ fontSize: 12 }}
        />
        <YAxis tickFormatter={(value) => `$${value}`} width={54} />
        <Tooltip content={<PerformanceTooltip />} />
        <Bar dataKey="totalRealizedPnl" radius={[4, 4, 0, 0]}>
          {chartData.map((entry) => (
            <Cell
              key={entry.id}
              fill={performanceColor(entry.totalRealizedPnl)}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

type AccountTrendPoint = AccountSnapshot & {
  grossExposure: number | null;
  grossExposurePct: number | null;
};

type AccountTrendLine = {
  dataKey: keyof Pick<
    AccountTrendPoint,
    "equity" | "portfolioValue" | "cash" | "grossExposure" | "grossExposurePct"
  >;
  name: string;
  stroke: string;
};

function AccountTrendTooltip({
  active,
  payload,
  valueFormatter,
}: {
  active?: boolean;
  payload?: Array<{
    color?: string;
    name?: string;
    value?: number | null;
    payload: AccountTrendPoint;
  }>;
  valueFormatter: (value: number | null | undefined) => string;
}) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload;

  if (!point) return null;

  return (
    <Card withBorder shadow="sm" radius="md" p="sm">
      <Text fw={700}>{formatDate(point.createdAt)}</Text>
      <Stack gap={2} mt={4}>
        {payload.map((item) => (
          <Text key={item.name} size="sm" style={{ color: item.color }}>
            {item.name}: {valueFormatter(item.value)}
          </Text>
        ))}
      </Stack>
    </Card>
  );
}

function AccountTrendChart({
  data,
  emptyLabel,
  lines,
  unavailableLabel,
  valueFormatter,
  yAxisFormatter,
}: {
  data: AccountTrendPoint[];
  emptyLabel: string;
  lines: AccountTrendLine[];
  unavailableLabel?: string;
  valueFormatter: (value: number | null | undefined) => string;
  yAxisFormatter: (value: number) => string;
}) {
  const hasRenderableValue = data.some((point) =>
    lines.some((line) => point[line.dataKey] !== null)
  );

  if (data.length === 0) {
    return <Text c="dimmed">{emptyLabel}</Text>;
  }

  if (!hasRenderableValue) {
    return <Text c="dimmed">{unavailableLabel ?? emptyLabel}</Text>;
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid
          stroke="var(--mantine-color-gray-4)"
          strokeDasharray="3 3"
          vertical={false}
        />
        <XAxis
          dataKey="createdAt"
          tickFormatter={formatDate}
          tick={{ fontSize: 12 }}
          minTickGap={24}
        />
        <YAxis tickFormatter={yAxisFormatter} width={68} />
        <Tooltip
          content={<AccountTrendTooltip valueFormatter={valueFormatter} />}
        />
        <Legend />
        {lines.map((line) => (
          <Line
            key={line.dataKey}
            type="monotone"
            dataKey={line.dataKey}
            name={line.name}
            stroke={line.stroke}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function PerformanceSortHeader({
  column,
  label,
  align = "left",
  sortBy,
  sortDirection,
  onSort,
}: {
  column: TradePerformanceSortBy;
  label: string;
  align?: "left" | "right";
  sortBy: TradePerformanceSortBy;
  sortDirection: TradePerformanceSortDirection;
  onSort: (sortBy: TradePerformanceSortBy) => void;
}) {
  return (
    <Table.Th ta={align}>
      <Button
        variant="subtle"
        size="compact-sm"
        onClick={() => onSort(column)}
      >
        {label}
        {getSortLabel(column, sortBy, sortDirection)}
      </Button>
    </Table.Th>
  );
}

function PerformancePaginationFooter({
  page,
  pageSize,
  total,
  totalPages,
  rowCount,
  isFetching,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rowCount: number;
  isFetching: boolean;
  onPageChange: (page: number) => void;
}) {
  const firstResult = total === 0 || rowCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult =
    total === 0 || rowCount === 0
      ? 0
      : Math.min(firstResult + rowCount - 1, total);

  return (
    <Group justify="space-between">
      <Text size="sm" c="dimmed">
        Showing {firstResult}-{lastResult} of {total}
      </Text>
      <Group gap="xs">
        <Button
          size="xs"
          variant="default"
          disabled={page <= 1 || isFetching}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Previous
        </Button>
        <Text size="sm">
          Page {page} of {totalPages}
        </Text>
        <Button
          size="xs"
          variant="default"
          disabled={page >= totalPages || isFetching}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          Next
        </Button>
      </Group>
    </Group>
  );
}

function PerformanceTradesTable({
  trades,
  page,
  pageSize,
  total,
  totalPages,
  sortBy,
  sortDirection,
  isFetching,
  onPageChange,
  onSort,
  onOpenCycle,
}: {
  trades: TradePerformanceTradeRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sortBy: TradePerformanceSortBy;
  sortDirection: TradePerformanceSortDirection;
  isFetching: boolean;
  onPageChange: (page: number) => void;
  onSort: (sortBy: TradePerformanceSortBy) => void;
  onOpenCycle: (cycleId: number) => void;
}) {
  if (trades.length === 0) {
    return (
      <Stack gap="sm">
        <Text c="dimmed">No completed trades match these filters.</Text>
        {total > 0 && (
          <PerformancePaginationFooter
            page={page}
            pageSize={pageSize}
            total={total}
            totalPages={totalPages}
            rowCount={trades.length}
            isFetching={isFetching}
            onPageChange={onPageChange}
          />
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <ScrollArea>
        <Table striped highlightOnHover withTableBorder miw={1240}>
          <Table.Thead>
            <Table.Tr>
              <PerformanceSortHeader
                column="symbol"
                label="Symbol"
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSort={onSort}
              />
              <Table.Th>Mode</Table.Th>
              <PerformanceSortHeader
                column="openedAt"
                label="Opened"
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSort={onSort}
              />
              <PerformanceSortHeader
                column="closedAt"
                label="Closed"
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSort={onSort}
              />
              <Table.Th ta="right">Qty</Table.Th>
              <Table.Th ta="right">Avg Entry</Table.Th>
              <Table.Th ta="right">Avg Exit</Table.Th>
              <PerformanceSortHeader
                column="realizedPnl"
                label="P/L"
                align="right"
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSort={onSort}
              />
              <PerformanceSortHeader
                column="returnPct"
                label="Return"
                align="right"
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSort={onSort}
              />
              <PerformanceSortHeader
                column="holdingDurationMs"
                label="Hold"
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSort={onSort}
              />
              <Table.Th>Strategy</Table.Th>
              <Table.Th>Entry Decision</Table.Th>
              <Table.Th>Exit</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {trades.map((trade) => (
              <Table.Tr key={trade.id}>
                <Table.Td>
                  <Text fw={700}>{trade.symbol}</Text>
                  <Text size="xs" c="dimmed">
                    {trade.side}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light">
                    {trade.mode ?? "-"}
                  </Badge>
                </Table.Td>
                <Table.Td>{formatDate(trade.openedAt)}</Table.Td>
                <Table.Td>{formatDate(trade.closedAt)}</Table.Td>
                <Table.Td ta="right">{formatNumber(trade.quantity)}</Table.Td>
                <Table.Td ta="right">{formatMoney(trade.avgEntryPrice)}</Table.Td>
                <Table.Td ta="right">{formatMoney(trade.avgExitPrice)}</Table.Td>
                <Table.Td ta="right">
                  <Text fw={700} c={pnlTextColor(trade.realizedPnl)} size="sm">
                    {formatMoney(trade.realizedPnl)}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Text fw={700} c={pnlTextColor(trade.returnPct)} size="sm">
                    {formatPercent(trade.returnPct)}
                  </Text>
                </Table.Td>
                <Table.Td>{formatDuration(trade.holdingDurationMs)}</Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    <Text size="sm">{trade.strategy?.name ?? "-"}</Text>
                    <Text size="xs" c="dimmed">
                      {trade.subscription?.name ?? trade.subscription?.key ?? "-"}
                    </Text>
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    {trade.entryDecision ? (
                      <>
                        <Badge
                          size="xs"
                          variant="light"
                          color={decisionColor(
                            trade.entryDecision.decisionState
                          )}
                        >
                          {trade.entryDecision.decisionState}
                        </Badge>
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {trade.entryDecision.decisionReason ??
                            trade.entryDecision.blockingReason ??
                            trade.entryDecision.persistenceReason}
                        </Text>
                      </>
                    ) : (
                      <Text size="sm">-</Text>
                    )}
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    <Text size="sm">{trade.exitProfile?.name ?? "-"}</Text>
                    <Text size="xs" c="dimmed">
                      {trade.exitReason ?? "-"}
                    </Text>
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconFileAnalytics size={14} />}
                    onClick={() => onOpenCycle(trade.id)}
                  >
                    Lifecycle
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>

      <PerformancePaginationFooter
        page={page}
        pageSize={pageSize}
        total={total}
        totalPages={totalPages}
        rowCount={trades.length}
        isFetching={isFetching}
        onPageChange={onPageChange}
      />
    </Stack>
  );
}

export function ReportsPage() {
  const [token] = useState(() => getAdminToken());

  const [snapshotLimit, setSnapshotLimit] = useState(20);
  const [activityLimit, setActivityLimit] = useState(20);
  const [reportTimespan, setReportTimespan] = useState("all");
  const [reportModeFilter, setReportModeFilter] = useState("all");
  const [symbolFilter, setSymbolFilter] = useState("");
  const [activityTypeFilter, setActivityTypeFilter] = useState<string | null>(
    "FILL"
  );
  const [performanceSymbolFilter, setPerformanceSymbolFilter] = useState("");
  const [performanceStrategyId, setPerformanceStrategyId] = useState<string | null>(null);
  const [performanceSubscriptionId, setPerformanceSubscriptionId] = useState<string | null>(null);
  const [performanceExitProfileId, setPerformanceExitProfileId] = useState<string | null>(null);
  const [performanceExitReason, setPerformanceExitReason] = useState<string | null>(null);
  const [performanceOutcome, setPerformanceOutcome] =
    useState<TradePerformanceOutcome>("all");
  const [performancePage, setPerformancePage] = useState(1);
  const [performancePageSize, setPerformancePageSize] = useState(25);
  const [performanceSortBy, setPerformanceSortBy] =
    useState<TradePerformanceSortBy>("closedAt");
  const [performanceSortDirection, setPerformanceSortDirection] =
    useState<TradePerformanceSortDirection>("desc");
  const tradeCycleDrawer = useTradeCycleDrawer(token);
  const strategiesQuery = useStrategies(token);
  const subscriptionsQuery = useSubscriptions(token);
  const exitProfilesQuery = useExitProfiles(token);

  const brokerQuery = useMemo(() => {
    const query: BrokerActivitiesQuery = {
      limit: activityLimit,
    };

    const symbol = symbolFilter.trim().toUpperCase();

    if (symbol) {
      query.symbol = symbol;
    }

    if (activityTypeFilter) {
      query.activityType = activityTypeFilter;
    }

    return query;
  }, [activityLimit, activityTypeFilter, symbolFilter]);

  const accountSnapshotQuery = useMemo(() => {
    const dateFrom = getTimespanDateFrom(reportTimespan);

    return {
      limit: snapshotLimit,
      ...(reportModeFilter !== "all" ? { mode: reportModeFilter } : {}),
      ...(dateFrom ? { dateFrom } : {}),
    };
  }, [reportModeFilter, reportTimespan, snapshotLimit]);

  const performanceQuery = useMemo<TradePerformanceQuery>(() => {
    const dateFrom = getTimespanDateFrom(reportTimespan);
    const symbol = performanceSymbolFilter.trim().toUpperCase();

    return {
      page: performancePage,
      pageSize: performancePageSize,
      sortBy: performanceSortBy,
      sortDirection: performanceSortDirection,
      ...(reportModeFilter !== "all" ? { mode: reportModeFilter } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(symbol ? { symbol } : {}),
      ...(performanceStrategyId ? { strategyId: Number(performanceStrategyId) } : {}),
      ...(performanceSubscriptionId
        ? { subscriptionId: Number(performanceSubscriptionId) }
        : {}),
      ...(performanceExitProfileId
        ? { exitProfileId: Number(performanceExitProfileId) }
        : {}),
      ...(performanceExitReason ? { exitReason: performanceExitReason } : {}),
      ...(performanceOutcome !== "all" ? { outcome: performanceOutcome } : {}),
    };
  }, [
    performanceExitProfileId,
    performanceExitReason,
    performanceOutcome,
    performancePage,
    performancePageSize,
    performanceSortBy,
    performanceSortDirection,
    performanceStrategyId,
    performanceSubscriptionId,
    performanceSymbolFilter,
    reportModeFilter,
    reportTimespan,
  ]);

  const accountSnapshotsQuery = useAccountSnapshots(token, accountSnapshotQuery);
  const accountSnapshotTrendsQuery = useAccountSnapshotTrends(
    token,
    accountSnapshotQuery
  );
  const brokerActivitiesQuery = useBrokerActivities(token, brokerQuery);
  const tradePerformanceQuery = useTradePerformance(token, performanceQuery);

  const manualSnapshotMutation = useCreateManualAccountSnapshot(token);
  const brokerSyncMutation = useSyncBrokerActivities(token);

  const snapshots = accountSnapshotsQuery.data?.snapshots ?? [];
  const trendSnapshots = accountSnapshotTrendsQuery.data?.snapshots ?? [];
  const activities = brokerActivitiesQuery.data?.activities ?? [];
  const performance = tradePerformanceQuery.data;
  const performanceTrades = performance?.trades ?? [];
  const performancePagination = performance?.pagination;
  const latestSnapshot = snapshots[0];
  const accountTrendData = trendSnapshots.map((snapshot) => ({
    ...snapshot,
    grossExposure: snapshot.exposure.grossExposure,
    grossExposurePct: snapshot.exposure.grossExposurePct,
  }));
  const strategyOptions = [
    { value: "", label: "All strategies" },
    ...(strategiesQuery.data ?? []).map((strategy) => ({
      value: String(strategy.id),
      label: strategy.name,
    })),
  ];
  const subscriptionOptions = [
    { value: "", label: "All subscriptions" },
    ...(subscriptionsQuery.data ?? []).map((subscription) => ({
      value: String(subscription.id),
      label: subscription.key,
    })),
  ];
  const exitProfileOptions = [
    { value: "", label: "All exit profiles" },
    ...(exitProfilesQuery.data ?? []).map((profile) => ({
      value: String(profile.id),
      label: profile.name,
    })),
  ];
  const exitReasonOptions = [
    { value: "", label: "All exit reasons" },
    ...Array.from(
      new Set([
        ...(performance?.groups.byExitReason ?? [])
          .map((group) => group.id)
          .filter((value) => value !== "unknown"),
        ...(performanceExitReason ? [performanceExitReason] : []),
      ])
    ).map((reason) => ({ value: reason, label: reason })),
  ];

  function resetPerformancePage() {
    setPerformancePage(1);
  }

  function clearPerformanceFilters() {
    setPerformanceSymbolFilter("");
    setPerformanceStrategyId(null);
    setPerformanceSubscriptionId(null);
    setPerformanceExitProfileId(null);
    setPerformanceExitReason(null);
    setPerformanceOutcome("all");
    setPerformancePage(1);
  }

  function handlePerformanceSort(nextSortBy: TradePerformanceSortBy) {
    setPerformancePage(1);

    if (performanceSortBy === nextSortBy) {
      setPerformanceSortDirection((current) =>
        current === "asc" ? "desc" : "asc"
      );
      return;
    }

    setPerformanceSortBy(nextSortBy);
    setPerformanceSortDirection(nextSortBy === "symbol" ? "asc" : "desc");
  }

  async function handleManualSnapshot() {
    try {
      const result = await manualSnapshotMutation.mutateAsync();

      notifications.show({
        color: "teal",
        message: result.created
          ? "Account snapshot recorded."
          : "Account snapshot skipped.",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        message:
          error instanceof Error
            ? error.message
            : "Failed to record account snapshot.",
      });
    }
  }

  async function handleBrokerSync() {
    try {
      const result = await brokerSyncMutation.mutateAsync();

      notifications.show({
        color: "teal",
        message: `Broker sync complete. Seen: ${result.seen}, created: ${result.created}, updated: ${result.updated}.`,
      });
    } catch (error) {
      notifications.show({
        color: "red",
        message:
          error instanceof Error
            ? error.message
            : "Failed to sync broker activities.",
      });
    }
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Reports</Title>
          <Text c="dimmed">
            Account snapshots and broker-confirmed activity for production
            auditing.
          </Text>
        </div>

        <Group align="flex-end">
          <Select
            label="Mode"
            value={reportModeFilter}
            onChange={(value) => {
              setReportModeFilter(value ?? "all");
              setPerformancePage(1);
            }}
            data={[
              { value: "all", label: "All" },
              { value: "paper", label: "Paper" },
              { value: "live", label: "Live" },
            ]}
            w={120}
          />

          <Select
            label="Timespan"
            value={reportTimespan}
            onChange={(value) => {
              setReportTimespan(value ?? "all");
              setPerformancePage(1);
            }}
            data={[
              { value: "today", label: "Today" },
              { value: "7d", label: "7 days" },
              { value: "30d", label: "30 days" },
              { value: "90d", label: "90 days" },
              { value: "ytd", label: "YTD" },
              { value: "1y", label: "1 year" },
              { value: "all", label: "All time" },
            ]}
            w={140}
          />

          <Button
            variant="default"
            onClick={handleManualSnapshot}
            loading={manualSnapshotMutation.isPending}
          >
            Record Account Snapshot
          </Button>

          <Button
            onClick={handleBrokerSync}
            loading={brokerSyncMutation.isPending}
          >
            Sync Broker Fills
          </Button>
        </Group>
      </Group>

      {latestSnapshot && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Latest Snapshot
            </Text>
            <Text fw={700}>{formatDate(latestSnapshot.createdAt)}</Text>
            <Badge variant="light" color={latestSnapshot.changed ? "teal" : "gray"}>
              {latestSnapshot.reason}
            </Badge>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Cash
            </Text>
            <Text fw={700}>{formatMoney(latestSnapshot.cash)}</Text>
            <Text size="xs" c="dimmed">
              Buying power: {formatMoney(latestSnapshot.buyingPower)}
            </Text>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Equity
            </Text>
            <Text fw={700}>{formatMoney(latestSnapshot.equity)}</Text>
            <Text size="xs" c="dimmed">
              Portfolio: {formatMoney(latestSnapshot.portfolioValue)}
            </Text>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Day P/L
            </Text>
            <Text fw={700}>{formatMoney(latestSnapshot.dayPnL)}</Text>
            <Text size="xs" c="dimmed">
              {latestSnapshot.dayPnLPct === null
                ? "-"
                : `${latestSnapshot.dayPnLPct.toFixed(3)}%`}
            </Text>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Gross Exposure
            </Text>
            <Text fw={700}>
              {formatMoney(latestSnapshot.exposure.grossExposure)}
            </Text>
            <Text size="xs" c="dimmed">
              {formatExposurePercent(latestSnapshot.exposure.grossExposurePct)}
            </Text>
          </Card>
        </SimpleGrid>
      )}

      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={3}>Trade Performance</Title>
              <Text size="sm" c="dimmed">
                Closed trade-cycle results grouped by lifecycle ownership.
              </Text>
            </div>
          </Group>

          <Divider />

          <Group align="flex-end">
            <TextInput
              label="Symbol"
              placeholder="SPY"
              value={performanceSymbolFilter}
              onChange={(event) => {
                setPerformanceSymbolFilter(event.currentTarget.value);
                resetPerformancePage();
              }}
              w={110}
            />

            <Select
              label="Strategy"
              value={performanceStrategyId ?? ""}
              onChange={(value) => {
                setPerformanceStrategyId(value || null);
                resetPerformancePage();
              }}
              data={strategyOptions}
              searchable
              w={190}
            />

            <Select
              label="Subscription"
              value={performanceSubscriptionId ?? ""}
              onChange={(value) => {
                setPerformanceSubscriptionId(value || null);
                resetPerformancePage();
              }}
              data={subscriptionOptions}
              searchable
              w={190}
            />

            <Select
              label="Exit profile"
              value={performanceExitProfileId ?? ""}
              onChange={(value) => {
                setPerformanceExitProfileId(value || null);
                resetPerformancePage();
              }}
              data={exitProfileOptions}
              searchable
              w={190}
            />

            <Select
              label="Exit reason"
              value={performanceExitReason ?? ""}
              onChange={(value) => {
                setPerformanceExitReason(value || null);
                resetPerformancePage();
              }}
              data={exitReasonOptions}
              searchable
              w={180}
            />

            <Select
              label="Outcome"
              value={performanceOutcome}
              onChange={(value) => {
                setPerformanceOutcome(
                  (value as TradePerformanceOutcome | null) ?? "all"
                );
                resetPerformancePage();
              }}
              data={[
                { value: "all", label: "All" },
                { value: "winner", label: "Winners" },
                { value: "loser", label: "Losers" },
                { value: "breakeven", label: "Breakeven" },
              ]}
              w={140}
            />

            <Select
              label="Rows"
              value={String(performancePageSize)}
              onChange={(value) => {
                setPerformancePageSize(Number(value ?? 25));
                resetPerformancePage();
              }}
              data={[
                { value: "10", label: "10" },
                { value: "25", label: "25" },
                { value: "50", label: "50" },
                { value: "100", label: "100" },
              ]}
              w={100}
            />

            <Button variant="default" onClick={clearPerformanceFilters}>
              Clear
            </Button>
          </Group>

          {tradePerformanceQuery.isLoading && (
            <Group>
              <Loader size="sm" />
              <Text>Loading trade performance...</Text>
            </Group>
          )}

          {tradePerformanceQuery.isError && (
            <Alert color="red" title="Failed to load trade performance">
              Check the backend route and admin session.
            </Alert>
          )}

          {performance && (
            <Stack gap="lg">
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
                <Card withBorder radius="md" p="md">
                  <Text size="sm" c="dimmed">
                    Realized P/L
                  </Text>
                  <Text
                    fw={700}
                    c={
                      performance.summary.totalRealizedPnl >= 0
                        ? "teal"
                        : "red"
                    }
                  >
                    {formatMoney(performance.summary.totalRealizedPnl)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {performance.summary.reportableTradeCount} reportable trades
                  </Text>
                </Card>

                <Card withBorder radius="md" p="md">
                  <Text size="sm" c="dimmed">
                    Win Rate
                  </Text>
                  <Text fw={700}>
                    {formatPercent(performance.summary.winRate)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {performance.summary.winnerCount} wins /{" "}
                    {performance.summary.loserCount} losses
                  </Text>
                </Card>

                <Card withBorder radius="md" p="md">
                  <Text size="sm" c="dimmed">
                    Avg Return
                  </Text>
                  <Text fw={700}>
                    {formatPercent(performance.summary.averageReturnPct)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Per reportable trade
                  </Text>
                </Card>

                <Card withBorder radius="md" p="md">
                  <Text size="sm" c="dimmed">
                    Profit Factor
                  </Text>
                  <Text fw={700}>
                    {formatNumber(performance.summary.profitFactor)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Gross wins over gross losses
                  </Text>
                </Card>

                <Card withBorder radius="md" p="md">
                  <Text size="sm" c="dimmed">
                    Avg Hold
                  </Text>
                  <Text fw={700}>
                    {formatDuration(
                      performance.summary.averageHoldingDurationMs
                    )}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Closed cycle duration
                  </Text>
                </Card>
              </SimpleGrid>

              <SimpleGrid cols={{ base: 1, md: 2, xl: 4 }}>
                <Card withBorder radius="md" p="md">
                  <Stack gap="sm">
                    <Title order={4}>By Strategy</Title>
                    <PerformanceBarChart
                      data={performance.groups.byStrategy}
                      emptyLabel="No strategy results yet."
                    />
                  </Stack>
                </Card>

                <Card withBorder radius="md" p="md">
                  <Stack gap="sm">
                    <Title order={4}>By Entry Decision</Title>
                    <PerformanceBarChart
                      data={performance.groups.byEntryDecisionState}
                      emptyLabel="No decision-state results yet."
                    />
                  </Stack>
                </Card>

                <Card withBorder radius="md" p="md">
                  <Stack gap="sm">
                    <Title order={4}>By Symbol</Title>
                    <PerformanceBarChart
                      data={performance.groups.bySecurity}
                      emptyLabel="No symbol results yet."
                    />
                  </Stack>
                </Card>

                <Card withBorder radius="md" p="md">
                  <Stack gap="sm">
                    <Title order={4}>By Exit Reason</Title>
                    <PerformanceBarChart
                      data={performance.groups.byExitReason}
                      emptyLabel="No exit results yet."
                    />
                  </Stack>
                </Card>
              </SimpleGrid>

              <Card withBorder radius="md" p="md">
                <Stack gap="sm">
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Title order={4}>Trades</Title>
                      <Text size="sm" c="dimmed">
                        Completed trade cycles matching the current filters.
                      </Text>
                    </div>
                    {tradePerformanceQuery.isFetching && (
                      <Badge variant="light" color="blue">
                        Refreshing
                      </Badge>
                    )}
                  </Group>

                  <PerformanceTradesTable
                    trades={performanceTrades}
                    page={performancePagination?.page ?? performancePage}
                    pageSize={performancePagination?.pageSize ?? performancePageSize}
                    total={performancePagination?.total ?? 0}
                    totalPages={performancePagination?.totalPages ?? 1}
                    sortBy={performanceSortBy}
                    sortDirection={performanceSortDirection}
                    isFetching={tradePerformanceQuery.isFetching}
                    onPageChange={setPerformancePage}
                    onSort={handlePerformanceSort}
                    onOpenCycle={tradeCycleDrawer.openCycle}
                  />
                </Stack>
              </Card>
            </Stack>
          )}
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 3 }}>
        <Card withBorder radius="md" p="lg">
          <Stack gap="sm">
            <div>
              <Title order={3}>Account Value</Title>
              <Text size="sm" c="dimmed">
                Equity and portfolio value over the selected snapshot range.
              </Text>
            </div>

            {accountSnapshotTrendsQuery.isLoading && (
              <Group>
                <Loader size="sm" />
                <Text>Loading account trends...</Text>
              </Group>
            )}

            {accountSnapshotTrendsQuery.isError && (
              <Alert color="red" title="Failed to load account trends">
                Check the backend route and admin session.
              </Alert>
            )}

            {!accountSnapshotTrendsQuery.isLoading &&
              !accountSnapshotTrendsQuery.isError && (
                <AccountTrendChart
                  data={accountTrendData}
                  emptyLabel="No account snapshots match these filters."
                  lines={[
                    {
                      dataKey: "equity",
                      name: "Equity",
                      stroke: "var(--mantine-color-blue-6)",
                    },
                    {
                      dataKey: "portfolioValue",
                      name: "Portfolio value",
                      stroke: "var(--mantine-color-teal-6)",
                    },
                  ]}
                  valueFormatter={formatMoney}
                  yAxisFormatter={(value) => `$${Number(value).toLocaleString()}`}
                />
              )}
          </Stack>
        </Card>

        <Card withBorder radius="md" p="lg">
          <Stack gap="sm">
            <div>
              <Title order={3}>Capital Allocation</Title>
              <Text size="sm" c="dimmed">
                Cash compared with gross market exposure.
              </Text>
            </div>

            {accountSnapshotTrendsQuery.isLoading && (
              <Group>
                <Loader size="sm" />
                <Text>Loading allocation trends...</Text>
              </Group>
            )}

            {accountSnapshotTrendsQuery.isError && (
              <Alert color="red" title="Failed to load allocation trends">
                Check the backend route and admin session.
              </Alert>
            )}

            {!accountSnapshotTrendsQuery.isLoading &&
              !accountSnapshotTrendsQuery.isError && (
                <AccountTrendChart
                  data={accountTrendData}
                  emptyLabel="No account snapshots match these filters."
                  unavailableLabel="Exposure data is unavailable for these historical snapshots."
                  lines={[
                    {
                      dataKey: "cash",
                      name: "Cash",
                      stroke: "var(--mantine-color-green-6)",
                    },
                    {
                      dataKey: "grossExposure",
                      name: "Gross exposure",
                      stroke: "var(--mantine-color-orange-6)",
                    },
                  ]}
                  valueFormatter={formatMoney}
                  yAxisFormatter={(value) => `$${Number(value).toLocaleString()}`}
                />
              )}
          </Stack>
        </Card>

        <Card withBorder radius="md" p="lg">
          <Stack gap="sm">
            <div>
              <Title order={3}>Exposure Percent</Title>
              <Text size="sm" c="dimmed">
                Gross exposure as a percentage of account equity.
              </Text>
            </div>

            {accountSnapshotTrendsQuery.isLoading && (
              <Group>
                <Loader size="sm" />
                <Text>Loading exposure trends...</Text>
              </Group>
            )}

            {accountSnapshotTrendsQuery.isError && (
              <Alert color="red" title="Failed to load exposure trends">
                Check the backend route and admin session.
              </Alert>
            )}

            {!accountSnapshotTrendsQuery.isLoading &&
              !accountSnapshotTrendsQuery.isError && (
                <AccountTrendChart
                  data={accountTrendData}
                  emptyLabel="No account snapshots match these filters."
                  unavailableLabel="Exposure percentage is unavailable for these historical snapshots."
                  lines={[
                    {
                      dataKey: "grossExposurePct",
                      name: "Gross exposure",
                      stroke: "var(--mantine-color-violet-6)",
                    },
                  ]}
                  valueFormatter={formatExposurePercent}
                  yAxisFormatter={(value) => `${Number(value).toFixed(0)}%`}
                />
              )}
          </Stack>
        </Card>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card withBorder radius="md" p="lg">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={3}>Account Snapshots</Title>
                <Text size="sm" c="dimmed">
                  Account-level cash, buying power, equity, and portfolio value
                  checkpoints.
                </Text>
              </div>

              <NumberInput
                label="Limit"
                value={snapshotLimit}
                min={1}
                max={200}
                w={110}
                onChange={(value) =>
                  setSnapshotLimit(normalizeLimit(value, snapshotLimit))
                }
              />
            </Group>

            <Divider />

            {accountSnapshotsQuery.isLoading && (
              <Group>
                <Loader size="sm" />
                <Text>Loading snapshots…</Text>
              </Group>
            )}

            {accountSnapshotsQuery.isError && (
              <Alert color="red" title="Failed to load account snapshots">
                Check the backend route and admin session.
              </Alert>
            )}

            {!accountSnapshotsQuery.isLoading && snapshots.length === 0 && (
              <Text c="dimmed">No account snapshots recorded yet.</Text>
            )}

            {snapshots.length > 0 && (
              <ScrollArea>
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Reason</Table.Th>
                      <Table.Th>Cash</Table.Th>
                      <Table.Th>Buying Power</Table.Th>
                      <Table.Th>Equity</Table.Th>
                      <Table.Th>Gross Exposure</Table.Th>
                      <Table.Th>Changed</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {snapshots.map((snapshot) => (
                      <Table.Tr key={snapshot.id}>
                        <Table.Td>{formatDate(snapshot.createdAt)}</Table.Td>
                        <Table.Td>
                          <Badge variant="light">{snapshot.reason}</Badge>
                        </Table.Td>
                        <Table.Td>{formatMoney(snapshot.cash)}</Table.Td>
                        <Table.Td>{formatMoney(snapshot.buyingPower)}</Table.Td>
                        <Table.Td>{formatMoney(snapshot.equity)}</Table.Td>
                        <Table.Td>
                          {formatMoney(snapshot.exposure.grossExposure)}
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={snapshot.changed ? "teal" : "gray"}
                            variant="light"
                          >
                            {snapshot.changed ? "Yes" : "No"}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Stack>
        </Card>

        <Card withBorder radius="md" p="lg">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={3}>Broker Activity</Title>
                <Text size="sm" c="dimmed">
                  Broker-confirmed fills and related account activity imported
                  from Alpaca.
                </Text>
              </div>

              <Group align="flex-end">
                <TextInput
                  label="Symbol"
                  placeholder="SPY"
                  value={symbolFilter}
                  onChange={(event) => setSymbolFilter(event.currentTarget.value)}
                  w={100}
                />

                <Select
                  label="Type"
                  value={activityTypeFilter}
                  onChange={setActivityTypeFilter}
                  data={[
                    { value: "FILL", label: "FILL" },
                    { value: "", label: "All" },
                  ]}
                  w={110}
                />

                <NumberInput
                  label="Limit"
                  value={activityLimit}
                  min={1}
                  max={200}
                  w={110}
                  onChange={(value) =>
                    setActivityLimit(normalizeLimit(value, activityLimit))
                  }
                />
              </Group>
            </Group>

            <Divider />

            {brokerActivitiesQuery.isLoading && (
              <Group>
                <Loader size="sm" />
                <Text>Loading broker activities…</Text>
              </Group>
            )}

            {brokerActivitiesQuery.isError && (
              <Alert color="red" title="Failed to load broker activities">
                Check the backend route and admin session.
              </Alert>
            )}

            {!brokerActivitiesQuery.isLoading && activities.length === 0 && (
              <Text c="dimmed">No broker activities found.</Text>
            )}

            {activities.length > 0 && (
              <ScrollArea>
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Symbol</Table.Th>
                      <Table.Th>Side</Table.Th>
                      <Table.Th>Qty</Table.Th>
                      <Table.Th>Price</Table.Th>
                      <Table.Th>Intent</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {activities.map((activity) => (
                      <Table.Tr key={activity.id}>
                        <Table.Td>
                          {formatDate(activity.transactionTime)}
                        </Table.Td>
                        <Table.Td>
                          <Badge variant="light">{activity.activityType}</Badge>
                        </Table.Td>
                        <Table.Td>{activity.symbol ?? "-"}</Table.Td>
                        <Table.Td>
                          <Badge
                            color={sideColor(activity.side)}
                            variant="light"
                          >
                            {activity.side ?? "-"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>{formatNumber(activity.qty)}</Table.Td>
                        <Table.Td>{formatMoney(activity.price)}</Table.Td>
                        <Table.Td>
                          {activity.orderIntentId === null
                            ? "-"
                            : activity.orderIntentId}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      <TradeCycleDrawer
        {...tradeCycleDrawer.drawerProps}
        onClose={tradeCycleDrawer.closeCycle}
      />
    </Stack>
  );
}
