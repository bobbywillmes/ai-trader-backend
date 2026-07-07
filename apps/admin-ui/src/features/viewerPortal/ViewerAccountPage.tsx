import { Alert, Badge, Card, Group, Loader, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { Link, Navigate, useParams } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { useAuth } from "../auth/useAuth";
import { useTradingAccount } from "../tradingAccounts/hooks";
import type { TradingAccount } from "../tradingAccounts/types";

function parseAccountId(value: string | undefined) {
  const id = Number(value);

  return Number.isInteger(id) && id > 0 ? id : null;
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function environmentColor(environment: TradingAccount["environment"]) {
  return environment === "LIVE" ? "red" : "yellow";
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

export function ViewerAccountPage() {
  const { accountId } = useParams();
  const id = parseAccountId(accountId);
  const { access } = useAuth();
  const token = getAdminToken();
  const assignedAccountIds = access?.accessibleTradingAccountIds ?? [];
  const assignedAccountIdSet = new Set(assignedAccountIds);
  const { data, isLoading, isError, error } = useTradingAccount(id ?? undefined, token);

  if (!id) {
    return <Navigate to="/portal" replace />;
  }

  if (!assignedAccountIdSet.has(id)) {
    return (
      <Alert color="red" title="Not authorized">
        This trading account is not assigned to your portal access.{" "}
        <Text component={Link} to="/portal" size="sm" c="red.7">
          Back to portal
        </Text>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Group gap="sm">
        <Loader size="sm" color="cyan" />
        <Text size="sm" c="dimmed">Loading account...</Text>
      </Group>
    );
  }

  if (isError || !data?.account) {
    return (
      <Alert color="red" title="Failed to load account">
        {error instanceof Error ? error.message : "Account data is unavailable."}
      </Alert>
    );
  }

  const account = data.account;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2} size="h3">{account.displayName}</Title>
          <Text size="sm" c="dimmed">
            Read-only account overview
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

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <StatCard label="Portfolio value" value={formatMoney(account.lastPortfolioValue)} />
        <StatCard label="Equity" value={formatMoney(account.lastEquity)} />
        <StatCard label="Cash" value={formatMoney(account.lastCash)} />
        <StatCard label="Buying power" value={formatMoney(account.lastBuyingPower)} />
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
              {formatMoney(account.totalOpenPositionNotional)}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Estimated trading capital</Text>
            <Text size="sm" fw={600}>
              {formatMoney(account.estimatedTradingCapital)}
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
    </Stack>
  );
}
