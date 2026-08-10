import { Fragment, useMemo, useState } from "react";
import {
  Accordion,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRefresh, IconSearch } from "@tabler/icons-react";
import { TradingAccountBadge } from "../../components/TradingAccountBadge";
import {
  CompactRecordList,
  DataState,
  DataTable,
  MobileRecordCard,
  RecordDetailsGrid,
  ResponsiveDataView,
  ResponsiveDetails,
  ResponsiveFilterToolbar,
  StatusBadge,
  formatStatusLabel,
  type SummaryField,
} from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { describeEvent, rawPayload } from "../dashboard/eventUtils";
import { useSystemEvents } from "../dashboard/hooks";
import type { SystemEvent } from "../dashboard/types";
import classes from "./SystemEventsPage.module.css";
import { TradingAccountScopeSelector } from "../tradingAccountScope/TradingAccountScopeSelector";
import { useTradingAccountScope } from "../tradingAccountScope/useTradingAccountScope";

const eventTitle = (type: string) =>
  type.split(".").map(formatStatusLabel).join(" ");
const eventTone = (event: SystemEvent) =>
  /rejected|failed|error|critical/.test(event.type)
    ? ("danger" as const)
    : /warning|blocked|cancel|expired|attention/.test(event.type)
      ? ("warning" as const)
      : event.processed
        ? ("neutral" as const)
        : ("informational" as const);
const formatDate = (value: string) => new Date(value).toLocaleString();
function Details({ event }: { event: SystemEvent }) {
  const meta = describeEvent(event);
  return (
    <Stack gap="md">
      <section>
        <Title order={3} size="h5">
          Event
        </Title>
        <RecordDetailsGrid
          sections={[
            {
              items: [
                { label: "Event", value: eventTitle(event.type) },
                { label: "Timestamp", value: formatDate(event.createdAt) },
                {
                  label: "Summary",
                  value: meta.description || "No summary was provided",
                },
                {
                  label: "Processing state",
                  value: event.processed ? "Processed" : "Recorded",
                },
              ],
            },
          ]}
        />
      </section>
      <section>
        <Title order={3} size="h5">
          Related context
        </Title>
        <RecordDetailsGrid
          sections={[
            {
              items: [
                {
                  label: "Trading account",
                  value:
                    event.tradingAccount?.displayName ??
                    (event.tradingAccountId
                      ? `Account ${event.tradingAccountId}`
                      : "SYSTEM"),
                },
                {
                  label: "Entity type",
                  value: event.entityType
                    ? formatStatusLabel(event.entityType)
                    : "Not linked",
                },
                { label: "Entity", value: event.entityId ?? "Not linked" },
              ],
            },
          ]}
        />
      </section>
      <Accordion variant="contained">
        <Accordion.Item value="raw">
          <Accordion.Control>Raw diagnostics</Accordion.Control>
          <Accordion.Panel>
            <RecordDetailsGrid
              sections={[
                {
                  items: [
                    {
                      label: "System event ID",
                      value: event.id,
                      technical: true,
                    },
                    {
                      label: "Raw event type",
                      value: event.type,
                      technical: true,
                    },
                    {
                      label: "Trading account ID",
                      value: event.tradingAccountId,
                      technical: true,
                    },
                    {
                      label: "Entity ID",
                      value: event.entityId,
                      technical: true,
                    },
                    {
                      label: "Event payload",
                      value: rawPayload(event),
                      technical: true,
                    },
                  ],
                },
              ]}
            />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

export function SystemEventsPage() {
  const accountScope = useTradingAccountScope();
  const [token] = useState(() => getAdminToken());
  const [limit, setLimit] = useState(100);
  const [type, setType] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<SystemEvent | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const query = useSystemEvents(
    token,
    accountScope.isAll ? "all" : (accountScope.selectedAccount?.id ?? "all"),
    limit,
  );
  const events = useMemo(() => query.data ?? [], [query.data]);
  const types = useMemo(
    () => [...new Set(events.map((event) => event.type))].sort(),
    [events],
  );
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (type === "all" || event.type === type) &&
          (!search.trim() ||
            [
              event.type,
              event.entityType,
              event.entityId,
              event.tradingAccount?.displayName,
              describeEvent(event).description,
            ].some((value) =>
              value?.toLowerCase().includes(search.trim().toLowerCase()),
            )),
      ),
    [events, search, type],
  );
  const clear = () => {
    setSearch("");
    setType("all");
    setLimit(100);
  };
  const active = [
    {
      key: "type",
      active: type !== "all",
      label: `Event: ${eventTitle(type)}`,
      remove: () => setType("all"),
    },
    {
      key: "limit",
      active: limit !== 100,
      label: `Last ${limit}`,
      remove: () => setLimit(100),
    },
  ]
    .filter((item) => item.active)
    .map((item) => ({
      key: item.key,
      label: item.label,
      onRemove: item.remove,
    }));
  const identity = (event: SystemEvent) => (
    <div>
      <Text component="h3" fw={800}>
        {eventTitle(event.type)}
      </Text>
      <Text size="xs" c="dimmed">
        {event.type}
        {accountScope.isAll
          ? ` · ${event.tradingAccount?.displayName ?? "SYSTEM"}${event.tradingAccount?.environment ? ` · ${event.tradingAccount.environment}` : ""}`
          : ""}
      </Text>
    </div>
  );
  const fields = (event: SystemEvent): SummaryField[] => [
    {
      label: "Summary",
      value: describeEvent(event).description || "No summary provided",
    },
    {
      label: "Context",
      value: event.entityType
        ? `${formatStatusLabel(event.entityType)} · ${event.entityId ?? "unlinked"}`
        : "System event",
    },
    ...(accountScope.isAll
      ? [
          {
            label: "Account",
            value: (
              <TradingAccountBadge
                account={event.tradingAccount}
                tradingAccountId={event.tradingAccountId}
                emptyLabel="SYSTEM"
              />
            ),
          },
        ]
      : []),
  ];
  const open = (event: SystemEvent, element: HTMLElement) => {
    setSelected(event);
    setOpener(element);
  };
  const wide = (items: readonly SystemEvent[]) => (
    <DataTable caption="System event stream" captionHidden density="compact">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Event</Table.Th>
          <Table.Th>State</Table.Th>
          <Table.Th>Summary / context</Table.Th>
          <Table.Th>Account</Table.Th>
          <Table.Th>Timestamp</Table.Th>
          <Table.Th>Actions</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((event) => (
          <Fragment key={event.id}>
            <Table.Tr>
              <Table.Td>{identity(event)}</Table.Td>
              <Table.Td>
                <StatusBadge
                  status={event.processed ? "processed" : "recorded"}
                  label={event.processed ? "Processed" : "Recorded"}
                  tone={eventTone(event)}
                  size="compact"
                />
              </Table.Td>
              <Table.Td className={classes.message}>
                <Text size="sm">
                  {describeEvent(event).description || "No summary provided"}
                </Text>
                <Text size="xs" c="dimmed" mt={2}>
                  {event.entityType
                    ? `${formatStatusLabel(event.entityType)} · ${event.entityId ?? "unlinked"}`
                    : "System event"}
                </Text>
              </Table.Td>
              <Table.Td>
                <TradingAccountBadge
                  account={event.tradingAccount}
                  tradingAccountId={event.tradingAccountId}
                  emptyLabel="SYSTEM"
                />
              </Table.Td>
              <Table.Td>{formatDate(event.createdAt)}</Table.Td>
              <Table.Td>
                <Button
                  variant="default"
                  size="compact-sm"
                  aria-expanded={expanded === event.id}
                  onClick={() =>
                    setExpanded(expanded === event.id ? null : event.id)
                  }
                >
                  Details
                </Button>
              </Table.Td>
            </Table.Tr>
            {expanded === event.id && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Details event={event} />
                </Table.Td>
              </Table.Tr>
            )}
          </Fragment>
        ))}
      </Table.Tbody>
    </DataTable>
  );
  return (
    <main className={classes.page}>
      <Stack gap="lg">
        <Group
          justify="space-between"
          align="flex-end"
          className={classes.header}
        >
          <div>
            <Title order={2} size="h3">
              System Events
            </Title>
            <Text size="sm" c="dimmed">
              Diagnostic stream of significant state transitions and linked
              operational records.
            </Text>
          </div>
          <Group>
            <TradingAccountScopeSelector
              mode="ACCOUNT_FILTERABLE"
              expanded
              variant="dashboard"
            />
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              Refresh
            </Button>
          </Group>
        </Group>
        <Card withBorder radius="md" p="md">
          <Stack gap="md">
            <ResponsiveFilterToolbar
              primary={
                <TextInput
                  aria-label="Search system events"
                  placeholder="Search events or context"
                  leftSection={<IconSearch size={16} />}
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                />
              }
              secondary={
                <>
                  <Select
                    label="Event type"
                    value={type}
                    onChange={(value) => setType(value ?? "all")}
                    data={[
                      { value: "all", label: "All event types" },
                      ...types.map((value) => ({
                        value,
                        label: eventTitle(value),
                      })),
                    ]}
                  />
                  <NumberInput
                    label="Result limit"
                    min={1}
                    max={500}
                    value={limit}
                    onChange={(value) =>
                      typeof value === "number" && setLimit(value)
                    }
                  />
                </>
              }
              activeFilters={active}
              onClearAll={clear}
            />
            {query.isLoading ? (
              <DataState state="loading" message="Loading system events…" />
            ) : query.isError ? (
              <DataState
                state="error"
                title="Unable to load system events"
                message={
                  query.error instanceof Error ? query.error.message : undefined
                }
                onRetry={() => void query.refetch()}
              />
            ) : filtered.length === 0 ? (
              <DataState
                state="empty"
                title={
                  events.length ? "No matching events" : "No system events"
                }
                message={
                  events.length
                    ? "Clear or change the current filters."
                    : "No significant state transitions have been recorded."
                }
                action={
                  events.length
                    ? { label: "Clear filters", onClick: clear }
                    : undefined
                }
              />
            ) : (
              <ResponsiveDataView
                records={filtered}
                getRecordId={(event) => event.id}
                wide={wide}
                compact={(items) => (
                  <CompactRecordList
                    records={items}
                    getRecordId={(event) => event.id}
                    renderIdentity={identity}
                    renderFields={fields}
                    renderDetails={(event) => <Details event={event} />}
                    expandedId={expanded}
                    onExpandedChange={(id) => setExpanded(id as number | null)}
                  />
                )}
                narrow={(items) => (
                  <MobileRecordCard
                    records={items}
                    getRecordId={(event) => event.id}
                    renderIdentity={identity}
                    renderStatus={(event) => (
                      <StatusBadge
                        status={event.processed ? "processed" : "recorded"}
                        label={event.processed ? "Processed" : "Recorded"}
                        tone={eventTone(event)}
                        size="compact"
                      />
                    )}
                    renderFields={fields}
                    onDetails={open}
                  />
                )}
                aria-label="System event stream"
              />
            )}
          </Stack>
        </Card>
      </Stack>
      <ResponsiveDetails
        opened={Boolean(selected)}
        title={selected ? eventTitle(selected.type) : "System event"}
        onClose={() => setSelected(null)}
        returnFocusTo={opener}
      >
        {selected && <Details event={selected} />}
      </ResponsiveDetails>
    </main>
  );
}
