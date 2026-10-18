import { Alert, Badge, Button, Checkbox, Group, Modal, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useIsSystemOwner } from '../../../../auth/useAuth';
import { ApiError } from '../../../../../lib/api';
import { getMarketPolicyEnforcementAuthorizationHistory, grantMarketPolicyEnforcementAuthorization, previewMarketPolicyEnforcementAuthorization, revokeMarketPolicyEnforcementAuthorization } from '../../../api';
import type { MarketPolicyEnforcementAuthorizationState } from '../../../types';
import { formatDateTime } from '../../utils/formatters';

const STATE_COLORS: Record<MarketPolicyEnforcementAuthorizationState, string> = { NOT_AUTHORIZED: 'gray', AUTHORIZED: 'teal', REVOKED: 'orange', INVALIDATED: 'red' };
const STATE_LABELS: Record<MarketPolicyEnforcementAuthorizationState, string> = { NOT_AUTHORIZED: 'NOT AUTHORIZED', AUTHORIZED: 'AUTHORIZED', REVOKED: 'REVOKED', INVALIDATED: 'INVALIDATED' };

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const code = typeof error.data === 'object' && error.data !== null && 'details' in error.data
      ? (error.data as { details?: { code?: string } | null }).details?.code : undefined;
    return code ? `${error.message} (${code})` : error.message;
  }
  return error instanceof Error ? error.message : 'Enforcement authorization action failed.';
}

export function MarketPolicyEnforcementAuthorizationSection({ accountId, assignmentId, token, enrollmentQueryKey }: { accountId: number; assignmentId: number; token: string | null; enrollmentQueryKey: readonly unknown[] }) {
  const owner = useIsSystemOwner();
  const queryClient = useQueryClient();
  const key = [...enrollmentQueryKey, 'enforcementAuthorization'] as const;
  const preview = useQuery({ queryKey: [...key, 'preview'], queryFn: () => previewMarketPolicyEnforcementAuthorization(accountId, assignmentId, token as string), enabled: Boolean(token) });
  const history = useQuery({ queryKey: [...key, 'history'], queryFn: () => getMarketPolicyEnforcementAuthorizationHistory(accountId, assignmentId, token as string), enabled: Boolean(token) && owner });
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [grantReason, setGrantReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: enrollmentQueryKey }); };
  const p = preview.data?.preview;
  const current = p?.currentAuthorization;
  const generation = p?.identity.enrollmentGeneration;
  const revision = p?.identity.boundPolicyRevision;
  const grant = useMutation({
    mutationFn: () => grantMarketPolicyEnforcementAuthorization(accountId, assignmentId, { generationId: generation!.id, expectedConfigurationFingerprint: p!.identity.configurationFingerprint!, expectedPolicyRevisionId: revision!.id, reason: grantReason.trim() }, token as string),
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationFn: () => revokeMarketPolicyEnforcementAuthorization(accountId, assignmentId, { authorizationId: current!.authorization!.id, reason: revokeReason.trim() }, token as string),
    onSettled: refresh,
  });
  const run = async (action: () => Promise<unknown>, success: string, close: () => void) => {
    try { await action(); notifications.show({ color: 'teal', message: success }); close(); }
    // Stale or conflicting state is refetched by onSettled; the dialog stays open with the current preview.
    catch (error) { notifications.show({ color: 'red', message: errorMessage(error) }); }
  };

  if (preview.isLoading) return null;
  if (preview.isError || !p || !current) return <Alert color="red">Enforcement authorization could not be loaded.</Alert>;
  const canGrant = owner && p.viewerCanAuthorize && p.eligibleToAuthorize && Boolean(p.identity.configurationFingerprint) && Boolean(generation) && Boolean(revision);
  const canRevoke = owner && current.state === 'AUTHORIZED' && Boolean(current.authorization);
  const identityRows: Array<[string, string]> = [
    ['Account', `${p.identity.tradingAccount.displayName} (#${p.identity.tradingAccount.id}, ${p.identity.tradingAccount.environment})`],
    ['Strategy', `${p.identity.strategy.name} (${p.identity.strategy.key})`],
    ['Assignment', `#${p.identity.assignment.id} · ${p.identity.subscription.name}${p.identity.security ? ` · ${p.identity.security.symbol}` : ''}`],
    ['Enrollment generation', generation ? `${generation.generation} (#${generation.id}) · ${generation.status}` : 'None'],
    ['Bound policy revision', revision ? `${revision.revision} (#${revision.id}) · ${revision.status}` : 'None'],
    ['Strategy ACTIVE revision', p.identity.activePolicyRevision ? `${p.identity.activePolicyRevision.revision} (#${p.identity.activePolicyRevision.id})` : 'None'],
  ];

  return <Stack gap="xs">
    <Group justify="space-between">
      <Title order={6}>Enforcement authorization</Title>
      <Group gap="xs">
        <Badge color={STATE_COLORS[current.state]}>{STATE_LABELS[current.state]}</Badge>
        {current.state === 'AUTHORIZED' && !current.effective && <Badge color="red">NOT EFFECTIVE</Badge>}
        <Badge color="gray" variant="outline">PAPER ONLY</Badge>
        <Badge color="gray">RUNTIME ENFORCEMENT NOT ACTIVE</Badge>
      </Group>
    </Group>
    <Text size="sm" c="dimmed">Authorization records explicit owner permission for this exact PAPER assignment and enrollment generation. Market-policy enforcement is not running: orders are not evaluated, blocked, or allowed by this authorization.</Text>
    {current.ineffectiveReasons.length > 0 && <Alert color="red" title="Authorization not effective">{current.ineffectiveReasons.join(' · ')}</Alert>}
    {current.authorization && <Text size="xs">Authorization #{current.authorization.id} · sequence {current.authorization.authorizationSequence} · authorized {formatDateTime(current.authorization.authorizedAt)}{current.authorization.revokedAt ? ` · revoked ${formatDateTime(current.authorization.revokedAt)}` : ''}{current.authorization.invalidatedAt ? ` · invalidated ${formatDateTime(current.authorization.invalidatedAt)} (${current.authorization.invalidationReasonCode})` : ''}</Text>}
    <Table withTableBorder fz="xs"><Table.Tbody>{identityRows.map(([label, value]) => <Table.Tr key={label}><Table.Th w={190}>{label}</Table.Th><Table.Td>{value}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    <Group gap="xs">
      <Badge color={p.configurationValidity.valid ? 'teal' : 'red'}>{p.configurationValidity.valid ? 'Configuration valid' : 'Configuration invalid'}</Badge>
      <Badge color={p.eligibleToAuthorize ? 'teal' : 'gray'}>{p.eligibleToAuthorize ? 'Eligible to authorize' : 'Not eligible to authorize'}</Badge>
      <Badge color="gray" variant="light">Market observation: {p.currentMarketEligibility.outcome ?? p.currentMarketEligibility.evaluatorTechnicalStatus} (informational)</Badge>
    </Group>
    {p.blockingReasons.length > 0 && <Alert color="yellow" title="Authorization blocked"><Stack gap={2}>{p.blockingReasons.map(reason => <Text key={reason.code} size="xs">{reason.code}: {reason.message}</Text>)}</Stack></Alert>}
    <Text size="xs" c="dimmed">Operational posture (does not affect authorization validity): strategy {p.operationalPosture.strategyEnabled ? 'enabled' : 'disabled'} · assignment {p.operationalPosture.assignmentEnabled ? 'enabled' : 'disabled'} · entries {p.operationalPosture.entriesEnabled ? 'enabled' : 'disabled'} · account {p.operationalPosture.accountStatus} · kill switch {p.operationalPosture.killSwitchEnabled ? 'on' : 'off'}</Text>
    {owner && <Group>
      <Button size="xs" disabled={!canGrant} onClick={() => { setGrantReason(''); setAcknowledged(false); setGrantOpen(true); }}>Authorize enforcement…</Button>
      <Button size="xs" color="red" variant="light" disabled={!canRevoke} onClick={() => { setRevokeReason(''); setRevokeOpen(true); }}>Revoke authorization…</Button>
    </Group>}
    {owner && history.data && history.data.authorizations.length > 0 && <Stack gap={2}>
      <Text fw={700} size="sm">Immutable authorization history</Text>
      {history.data.authorizations.flatMap(item => item.events.map(event => <Text key={event.id} size="xs">{formatDateTime(event.occurredAt)} · authorization #{item.id} (generation {item.generation}, revision {item.policyRevision}) · {event.action} · {event.actor?.email ?? 'system'} · {event.reason}</Text>))}
    </Stack>}

    <Modal opened={grantOpen} onClose={() => setGrantOpen(false)} title="Authorize PAPER market-policy enforcement" size="lg">
      <Stack gap="sm">
        <Text size="sm">This grants enforcement authority to exactly one ACTIVE PAPER enrollment generation. It does not start runtime enforcement and does not change any current order behavior.</Text>
        <Table withTableBorder fz="xs"><Table.Tbody>{identityRows.map(([label, value]) => <Table.Tr key={label}><Table.Th w={190}>{label}</Table.Th><Table.Td>{value}</Table.Td></Table.Tr>)}<Table.Tr><Table.Th>Configuration fingerprint</Table.Th><Table.Td style={{ wordBreak: 'break-all' }}>{p.identity.configurationFingerprint}</Table.Td></Table.Tr></Table.Tbody></Table>
        {!p.eligibleToAuthorize && <Alert color="yellow">The configuration changed and is no longer eligible. Close this dialog and review the blocking reasons.</Alert>}
        <TextInput label="Authorization reason" value={grantReason} onChange={event => setGrantReason(event.currentTarget.value)} maxLength={500} />
        <Checkbox label="I confirm this exact account, Strategy, assignment, generation, and policy revision" checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setGrantOpen(false)}>Cancel</Button>
          <Button disabled={!grantReason.trim() || !acknowledged || !canGrant} loading={grant.isPending} onClick={() => run(() => grant.mutateAsync(), 'Enforcement authorization granted. Runtime enforcement remains inactive.', () => setGrantOpen(false))}>Grant authorization</Button>
        </Group>
      </Stack>
    </Modal>

    <Modal opened={revokeOpen} onClose={() => setRevokeOpen(false)} title="Revoke enforcement authorization">
      <Stack gap="sm">
        <Text size="sm">Revocation immediately removes enforcement eligibility for authorization #{current.authorization?.id}. History is retained; reauthorization requires a new explicit grant.</Text>
        <TextInput label="Revocation reason" value={revokeReason} onChange={event => setRevokeReason(event.currentTarget.value)} maxLength={500} />
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setRevokeOpen(false)}>Cancel</Button>
          <Button color="red" disabled={!revokeReason.trim() || !canRevoke} loading={revoke.isPending} onClick={() => run(() => revoke.mutateAsync(), 'Enforcement authorization revoked.', () => setRevokeOpen(false))}>Revoke authorization</Button>
        </Group>
      </Stack>
    </Modal>
  </Stack>;
}
