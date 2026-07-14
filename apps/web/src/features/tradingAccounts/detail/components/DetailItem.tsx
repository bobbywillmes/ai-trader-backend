import type { ReactNode } from "react";
import { Stack, Text } from "@mantine/core";

export function DetailItem({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value ?? "-"}
      </Text>
    </Stack>
  );
}
