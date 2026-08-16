import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useIsSystemOwner } from '../../../../auth/useAuth';
import {
  useActivateTradingAccount,
  useLiveWriteApprovals,
} from '../../../hooks';
import type {
  TradingAccount,
  TradingAccountReadinessAssessment,
} from '../../../types';

export function LiveAccountActivationCard({
  account,
  assessment,
  token,
}: {
  account: TradingAccount;
  assessment: TradingAccountReadinessAssessment | null;
  token: string | null;
}) {
  const isSystemOwner = useIsSystemOwner();
  const approvals = useLiveWriteApprovals(account.id, token);
  const activate = useActivateTradingAccount(account.id, token);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const riskAuthorized =
    approvals.data?.capabilities.find(
      (item) => item.capability === 'RISK_REDUCING',
    )?.effective === true;
  const eligible =
    isSystemOwner &&
    account.environment === 'LIVE' &&
    account.status === 'PAUSED' &&
    !account.tradingEnabled &&
    account.killSwitchEnabled &&
    assessment?.result === 'PASSED' &&
    assessment.validity === 'CURRENT' &&
    riskAuthorized;

  if (!isSystemOwner || !eligible || !assessment) return null;

  return (
    <Card withBorder>
      <Stack gap="md">
        <div>
          <Title order={3}>Activate Live account</Title>
          <Text size="sm" c="dimmed">
            Move this account into operational management while keeping every
            Live entry latch disarmed.
          </Text>
        </div>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Card withBorder>
            <Text fw={700}>Before: PAUSED / SAFE</Text>
            <Text size="sm">Trading disabled</Text>
            <Text size="sm">Kill switch enabled</Text>
            <Text size="sm">Risk-reducing authorized</Text>
            <Text size="sm">Entries disabled</Text>
          </Card>
          <Card withBorder>
            <Text fw={700}>After: ACTIVE / ENTRY DISARMED</Text>
            <Text size="sm">Trading disabled</Text>
            <Text size="sm">Kill switch enabled</Text>
            <Text size="sm">Risk-reducing authorized</Text>
            <Text size="sm">Entries disabled</Text>
          </Card>
        </SimpleGrid>
        <Alert color="blue" title="Activation does not arm Live entries">
          Activation performs no broker write. Trading remains disabled, the
          kill switch remains enabled, assignment entries remain disabled, ENTRY
          approval remains separate, and RISK_REDUCING authorization is
          preserved.
        </Alert>
        <TextInput
          label="Activation reason"
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          disabled={activate.isPending}
        />
        <TextInput
          label="Type ACTIVATE LIVE ACCOUNT"
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          disabled={activate.isPending}
          autoComplete="off"
        />
        {activate.isError && (
          <Alert color="red">{activate.error.message}</Alert>
        )}
        <Group justify="flex-end">
          <Button
            loading={activate.isPending}
            disabled={
              !reason.trim() || confirmation !== 'ACTIVATE LIVE ACCOUNT'
            }
            onClick={() =>
              activate.mutate({
                readinessAssessmentId: assessment.id,
                reason: reason.trim(),
                typedConfirmation: 'ACTIVATE LIVE ACCOUNT',
                expectedUpdatedAt: account.updatedAt,
              })
            }
          >
            Activate account with entries disarmed
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
