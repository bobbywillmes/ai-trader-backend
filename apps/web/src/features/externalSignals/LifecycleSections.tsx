import { useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { stamp } from './presentation';
import { absence, matchLifecycles, parseExecutionLifecycle, stageColor, stageLabel, truncationNotice } from './lifecycle';
import type { AccountCycleLifecycle, ExecutionLifecycle, OperationsCycle, TruncationMetadata } from './types';

type AccountCycle = OperationsCycle['accountCycles'][number];
const show = (value: unknown, fallback = 'none') => value === null || value === undefined || value === '' ? fallback : String(value);
const yesNo = (value: boolean) => value ? 'yes' : 'no';
const wrap = { overflowWrap: 'anywhere' } as const;
const Line = ({ label, children }: { label: string; children: ReactNode }) => <Text size="xs" style={wrap}>{label}: {children}</Text>;

/** Boundary-specific replacement for the former blanket "SHADOW ONLY / authority NONE" statement. */
export function ExecutionBoundaryNotice({ compact = false }: { compact?: boolean }) {
  return <Alert color="cyan" title="Execution boundaries" data-testid="execution-boundary-notice"><Stack gap={2}>
    <Text size="sm">Historical SHADOW correlation and reservation evidence remains SHADOW; reservations are hypothetical, never admission.</Text>
    <Text size="sm">TradingView PAPER ENTRY execution authority may be configured. Configured authority is not proof that a broker send occurred.</Text>
    {!compact && <>
      <Text size="sm">Durable C2 claims and final-authorization evidence may exist.</Text>
      <Text size="sm">Runtime finalization scheduling remains unavailable before C3C. Broker POST execution is unavailable.</Text>
      <Text size="sm">TradingView SELL and LIVE execution remain unavailable. Accepted EXIT correlation is not a broker SELL.</Text>
    </>}
  </Stack></Alert>;
}

function Disclosure({ title, summary, children }: { title: string; summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Stack gap={4}>
    <Button variant="subtle" size="compact-sm" justify="flex-start" h="auto" style={{ whiteSpace: 'normal', ...wrap }} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '▾' : '▸'} {title}{summary ? ` · ${summary}` : ''}</Button>
    {open && <Stack gap={4} pl="sm" style={{ minWidth: 0 }}>{children}</Stack>}
  </Stack>;
}
const Truncation = ({ meta }: { meta: TruncationMetadata }) => <Text size="xs" c={meta.truncated ? 'orange' : 'dimmed'} role={meta.truncated ? 'status' : undefined}>{truncationNotice(meta)}</Text>;

function Ladder({ item, hasIntent }: { item: AccountCycleLifecycle; hasIntent: boolean }) {
  const { readiness, evidence, recovery } = item, stage = item.lifecycle.stage, pair = evidence.authorization;
  const brokerOrders = evidence.broker.ordersMetadata.total, brokerActivities = evidence.broker.activitiesMetadata.total;
  const frozen = readiness.assignmentAuthorityState;
  const authority = stage === 'NOT_AN_EXECUTION_CANDIDATE' ? 'Not applicable' : frozen === 'NOT_YET_FROZEN' ? 'Not yet frozen into an obligation' : frozen === 'FROZEN_NOT_EFFECTIVE' ? 'Frozen, but no longer effective' : frozen === 'FROZEN_EFFECTIVE' ? 'Frozen and currently effective' : readiness.effectiveAssignmentAuthority ? 'Effective (frozen state not reported)' : 'Not effective or not reported';
  const exposure = !evidence.exposure ? absence(stage) : evidence.exposure.held ? `Held (${evidence.exposure.status})${recovery.retainedExposureReviewRequired ? ' — review required' : ''}` : `Settled (${evidence.exposure.status}, released ${stamp(evidence.exposure.releasedAt)})`;
  const steps: Array<[string, string]> = [
    ['1. Execution authority configured', `${authority}. Configuration only; not a send.`],
    ['2. C2 worker claimed', evidence.workerClaim ? `Claim #${evidence.workerClaim.id} recorded ${stamp(evidence.workerClaim.claimedAt)} (historical evidence)` : hasIntent ? 'No worker claim recorded' : absence(stage)],
    ['3. Paired final authorization committed', authorizationText(pair)],
    ['4. Broker send permission established', evidence.brokerSendPermissionEstablished ? 'Established' : 'Not established'],
    ['5. Broker adapter invoked', 'Not reported by the pre-C3C projection'],
    ['6. Broker order/activity observed', brokerOrders + brokerActivities > 0 ? `${brokerOrders} direct-linked order(s), ${brokerActivities} activity record(s)` : 'None directly linked (absence is not proof of non-delivery)'],
    ['7. Exposure settled or reconciliation required', recovery.authoritativeReconciliationRequired ? `${exposure}; authoritative reconciliation required` : exposure],
  ];
  return <Stack gap={2} aria-label="Execution state ladder">{steps.map(([name, value]) => <Text key={name} size="xs" style={wrap}>{`${name} — ${value}`}</Text>)}</Stack>;
}

const authorizationText = (pair: AccountCycleLifecycle['evidence']['authorization']) => {
  const count = Number(pair.tradingViewConsumption !== null) + Number(pair.marketIntelligenceConsumption !== null);
  if (count === 0) return 'Authorization not committed.';
  if (count === 1) return 'Incomplete authorization pair — inconsistent evidence.';
  return pair.expired ? 'Historical authorization committed; deadline expired; broker send not established.' : 'Authorization committed — broker send not established.';
};

function Recovery({ item, account }: { item: AccountCycleLifecycle; account: AccountCycle }) {
  const { recovery, evidence } = item;
  return <>
    {recovery.retainedExposureReviewRequired && <Alert color="red" title="Retained exposure review required" data-testid="retained-exposure-warning"><Stack gap={2}>
      <Text size="sm">The lifecycle is not safely terminal: the account cycle or intent is terminal while exposure is still held.</Text>
      <Line label="Account">{account.tradingAccount.displayName} ({account.tradingAccount.environment}), account cycle #{account.id}</Line>
      <Line label="Intent">{evidence.orderIntent ? `#${evidence.orderIntent.id} (${evidence.orderIntent.status})` : 'none'}</Line>
      <Line label="Exposure claim">{evidence.exposure ? `#${evidence.exposure.id} · status ${evidence.exposure.status} · acquired ${stamp(evidence.exposure.acquiredAt)}` : 'none'}</Line>
      <Line label="Diagnostic reason">{show(recovery.retainedExposureReasonCode)}</Line>
      <Text size="xs" c="dimmed">This page is read-only and cannot release the exposure.</Text>
    </Stack></Alert>}
    {recovery.authoritativeReconciliationRequired && <Alert color="orange" title="Authoritative reconciliation required" data-testid="authoritative-reconciliation-warning"><Stack gap={2}>
      <Text size="sm">Unresolved authoritative-only attention: {recovery.unresolvedAuthoritativeOnlyCount} (active attention records: {recovery.activeAttentionCount}).</Text>
      {recovery.activeOperationalAttention.filter(attention => attention.resolutionPolicy === 'AUTHORITATIVE_ONLY').map(attention => <Line key={String(attention.id)} label={`Attention #${attention.id}`}>{show(attention.code)} · {show(attention.severity)} · {attention.status} · resolution policy {show(attention.resolutionPolicy)}</Line>)}
      <Truncation meta={recovery.activeOperationalAttentionMetadata} />
      <Text size="xs" c="dimmed">Only authoritative broker evidence can resolve this. Nothing on this page releases or reconciles exposure.</Text>
    </Stack></Alert>}
  </>;
}

function AccountLifecycle({ item, account }: { item: AccountCycleLifecycle; account: AccountCycle }) {
  const { readiness: r, evidence: e, recovery } = item, stage = item.lifecycle.stage, pair = e.authorization, hasIntent = e.orderIntent !== null;
  return <Stack gap="xs" mt="xs" data-testid={`lifecycle-${account.id}`}>
    <Group gap="xs" align="flex-start" wrap="wrap">
      <Badge color={stageColor(stage)}>{stageLabel(stage)}</Badge>
      <Text size="xs" c="dimmed" style={wrap}>Reason: {item.lifecycle.reasonCode}</Text>
      <Badge variant="light" color="gray">Scope {r.scope === 'NOT_APPLICABLE_NO_INTENT' ? 'not applicable (no intent)' : r.scope}</Badge>
    </Group>
    <Group gap="xs">
      {e.workerClaim && <Badge variant="light" color="indigo">Worker claim #{e.workerClaim.id} (historical)</Badge>}
      {!r.c2WorkerClaimPresent && <Badge variant="light" color="gray">No worker claim</Badge>}
      {e.exposure && <Badge variant="light" color={e.exposure.held ? 'orange' : 'teal'}>Exposure {e.exposure.held ? 'held' : 'settled'}</Badge>}
    </Group>
    <Recovery item={item} account={account} />
    <Ladder item={item} hasIntent={hasIntent} />
    <Disclosure title="Identity" summary={e.orderIntent ? `Intent #${e.orderIntent.id}` : 'No marked intent'}>
      <Line label="Account">{account.tradingAccount.displayName} ({account.tradingAccount.environment})</Line>
      <Line label="Account cycle">#{item.accountCycleId}</Line>
      <Line label="TradingView signal">{show(r.receipt.signalId)}</Line>
      <Line label="Frozen assignment / subscription / route">#{account.tradingAccountSubscriptionId} / #{account.subscriptionId} / #{account.entrySignalRouteId}</Line>
      <Line label="Marked OrderIntent">{e.orderIntent ? `#${e.orderIntent.id} · ${e.orderIntent.status} · client order ${show(e.orderIntent.clientOrderId)} · created ${stamp(e.orderIntent.createdAt)}${e.orderIntent.blockReason ? ` · block reason ${e.orderIntent.blockReason}` : ''}` : absence(stage)}</Line>
    </Disclosure>
    <Disclosure title="Readiness" summary={`Authority ${r.assignmentAuthorityState ?? 'not reported'}`}>
      <Line label="Execution generation">{r.frozenGeneration.id === null ? absence(stage) : `#${r.frozenGeneration.id} (generation ${show(r.frozenGeneration.generation)}, ${r.frozenGeneration.enabled ? 'enabled' : 'disabled'}, ${show(r.frozenGeneration.authorityMode)}, effective ${stamp(r.frozenGeneration.effectiveAt)})`}</Line>
      <Line label="Rollout relationship">active execution #{show(r.rolloutRelationship.activeExecutionGenerationId)} (matches: {yesNo(r.rolloutRelationship.matchesExecution)}) · active dispatch #{show(r.rolloutRelationship.activeDispatchGenerationId)} (matches: {yesNo(r.rolloutRelationship.matchesDispatch)})</Line>
      <Line label="Execution state">version {show(r.executionState.version)} · activated {stamp(r.executionState.activatedAt)}</Line>
      <Line label="Dispatch state">version {show(r.dispatchState.version)} · activated {stamp(r.dispatchState.activatedAt)}</Line>
      <Line label="Frozen assignment authority">{r.assignmentAuthorityState ?? 'not reported'} · effective: {yesNo(r.effectiveAssignmentAuthority)} (diagnostic only)</Line>
      <Line label="Account operational">{yesNo(r.accountOperational)} · assignment operational: {yesNo(r.assignmentOperational)}</Line>
      <Line label="Signal receipt">{stamp(r.receipt.receivedAt)} · freshness {r.receipt.freshness}</Line>
      <Line label="Authorization deadline">{r.authorizationDeadlineStatus}{pair.tradingViewConsumption ? ` · deadline ${stamp(pair.tradingViewConsumption.deadlineAt)}` : ''}</Line>
      <Text size="xs" c="dimmed">Readiness may change after observation.</Text>
    </Disclosure>
    <Disclosure title="Authorization" summary={pair.pairPresent ? 'pair committed' : 'no complete pair'}>
      <Line label="TradingView consumption">{pair.tradingViewConsumption ? `#${pair.tradingViewConsumption.id} · authorized ${stamp(pair.tradingViewConsumption.authorizedAt)} · deadline ${stamp(pair.tradingViewConsumption.deadlineAt)}` : absence(stage)}</Line>
      <Line label="Market Intelligence consumption">{pair.marketIntelligenceConsumption ? `#${pair.marketIntelligenceConsumption.id} · consumed ${stamp(pair.marketIntelligenceConsumption.consumedAt)}` : absence(stage)}</Line>
      <Line label="Complete pair">{yesNo(pair.pairPresent)}{pair.expired ? ' · deadline expired' : ''}</Line>
      <Line label="Execution obligation">{e.executionObligation ? `#${e.executionObligation.id} · frozen ${stamp(e.executionObligation.createdAt)}` : absence(stage)}</Line>
      <Line label="Market Intelligence obligation">{e.marketIntelligenceObligation ? `#${e.marketIntelligenceObligation.id} · valid until ${stamp(e.marketIntelligenceObligation.validUntil)}` : absence(stage)}</Line>
      <Text size="xs" c="dimmed" style={wrap}>{authorizationText(pair)}</Text>
    </Disclosure>
    <Disclosure title="Exposure claim" summary={e.exposure ? `#${e.exposure.id} ${e.exposure.status}` : absence(stage)}>
      {e.exposure
        ? <><Line label="Claim">#{e.exposure.id} · {e.exposure.status} · {e.exposure.held ? 'held' : 'released'}</Line><Line label="Acquired">{stamp(e.exposure.acquiredAt)} · released {stamp(e.exposure.releasedAt)} · reason {show(e.exposure.releaseReason)}</Line></>
        : <Text size="xs">{absence(stage)}</Text>}
      <Text size="xs" fw={600}>Claim events</Text><Truncation meta={e.exposureEventsMetadata} />
      {e.exposureEvents.map(event => <Line key={String(event.id)} label={`Event #${event.id}`}>{event.eventType} · {stamp(event.createdAt)}</Line>)}
    </Disclosure>
    <Disclosure title="Broker evidence" summary={`${e.broker.ordersMetadata.total} orders · ${e.broker.activitiesMetadata.total} activities`}>
      <Text size="xs">Only directly linked BrokerOrders and BrokerActivities are reported ({e.broker.attributionProvenance}). Absence is not authoritative non-delivery proof, and linked records are not proof of who submitted them.</Text>
      <Text size="xs" fw={600}>Broker orders</Text><Truncation meta={e.broker.ordersMetadata} />
      {e.broker.orders.map(order => <Line key={String(order.id)} label={`Order #${order.id}`}>{show(order.brokerOrderId)} · {show(order.side)} {show(order.status)} · created {stamp(order.createdAt)} · updated {stamp(order.updatedAt)}</Line>)}
      <Text size="xs" fw={600}>Broker activities</Text><Truncation meta={e.broker.activitiesMetadata} />
      {e.broker.activities.map(activity => <Line key={String(activity.id)} label={`Activity #${activity.id}`}>{show(activity.activityId)} · {show(activity.activityType)} · order {show(activity.orderId)} · {stamp(activity.transactionTime ?? activity.createdAt)}</Line>)}
    </Disclosure>
    <Disclosure title="Recovery and attention" summary={`${recovery.activeAttentionCount} active`}>
      <Line label="Retained exposure review">{recovery.retainedExposureReviewRequired ? `required (${show(recovery.retainedExposureReasonCode)})` : 'not required'}</Line>
      <Line label="Authoritative reconciliation">{recovery.authoritativeReconciliationRequired ? `required (${recovery.unresolvedAuthoritativeOnlyCount} unresolved authoritative-only)` : 'not required'}</Line>
      <Text size="xs" fw={600}>Operational attention (active first)</Text><Truncation meta={recovery.operationalAttentionMetadata} />
      {recovery.operationalAttention.map(attention => <Line key={String(attention.id)} label={`Attention #${attention.id}`}>{show(attention.code)} · {attention.status} · {show(attention.severity)} · policy {show(attention.resolutionPolicy)} · last observed {stamp(attention.lastObservedAt)}</Line>)}
    </Disclosure>
  </Stack>;
}

/** Lifecycle for one account cycle, resolved strictly by accountCycleId. */
export function AccountCycleLifecycleView({ account, lifecycle }: { account: AccountCycle; lifecycle: ExecutionLifecycle | null }) {
  if (!lifecycle) return <Text size="xs" c="dimmed" mt="xs">Execution lifecycle projection unavailable for this account cycle.</Text>;
  const matches = matchLifecycles([account.id], lifecycle).byId.get(account.id) ?? [];
  if (matches.length === 0) return <Text size="xs" c="dimmed" mt="xs">No execution lifecycle evidence was returned for account cycle #{account.id}.</Text>;
  if (matches.length > 1) return <Alert color="red" mt="xs">Contradictory lifecycle projections ({matches.length}) were returned for account cycle #{account.id}; none is displayed.</Alert>;
  return <AccountLifecycle item={matches[0]!} account={account} />;
}

const sourceMessages: Record<string, string> = {
  NO_ENTRY_SIGNAL: 'No TradingView ENTRY signal exists in this source cycle (EXIT-only). Accepted EXIT correlation is not a broker SELL, and there is no ENTRY execution lifecycle.',
  NO_ELIGIBLE_ACCOUNT_ROUTE: 'Correlation completed with no eligible PAPER account route; nothing was admitted for execution.',
};
export function ExecutionLifecycleSummary({ cycle, lifecycle }: { cycle: OperationsCycle; lifecycle: ReturnType<typeof parseExecutionLifecycle> }) {
  if (lifecycle.status === 'absent') return <Alert color="gray" title="Execution lifecycle">The execution lifecycle projection was not returned for this cycle.</Alert>;
  if (lifecycle.status === 'invalid') return <Alert color="red" title="Execution lifecycle unrecognized">The lifecycle response did not match the expected shape ({lifecycle.reason}). Evidence is hidden rather than guessed.</Alert>;
  const { value } = lifecycle, source = value.sourceLifecycle, { byId, unmatched } = matchLifecycles(cycle.accountCycles.map(account => account.id), value);
  const matched = cycle.accountCycles.flatMap(account => {
    const entries = byId.get(account.id) ?? [];
    return entries.length === 1 ? entries : [];
  });
  const retainedExposureCount = matched.filter(item => item.recovery.retainedExposureReviewRequired).length;
  const reconciliationCount = matched.filter(item => item.recovery.authoritativeReconciliationRequired).length;
  return <Card withBorder data-testid="execution-lifecycle-summary"><Stack gap={4}>
    <Group gap="xs" wrap="wrap"><Text fw={600}>Execution lifecycle</Text>{source && <Badge color="gray" variant="light">{source.stage === 'ACCOUNT_LIFECYCLES_PROJECTED' ? `${matched.length} matched account lifecycle(s)` : stageLabel(source.stage)}</Badge>}</Group>
    {(retainedExposureCount > 0 || reconciliationCount > 0) && <Alert color="orange" title="Lifecycle review summary" data-testid="lifecycle-warning-summary">
      <Text size="sm" style={wrap}>Retained-exposure review required: {retainedExposureCount}. Authoritative reconciliation required: {reconciliationCount}.</Text>
    </Alert>}
    {source && sourceMessages[source.reasonCode] && <Text size="sm">{sourceMessages[source.reasonCode]}</Text>}
    {source?.stage === 'CORRELATION_IN_PROGRESS' && <Text size="sm">Correlation has not completed ({source.reasonCode}); account lifecycles may not exist yet.</Text>}
    <Text size="xs" c="dimmed">Observed {stamp(value.observedAt)}. {value.readinessMayChangeAfterObservation ? 'Readiness may change after observation. ' : ''}Finalization scheduling: {value.capabilities.finalizationScheduling} · Broker POST: {value.capabilities.brokerPost} · SELL: {value.capabilities.tradingViewSellExecution} · LIVE: {value.capabilities.tradingViewLiveExecution}.</Text>
    <Text size="xs" c="dimmed">Pre-C3C, only directly linked broker evidence is reported; absence of broker records is not authoritative proof of non-delivery.</Text>
    {cycle.accountCycles.some(account => !byId.has(account.id)) && <Text size="xs" c="orange">Some account cycles have no matching lifecycle entry.</Text>}
    {unmatched.length > 0 && <Alert color="orange">{unmatched.length} lifecycle entr{unmatched.length === 1 ? 'y' : 'ies'} did not match any account cycle of this source cycle and {unmatched.length === 1 ? 'is' : 'are'} not displayed.</Alert>}
  </Stack></Card>;
}
