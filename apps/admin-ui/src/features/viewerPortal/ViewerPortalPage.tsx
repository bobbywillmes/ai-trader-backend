import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link, Navigate } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import type { TradingAccount } from "../tradingAccounts/types";
import { useAuth } from "../auth/useAuth";

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function environmentColor(environment: TradingAccount["environment"]) {
  return environment === "LIVE" ? "red" : "yellow";
}

function AccountCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" align="flex-start" mb="sm">
        <div>
          <Text fw={700}>{account.displayName}</Text>
          <Text size="xs" c="dimmed">
            {account.broker} account {account.brokerAccountNumberMasked ?? "-"}
          </Text>
        </div>
        <Group gap="xs">
          <Badge color={environmentColor(account.environment)} variant="light">
            {account.environment}
          </Badge>
          <Badge color="gray" variant="light">
            {account.status}
          </Badge>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm" mb="md">
        <div>
          <Text size="xs" c="dimmed">Portfolio value</Text>
          <Text size="sm" fw={600}>{formatMoney(account.lastPortfolioValue)}</Text>
        </div>
        <div>
          <Text size="xs" c="dimmed">Cash</Text>
          <Text size="sm" fw={600}>{formatMoney(account.lastCash)}</Text>
        </div>
        <div>
          <Text size="xs" c="dimmed">Buying power</Text>
          <Text size="sm" fw={600}>{formatMoney(account.lastBuyingPower)}</Text>
        </div>
        <div>
          <Text size="xs" c="dimmed">Open notional</Text>
          <Text size="sm" fw={600}>
            {formatMoney(account.totalOpenPositionNotional)}
          </Text>
        </div>
      </SimpleGrid>

      <Button
        component={Link}
        to={`/portal/accounts/${account.id}`}
        variant="light"
        color="cyan"
        size="xs"
      >
        View account
      </Button>
    </Card>
  );
}

export function ViewerPortalPage() {
  const { access } = useAuth();
  const token = getAdminToken();
  const assignedAccountIds = access?.accessibleTradingAccountIds ?? [];
  const { data, isLoading, isError, error } = useTradingAccounts(token);
  const assignedAccountIdSet = new Set(assignedAccountIds);
  const assignedAccounts =
    data?.accounts.filter((account) => assignedAccountIdSet.has(account.id)) ??
    [];

  if (assignedAccountIds.length === 1) {
    return <Navigate to={`/portal/accounts/${assignedAccountIds[0]}`} replace />;
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">Account Portal</Title>
        <Text size="sm" c="dimmed">
          Read-only account access for assigned trading accounts.
        </Text>
      </div>

      {assignedAccountIds.length === 0 && (
        <Card withBorder radius="md" p="md">
          <Text fw={600} size="sm">No assigned accounts</Text>
          <Text size="sm" c="dimmed" mt={4}>
            No trading accounts are assigned to this viewer yet.
          </Text>
        </Card>
      )}

      {assignedAccountIds.length > 1 && isLoading && (
        <Group gap="sm">
          <Loader size="sm" color="cyan" />
          <Text size="sm" c="dimmed">Loading assigned accounts...</Text>
        </Group>
      )}

      {assignedAccountIds.length > 1 && isError && (
        <Alert color="red" title="Failed to load assigned accounts">
          {error instanceof Error ? error.message : "Account data is unavailable."}
        </Alert>
      )}

      {assignedAccountIds.length > 1 && !isLoading && !isError && (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Select an assigned trading account to view read-only account details.
          </Text>
          {assignedAccounts.length === 0 ? (
            <Card withBorder radius="md" p="md">
              <Text size="sm" c="dimmed">
                No assigned account details are currently available.
              </Text>
            </Card>
          ) : (
            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
              {assignedAccounts.map((account) => (
                <AccountCard key={account.id} account={account} />
              ))}
            </SimpleGrid>
          )}
        </Stack>
      )}
    </Stack>
  );
}
