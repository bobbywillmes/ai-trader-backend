import { Alert, Badge, Button, Group, Loader, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useIsSystemOwner } from '../../../../auth/useAuth';
import { activateAssignmentMarketPolicyEnrollment, disableAssignmentMarketPolicyEnrollment, getAssignmentMarketPolicyEnrollment, prepareAssignmentMarketPolicyEnrollment, previewAssignmentMarketPolicyEnrollment } from '../../../api';
import { formatDateTime } from '../../utils/formatters';

export function MarketPolicyEnrollmentPanel({ accountId, assignmentId, token }: { accountId: number; assignmentId: number; token: string | null }) {
  const owner = useIsSystemOwner(); const queryClient = useQueryClient(); const [reason, setReason] = useState('Owner disabled configuration');
  const key = ['tradingAccounts', 'detail', accountId, 'accountSubscriptions', assignmentId, 'marketPolicyEnrollment'] as const;
  const state = useQuery({ queryKey: key, queryFn: () => getAssignmentMarketPolicyEnrollment(accountId, assignmentId, token as string), enabled: Boolean(token) });
  const preview = useQuery({ queryKey: [...key, 'preview'], queryFn: () => previewAssignmentMarketPolicyEnrollment(accountId, assignmentId, token as string), enabled: Boolean(token) });
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: key }); };
  const prepare = useMutation({ mutationFn: () => prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, token as string), onSuccess: refresh });
  const current = state.data?.enrollment?.generations.find(item => item.status !== 'DISABLED') ?? null;
  const activate = useMutation({ mutationFn: () => activateAssignmentMarketPolicyEnrollment(accountId, assignmentId, current!.id, current!.configurationFingerprint, token as string), onSuccess: refresh });
  const disable = useMutation({ mutationFn: () => disableAssignmentMarketPolicyEnrollment(accountId, assignmentId, current!.id, reason, token as string), onSuccess: refresh });
  const run = async (action: () => Promise<unknown>, success: string) => { try { await action(); notifications.show({ color: 'teal', message: success }); } catch (error) { notifications.show({ color: 'red', message: error instanceof Error ? error.message : 'Enrollment action failed.' }); } };
  if (state.isLoading || preview.isLoading) return <Loader size="sm" />;
  if (state.isError || preview.isError) return <Alert color="red">Market-policy enrollment could not be loaded.</Alert>;
  const p = preview.data?.preview; const generations = state.data?.enrollment?.generations ?? [];
  return <Stack gap="sm">
    <Group justify="space-between"><Title order={5}>Market-policy enrollment</Title><Group gap="xs"><Badge color="orange">CONFIGURATION ONLY</Badge><Badge color="gray">NOT ENFORCING</Badge></Group></Group>
    <Text size="sm" c="dimmed">This PAPER enrollment records configuration and authorization evidence only. It cannot initiate, block, retry, or modify an order.</Text>
    {p && <Group gap="xs"><Badge color={p.paperEligible ? 'teal' : 'red'}>{p.paperEligible ? 'PAPER eligible' : 'Not PAPER'}</Badge><Badge color={p.configurationValid ? 'teal' : 'red'}>{p.configurationValid ? 'Configuration valid' : 'Configuration invalid'}</Badge><Badge color={p.readyToActivate ? 'teal' : 'gray'}>{p.readyToActivate ? 'Ready to activate' : 'Not ready'}</Badge><Badge color={p.currentMarketEligibility.outcome === 'ALLOWED' ? 'teal' : p.currentMarketEligibility.outcome ? 'yellow' : 'gray'}>Market: {p.currentMarketEligibility.outcome ?? p.currentMarketEligibility.evaluatorTechnicalStatus}</Badge></Group>}
    {p?.notReadyReasons.length ? <Alert color="yellow">{p.notReadyReasons.join(' · ')}</Alert> : null}
    {owner && <Group align="end"><Button size="xs" disabled={Boolean(current)} loading={prepare.isPending} onClick={() => run(() => prepare.mutateAsync(), 'Enrollment generation prepared.')}>Prepare</Button><Button size="xs" disabled={current?.status !== 'PREPARED' || !p?.readyToActivate} loading={activate.isPending} onClick={() => run(() => activate.mutateAsync(), 'Enrollment configuration activated.')}>Activate configuration</Button>{current && <><TextInput size="xs" label="Disable reason" value={reason} onChange={event => setReason(event.currentTarget.value)} /><Button size="xs" color="red" variant="light" disabled={!reason.trim()} loading={disable.isPending} onClick={() => run(() => disable.mutateAsync(), 'Enrollment generation disabled.')}>Disable</Button></>}</Group>}
    {generations.length > 0 && <Table withTableBorder striped><Table.Thead><Table.Tr><Table.Th>Generation</Table.Th><Table.Th>Status</Table.Th><Table.Th>Policy revision</Table.Th><Table.Th>Prepared</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{generations.map(g => <Table.Tr key={g.id}><Table.Td>{g.generation}</Table.Td><Table.Td>{g.status}</Table.Td><Table.Td>{g.policyRevision.revision}</Table.Td><Table.Td>{formatDateTime(g.preparedAt)}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
    {generations.flatMap(g => g.transitions).length > 0 && <Stack gap="xs"><Text fw={700} size="sm">Immutable transition history</Text>{generations.flatMap(g => g.transitions.map(t => <Text key={t.id} size="xs">{formatDateTime(t.occurredAt)} · generation {g.generation} · {t.action} · {t.actor.email}{t.reason ? ` · ${t.reason}` : ''}</Text>))}</Stack>}
  </Stack>;
}
