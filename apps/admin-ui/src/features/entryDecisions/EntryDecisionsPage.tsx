import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { getAdminToken } from "../../lib/api";
import { EntryDecisionDrawer } from "./EntryDecisionDrawer";
import { useEntryDecisionDrawer, useEntryDecisions } from "./hooks";
import type { EntryDecisionQuery, EntryDecisionSummary } from "./types";

function normalizeLimit(value: string | number, fallback: number) {
  if (value === "") return fallback;

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function EntryDecisionsPage() {
  const [token] = useState(() => getAdminToken());
  const [limit, setLimit] = useState(100);
  const [symbolFilter, setSymbolFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [signalFilter, setSignalFilter] = useState("all");
  const decisionDrawer = useEntryDecisionDrawer(token);
  const hasActiveFilters =
    symbolFilter.trim() !== "" ||
    stateFilter.trim() !== "" ||
    signalFilter !== "all" ||
    limit !== 100;

  const query = useMemo(() => {
    const next: EntryDecisionQuery = { limit };
    const symbol = symbolFilter.trim().toUpperCase();
    const decisionState = stateFilter.trim();

    if (symbol) next.symbol = symbol;
    if (decisionState) next.decisionState = decisionState;
    if (signalFilter === "created") next.signalCreated = true;
    if (signalFilter === "blocked") next.signalBlocked = true;

    return next;
  }, [limit, signalFilter, stateFilter, symbolFilter]);

  const decisionsQuery = useEntryDecisions(token, query);
  const decisions = decisionsQuery.data?.decisions ?? [];

  function clearFilters() {
    setSymbolFilter("");
    setStateFilter("");
    setSignalFilter("all");
    setLimit(100);
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Entry Decisions</Title>
          <Text c="dimmed">
            Stored n8n entry evaluations with signal outcomes and lifecycle links.
          </Text>
        </div>

        <Button
          leftSection={<IconRefresh size={16} />}
          variant="default"
          onClick={() => decisionsQuery.refetch()}
          loading={decisionsQuery.isFetching}
        >
          Refresh
        </Button>
      </Group>

      <Card withBorder radius="md" p="md">
        <Stack gap="md">
          <Group align="flex-end">
            <TextInput
              label="Symbol"
              placeholder="SPY"
              leftSection={<IconSearch size={16} />}
              value={symbolFilter}
              onChange={(event) => setSymbolFilter(event.currentTarget.value)}
              w={140}
            />

            <TextInput
              label="State"
              placeholder="eligible"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.currentTarget.value)}
              w={180}
            />

            <Select
              label="Signal"
              value={signalFilter}
              onChange={(value) => setSignalFilter(value ?? "all")}
              data={[
                { value: "all", label: "All" },
                { value: "created", label: "Created" },
                { value: "blocked", label: "Blocked" },
              ]}
              w={130}
            />

            <NumberInput
              label="Limit"
              min={1}
              max={500}
              value={limit}
              onChange={(value) => setLimit(normalizeLimit(value, limit))}
              w={110}
            />

            <Button
              variant="default"
              leftSection={<IconX size={16} />}
              onClick={clearFilters}
              disabled={!hasActiveFilters}
            >
              Clear
            </Button>
          </Group>

          {decisionsQuery.isError && (
            <Alert color="red" title="Failed to load entry decisions">
              {decisionsQuery.error instanceof Error
                ? decisionsQuery.error.message
                : "Check the backend route and admin session."}
            </Alert>
          )}

          {decisionsQuery.isLoading && (
            <Group>
              <Loader size="sm" />
              <Text c="dimmed">Loading entry decisions...</Text>
            </Group>
          )}

          {!decisionsQuery.isLoading && decisions.length === 0 && (
            <Text c="dimmed">No entry decisions found.</Text>
          )}

          {decisions.length > 0 && (
            <ScrollArea>
              <Table striped highlightOnHover withTableBorder miw={1180}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Evaluated</Table.Th>
                    <Table.Th>Symbol</Table.Th>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Signal</Table.Th>
                    <Table.Th>Reason</Table.Th>
                    <Table.Th ta="right">Price</Table.Th>
                    <Table.Th ta="right">Dip</Table.Th>
                    <Table.Th>Runtime</Table.Th>
                    <Table.Th>Subscription</Table.Th>
                    <Table.Th>Links</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {decisions.map((decision) => (
                    <EntryDecisionRow
                      key={decision.id}
                      decision={decision}
                      onSelect={() => decisionDrawer.openDecision(decision.id)}
                    />
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>

      <EntryDecisionDrawer
        {...decisionDrawer.drawerProps}
        onClose={decisionDrawer.closeDecision}
      />
    </Stack>
  );
}

function EntryDecisionRow({
  decision,
  onSelect,
}: {
  decision: EntryDecisionSummary;
  onSelect: () => void;
}) {
  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={2}>
          <Text size="sm">{formatDate(decision.evaluatedAt)}</Text>
          <Text size="xs" c="dimmed">
            {decision.persistenceReason}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text fw={700}>{decision.symbol}</Text>
        <Text size="xs" c="dimmed">
          {decision.source}
        </Text>
      </Table.Td>
      <Table.Td>
        <Badge color={decisionColor(decision.decisionState)} variant="light">
          {decision.decisionState}
        </Badge>
      </Table.Td>
      <Table.Td>
        <SignalBadge decision={decision} />
      </Table.Td>
      <Table.Td maw={260}>
        <Text size="sm" lineClamp={3}>
          {decision.blockingReason ?? decision.decisionReason ?? "-"}
        </Text>
      </Table.Td>
      <Table.Td ta="right">{formatMoney(decision.currentPrice)}</Table.Td>
      <Table.Td ta="right">
        <Stack gap={2}>
          <Text size="sm">{formatPercent(decision.dipPercent)}</Text>
          {decision.dipThresholdPercent !== null && (
            <Text size="xs" c="dimmed">
              Threshold {formatPercent(decision.dipThresholdPercent)}
            </Text>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap={4}>
          <BooleanBadge label="Orders" value={decision.allowOrderSignals} />
          <BooleanBadge label="Trading" value={decision.tradingEnabled} />
          {decision.eventRisk && (
            <Badge size="xs" color="yellow" variant="light">
              {decision.eventRisk}
            </Badge>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap={2}>
          <Text size="sm">{decision.subscriptionKey ?? "-"}</Text>
          {decision.strategyKey && (
            <Text size="xs" c="dimmed">
              {decision.strategyKey}
            </Text>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap={2}>
          <Text size="xs">Intent: {decision.orderIntentId ?? "-"}</Text>
          <Text size="xs">Order: {decision.brokerOrderRecordId ?? "-"}</Text>
          <Text size="xs">Position: {decision.trackedPositionId ?? "-"}</Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Button size="xs" variant="default" onClick={onSelect}>
          View
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function SignalBadge({ decision }: { decision: EntryDecisionSummary }) {
  if (decision.signalCreated) {
    return <Badge color="teal">Created</Badge>;
  }

  if (decision.signalBlocked) {
    return <Badge color="red">Blocked</Badge>;
  }

  if (decision.signalEligible === true) {
    return <Badge color="blue">Eligible</Badge>;
  }

  if (decision.signalEligible === false) {
    return <Badge color="gray">Not Eligible</Badge>;
  }

  return <Badge color="gray">Recorded</Badge>;
}

function BooleanBadge({
  label,
  value,
}: {
  label: string;
  value: boolean | null;
}) {
  if (value === null) {
    return (
      <Badge size="xs" color="gray" variant="light">
        {label}: -
      </Badge>
    );
  }

  return (
    <Badge size="xs" color={value ? "teal" : "red"} variant="light">
      {label}: {value ? "On" : "Off"}
    </Badge>
  );
}

function decisionColor(state: string) {
  if (state.includes("allow") || state.includes("eligible")) return "teal";
  if (state.includes("block") || state.includes("deny")) return "red";
  if (state.includes("watch") || state.includes("cooldown")) return "yellow";
  return "blue";
}

function formatDate(value: string | null) {
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

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`;
}

