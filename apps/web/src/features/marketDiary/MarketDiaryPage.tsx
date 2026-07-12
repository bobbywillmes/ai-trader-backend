import { useCurrentMarketState, useMarketDiaryEvents } from './hooks';
import { useState } from 'react';
import { getAdminToken } from '../../lib/api';
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';



function formatDate(value: string | null) {
  if (!value) return '—';

  return new Date(value).toLocaleString();
}

function formatOptional(value: string | null | undefined) {
  return value && value.trim().length > 0 ? value : '—';
}

function getBiasColor(value: string) {
  switch (value.toLowerCase()) {
    case 'bullish':
      return 'green';
    case 'bearish':
    case 'risk_off':
      return 'red';
    case 'cautious':
      return 'yellow';
    case 'neutral':
    default:
      return 'blue';
  }
}

function getRiskModeColor(value: string) {
  switch (value.toLowerCase()) {
    case 'normal':
      return 'green';
    case 'reduced_size':
    case 'cautious':
      return 'yellow';
    case 'no_new_entries':
    case 'risk_off':
      return 'red';
    default:
      return 'blue';
  }
}

function DetailItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack gap={4}>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="sm">{children}</Text>
    </Stack>
  );
}

export function MarketDiaryPage() {
  const [token] = useState(() => getAdminToken());

  const marketStateQuery = useCurrentMarketState(token);
  const diaryEventsQuery = useMarketDiaryEvents(token);

  const marketState = marketStateQuery.data;
  const events = diaryEventsQuery.data ?? [];

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>Market Diary</Title>
        <Text c="dimmed" mt={4}>
          Current market context and recent diary events used by n8n workflows.
        </Text>
      </div>

      <Card withBorder radius="lg" p="lg">
        <Stack gap="lg">
          <div>
            <Title order={2}>Current Market State</Title>
            <Text c="dimmed" size="sm" mt={4}>
              Backend source of truth for the active market context.
            </Text>
          </div>

          {marketStateQuery.isLoading ? (
            <Group gap="sm">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Loading market state...
              </Text>
            </Group>
          ) : marketStateQuery.isError ? (
            <Alert
              color="red"
              icon={<IconAlertCircle size={18} />}
              title="Unable to load market state"
            >
              Check that the backend is running and that your admin token is valid.
            </Alert>
          ) : marketState ? (
            <Stack gap="lg">
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
                <DetailItem label="Market Bias">
                  <Badge color={getBiasColor(marketState.marketBias)}>
                    {marketState.marketBias}
                  </Badge>
                </DetailItem>

                <DetailItem label="Risk Mode">
                  <Badge color={getRiskModeColor(marketState.riskMode)}>
                    {marketState.riskMode}
                  </Badge>
                </DetailItem>

                <DetailItem label="Source">{marketState.source}</DetailItem>

                <DetailItem label="Last LLM Run">
                  {formatDate(marketState.lastLlmRunAt)}
                </DetailItem>

                <DetailItem label="Valid Until">
                  {formatDate(marketState.validUntil)}
                </DetailItem>

                <DetailItem label="Updated">
                  {formatDate(marketState.updatedAt)}
                </DetailItem>
              </SimpleGrid>

              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                <Paper withBorder radius="md" p="md">
                  <DetailItem label="Macro Summary">
                    {formatOptional(marketState.macroSummary)}
                  </DetailItem>
                </Paper>

                <Paper withBorder radius="md" p="md">
                  <DetailItem label="Watch For">
                    {formatOptional(marketState.watchFor)}
                  </DetailItem>
                </Paper>

                <Paper withBorder radius="md" p="md">
                  <DetailItem label="Avoid Because">
                    {formatOptional(marketState.avoidBecause)}
                  </DetailItem>
                </Paper>

                <Paper withBorder radius="md" p="md">
                  <DetailItem label="Notes">
                    {formatOptional(marketState.notes)}
                  </DetailItem>
                </Paper>
              </SimpleGrid>
            </Stack>
          ) : (
            <Text c="dimmed">No market state found.</Text>
          )}
        </Stack>
      </Card>

      <Card withBorder radius="lg" p="lg">
        <Stack gap="lg">
          <div>
            <Title order={2}>Recent Diary Events</Title>
            <Text c="dimmed" size="sm" mt={4}>
              Latest market diary records written by admin tools or n8n.
            </Text>
          </div>

          {diaryEventsQuery.isLoading ? (
            <Group gap="sm">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Loading diary events...
              </Text>
            </Group>
          ) : diaryEventsQuery.isError ? (
            <Alert
              color="red"
              icon={<IconAlertCircle size={18} />}
              title="Unable to load diary events"
            >
              Check that the market diary endpoint is available.
            </Alert>
          ) : events.length === 0 ? (
            <Text c="dimmed">No diary events found.</Text>
          ) : (
            <Table.ScrollContainer minWidth={900}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Time</Table.Th>
                    <Table.Th>Event Type</Table.Th>
                    <Table.Th>Source</Table.Th>
                    <Table.Th>Symbol</Table.Th>
                    <Table.Th>Summary</Table.Th>
                    <Table.Th>Details</Table.Th>
                  </Table.Tr>
                </Table.Thead>

                <Table.Tbody>
                  {events.map((event) => (
                    <Table.Tr key={event.id}>
                      <Table.Td>
                        <Text size="sm">{formatDate(event.createdAt)}</Text>
                      </Table.Td>

                      <Table.Td>
                        <Badge variant="light">{event.eventType}</Badge>
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm">{event.source}</Text>
                      </Table.Td>

                      <Table.Td>
                        {event.symbol ? (
                          <Badge color="blue" variant="outline">
                            {event.symbol}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm">{event.summary}</Text>
                      </Table.Td>

                      <Table.Td>
                        <Text size="sm" c={event.details ? undefined : 'dimmed'}>
                          {formatOptional(event.details)}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}