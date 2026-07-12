import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { useAuth } from "../auth/useAuth";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import type { TradingAccount } from "../tradingAccounts/types";

function formatMoney(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

function environmentColor(environment: TradingAccount["environment"]) {
  return environment === "LIVE" ? "red" : "yellow";
}

function accountStatusColor(status: TradingAccount["status"]) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "PAUSED":
      return "yellow";
    case "NEEDS_CREDENTIALS":
      return "orange";
    case "ERROR":
      return "red";
    case "ARCHIVED":
      return "gray";
    default:
      return "gray";
  }
}

function credentialStatusColor(
  status: TradingAccount["credential"]["status"]
) {
  switch (status) {
    case "ACTIVE":
      return "teal";
    case "NEEDS_VERIFICATION":
      return "yellow";
    case "INVALID":
      return "red";
    case "REVOKED":
      return "gray";
    default:
      return "orange";
  }
}

function useAssignedAccounts() {
  const { access } = useAuth();
  const token = getAdminToken();
  const assignedAccountIds = access?.accessibleTradingAccountIds ?? [];
  const assignedAccountIdSet = new Set(assignedAccountIds);
  const query = useTradingAccounts(token);
  const assignedAccounts =
    query.data?.accounts.filter((account) =>
      assignedAccountIdSet.has(account.id)
    ) ?? [];

  return {
    ...query,
    assignedAccountIds,
    assignedAccounts,
  };
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <Card withBorder radius="md" p="md">
      <Text
        size="xs"
        c="dimmed"
        tt="uppercase"
        fw={700}
        style={{ letterSpacing: "0.07em" }}
        mb={6}
      >
        {label}
      </Text>
      <Text size="xl" fw={700}>{value}</Text>
    </Card>
  );
}

function EmptyAssignedAccounts() {
  return (
    <Card withBorder radius="md" p="md">
      <Text fw={600} size="sm">No assigned accounts</Text>
      <Text size="sm" c="dimmed" mt={4}>
        No Trading Account memberships are assigned to this user yet.
      </Text>
    </Card>
  );
}

function LoadingAccounts() {
  return (
    <Group gap="sm">
      <Loader size="sm" color="cyan" />
      <Text size="sm" c="dimmed">Loading assigned accounts...</Text>
    </Group>
  );
}

function AccountBadges({ account }: { account: TradingAccount }) {
  return (
    <Group gap="xs">
      <Badge color={environmentColor(account.environment)} variant="light">
        {account.environment}
      </Badge>
      <Badge color={accountStatusColor(account.status)} variant="light">
        {formatStatus(account.status)}
      </Badge>
    </Group>
  );
}

function DashboardOverview({ account }: { account: TradingAccount }) {
  return (
    <>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2} size="h3">{account.displayName}</Title>
          <Text size="sm" c="dimmed">
            Read-only dashboard for your assigned trading account.
          </Text>
        </div>
        <AccountBadges account={account} />
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <StatCard
          label="Portfolio value"
          value={formatMoney(account.lastPortfolioValue, account.baseCurrency)}
        />
        <StatCard
          label="Equity"
          value={formatMoney(account.lastEquity, account.baseCurrency)}
        />
        <StatCard
          label="Cash"
          value={formatMoney(account.lastCash, account.baseCurrency)}
        />
        <StatCard
          label="Buying power"
          value={formatMoney(account.lastBuyingPower, account.baseCurrency)}
        />
      </SimpleGrid>

      <Card withBorder radius="md" p="md">
        <Text fw={600} size="sm" mb="sm">Account summary</Text>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          <div>
            <Text size="xs" c="dimmed">Broker</Text>
            <Text size="sm" fw={600}>{account.broker}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Account number</Text>
            <Text size="sm" fw={600}>
              {account.brokerAccountNumberMasked ?? "-"}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Broker status</Text>
            <Text size="sm" fw={600}>{account.brokerAccountStatus ?? "-"}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Open position notional</Text>
            <Text size="sm" fw={600}>
              {formatMoney(
                account.totalOpenPositionNotional,
                account.baseCurrency
              )}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Estimated trading capital</Text>
            <Text size="sm" fw={600}>
              {formatMoney(account.estimatedTradingCapital, account.baseCurrency)}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Last broker sync</Text>
            <Text size="sm" fw={600}>
              {formatDateTime(account.lastBrokerSyncAt)}
            </Text>
          </div>
        </SimpleGrid>
      </Card>
    </>
  );
}

export function AccountPortalPage() {
  const {
    assignedAccountIds,
    assignedAccounts,
    isLoading,
    isError,
    error,
  } = useAssignedAccounts();
  const dashboardAccount = assignedAccounts[0];

  return (
    <Stack gap="lg">
      {assignedAccountIds.length === 0 && <EmptyAssignedAccounts />}

      {assignedAccountIds.length > 0 && isLoading && <LoadingAccounts />}

      {assignedAccountIds.length > 0 && isError && (
        <Alert color="red" title="Failed to load dashboard">
          {error instanceof Error ? error.message : "Account data is unavailable."}
        </Alert>
      )}

      {assignedAccountIds.length > 0 &&
        !isLoading &&
        !isError &&
        !dashboardAccount && (
          <Card withBorder radius="md" p="md">
            <Text size="sm" c="dimmed">
              No assigned account details are currently available.
            </Text>
          </Card>
        )}

      {dashboardAccount && <DashboardOverview account={dashboardAccount} />}
    </Stack>
  );
}

export function AccountPortalAccountsPage() {
  const {
    assignedAccountIds,
    assignedAccounts,
    isLoading,
    isError,
    error,
  } = useAssignedAccounts();

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">Accounts</Title>
        <Text size="sm" c="dimmed">
          Read-only trading accounts assigned to your portal access.
        </Text>
      </div>

      {assignedAccountIds.length === 0 && <EmptyAssignedAccounts />}

      {assignedAccountIds.length > 0 && isLoading && <LoadingAccounts />}

      {assignedAccountIds.length > 0 && isError && (
        <Alert color="red" title="Failed to load assigned accounts">
          {error instanceof Error ? error.message : "Account data is unavailable."}
        </Alert>
      )}

      {assignedAccountIds.length > 0 && !isLoading && !isError && (
        <Card withBorder radius="md" p="md">
          {assignedAccounts.length === 0 ? (
            <Text size="sm" c="dimmed">
              No assigned account details are currently available.
            </Text>
          ) : (
            <ScrollArea>
              <Table striped highlightOnHover style={{ minWidth: 1120 }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Account</Table.Th>
                    <Table.Th>Broker</Table.Th>
                    <Table.Th>Environment</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Trading</Table.Th>
                    <Table.Th>Credentials</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>Capital</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>Cash</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>Equity</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>Portfolio</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Open Notional
                    </Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>
                      Buying Power
                    </Table.Th>
                    <Table.Th>Verified</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {assignedAccounts.map((account) => (
                    <Table.Tr key={account.id}>
                      <Table.Td>
                        <Text fw={600}>{account.displayName}</Text>
                        <Text size="xs" c="dimmed">
                          ID {account.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>{account.broker}</Table.Td>
                      <Table.Td>
                        <Badge
                          color={environmentColor(account.environment)}
                          variant="light"
                        >
                          {account.environment}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={accountStatusColor(account.status)}
                          variant="light"
                        >
                          {formatStatus(account.status)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={account.tradingEnabled ? "teal" : "gray"}
                          variant="light"
                        >
                          {account.tradingEnabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={credentialStatusColor(account.credential.status)}
                          variant="light"
                        >
                          {account.credential.exists
                            ? formatStatus(account.credential.status)
                            : "No credentials"}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          account.estimatedTradingCapital,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(account.lastCash, account.baseCurrency)}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(account.lastEquity, account.baseCurrency)}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          account.lastPortfolioValue,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          account.totalOpenPositionNotional,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        {formatMoney(
                          account.lastBuyingPower,
                          account.baseCurrency
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {formatDateTime(account.credential.verifiedAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group justify="flex-end">
                          <Button
                            component={Link}
                            to={`/portal/accounts/${account.id}`}
                            size="xs"
                            variant="subtle"
                          >
                            View
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Card>
      )}
    </Stack>
  );
}
