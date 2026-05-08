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
import { useOpenPositions, useClosePosition } from "./hooks";

function PnL({ value, suffix = "" }: { value: number; suffix?: string }) {
  const color = value > 0 ? "teal" : value < 0 ? "red" : "dimmed";
  const sign = value > 0 ? "+" : "";
  return (
    <Text c={color} fw={600} size="sm">
      {sign}{value.toFixed(2)}{suffix}
    </Text>
  );
}

export function PositionsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const { data: positions = [], isLoading, isError, error } = useOpenPositions(token);
  const closePositionMutation = useClosePosition(token);

  function handleClosePosition(symbol: string) {
    modals.openConfirmModal({
      title: "Close position",
      children: <Text size="sm">Submit a sell order to close <strong>{symbol}</strong>?</Text>,
      labels: { confirm: "Close position", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await closePositionMutation.mutateAsync(symbol);
          notifications.show({ message: `Close order submitted for ${symbol}.`, color: "teal" });
        } catch (err) {
          notifications.show({
            message: err instanceof Error ? err.message : `Failed to close ${symbol}.`,
            color: "red",
          });
        }
      },
    });
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">Open Positions</Title>
        <Text size="sm" c="dimmed">View and close open tracked positions.</Text>
      </div>

      <Card withBorder radius="md" p="md">
        {isError && (
          <Alert color="red" mb="md">
            {error instanceof Error ? error.message : "Failed to load positions."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">Loading positions…</Text>
          </Group>
        )}

        {!isLoading && positions.length === 0 && (
          <Text size="sm" c="dimmed">No open positions.</Text>
        )}

        {positions.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 700 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Symbol</Table.Th>
                  <Table.Th>Side</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Avg Entry</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Current</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>P/L</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>P/L %</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Subscription</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {positions.map((position) => {
                  const isClosing =
                    closePositionMutation.isPending &&
                    closePositionMutation.variables === position.symbol;

                  return (
                    <Table.Tr key={position.id}>
                      <Table.Td fw={600}>{position.symbol}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" color={position.side === "long" ? "teal" : "red"} variant="light">
                          {position.side}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>{position.qty}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>${position.avgEntryPrice.toFixed(2)}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>${position.currentPrice.toFixed(2)}</Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        <PnL value={position.unrealizedPnL} />
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        <PnL value={position.unrealizedPnLPct * 100} suffix="%" />
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          color={isClosing ? "yellow" : "teal"}
                          variant="light"
                        >
                          {isClosing ? "closing" : position.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{position.subscription?.key ?? "—"}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          color="red"
                          variant="subtle"
                          loading={isClosing}
                          disabled={isClosing}
                          onClick={() => handleClosePosition(position.symbol)}
                        >
                          Close
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
