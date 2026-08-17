import { Alert, Badge, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import {
  useArmLiveEntries,
  useDisarmLiveEntries,
  useLiveWriteApprovals,
  useStageLiveEntryCanary,
  useTradingAccountSubscriptions,
} from '../../../hooks';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

export function LiveEntryArmingCard({ account, assessment, token }: {
  account: TradingAccount;
  assessment: TradingAccountReadinessAssessment | null;
  token: string | null;
}) {
  const assignments = useTradingAccountSubscriptions(account.id, token);
  const approvals = useLiveWriteApprovals(account.id, token);
  const stage = useStageLiveEntryCanary(account.id, token);
  const arm = useArmLiveEntries(account.id, token);
  const disarm = useDisarmLiveEntries(account.id, token);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const rsp = assignments.data?.accountSubscriptions.find((item) => item.subscription.key === 'rsp_dip_core');
  const entry = approvals.data?.capabilities.find((item) => item.capability === 'ENTRY');
  const preview = assessment?.evidence.selectedCanary;
  const armed = Boolean(account.activeLiveEntryArmingId && account.tradingEnabled && !account.killSwitchEnabled);
  const staged = Boolean(rsp?.entriesEnabled && !armed);
  const posture = armed ? 'ACTIVE · ENTRIES ARMED' : staged ? 'ACTIVE · ENTRY STAGED' : 'ACTIVE · ENTRY DISARMED';
  const canArm = Boolean(assessment?.purpose === 'LIVE_ENTRY_ARMING' && assessment.result === 'PASSED' && assessment.validity === 'CURRENT' && entry?.effective && entry.approval && rsp);

  return <Card withBorder>
    <Group justify="space-between"><Title order={3}>Live entry authority</Title><Badge color={armed ? 'red' : staged ? 'yellow' : 'gray'}>{posture}</Badge></Group>
    <Stack gap="sm" mt="md">
      <Text size="sm">Deployment entry permission: {assessment?.evidence.policy?.allowLiveTrading ? 'enabled' : 'disabled'}</Text>
      <Text size="sm">ENTRY approval: {entry?.effective ? `effective revision ${entry.approval?.revision}` : entry?.reason ?? 'missing'}</Text>
      <Text size="sm">Canary assignment: {rsp ? `rsp_dip_core #${rsp.id} · entries ${rsp.entriesEnabled ? 'enabled' : 'disabled'}` : 'not provisioned'}</Text>
      <Text size="sm">Account latches: trading {account.tradingEnabled ? 'enabled' : 'disabled'} · kill switch {account.killSwitchEnabled ? 'enabled' : 'disabled'}</Text>
      <Text size="sm">Active arming binding: {account.activeLiveEntryArmingId ?? 'none'} · one-shot {account.activeLiveEntryArming?.terminations.some((item) => item.type === 'CONSUMED') ? 'consumed' : armed ? 'available' : 'not active'}</Text>
      {preview && <Alert color="blue" title="First-canary sizing preview">
        {preview.symbol} assignment #{preview.tradingAccountSubscriptionId}: MAX_NOTIONAL {String(preview.maxPositionNotional ?? 'unavailable')}; estimated notional up to {String(preview.maxPositionNotional ?? 'unavailable')}; allocation limit {String(preview.allocation?.maxAllocatedNotional ?? 'unavailable')}; account limits {String(preview.accountLimits?.maxDailyEntryOrders ?? 'unavailable')} daily entry / {String(preview.accountLimits?.maxDailyEntryNotional ?? 'unavailable')} daily notional / {String(preview.accountLimits?.maxOpenPositions ?? 'unavailable')} open position / {String(preview.accountLimits?.maxSymbolOpenNotional ?? 'unavailable')} symbol notional. Quantity is shown when runtime pricing makes it available; market fills can exceed estimated notional.
      </Alert>}
      <TextInput label="Operator reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
      <Group>
        <Button variant="default" disabled={!rsp || !reason || stage.isPending || armed} onClick={() => rsp && stage.mutate({ tradingAccountSubscriptionId: rsp.id, reason })}>Stage RSP canary</Button>
        <Button color="red" variant="outline" disabled={!reason || disarm.isPending} onClick={() => disarm.mutate({ reason })}>DISARM LIVE ENTRIES</Button>
      </Group>
      <Alert color="red" title="Real-money authorization">
        ARMING LIVE ENTRIES CAN ALLOW REAL-MONEY BROKER ORDERS.
      </Alert>
      <TextInput label="Type ARM LIVE ENTRIES" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} />
      <Button color="red" disabled={!canArm || !reason || confirmation !== 'ARM LIVE ENTRIES' || arm.isPending}
        onClick={() => entry?.approval && rsp && assessment && arm.mutate({ reason, typedConfirmation: confirmation, readinessAssessmentId: assessment.id, tradingAccountSubscriptionId: rsp.id, entryApprovalId: entry.approval.id, entryApprovalRevision: entry.approval.revision, expectedUpdatedAt: account.updatedAt })}>
        ARM LIVE ENTRIES
      </Button>
      {(stage.isError || arm.isError || disarm.isError) && <Alert color="red">{(stage.error ?? arm.error ?? disarm.error)?.message}</Alert>}
    </Stack>
  </Card>;
}
