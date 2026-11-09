import { Alert, Badge, Card, Group, Stack, Text } from '@mantine/core';
import { useAuthorityStatus, useEntryExecutionAuthorizations } from './hooks';
import { stamp } from './presentation';
import type { OperationsCycle } from './types';
import type { LifecycleParse } from './lifecycle';
import { matchLifecycles } from './lifecycle';
import { parseDispatchStatus, parseEntryExecutionAuthorizations, parseExecutionRolloutStatus } from './authority';

export function AuthorityStatus({ token }: { token: string | null }) {
  const { execution, dispatch } = useAuthorityStatus(token);
  if (execution.isPending || dispatch.isPending) return <Text size="sm" c="dimmed">Loading authority status…</Text>;
  if (execution.isError || dispatch.isError) return <Alert color="red">Authority status is unavailable.</Alert>;
  const parsedExecution=parseExecutionRolloutStatus(execution.data),parsedDispatch=parseDispatchStatus(dispatch.data);
  if(parsedExecution.status==='invalid'||parsedDispatch.status==='invalid')return <Alert color="red">Authority status response is invalid. Execution and dispatch authority cannot be determined.</Alert>;
  const e=parsedExecution.value,d=parsedDispatch.value,active=e.generations.find(g=>g.id===e.activeExecutionGenerationId);
  const activeExecution=e.activeExecutionGenerationId===null?'none':active?`${active.generation} (#${active.id})`:`unavailable (missing generation #${e.activeExecutionGenerationId})`;
  const dispatchGeneration=d.state.activeRolloutGenerationId===null?'none':e.generations.some(g=>g.id===d.state.activeRolloutGenerationId)?String(d.state.activeRolloutGenerationId):`unavailable (missing generation #${d.state.activeRolloutGenerationId})`;
  return <Card withBorder data-testid="authority-status"><Stack gap="xs"><Group justify="space-between"><Text fw={600}>Read-only execution authority status</Text><Badge color="gray">Configuration, not broker permission</Badge></Group>
    <Text size="sm">Active execution generation: {activeExecution} · state version {e.rolloutStateVersion} · epoch {stamp(e.executionEpochAt)}</Text>
    <Text size="sm">Active dispatch generation: {dispatchGeneration} · state version {d.state.version} · epoch {stamp(d.state.activatedAt)}</Text>
    <Alert color="orange">An active dispatch generation does not permit a broker order. Finalization scheduling and broker POST remain unavailable before C3C.</Alert>
    <Text size="xs">Recent execution history: {e.activationEvents.slice(0,5).map(x=>`${x.action} generation #${x.rolloutGenerationId} (${stamp(x.createdAt)})`).join(' · ') || 'none'}</Text>
    <Text size="xs">Recent dispatch history: {d.activationEvents.slice(0,5).map(x=>`${x.action} generation #${x.rolloutGenerationId} / v${x.stateVersion} (${stamp(x.createdAt)})`).join(' · ') || 'none'}</Text>
  </Stack></Card>;
}

export function AssignmentAuthority({account,lifecycle,token}:{account:OperationsCycle['accountCycles'][number];lifecycle:LifecycleParse|null;token:string|null}){
  const query=useEntryExecutionAuthorizations(account.tradingAccountId,account.tradingAccountSubscriptionId,token);
  if(query.isPending)return <Text size="xs" c="dimmed">Loading frozen assignment authority…</Text>;
  if(query.isError)return <Alert color="red">Assignment authority history is unavailable.</Alert>;
  const parsed=parseEntryExecutionAuthorizations(query.data,account.tradingAccountId,account.tradingAccountSubscriptionId);
  if(parsed.status==='invalid')return <Alert color="red">Assignment authority history response is invalid. Historical authorization is unavailable.</Alert>;
  const rows=parsed.value.authorizations,latest=rows[0];
  const matches=lifecycle?.status==='ok'?(matchLifecycles([account.id],lifecycle.value).byId.get(account.id)??[]):[];
  const entry=matches.length===1?matches[0]:undefined,obligation=entry?.evidence.executionObligation!==null;
  const state=entry?.readiness.assignmentAuthorityState,effective=entry?.readiness.effectiveAssignmentAuthority;
  const label=state==='FROZEN_EFFECTIVE'&&effective===true&&obligation?'Frozen authority effective':state==='FROZEN_NOT_EFFECTIVE'&&effective===false&&obligation?'Frozen authority not effective':state==='NOT_YET_FROZEN'&&effective===false&&!obligation?'Not yet frozen':'Indeterminate — lifecycle evidence unavailable or inconsistent';
  const confident=!label.startsWith('Indeterminate');
  return <Card withBorder padding="xs" data-testid={`assignment-authority-${account.id}`}><Stack gap={3}><Group><Text size="sm" fw={600}>Assignment execution authority</Text><Badge color={label==='Frozen authority effective'?'teal':confident?'gray':'orange'}>{label}</Badge></Group>
    <Text size="xs">Account #{account.tradingAccountId} · assignment #{account.tradingAccountSubscriptionId} · subscription #{account.subscriptionId}</Text>
    {latest?<><Text size="xs">Latest authorization #{latest.id}: {latest.status} · generation #{latest.rolloutGenerationId} · sequence {latest.authorizationSequence}</Text><Text size="xs">Binding #{latest.strategySignalBindingId} revision #{latest.strategySignalRevisionId} · Security #{latest.securityId} · source #{latest.signalSourceId}</Text></>:<Text size="xs">No authorization records for this exact account assignment.</Text>}
    <Text size="xs" c="dimmed">Configured or frozen authority is diagnostic only here and never establishes broker-send capability.</Text>
  </Stack></Card>;
}
