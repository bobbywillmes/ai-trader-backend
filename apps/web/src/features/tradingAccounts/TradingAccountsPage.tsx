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
import { useNavigate } from "react-router-dom";
import { getAdminToken } from "../../lib/api";
import { useIsSystemOwner } from "../auth/useAuth";
import { CreateTradingAccountModal } from "./CreateTradingAccountModal";
import {
  useTradingAccountRiskHealthSummaries,
  useTradingAccounts,
} from "./hooks";
import type {
  BrokerCredentialStatus,
  TradingAccount,
  TradingAccountEnvironment,
  TradingAccountRiskHealthStatus,
  TradingAccountStatus,
} from "./types";

function formatDateTime(value: string | null | undefined) {
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

function formatMoney(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function accountStatusColor(status: TradingAccountStatus) {
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

function credentialStatusColor(status: BrokerCredentialStatus | null) {
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

function environmentColor(environment: TradingAccountEnvironment) {
  return environment === "LIVE" ? "red" : "blue";
}

function riskHealthStatusColor(status: TradingAccountRiskHealthStatus) {
  switch (status) {
    case "READY":
      return "teal";
    case "READY_WITH_WARNINGS":
      return "yellow";
    case "BLOCKED":
      return "red";
    default:
      return "gray";
  }
}

function riskHealthStatusLabel(status: TradingAccountRiskHealthStatus) {
  switch (status) {
    case "READY":
      return "Ready";
    case "READY_WITH_WARNINGS":
      return "Warnings";
    case "BLOCKED":
      return "Blocked";
    default:
      return status;
  }
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

function CredentialBadge({ account }: { account: TradingAccount }) {
  const status = account.credential.status;

  return (
    <Badge color={credentialStatusColor(status)} variant="light">
      {account.credential.exists ? formatStatus(status) : "No credentials"}
    </Badge>
  );
}

type EntryReadinessBadgeProps = {
  status: TradingAccountRiskHealthStatus | null;
  loading: boolean;
  error: boolean;
};

function EntryReadinessBadge({
  status,
  loading,
  error,
}: EntryReadinessBadgeProps) {
  if (loading) {
    return (
      <Badge color="gray" variant="light">
        Loading
      </Badge>
    );
  }

  if (error || !status) {
    return (
      <Badge color="gray" variant="light">
        Unknown
      </Badge>
    );
  }

  return (
    <Badge color={riskHealthStatusColor(status)} variant="light">
      {riskHealthStatusLabel(status)}
    </Badge>
  );
}

export function TradingAccountsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const navigate = useNavigate();
  const isSystemOwner = useIsSystemOwner();
  const [createOpened, setCreateOpened] = useState(false);
  const { data, isLoading, isError, error } = useTradingAccounts(token);
  const accounts = data?.accounts ?? [];
  const riskHealthQueries = useTradingAccountRiskHealthSummaries(
    accounts.map((account) => account.id),
    token
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
      <div>
        <Title order={2} size="h3">
          Trading Accounts
        </Title>
        <Text size="sm" c="dimmed">
          View broker account scope, safety posture, and credential status.
        </Text>
      </div>
        {isSystemOwner && <Button onClick={() => setCreateOpened(true)}>New Trading Account</Button>}
      </Group>

      <CreateTradingAccountModal opened={createOpened} onClose={() => setCreateOpened(false)} token={token} accounts={accounts} />

      <Card withBorder radius="md" p="md">
        {isError && (
          <Alert color="red" mb="md">
            {error instanceof Error
              ? error.message
              : "Failed to load trading accounts."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">
              Loading trading accounts...
            </Text>
          </Group>
        )}

        {!isLoading && accounts.length === 0 && (
          <Text size="sm" c="dimmed">
            No trading accounts.
          </Text>
        )}

        {accounts.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 1320 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Account</Table.Th>
                  <Table.Th>Broker</Table.Th>
                  <Table.Th>Environment</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Trading</Table.Th>
                  <Table.Th>Kill Switch</Table.Th>
                  <Table.Th>Entry Readiness</Table.Th>
                  <Table.Th>Credentials</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Capital</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Cash</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Equity</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Portfolio</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Open Notional</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Buying Power</Table.Th>
                  <Table.Th>Verified</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accounts.map((account, index) => {
                  const riskHealthQuery = riskHealthQueries[index];
                  const readinessStatus =
                    riskHealthQuery?.data?.riskHealth.status ?? null;

                  return (
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
                          color={account.killSwitchEnabled ? "orange" : "teal"}
                          variant="light"
                        >
                          {account.killSwitchEnabled ? "Enabled" : "Off"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <EntryReadinessBadge
                          status={readinessStatus}
                          loading={riskHealthQuery?.isLoading ?? false}
                          error={riskHealthQuery?.isError ?? false}
                        />
                      </Table.Td>
                      <Table.Td>
                        <CredentialBadge account={account} />
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
                            size="xs"
                            variant="subtle"
                            onClick={() =>
                              navigate(`/trading-accounts/${account.id}`)
                            }
                          >
                            View
                          </Button>
                        </Group>
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
