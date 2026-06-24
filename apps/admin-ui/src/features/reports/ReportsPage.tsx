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

  const performanceQuery = useMemo(() => {
    const dateFrom = getTimespanDateFrom(reportTimespan);

    return {
      limit: 5000,
      ...(reportModeFilter !== "all" ? { mode: reportModeFilter } : {}),
      ...(dateFrom ? { dateFrom } : {}),
    };
  }, [reportModeFilter, reportTimespan]);

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
  const latestSnapshot = snapshots[0];
  const accountTrendData = trendSnapshots.map((snapshot) => ({
    ...snapshot,
    grossExposure: snapshot.exposure.grossExposure,
    grossExposurePct: snapshot.exposure.grossExposurePct,
  }));

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
            onChange={(value) => setReportModeFilter(value ?? "all")}
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
            onChange={(value) => setReportTimespan(value ?? "all")}
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

              <SimpleGrid cols={{ base: 1, lg: 3 }}>
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
    </Stack>
  );
}
