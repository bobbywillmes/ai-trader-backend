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
import { useTradingAccounts } from "./hooks";
import type {
  BrokerCredentialStatus,
  TradingAccount,
  TradingAccountEnvironment,
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

export function TradingAccountsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useTradingAccounts(token);
  const accounts = data?.accounts ?? [];

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">
          Trading Accounts
        </Title>
        <Text size="sm" c="dimmed">
          View broker account scope, safety posture, and credential status.
        </Text>
      </div>

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
            <Table striped highlightOnHover style={{ minWidth: 1160 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Account</Table.Th>
                  <Table.Th>Broker</Table.Th>
                  <Table.Th>Environment</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Trading</Table.Th>
                  <Table.Th>Kill Switch</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Capital</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Equity</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Buying Power</Table.Th>
                  <Table.Th>Credentials</Table.Th>
                  <Table.Th>Verified</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accounts.map((account) => (
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
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(
                        account.estimatedTradingCapital,
                        account.baseCurrency
                      )}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(account.lastEquity, account.baseCurrency)}
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {formatMoney(
                        account.lastBuyingPower,
                        account.baseCurrency
                      )}
                    </Table.Td>
                    <Table.Td>
                      <CredentialBadge account={account} />
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
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>
    </Stack>
  );
}
