import { Button, Group, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";

export function AccountDetailHeader({ displayName }: { displayName?: string }) {
  return (
    <Group justify="space-between" align="flex-start">
      <div>
        <Button
          component={Link}
          to="/trading-accounts"
          variant="subtle"
          size="xs"
          mb="xs"
        >
          Back to Trading Accounts
        </Button>
        <Title order={2} size="h3">
          {displayName ?? "Trading Account"}
        </Title>
        <Text size="sm" c="dimmed">
          Account-scoped broker metadata, credential status, and safety controls.
        </Text>
      </div>
    </Group>
  );
}
