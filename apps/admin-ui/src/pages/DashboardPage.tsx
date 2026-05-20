import { useState } from "react";
import {
  Badge,
  Box,
  Card,
  Divider,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { getAdminToken } from "../lib/api";
import { useBootstrap, useSystemEvents } from "../features/dashboard/hooks";
import type { BrokerPosition, BrokerOpenOrder, SystemEvent } from "../features/dashboard/types";
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

function formatSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  const formatted = `${Math.abs(value).toFixed(2)}%`;

  if (value > 0) return `${formatted}`;
  if (value < 0) return `- ${formatted}`;
  return formatted;
}

function PnLText({ format, value }: { format: string, value: number; }) {
  const fmt = format;
  const color = value > 0 ? "teal" : value < 0 ? "red" : "dimmed";
  if (fmt == 'percent') {
    return (
      <Text c={color} >
        {formatSignedPercent(value)}
      </Text>
    )
  }
  return (
    <Text c={color} fw={600} size="sm">
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
  const { data: bootstrap, isLoading: bootstrapLoading } = useBootstrap(token);
  const { data: events, isLoading: eventsLoading } = useSystemEvents(token, 50);

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
