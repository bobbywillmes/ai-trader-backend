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
import { useOpenPositions } from "../../../../positions/hooks";
import type { TrackedPosition } from "../../../../positions/types";
import type { TradingAccount } from "../../../types";
import {
  formatDateTime,
  formatMoney,
  formatPercentValue,
  formatQuantity,
  formatSignedMoney,
} from "../../utils/formatters";

export function PositionsTab({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data: positions = [], isLoading, isError, error } =
    useOpenPositions(token);
  const accountPositions = positions.filter(
    (position: TrackedPosition) => position.tradingAccountId === account.id
  );

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Open Positions</Title>
            <Text size="sm" c="dimmed">
              Open tracked positions attributed to this trading account.
            </Text>
          </div>
          <Button component={Link} to="/positions/open" variant="light" size="xs">
            Open global positions
          </Button>
        </Group>

        {isError && (
          <Alert color="red" title="Failed to load open positions">
            {error instanceof Error ? error.message : "Unknown error."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading open positions...
            </Text>
          </Group>
        )}

        {!isLoading && !isError && accountPositions.length === 0 && (
          <Alert color="gray">
            No open positions are currently attributed to this trading account.
          </Alert>
        )}

        {accountPositions.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 980 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Symbol</Table.Th>
                  <Table.Th>Side</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Qty</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Avg entry</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Current</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Market value</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>P/L</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>P/L %</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Opened</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accountPositions.map((position) => (
                  <Table.Tr key={position.id}>
                    <Table.Td>
                      <Text fw={700} size="sm">
                        {position.symbol}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        color={position.side === "long" ? "teal" : "red"}
                        variant="light"
                      >
                        {position.side}
                      </Badge>
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatQuantity(position.qty)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(position.avgEntryPrice, account.baseCurrency)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(position.currentPrice, account.baseCurrency)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(position.marketValue, account.baseCurrency)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      <Text
                        size="sm"
                        fw={600}
                        c={
                          position.unrealizedPnL > 0
                            ? "teal"
                            : position.unrealizedPnL < 0
                              ? "red"
                              : "dimmed"
                        }
                      >
                        {formatSignedMoney(
                          position.unrealizedPnL,
                          account.baseCurrency
                        )}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      <Text
                        size="sm"
                        fw={600}
                        c={
                          position.unrealizedPnLPct > 0
                            ? "teal"
                            : position.unrealizedPnLPct < 0
                              ? "red"
                              : "dimmed"
                        }
                      >
                        {formatPercentValue(position.unrealizedPnLPct * 100)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" color="teal" variant="light">
                        {position.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatDateTime(position.openedAt)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Stack>
    </Card>
  );
}
