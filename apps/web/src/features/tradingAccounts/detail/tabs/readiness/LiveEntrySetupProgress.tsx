import { Badge, Card, Group, List, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

type Milestone = { label: string; complete: boolean };

export function LiveEntrySetupProgress({ account, assessment, canaryStaged, riskEffective, entryEffective }: {
  account: TradingAccount;
  assessment: TradingAccountReadinessAssessment | null;
  canaryStaged: boolean;
  riskEffective: boolean;
  entryEffective: boolean;
}) {
  const latestArming = account.latestLiveEntryArming ?? account.activeLiveEntryArming ?? null;
  const consumed = latestArming?.terminations.some((item) => item.type === 'CONSUMED') === true;
  const armed = Boolean(account.activeLiveEntryArmingId && account.tradingEnabled && !account.killSwitchEnabled);
  const currentArmingReadiness = assessment?.purpose === 'LIVE_ENTRY_ARMING' && assessment.result === 'PASSED' && assessment.validity === 'CURRENT';
  const credentialsCurrent = Boolean(assessment?.credentialVerifiedAt && assessment.validity !== 'EXPIRED');
  const milestones: Milestone[] = [
    { label: 'Account activated', complete: account.status === 'ACTIVE' },
    { label: 'RSP canary staged', complete: canaryStaged },
    { label: 'Credentials recently verified', complete: credentialsCurrent },
    { label: 'RISK_REDUCING effective', complete: riskEffective },
    { label: 'ENTRY effective', complete: entryEffective },
    { label: 'Live Entry Arming assessment passed and current', complete: currentArmingReadiness },
    { label: 'Live entries armed with an active binding', complete: armed },
    { label: 'One-shot authority consumed', complete: consumed },
  ];
  const currentMilestone = consumed
    ? null
    : armed
      ? 'One-shot authority consumed'
      : !canaryStaged
        ? 'RSP canary staged'
        : !credentialsCurrent
          ? 'Credentials recently verified'
          : !riskEffective
            ? 'RISK_REDUCING effective'
            : !entryEffective
              ? 'ENTRY effective'
              : !currentArmingReadiness
                ? 'Live Entry Arming assessment passed and current'
                : 'Live entries armed with an active binding';
  const next = consumed
    ? 'Verify execution evidence and DISARM.'
    : armed
      ? 'Execute the one-shot RSP canary.'
      : !canaryStaged
        ? 'Stage the RSP canary.'
        : !credentialsCurrent
          ? 'Verify credentials and run a fresh Live Entry Arming assessment.'
        : !riskEffective
          ? 'Grant RISK_REDUCING authorization.'
          : !entryEffective
            ? 'Grant ENTRY authorization.'
            : !currentArmingReadiness
              ? 'Run a fresh Live Entry Arming assessment.'
              : 'ARM LIVE ENTRIES.';

  return <Card withBorder>
    <Group justify="space-between" align="flex-start">
      <div><Title order={3}>Live Entry Setup Progress</Title><Text size="sm" c="dimmed">First-canary operator workflow</Text></div>
      <Badge color={armed ? 'red' : currentArmingReadiness ? 'green' : 'yellow'}>{armed ? 'ARMED' : currentArmingReadiness ? 'READY TO ARM' : 'IN PROGRESS'}</Badge>
    </Group>
    <SimpleGrid cols={{ base: 1, md: 2 }} mt="md">
      <Stack gap="xs">
        <Text fw={700}>What has been accomplished</Text>
        <List spacing="xs">{milestones.map((milestone) => {
          const current = milestone.label === currentMilestone;
          return <List.Item key={milestone.label} icon={<Badge color={milestone.complete ? 'green' : current ? 'blue' : 'gray'} size="xs">{milestone.complete ? 'DONE' : current ? 'CURRENT' : 'PENDING'}</Badge>}><Text size="sm">{milestone.label}</Text></List.Item>;
        })}</List>
      </Stack>
      <Card withBorder bg="var(--mantine-color-default)" c="var(--mantine-color-default-color)" data-testid="live-entry-next-panel">
        <Stack gap="xs">
          <Text fw={700} size="lg">What happens next</Text>
          <Text fw={700} data-testid="live-entry-next-action">Next step: {next}</Text>
          {!armed && !consumed && <Stack gap={2} mt="xs">
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
