import { useState } from "react";
import {
  Badge,
  Box,
  Card,
  Divider,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getAdminToken } from "../lib/api";
import {
  useBootstrap,
  useIndexIntraday,
  useIndexPerformance,
  useSystemEvents,
} from "../features/dashboard/hooks";
import type {
  BrokerPosition,
  BrokerOpenOrder,
  IndexChartSummary,
  IndexChartRange,
  IndexIntradayResponse,
  IndexIntradaySymbol,
  IndexPerformanceResponse,
  IndexPerformanceSymbol,
  SystemEvent,
} from "../features/dashboard/types";
import { describeEvent } from "../features/dashboard/eventUtils";

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPrice(value: number | null | undefined) {
  return formatMoney(value);
}

function formatSignedMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  const formatted = formatMoney(Math.abs(value));

  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

function formatSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  const formatted = `${Math.abs(value).toFixed(2)}%`;

  if (value > 0) return `${formatted}`;
  if (value < 0) return `- ${formatted}`;
  return formatted;
}

function formatMarketSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  const formatted = `${Math.abs(value).toFixed(2)}%`;

  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function performanceColor(value: number | null | undefined) {
  if (value === null || value === undefined) return "dimmed";
  if (value > 0) return "teal";
  if (value < 0) return "red";
  return "dimmed";
}

const indexChartRangeOptions: Array<{ label: string; value: IndexChartRange }> = [
  { label: "1D", value: "1d" },
  { label: "7D", value: "7d" },
  { label: "14D", value: "14d" },
  { label: "30D", value: "30d" },
  { label: "6M", value: "6m" },
  { label: "1Y", value: "1y" },
];

function PnLText({ format, value }: { format: string, value: number; }) {
  const fmt = format;
  const color = value > 0 ? "teal" : value < 0 ? "red" : "dimmed";
  if (fmt == 'percent') {
    return (
      <Text component="span" c={color} >
        {formatSignedPercent(value)}
      </Text>
    )
  }
  return (
    <Text component="span" c={color} fw={600} size="sm">
      {formatMoney(value)}
    </Text>
  );
}

function StatCard({
  label,
  value,
  subValue,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  subValue?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <Card withBorder radius="md" p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: "0.07em" }} mb={6}>
        {label}
      </Text>
      {loading ? (
        <Skeleton height={28} width="60%" radius="sm" />
      ) : (
        <Text size="xl" fw={700}>
          {value}
        </Text>
      )}
      {subValue && !loading && (
        <Box mt={4}>{subValue}</Box>
      )}
    </Card>
  );
}

function PositionsTable({ positions }: { positions: BrokerPosition[] }) {
  if (positions.length === 0) {
    return <Text size="sm" c="dimmed" py="sm">No open positions.</Text>;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover style={{ minWidth: 480 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Symbol</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Last Price</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Avg Cost</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Mkt Value</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Unrealized P/L</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>P/L %</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {positions.map((p) => (
            <Table.Tr key={p.symbol}>
              <Table.Td fw={600}>{p.symbol}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>{fmt(p.qty, 0)}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>${fmt(p.currentPrice)}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>${fmt(p.avgEntryPrice)}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>${fmt(p.marketValue)}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                <PnLText format ="money" value={p.unrealizedPnL} />
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                <PnLText format="percent" value={p.unrealizedPnLPct * 100} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function OrdersTable({ orders }: { orders: BrokerOpenOrder[] }) {
  if (orders.length === 0) {
    return <Text size="sm" c="dimmed" py="sm">No open orders.</Text>;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover style={{ minWidth: 520 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Symbol</Table.Th>
            <Table.Th>Side</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Limit</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {orders.map((o) => (
            <Table.Tr key={o.id}>
              <Table.Td fw={600}>{o.symbol}</Table.Td>
              <Table.Td>
                <Badge size="sm" color={o.side === "buy" ? "teal" : "red"} variant="light">
                  {o.side}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm" tt="capitalize">{o.orderType.replace(/_/g, " ")}</Text>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {o.qty != null ? fmt(o.qty, 0) : o.notional != null ? `$${fmt(o.notional)}` : "—"}
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {o.limitPrice != null ? `$${fmt(o.limitPrice)}` : "—"}
              </Table.Td>
              <Table.Td>
                <Badge size="sm" color="yellow" variant="light">{o.status}</Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function SparklineTooltip({
  active,
  dateOnly,
  payload,
}: {
  active?: boolean;
  dateOnly: boolean;
  payload?: Array<{
    payload?: {
      close?: number;
      time?: string;
    };
  }>;
}) {
  const point = payload?.[0]?.payload;

  if (!active || !point) {
    return null;
  }

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
      <Text size="xs" c="gray.2">
        {dateOnly ? formatDate(point.time) : formatDateTime(point.time)}
      </Text>
      <Text size="xs" fw={700} c="gray.1">{formatPrice(point.close)}</Text>
    </Box>
  );
}

function getRangeSummary(
  symbol: IndexPerformanceSymbol,
  intraday: IndexIntradaySymbol | undefined
): IndexChartSummary {
  return {
    open: intraday?.summary.open ?? symbol.previousClose,
    close: intraday?.summary.close ?? symbol.lastPrice,
    change: intraday?.summary.change ?? symbol.todayChange,
    changePercent: intraday?.summary.changePercent ?? symbol.todayChangePercent,
    high: intraday?.summary.high ?? symbol.dayHigh,
    low: intraday?.summary.low ?? symbol.dayLow,
  };
}

function IndexSparkline({
  dateOnly,
  intraday,
  loading,
}: {
  dateOnly: boolean;
  intraday: IndexIntradaySymbol | undefined;
  loading: boolean;
}) {
  const points = intraday?.points ?? [];

  if (loading) {
    return <Skeleton height={48} radius="sm" mt="sm" />;
  }

  if (points.length < 2) {
    return (
      <Box h={48} mt="sm" style={{ display: "flex", alignItems: "center" }}>
        <Text size="xs" c="dimmed">No intraday bars available.</Text>
      </Box>
    );
  }

  const first = points[0]?.close ?? 0;
  const last = points.at(-1)?.close ?? first;
  const stroke = last >= first ? "#14b8a6" : "#ef4444";

  return (
    <Box h={48} mt="sm">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 6, right: 0, bottom: 6, left: 0 }}>
          <YAxis
            hide
            type="number"
            domain={["dataMin", "dataMax"]}
          />
          <Tooltip
            cursor={{ stroke: "rgba(203, 213, 225, 0.24)" }}
            content={<SparklineTooltip dateOnly={dateOnly} />}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke={stroke}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}

function IndexMarketPulseCard({
  chartRange,
  intraday,
  intradayLoading,
  symbol,
}: {
  chartRange: IndexChartRange;
  intraday: IndexIntradaySymbol | undefined;
  intradayLoading: boolean;
  symbol: IndexPerformanceSymbol;
}) {
  const summary = getRangeSummary(symbol, intraday);
  const color = performanceColor(summary.changePercent);
  const dateOnly = chartRange === "6m" || chartRange === "1y";

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" align="flex-start" mb="sm">
        <div>
          <Text fw={700} size="lg">{symbol.symbol}</Text>
        </div>
      </Group>
      <Text size="xl" fw={700}>{formatPrice(summary.close)}</Text>
      <Group gap="xs" mt={4}>
        <Text c={color} fw={700} size="sm">
          {formatMarketSignedPercent(summary.changePercent)}
        </Text>
        <Text c={color} size="sm">
          {formatSignedMoney(summary.change)}
        </Text>
      </Group>
      <Group gap="lg" mt="sm">
        <Text size="xs" c="dimmed">O {formatPrice(summary.open)}</Text>
        <Text size="xs" c="dimmed">H {formatPrice(summary.high)}</Text>
        <Text size="xs" c="dimmed">L {formatPrice(summary.low)}</Text>
        <Text size="xs" c="dimmed">C {formatPrice(summary.close)}</Text>
      </Group>
      <IndexSparkline
        dateOnly={dateOnly}
        intraday={intraday}
        loading={intradayLoading}
      />
    </Card>
  );
}

function IndexMarketPulseTable({
  intradayBySymbol,
  symbols,
}: {
  intradayBySymbol: Map<IndexPerformanceSymbol["symbol"], IndexIntradaySymbol>;
  symbols: IndexPerformanceSymbol[];
}) {
  return (
    <ScrollArea>
      <Table striped highlightOnHover style={{ minWidth: 760 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Symbol</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Change %</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Change</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Open</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>High</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Low</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Close</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Prev Close</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {symbols.map((symbol) => {
            const summary = getRangeSummary(
              symbol,
              intradayBySymbol.get(symbol.symbol)
            );
            const color = performanceColor(summary.changePercent);

            return (
              <Table.Tr key={symbol.symbol}>
                <Table.Td fw={700}>{symbol.symbol}</Table.Td>
                <Table.Td style={{ textAlign: "right" }}>
                  <Text c={color} size="sm" fw={700}>
                    {formatMarketSignedPercent(summary.changePercent)}
                  </Text>
                </Table.Td>
                <Table.Td style={{ textAlign: "right" }}>
                  <Text c={color} size="sm">
                    {formatSignedMoney(summary.change)}
                  </Text>
                </Table.Td>
                <Table.Td style={{ textAlign: "right" }}>{formatPrice(summary.open)}</Table.Td>
                <Table.Td style={{ textAlign: "right" }}>{formatPrice(summary.high)}</Table.Td>
                <Table.Td style={{ textAlign: "right" }}>{formatPrice(summary.low)}</Table.Td>
                <Table.Td style={{ textAlign: "right" }}>{formatPrice(summary.close)}</Table.Td>
                <Table.Td style={{ textAlign: "right" }}>{formatPrice(symbol.previousClose)}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function PercentChangeTooltip({
  active,
  label,
  payload,
}: {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ value?: number | string }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const value = Number(payload[0]?.value ?? 0);

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
      <Text size="xs" fw={700} c="gray.2">{label}</Text>
      <Text size="xs" c={value >= 0 ? "teal.3" : "red.3"}>
        Change {formatMarketSignedPercent(value)}
      </Text>
    </Box>
  );
}

function IndexPercentChangeChart({
  intradayBySymbol,
  symbols,
}: {
  intradayBySymbol: Map<IndexPerformanceSymbol["symbol"], IndexIntradaySymbol>;
  symbols: IndexPerformanceSymbol[];
}) {
  const data = symbols.map((symbol) => {
    const summary = getRangeSummary(symbol, intradayBySymbol.get(symbol.symbol));

    return {
      symbol: symbol.symbol,
      changePercent: summary.changePercent ?? 0,
      hasValue: summary.changePercent !== null,
    };
  });

  return (
    <Box>
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">Current Percent Change</Text>
        <Text size="xs" c="dimmed">10 second refresh</Text>
      </Group>
      <Box h={180}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(value) => `${Number(value).toFixed(1)}%`}
              stroke="rgba(203, 213, 225, 0.64)"
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              dataKey="symbol"
              type="category"
              width={42}
              stroke="rgba(203, 213, 225, 0.84)"
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: "rgba(148, 163, 184, 0.08)" }}
              content={<PercentChangeTooltip />}
            />
            <ReferenceLine x={0} stroke="rgba(203, 213, 225, 0.36)" />
            <Bar dataKey="changePercent" radius={[4, 4, 4, 4]} barSize={20}>
              {data.map((item) => (
                <Cell
                  key={item.symbol}
                  fill={
                    !item.hasValue
                      ? "#64748b"
                      : item.changePercent >= 0
                        ? "#14b8a6"
                        : "#ef4444"
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Box>
    </Box>
  );
}

function IndexMarketPulse({
  data,
  chartRange,
  intradayData,
  intradayError,
  intradayLoading,
  onChartRangeChange,
  loading,
  error,
}: {
  data: IndexPerformanceResponse | undefined;
  chartRange: IndexChartRange;
  intradayData: IndexIntradayResponse | undefined;
  intradayError: Error | null;
  intradayLoading: boolean;
  onChartRangeChange: (range: IndexChartRange) => void;
  loading: boolean;
  error: Error | null;
}) {
  const symbols = data?.symbols ?? [];
  const latestSymbolUpdate = symbols
    .map((symbol) => symbol.updatedTime)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const intradayBySymbol = new Map(
    (intradayData?.symbols ?? []).map((symbol) => [symbol.symbol, symbol])
  );

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="md" align="flex-start">
        <div>
          <Text fw={600} size="sm">Index Market Pulse</Text>
          <Text size="xs" c="dimmed">
            SPY, QQQ, DIA, and IWM from Massive market data
          </Text>
        </div>
        <Stack gap="xs" align="flex-end">
          <Group gap="xs">
            {data?.marketStatus && (
              <Badge color={data.marketStatus === "open" ? "teal" : "gray"} variant="light">
                Market {data.marketStatus}
              </Badge>
            )}
            {latestSymbolUpdate && (
              <Text size="xs" c="dimmed">
                Updated {formatDateTime(latestSymbolUpdate.toISOString())}
              </Text>
            )}
            {data?.serverTime && (
              <Text size="xs" c="dimmed">
                Server {formatDateTime(data.serverTime)}
              </Text>
            )}
            {loading && <Loader size="xs" color="cyan" />}
          </Group>
          <SegmentedControl
            aria-label="Index chart timeframe"
            data={indexChartRangeOptions}
            onChange={(value) => onChartRangeChange(value as IndexChartRange)}
            size="xs"
            value={chartRange}
          />
        </Stack>
      </Group>

      {error ? (
        <Box p="sm" style={{ border: "1px solid rgba(248, 113, 113, 0.35)", borderRadius: 8 }}>
          <Text size="sm" c="red" fw={600}>Market data unavailable</Text>
          <Text size="xs" c="dimmed">{error.message}</Text>
        </Box>
      ) : loading ? (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={126} radius="md" />
            ))}
          </SimpleGrid>
          <Skeleton height={160} radius="md" />
        </Stack>
      ) : (
        <Stack gap="md">
          <IndexPercentChangeChart
            intradayBySymbol={intradayBySymbol}
            symbols={symbols}
          />
          {intradayError && (
            <Text size="xs" c="dimmed">
              Intraday sparklines unavailable: {intradayError.message}
            </Text>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
            {symbols.map((symbol) => (
              <IndexMarketPulseCard
                key={symbol.symbol}
                chartRange={chartRange}
                intraday={intradayBySymbol.get(symbol.symbol)}
                intradayLoading={intradayLoading}
                symbol={symbol}
              />
            ))}
          </SimpleGrid>
          <IndexMarketPulseTable
            intradayBySymbol={intradayBySymbol}
            symbols={symbols}
          />
        </Stack>
      )}
    </Card>
  );
}

const hiddenDashboardEventTypes = new Set([
  "broker_activity.synced",
  "order.filled",
  "order.new",
]);

function shouldShowDashboardEvent(event: SystemEvent) {
  return !hiddenDashboardEventTypes.has(event.type);
}

function EventFeed({ events }: { events: SystemEvent[] }) {
  if (events.length === 0) {
    return <Text size="sm" c="dimmed" py="sm">No recent events.</Text>;
  }

  const recentEvents = events.filter(
    shouldShowDashboardEvent
  );

  return (
    <Stack gap={0}>
      {recentEvents.map((ev, i) => {
        const { label, description, color } = describeEvent(ev);
        return (
          <Box key={ev.id}>
            {i > 0 && <Divider />}
            <Group py="xs" gap="sm" wrap="nowrap">
              <Badge
                size="sm"
                color={color}
                variant="light"
                style={{ flexShrink: 0, minWidth: 88, textAlign: "center" }}
              >
                {label}
              </Badge>
              <Text size="sm" style={{ flex: 1 }}>
                {description}
              </Text>
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                {new Date(ev.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </Text>
            </Group>
          </Box>
        );
      })}
    </Stack>
  );
}

export function DashboardPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [indexChartRange, setIndexChartRange] =
    useState<IndexChartRange>("1d");
  const { data: bootstrap, isLoading: bootstrapLoading } = useBootstrap(token);
  const { data: events, isLoading: eventsLoading } = useSystemEvents(token, 50);
  const {
    data: indexPerformance,
    error: indexPerformanceError,
    isLoading: indexPerformanceLoading,
  } = useIndexPerformance(token);
  const {
    data: indexIntraday,
    error: indexIntradayError,
    isLoading: indexIntradayLoading,
  } = useIndexIntraday(token, indexChartRange);

  const account = bootstrap?.account;
  const positions = bootstrap?.positions ?? [];
  const openOrders = bootstrap?.openOrders ?? [];
  const risk = bootstrap?.risk;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2} size="h3">Dashboard</Title>
          <Text size="sm" c="dimmed">Live account overview</Text>
        </div>
        <Group gap="xs">
          {account && (
            <>
              <Badge
                color={account.mode === "live" ? "green" : "yellow"}
                variant="filled"
                size="sm"
              >
                {account.mode === "live" ? "Live Trading" : "Paper Trading"}
              </Badge>
              <Badge
                color={account.tradingBlocked
                        ? "Trading Blocked"
                        : risk?.canEnter === false ? "orange" : "teal"}
                variant="light"
                size="sm"
              >
                {account.tradingBlocked
                  ? "Trading Blocked"
                  : risk?.canEnter === false
                    ? risk.reasons?.[0] ?? "Entries Blocked"
                    : "Trading Active"}
              </Badge>
            </>
          )}
          {bootstrapLoading && <Loader size="xs" color="cyan" />}
        </Group>
      </Group>

      {/* Account stat cards */}
      <SimpleGrid cols={{ base: 2, sm: 2, md: 4 }} spacing="md">
        <StatCard
          label="Portfolio Value"
          value={account ? `$${fmt(account.portfolioValue)}` : "—"}
          loading={bootstrapLoading}
        />
        <StatCard
          label="Day P/L"
          value={
            account ? (
              <PnLText format="money" value={account.dayPnL} />
            ) : "—"
          }
          subValue={
            account ? (
              <PnLText format="percent" value={account.dayPnLPct * 100} />
            ) : undefined
          }
          loading={bootstrapLoading}
        />
        <StatCard
          label="Cash"
          value={account ? `$${fmt(account.cash)}` : "—"}
          loading={bootstrapLoading}
        />
        <StatCard
          label="Buying Power"
          value={account ? `$${fmt(account.buyingPower)}` : "—"}
          loading={bootstrapLoading}
        />
      </SimpleGrid>

      <IndexMarketPulse
        chartRange={indexChartRange}
        data={indexPerformance}
        intradayData={indexIntraday}
        intradayError={indexIntradayError}
        intradayLoading={indexIntradayLoading}
        onChartRangeChange={setIndexChartRange}
        loading={indexPerformanceLoading}
        error={indexPerformanceError}
      />

      {/* Positions + Orders */}
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm">
            <Text fw={600} size="sm">Open Positions</Text>
            <ThemeIcon size="sm" color="cyan" variant="light" radius="sm">
              <Text size="xs" fw={700}>{positions.length}</Text>
            </ThemeIcon>
          </Group>
          {bootstrapLoading ? (
            <Stack gap="xs">
              <Skeleton height={32} radius="sm" />
              <Skeleton height={32} radius="sm" />
            </Stack>
          ) : (
            <PositionsTable positions={positions} />
          )}
        </Card>

        <Card withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm">
            <Text fw={600} size="sm">Open Orders</Text>
            <ThemeIcon size="sm" color="cyan" variant="light" radius="sm">
              <Text size="xs" fw={700}>{openOrders.length}</Text>
            </ThemeIcon>
          </Group>
          {bootstrapLoading ? (
            <Stack gap="xs">
              <Skeleton height={32} radius="sm" />
              <Skeleton height={32} radius="sm" />
            </Stack>
          ) : (
            <OrdersTable orders={openOrders} />
          )}
        </Card>
      </SimpleGrid>

      {/* System Events feed */}
      <Card withBorder radius="md" p="md">
        <Group justify="space-between" mb="sm">
          <Text fw={600} size="sm">Recent Activity</Text>
          {eventsLoading && <Loader size="xs" color="cyan" />}
        </Group>
        {eventsLoading ? (
          <Stack gap="xs">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height={36} radius="sm" />
            ))}
          </Stack>
        ) : (
          <EventFeed events={events ?? []} />
        )}
      </Card>
    </Stack>
  );
}
