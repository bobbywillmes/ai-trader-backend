import { Alert, Badge, Card, Group, Loader, Stack, Table, Text, Title } from "@mantine/core";
import { useTradingAccountWorkerHealth } from "../../../hooks";
import type { TradingAccount, TradingAccountWorkerStatus } from "../../../types";

const color: Record<TradingAccountWorkerStatus, string> = {
  HEALTHY: "green", DORMANT: "gray", STARTING: "blue", DEGRADED: "yellow",
  DELAYED: "orange", STALE: "red", FAILING: "red", BACKING_OFF: "orange",
};
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "Never";

export function AccountWorkerHealthCard({ account, token }: {
  account: TradingAccount; token: string | null;
}) {
  const query = useTradingAccountWorkerHealth(account.id, token);
  return (
    <Card withBorder>
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={4}>Account worker health</Title>
          <Badge color={account.environment === "LIVE" ? "red" : "blue"}>
            {account.environment}
          </Badge>
        </Group>
        {query.isLoading && <Loader size="sm" />}
        {query.isError && <Alert color="red">Worker health could not be loaded.</Alert>}
        {query.data?.workers.length === 0 && (
          <Text c="dimmed" size="sm">No account workflow attempts have been recorded yet.</Text>
        )}
        {query.data && query.data.workers.length > 0 && (
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover>
              <Table.Thead><Table.Tr>
                <Table.Th>Workflow</Table.Th><Table.Th>Status</Table.Th>
                <Table.Th>Last success</Table.Th><Table.Th>Last failure</Table.Th>
                <Table.Th>Lock skips</Table.Th><Table.Th>Backoff</Table.Th><Table.Th>Safe detail</Table.Th>
              </Table.Tr></Table.Thead>
              <Table.Tbody>{query.data.workers.map((worker) => (
                <Table.Tr key={worker.workerKey}>
                  <Table.Td>{worker.workerKey.replaceAll("_", " ")}</Table.Td>
                  <Table.Td><Badge color={color[worker.status]}>{worker.status}</Badge></Table.Td>
                  <Table.Td>{date(worker.lastSucceededAt)}</Table.Td>
                  <Table.Td>{date(worker.lastFailedAt)}</Table.Td>
                  <Table.Td>{worker.totalLockSkips}</Table.Td>
                  <Table.Td>{worker.backoffUntil ? date(worker.backoffUntil) : "—"}</Table.Td>
                  <Table.Td>{worker.lastError ?? worker.eligibilityReason ?? "—"}</Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Card>
  );
}
