import { Badge, Card, Group, Stack, Text, Title } from "@mantine/core";

export function StrategiesPage() {
  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2} size="h3">Strategies</Title>
          <Text size="sm" c="dimmed">
            Review and manage strategy definitions.
          </Text>
        </div>
        <Badge color="gray" variant="light">Placeholder</Badge>
      </Group>

      <Card withBorder radius="md" p="md">
        <Stack gap="xs">
          <Text fw={600}>Strategy management is not available yet.</Text>
          <Text size="sm" c="dimmed">
            This page reserves the admin route for future strategy configuration
            workflows. Existing strategy selection and reporting behavior is unchanged.
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}
