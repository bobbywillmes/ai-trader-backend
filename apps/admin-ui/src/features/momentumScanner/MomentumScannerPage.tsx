import { useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconBolt,
  IconCircleCheck,
  IconRefresh,
  IconSend,
  IconSparkles,
} from "@tabler/icons-react";

import { getAdminToken } from "../../lib/api";
import {
  useCatalystEvents,
  useConfirmMomentumCandidatePrices,
  useGenerateMomentumCandidates,
  useMomentumCandidates,
  useMomentumScannerHandoffs,
  usePrepareMomentumScannerHandoffs,
  useRunMassiveNewsWorker,
} from "./hooks";
import type {
  CatalystEvent,
  GenerateMomentumCandidatesRequest,
  MomentumCandidate,
  MomentumCandidateState,
  MomentumScannerHandoff,
  PrepareMomentumScannerHandoffsRequest,
} from "./types";

type ActionSummary = {
  label: string;
  details: string[];
};

function normalizePositiveInteger(value: string | number, fallback: number) {
  if (value === "") return fallback;

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-";

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) return String(value);

  return parsed.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function formatOptional(value: string | null | undefined) {
  return value && value.trim() !== "" ? value : "-";
}

function candidateStateColor(state: MomentumCandidateState) {
  switch (state) {
    case "ENTRY_READY":
      return "teal";
    case "ENTRY_BLOCKED":
      return "red";
    case "WATCHING":
      return "blue";
    case "DISCOVERED":
      return "cyan";
    case "EXPIRED":
    case "DISMISSED":
      return "gray";
    default:
      return "gray";
  }
}

function handoffStatusColor(status: string) {
  switch (status) {
    case "PENDING":
      return "blue";
    case "SENT":
      return "cyan";
    case "ACKNOWLEDGED":
      return "teal";
    case "FAILED":
      return "red";
    default:
      return "gray";
  }
}

function sentimentColor(sentiment: string) {
  switch (sentiment) {
    case "POSITIVE":
      return "teal";
    case "NEGATIVE":
      return "red";
    case "MIXED":
      return "yellow";
    default:
      return "gray";
  }
}

function SectionShell({
  title,
  subtitle,
  isLoading,
  isError,
  errorTitle,
  empty,
  children,
}: {
  title: string;
  subtitle: string;
  isLoading: boolean;
  isError: boolean;
  errorTitle: string;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>{title}</Title>
            <Text size="sm" c="dimmed">
              {subtitle}
            </Text>
          </div>
          {isLoading && <Loader size="sm" />}
        </Group>

        {isError && (
          <Alert color="red" title={errorTitle}>
            Check the backend route and admin session.
          </Alert>
        )}

        {!isLoading && !isError && empty ? (
          <Text c="dimmed">No records found.</Text>
        ) : (
          children
        )}
      </Stack>
    </Card>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  color = "cyan",
}: {
  label: string;
  value: number;
  detail: string;
  color?: string;
}) {
  return (
    <Card withBorder radius="md" p="md">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={800} size="xl" c={color}>
        {value.toLocaleString()}
      </Text>
      <Text size="xs" c="dimmed">
        {detail}
      </Text>
    </Card>
  );
}

export function MomentumScannerPage() {
  const [token] = useState(() => getAdminToken());
  const [minCatalystScore, setMinCatalystScore] = useState(60);
  const [candidateTake, setCandidateTake] = useState(20);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [maxCandidates, setMaxCandidates] = useState(20);
  const [minHandoffScore, setMinHandoffScore] = useState(60);
  const [lastAction, setLastAction] = useState<ActionSummary | null>(null);

  const catalystEventsQuery = useCatalystEvents(token, { limit: 30 });
  const candidatesQuery = useMomentumCandidates(token, { limit: 50 });
  const handoffsQuery = useMomentumScannerHandoffs(token, { limit: 50 });
  const runNewsWorker = useRunMassiveNewsWorker(token);
  const generateCandidates = useGenerateMomentumCandidates(token);
  const confirmPrices = useConfirmMomentumCandidatePrices(token);
  const prepareHandoffs = usePrepareMomentumScannerHandoffs(token);

  const catalystEvents = catalystEventsQuery.data ?? [];
  const candidates = candidatesQuery.data ?? [];
  const handoffs = handoffsQuery.data ?? [];
  const isActionPending =
    runNewsWorker.isPending ||
    generateCandidates.isPending ||
    confirmPrices.isPending ||
    prepareHandoffs.isPending;

  const stateCounts = useMemo(() => {
    return candidates.reduce<Record<string, number>>((counts, candidate) => {
      counts[candidate.state] = (counts[candidate.state] ?? 0) + 1;
      return counts;
    }, {});
  }, [candidates]);

  async function refreshAll() {
    await Promise.all([
      catalystEventsQuery.refetch(),
      candidatesQuery.refetch(),
      handoffsQuery.refetch(),
    ]);
    notifications.show({
      message: "Momentum scanner data refreshed.",
      color: "teal",
    });
  }

  async function runAction<T>(
    label: string,
    action: () => Promise<T>,
    summarize: (result: T) => string[]
  ) {
    try {
      const result = await action();
      const details = summarize(result);
      setLastAction({ label, details });
      notifications.show({
        title: label,
        message: details.join(" | "),
        color: "teal",
      });
    } catch (error) {
      notifications.show({
        title: `${label} failed`,
        message: error instanceof Error ? error.message : "Unknown error.",
        color: "red",
      });
    }
  }

  function handleGenerateCandidates() {
    const request: GenerateMomentumCandidatesRequest = {
      minCatalystScore,
      take: candidateTake,
      expiresInHours,
    };

    void runAction(
      "Generated candidates",
      () => generateCandidates.mutateAsync(request),
      (result) => [
        `${result.generatedCandidates} generated`,
        `${result.evaluatedImpacts} impacts evaluated`,
        `score >= ${result.minCatalystScore}`,
      ]
    );
  }

  function handlePrepareHandoffs() {
    const request: PrepareMomentumScannerHandoffsRequest = {
      maxCandidates,
      minScore: minHandoffScore,
    };

    void runAction(
      "Prepared handoffs",
      () => prepareHandoffs.mutateAsync(request),
      (result) => [
        `${result.prepared} prepared`,
        `${result.skipped} skipped`,
        `${result.handoffs.length} handoff records`,
      ]
    );
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="sm" mb={4}>
            <Title order={2}>Momentum Scanner</Title>
            <Badge color="blue" variant="light">
              Backend pipeline
            </Badge>
            <Badge color="teal" variant="light">
              Review only
            </Badge>
            <Badge color="gray" variant="light">
              No orders
            </Badge>
          </Group>
          <Text c="dimmed">
            Review and manually test the catalyst/news momentum pipeline. This
            page does not create signals, orders, broker activity, or n8n
            workflow changes.
          </Text>
        </div>

        <Button
          leftSection={<IconRefresh size={16} />}
          variant="default"
          onClick={() => void refreshAll()}
          loading={
            catalystEventsQuery.isFetching ||
            candidatesQuery.isFetching ||
            handoffsQuery.isFetching
          }
        >
          Refresh
        </Button>
      </Group>

      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={3}>Manual Workflow Actions</Title>
              <Text size="sm" c="dimmed">
                Testing controls for the non-trading pipeline sequence.
              </Text>
            </div>
            {isActionPending && <Loader size="sm" />}
          </Group>

          <Group align="flex-end">
            <NumberInput
              label="Min catalyst score"
              min={1}
              max={100}
              value={minCatalystScore}
              onChange={(value) =>
                setMinCatalystScore(normalizePositiveInteger(value, 60))
              }
              w={150}
            />
            <NumberInput
              label="Take"
              min={1}
              max={250}
              value={candidateTake}
              onChange={(value) =>
                setCandidateTake(normalizePositiveInteger(value, 20))
              }
              w={110}
            />
            <NumberInput
              label="Expires hours"
              min={1}
              max={168}
              value={expiresInHours}
              onChange={(value) =>
                setExpiresInHours(normalizePositiveInteger(value, 24))
              }
              w={140}
            />
            <NumberInput
              label="Max handoffs"
              min={1}
              max={100}
              value={maxCandidates}
              onChange={(value) =>
                setMaxCandidates(normalizePositiveInteger(value, 20))
              }
              w={130}
            />
            <NumberInput
              label="Min handoff score"
              min={1}
              max={100}
              value={minHandoffScore}
              onChange={(value) =>
                setMinHandoffScore(normalizePositiveInteger(value, 60))
              }
              w={160}
            />
          </Group>

          <Group>
            <Button
              leftSection={<IconBolt size={16} />}
              variant="light"
              onClick={() =>
                void runAction(
                  "Ran news worker",
                  () => runNewsWorker.mutateAsync(),
                  (result) => [
                    result.ok ? "worker returned ok" : "worker returned not ok",
                  ]
                )
              }
              loading={runNewsWorker.isPending}
            >
              Run news worker
            </Button>
            <Button
              leftSection={<IconSparkles size={16} />}
              variant="light"
              onClick={handleGenerateCandidates}
              loading={generateCandidates.isPending}
            >
              Generate candidates
            </Button>
            <Button
              leftSection={<IconCircleCheck size={16} />}
              variant="light"
              onClick={() =>
                void runAction(
                  "Confirmed prices",
                  () =>
                    confirmPrices.mutateAsync({
                      maxCandidates,
                      minCatalystScore,
                    }),
                  (result) => [
                    `${formatNumber(result.checked)} checked`,
                    `${formatNumber(result.confirmed)} confirmed`,
                    `${formatNumber(result.blocked)} blocked`,
                  ]
                )
              }
              loading={confirmPrices.isPending}
            >
              Confirm prices
            </Button>
            <Button
              leftSection={<IconSend size={16} />}
              variant="light"
              onClick={handlePrepareHandoffs}
              loading={prepareHandoffs.isPending}
            >
              Prepare handoffs
            </Button>
          </Group>

          {lastAction && (
            <Alert color="teal" title={lastAction.label}>
              {lastAction.details.join(" | ")}
            </Alert>
          )}
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
        <SummaryCard
          label="Catalyst Events"
          value={catalystEvents.length}
          detail="Recent news catalysts"
        />
        <SummaryCard
          label="Candidates"
          value={candidates.length}
          detail="Current review list"
        />
        <SummaryCard
          label="Entry Ready"
          value={stateCounts.ENTRY_READY ?? 0}
          detail="Scanner eligible"
          color="teal"
        />
        <SummaryCard
          label="Entry Blocked"
          value={stateCounts.ENTRY_BLOCKED ?? 0}
          detail="Needs review"
          color="red"
        />
        <SummaryCard
          label="Handoffs"
          value={handoffs.length}
          detail="Prepared scanner payloads"
        />
      </SimpleGrid>

      <CatalystEventsSection
        events={catalystEvents}
        isLoading={catalystEventsQuery.isLoading}
        isError={catalystEventsQuery.isError}
      />

      <MomentumCandidatesSection
        candidates={candidates}
        isLoading={candidatesQuery.isLoading}
        isError={candidatesQuery.isError}
      />

      <ScannerHandoffsSection
        handoffs={handoffs}
        isLoading={handoffsQuery.isLoading}
        isError={handoffsQuery.isError}
      />
    </Stack>
  );
}

function CatalystEventsSection({
  events,
  isLoading,
  isError,
}: {
  events: CatalystEvent[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <SectionShell
      title="Catalyst Events"
      subtitle="Recent catalyst records and ticker-impact coverage."
      isLoading={isLoading}
      isError={isError}
      errorTitle="Failed to load catalyst events"
      empty={events.length === 0}
    >
      {events.length > 0 && (
        <ScrollArea>
          <Table striped highlightOnHover withTableBorder miw={1180}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Received</Table.Th>
                <Table.Th>Published</Table.Th>
                <Table.Th>Source</Table.Th>
                <Table.Th>Publisher</Table.Th>
                <Table.Th>Title</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Tier</Table.Th>
                <Table.Th>Sentiment</Table.Th>
                <Table.Th ta="right">Impacts</Table.Th>
                <Table.Th>Link</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {events.map((event) => (
                <Table.Tr key={event.id}>
                  <Table.Td>{formatDate(event.receivedAt)}</Table.Td>
                  <Table.Td>{formatDate(event.publishedAt)}</Table.Td>
                  <Table.Td>
                    <Badge variant="light">{event.source}</Badge>
                  </Table.Td>
                  <Table.Td>{formatOptional(event.sourcePublisher)}</Table.Td>
                  <Table.Td maw={360}>
                    <Text size="sm" lineClamp={2}>
                      {event.title}
                    </Text>
                  </Table.Td>
                  <Table.Td>{event.eventType}</Table.Td>
                  <Table.Td>
                    <Badge variant="outline">{event.eventTier}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={sentimentColor(event.sentiment)} variant="light">
                      {event.sentiment}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">{event.tickerImpacts.length}</Table.Td>
                  <Table.Td>
                    {event.sourceUrl ? (
                      <Button
                        component="a"
                        href={event.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        size="xs"
                        variant="default"
                      >
                        Source
                      </Button>
                    ) : (
                      <Text size="sm" c="dimmed">
                        -
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </SectionShell>
  );
}

function MomentumCandidatesSection({
  candidates,
  isLoading,
  isError,
}: {
  candidates: MomentumCandidate[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <SectionShell
      title="Momentum Candidates"
      subtitle="Generated symbols with catalyst, price-action, volume, and risk scoring."
      isLoading={isLoading}
      isError={isError}
      errorTitle="Failed to load momentum candidates"
      empty={candidates.length === 0}
    >
      {candidates.length > 0 && (
        <ScrollArea>
          <Table striped highlightOnHover withTableBorder miw={1420}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Symbol</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th ta="right">Total</Table.Th>
                <Table.Th ta="right">Catalyst</Table.Th>
                <Table.Th ta="right">Price</Table.Th>
                <Table.Th ta="right">Volume</Table.Th>
                <Table.Th ta="right">Risk</Table.Th>
                <Table.Th>Blocked</Table.Th>
                <Table.Th>Reason</Table.Th>
                <Table.Th>Discovered</Table.Th>
                <Table.Th>Evaluated</Table.Th>
                <Table.Th>Expires</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {candidates.map((candidate) => (
                <Table.Tr key={candidate.id}>
                  <Table.Td>
                    <Text fw={800}>{candidate.symbol}</Text>
                    <Text size="xs" c="dimmed">
                      {candidate.catalystEvent?.source ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      color={candidateStateColor(candidate.state)}
                      variant={candidate.state === "ENTRY_READY" ? "filled" : "light"}
                    >
                      {candidate.state}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">{candidate.totalScore}</Table.Td>
                  <Table.Td ta="right">{candidate.catalystScore}</Table.Td>
                  <Table.Td ta="right">{candidate.priceActionScore}</Table.Td>
                  <Table.Td ta="right">{candidate.volumeScore}</Table.Td>
                  <Table.Td ta="right">{candidate.riskScore}</Table.Td>
                  <Table.Td maw={220}>
                    <Text size="sm" lineClamp={2} c={candidate.blockedReason ? "red" : "dimmed"}>
                      {candidate.blockedReason ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td maw={320}>
                    <Text size="sm" lineClamp={2}>
                      {candidate.reason ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>{formatDate(candidate.discoveredAt)}</Table.Td>
                  <Table.Td>{formatDate(candidate.lastEvaluatedAt)}</Table.Td>
                  <Table.Td>{formatDate(candidate.expiresAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </SectionShell>
  );
}

function ScannerHandoffsSection({
  handoffs,
  isLoading,
  isError,
}: {
  handoffs: MomentumScannerHandoff[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <SectionShell
      title="Scanner Handoffs"
      subtitle="Prepared review payloads for the downstream scanner workflow."
      isLoading={isLoading}
      isError={isError}
      errorTitle="Failed to load scanner handoffs"
      empty={handoffs.length === 0}
    >
      {handoffs.length > 0 && (
        <ScrollArea>
          <Table striped highlightOnHover withTableBorder miw={1280}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Symbol</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Payload</Table.Th>
                <Table.Th>Prepared</Table.Th>
                <Table.Th>Sent</Table.Th>
                <Table.Th>Ack</Table.Th>
                <Table.Th>Failed</Table.Th>
                <Table.Th ta="right">Attempts</Table.Th>
                <Table.Th>Error</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {handoffs.map((handoff) => (
                <Table.Tr key={handoff.id}>
                  <Table.Td>
                    <Text fw={800}>{handoff.symbol}</Text>
                    <Text size="xs" c="dimmed">
                      {handoff.momentumCandidate?.state ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={handoffStatusColor(handoff.status)} variant="light">
                      {handoff.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{handoff.payloadVersion}</Table.Td>
                  <Table.Td>{formatDate(handoff.preparedAt)}</Table.Td>
                  <Table.Td>{formatDate(handoff.sentAt)}</Table.Td>
                  <Table.Td>{formatDate(handoff.acknowledgedAt)}</Table.Td>
                  <Table.Td>{formatDate(handoff.failedAt)}</Table.Td>
                  <Table.Td ta="right">{handoff.attempts}</Table.Td>
                  <Table.Td maw={320}>
                    <Text size="sm" lineClamp={2} c={handoff.lastError ? "red" : "dimmed"}>
                      {handoff.lastError ?? "-"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </SectionShell>
  );
}
