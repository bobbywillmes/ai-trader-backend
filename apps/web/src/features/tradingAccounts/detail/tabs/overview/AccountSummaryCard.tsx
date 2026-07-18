import { Alert, Badge, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import type { TradingAccount } from "../../../types";
import { DetailItem } from "../../components/DetailItem";
import { formatMoney, formatStatus } from "../../utils/formatters";
import { accountStatusColor, environmentColor } from "./utils";

export function AccountSummaryCard({ account }: { account: TradingAccount }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Account Summary</Title>
            <Text size="sm" c="dimmed">
              Broker identity and account-level safety posture.
            </Text>
          </div>
          <Group gap="xs">
            <Badge color={environmentColor(account.environment)} variant="light">
              {account.environment}
            </Badge>
            <Badge color={accountStatusColor(account.status)} variant="light">
              {formatStatus(account.status)}
            </Badge>
          </Group>
        </Group>

        {account.environment === "LIVE" && (
          <Alert color="red" title="Live account">
            Treat every credential and trading-control change for this account as
            broker-facing real-money risk.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <DetailItem label="Display name" value={account.displayName} />
          <DetailItem label="Broker" value={<Stack gap={0}><Text>{account.broker}</Text><Text size="xs" c="dimmed">Permanent — cannot be changed after creation.</Text></Stack>} />
          <DetailItem label="Environment" value={<Stack gap={0}><Text>{account.environment}</Text><Text size="xs" c="dimmed">Permanent — cannot be changed after creation.</Text></Stack>} />
          <DetailItem label="Status" value={formatStatus(account.status)} />
          <DetailItem
            label="Trading enabled"
            value={
              <Badge color={account.tradingEnabled ? "teal" : "gray"}>
                {account.tradingEnabled ? "Enabled" : "Disabled"}
              </Badge>
            }
          />
          <DetailItem
            label="Kill switch"
            value={
              <Badge color={account.killSwitchEnabled ? "orange" : "teal"}>
                {account.killSwitchEnabled ? "Enabled" : "Off"}
              </Badge>
            }
          />
          <DetailItem
            label="Estimated capital"
            value={formatMoney(
              account.estimatedTradingCapital,
              account.baseCurrency
            )}
          />
          <DetailItem label="Base currency" value={account.baseCurrency} />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}
