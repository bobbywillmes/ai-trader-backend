import { Badge, Group, Stack, Text } from "@mantine/core";
import type { TradingAccountSummary } from "../types/tradingAccount";

type TradingAccountBadgeProps = {
  account?: TradingAccountSummary | null;
  tradingAccountId?: number | null;
  emptyLabel?: "Global" | "SYSTEM" | "Unassigned";
  layout?: "compact" | "stacked";
};

function environmentColor(environment: TradingAccountSummary["environment"]) {
  return environment === "LIVE" ? "red" : "blue";
}

export function TradingAccountBadge({
  account,
  tradingAccountId,
  emptyLabel = "Unassigned",
  layout = "compact",
}: TradingAccountBadgeProps) {
  if (!account) {
    return (
      <Badge size="sm" color="gray" variant="light">
        {tradingAccountId !== null && tradingAccountId !== undefined
          ? `Account #${tradingAccountId}`
          : emptyLabel}
      </Badge>
    );
  }

  const environmentBadge = (
    <Badge
      size="xs"
      color={environmentColor(account.environment)}
      variant="light"
      style={{ flexShrink: 0 }}
    >
      {account.environment}
    </Badge>
  );

  if (layout === "stacked") {
    return (
      <Stack gap={2}>
        <Text size="sm" fw={600}>
          {account.displayName}
        </Text>
        <Group gap={4}>
          {environmentBadge}
          <Text size="xs" c="dimmed">
            {account.broker}
          </Text>
        </Group>
      </Stack>
    );
  }

  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: "max-content" }}>
      <Text size="sm" fw={600} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
        {account.displayName}
      </Text>
      {environmentBadge}
    </Group>
  );
}
