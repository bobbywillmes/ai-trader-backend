import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";

export function AccountTabPlaceholder({
  title,
  description,
  actionLabel,
  actionTo,
  secondaryActionLabel,
  secondaryActionTo,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: string;
  secondaryActionLabel?: string;
  secondaryActionTo?: string;
}) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="sm" align="flex-start">
        <Title order={3}>{title}</Title>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
        {(actionLabel && actionTo) ||
        (secondaryActionLabel && secondaryActionTo) ? (
          <Group gap="xs">
            {actionLabel && actionTo && (
              <Button component={Link} to={actionTo} variant="light" size="xs">
                {actionLabel}
              </Button>
            )}
            {secondaryActionLabel && secondaryActionTo && (
              <Button
                component={Link}
                to={secondaryActionTo}
                variant="default"
                size="xs"
              >
                {secondaryActionLabel}
              </Button>
            )}
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}
