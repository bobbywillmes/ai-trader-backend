import { useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Drawer,
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
  useCatalystEvent,
  useConfirmMomentumCandidatePrices,
  useGenerateMomentumCandidates,
  useMomentumCandidate,
  useMomentumCandidatePriceChecks,
  useMomentumCandidates,
  useMomentumScannerHandoff,
  useMomentumScannerHandoffs,
  usePrepareMomentumScannerHandoffs,
  useRunMassiveNewsWorker,
  useLatestMomentumPipelineRuns,
  useMomentumPipelineRuns,
  useExpireMomentumCandidates,
  useRunFullMomentumPipeline,
} from "./hooks";
import type {
  CatalystEvent,
  GenerateMomentumCandidatesRequest,
  MomentumCandidate,
  MomentumCandidateState,
  MomentumScannerHandoff,
  PrepareMomentumScannerHandoffsRequest,
} from "./types";
import { MomentumScannerNavigation } from "./MomentumScannerNavigation";
import { MomentumPipelineRunSummary } from "./components/MomentumPipelineRunSummary";

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

function formatPipelineDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
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

export function MomentumScannerPipelinePage() {
  const [token] = useState(() => getAdminToken());
  const [minCatalystScore, setMinCatalystScore] = useState(60);
  const [candidateTake, setCandidateTake] = useState(20);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [maxCandidates, setMaxCandidates] = useState(20);
  const [minHandoffScore, setMinHandoffScore] = useState(60);
  const [lastAction, setLastAction] = useState<ActionSummary | null>(null);
  const [selectedCatalystEventId, setSelectedCatalystEventId] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedHandoffId, setSelectedHandoffId] = useState<string | null>(null);

  const catalystEventsQuery = useCatalystEvents(token, { limit: 30 });
  const candidatesQuery = useMomentumCandidates(token, { limit: 50 });
  const handoffsQuery = useMomentumScannerHandoffs(token, { limit: 50 });
  const catalystEventDetailQuery = useCatalystEvent(token, selectedCatalystEventId);
  const candidateDetailQuery = useMomentumCandidate(token, selectedCandidateId);
  const candidatePriceChecksQuery = useMomentumCandidatePriceChecks(
    token,
    selectedCandidateId
  );
  const handoffDetailQuery = useMomentumScannerHandoff(token, selectedHandoffId);
  const runNewsWorker = useRunMassiveNewsWorker(token);
  const generateCandidates = useGenerateMomentumCandidates(token);
  const confirmPrices = useConfirmMomentumCandidatePrices(token);
  const prepareHandoffs = usePrepareMomentumScannerHandoffs(token);
  const latestPipelineRuns = useLatestMomentumPipelineRuns(token);
  const pipelineRuns = useMomentumPipelineRuns(token, 10);
  const expireCandidates = useExpireMomentumCandidates(token);
  const runFullPipeline = useRunFullMomentumPipeline(token);

  const catalystEvents = useMemo(
    () => catalystEventsQuery.data ?? [],
    [catalystEventsQuery.data]
  );
  const candidates = useMemo(
    () => candidatesQuery.data ?? [],
    [candidatesQuery.data]
  );
  const handoffs = useMemo(
    () => handoffsQuery.data ?? [],
    [handoffsQuery.data]
  );
  const isActionPending =
    runNewsWorker.isPending ||
    expireCandidates.isPending ||
    runFullPipeline.isPending ||
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
      latestPipelineRuns.refetch(),
      pipelineRuns.refetch(),
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

  function handleExpireCandidates() {
    void runAction(
      "Expired stale candidates",
      () => expireCandidates.mutateAsync(),
      (result) => [
        `${result.inspected} inspected`,
        `${result.expired} expired`,
        `${result.staleRemaining} stale remaining`,
      ]
    );
  }

  function handleRunFullPipeline() {
    void (async () => {
      try {
        const result = await runFullPipeline.mutateAsync({
        metadata: { requestedFrom: "scanner-pipeline-ui" },
        minCatalystScore,
        candidateTake,
        expiresInHours,
        maxCandidates,
        minHandoffScore,
        });
        const details = [
        `run ${result.runId}`,
        result.status.toLowerCase(),
        result.failedStage ? `failed at ${result.failedStage.replaceAll("_", " ").toLowerCase()}` : "core stages recorded",
        ];
        setLastAction({ label: "Full pipeline run", details });
        notifications.show({
          title: "Full pipeline run",
          message: details.join(" | "),
          color: result.status === "FAILED" ? "red" : result.status === "PARTIAL" ? "yellow" : "teal",
        });
      } catch (error) {
        notifications.show({
          title: "Unable to start full pipeline",
          message: error instanceof Error ? error.message : "Unknown error.",
          color: "red",
        });
      }
    })();
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
      <MomentumScannerNavigation />
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

      {latestPipelineRuns.isError && <Alert color="red" title="Unable to load pipeline status">{latestPipelineRuns.error instanceof Error ? latestPipelineRuns.error.message : "Pipeline status could not be loaded."}</Alert>}
      {latestPipelineRuns.data?.currentRun && <MomentumPipelineRunSummary run={latestPipelineRuns.data.currentRun} title="Currently running" />}
      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <MomentumPipelineRunSummary run={latestPipelineRuns.data?.latestAttempt ?? null} title="Latest attempted run" />
        <MomentumPipelineRunSummary run={latestPipelineRuns.data?.latestSuccessful ?? null} title="Latest successful run" />
      </SimpleGrid>

      <Card withBorder radius="md" p="lg">
        <Group justify="space-between" align="center">
          <div>
            <Title order={3}>Full pipeline run</Title>
            <Text size="sm" c="dimmed">
              Runs news, expiration, candidate generation, price confirmation, and handoff preparation as one durable ADMIN MANUAL run. Slack delivery is not included.
            </Text>
          </div>
          <Button
            leftSection={<IconBolt size={16} />}
            onClick={handleRunFullPipeline}
            loading={runFullPipeline.isPending}
          >
            Run full pipeline
          </Button>
        </Group>
      </Card>

      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Title order={3}>Recent pipeline runs</Title>
          {pipelineRuns.isError ? <Alert color="red">Recent run history could not be loaded.</Alert> : pipelineRuns.data?.data.length ? <ScrollArea>
            <Table striped highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>Status</Table.Th><Table.Th>Started</Table.Th><Table.Th>Source</Table.Th><Table.Th>Last stage</Table.Th><Table.Th>Duration</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{pipelineRuns.data.data.map((run) => <Table.Tr key={run.id}><Table.Td><Badge variant="light" color={run.status === "SUCCEEDED" ? "teal" : run.status === "RUNNING" ? "blue" : run.status === "PARTIAL" ? "yellow" : "red"}>{run.status}</Badge></Table.Td><Table.Td>{formatPipelineDate(run.startedAt)}</Table.Td><Table.Td>{run.source.replaceAll("_", " ")}</Table.Td><Table.Td>{run.currentStage?.replaceAll("_", " ") ?? "—"}</Table.Td><Table.Td>{run.durationMs === null ? "—" : `${(run.durationMs / 1000).toFixed(1)}s`}</Table.Td></Table.Tr>)}</Table.Tbody>
            </Table>
          </ScrollArea> : <Text c="dimmed">No pipeline runs recorded.</Text>}
        </Stack>
      </Card>

      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={3}>Standalone stage actions</Title>
              <Text size="sm" c="dimmed">
                Runs one stage only for testing. These calls do not create or complete a MomentumPipelineRun.
              </Text>
            </div>
            {isActionPending && <Loader size="sm" />}
          </Group>

          <Group align="flex-end">
            <Button
              variant="light"
              color="orange"
              onClick={handleExpireCandidates}
              loading={expireCandidates.isPending}
            >
              Expire stale candidates
            </Button>
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
        onView={setSelectedCatalystEventId}
      />

      <MomentumCandidatesSection
        candidates={candidates}
        isLoading={candidatesQuery.isLoading}
        isError={candidatesQuery.isError}
        onView={setSelectedCandidateId}
      />

      <ScannerHandoffsSection
        handoffs={handoffs}
        isLoading={handoffsQuery.isLoading}
        isError={handoffsQuery.isError}
        onView={setSelectedHandoffId}
      />

      <CatalystEventDrawer
        opened={selectedCatalystEventId !== null}
        event={catalystEventDetailQuery.data ?? null}
        isLoading={catalystEventDetailQuery.isLoading}
        isError={catalystEventDetailQuery.isError}
        onClose={() => setSelectedCatalystEventId(null)}
      />

      <MomentumCandidateDrawer
        opened={selectedCandidateId !== null}
        candidate={candidateDetailQuery.data ?? null}
        priceChecks={candidatePriceChecksQuery.data ?? []}
        isLoading={
          candidateDetailQuery.isLoading || candidatePriceChecksQuery.isLoading
        }
        isError={
          candidateDetailQuery.isError || candidatePriceChecksQuery.isError
        }
        onClose={() => setSelectedCandidateId(null)}
      />

      <ScannerHandoffDrawer
        opened={selectedHandoffId !== null}
        handoff={handoffDetailQuery.data ?? null}
        isLoading={handoffDetailQuery.isLoading}
        isError={handoffDetailQuery.isError}
        onClose={() => setSelectedHandoffId(null)}
      />
    </Stack>
  );
}

function CatalystEventsSection({
  events,
  isLoading,
  isError,
  onView,
}: {
  events: CatalystEvent[];
  isLoading: boolean;
  isError: boolean;
  onView: (id: string) => void;
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
                <Table.Th />
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
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => onView(event.id)}
                    >
                      View
                    </Button>
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
  onView,
}: {
  candidates: MomentumCandidate[];
  isLoading: boolean;
  isError: boolean;
  onView: (id: string) => void;
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
                <Table.Th />
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
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => onView(candidate.id)}
                    >
                      View
                    </Button>
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

function ScannerHandoffsSection({
  handoffs,
  isLoading,
  isError,
  onView,
}: {
  handoffs: MomentumScannerHandoff[];
  isLoading: boolean;
  isError: boolean;
  onView: (id: string) => void;
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
          <Table striped highlightOnHover withTableBorder miw={1180}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Symbol</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Payload</Table.Th>
                <Table.Th>Prepared</Table.Th>
                <Table.Th>Sent</Table.Th>
                <Table.Th>Failed</Table.Th>
                <Table.Th ta="right">Attempts</Table.Th>
                <Table.Th>Error</Table.Th>
                <Table.Th />
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
                  <Table.Td>{formatDate(handoff.failedAt)}</Table.Td>
                  <Table.Td ta="right">{handoff.attempts}</Table.Td>
                  <Table.Td maw={320}>
                    <Text size="sm" lineClamp={2} c={handoff.lastError ? "red" : "dimmed"}>
                      {handoff.lastError ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => onView(handoff.id)}
                    >
                      View
                    </Button>
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

function DetailItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Stack gap={3}>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="sm">{children}</Text>
    </Stack>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <Text c="dimmed">-</Text>;
  }

  return (
    <Code block style={{ whiteSpace: "pre-wrap" }}>
      {JSON.stringify(value, null, 2)}
    </Code>
  );
}

function DrawerState({
  isLoading,
  isError,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <Group>
        <Loader size="sm" />
        <Text c="dimmed">Loading details...</Text>
      </Group>
    );
  }

  if (isError) {
    return (
      <Alert color="red" title="Failed to load details">
        Check the backend route and admin session.
      </Alert>
    );
  }

  return <>{children}</>;
}

function CatalystEventDrawer({
  opened,
  event,
  isLoading,
  isError,
  onClose,
}: {
  opened: boolean;
  event: CatalystEvent | null;
  isLoading: boolean;
  isError: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="Catalyst Event"
      position="right"
      size="xl"
    >
      <DrawerState isLoading={isLoading} isError={isError}>
        {event ? (
          <Stack gap="lg">
            <Stack gap="xs">
              <Group>
                <Badge variant="light">{event.source}</Badge>
                <Badge color={sentimentColor(event.sentiment)} variant="light">
                  {event.sentiment}
                </Badge>
                <Badge variant="outline">{event.eventTier}</Badge>
              </Group>
              <Title order={3}>{event.title}</Title>
              <Text c="dimmed">{event.summary ?? "No summary recorded."}</Text>
            </Stack>

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <DetailItem label="Received">{formatDate(event.receivedAt)}</DetailItem>
              <DetailItem label="Published">{formatDate(event.publishedAt)}</DetailItem>
              <DetailItem label="Publisher">
                {formatOptional(event.sourcePublisher)}
              </DetailItem>
              <DetailItem label="Source External ID">
                {formatOptional(event.sourceExternalId)}
              </DetailItem>
              <DetailItem label="Event Type">{event.eventType}</DetailItem>
              <DetailItem label="Source URL">
                {event.sourceUrl ? (
                  <Button
                    component="a"
                    href={event.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    size="xs"
                    variant="default"
                  >
                    Open source
                  </Button>
                ) : (
                  "-"
                )}
              </DetailItem>
            </SimpleGrid>

            <Divider />

            <Stack gap="sm">
              <Title order={4}>Ticker Impacts</Title>
              {event.tickerImpacts.length === 0 ? (
                <Text c="dimmed">No ticker impacts recorded.</Text>
              ) : (
                <Table striped withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Symbol</Table.Th>
                      <Table.Th>Role</Table.Th>
                      <Table.Th>Sentiment</Table.Th>
                      <Table.Th ta="right">Score</Table.Th>
                      <Table.Th>Reason</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {event.tickerImpacts.map((impact) => (
                      <Table.Tr key={impact.id}>
                        <Table.Td>
                          <Text fw={700}>{impact.symbol}</Text>
                        </Table.Td>
                        <Table.Td>{impact.catalystRole ?? "-"}</Table.Td>
                        <Table.Td>
                          <Badge
                            color={sentimentColor(impact.sentiment)}
                            variant="light"
                          >
                            {impact.sentiment}
                          </Badge>
                        </Table.Td>
                        <Table.Td ta="right">{impact.totalCatalystScore}</Table.Td>
                        <Table.Td>
                          <Text size="sm" lineClamp={3}>
                            {impact.sentimentReasoning ??
                              impact.blockedReason ??
                              "-"}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Sentiment Reasoning</Title>
              <Text size="sm">{event.sentimentReasoning ?? "-"}</Text>
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Raw Payload</Title>
              <JsonBlock value={event.rawPayload} />
            </Stack>
          </Stack>
        ) : (
          <Text c="dimmed">No catalyst event selected.</Text>
        )}
      </DrawerState>
    </Drawer>
  );
}

function MomentumCandidateDrawer({
  opened,
  candidate,
  priceChecks,
  isLoading,
  isError,
  onClose,
}: {
  opened: boolean;
  candidate: MomentumCandidate | null;
  priceChecks: Array<import("./types").MomentumCandidatePriceCheck>;
  isLoading: boolean;
  isError: boolean;
  onClose: () => void;
}) {
  const latestPriceCheck = priceChecks[0] ?? null;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="Momentum Candidate"
      position="right"
      size="xl"
    >
      <DrawerState isLoading={isLoading} isError={isError}>
        {candidate ? (
          <Stack gap="lg">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={3}>{candidate.symbol}</Title>
                <Text c="dimmed">{candidate.reason ?? "No reason recorded."}</Text>
              </div>
              <Badge
                color={candidateStateColor(candidate.state)}
                variant={candidate.state === "ENTRY_READY" ? "filled" : "light"}
              >
                {candidate.state}
              </Badge>
            </Group>

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <DetailItem label="Total Score">{candidate.totalScore}</DetailItem>
              <DetailItem label="Catalyst Score">{candidate.catalystScore}</DetailItem>
              <DetailItem label="Price Action Score">
                {candidate.priceActionScore}
              </DetailItem>
              <DetailItem label="Volume Score">{candidate.volumeScore}</DetailItem>
              <DetailItem label="Risk Score">{candidate.riskScore}</DetailItem>
              <DetailItem label="Blocked Reason">
                {candidate.blockedReason ?? "-"}
              </DetailItem>
              <DetailItem label="Discovered">
                {formatDate(candidate.discoveredAt)}
              </DetailItem>
              <DetailItem label="Last Evaluated">
                {formatDate(candidate.lastEvaluatedAt)}
              </DetailItem>
              <DetailItem label="Expires">
                {formatDate(candidate.expiresAt)}
              </DetailItem>
            </SimpleGrid>

            <Divider />

            <Stack gap="sm">
              <Title order={4}>Catalyst Summary</Title>
              {candidate.catalystEvent ? (
                <Card withBorder radius="md" p="md">
                  <Stack gap="xs">
                    <Group>
                      <Badge variant="light">{candidate.catalystEvent.source}</Badge>
                      <Badge
                        color={sentimentColor(candidate.catalystEvent.sentiment)}
                        variant="light"
                      >
                        {candidate.catalystEvent.sentiment}
                      </Badge>
                    </Group>
                    <Text fw={700}>{candidate.catalystEvent.title}</Text>
                    <Text size="sm" c="dimmed">
                      {candidate.catalystEvent.summary ?? "-"}
                    </Text>
                  </Stack>
                </Card>
              ) : (
                <Text c="dimmed">No catalyst event linked.</Text>
              )}
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Catalyst Impact</Title>
              {candidate.catalystImpact ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <DetailItem label="Role">
                    {candidate.catalystImpact.catalystRole ?? "-"}
                  </DetailItem>
                  <DetailItem label="Sentiment">
                    {candidate.catalystImpact.sentiment}
                  </DetailItem>
                  <DetailItem label="Total Catalyst Score">
                    {candidate.catalystImpact.totalCatalystScore}
                  </DetailItem>
                  <DetailItem label="Reasoning">
                    {candidate.catalystImpact.sentimentReasoning ?? "-"}
                  </DetailItem>
                </SimpleGrid>
              ) : (
                <Text c="dimmed">No catalyst impact linked.</Text>
              )}
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Latest Price Confirmation</Title>
              {latestPriceCheck ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <DetailItem label="Observed">
                    {formatDate(latestPriceCheck.observedAt)}
                  </DetailItem>
                  <DetailItem label="Last Price">
                    {formatNumber(latestPriceCheck.lastPrice)}
                  </DetailItem>
                  <DetailItem label="Previous Close">
                    {formatNumber(latestPriceCheck.previousClose)}
                  </DetailItem>
                  <DetailItem label="% From Previous Close">
                    {formatNumber(latestPriceCheck.pctFromPreviousClose)}
                  </DetailItem>
                  <DetailItem label="Above VWAP">
                    {latestPriceCheck.aboveVwap === null
                      ? "-"
                      : latestPriceCheck.aboveVwap
                        ? "Yes"
                        : "No"}
                  </DetailItem>
                  <DetailItem label="Day Volume">
                    {formatNumber(latestPriceCheck.dayVolume)}
                  </DetailItem>
                  <DetailItem label="Dollar Volume">
                    {formatNumber(latestPriceCheck.dollarVolume)}
                  </DetailItem>
                  <DetailItem label="Recent Move %">
                    {formatNumber(latestPriceCheck.recentMovePct)}
                  </DetailItem>
                  <DetailItem label="Recent Volume">
                    {formatNumber(latestPriceCheck.recentVolume)}
                  </DetailItem>
                  <DetailItem label="Confirmed">
                    {latestPriceCheck.confirmed ? "Yes" : "No"}
                  </DetailItem>
                  <DetailItem label="Decision">{latestPriceCheck.decision}</DetailItem>
                  <DetailItem label="Blocked Reason">
                    {latestPriceCheck.blockedReason ?? "-"}
                  </DetailItem>
                </SimpleGrid>
              ) : (
                <Text c="dimmed">No price checks recorded.</Text>
              )}
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Price Checks</Title>
              {priceChecks.length === 0 ? (
                <Text c="dimmed">No price checks recorded.</Text>
              ) : (
                <Table striped withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Observed</Table.Th>
                      <Table.Th>Decision</Table.Th>
                      <Table.Th>Confirmed</Table.Th>
                      <Table.Th>Blocked</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {priceChecks.map((priceCheck) => (
                      <Table.Tr key={priceCheck.id}>
                        <Table.Td>{formatDate(priceCheck.observedAt)}</Table.Td>
                        <Table.Td>{priceCheck.decision}</Table.Td>
                        <Table.Td>{priceCheck.confirmed ? "Yes" : "No"}</Table.Td>
                        <Table.Td>{priceCheck.blockedReason ?? "-"}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Raw Snapshot</Title>
              <JsonBlock value={candidate.rawSnapshot} />
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Metadata</Title>
              <JsonBlock value={candidate.metadata} />
            </Stack>
          </Stack>
        ) : (
          <Text c="dimmed">No candidate selected.</Text>
        )}
      </DrawerState>
    </Drawer>
  );
}

function ScannerHandoffDrawer({
  opened,
  handoff,
  isLoading,
  isError,
  onClose,
}: {
  opened: boolean;
  handoff: MomentumScannerHandoff | null;
  isLoading: boolean;
  isError: boolean;
  onClose: () => void;
}) {
  const payload = handoff?.payload ?? null;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="Scanner Handoff"
      position="right"
      size="xl"
    >
      <DrawerState isLoading={isLoading} isError={isError}>
        {handoff ? (
          <Stack gap="lg">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={3}>{handoff.symbol}</Title>
                <Text c="dimmed">{handoff.idempotencyKey}</Text>
              </div>
              <Badge color={handoffStatusColor(handoff.status)} variant="light">
                {handoff.status}
              </Badge>
            </Group>

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <DetailItem label="Payload Version">
                {handoff.payloadVersion}
              </DetailItem>
              <DetailItem label="Prepared">
                {formatDate(handoff.preparedAt)}
              </DetailItem>
              <DetailItem label="Sent">{formatDate(handoff.sentAt)}</DetailItem>
              <DetailItem label="Acknowledged">
                {formatDate(handoff.acknowledgedAt)}
              </DetailItem>
              <DetailItem label="Failed">
                {formatDate(handoff.failedAt)}
              </DetailItem>
              <DetailItem label="Attempts">{handoff.attempts}</DetailItem>
              <DetailItem label="Last Error">{handoff.lastError ?? "-"}</DetailItem>
            </SimpleGrid>

            <Divider />

            <Stack gap="sm">
              <Title order={4}>Candidate Summary</Title>
              <JsonBlock value={payload?.candidate ?? null} />
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Catalyst Summary</Title>
              <JsonBlock value={payload?.catalyst ?? null} />
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Price Confirmation</Title>
              <JsonBlock value={payload?.priceConfirmation ?? null} />
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Review Guidance</Title>
              <JsonBlock value={payload?.reviewGuidance ?? null} />
            </Stack>

            <Stack gap="sm">
              <Title order={4}>Full Payload</Title>
              <JsonBlock value={payload} />
            </Stack>
          </Stack>
        ) : (
          <Text c="dimmed">No scanner handoff selected.</Text>
        )}
      </DrawerState>
    </Drawer>
  );
}
