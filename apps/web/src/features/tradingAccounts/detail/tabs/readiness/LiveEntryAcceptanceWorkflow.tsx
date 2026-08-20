import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';

import {
  useAbortLiveEntryAcceptance,
  useCreateLiveEntryAcceptance,
  useCurrentLiveEntryAcceptance,
  useExecuteLiveEntryAcceptance,
  usePreviewLiveEntryAcceptance,
  useVerifyLiveEntryAcceptance,
} from '../../../hooks';
import type { TradingAccount, TradingAccountSubscription } from '../../../types';

const steps = ['SETUP', 'AUTHORIZATION', 'READINESS', 'ARMING', 'EXECUTION', 'VERIFICATION', 'COMPLETION'] as const;

export function LiveEntryAcceptanceWorkflow({ account, assignment, token }: {
  account: TradingAccount;
  assignment: TradingAccountSubscription | undefined;
  token: string | null;
}) {
  const current = useCurrentLiveEntryAcceptance(account.id, token);
  const projection = current.data?.run ?? null;
  const run = projection?.run;
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const create = useCreateLiveEntryAcceptance(account.id, token, {
    tradingAccountSubscriptionId: assignment?.id,
    reason,
  });
  const preview = usePreviewLiveEntryAcceptance(account.id, run?.id, token);
  const execute = useExecuteLiveEntryAcceptance(account.id, run?.id, token, {
    requestKey,
    expectedPreviewRevision: run?.previewRevision,
    expectedPreviewFingerprint: run?.previewFingerprint,
    typedConfirmation: confirmation,
  });
  const verify = useVerifyLiveEntryAcceptance(account.id, run?.id, token);
  const abort = useAbortLiveEntryAcceptance(account.id, run?.id, token, { reason });
  const reviewed = run?.previewJson;
  const expectedConfirmation = reviewed ? `BUY ${reviewed.order.symbol}` : '';
  const activeIndex = projection && projection.phase !== 'ACTION_REQUIRED'
    ? steps.indexOf(projection.phase as (typeof steps)[number])
    : -1;
  const error = create.error ?? preview.error ?? execute.error ?? verify.error ?? abort.error;

  return <Card withBorder data-testid="live-entry-acceptance-workflow">
    <Group justify="space-between" align="flex-start">
      <div>
        <Title order={3}>Live Entry Acceptance</Title>
        <Text size="sm" c="dimmed">Durable first-canary ceremony</Text>
      </div>
      <Badge color={projection?.phase === 'ACTION_REQUIRED' ? 'red' : run?.terminalOutcome === 'CANARY_COMPLETE' ? 'green' : 'yellow'}>
        {projection?.phase ?? 'NOT STARTED'}
      </Badge>
    </Group>

    <SimpleGrid cols={{ base: 2, md: 7 }} mt="md">
      {steps.map((step, index) => <Card withBorder p="xs" key={step}>
        <Text size="xs" fw={700}>{index + 1}. {step}</Text>
        <Badge size="xs" color={run?.terminalAt || activeIndex > index ? 'green' : activeIndex === index ? 'blue' : 'gray'}>
          {run?.terminalAt || activeIndex > index ? 'DONE' : activeIndex === index ? 'CURRENT' : 'PENDING'}
        </Badge>
      </Card>)}
    </SimpleGrid>

    {!run && <Stack mt="md" gap="sm">
      <Alert color="blue">Create one durable ceremony for the selected Live account and canary assignment.</Alert>
      <TextInput label="Operator reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
      <Button disabled={!assignment || !reason.trim() || create.isPending} onClick={() => create.mutate()}>Start acceptance run</Button>
    </Stack>}

    {run && <Stack mt="md" gap="sm">
      <Text size="sm">Run #{run.id} · assignment #{run.tradingAccountSubscriptionId}</Text>
      {projection?.phase === 'ACTION_REQUIRED' && <Alert color="red" title="ACTION REQUIRED">
        Execution remains unresolved. This run blocks re-arming and replacement ceremonies until authoritative broker/local evidence resolves it. Verification is read-only at the broker boundary and never resubmits the order.
      </Alert>}
      {!run.executionClaimedAt && <Group>
        <Button variant="default" disabled={!account.activeLiveEntryArmingId || preview.isPending} onClick={() => preview.mutate()}>
          {reviewed ? 'Regenerate execution preview' : 'Generate execution preview'}
        </Button>
      </Group>}
      {reviewed && <Card withBorder>
        <Title order={4}>Reviewed real broker order</Title>
        <SimpleGrid cols={{ base: 1, md: 2 }} mt="sm">
          <Text size="sm">Environment: <b>{reviewed.environment}</b></Text>
          <Text size="sm">Account: <b>{account.displayName}</b></Text>
          <Text size="sm">Assignment: <b>#{run.tradingAccountSubscriptionId}</b></Text>
          <Text size="sm">Order: <b>{reviewed.order.side.toUpperCase()} {reviewed.order.qty} {reviewed.order.symbol}</b></Text>
          <Text size="sm">Type / TIF: <b>{reviewed.order.orderType.toUpperCase()} / {reviewed.order.timeInForce.toUpperCase()}</b></Text>
          <Text size="sm">Reference price: <b>{reviewed.order.referencePrice ?? 'unavailable'}</b></Text>
          <Text size="sm">Estimated notional: <b>{reviewed.order.estimatedNotional ?? 'unavailable'}</b></Text>
          <Text size="sm">Arming expires: <b>{new Date(reviewed.arming.expiresAt).toLocaleString()}</b></Text>
        </SimpleGrid>
        {!run.executionClaimedAt && <Stack mt="md">
          <Alert color="red" title="REAL LIVE ORDER">
            A real broker BUY order will be submitted. One-shot Live entry authority is consumed transactionally before outbound submission.
          </Alert>
          <TextInput label={`Type ${expectedConfirmation}`} value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} />
          <Button color="red" disabled={confirmation !== expectedConfirmation || execute.isPending} onClick={() => execute.mutate(undefined, { onSuccess: () => setRequestKey(crypto.randomUUID()) })}>
            Submit real broker order
          </Button>
        </Stack>}
      </Card>}
      {run.executionClaimedAt && <Group>
        <Button disabled={verify.isPending} onClick={() => verify.mutate()}>Refresh authoritative verification</Button>
      </Group>}
      {run.orderIntent && <Card withBorder>
        <Title order={4}>Post-execution evidence</Title>
        <Text size="sm">OrderIntent #{run.orderIntent.id}: {run.orderIntent.status}</Text>
        <Text size="sm">Client identity: {run.orderIntent.clientOrderId ?? 'unavailable'}</Text>
        <Text size="sm">BrokerOrder: {run.orderIntent.brokerOrders[0]?.brokerOrderId ?? 'not observed'} · {run.orderIntent.brokerOrders[0]?.status ?? 'not observed'}</Text>
        <Text size="sm">TrackedPosition: {run.orderIntent.trackedPosition ? `#${run.orderIntent.trackedPosition.id} · ${run.orderIntent.trackedPosition.status} · qty ${run.orderIntent.trackedPosition.qty}` : 'not observed'}</Text>
      </Card>}
      {run.terminalOutcome && <Alert color={run.terminalOutcome === 'CANARY_COMPLETE' ? 'green' : 'yellow'} title={run.terminalOutcome.replaceAll('_', ' ')}>
        {run.terminalReason}
      </Alert>}
      {!run.executionClaimedAt && !run.terminalAt && <Stack>
        <TextInput label="Abort reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
        <Button color="red" variant="outline" disabled={!reason.trim() || abort.isPending} onClick={() => abort.mutate()}>Abort before execution</Button>
      </Stack>}
    </Stack>}
    {error && <Alert color="red" mt="md">{error.message}</Alert>}
  </Card>;
}

