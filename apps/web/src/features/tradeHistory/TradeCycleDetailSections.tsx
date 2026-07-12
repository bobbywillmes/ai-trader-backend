import {
  Accordion,
  Badge,
  Code,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import {
  formatDate,
  formatMoney,
  formatPreciseNumber,
} from "./formatters";
import type {
  TradeCycleBrokerActivity,
  TradeCycleBrokerOrder,
  TradeCycleOrderIntent,
  TradeCycleSystemEvent,
} from "./types";

type TradeCycleDetailSectionsProps = {
  orderIntents: TradeCycleOrderIntent[];
  brokerOrders: TradeCycleBrokerOrder[];
  brokerActivities: TradeCycleBrokerActivity[];
  systemEvents: TradeCycleSystemEvent[];
};

export function TradeCycleDetailSections({
  orderIntents,
  brokerOrders,
  brokerActivities,
  systemEvents,
}: TradeCycleDetailSectionsProps) {
  return (
    <Accordion variant="contained" multiple defaultValue={["broker-activities"]}>
      <Accordion.Item value="order-intents">
        <Accordion.Control>
          <SectionLabel label="Order Intents" count={orderIntents.length} />
        </Accordion.Control>
        <Accordion.Panel>
          <OrderIntentsTable orderIntents={orderIntents} />
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="broker-orders">
        <Accordion.Control>
          <SectionLabel label="Broker Orders" count={brokerOrders.length} />
        </Accordion.Control>
        <Accordion.Panel>
          <BrokerOrdersTable brokerOrders={brokerOrders} />
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="broker-activities">
        <Accordion.Control>
          <SectionLabel label="Broker Activities" count={brokerActivities.length} />
        </Accordion.Control>
        <Accordion.Panel>
          <BrokerActivitiesTable brokerActivities={brokerActivities} />
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="system-events">
        <Accordion.Control>
          <SectionLabel label="System Events" count={systemEvents.length} />
        </Accordion.Control>
        <Accordion.Panel>
          <SystemEventsTable systemEvents={systemEvents} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <Group gap="xs">
      <Text fw={700}>{label}</Text>
      <Badge size="sm" variant="light" color={count > 0 ? "blue" : "gray"}>
        {count}
      </Badge>
    </Group>
  );
}

function OrderIntentsTable({
  orderIntents,
}: {
  orderIntents: TradeCycleOrderIntent[];
}) {
  if (orderIntents.length === 0) {
    return <EmptyState label="No order intents are linked to this cycle." />;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover withTableBorder miw={920}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Created</Table.Th>
            <Table.Th>Side</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th ta="right">Notional</Table.Th>
            <Table.Th ta="right">Limit</Table.Th>
            <Table.Th>Subscription</Table.Th>
            <Table.Th>Reason</Table.Th>
            <Table.Th>Broker Orders</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {orderIntents.map((intent) => (
            <Table.Tr key={intent.id}>
              <Table.Td>{formatDate(intent.createdAt)}</Table.Td>
              <Table.Td>
                <SideBadge side={intent.side} />
              </Table.Td>
              <Table.Td>
                <Badge variant="light" color="cyan">
                  {intent.source}
                </Badge>
              </Table.Td>
              <Table.Td>
                <StatusBadge status={intent.status} />
              </Table.Td>
              <Table.Td ta="right">{formatPreciseNumber(intent.qty)}</Table.Td>
              <Table.Td ta="right">{formatMoney(intent.notional)}</Table.Td>
              <Table.Td ta="right">{formatMoney(intent.limitPrice)}</Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm">{intent.subscriptionKey ?? "-"}</Text>
                  {intent.subscriptionId !== null && (
                    <Text size="xs" c="dimmed">
                      ID {intent.subscriptionId}
                    </Text>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td maw={220}>
                <Text size="sm" lineClamp={3}>
                  {intent.blockReason ?? "-"}
                </Text>
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm">{intent.brokerOrders.length}</Text>
                  {intent.clientOrderId && (
                    <LongCode value={intent.clientOrderId} />
                  )}
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function BrokerOrdersTable({
  brokerOrders,
}: {
  brokerOrders: TradeCycleBrokerOrder[];
}) {
  if (brokerOrders.length === 0) {
    return <EmptyState label="No broker orders are linked to this cycle." />;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover withTableBorder miw={1040}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Created</Table.Th>
            <Table.Th>Side</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>TIF</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th ta="right">Notional</Table.Th>
            <Table.Th ta="right">Filled</Table.Th>
            <Table.Th ta="right">Avg Fill</Table.Th>
            <Table.Th>Broker Order</Table.Th>
            <Table.Th>Intent</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {brokerOrders.map((order) => {
            const brokerFields = readBrokerOrderFields(order.rawBrokerJson);

            return (
              <Table.Tr key={order.id}>
                <Table.Td>{formatDate(order.createdAt)}</Table.Td>
                <Table.Td>
                  <SideBadge side={order.side} />
                </Table.Td>
                <Table.Td>
                  <StatusBadge status={order.status} />
                </Table.Td>
                <Table.Td>{brokerFields.type ?? "-"}</Table.Td>
                <Table.Td>{brokerFields.timeInForce ?? "-"}</Table.Td>
                <Table.Td ta="right">{formatPreciseNumber(brokerFields.qty)}</Table.Td>
                <Table.Td ta="right">{formatMoney(brokerFields.notional)}</Table.Td>
                <Table.Td ta="right">
                  {formatPreciseNumber(brokerFields.filledQty)}
                </Table.Td>
                <Table.Td ta="right">{formatMoney(brokerFields.filledAvgPrice)}</Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    <LongCode value={order.brokerOrderId} />
                    <LongCode value={order.clientOrderId} />
                  </Stack>
                </Table.Td>
                <Table.Td>{order.orderIntentId}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function BrokerActivitiesTable({
  brokerActivities,
}: {
  brokerActivities: TradeCycleBrokerActivity[];
}) {
  if (brokerActivities.length === 0) {
    return <EmptyState label="No broker activities are linked to this cycle." />;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover withTableBorder miw={1040}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Transaction</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Category</Table.Th>
            <Table.Th>Side</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th ta="right">Cum Qty</Table.Th>
            <Table.Th ta="right">Price</Table.Th>
            <Table.Th ta="right">Net</Table.Th>
            <Table.Th>Broker Order</Table.Th>
            <Table.Th>Links</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {brokerActivities.map((activity) => (
            <Table.Tr key={activity.id}>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm">{formatDate(activity.transactionTime)}</Text>
                  <Text size="xs" c="dimmed">
                    Imported {formatDate(activity.createdAt)}
                  </Text>
                </Stack>
              </Table.Td>
              <Table.Td>
                <Badge variant="light">{activity.activityType}</Badge>
              </Table.Td>
              <Table.Td>{activity.activityCategory ?? "-"}</Table.Td>
              <Table.Td>
                <SideBadge side={activity.side} />
              </Table.Td>
              <Table.Td ta="right">{formatPreciseNumber(activity.qty)}</Table.Td>
              <Table.Td ta="right">{formatPreciseNumber(activity.cumQty)}</Table.Td>
              <Table.Td ta="right">{formatMoney(activity.price)}</Table.Td>
              <Table.Td ta="right">{formatMoney(activity.netAmount)}</Table.Td>
              <Table.Td>
                {activity.orderId ? <LongCode value={activity.orderId} /> : "-"}
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="xs">Intent: {activity.orderIntentId ?? "-"}</Text>
                  <Text size="xs">
                    Broker row: {activity.brokerOrderRecordId ?? "-"}
                  </Text>
                  <Text size="xs">
                    Position: {activity.trackedPositionId ?? "-"}
                  </Text>
                  {activity.trackedPositionLinkSource && (
                    <Badge size="xs" variant="light" color="gray">
                      {activity.trackedPositionLinkSource}
                    </Badge>
                  )}
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function SystemEventsTable({
  systemEvents,
}: {
  systemEvents: TradeCycleSystemEvent[];
}) {
  if (systemEvents.length === 0) {
    return <EmptyState label="No system events are linked to this cycle." />;
  }

  return (
    <ScrollArea>
      <Table striped highlightOnHover withTableBorder miw={900}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Time</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Message</Table.Th>
            <Table.Th>Entity</Table.Th>
            <Table.Th>Payload</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {systemEvents.map((event) => (
            <Table.Tr key={event.id}>
              <Table.Td>{formatDate(event.createdAt)}</Table.Td>
              <Table.Td>
                <Badge variant="light" color="orange">
                  {event.type}
                </Badge>
              </Table.Td>
              <Table.Td maw={260}>
                <Text size="sm" lineClamp={3}>
                  {event.message ?? "-"}
                </Text>
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm">{event.entityType}</Text>
                  <LongCode value={event.entityId} />
                </Stack>
              </Table.Td>
              <Table.Td>
                <PayloadDetails payload={event.payloadJson} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <Text size="sm" c="dimmed">
      {label}
    </Text>
  );
}

function SideBadge({ side }: { side: string | null }) {
  const normalized = side?.toLowerCase() ?? null;

  return (
    <Badge
      color={normalized === "buy" ? "teal" : normalized === "sell" ? "red" : "gray"}
      variant="light"
    >
      {side ?? "-"}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge color={statusColor(status)} variant="light">
      {status}
    </Badge>
  );
}

function statusColor(status: string) {
  switch (status) {
    case "filled":
    case "submitted":
      return "teal";
    case "pending":
    case "submitting":
      return "yellow";
    case "blocked":
    case "failed":
    case "rejected":
      return "red";
    case "canceled":
    case "expired":
      return "gray";
    default:
      return "blue";
  }
}

function LongCode({ value }: { value: string }) {
  return (
    <Code
      fz="xs"
      style={{
        display: "block",
        maxWidth: 220,
        whiteSpace: "normal",
        overflowWrap: "anywhere",
      }}
    >
      {value}
    </Code>
  );
}

function PayloadDetails({ payload }: { payload: unknown }) {
  return (
    <details>
      <summary>
        <Text span size="sm" c="blue">
          View payload
        </Text>
      </summary>
      <ScrollArea h={220} mt="xs">
        <Code block fz="xs">
          {formatJson(payload)}
        </Code>
      </ScrollArea>
    </details>
  );
}

function formatJson(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  return JSON.stringify(value ?? null, null, 2);
}

type BrokerOrderFields = {
  type: string | null;
  timeInForce: string | null;
  qty: number | null;
  notional: number | null;
  filledQty: number | null;
  filledAvgPrice: number | null;
};

function readBrokerOrderFields(value: unknown): BrokerOrderFields {
  if (!isRecord(value)) {
    return emptyBrokerOrderFields();
  }

  return {
    type: readString(value, "type") ?? readString(value, "order_type"),
    timeInForce:
      readString(value, "time_in_force") ?? readString(value, "timeInForce"),
    qty: readNumberLike(value, "qty"),
    notional: readNumberLike(value, "notional"),
    filledQty:
      readNumberLike(value, "filled_qty") ?? readNumberLike(value, "filledQty"),
    filledAvgPrice:
      readNumberLike(value, "filled_avg_price") ??
      readNumberLike(value, "filledAvgPrice"),
  };
}

function emptyBrokerOrderFields(): BrokerOrderFields {
  return {
    type: null,
    timeInForce: null,
    qty: null,
    notional: null,
    filledQty: null,
    filledAvgPrice: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNumberLike(record: Record<string, unknown>, key: string) {
  const value = record[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
