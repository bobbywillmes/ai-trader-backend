import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { DataState } from "../../../../../components/data-display";
import { useOpenOrders } from "../../../../orders/hooks";
import { OrdersDataView } from "../../../../orders/OrdersPage";
import type { TradingAccount } from "../../../types";

export function OrdersTab({ account, token }: { account: TradingAccount; token: string | null }) {
  const query = useOpenOrders(token);
  const orders = (query.data ?? []).filter((order) => order.tradingAccountId === account.id);
  return <Card withBorder radius="md" p="md"><Stack gap="md">
    <Group justify="space-between" align="flex-start"><div><Title order={3}>Open Orders</Title><Text size="sm" c="dimmed">Open broker orders attributed to this trading account.</Text></div><Button component={Link} to="/orders/open" variant="light" size="xs">Open global orders</Button></Group>
    {query.isLoading ? <DataState state="loading" message="Loading open orders…" /> : query.isError ? <DataState state="error" title="Unable to load open orders" message={query.error instanceof Error ? query.error.message : "Open orders could not be loaded."} onRetry={() => void query.refetch()} /> : orders.length === 0 ? <DataState state="empty" title="No open orders" message="No open orders are currently attributed to this trading account." /> : <OrdersDataView orders={orders} token={token} ariaLabel={`${account.displayName} open orders`} />}
  </Stack></Card>;
}
