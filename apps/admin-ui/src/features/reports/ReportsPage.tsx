import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import {
  useAccountSnapshots,
  useBrokerActivities,
  useCreateManualAccountSnapshot,
  useSyncBrokerActivities,
} from "./hooks";
import type { BrokerActivitiesQuery } from "./types";

function formatDate(value: string | null) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

function normalizeLimit(value: string | number, fallback: number) {
  if (value === "") return fallback;

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sideColor(side: string | null) {
  if (side === "buy") return "teal";
  if (side === "sell") return "red";
  return "gray";
}

export function ReportsPage() {
  const [token] = useState(() => getAdminToken());

  const [snapshotLimit, setSnapshotLimit] = useState(20);
  const [activityLimit, setActivityLimit] = useState(20);
  const [symbolFilter, setSymbolFilter] = useState("");
  const [activityTypeFilter, setActivityTypeFilter] = useState<string | null>(
    "FILL"
  );

  const brokerQuery = useMemo(() => {
    const query: BrokerActivitiesQuery = {
      limit: activityLimit,
    };

    const symbol = symbolFilter.trim().toUpperCase();

    if (symbol) {
      query.symbol = symbol;
    }

    if (activityTypeFilter) {
      query.activityType = activityTypeFilter;
    }

    return query;
  }, [activityLimit, activityTypeFilter, symbolFilter]);

  const accountSnapshotsQuery = useAccountSnapshots(token, snapshotLimit);
  const brokerActivitiesQuery = useBrokerActivities(token, brokerQuery);

  const manualSnapshotMutation = useCreateManualAccountSnapshot(token);
  const brokerSyncMutation = useSyncBrokerActivities(token);

  const snapshots = accountSnapshotsQuery.data?.snapshots ?? [];
  const activities = brokerActivitiesQuery.data?.activities ?? [];
  const latestSnapshot = snapshots[0];

  async function handleManualSnapshot() {
    try {
      const result = await manualSnapshotMutation.mutateAsync();

      notifications.show({
        color: "teal",
        message: result.created
          ? "Account snapshot recorded."
          : "Account snapshot skipped.",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        message:
          error instanceof Error
            ? error.message
            : "Failed to record account snapshot.",
      });
    }
  }

  async function handleBrokerSync() {
    try {
      const result = await brokerSyncMutation.mutateAsync();

      notifications.show({
        color: "teal",
        message: `Broker sync complete. Seen: ${result.seen}, created: ${result.created}, updated: ${result.updated}.`,
      });
    } catch (error) {
      notifications.show({
        color: "red",
        message:
          error instanceof Error
            ? error.message
            : "Failed to sync broker activities.",
      });
    }
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Reports</Title>
          <Text c="dimmed">
            Account snapshots and broker-confirmed activity for production
            auditing.
          </Text>
        </div>

        <Group>
          <Button
            variant="default"
            onClick={handleManualSnapshot}
            loading={manualSnapshotMutation.isPending}
          >
            Record Account Snapshot
          </Button>

          <Button
            onClick={handleBrokerSync}
            loading={brokerSyncMutation.isPending}
          >
            Sync Broker Fills
          </Button>
        </Group>
      </Group>

      {latestSnapshot && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Latest Snapshot
            </Text>
            <Text fw={700}>{formatDate(latestSnapshot.createdAt)}</Text>
            <Badge variant="light" color={latestSnapshot.changed ? "teal" : "gray"}>
              {latestSnapshot.reason}
            </Badge>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Cash
            </Text>
            <Text fw={700}>{formatMoney(latestSnapshot.cash)}</Text>
            <Text size="xs" c="dimmed">
              Buying power: {formatMoney(latestSnapshot.buyingPower)}
            </Text>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Equity
            </Text>
            <Text fw={700}>{formatMoney(latestSnapshot.equity)}</Text>
            <Text size="xs" c="dimmed">
              Portfolio: {formatMoney(latestSnapshot.portfolioValue)}
            </Text>
          </Card>

          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              Day P/L
            </Text>
            <Text fw={700}>{formatMoney(latestSnapshot.dayPnL)}</Text>
            <Text size="xs" c="dimmed">
              {latestSnapshot.dayPnLPct === null
                ? "-"
                : `${latestSnapshot.dayPnLPct.toFixed(3)}%`}
            </Text>
          </Card>
        </SimpleGrid>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card withBorder radius="md" p="lg">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={3}>Account Snapshots</Title>
                <Text size="sm" c="dimmed">
                  Account-level cash, buying power, equity, and portfolio value
                  checkpoints.
                </Text>
              </div>

              <NumberInput
                label="Limit"
                value={snapshotLimit}
                min={1}
                max={200}
                w={110}
                onChange={(value) =>
                  setSnapshotLimit(normalizeLimit(value, snapshotLimit))
                }
              />
            </Group>

            <Divider />

            {accountSnapshotsQuery.isLoading && (
              <Group>
                <Loader size="sm" />
                <Text>Loading snapshots…</Text>
              </Group>
            )}

            {accountSnapshotsQuery.isError && (
              <Alert color="red" title="Failed to load account snapshots">
                Check the backend route and admin session.
              </Alert>
            )}

            {!accountSnapshotsQuery.isLoading && snapshots.length === 0 && (
              <Text c="dimmed">No account snapshots recorded yet.</Text>
            )}

            {snapshots.length > 0 && (
              <ScrollArea>
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Reason</Table.Th>
                      <Table.Th>Cash</Table.Th>
                      <Table.Th>Buying Power</Table.Th>
                      <Table.Th>Equity</Table.Th>
                      <Table.Th>Changed</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {snapshots.map((snapshot) => (
                      <Table.Tr key={snapshot.id}>
                        <Table.Td>{formatDate(snapshot.createdAt)}</Table.Td>
                        <Table.Td>
                          <Badge variant="light">{snapshot.reason}</Badge>
                        </Table.Td>
                        <Table.Td>{formatMoney(snapshot.cash)}</Table.Td>
                        <Table.Td>{formatMoney(snapshot.buyingPower)}</Table.Td>
                        <Table.Td>{formatMoney(snapshot.equity)}</Table.Td>
                        <Table.Td>
                          <Badge
                            color={snapshot.changed ? "teal" : "gray"}
                            variant="light"
                          >
                            {snapshot.changed ? "Yes" : "No"}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Stack>
        </Card>

        <Card withBorder radius="md" p="lg">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={3}>Broker Activity</Title>
                <Text size="sm" c="dimmed">
                  Broker-confirmed fills and related account activity imported
                  from Alpaca.
                </Text>
              </div>

              <Group align="flex-end">
                <TextInput
                  label="Symbol"
                  placeholder="SPY"
                  value={symbolFilter}
                  onChange={(event) => setSymbolFilter(event.currentTarget.value)}
                  w={100}
                />

                <Select
                  label="Type"
                  value={activityTypeFilter}
                  onChange={setActivityTypeFilter}
                  data={[
                    { value: "FILL", label: "FILL" },
                    { value: "", label: "All" },
                  ]}
                  w={110}
                />

                <NumberInput
                  label="Limit"
                  value={activityLimit}
                  min={1}
                  max={200}
                  w={110}
                  onChange={(value) =>
                    setActivityLimit(normalizeLimit(value, activityLimit))
                  }
                />
              </Group>
            </Group>

            <Divider />

            {brokerActivitiesQuery.isLoading && (
              <Group>
                <Loader size="sm" />
                <Text>Loading broker activities…</Text>
              </Group>
            )}

            {brokerActivitiesQuery.isError && (
              <Alert color="red" title="Failed to load broker activities">
                Check the backend route and admin session.
              </Alert>
            )}

            {!brokerActivitiesQuery.isLoading && activities.length === 0 && (
              <Text c="dimmed">No broker activities found.</Text>
            )}

            {activities.length > 0 && (
              <ScrollArea>
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Symbol</Table.Th>
                      <Table.Th>Side</Table.Th>
                      <Table.Th>Qty</Table.Th>
                      <Table.Th>Price</Table.Th>
                      <Table.Th>Intent</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {activities.map((activity) => (
                      <Table.Tr key={activity.id}>
                        <Table.Td>
                          {formatDate(activity.transactionTime)}
                        </Table.Td>
                        <Table.Td>
                          <Badge variant="light">{activity.activityType}</Badge>
                        </Table.Td>
                        <Table.Td>{activity.symbol ?? "-"}</Table.Td>
                        <Table.Td>
                          <Badge
                            color={sideColor(activity.side)}
                            variant="light"
                          >
                            {activity.side ?? "-"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>{formatNumber(activity.qty)}</Table.Td>
                        <Table.Td>{formatMoney(activity.price)}</Table.Td>
                        <Table.Td>
                          {activity.orderIntentId === null
                            ? "-"
                            : activity.orderIntentId}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}