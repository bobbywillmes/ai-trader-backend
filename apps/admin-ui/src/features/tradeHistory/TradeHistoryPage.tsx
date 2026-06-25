import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { getAdminToken } from "../../lib/api";
import { TradeCycleDrawer } from "./TradeCycleDrawer";
import {
  formatDate,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  pnlColor,
} from "./formatters";
import { useTradeCycleDrawer, useTradeCycles } from "./hooks";
import type { TradeCycleSummary, TradeCyclesQuery } from "./types";

function statusColor(status: string) {
  if (status === "closed") return "gray";
  if (status === "closing") return "yellow";
  return "teal";
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
  const [modeFilter, setModeFilter] = useState("all");
  const tradeCycleDrawer = useTradeCycleDrawer(token);
  const hasActiveFilters =
    symbolFilter.trim() !== "" ||
    statusFilter !== "closed" ||
    modeFilter !== "all" ||
    limit !== 50;

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
    if (modeFilter !== "all") next.mode = modeFilter;

    return next;
  }, [limit, modeFilter, statusFilter, symbolFilter]);

  const tradeCyclesQuery = useTradeCycles(token, query);
  const cycles = tradeCyclesQuery.data?.cycles ?? [];

  function clearFilters() {
    setSymbolFilter("");
    setStatusFilter("closed");
    setModeFilter("all");
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
              onChange={(value) => setModeFilter(value ?? "all")}
              data={[
                { value: "all", label: "All" },
                { value: "paper", label: "Paper" },
                { value: "live", label: "Live" },
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
              variant="default"
              leftSection={<IconX size={16} />}
              onClick={clearFilters}
              disabled={!hasActiveFilters}
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
                    <Table.Th>Entry Decision</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {cycles.map((cycle) => (
                    <TradeCycleRow
                      key={cycle.id}
                      cycle={cycle}
                      onSelect={() => tradeCycleDrawer.openCycle(cycle.id)}
                    />
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <TradeCycleDrawer
        {...tradeCycleDrawer.drawerProps}
        onClose={tradeCycleDrawer.closeCycle}
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
        <Stack gap={2}>
          {cycle.entryDecision ? (
            <>
              <Badge
                size="xs"
                variant="light"
                color={decisionColor(cycle.entryDecision.decisionState)}
              >
                {cycle.entryDecision.decisionState}
              </Badge>
              <Text size="xs" c="dimmed" lineClamp={1}>
                {cycle.entryDecision.decisionReason ??
                  cycle.entryDecision.blockingReason ??
                  cycle.entryDecision.persistenceReason}
              </Text>
            </>
          ) : (
            <Text size="sm">-</Text>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Badge color={statusColor(cycle.status)} variant="light">
          {cycle.status}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Button size="xs" variant="default" onClick={onSelect}>
          View
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function decisionColor(state: string) {
  if (state.includes("allow") || state.includes("eligible")) return "teal";
  if (state.includes("block") || state.includes("deny")) return "red";
  if (state.includes("watch") || state.includes("cooldown")) return "yellow";
  return "blue";
}
