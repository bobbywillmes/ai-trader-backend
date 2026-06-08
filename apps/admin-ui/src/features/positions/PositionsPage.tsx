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
import type { TrackedPosition } from "./types";

function PnL({ value, suffix = "" }: { value: number; suffix?: string }) {
  const color = value > 0 ? "teal" : value < 0 ? "red" : "dimmed";
  const sign = value > 0 ? "+" : "";
  return (
    <Text c={color} fw={600} size="sm">
      {sign}{value.toFixed(2)}{suffix}
    </Text>
  );
}

function getAttentionCodeLabel(code: string | null | undefined) {
  switch (code) {
    case "trail_submit_failed":
      return "Submit failed";
    case "trail_order_rejected":
      return "Rejected";
    case "trail_order_canceled":
      return "Canceled";
    case "trail_order_expired":
      return "Expired";
    default:
      return "Attention required";
  }
}

function positionNeedsAttention(position: TrackedPosition) {
  return Boolean(position.exitState?.attentionRequired);
}

function getAttentionMessage(position: TrackedPosition) {
  return (
    position.exitState?.attentionMessage ??
    getAttentionCodeLabel(position.exitState?.attentionCode)
  );
}

function getTrailingStopState(position: TrackedPosition) {
  if (!isUnlockTrailingExit(position)) {
    return '—';
  }

  if (position.exitState?.attentionRequired) {
    return getAttentionCodeLabel(position.exitState.attentionCode);
  }

  const status =
    position.exitState?.trailOrderStatus ?? position.trailingStopStatus;

  if (status === 'filled') {
    return 'Trailing stop filled';
  }

  if (
    status === 'canceled' ||
    status === 'expired' ||
    status === 'rejected' ||
    status === 'suspended' ||
    status === 'broker_order_not_found' ||
    status === 'submit_failed'
  ) {
    return 'Attention required';
  }

  if (
    position.exitState?.trailBrokerOrderId ||
    position.exitState?.trailClientOrderId ||
    position.trailingStopOrderId
  ) {
    return 'Broker trailing stop active';
  }

  if (position.exitState?.targetUnlocked || position.trailingUnlocked) {
    return 'Trailing unlocked';
  }

  return 'Waiting for unlock';
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return '—';
  }

  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return '—';
  }

  return `${value.toFixed(2)}%`;
}

function getExitProfile(position: TrackedPosition) {
  return position.subscription?.exitProfile ?? null;
}

function getExitMode(position: TrackedPosition) {
  return position.exitState?.exitMode ?? getExitProfile(position)?.exitMode ?? null;
}

function isUnlockTrailingExit(position: TrackedPosition) {
  return getExitMode(position) === 'unlock_trailing_stop';
}

function isFixedTargetExit(position: TrackedPosition) {
  return getExitMode(position) === 'fixed_target';
}

function getExitStrategyLabel(position: TrackedPosition) {
  const exitMode = getExitMode(position);

  if (exitMode === 'unlock_trailing_stop') {
    return 'Target Unlocks Trail';
  }

  if (exitMode === 'fixed_target') {
    return 'Fixed Target';
  }

  if (exitMode === 'fixed_bracket') {
    return 'Fixed Bracket';
  }

  if (exitMode === 'hybrid') {
    return 'Hybrid';
  }

  return exitMode ?? '—';
}

function getTargetPct(position: TrackedPosition) {
  return (
    position.subscription?.exitProfile?.targetPct ??
    null
  );
}

function getExitTargetPrice(position: TrackedPosition) {
  const targetPct = getTargetPct(position);

  if (targetPct === null || targetPct === undefined) {
    return null;
  }

  if (position.side === 'short') {
    return position.avgEntryPrice * (1 - targetPct / 100);
  }

  return position.avgEntryPrice * (1 + targetPct / 100);
}

function getExitTargetLabel(position: TrackedPosition) {
  const targetPct = getTargetPct(position);
  const targetPrice = getExitTargetPrice(position);

  if (targetPct === null || targetPct === undefined || targetPrice === null) {
    return '—';
  }

  if (isUnlockTrailingExit(position)) {
    if (position.trailingUnlocked && position.trailingUnlockedPrice) {
      return `Unlocked at ${formatCurrency(position.trailingUnlockedPrice)}`;
    }

    return `${targetPct.toFixed(2)}% / ${formatCurrency(targetPrice)}`;
  }

  if (isFixedTargetExit(position)) {
    return `${formatCurrency(targetPrice)} (${targetPct.toFixed(2)}%)`;
  }

  return `${targetPct.toFixed(2)}% / ${formatCurrency(targetPrice)}`;
}



export function PositionsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const { data: positions = [], isLoading, isError, error } = useOpenPositions(token);
  const closePositionMutation = useClosePosition(token);
  const attentionPositions = positions.filter(positionNeedsAttention);

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


        {attentionPositions.length > 0 && (
          <Alert color="red" title="Exit attention required">
            <Stack gap="xs">
              {attentionPositions.map((position) => (
                <Text key={position.id} size="sm">
                  <strong>{position.symbol}</strong>: {getAttentionMessage(position)}
                </Text>
              ))}
            </Stack>
          </Alert>
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
                  <Table.Th>Attention</Table.Th>
                  <Table.Th>Subscription</Table.Th>
                  <Table.Th>Exit Strategy</Table.Th>
                  <Table.Th>Exit Target</Table.Th>
                  <Table.Th>Trailing State</Table.Th>
                  <Table.Th>Trail %</Table.Th>
                  <Table.Th>Trail HWM</Table.Th>
                  <Table.Th>Stop Price</Table.Th>
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
                        {positionNeedsAttention(position) ? (
                          <Stack gap={2}>
                            <Badge color="red" variant="light">
                              {getAttentionCodeLabel(position.exitState?.attentionCode)}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {getAttentionMessage(position)}
                            </Text>
                          </Stack>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{position.subscription?.key ?? "—"}</Text>
                      </Table.Td>
                      <Table.Td>{getExitStrategyLabel(position)}</Table.Td>
                      <Table.Td>{getExitTargetLabel(position)}</Table.Td>
                      <Table.Td>{getTrailingStopState(position)}</Table.Td>
                      <Table.Td>
                        {isUnlockTrailingExit(position)
                          ? formatPercent(position.trailingStopTrailPercent)
                          : '—'}
                      </Table.Td>
                      <Table.Td>
                        {isUnlockTrailingExit(position)
                          ? formatCurrency(position.trailingStopHwm)
                          : '—'}
                      </Table.Td>
                      <Table.Td>
                        {isUnlockTrailingExit(position)
                          ? formatCurrency(position.trailingStopStopPrice)
                          : '—'}
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
