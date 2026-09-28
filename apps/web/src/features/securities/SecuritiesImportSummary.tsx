import { Alert, Badge, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { ImportPlan } from './universeApi';

type Accent = 'blue' | 'gray' | 'teal' | 'orange' | 'red';

function tileStyle(color: Accent) {
  return {
    border: `1px solid var(--mantine-color-${color}-8)`,
    borderLeft: `4px solid var(--mantine-color-${color}-5)`,
    borderRadius: 8,
    background: `color-mix(in srgb, var(--mantine-color-${color}-9) 22%, transparent)`,
  };
}

function SummaryTile({ label, value, color, testId }: { label: string; value: string | number; color: Accent; testId: string }) {
  return <Stack gap={2} p="sm" style={tileStyle(color)} data-testid={testId}>
    <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
    <Text size="lg" fw={700}>{value}</Text>
  </Stack>;
}

function ScopeBadges({ label, fields, subdued = false }: { label: string; fields: string[]; subdued?: boolean }) {
  return <Stack gap="xs">
    <Text size="sm" fw={600}>{label}</Text>
    <Group gap="xs">
      {fields.length ? fields.map(field => <Badge key={field} color={subdued ? 'gray' : 'blue'} variant="light" size="sm">{field}</Badge>) : <Text size="sm" c="dimmed">None</Text>}
    </Group>
  </Stack>;
}

export function SecuritiesImportSummary({ filename, plan }: { filename: string; plan: ImportPlan }) {
  const conflict = plan.conflicts.length > 0;
  const identityConflict = plan.conflicts.some(item => /universe.*conflict|source universe/i.test(item));
  const scheduled = plan.timing.kind === 'scheduled';

  return <Card withBorder radius="md" p="lg" data-testid="import-plan-summary">
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={4}>{plan.applied ? 'Import Result' : 'Import Preview'}</Title>
          {plan.applied && <Text size="sm" c="teal" fw={600}>{scheduled ? 'Applied import · memberships scheduled' : 'Applied import'}</Text>}
        </div>
        <Badge size="lg" variant="light" color={conflict ? 'red' : scheduled ? 'blue' : plan.applied ? 'teal' : 'blue'}>
          {conflict ? 'CONFLICTS' : scheduled ? 'SCHEDULED' : plan.applied ? 'APPLIED' : 'READY TO APPLY'}
        </Badge>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Stack gap={2}>
          <Text size="xs" c="dimmed" tt="uppercase">File</Text>
          <Text fw={700} style={{ overflowWrap: 'anywhere' }}>{filename}</Text>
        </Stack>
        <Stack gap={2}>
          <Text size="xs" c="dimmed" tt="uppercase">Membership effective date</Text>
          <Text fw={700}>{plan.effectiveDate}</Text>
        </Stack>
      </SimpleGrid>

      <Card withBorder radius="md" p="md">
        <Stack gap="xs">
          <Title order={5}>Timing</Title>
          {scheduled ? <>
            <Text size="sm"><b>Security/catalog changes:</b> Applied immediately</Text>
            <Text size="sm"><b>Universe memberships:</b> Effective {plan.effectiveDate}</Text>
            {plan.applied && <Text size="sm" c="blue">The database operation succeeded. Membership changes are scheduled and are not currently active.</Text>}
          </> : <Text size="sm" fw={600}>Immediate · takes effect today</Text>}
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 6 }}>
        <SummaryTile label="Securities supplied" value={plan.inputSecurityCount} color="blue" testId="summary-securities" />
        <SummaryTile label={scheduled ? 'Broad universe on effective date' : 'Broad universe'} value={`${plan.currentBroadMemberCount} → ${plan.resultingBroadMemberCount}`} color="blue" testId="summary-broad" />
        <SummaryTile label="New Securities" value={plan.newSecurities.length} color={plan.newSecurities.length ? 'teal' : 'gray'} testId="summary-new" />
        <SummaryTile label="Metadata changes" value={plan.metadataChanges.length} color={plan.metadataChanges.length ? 'blue' : 'gray'} testId="summary-metadata" />
        <SummaryTile label="Membership additions" value={plan.membershipAdditions.length + plan.membershipReopens.length} color={plan.membershipAdditions.length + plan.membershipReopens.length ? 'teal' : 'gray'} testId="summary-additions" />
        <SummaryTile label="Membership removals" value={plan.membershipRemovals.length + plan.membershipDeletions.length} color={plan.membershipRemovals.length + plan.membershipDeletions.length ? 'orange' : 'gray'} testId="summary-removals" />
      </SimpleGrid>

      <Card withBorder radius="md" p="md">
        <Stack gap="md">
          <Title order={5}>Import Scope</Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <ScopeBadges label="Supplied fields" fields={plan.suppliedColumns} />
            <ScopeBadges label="Omitted fields · unchanged" fields={plan.omittedColumns} subdued />
          </SimpleGrid>
        </Stack>
      </Card>

      <Stack gap="sm">
        <Title order={5}>Universe Membership Impact</Title>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
          {plan.universeCounts.map(universe => {
            const changed = universe.before !== universe.after;
            const color: Accent = !changed ? 'gray' : universe.after > universe.before ? 'teal' : 'orange';
            return <Stack key={universe.code} gap={4} p="sm" style={changed ? tileStyle(color) : { border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }} data-testid={`universe-impact-${universe.code}`}>
              <Group justify="space-between" gap="xs">
                <Text fw={changed ? 700 : 500} size="sm">{universe.code}</Text>
                {changed && <Badge size="xs" color={color} variant="light">Changed</Badge>}
              </Group>
              <Text size="sm" c={changed ? undefined : 'dimmed'}>{universe.before} → {universe.after}</Text>
            </Stack>;
          })}
        </SimpleGrid>
      </Stack>

      {plan.unchangedMembershipValues.length > 0 && <Text size="xs" c="dimmed">Unchanged supplied membership values: {plan.unchangedMembershipValues.length}</Text>}
      {plan.missingUniverses.length > 0 && <Alert color={identityConflict ? 'red' : 'blue'} variant="light" title={identityConflict ? 'Source universe identities need review' : 'Source universes to initialize'}>
        <Group gap="xs">{plan.missingUniverses.map(code => <Badge key={code} color={identityConflict ? 'red' : 'blue'} variant="light">{code}</Badge>)}</Group>
      </Alert>}
      {conflict && <Alert color="red" title="Import conflicts">{plan.conflicts.map(item => <Text key={item} size="sm">{item}</Text>)}</Alert>}
    </Stack>
  </Card>;
}
