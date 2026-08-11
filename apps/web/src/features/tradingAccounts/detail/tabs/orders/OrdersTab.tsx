import { Alert, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import { createScopedNavigationTarget } from "../../../../../app/navigationUtils";
import { DataState } from "../../../../../components/data-display";
import { useTradingAccountOpenOrders } from "../../../../orders/hooks";
import { OrdersDataView } from "../../../../orders/OrdersPage";
import type { TradingAccount } from "../../../types";

export function OrdersTab({ account, token }: { account: TradingAccount; token: string | null }) {
  const location = useLocation();
  const query = useTradingAccountOpenOrders(account.id, token);
  const orders = query.data?.orders ?? [];

  return <Card withBorder radius="md" p="md"><Stack gap="md">
    <Group justify="space-between" align="flex-start"><div><Title order={3}>Open Orders</Title><Text size="sm" c="dimmed">Open broker orders for this trading account.</Text></div><Button component={Link} to={createScopedNavigationTarget("/orders/open", location.search)} variant="light" size="xs">Open operational orders</Button></Group>
    {query.isLoading ? <DataState state="loading" message="Loading open orders…" /> : query.isError ? <DataState state="error" title="Unable to load open orders" message={query.error instanceof Error ? query.error.message : "Open orders could not be loaded."} onRetry={() => void query.refetch()} /> : query.data?.availability === "UNAVAILABLE" ? <Alert color="yellow" title="Broker orders unavailable">{query.data.message ?? "Broker state is unavailable for this trading account."}</Alert> : orders.length === 0 ? <DataState state="empty" title="No open orders" message="This trading account currently has no open broker orders." /> : <OrdersDataView orders={orders} token={token} ariaLabel={`${account.displayName} open orders`} />}
  </Stack></Card>;
}
