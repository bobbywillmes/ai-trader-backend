import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  useTradingAccountRiskSettings,
  useUpdateTradingAccountRiskSettings,
} from "../../../hooks";
import type {
  TradingAccount,
  TradingAccountRiskSettings,
} from "../../../types";
import { DetailItem } from "../../components/DetailItem";
import {
  formatMoney,
  formatQuantity,
  formatStatus,
} from "../../utils/formatters";
import {
  type AccountRiskSettingsDraft,
  normalizeNumberInput,
  riskSettingsDraftChanged,
  riskSettingsDraftToPayload,
  riskSettingsToDraft,
  validateAccountRiskSettingsDraft,
} from "./utils";

function AccountRiskControlsForm({
  account,
  riskSettings,
  token,
}: {
  account: TradingAccount;
  riskSettings: TradingAccountRiskSettings;
  token: string | null;
}) {
  const [draft, setDraft] = useState<AccountRiskSettingsDraft>(() =>
    riskSettingsToDraft(riskSettings)
  );
  const updateMutation = useUpdateTradingAccountRiskSettings(token);
  const hasChanges = riskSettingsDraftChanged(riskSettings, draft);
  const draftError = validateAccountRiskSettingsDraft(draft);

  function resetDraft() {
    setDraft(riskSettingsToDraft(riskSettings));
  }

  async function saveRiskSettings() {
    if (draftError) {
      notifications.show({
        message: draftError,
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: account.id,
        payload: riskSettingsDraftToPayload(draft),
      });

      notifications.show({
        message: "Account risk controls saved.",
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        message:
          error instanceof Error
            ? error.message
            : "Failed to save account risk controls.",
        color: "red",
      });
    }
  }

  function updateDraft(patch: Partial<AccountRiskSettingsDraft>) {
    setDraft((current) => ({
      ...current,
      ...patch,
    }));
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Title order={3}>Account Risk Controls</Title>
            {hasChanges && (
              <Badge color="blue" variant="light">
                Unsaved changes
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            These are the primary routine entry limits for this Trading Account.
            A blank field temporarily uses the matching legacy global fallback.
            Allocation and account-subscription controls remain enforced beneath
            this account layer.
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
            onClick={saveRiskSettings}
            loading={updateMutation.isPending}
            disabled={!hasChanges || draftError !== null}
          >
            Save Controls
          </Button>
        </Group>
      </Group>

      {draftError && (
        <Alert color="yellow">
          {draftError}
        </Alert>
      )}

      {riskSettings.effectiveEntryLimits.usingLegacyGlobalFallback && (
        <Alert color="yellow" title="Legacy fallback is active">
          One or more routine limits are inherited from Global Settings. PAPER
          accounts receive a readiness warning; LIVE accounts remain blocked
          until all four account-owned fields are configured.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <DetailItem
          label="Authoritative account exposure ceiling"
          value={formatMoney(account.maxDeployableNotional, account.baseCurrency)}
        />
        {Object.entries(riskSettings.effectiveEntryLimits.limits).map(
          ([field, limit]) => (
            <DetailItem
              key={field}
              label={formatStatus(field)}
              value={
                <Stack gap={2}>
                  <Text size="sm" fw={600}>
                    {field === "maxDailyEntryOrders" || field === "maxOpenPositions"
                      ? formatQuantity(limit.value)
                      : formatMoney(limit.value, account.baseCurrency)}
                  </Text>
                  <Badge
                    size="xs"
                    color={limit.source === "ACCOUNT" ? "teal" : "yellow"}
                    variant="light"
                  >
                    {limit.source === "ACCOUNT" ? "Account" : "Legacy fallback"}
                  </Badge>
                </Stack>
              }
            />
          )
        )}
      </SimpleGrid>

      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fw={600} size="sm">
            Account risk controls enabled
          </Text>
          <Text size="sm" c="dimmed">
            When disabled, account-specific values are ignored and all four
            routine limits use their legacy global fallbacks.
          </Text>
        </div>
        <Switch
          checked={draft.enabled}
          onChange={(event) =>
            updateDraft({ enabled: event.currentTarget.checked })
          }
          disabled={updateMutation.isPending}
          color="teal"
        />
      </Group>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <NumberInput
          label="Max daily entry orders"
          description="Counted by America/New_York trading date."
          value={draft.maxDailyEntryOrders ?? ""}
          onChange={(value) =>
            updateDraft({ maxDailyEntryOrders: normalizeNumberInput(value) })
          }
          min={1}
          step={1}
          thousandSeparator=","
          error={
            draft.maxDailyEntryOrders === null ||
            (Number.isInteger(draft.maxDailyEntryOrders) &&
              draft.maxDailyEntryOrders > 0)
              ? undefined
              : "Must be a positive whole number."
          }
          disabled={updateMutation.isPending}
        />

        <NumberInput
          label="Max daily entry notional"
          description="Accepted entries count even after they fill."
          value={draft.maxDailyEntryNotional ?? ""}
          onChange={(value) =>
            updateDraft({ maxDailyEntryNotional: normalizeNumberInput(value) })
          }
          min={1}
          thousandSeparator=","
          prefix="$"
          error={
            draft.maxDailyEntryNotional === null ||
            draft.maxDailyEntryNotional > 0
              ? undefined
              : "Must be greater than zero."
          }
          disabled={updateMutation.isPending}
        />

        <NumberInput
          label="Max open positions"
          description="Active positions and unmaterialized pending entries consume slots."
          value={draft.maxOpenPositions ?? ""}
          onChange={(value) =>
            updateDraft({ maxOpenPositions: normalizeNumberInput(value) })
          }
          min={1}
          step={1}
          thousandSeparator=","
          error={
            draft.maxOpenPositions === null ||
            (Number.isInteger(draft.maxOpenPositions) &&
              draft.maxOpenPositions > 0)
              ? undefined
              : "Must be a positive whole number."
          }
          disabled={updateMutation.isPending}
        />

        <NumberInput
          label="Max symbol open notional"
          description="Open, pending, and proposed exposure for the symbol."
          value={draft.maxSymbolOpenNotional ?? ""}
          onChange={(value) =>
            updateDraft({ maxSymbolOpenNotional: normalizeNumberInput(value) })
          }
          min={1}
          thousandSeparator=","
          prefix="$"
          error={
            draft.maxSymbolOpenNotional === null ||
            draft.maxSymbolOpenNotional > 0
              ? undefined
              : "Must be greater than zero."
          }
          disabled={updateMutation.isPending}
        />

      </SimpleGrid>

      <Alert color="blue" title="Superseded account fields">
        maxTotalOpenNotional ({formatMoney(
          riskSettings.maxTotalOpenNotional,
          account.baseCurrency
        )}) and maxSubscriptionOpenNotional ({formatMoney(
          riskSettings.maxSubscriptionOpenNotional,
          account.baseCurrency
        )}) remain stored for Phase 2B compatibility. maxDeployableNotional and
        resolved subscription reservations are authoritative for normal entries.
      </Alert>

      <Textarea
        label="Notes"
        value={draft.notes}
        onChange={(event) =>
          updateDraft({ notes: event.currentTarget.value })
        }
        autosize
        minRows={3}
        disabled={updateMutation.isPending}
      />
    </Stack>
  );
}

export function AccountRiskControlsCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const { data, isLoading, isError, error } = useTradingAccountRiskSettings(
    account.id,
    token
  );
  const riskSettings = data?.riskSettings;

  return (
    <Card withBorder radius="md" p="lg">
      {isLoading && (
        <Group gap="sm">
          <Loader size="sm" color="cyan" />
          <Text size="sm" c="dimmed">
            Loading account risk controls...
          </Text>
        </Group>
      )}

      {isError && (
        <Alert color="red" title="Failed to load account risk controls">
          {error instanceof Error ? error.message : "Unknown error."}
        </Alert>
      )}

      {!isLoading && !isError && !riskSettings && (
        <Alert color="yellow">Account risk controls are unavailable.</Alert>
      )}

      {riskSettings && (
        <AccountRiskControlsForm
          key={`${riskSettings.id}-${riskSettings.updatedAt}`}
          account={account}
          riskSettings={riskSettings}
          token={token}
        />
      )}
    </Card>
  );
}
