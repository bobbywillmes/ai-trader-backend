import { Alert, Button, Center, Loader, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconDatabaseOff } from "@tabler/icons-react";

type Props = { state: "loading" | "empty" | "error"; title?: string; message?: string; onRetry?: () => void; action?: { label: string; onClick: () => void } };

export function DataState({ state, title, message, onRetry, action }: Props) {
  if (state === "loading") return <Center py="xl" role="status" aria-live="polite" aria-busy="true"><Stack align="center" gap="sm"><Loader size="sm" /><Text c="dimmed" size="sm">{message ?? "Loading records…"}</Text></Stack></Center>;
  if (state === "error") return <Alert role="alert" color="red" icon={<IconAlertCircle />} title={title ?? "Unable to load records"}>{message ?? "Something went wrong. Try again."}{onRetry && <Button mt="sm" size="xs" color="red" variant="light" onClick={onRetry}>Retry</Button>}</Alert>;
  return <Center py="xl"><Stack align="center" gap="xs"><IconDatabaseOff aria-hidden="true" /><Text fw={600}>{title ?? "No records"}</Text><Text c="dimmed" size="sm">{message ?? "There is nothing to show yet."}</Text>{action && <Button mt="xs" size="xs" variant="default" onClick={action.onClick}>{action.label}</Button>}</Stack></Center>;
}
