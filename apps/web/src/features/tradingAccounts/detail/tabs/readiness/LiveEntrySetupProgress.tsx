import { Badge, Card, Group, List, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';
import { deriveLiveEntrySetupState, type CurrentApproval } from './liveEntrySetupState';

export function LiveEntrySetupProgress({ account, assessment, canaryStaged, riskApproval, entryApproval }: {
  account: TradingAccount;
  assessment: TradingAccountReadinessAssessment | null;
  canaryStaged: boolean;
  riskApproval: CurrentApproval | null;
  entryApproval: CurrentApproval | null;
}) {
  const workflow = deriveLiveEntrySetupState({ account, assessment, canaryStaged, riskApproval, entryApproval });

  return <Card withBorder>
    <Group justify="space-between" align="flex-start">
      <div><Title order={3}>Live Entry Setup Progress</Title><Text size="sm" c="dimmed">First-canary operator workflow</Text></div>
      <Badge color={workflow.armed ? 'red' : workflow.readyToArm ? 'green' : 'yellow'}>{workflow.armed ? 'ARMED' : workflow.readyToArm ? 'READY TO ARM' : 'IN PROGRESS'}</Badge>
    </Group>
    <SimpleGrid cols={{ base: 1, md: 2 }} mt="md">
      <Stack gap="xs">
        <Text fw={700}>What has been accomplished</Text>
        <List spacing="xs">{workflow.milestones.map((milestone) => {
          return <List.Item key={milestone.key} icon={<Badge color={milestone.status === 'DONE' ? 'green' : milestone.status === 'NEXT' ? 'blue' : 'gray'} size="xs">{milestone.status}</Badge>}><Text size="sm">{milestone.label}</Text></List.Item>;
        })}</List>
      </Stack>
      <Card withBorder bg="var(--mantine-color-default)" c="var(--mantine-color-default-color)" data-testid="live-entry-next-panel">
        <Stack gap="xs">
          <Text fw={700} size="lg">What happens next</Text>
          <Text fw={700} data-testid="live-entry-next-action">Next step: {workflow.nextAction}</Text>
          {!workflow.armed && !workflow.consumedHistorically && <Stack gap={2} mt="xs">
            <Text size="sm">No broker order has been sent.</Text>
            <Text size="sm">Account trading remains disabled.</Text>
            <Text size="sm">Kill switch remains enabled.</Text>
            <Text size="sm" fw={600}>ENTRY approval alone does not authorize a broker entry.</Text>
          </Stack>}
        </Stack>
      </Card>
    </SimpleGrid>
  </Card>;
}
