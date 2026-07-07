import { Card, Stack, Text, Title } from "@mantine/core";

import { useAuth } from "../auth/useAuth";

export function ViewerPortalPage() {
  const { access } = useAuth();
  const assignedAccountCount = access?.accessibleTradingAccountIds?.length ?? 0;

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">Account Portal</Title>
        <Text size="sm" c="dimmed">
          Read-only account access for assigned trading accounts.
        </Text>
      </div>

      <Card withBorder radius="md" p="md">
        <Text fw={600} size="sm">Portal access</Text>
        <Text size="sm" c="dimmed" mt={4}>
          {assignedAccountCount === 0
            ? "No trading accounts are assigned to this viewer yet."
            : `${assignedAccountCount} assigned trading account${assignedAccountCount === 1 ? "" : "s"} available.`}
        </Text>
      </Card>
    </Stack>
  );
}
