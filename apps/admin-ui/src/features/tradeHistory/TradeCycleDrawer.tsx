import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  Divider,
  Drawer,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Timeline,
  Title,
} from "@mantine/core";
import {
  IconCircleCheck,
  IconClock,
  IconFileAnalytics,
} from "@tabler/icons-react";
import { TradingAccountBadge } from "../../components/TradingAccountBadge";
import { TradeCycleDetailSections } from "./TradeCycleDetailSections";
import {
  formatDate,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  pnlColor,
} from "./formatters";
import type { TradeCycleDetail } from "./types";

function sourceColor(source: string) {
  switch (source) {
    case "broker_activity":
      return "blue";
    case "broker_order":
      return "violet";
    case "order_intent":
      return "cyan";
    case "entry_decision":
      return "blue";
    case "system_event":
      return "orange";
    default:
      return "gray";
  }
}

function statusColor(status: string) {
  if (status === "closed") return "gray";
  if (status === "closing") return "yellow";
  return "teal";
}

function isClosedCycle(cycle: TradeCycleDetail) {
  return cycle.status === "closed" && cycle.closedAt !== null;
}

type TradeCycleDrawerProps = {
  opened: boolean;
  cycle: TradeCycleDetail | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onClose: () => void;
};

export function TradeCycleDrawer({
  opened,
  cycle,
  isLoading,
  isError,
  error,
  onClose,
}: TradeCycleDrawerProps) {
  const closed = cycle ? isClosedCycle(cycle) : false;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        cycle ? (
          <Group gap="sm">
            <IconFileAnalytics size={20} />
            <Text fw={700}>
              {cycle.symbol} Cycle #{cycle.id}
            </Text>
          </Group>
        ) : (
          "Trade Cycle"
        )
      }
    >
      {isLoading && (
        <Group>
          <Loader size="sm" />
          <Text c="dimmed">Loading lifecycle...</Text>
        </Group>
      )}

      {isError && (
        <Alert color="red" title="Failed to load trade cycle">
          {error?.message ?? "Check the backend route and admin session."}
        </Alert>
      )}

      {cycle && (
        <Stack gap="lg">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Metric
              label="Realized P/L"
              value={closed ? formatMoney(cycle.realizedPnl) : "Not closed"}
              color={pnlColor(cycle.realizedPnl)}
            />
            <Metric
              label="Return"
              value={closed ? formatPercent(cycle.returnPct) : "Not closed"}
              color={pnlColor(cycle.returnPct)}
            />
            <Metric label="Average Entry" value={formatMoney(cycle.avgEntryPrice)} />
            <Metric
              label="Average Exit"
              value={closed ? formatMoney(cycle.avgExitPrice) : "Unavailable"}
            />
            <Metric label="Quantity" value={formatNumber(cycle.quantity)} />
            <Metric
              label="Holding Duration"
              value={closed ? formatDuration(cycle.holdingDurationMs) : "In progress"}
            />
            {!closed && (
              <>
                <Metric label="Current Price" value={formatMoney(cycle.currentPrice)} />
                <Metric
                  label="Unrealized P/L"
                  value={formatMoney(cycle.unrealizedPnL)}
                  color={pnlColor(cycle.unrealizedPnL)}
                />
              </>
            )}
          </SimpleGrid>

          <Divider />

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Info
              label="Trading Account"
              value={
                <TradingAccountBadge
                  account={cycle.tradingAccount}
                  tradingAccountId={cycle.tradingAccountId}
                />
              }
            />
            <Info
              label="Status"
              value={
                <Badge color={statusColor(cycle.status)} variant="light">
                  {closed ? "Closed" : cycle.status === "closing" ? "Closing" : "Open / Active"}
                </Badge>
              }
            />
            <Info label="Strategy" value={cycle.strategy?.name ?? "-"} />
            <Info label="Subscription" value={cycle.subscription?.name ?? "-"} />
            <Info label="Exit Profile" value={cycle.exitProfile?.name ?? "-"} />
            <Info
              label="Entry Decision"
              value={
                cycle.entryDecision ? (
                  <Group gap="xs">
                    <Badge
                      color={sourceColor("entry_decision")}
                      variant="light"
                    >
                      {cycle.entryDecision.decisionState}
                    </Badge>
                    <Text size="sm">
                      {cycle.entryDecision.decisionReason ??
                        cycle.entryDecision.blockingReason ??
                        cycle.entryDecision.persistenceReason}
                    </Text>
                  </Group>
                ) : (
                  "-"
                )
              }
            />
            <Info
              label="Exit Reason"
              value={
                closed
                  ? cycle.exitReason ?? cycle.exitStateStatus ?? "Unavailable"
                  : cycle.exitStateStatus ?? "In progress"
              }
            />
            <Info label="Opened" value={formatDate(cycle.openedAt)} />
            <Info label="Closed" value={closed ? formatDate(cycle.closedAt) : "Not closed"} />
            <Info
              label="Config Snapshot"
              value={
                cycle.configSnapshotCapturedAt
                  ? formatDate(cycle.configSnapshotCapturedAt)
                  : "Live fallback"
              }
            />
          </SimpleGrid>

          <Divider />

          <Stack gap="sm">
            <Title order={3} size="h4">
              Lifecycle Timeline
            </Title>
            {cycle.timeline.length === 0 ? (
              <Text c="dimmed">No lifecycle events recorded.</Text>
            ) : (
              <Timeline active={cycle.timeline.length} bulletSize={26} lineWidth={2}>
                {cycle.timeline.map((item, index) => (
                  <Timeline.Item
                    key={`${item.source}-${item.entityId ?? "none"}-${index}`}
                    bullet={
                      item.source === "tracked_position" ? (
                        <IconCircleCheck size={14} />
                      ) : (
                        <IconClock size={14} />
                      )
                    }
                    title={
                      <Group gap="xs">
                        <Text fw={600} size="sm">
                          {item.summary}
                        </Text>
                        <Badge
                          size="xs"
                          color={sourceColor(item.source)}
                          variant="light"
                        >
                          {item.source.replaceAll("_", " ")}
                        </Badge>
                      </Group>
                    }
                  >
                    <Text size="xs" c="dimmed">
                      {formatDate(item.occurredAt)} - {item.type}
                    </Text>
                  </Timeline.Item>
                ))}
              </Timeline>
            )}
          </Stack>

          <Divider />

          <TradeCycleDetailSections
            orderIntents={cycle.orderIntents}
            brokerOrders={cycle.brokerOrders}
            brokerActivities={cycle.brokerActivities}
            systemEvents={cycle.systemEvents}
          />
        </Stack>
      )}
    </Drawer>
  );
}

function Metric({
  label,
  value,
  color = "inherit",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text fw={700} c={color}>
        {value}
      </Text>
    </div>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}
