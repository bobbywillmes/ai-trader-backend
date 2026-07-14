import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router-dom";
import { useOpenOrders } from "../../../../orders/hooks";
import type { OpenOrder } from "../../../../orders/types";
import type { TradingAccount } from "../../../types";
import {
  formatDateTime,
  formatMoney,
  formatOrderValue,
} from "../../utils/formatters";

export function OrdersTab({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data: orders = [], isLoading, isError, error } = useOpenOrders(token);
  const accountOrders = orders.filter(
    (order: OpenOrder) => order.tradingAccountId === account.id
  );

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Open Orders</Title>
            <Text size="sm" c="dimmed">
              Open broker orders attributed to this trading account.
            </Text>
          </div>
          <Button component={Link} to="/orders/open" variant="light" size="xs">
            Open global orders
          </Button>
        </Group>

        {isError && (
          <Alert color="red" title="Failed to load open orders">
            {error instanceof Error ? error.message : "Unknown error."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading open orders...
            </Text>
          </Group>
        )}

        {!isLoading && !isError && accountOrders.length === 0 && (
          <Alert color="gray">
            No open orders are currently attributed to this trading account.
          </Alert>
        )}

        {accountOrders.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 860 }}>
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
                  <Table.Th>Client order id</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accountOrders.map((order) => {
                  const filledQty = order.filled_qty ?? order.filledQty ?? "0";
                  const limitPrice = order.limit_price ?? order.limitPrice ?? null;
                  const submittedAt = order.submitted_at ?? order.submittedAt;
                  const clientOrderId =
                    order.client_order_id ?? order.clientOrderId ?? null;

                  return (
                    <Table.Tr key={order.id}>
                      <Table.Td>
                        <Text fw={700} size="sm">
                          {order.symbol}
                        </Text>
                      </Table.Td>
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
                        <Text size="sm" tt="capitalize">
                          {order.type}
                        </Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatOrderValue(order.qty)}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatOrderValue(filledQty)}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {limitPrice !== null && limitPrice !== undefined
                          ? formatMoney(Number(limitPrice), account.baseCurrency)
                          : "-"}
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" color="yellow" variant="light">
                          {order.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {formatDateTime(submittedAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {clientOrderId ?? "-"}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Stack>
    </Card>
  );
}
