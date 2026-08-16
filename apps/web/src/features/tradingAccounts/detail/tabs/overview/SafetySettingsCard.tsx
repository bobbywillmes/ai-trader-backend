import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useUpdateTradingAccount } from '../../../hooks';
import type { TradingAccount } from '../../../types';
import { actionableErrorMessage } from '../../utils/errors';
import { formatMoney } from '../../utils/formatters';
import {
  normalizeNumberInput,
  normalizeOptionalText,
} from '../../utils/formValues';
import type { AccountSettingsDraft } from './types';
import {
  accountStatusColor,
  accountToSettingsDraft,
  settingsDraftChanged,
} from './utils';

export function SafetySettingsCard({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const [draft, setDraft] = useState<AccountSettingsDraft>(() =>
    accountToSettingsDraft(account),
  );
  const updateMutation = useUpdateTradingAccount(token);
  const hasChanges = settingsDraftChanged(account, draft);
  const displayNameValid = draft.displayName.trim().length > 0;
  const capitalValid =
    draft.estimatedTradingCapital === null ||
    draft.estimatedTradingCapital >= 0;
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
        message: 'Display name is required.',
        color: 'red',
      });
      return;
    }

    if (!capitalValid) {
      notifications.show({
        message: 'Estimated trading capital must be zero or greater.',
        color: 'red',
      });
      return;
    }
    if (!deployableCapitalValid) {
      notifications.show({
        message: 'Max deployable notional must be empty or greater than zero.',
        color: 'red',
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
          pausedReason: normalizeOptionalText(draft.pausedReason),
          notes: normalizeOptionalText(draft.notes),
        },
      });

      notifications.show({
        message: 'Trading account settings saved.',
        color: 'teal',
      });
    } catch (error) {
      notifications.show({
        message: actionableErrorMessage(
          error,
          'Failed to save trading account settings.',
        ),
        color: 'red',
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

        <Alert color="blue" title="Operational state is managed separately">
          Activation and emergency deactivation use dedicated safety operations.
          Ordinary account editing cannot change status, trading enablement, or
          the account kill switch. Activation is intentionally unavailable in
          this phase.
        </Alert>

        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <div>
            <Text size="xs" c="dimmed">
              Status
            </Text>
            <Badge
              color={
                account.status === 'ACTIVE' &&
                !account.tradingEnabled &&
                account.killSwitchEnabled
                  ? 'yellow'
                  : accountStatusColor(account.status)
              }
              variant="light"
            >
              {account.status === 'ACTIVE' &&
              !account.tradingEnabled &&
              account.killSwitchEnabled
                ? 'ACTIVE · ENTRY DISARMED'
                : account.status.replaceAll('_', ' ')}
            </Badge>
          </div>
          <div>
            <Text size="xs" c="dimmed">
              Automated trading
            </Text>
            <Badge
              color={account.tradingEnabled ? 'teal' : 'gray'}
              variant="light"
            >
              {account.tradingEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <div>
            <Text size="xs" c="dimmed">
              Kill switch
            </Text>
            <Badge
              color={account.killSwitchEnabled ? 'orange' : 'teal'}
              variant="light"
            >
              {account.killSwitchEnabled ? 'Enabled' : 'Off'}
            </Badge>
          </div>
        </SimpleGrid>

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
            error={displayNameValid ? undefined : 'Display name is required.'}
            disabled={updateMutation.isPending}
          />

          <NumberInput
            label="Estimated trading capital"
            value={draft.estimatedTradingCapital ?? ''}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                estimatedTradingCapital: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={capitalValid ? undefined : 'Must be zero or greater.'}
            disabled={updateMutation.isPending}
          />

          <NumberInput
            label="Max deployable notional"
            description="Authoritative ceiling for enabled allocation budgets."
            value={draft.maxDeployableNotional ?? ''}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                maxDeployableNotional: normalizeNumberInput(value),
              }))
            }
            min={0}
            thousandSeparator=","
            prefix="$"
            error={
              deployableCapitalValid ? undefined : 'Must be greater than zero.'
            }
            disabled={updateMutation.isPending}
          />

          <Alert
            color={
              account.remainingDeployableNotional !== null &&
              account.remainingDeployableNotional < 0
                ? 'red'
                : 'blue'
            }
            title="Allocation capacity"
          >
            Enabled allocation budgets:{' '}
            {formatMoney(
              account.enabledAllocatedNotional,
              account.baseCurrency,
            )}
            . Remaining deployable capacity:{' '}
            {formatMoney(
              account.remainingDeployableNotional,
              account.baseCurrency,
            )}
            .
          </Alert>

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
