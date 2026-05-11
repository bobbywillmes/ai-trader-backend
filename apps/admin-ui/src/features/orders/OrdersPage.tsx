import { useState } from "react";
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
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { useOpenOrders, useCancelOrder } from "./hooks";

export function OrdersPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const { data: orders = [], isLoading, isError, error } = useOpenOrders(token);
  const cancelOrderMutation = useCancelOrder(token);

  function handleCancelOrder(orderId: string, symbol?: string) {
    modals.openConfirmModal({
      title: "Cancel order",
      children: (
        <Text size="sm">
          Cancel the open order{symbol ? <> for <strong>{symbol}</strong></> : ""}?
        </Text>
      ),
      labels: { confirm: "Cancel order", cancel: "Keep" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await cancelOrderMutation.mutateAsync(orderId);
          notifications.show({
            message: `Order canceled${symbol ? ` for ${symbol}` : ""}.`,
            color: "teal",
          });
        } catch (err) {
          notifications.show({
            message: err instanceof Error ? err.message : "Failed to cancel order.",
            color: "red",
          });
        }
      },
    });
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">Open Orders</Title>
        <Text size="sm" c="dimmed">View and cancel open orders.</Text>
      </div>

      <Card withBorder radius="md" p="md">
        {isError && (
          <Alert color="red" mb="md">
            {error instanceof Error ? error.message : "Failed to load orders."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">Loading orders…</Text>
          </Group>
        )}

        {!isLoading && orders.length === 0 && (
          <Text size="sm" c="dimmed">No open orders.</Text>
        )}

        {orders.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 640 }}>
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
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {orders.map((order) => {
                  const filledQty = order.filled_qty ?? order.filledQty ?? "0";
                  const limitPrice = order.limit_price ?? order.limitPrice ?? null;
                  const submittedAt = order.submitted_at ?? order.submittedAt ?? null;
                  const isCanceling =
                    cancelOrderMutation.isPending &&
                    cancelOrderMutation.variables === order.id;

                  return (
                    <Table.Tr key={order.id}>
                      <Table.Td fw={600}>{order.symbol}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" color={order.side === "buy" ? "teal" : "red"} variant="light">
                          {order.side}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" tt="capitalize">{order.type}</Text>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>{order.qty ?? "—"}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>{filledQty}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {limitPrice != null ? `$${Number(limitPrice).toFixed(2)}` : "—"}
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" color="yellow" variant="light">{order.status}</Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {submittedAt
                            ? new Date(submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                            : "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          color="red"
                          variant="subtle"
                          loading={isCanceling}
                          disabled={isCanceling}
                          onClick={() => handleCancelOrder(order.id, order.symbol)}
                        >
                          Cancel
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>
    </Stack>
  );
}
