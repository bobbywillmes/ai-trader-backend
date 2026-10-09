import { Stack, Text, Group } from '@mantine/core';
import { EvidenceBadge, JsonEvidence } from './components';
import { stamp } from './presentation';
import type { AuthorityMode, SignalRoute } from './types';

export function EvaluationDetails({ route, authority }: { route: SignalRoute; authority: AuthorityMode }) {
  const evaluation = route.evaluation;
  if (!evaluation) return <Text size="sm" c="dimmed">{route.evaluationVersion == null ? 'Not evaluated — predates SignalEvaluation' : 'No evaluation evidence recorded'}</Text>;
  const shadow = route.marketEligibilityAttempts?.at(-1) ?? null;
  const decision = shadow?.eligibilityDecision ?? null;
  const freshness = decision?.currentFreshness ?? 'UNAVAILABLE';
  return <Stack gap="xs">
    <Text fw={600}>SignalEvaluation #{evaluation.id}</Text>
    <Text size="sm">{evaluation.event} · {evaluation.intent} / {evaluation.riskDirection}</Text>
    <Text size="sm">Authority: {authority}</Text>
    <Group gap="xs"><EvidenceBadge value={evaluation.status} />{evaluation.outcome && <EvidenceBadge value={evaluation.outcome} />}</Group>
    {evaluation.reasonCode && <Text size="sm">Reason: {evaluation.reasonCode}</Text>}
    {evaluation.prospectiveExitManagementMode && <Text size="sm">Prospective exit ownership: {evaluation.prospectiveExitManagementMode}</Text>}
    {evaluation.positionExitManagementMode && <Text size="sm">Position exit ownership snapshot: {evaluation.positionExitManagementMode}</Text>}
    {evaluation.trackedPositionId && <Text size="sm">TrackedPosition #{evaluation.trackedPositionId} · PositionExitState #{evaluation.positionExitStateId ?? 'unavailable'}</Text>}
    <Text size="xs" c="dimmed">Version {evaluation.evaluationVersion} · Started {stamp(evaluation.startedAt)} · Completed {stamp(evaluation.completedAt)} · Created {stamp(evaluation.createdAt)}</Text>
    <Text size="sm" fw={600}>Ordered gate trail</Text>
    {evaluation.gates.map(gate => <Stack key={gate.id} gap={4}>
      <Group gap="xs"><Text size="sm">{gate.sequence}. {gate.gateKey}</Text><EvidenceBadge value={gate.result} /></Group>
      {gate.reasonCode && <Text size="xs">{gate.reasonCode}</Text>}
      <Text size="xs" c="dimmed">{stamp(gate.evaluatedAt)}</Text>
      {gate.evidenceJson != null && <JsonEvidence title={`${gate.gateKey} evidence`} value={gate.evidenceJson} />}
    </Stack>)}
    <Text size="sm" c="dimmed">Evaluation is applicability evidence, not order approval. Authority is separate from outcome. No execution handoff exists in this phase.</Text>
    <Text fw={600} mt="sm">Market-policy shadow</Text>
    <Text size="sm" c="dimmed">SHADOW ONLY / NO TRADING EFFECT. This evidence cannot change the SignalEvaluation outcome above.</Text>
    {!shadow ? <Text size="sm" c="dimmed">No route-specific shadow attempt recorded.</Text> : <>
      <Group gap="xs"><EvidenceBadge value={shadow.status} />{decision && <EvidenceBadge value={decision.outcome} />}</Group>
      <Text size="sm">Processing reason: {shadow.reasonCode} · Current freshness: {freshness}</Text>
      <Text size="xs" c="dimmed">Integration {shadow.integrationVersion} · attempt {shadow.attempt} · {stamp(shadow.completedAt)}</Text>
      {decision && <>
        <Text size="sm">Recorded outcome: <b>{decision.outcome}</b> ({decision.reasonCode})</Text>
        <Text size="sm">Policy revision {decision.policyRevision?.revision ?? 'none'} · Market Regime composition #{decision.marketRegimeAssessmentId ?? 'unresolved'}</Text>
        <Text size="xs" c="dimmed">Evaluated {stamp(decision.evaluatedAt)} · valid until {stamp(decision.validUntil)}</Text>
        {decision.gates.map(gate => <Stack key={gate.id} gap={2}>
          <Group gap="xs"><Text size="sm">{gate.ordinal}. {gate.dimension} · {gate.requirement}</Text><EvidenceBadge value={gate.outcome} /></Group>
          <Text size="xs">Observed {gate.observedState ?? 'unavailable'} · allowed {gate.allowedStatesJson.length ? gate.allowedStatesJson.join(', ') : 'none'} · {gate.reasonCode}</Text>
          <Text size="xs" c="dimmed">{gate.algorithmVersion} · source assessment #{gate.sourceAssessmentId ?? 'none'} · health {gate.sourceHealth ?? 'unavailable'}</Text>
        </Stack>)}
      </>}
      {shadow.status === 'FAILED' && <JsonEvidence title="Shadow processing diagnostics" value={shadow.evidenceJson} />}
    </>}
  </Stack>;
}
