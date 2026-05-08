import { useState } from "react";
import {
  Alert,
  Badge,
  Card,
  Divider,
  Group,
  Loader,
  Stack,
  Switch,
  Text,
  Title,
  ThemeIcon,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { useConfig, useUpdateConfig } from "./hooks";

export function SettingsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const { data: config, isLoading, isError } = useConfig(token);
  const updateMutation = useUpdateConfig(token);

  async function applyUpdate(payload: { tradingEnabled?: boolean; paperMode?: boolean }) {
    try {
      await updateMutation.mutateAsync(payload);
      notifications.show({ message: "Settings saved.", color: "teal" });
    } catch (err) {
      notifications.show({
        message: err instanceof Error ? err.message : "Failed to save settings.",
        color: "red",
      });
    }
  }

  function handleTradingToggle(enabled: boolean) {
    if (enabled) {
      modals.openConfirmModal({
        title: "Enable trading",
        children: (
          <Text size="sm">
            This will allow the system to submit new orders when entry signals arrive.
            Make sure your exit profiles and subscriptions are configured correctly before enabling.
          </Text>
        ),
        labels: { confirm: "Enable trading", cancel: "Cancel" },
        confirmProps: { color: "teal" },
        onConfirm: () => applyUpdate({ tradingEnabled: true }),
      });
    } else {
      modals.openConfirmModal({
        title: "Disable trading",
        children: (
          <Text size="sm">
            No new orders will be submitted. Open positions will continue to be monitored and
            exit rules will still apply.
          </Text>
        ),
        labels: { confirm: "Disable trading", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => applyUpdate({ tradingEnabled: false }),
      });
    }
  }

  function handlePaperModeToggle(paperMode: boolean) {
    if (!paperMode) {
      modals.openConfirmModal({
        title: "Switch to live trading",
        children: (
          <Stack gap="sm">
            <Alert color="red" variant="light">
              Live trading uses real money. Orders will be executed against your live Alpaca account.
            </Alert>
            <Text size="sm">
              Ensure your Alpaca API keys are configured for the live environment and that you
              understand the risks before proceeding.
            </Text>
          </Stack>
        ),
        labels: { confirm: "Switch to live", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => applyUpdate({ paperMode: false }),
      });
    } else {
      applyUpdate({ paperMode: true });
    }
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">Settings</Title>
        <Text size="sm" c="dimmed">Runtime trading configuration.</Text>
      </div>

      <Card withBorder radius="md" p="md">
        <Text fw={600} size="sm" mb="md">Trading Controls</Text>

        {isError && (
          <Alert color="red" mb="md">Failed to load settings.</Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">Loading settings…</Text>
          </Group>
        )}

        {config && (
          <Stack gap={0}>
            <Group justify="space-between" py="md">
              <div>
                <Group gap="xs" mb={4}>
                  <Text size="sm" fw={600}>Trading Enabled</Text>
                  <Badge
                    size="xs"
                    color={config.tradingEnabled ? "teal" : "red"}
                    variant="light"
                  >
                    {config.tradingEnabled ? "On" : "Off"}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" maw={420}>
                  Master switch for order submission. When off, entry signals are ignored and
                  no new orders are placed. Open positions continue to be monitored.
                </Text>
              </div>
              <Switch
                checked={config.tradingEnabled}
                onChange={(e) => handleTradingToggle(e.currentTarget.checked)}
                disabled={updateMutation.isPending}
                color="teal"
                size="md"
              />
            </Group>

            <Divider />

            <Group justify="space-between" py="md">
              <div>
                <Group gap="xs" mb={4}>
                  <Text size="sm" fw={600}>Paper Trading Mode</Text>
                  <Badge
                    size="xs"
                    color={config.paperMode ? "yellow" : "red"}
                    variant={config.paperMode ? "light" : "filled"}
                  >
                    {config.paperMode ? "Paper" : "Live"}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" maw={420}>
                  When enabled, orders are simulated using Alpaca's paper trading environment.
                  Disable only when connected to a live Alpaca account and ready to trade real funds.
                </Text>
                {!config.paperMode && (
                  <Group gap="xs" mt={6}>
                    <ThemeIcon size="xs" color="red" variant="light" radius="xl">
                      <Text size="xs">!</Text>
                    </ThemeIcon>
                    <Text size="xs" c="red.4" fw={500}>Live trading is active — real money at risk.</Text>
                  </Group>
                )}
              </div>
              <Switch
                checked={config.paperMode}
                onChange={(e) => handlePaperModeToggle(e.currentTarget.checked)}
                disabled={updateMutation.isPending}
                color="yellow"
                size="md"
              />
            </Group>
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
