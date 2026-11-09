import { Alert, Badge, Card, Group, Stack, Text } from '@mantine/core';
import { useAuthorityStatus, useEntryExecutionAuthorizations } from './hooks';
import { stamp } from './presentation';
import type { AccountCycleLifecycle, OperationsCycle } from './types';

export function AuthorityStatus({ token }: { token: string | null }) {
  const { execution, dispatch } = useAuthorityStatus(token);
  if (execution.isPending || dispatch.isPending) return <Text size="sm" c="dimmed">Loading authority status…</Text>;
  if (execution.isError || dispatch.isError) return <Alert color="red">Authority status is unavailable.</Alert>;
  const e=execution.data!,d=dispatch.data!,active=e.generations.find(g=>g.id===e.activeExecutionGenerationId);
  return <Card withBorder data-testid="authority-status"><Stack gap="xs"><Group justify="space-between"><Text fw={600}>Read-only execution authority status</Text><Badge color="gray">Configuration, not broker permission</Badge></Group>
    <Text size="sm">Active execution generation: {active ? `${active.generation} (#${active.id})` : 'none'} · state version {e.rolloutStateVersion} · epoch {stamp(e.executionEpochAt)}</Text>
    <Text size="sm">Active dispatch generation: {d.state.activeRolloutGenerationId ?? 'none'} · state version {d.state.version} · epoch {stamp(d.state.activatedAt)}</Text>
    <Alert color="orange">An active dispatch generation does not permit a broker order. Finalization scheduling and broker POST remain unavailable before C3C.</Alert>
    <Text size="xs">Recent execution history: {e.activationEvents.slice(0,5).map(x=>`${x.action} generation #${x.rolloutGenerationId} (${stamp(x.createdAt)})`).join(' · ') || 'none'}</Text>
    <Text size="xs">Recent dispatch history: {d.activationEvents.slice(0,5).map(x=>`${x.action} generation #${x.rolloutGenerationId} / v${x.stateVersion} (${stamp(x.createdAt)})`).join(' · ') || 'none'}</Text>
  </Stack></Card>;
}

export function AssignmentAuthority({account,lifecycle,token}:{account:OperationsCycle['accountCycles'][number];lifecycle?:AccountCycleLifecycle;token:string|null}){
  const query=useEntryExecutionAuthorizations(account.tradingAccountId,account.tradingAccountSubscriptionId,token);
  if(query.isPending)return <Text size="xs" c="dimmed">Loading frozen assignment authority…</Text>;
  if(query.isError)return <Alert color="red">Assignment authority history is unavailable.</Alert>;
  const rows=query.data?.authorizations??[],latest=rows[0],effective=lifecycle?.readiness.effectiveAssignmentAuthority===true;
  return <Card withBorder padding="xs" data-testid={`assignment-authority-${account.id}`}><Stack gap={3}><Group><Text size="sm" fw={600}>Assignment execution authority</Text><Badge color={effective?'teal':'gray'}>{effective?'Frozen authority effective':'Not effective'}</Badge></Group>
    <Text size="xs">Account #{account.tradingAccountId} · assignment #{account.tradingAccountSubscriptionId} · subscription #{account.subscriptionId}</Text>
    {latest?<><Text size="xs">Latest authorization #{latest.id}: {latest.status} · generation #{latest.rolloutGenerationId} · sequence {latest.authorizationSequence}</Text><Text size="xs">Binding #{latest.strategySignalBindingId} revision #{latest.strategySignalRevisionId} · Security #{latest.securityId} · source #{latest.signalSourceId}</Text></>:<Text size="xs">No authorization records for this exact account assignment.</Text>}
    <Text size="xs" c="dimmed">Configured or frozen authority is diagnostic only here and never establishes broker-send capability.</Text>
  </Stack></Card>;
}
