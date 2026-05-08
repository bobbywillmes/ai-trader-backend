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

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtCurrency(n: number) {
  return `$${fmt(Math.abs(n))}`;
}

function PnLText({ value, suffix = "" }: { value: number; suffix?: string }) {
  const color = value > 0 ? "teal" : value < 0 ? "red" : "dimmed";
  const sign = value > 0 ? "+" : "";
  return (
    <Text c={color} fw={600} size="sm">
      {sign}
      {fmtCurrency(value)}
      {suffix}
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
            <Table.Th>Side</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Mkt Value</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Unrealized P/L</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>P/L %</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {positions.map((p) => (
            <Table.Tr key={p.symbol}>
              <Table.Td fw={600}>{p.symbol}</Table.Td>
              <Table.Td>
                <Badge size="sm" color={p.side === "long" ? "teal" : "red"} variant="light">
                  {p.side}
                </Badge>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>{fmt(p.qty, 0)}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>${fmt(p.marketValue)}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                <PnLText value={p.unrealizedPnL} />
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                <PnLText value={p.unrealizedPnLPct * 100} suffix="%" />
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

type EventPayload = Record<string, unknown>;

function parsePayload(ev: SystemEvent): EventPayload {
  if (!ev.payloadJson) return {};
  if (typeof ev.payloadJson === "object") return ev.payloadJson as EventPayload;
  try {
    return JSON.parse(ev.payloadJson) as EventPayload;
  } catch {
    return {};
  }
}

function cap(s: unknown) {
  if (typeof s !== "string" || !s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type EventMeta = { label: string; description: string; color: string };

function describeEvent(ev: SystemEvent): EventMeta {
  const p = parsePayload(ev);

  switch (ev.type) {
    case "order.submitted":
      return { label: "Submitted", description: `${cap(p.side)} ${p.symbol as string}`, color: "blue" };
    case "order.filled":
      return { label: "Filled", description: `${cap(p.side)} ${p.symbol as string}`, color: "green" };
    case "order.canceled":
      return { label: "Canceled", description: `${cap(p.side)} ${p.symbol as string}`, color: "orange" };
    case "order.rejected":
      return { label: "Rejected", description: `${cap(p.side)} ${p.symbol as string}`, color: "red" };
    case "order.expired":
      return { label: "Expired", description: `${cap(p.side)} ${p.symbol as string}`, color: "gray" };
    case "order.pending_cancel":
      return { label: "Canceling", description: `${cap(p.side)} ${p.symbol as string}`, color: "yellow" };
    case "position.opened": {
      const price = typeof p.avgEntryPrice === "number" ? ` @ $${fmt(p.avgEntryPrice)}` : "";
      return {
        label: "Opened",
        description: `${cap(p.side)} ${p.qty} ${p.symbol as string}${price}`,
        color: "teal",
      };
    }
    case "position.closed":
      return { label: "Closed", description: `${p.symbol as string}`, color: "cyan" };
    case "position.close_requested":
      return { label: "Close Req", description: `${p.symbol as string}`, color: "cyan" };
    case "exit.triggered": {
      const pct = typeof p.pnlPct === "number" ? p.pnlPct * 100 : null;
      const sign = pct != null && pct >= 0 ? "+" : "";
      const pctStr = pct != null ? ` (${sign}${pct.toFixed(2)}%)` : "";
      const reason =
        p.reason === "take_profit" ? "Take Profit" :
        p.reason === "stop_loss" ? "Stop Loss" :
        p.reason === "trailing_stop" ? "Trailing Stop" :
        p.reason === "max_hold_days" ? "Max Hold Days" :
        cap(p.reason);
      return {
        label: "Exit",
        description: `${p.symbol as string} — ${reason}${pctStr}`,
        color: "yellow",
      };
    }
    default:
      return {
        label: cap(ev.type.split(".").pop()),
        description: [ev.entityType, ev.entityId].filter(Boolean).join(" · "),
        color: "gray",
      };
  }
}

function EventFeed({ events }: { events: SystemEvent[] }) {
  if (events.length === 0) {
    return <Text size="sm" c="dimmed" py="sm">No recent events.</Text>;
  }

  return (
    <Stack gap={0}>
      {events.map((ev, i) => {
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
  const { data: events, isLoading: eventsLoading } = useSystemEvents(token, 25);

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
                color={account.tradingBlocked ? "red" : risk?.canTrade === false ? "orange" : "teal"}
                variant="light"
                size="sm"
              >
                {account.tradingBlocked
                  ? "Trading Blocked"
                  : risk?.canTrade === false
                  ? risk.reason ?? "Risk Limit"
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
              <PnLText value={account.dayPnL} />
            ) : "—"
          }
          subValue={
            account ? (
              <PnLText value={account.dayPnLPct * 100} suffix="%" />
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
