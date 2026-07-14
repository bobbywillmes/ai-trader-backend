import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useUpdateTradingAccount } from "../../../hooks";
import type { TradingAccount, TradingAccountStatus } from "../../../types";
import { actionableErrorMessage } from "../../utils/errors";
import { formatMoney } from "../../utils/formatters";
import {
  normalizeNumberInput,
  normalizeOptionalText,
} from "../../utils/formValues";
import type { AccountSettingsDraft } from "./types";
import {
  accountToSettingsDraft,
  settingsDraftChanged,
  tradingAccountStatusOptions,
} from "./utils";

export function SafetySettingsCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [draft, setDraft] = useState<AccountSettingsDraft>(() =>
    accountToSettingsDraft(account)
  );
  const updateMutation = useUpdateTradingAccount(token);
  const hasChanges = settingsDraftChanged(account, draft);
  const displayNameValid = draft.displayName.trim().length > 0;
  const capitalValid =
    draft.estimatedTradingCapital === null || draft.estimatedTradingCapital >= 0;
  const deployableCapitalValid =
    draft.maxDeployableNotional !== null
      ? draft.maxDeployableNotional > 0
      : account.enabledAllocatedNotional === 0;

  function resetDraft() {
    setDraft(accountToSettingsDraft(account));
  }

  async function saveSettings() {
    if (!displayNameValid) {
      notifications.show({
        message: "Display name is required.",
        color: "red",
      });
      return;
    }

    if (!capitalValid) {
      notifications.show({
        message: "Estimated trading capital must be zero or greater.",
        color: "red",
      });
      return;
    }
    if (!deployableCapitalValid) {
      notifications.show({
        message: "Max deployable notional must be empty or greater than zero.",
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: account.id,
        payload: {
          displayName: draft.displayName.trim(),
          estimatedTradingCapital: draft.estimatedTradingCapital,
          maxDeployableNotional: draft.maxDeployableNotional,
          status: draft.status,
          tradingEnabled: draft.tradingEnabled,
          killSwitchEnabled: draft.killSwitchEnabled,
          pausedReason: normalizeOptionalText(draft.pausedReason),
          notes: normalizeOptionalText(draft.notes),
        },
      });

      notifications.show({
        message: "Trading account settings saved.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message: actionableErrorMessage(
          error,
          "Failed to save trading account settings."
        ),
        color: "red",
      });
    }
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs">
              <Title order={3}>Safety / Status Controls</Title>
              {hasChanges && (
                <Badge color="blue" variant="light">
                  Unsaved changes
                </Badge>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              Save-gated account settings. Broker identity and broker metadata
              are read-only.
            </Text>
          </div>
          <Group>
            <Button
              variant="default"
              onClick={resetDraft}
              disabled={!hasChanges || updateMutation.isPending}
            >
              Reset
            </Button>
            <Button
              onClick={saveSettings}
              loading={updateMutation.isPending}
              disabled={
                !hasChanges ||
                !displayNameValid ||
                !capitalValid ||
                !deployableCapitalValid
              }
            >
              Save Settings
            </Button>
          </Group>
        </Group>

        {account.environment === "LIVE" && draft.tradingEnabled && (
          <Alert color="red" title="Live trading enablement">
            This would mark a live account as trading-enabled. Credential
            verification does not turn this on automatically.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <TextInput
            label="Display name"
            value={draft.displayName}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                displayName: value,
              }));
            }}
            error={displayNameValid ? undefined : "Display name is required."}
            disabled={updateMutation.isPending}
          />

          <NumberInput
            label="Estimated trading capital"
            value={draft.estimatedTradingCapital ?? ""}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                estimatedTradingCapital: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={capitalValid ? undefined : "Must be zero or greater."}
            disabled={updateMutation.isPending}
          />

          <NumberInput
            label="Max deployable notional"
            description="Authoritative ceiling for enabled allocation budgets."
            value={draft.maxDeployableNotional ?? ""}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                maxDeployableNotional: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={deployableCapitalValid ? undefined : "Must be greater than zero."}
            disabled={updateMutation.isPending}
          />

          <Alert
            color={
              account.remainingDeployableNotional !== null &&
              account.remainingDeployableNotional < 0
                ? "red"
                : "blue"
            }
            title="Allocation capacity"
          >
            Enabled allocation budgets: {formatMoney(
              account.enabledAllocatedNotional,
              account.baseCurrency
            )}. Remaining deployable capacity: {formatMoney(
              account.remainingDeployableNotional,
              account.baseCurrency
            )}.
          </Alert>

          <Select
            label="Status"
            data={tradingAccountStatusOptions}
            value={draft.status}
            onChange={(value) => {
              if (!value) return;

              setDraft((current) => ({
                ...current,
                status: value as TradingAccountStatus,
              }));
            }}
            disabled={updateMutation.isPending}
          />

          <Stack gap="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Automated trading
                </Text>
                <Text size="sm" c="dimmed">
                  Account-level master switch for broker-facing automation.
                </Text>
              </div>
              <Switch
                checked={draft.tradingEnabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;

                  setDraft((current) => ({
                    ...current,
                    tradingEnabled: checked,
                  }));
                }}
                disabled={updateMutation.isPending}
                color="teal"
              />
            </Group>

            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text fw={600} size="sm">
                  Kill switch
                </Text>
                <Text size="sm" c="dimmed">
                  Blocks new account-scoped broker access when enabled.
                </Text>
              </div>
              <Switch
                checked={draft.killSwitchEnabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;

                  setDraft((current) => ({
                    ...current,
                    killSwitchEnabled: checked,
                  }));
                }}
                disabled={updateMutation.isPending}
                color="orange"
              />
            </Group>
          </Stack>

          <Textarea
            label="Paused reason"
            value={draft.pausedReason}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                pausedReason: value,
              }));
            }}
            autosize
            minRows={3}
            disabled={updateMutation.isPending}
          />

          <Textarea
            label="Notes"
            value={draft.notes}
            onChange={(event) => {
              const value = event.currentTarget.value;

              setDraft((current) => ({
                ...current,
                notes: value,
              }));
            }}
            autosize
            minRows={3}
            disabled={updateMutation.isPending}
          />
        </SimpleGrid>
      </Stack>
    </Card>
  );
}
