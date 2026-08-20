import { useState } from 'react';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { ApiError } from '../../../../../lib/api';
import {
  useLatestTradingAccountReadiness,
  useRunTradingAccountReadiness,
  useTradingAccountReadinessHistory,
} from '../../../hooks';
import type {
  ReadinessOutcome,
  TradingAccount,
  TradingAccountReadinessAssessment,
} from '../../../types';
import { LiveWriteAuthorizationCard } from './LiveWriteAuthorizationCard';
import { LiveAccountActivationCard } from './LiveAccountActivationCard';
import { LiveEntryArmingCard } from './LiveEntryArmingCard';

const stageLabels: Record<string, string> = {
  CREDENTIALS_CONFIGURED: 'Credentials configured',
  CREDENTIALS_VERIFIED: 'Credentials verified',
  READ_ONLY_READY: 'Read-only ready',
  CONFIGURATION_READY: 'Configuration ready',
  RISK_REDUCING_READY: 'Risk-reducing ready',
  ACTIVATION_READY: 'Activation ready',
  ENTRY_READY: 'Entry ready',
  LIVE_ENTRY_ARMING_READY: 'Live entry arming ready',
};

function outcomeColor(
  outcome: ReadinessOutcome | 'ERROR' | 'CURRENT' | 'STALE' | 'EXPIRED',
) {
  if (outcome === 'PASSED' || outcome === 'CURRENT') return 'green';
  if (outcome === 'WARNING' || outcome === 'STALE') return 'yellow';
  if (outcome === 'NOT_APPLICABLE') return 'gray';
  return 'red';
}

function purposeLabel(purpose: TradingAccountReadinessAssessment['purpose']) {
  return purpose === 'LIVE_ENTRY_ARMING' ? 'Live Entry Arming' : 'Live Activation';
}

function isNonAuthoritativeLifecycleStage(assessment: TradingAccountReadinessAssessment, stageKey: string) {
  return assessment.purpose === 'LIVE_ENTRY_ARMING'
    ? stageKey === 'ACTIVATION_READY' || stageKey === 'ENTRY_READY'
    : stageKey === 'ENTRY_READY' || stageKey === 'LIVE_ENTRY_ARMING_READY';
}

export function AssessmentDetails({
  assessment,
}: {
  assessment: TradingAccountReadinessAssessment;
}) {
  const policy = assessment.evidence.policy;
  return (
    <Stack gap="md">
      <Group>
        <Text fw={700}>Assessment purpose: {purposeLabel(assessment.purpose)}</Text>
        <Badge color={outcomeColor(assessment.result)}>
          {assessment.result}
        </Badge>
        <Badge color={outcomeColor(assessment.validity)}>
          {assessment.validity}
        </Badge>
        <Text size="sm">
          Assessed {new Date(assessment.completedAt).toLocaleString()}
        </Text>
        <Text size="sm">
          Expires {new Date(assessment.expiresAt).toLocaleString()}
        </Text>
      </Group>
      {assessment.staleReasons.length > 0 && (
        <Alert color="yellow" title="Assessment evidence changed">
          {assessment.staleReasons.join(', ')}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
        {assessment.stages.map((stage) => {
          const nonAuthoritative = isNonAuthoritativeLifecycleStage(assessment, stage.key);
          return <Card key={stage.key} withBorder opacity={nonAuthoritative ? 0.55 : 1}>
            <Group justify="space-between">
              <Text fw={600}>{stageLabels[stage.key] ?? stage.key}</Text>
              <Badge color={outcomeColor(stage.outcome)}>{stage.outcome}</Badge>
            </Group>
            {nonAuthoritative && <Badge color="gray" variant="light">NOT REQUIRED FOR THIS ASSESSMENT</Badge>}
            <Text size="sm" c="dimmed" mt="xs">
              {stage.summary}
            </Text>
            <Text size="xs" mt="xs">
              {stage.blockerCount} blockers · {stage.warningCount} warnings
            </Text>
          </Card>;
        })}
      </SimpleGrid>
      <Card withBorder>
        <Title order={4}>Evidence summary</Title>
        <Text size="sm">
          Broker positions: {assessment.brokerPositionCount ?? 'not observed'} ·
          open orders: {assessment.brokerOpenOrderCount ?? 'not observed'}
        </Text>
        <Text size="sm">
          Local open: {assessment.localOpenPositionCount} · closing:{' '}
          {assessment.localClosingPositionCount} · intents:{' '}
          {assessment.localNonterminalIntentCount} · orders:{' '}
          {assessment.localNonterminalOrderCount}
        </Text>
        <Text size="sm">
          Reconciliation:{' '}
          {assessment.reconciliationSummary?.mode ?? 'unavailable'}
          {assessment.reconciliationSummary?.findingCount !== undefined
            ? ` · ${assessment.reconciliationSummary.findingCount} findings`
            : ''}
        </Text>
        <Text size="sm">
          Worker health:{' '}
          {assessment.evidence.workerHealth
            ?.map((worker) => `${worker.workerKey}: ${worker.status}`)
            .join(', ') || 'No rows'}
        </Text>
        <Text size="sm">
          Live risk-reducing permission:{' '}
          {policy?.allowLiveRiskReducingWrites ? 'enabled' : 'disabled'} · Live
          entry permission: {policy?.allowLiveTrading ? 'enabled' : 'disabled'}
        </Text>
      </Card>
      <Accordion variant="contained">
        {assessment.stages.map((stage) => (
          <Accordion.Item key={stage.key} value={stage.key}>
            <Accordion.Control>
              {stageLabels[stage.key] ?? stage.key} gates
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                {stage.gates.map((gate) => (
                  <Group
                    key={`${stage.key}:${gate.code}`}
                    align="flex-start"
                    wrap="nowrap"
                  >
                    <Badge color={outcomeColor(gate.outcome)}>
                      {gate.outcome}
                    </Badge>
                    <div>
                      <Text size="sm" fw={600}>
                        {gate.code}
                      </Text>
                      <Text size="sm">{gate.message}</Text>
                    </div>
                  </Group>
                ))}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Stack>
  );
}

export function ReadinessTab({
  account,
  token,
}: {
  account: TradingAccount;
  token: string | null;
}) {
  const purpose = account.status === 'ACTIVE' ? 'LIVE_ENTRY_ARMING' : 'LIVE_ACTIVATION';
  const latest = useLatestTradingAccountReadiness(account.id, token, purpose);
  const history = useTradingAccountReadinessHistory(account.id, token, purpose);
  const run = useRunTradingAccountReadiness(account.id, token, purpose);
  const [selected, setSelected] =
    useState<TradingAccountReadinessAssessment | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const assessment = selected ?? latest.data?.assessment ?? null;
  const allAssessments = history.data?.assessments ?? [];
  const visibleAssessments = showAllHistory ? allAssessments : allAssessments.slice(0, 5);

  if (account.environment !== 'LIVE') {
    return (
      <Alert color="gray" title="Not applicable">
        Live activation readiness assessments apply only to LIVE Trading
        Accounts.
      </Alert>
    );
  }

  return (
    <Stack gap="lg">
      <Card withBorder>
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>Current posture</Title>
            <Text size="sm">
              Status: {account.status} · LIVE · trading{' '}
              {account.tradingEnabled ? 'enabled' : 'disabled'} · kill switch{' '}
              {account.killSwitchEnabled ? 'enabled' : 'disabled'}
            </Text>
          </div>
          <Button
            loading={run.isPending}
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            Run readiness assessment
          </Button>
        </Group>
      </Card>
      {run.isError && (
        <Alert
          color={
            run.error instanceof ApiError && run.error.status === 409
              ? 'yellow'
              : 'red'
          }
          title={
            run.error instanceof ApiError && run.error.status === 409
              ? 'Assessment already running'
              : 'Assessment failed'
          }
        >
          {run.error.message}
        </Alert>
      )}
      {latest.isLoading && <Text c="dimmed">Loading readiness evidence…</Text>}
      {!latest.isLoading && !assessment && (
        <Alert color="blue">No readiness assessment has been recorded.</Alert>
      )}
      {assessment && <AssessmentDetails assessment={assessment} />}
      <LiveAccountActivationCard
        account={account}
        assessment={latest.data?.assessment ?? null}
        token={token}
      />
      {(account.status === 'ACTIVE' || account.status === 'PAUSED') && (
        <LiveEntryArmingCard
          account={account}
          assessment={latest.data?.assessment ?? null}
          token={token}
        />
      )}
      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <div><Title order={4}>Assessment history</Title><Text size="sm" c="dimmed">Showing {showAllHistory ? 'all' : `latest ${Math.min(5, allAssessments.length)}`} of {allAssessments.length}</Text></div>
          {allAssessments.length > 5 && <Button size="xs" variant="subtle" onClick={() => setShowAllHistory((value) => !value)}>{showAllHistory ? 'Collapse / Show recent' : 'Show all'}</Button>}
        </Group>
        <ScrollArea h={showAllHistory ? 420 : undefined} type={showAllHistory ? 'auto' : 'never'}>
          <Table striped highlightOnHover style={{ minWidth: 720 }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Purpose</Table.Th>
                <Table.Th>Result</Table.Th>
                <Table.Th>Validity</Table.Th>
                <Table.Th>Counts</Table.Th>
                <Table.Th>Fingerprints</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visibleAssessments.map((item) => (
                <Table.Tr
                  key={item.id}
                  onClick={() => setSelected(item)}
                  style={{ cursor: 'pointer' }}
                >
                  <Table.Td>
                    {new Date(item.completedAt).toLocaleString()}
                  </Table.Td>
                  <Table.Td>{purposeLabel(item.purpose)}</Table.Td>
                  <Table.Td>
                    <Badge color={outcomeColor(item.result)}>
                      {item.result}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={outcomeColor(item.validity)}>
                      {item.validity}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {item.blockers.length} blockers · {item.warnings.length}{' '}
                    warnings
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      C {item.configurationFingerprint.slice(0, 8)} · K{' '}
                      {item.credentialFingerprint.slice(0, 8)} · P{' '}
                      {item.policyFingerprint.slice(0, 8)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Card>
      <LiveWriteAuthorizationCard
        account={account}
        token={token}
        latest={latest.data?.assessment ?? null}
      />
    </Stack>
  );
}
