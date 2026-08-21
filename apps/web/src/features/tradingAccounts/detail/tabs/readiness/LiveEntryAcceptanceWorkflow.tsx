import { Alert, Badge, Button, Card, Group, List, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
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
import type { deriveLiveEntrySetupState } from './liveEntrySetupState';

const steps = ['SETUP', 'AUTHORIZATION', 'READINESS', 'ARMING', 'EXECUTION', 'VERIFICATION', 'COMPLETION'] as const;

function evidenceText(value: unknown, fallback = 'not recorded') {
  if (value === null || value === undefined || value === '') return fallback;
  if (Array.isArray(value)) return value.length === 0 ? 'none' : JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export function LiveEntryAcceptanceWorkflow({
  account,
  assignment,
  token,
  prerequisiteState,
  deploymentRole,
}: {
  account: TradingAccount;
  assignment: TradingAccountSubscription | undefined;
  token: string | null;
  prerequisiteState?: ReturnType<typeof deriveLiveEntrySetupState>;
  deploymentRole?: 'OBSERVATION_ONLY' | 'PRODUCTION_EXECUTOR';
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
  const observationOnly = deploymentRole === 'OBSERVATION_ONLY';
  const canaryComplete = run?.terminalOutcome === 'CANARY_COMPLETE';
  const terminalEvidence = run?.terminalEvidenceJson ?? {};
  const brokerOrder = run?.orderIntent?.brokerOrders[0];
  const fills = run?.orderIntent?.brokerActivities.filter((activity) => activity.activityType === 'FILL') ?? [];
  const armingTermination = run?.liveEntryArming?.terminations.at(-1);

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
        <Badge size="xs" color={canaryComplete || activeIndex > index ? 'green' : activeIndex === index ? 'blue' : 'gray'}>
          {canaryComplete || activeIndex > index ? 'DONE' : activeIndex === index ? 'CURRENT' : 'PENDING'}
        </Badge>
      </Card>)}
    </SimpleGrid>

    {run && prerequisiteState && !run.executionClaimedAt && !run.terminalAt && (
      <Card withBorder mt="md" data-testid="acceptance-current-guidance">
        <Title order={4}>Current ceremony guidance</Title>
        <Text size="sm" c="dimmed">
          The acceptance phase is authoritative. These checks explain the evidence and controls required to advance it.
        </Text>
        {observationOnly ? (
          <Alert color="blue" title="Observation-only deployment" mt="sm">
            This deployment cannot grant Live authorization, activate the Live account, arm entries, or submit the canary. No hidden button or manual backend action is required here. Run the interactive broker-isolated portion through the repository&apos;s manual-acceptance harness.
          </Alert>
        ) : (
          <Alert color="blue" title={`Next operator action · ${projection?.phase ?? 'SETUP'}`} mt="sm">
            {prerequisiteState.nextAction}
          </Alert>
        )}
        <Title order={5} mt="md">Supporting prerequisite evidence</Title>
        <List spacing="xs" mt="xs">
          {prerequisiteState.milestones.map((milestone) => (
            <List.Item
              key={milestone.key}
              icon={<Badge size="xs" color={milestone.status === 'DONE' ? 'green' : milestone.status === 'NEXT' ? 'blue' : 'gray'}>
                {milestone.status === 'DONE' ? 'SATISFIED' : milestone.status === 'NEXT' ? 'CURRENT BLOCKER' : 'NOT YET'}
              </Badge>}
            >
              <Text size="sm">{milestone.label}</Text>
            </List.Item>
          ))}
        </List>
      </Card>
    )}

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
      {run.orderIntent && <Card withBorder data-testid="acceptance-post-execution-evidence">
        <Title order={4}>Post-execution evidence</Title>
        <Text size="sm">OrderIntent #{run.orderIntent.id}: {run.orderIntent.status}</Text>
        <Text size="sm">Client identity: {run.orderIntent.clientOrderId ?? 'unavailable'}</Text>
        <Text size="sm">Broker client identity: {brokerOrder?.clientOrderId ?? 'not observed'}</Text>
        <Text size="sm">Fill evidence: {fills.length > 0
          ? fills.map((fill) => `${fill.activityId}: qty ${evidenceText(fill.qty)} @ ${evidenceText(fill.price)} (${fill.transactionTime ? new Date(fill.transactionTime).toLocaleString() : 'time unavailable'})`).join('; ')
          : 'not observed'}</Text>
        <Text size="sm">Position attribution: subscription #{run.orderIntent.trackedPosition?.subscriptionId ?? 'not observed'}, assignment #{run.orderIntent.trackedPosition?.tradingAccountSubscriptionId ?? 'not observed'}</Text>
        <Text size="sm">Position / exit lifecycle: {run.orderIntent.trackedPosition?.exitState
          ? `${run.orderIntent.trackedPosition.exitState.status}; attention required: ${run.orderIntent.trackedPosition.exitState.attentionRequired ? 'yes' : 'no'}`
          : 'not observed'}</Text>
        <Text size="sm">BrokerOrder: {run.orderIntent.brokerOrders[0]?.brokerOrderId ?? 'not observed'} · {run.orderIntent.brokerOrders[0]?.status ?? 'not observed'}</Text>
        <Text size="sm">TrackedPosition: {run.orderIntent.trackedPosition ? `#${run.orderIntent.trackedPosition.id} · ${run.orderIntent.trackedPosition.status} · qty ${run.orderIntent.trackedPosition.qty}` : 'not observed'}</Text>
      </Card>}
      {run.terminalOutcome && <Card withBorder data-testid="acceptance-terminal-summary">
        <Title order={4}>{run.terminalOutcome.replaceAll('_', ' ')}</Title>
        <Text size="sm">{run.terminalReason}</Text>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Text size="sm">Terminal time: <b>{run.terminalAt ? new Date(run.terminalAt).toLocaleString() : 'not recorded'}</b></Text>
          <Text size="sm">Arming: <b>#{run.liveEntryArming?.id ?? 'not observed'}; {armingTermination?.type ?? 'termination not observed'}</b></Text>
          <Text size="sm">Arming termination: <b>{armingTermination ? `${armingTermination.reason} (${new Date(armingTermination.occurredAt).toLocaleString()})` : 'not observed'}</b></Text>
          <Text size="sm">Active arming absent: <b>{evidenceText(terminalEvidence.activeArmingAbsent)}</b></Text>
          <Text size="sm">Account trading disabled: <b>{run.tradingAccount.tradingEnabled ? 'no' : 'yes'}</b></Text>
          <Text size="sm">Kill switch enabled: <b>{run.tradingAccount.killSwitchEnabled ? 'yes' : 'no'}</b></Text>
          <Text size="sm">Assignment entries disabled: <b>{run.tradingAccountSubscription.entriesEnabled ? 'no' : 'yes'}</b></Text>
          <Text size="sm">Reconciliation run: <b>{evidenceText(terminalEvidence.reconciliationRunIdentifier)}</b></Text>
          <Text size="sm">Reconciliation discrepancies: <b>{evidenceText(terminalEvidence.relevantReconciliationFindings)}</b></Text>
          <Text size="sm">Lifecycle healthy: <b>{evidenceText(terminalEvidence.lifecycleHealthy)}</b></Text>
        </SimpleGrid>
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
