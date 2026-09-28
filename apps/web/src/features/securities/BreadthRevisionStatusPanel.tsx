import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { breadthStatusQueryKey, requestBreadthStatus, requestFreeze, type FreezePlan } from './universeApi';

function StatusField({ label, value, color = 'blue' }: { label: string; value: string | number; color?: 'blue' | 'teal' | 'orange' }) {
  return <Stack gap={2} p="sm" style={{ border: `1px solid var(--mantine-color-${color}-8)`, borderLeft: `4px solid var(--mantine-color-${color}-5)`, borderRadius: 8, background: `color-mix(in srgb, var(--mantine-color-${color}-9) 22%, transparent)` }}>
    <Text size="xs" c="dimmed" tt="uppercase">{label}</Text><Text fw={700} style={{ overflowWrap: 'anywhere' }}>{value}</Text>
  </Stack>;
}

export function BreadthRevisionStatusPanel() {
  const queryClient = useQueryClient();
  const { data: status, isPending, error } = useQuery({ queryKey: breadthStatusQueryKey, queryFn: requestBreadthStatus, refetchInterval: 60_000 });
  const [review, setReview] = useState<{ plan: FreezePlan; statusKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; statusKey: string } | null>(null);
  const statusKey = `${status?.asOfDate}|${status?.state}|${status?.current.constituentHash}|${status?.latestRevision?.id}`;
  const preview = review?.statusKey === statusKey ? review.plan : null;
  async function run(action: () => Promise<void>) {
    setBusy(true); setActionError(null);
    try { await action(); }
    catch (cause) { setReview(null); setActionError({ message: cause instanceof Error ? cause.message : 'Breadth revision request failed.', statusKey }); }
    finally { setBusy(false); }
  }
  return <Card withBorder><Stack gap="md">
    <Group justify="space-between" align="flex-start"><Title order={3}>Breadth Universe Revision</Title>{status && !error && <Badge color={status.state === 'CURRENT' ? 'teal' : status.state === 'REVISION_REQUIRED' ? 'orange' : 'gray'} size="lg" variant="light">{status.state === 'REVISION_REQUIRED' ? 'REVISION REQUIRED' : status.state}</Badge>}</Group>
    {isPending && <Text size="sm" c="dimmed">Loading Breadth revision status…</Text>}
    {error && <Alert color="red" title="Breadth status unavailable">{error instanceof Error ? error.message : 'Unable to read Breadth status.'}</Alert>}
    {status && !error && <>
      <Text size="sm" c="dimmed">Current owned-universe membership as of {status.asOfDate} (America/New_York).</Text>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <StatusField label="Current broad universe" value={`${status.current.memberCount} member${status.current.memberCount === 1 ? '' : 's'}`} color={status.state === 'CURRENT' ? 'teal' : 'blue'} />
        <StatusField label="Latest frozen revision" value={status.latestRevision ? `#${status.latestRevision.id}` : 'None'} />
        <StatusField label="Revision effective date" value={status.latestRevision?.effectiveDate ?? '—'} />
        <StatusField label="Revision members" value={status.latestRevision?.memberCount ?? '—'} />
      </SimpleGrid>
      {status.latestRevision && <StatusField label="Constituent hash" value={status.latestRevision.constituentHash} color={status.state === 'CURRENT' ? 'teal' : 'blue'} />}
      {status.state === 'EMPTY' && <Text size="sm" c="dimmed">There is no current broad population to freeze.</Text>}
      {status.state === 'REVISION_REQUIRED' && <>
        <StatusField label="Population difference" value={`+${status.difference.addedCount} / -${status.difference.removedCount}`} color="orange" />
        <Group><Button variant="default" loading={busy} onClick={() => run(async () => { setReview({ plan: await requestFreeze(status.asOfDate, false, status.asOfDate), statusKey }); })}>Preview Revision</Button>
          {preview && !preview.alreadyExists && <Button loading={busy} onClick={() => run(async () => { await requestFreeze(preview.effectiveDate, true, preview.effectiveDate, preview.constituentHash); setReview(null); await queryClient.invalidateQueries({ queryKey: breadthStatusQueryKey }); })}>Freeze Revision</Button>}</Group>
        {preview && <Alert color="blue" title="Revision preview">Effective {preview.effectiveDate} · {preview.memberCount} members · {preview.constituentHash}{preview.alreadyExists ? ' · Identical revision already exists' : ''}</Alert>}
      </>}
      {actionError?.statusKey === statusKey && <Alert color="red" title="Breadth revision conflict">{actionError.message}</Alert>}
    </>}
  </Stack></Card>;
}
