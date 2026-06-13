import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Drawer,
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
  Timeline,
  Title,
} from "@mantine/core";
import {
  IconCircleCheck,
  IconClock,
  IconFileAnalytics,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { getAdminToken } from "../../lib/api";
import { useTradeCycle, useTradeCycles } from "./hooks";
import type {
  TradeCycleDetail,
  TradeCycleSummary,
  TradeCyclesQuery,
} from "./types";

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

  return `${(value * 100).toFixed(2)}%`;
}

function formatDate(value: string | null | undefined) {
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

function formatDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "-";

  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function pnlColor(value: number | null | undefined) {
  if (value === null || value === undefined) return "dimmed";
  if (value > 0) return "teal";
  if (value < 0) return "red";
  return "dimmed";
}

function statusColor(status: string) {
  if (status === "closed") return "gray";
  if (status === "closing") return "yellow";
  return "teal";
}

function sourceColor(source: string) {
  switch (source) {
    case "broker_activity":
      return "blue";
    case "broker_order":
      return "violet";
    case "order_intent":
      return "cyan";
    case "system_event":
      return "orange";
    default:
      return "gray";
  }
}

function normalizeLimit(value: string | number, fallback: number) {
  if (value === "") return fallback;

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function TradeHistoryPage() {
  const [token] = useState(() => getAdminToken());
  const [limit, setLimit] = useState(50);
  const [symbolFilter, setSymbolFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>("closed");
  const [modeFilter, setModeFilter] = useState<string | null>(null);
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);

  const query = useMemo(() => {
    const next: TradeCyclesQuery = { limit };
    const symbol = symbolFilter.trim().toUpperCase();

    if (symbol) next.symbol = symbol;
    if (
      statusFilter === "open" ||
      statusFilter === "closing" ||
      statusFilter === "closed"
    ) {
      next.status = statusFilter;
    }
    if (modeFilter) next.mode = modeFilter;

    return next;
  }, [limit, modeFilter, statusFilter, symbolFilter]);

  const tradeCyclesQuery = useTradeCycles(token, query);
  const detailQuery = useTradeCycle(token, selectedCycleId);
  const cycles = tradeCyclesQuery.data?.cycles ?? [];
  const selectedCycle = detailQuery.data?.cycle ?? null;

  function clearFilters() {
    setSymbolFilter("");
    setStatusFilter("closed");
    setModeFilter(null);
    setLimit(50);
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Trade History</Title>
          <Text c="dimmed">
            Completed and active trade cycles from the canonical lifecycle API.
          </Text>
        </div>

        <Button
          leftSection={<IconRefresh size={16} />}
          variant="default"
          onClick={() => tradeCyclesQuery.refetch()}
          loading={tradeCyclesQuery.isFetching}
        >
          Refresh
        </Button>
      </Group>

      <Card withBorder radius="md" p="md">
        <Stack gap="md">
          <Group align="flex-end">
            <TextInput
              label="Symbol"
              placeholder="SPY"
              leftSection={<IconSearch size={16} />}
              value={symbolFilter}
              onChange={(event) => setSymbolFilter(event.currentTarget.value)}
              w={140}
            />

            <Select
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              data={[
                { value: "closed", label: "Closed" },
                { value: "open", label: "Open" },
                { value: "closing", label: "Closing" },
                { value: "", label: "All" },
              ]}
              w={130}
            />

            <Select
              label="Mode"
              value={modeFilter}
              onChange={setModeFilter}
              data={[
                { value: "paper", label: "Paper" },
                { value: "live", label: "Live" },
                { value: "", label: "All" },
              ]}
              w={120}
            />

            <NumberInput
              label="Limit"
              min={1}
              max={250}
              value={limit}
              onChange={(value) => setLimit(normalizeLimit(value, limit))}
              w={110}
            />

            <Button
              variant="subtle"
              leftSection={<IconX size={16} />}
              onClick={clearFilters}
            >
              Clear
            </Button>
          </Group>

          {tradeCyclesQuery.isError && (
            <Alert color="red" title="Failed to load trade cycles">
              {tradeCyclesQuery.error instanceof Error
                ? tradeCyclesQuery.error.message
                : "Check the backend route and admin session."}
            </Alert>
          )}

          {tradeCyclesQuery.isLoading && (
            <Group>
              <Loader size="sm" />
              <Text c="dimmed">Loading trade cycles...</Text>
            </Group>
          )}

          {!tradeCyclesQuery.isLoading && cycles.length === 0 && (
            <Text c="dimmed">No trade cycles found.</Text>
          )}

          {cycles.length > 0 && (
            <ScrollArea>
              <Table striped highlightOnHover withTableBorder miw={1180}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Symbol</Table.Th>
                    <Table.Th>Opened</Table.Th>
                    <Table.Th>Closed</Table.Th>
                    <Table.Th ta="right">Qty</Table.Th>
                    <Table.Th ta="right">Avg Entry</Table.Th>
                    <Table.Th ta="right">Avg Exit</Table.Th>
                    <Table.Th ta="right">Realized P/L</Table.Th>
                    <Table.Th ta="right">Return</Table.Th>
                    <Table.Th>Duration</Table.Th>
                    <Table.Th>Strategy</Table.Th>
                    <Table.Th>Subscription</Table.Th>
                    <Table.Th>Exit Profile</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {cycles.map((cycle) => (
                    <TradeCycleRow
                      key={cycle.id}
                      cycle={cycle}
                      onSelect={() => setSelectedCycleId(cycle.id)}
                    />
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <TradeCycleDrawer
        opened={selectedCycleId !== null}
        cycle={selectedCycle}
        isLoading={detailQuery.isLoading}
        isError={detailQuery.isError}
        error={detailQuery.error}
        onClose={() => setSelectedCycleId(null)}
      />
    </Stack>
  );
}

function TradeCycleRow({
  cycle,
  onSelect,
}: {
  cycle: TradeCycleSummary;
  onSelect: () => void;
}) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text fw={700}>{cycle.symbol}</Text>
        <Text size="xs" c="dimmed">
          {cycle.side}
        </Text>
      </Table.Td>
      <Table.Td>{formatDate(cycle.openedAt)}</Table.Td>
      <Table.Td>{formatDate(cycle.closedAt)}</Table.Td>
      <Table.Td ta="right">{formatNumber(cycle.quantity)}</Table.Td>
      <Table.Td ta="right">{formatMoney(cycle.avgEntryPrice)}</Table.Td>
      <Table.Td ta="right">{formatMoney(cycle.avgExitPrice)}</Table.Td>
      <Table.Td ta="right">
        <Text c={pnlColor(cycle.realizedPnl)} fw={700} size="sm">
          {formatMoney(cycle.realizedPnl)}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text c={pnlColor(cycle.returnPct)} fw={700} size="sm">
          {formatPercent(cycle.returnPct)}
        </Text>
      </Table.Td>
      <Table.Td>{formatDuration(cycle.holdingDurationMs)}</Table.Td>
      <Table.Td>{cycle.strategy?.name ?? "-"}</Table.Td>
      <Table.Td>
        <Stack gap={2}>
          <Text size="sm">{cycle.subscription?.name ?? "-"}</Text>
          {cycle.subscription?.brokerMode && (
            <Badge size="xs" variant="light">
              {cycle.subscription.brokerMode}
            </Badge>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>{cycle.exitProfile?.name ?? "-"}</Table.Td>
      <Table.Td>
        <Badge color={statusColor(cycle.status)} variant="light">
          {cycle.status}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Button size="xs" variant="subtle" onClick={onSelect}>
          View
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function TradeCycleDrawer({
  opened,
  cycle,
  isLoading,
  isError,
  error,
  onClose,
}: {
  opened: boolean;
  cycle: TradeCycleDetail | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        cycle ? (
          <Group gap="sm">
            <IconFileAnalytics size={20} />
            <Text fw={700}>
              {cycle.symbol} Cycle #{cycle.id}
            </Text>
          </Group>
        ) : (
          "Trade Cycle"
        )
      }
    >
      {isLoading && (
        <Group>
          <Loader size="sm" />
          <Text c="dimmed">Loading lifecycle...</Text>
        </Group>
      )}

      {isError && (
        <Alert color="red" title="Failed to load trade cycle">
          {error?.message ?? "Check the backend route and admin session."}
        </Alert>
      )}

      {cycle && (
        <Stack gap="lg">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Metric label="Realized P/L" value={formatMoney(cycle.realizedPnl)} color={pnlColor(cycle.realizedPnl)} />
            <Metric label="Return" value={formatPercent(cycle.returnPct)} color={pnlColor(cycle.returnPct)} />
            <Metric label="Average Entry" value={formatMoney(cycle.avgEntryPrice)} />
            <Metric label="Average Exit" value={formatMoney(cycle.avgExitPrice)} />
            <Metric label="Quantity" value={formatNumber(cycle.quantity)} />
            <Metric label="Holding Duration" value={formatDuration(cycle.holdingDurationMs)} />
          </SimpleGrid>

          <Divider />

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Info label="Strategy" value={cycle.strategy?.name ?? "-"} />
            <Info label="Subscription" value={cycle.subscription?.name ?? "-"} />
            <Info label="Exit Profile" value={cycle.exitProfile?.name ?? "-"} />
            <Info label="Exit Reason" value={cycle.exitReason ?? cycle.exitStateStatus ?? "-"} />
          </SimpleGrid>

          <Divider />

          <Stack gap="sm">
            <Title order={3} size="h4">
              Lifecycle Timeline
            </Title>
            {cycle.timeline.length === 0 ? (
              <Text c="dimmed">No lifecycle events recorded.</Text>
            ) : (
              <Timeline active={cycle.timeline.length} bulletSize={26} lineWidth={2}>
                {cycle.timeline.map((item, index) => (
                  <Timeline.Item
                    key={`${item.source}-${item.entityId ?? "none"}-${index}`}
                    bullet={
                      item.source === "tracked_position" ? (
                        <IconCircleCheck size={14} />
                      ) : (
                        <IconClock size={14} />
                      )
                    }
                    title={
                      <Group gap="xs">
                        <Text fw={600} size="sm">
                          {item.summary}
                        </Text>
                        <Badge size="xs" color={sourceColor(item.source)} variant="light">
                          {item.source.replaceAll("_", " ")}
                        </Badge>
                      </Group>
                    }
                  >
                    <Text size="xs" c="dimmed">
                      {formatDate(item.occurredAt)} - {item.type}
                    </Text>
                  </Timeline.Item>
                ))}
              </Timeline>
            )}
          </Stack>

          <Divider />

          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Info label="Order Intents" value={String(cycle.orderIntents.length)} />
            <Info label="Broker Orders" value={String(cycle.brokerOrders.length)} />
            <Info label="Broker Activities" value={String(cycle.brokerActivities.length)} />
          </SimpleGrid>
        </Stack>
      )}
    </Drawer>
  );
}

function Metric({
  label,
  value,
  color = "inherit",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text fw={700} c={color}>
        {value}
      </Text>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}
