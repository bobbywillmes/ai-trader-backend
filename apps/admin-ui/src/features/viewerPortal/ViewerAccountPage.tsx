import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Link, Navigate, useParams } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { useAuth } from "../auth/useAuth";
import { useTradingAccountOpenOrders } from "../orders/hooks";
import type { OpenOrder } from "../orders/types";
import { useTradingAccountOpenPositions } from "../positions/hooks";
import type { TrackedPosition } from "../positions/types";
import {
  formatDate,
  formatDuration,
  formatNumber,
} from "../tradeHistory/formatters";
import { useTradingAccountTradeCycles } from "../tradeHistory/hooks";
import type { TradeCycleSummary } from "../tradeHistory/types";
import { useTradingAccount } from "../tradingAccounts/hooks";
import type { TradingAccount } from "../tradingAccounts/types";

function parseAccountId(value: string | undefined) {
  const id = Number(value);

  return Number.isInteger(id) && id > 0 ? id : null;
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

function environmentColor(environment: TradingAccount["environment"]) {
  return environment === "LIVE" ? "red" : "yellow";
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${(value * 100).toFixed(2)}%`;
}

function pnlColor(value: number | null | undefined) {
  if (value === null || value === undefined) return "dimmed";
  if (value > 0) return "teal";
  if (value < 0) return "red";
  return "dimmed";
}

function DetailItem({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="sm" fw={600}>{value}</Text>
    </div>
  );
}

function statusLabel(value: string | null | undefined) {
  if (!value) return "-";
  return value.replace(/_/g, " ");
}

function ViewerPositionsTable({ positions }: { positions: TrackedPosition[] }) {
  if (positions.length === 0) {
    return <Text size="sm" c="dimmed">No open positions.</Text>;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover style={{ minWidth: 760 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Symbol</Table.Th>
            <Table.Th>Side</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Avg Entry</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Current</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Market Value</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Unrealized P/L</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {positions.map((position) => (
            <Table.Tr key={position.id}>
              <Table.Td fw={600}>{position.symbol}</Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  color={position.side === "short" ? "red" : "teal"}
                  variant="light"
                >
                  {position.side}
                </Badge>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>{position.qty}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {formatMoney(position.avgEntryPrice)}
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {formatMoney(position.currentPrice)}
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {formatMoney(position.marketValue)}
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                <Text c={pnlColor(position.unrealizedPnL)} fw={600} size="sm">
                  {formatMoney(position.unrealizedPnL)} /{" "}
                  {formatPercent(position.unrealizedPnLPct)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge size="sm" color="gray" variant="light">
                  {position.status}
                </Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function ViewerOrdersTable({ orders }: { orders: OpenOrder[] }) {
  if (orders.length === 0) {
    return <Text size="sm" c="dimmed">No open orders.</Text>;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover style={{ minWidth: 760 }}>
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
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {orders.map((order) => {
            const filledQty = order.filled_qty ?? order.filledQty ?? "0";
            const limitPrice = order.limit_price ?? order.limitPrice ?? null;
            const submittedAt = order.submitted_at ?? order.submittedAt ?? null;

            return (
              <Table.Tr key={order.id}>
                <Table.Td fw={600}>{order.symbol}</Table.Td>
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
                  <Text size="sm" tt="capitalize">{order.type}</Text>
                </Table.Td>
                <Table.Td style={{ textAlign: "right" }}>{order.qty ?? "-"}</Table.Td>
                <Table.Td style={{ textAlign: "right" }}>{filledQty}</Table.Td>
                <Table.Td style={{ textAlign: "right" }}>
                  {limitPrice != null ? formatMoney(Number(limitPrice)) : "-"}
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" color="yellow" variant="light">
                    {order.status}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {submittedAt ? formatDateTime(submittedAt) : "-"}
                  </Text>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function statusColor(status: string) {
  if (status === "closed") return "gray";
  if (status === "closing") return "yellow";
  return "teal";
}

function ViewerTradeHistoryTable({
  cycles,
}: {
  cycles: TradeCycleSummary[];
}) {
  if (cycles.length === 0) {
    return <Text size="sm" c="dimmed">No trade history found.</Text>;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover style={{ minWidth: 980 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Symbol</Table.Th>
            <Table.Th>Opened</Table.Th>
            <Table.Th>Closed</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Avg Entry</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Avg Exit</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Realized P/L</Table.Th>
            <Table.Th style={{ textAlign: "right" }}>Return</Table.Th>
            <Table.Th>Duration</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {cycles.map((cycle) => (
            <Table.Tr key={cycle.id}>
              <Table.Td>
                <Text fw={700}>{cycle.symbol}</Text>
                <Text size="xs" c="dimmed">{cycle.side}</Text>
              </Table.Td>
              <Table.Td>{formatDate(cycle.openedAt)}</Table.Td>
              <Table.Td>{formatDate(cycle.closedAt)}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {formatNumber(cycle.quantity)}
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {formatMoney(cycle.avgEntryPrice)}
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {formatMoney(cycle.avgExitPrice)}
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                <Text c={pnlColor(cycle.realizedPnl)} fw={600} size="sm">
                  {formatMoney(cycle.realizedPnl)}
                </Text>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                <Text c={pnlColor(cycle.returnPct)} fw={600} size="sm">
                  {formatPercent(cycle.returnPct)}
                </Text>
              </Table.Td>
              <Table.Td>{formatDuration(cycle.holdingDurationMs)}</Table.Td>
              <Table.Td>
                <Badge color={statusColor(cycle.status)} variant="light">
                  {cycle.status}
                </Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

type ViewerAccountPageProps = {
  view?: "overview" | "positions" | "orders" | "trade-history";
};

export function ViewerAccountPage({ view = "overview" }: ViewerAccountPageProps) {
  const { accountId } = useParams();
  const id = parseAccountId(accountId);
  const { access } = useAuth();
  const token = getAdminToken();
  const assignedAccountIds = access?.accessibleTradingAccountIds ?? [];
  const assignedAccountIdSet = new Set(assignedAccountIds);
  const { data, isLoading, isError, error } = useTradingAccount(id ?? undefined, token);
  const positionsQuery = useTradingAccountOpenPositions(
    view === "positions" ? id ?? undefined : undefined,
    token
  );
  const ordersQuery = useTradingAccountOpenOrders(
    view === "orders" ? id ?? undefined : undefined,
    token
  );
  const tradeHistoryQuery = useTradingAccountTradeCycles(
    token,
    view === "trade-history" ? id ?? undefined : undefined,
    { limit: 50, status: "closed" }
  );

  if (!id) {
    return <Navigate to="/portal" replace />;
  }

  if (!assignedAccountIdSet.has(id)) {
    return (
      <Alert color="red" title="Not authorized">
        This trading account is not assigned to your portal access.{" "}
        <Text component={Link} to="/portal" size="sm" c="red.7">
          Back to portal
        </Text>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Group gap="sm">
        <Loader size="sm" color="cyan" />
        <Text size="sm" c="dimmed">Loading account...</Text>
      </Group>
    );
  }

  if (isError || !data?.account) {
    return (
      <Alert color="red" title="Failed to load account">
        {error instanceof Error ? error.message : "Account data is unavailable."}
      </Alert>
    );
  }

  const account = data.account;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          {view === "overview" && (
            <Button
              component={Link}
              to="/portal/accounts"
              size="xs"
              variant="outline"
              color="gray"
              mb="sm"
            >
              Back to Accounts
            </Button>
          )}
          <Title order={2} size="h3">{account.displayName}</Title>
          <Text size="sm" c="dimmed">
            {view === "overview"
              ? "Read-only broker metadata, account status, and latest balances"
              : view === "positions"
                ? "Read-only open positions"
                : view === "orders"
                  ? "Read-only open orders"
                  : "Read-only trade history"}
          </Text>
        </div>
        <Group gap="xs">
          <Badge color={environmentColor(account.environment)} variant="light">
            {account.environment}
          </Badge>
          <Badge color="gray" variant="light">
            {account.status}
          </Badge>
        </Group>
      </Group>

      {view === "overview" && (
        <>
          <Card withBorder radius="md" p="md">
            <Group justify="space-between" align="flex-start" mb="md">
              <div>
                <Text fw={700} size="lg">Account Summary</Text>
                <Text size="sm" c="dimmed">
                  Broker identity and account-level status.
                </Text>
              </div>
              <Group gap="xs">
                <Badge color={environmentColor(account.environment)} variant="light">
                  {account.environment}
                </Badge>
                <Badge color="gray" variant="light">
                  {account.status}
                </Badge>
              </Group>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
              <DetailItem label="Display name" value={account.displayName} />
              <DetailItem label="Broker" value={account.broker} />
              <DetailItem label="Environment" value={account.environment} />
              <DetailItem label="Status" value={statusLabel(account.status)} />
              <DetailItem
                label="Trading enabled"
                value={
                  <Badge
                    size="sm"
                    color={account.tradingEnabled ? "teal" : "gray"}
                    variant="light"
                  >
                    {account.tradingEnabled ? "Enabled" : "Disabled"}
                  </Badge>
                }
              />
              <DetailItem
                label="Kill switch"
                value={
                  <Badge
                    size="sm"
                    color={account.killSwitchEnabled ? "orange" : "teal"}
                    variant="light"
                  >
                    {account.killSwitchEnabled ? "Enabled" : "Off"}
                  </Badge>
                }
              />
              <DetailItem
                label="Estimated capital"
                value={formatMoney(account.estimatedTradingCapital)}
              />
              <DetailItem label="Base currency" value={account.baseCurrency} />
            </SimpleGrid>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text fw={700} size="lg">Broker Account Snapshot</Text>
            <Text size="sm" c="dimmed" mb="md">
              Latest metadata and balances synced from the broker.
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
              <DetailItem
                label="Broker account id"
                value={account.brokerAccountId ?? "-"}
              />
              <DetailItem
                label="Account number"
                value={account.brokerAccountNumberMasked ?? "-"}
              />
              <DetailItem
                label="Broker status"
                value={account.brokerAccountStatus ?? "-"}
              />
              <DetailItem
                label="Last broker sync"
                value={formatDateTime(account.lastBrokerSyncAt)}
              />
              <DetailItem label="Cash" value={formatMoney(account.lastCash)} />
              <DetailItem
                label="Buying power"
                value={formatMoney(account.lastBuyingPower)}
              />
              <DetailItem label="Equity" value={formatMoney(account.lastEquity)} />
              <DetailItem
                label="Portfolio value"
                value={formatMoney(account.lastPortfolioValue)}
              />
              <DetailItem
                label="Open position notional"
                value={formatMoney(account.totalOpenPositionNotional)}
              />
            </SimpleGrid>
          </Card>

          <Card withBorder radius="md" p="md">
            <Group justify="space-between" align="flex-start" mb="md">
              <div>
                <Text fw={700} size="lg">Credential Status</Text>
                <Text size="sm" c="dimmed">
                  Safe credential summary only. Secrets are never displayed.
                </Text>
              </div>
              <Badge
                color={account.credential.status === "ACTIVE" ? "teal" : "gray"}
                variant="light"
              >
                {account.credential.exists
                  ? statusLabel(account.credential.status)
                  : "No credentials"}
              </Badge>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
              <DetailItem
                label="Exists"
                value={account.credential.exists ? "Yes" : "No"}
              />
              <DetailItem
                label="Status"
                value={statusLabel(account.credential.status)}
              />
              <DetailItem
                label="Auth type"
                value={account.credential.authType ?? "-"}
              />
              <DetailItem
                label="Key fingerprint"
                value={account.credential.keyFingerprint ?? "-"}
              />
              <DetailItem
                label="Verified at"
                value={formatDateTime(account.credential.verifiedAt)}
              />
              <DetailItem
                label="Last used"
                value={formatDateTime(account.credential.lastUsedAt)}
              />
              <DetailItem
                label="Last failed"
                value={formatDateTime(account.credential.lastFailedAt)}
              />
              <DetailItem
                label="Revoked at"
                value={formatDateTime(account.credential.revokedAt)}
              />
            </SimpleGrid>
          </Card>
        </>
      )}

      {view === "positions" && (
        <Card withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm">
            <Text fw={600} size="sm">Open positions</Text>
            {positionsQuery.isLoading && <Loader size="xs" color="cyan" />}
          </Group>
          {positionsQuery.isError && (
            <Alert color="red" mb="md">
              {positionsQuery.error instanceof Error
                ? positionsQuery.error.message
                : "Failed to load positions."}
            </Alert>
          )}
          {positionsQuery.isLoading ? (
            <Text size="sm" c="dimmed">Loading positions...</Text>
          ) : (
            <ViewerPositionsTable positions={positionsQuery.data?.positions ?? []} />
          )}
        </Card>
      )}

      {view === "orders" && (
        <Card withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm">
            <Text fw={600} size="sm">Open orders</Text>
            {ordersQuery.isLoading && <Loader size="xs" color="cyan" />}
          </Group>
          {ordersQuery.isError && (
            <Alert color="red" mb="md">
              {ordersQuery.error instanceof Error
                ? ordersQuery.error.message
                : "Failed to load orders."}
            </Alert>
          )}
          {ordersQuery.isLoading ? (
            <Text size="sm" c="dimmed">Loading orders...</Text>
          ) : (
            <ViewerOrdersTable orders={ordersQuery.data?.orders ?? []} />
          )}
        </Card>
      )}

      {view === "trade-history" && (
        <Card withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm">
            <Text fw={600} size="sm">Trade history</Text>
            {tradeHistoryQuery.isLoading && <Loader size="xs" color="cyan" />}
          </Group>
          {tradeHistoryQuery.isError && (
            <Alert color="red" mb="md">
              {tradeHistoryQuery.error instanceof Error
                ? tradeHistoryQuery.error.message
                : "Failed to load trade history."}
            </Alert>
          )}
          {tradeHistoryQuery.isLoading ? (
            <Text size="sm" c="dimmed">Loading trade history...</Text>
          ) : (
            <ViewerTradeHistoryTable
              cycles={tradeHistoryQuery.data?.cycles ?? []}
            />
          )}
        </Card>
      )}
    </Stack>
  );
}
