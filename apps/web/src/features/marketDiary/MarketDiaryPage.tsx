import { Fragment, useMemo, useState } from "react";
import { Accordion, Badge, Button, Card, Group, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { IconRefresh, IconSearch } from "@tabler/icons-react";
import { CompactRecordList, DataState, DataTable, MobileRecordCard, RecordDetailsGrid, ResponsiveDataView, ResponsiveDetails, ResponsiveFilterToolbar, StatusBadge, formatStatusLabel, type SummaryField } from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { useCurrentMarketState, useMarketDiaryEvents } from "./hooks";
import type { CurrentMarketState, MarketDiaryEvent } from "./types";
import classes from "./MarketDiaryPage.module.css";

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString() : "Not available";
const optional = (value: string | null | undefined) => value?.trim() || "Not recorded";
const tone = (value: string) => value.toLowerCase().includes("risk") || value.toLowerCase().includes("avoid") ? "danger" as const : value.toLowerCase().includes("caut") || value.toLowerCase().includes("warn") ? "warning" as const : "informational" as const;

function EventDetails({ event }: { event: MarketDiaryEvent }) {
  return <Stack gap="md">
    <section><Title order={3} size="h5">Diary entry</Title><RecordDetailsGrid sections={[{ items: [{ label: "Event", value: formatStatusLabel(event.eventType) }, { label: "Recorded", value: formatDate(event.createdAt) }, { label: "Source", value: event.source }, { label: "Symbol", value: event.symbol ?? "Market-wide" }, { label: "Summary", value: event.summary }, { label: "Detailed notes", value: optional(event.details) }] }]} /></section>
    <Accordion variant="contained"><Accordion.Item value="diagnostics"><Accordion.Control>Routing &amp; raw diagnostics</Accordion.Control><Accordion.Panel><RecordDetailsGrid sections={[{ items: [{ label: "Diary ID", value: event.id, technical: true }, { label: "Raw event type", value: event.eventType, technical: true }, { label: "Symbols", value: JSON.stringify(event.symbolsJson ?? null, null, 2), technical: true }, { label: "Payload", value: JSON.stringify(event.payloadJson ?? null, null, 2), technical: true }] }]} /></Accordion.Panel></Accordion.Item></Accordion>
  </Stack>;
}

function CurrentState({ state }: { state: CurrentMarketState }) {
  return <Stack gap="md">
    <div className={classes.stateHero}>
      <div><Text size="xs" fw={700} c="dimmed" tt="uppercase">Market posture</Text><Group gap="xs" mt={6} wrap="wrap"><StatusBadge status={state.marketBias} label={formatStatusLabel(state.marketBias)} tone={tone(state.marketBias)} /><StatusBadge status={state.riskMode} label={formatStatusLabel(state.riskMode)} tone={tone(state.riskMode)} /></Group></div>
      <div className={classes.stateTiming}><Text size="xs" fw={700} c="dimmed" tt="uppercase">Assessment timing</Text><Text size="sm" fw={600}>{formatDate(state.lastLlmRunAt)}</Text><Text size="xs" c="dimmed">Valid until {formatDate(state.validUntil)}</Text></div>
    </div>
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
      <Card withBorder radius="md" p="md" className={classes.assessmentPrimary}><Text size="xs" fw={700} c="dimmed" tt="uppercase">Macro summary</Text><Text mt="xs" className={classes.longText}>{optional(state.macroSummary)}</Text></Card>
      <Card withBorder radius="md" p="md"><Stack gap="md"><div><Text size="xs" fw={700} c="dimmed" tt="uppercase">Watch for</Text><Text size="sm" mt={4} className={classes.longText}>{optional(state.watchFor)}</Text></div><div><Text size="xs" fw={700} c="dimmed" tt="uppercase">Avoid because</Text><Text size="sm" mt={4} className={classes.longText}>{optional(state.avoidBecause)}</Text></div></Stack></Card>
    </SimpleGrid>
    {state.notes && <Card withBorder radius="md" p="md"><Text size="xs" fw={700} c="dimmed" tt="uppercase">Notes</Text><Text size="sm" mt={4} className={classes.longText}>{state.notes}</Text></Card>}
    <Group gap="lg" className={classes.stateMeta}><Text size="xs" c="dimmed">Source: <Text span inherit c="inherit" fw={600}>{state.source}</Text></Text><Text size="xs" c="dimmed">Updated: <Text span inherit c="inherit" fw={600}>{formatDate(state.updatedAt)}</Text></Text></Group>
    <Accordion variant="contained"><Accordion.Item value="raw"><Accordion.Control>Routing &amp; raw diagnostics</Accordion.Control><Accordion.Panel><RecordDetailsGrid sections={[{ items: [{ label: "Market-state ID", value: state.id, technical: true }, { label: "Payload", value: JSON.stringify(state.payloadJson ?? null, null, 2), technical: true }] }]} /></Accordion.Panel></Accordion.Item></Accordion>
  </Stack>;
}

export function MarketDiaryPage() {
  const [token] = useState(() => getAdminToken());
  const [search, setSearch] = useState(""); const [eventType, setEventType] = useState("all");
  const [expandedId, setExpandedId] = useState<number | null>(null); const [selected, setSelected] = useState<MarketDiaryEvent | null>(null); const [opener, setOpener] = useState<HTMLElement | null>(null);
  const marketStateQuery = useCurrentMarketState(token); const diaryQuery = useMarketDiaryEvents(token); const events = useMemo(() => diaryQuery.data ?? [], [diaryQuery.data]);
  const types = useMemo(() => [...new Set(events.map((event) => event.eventType))].sort(), [events]);
  const filtered = useMemo(() => events.filter((event) => (eventType === "all" || event.eventType === eventType) && (!search.trim() || [event.summary, event.details, event.symbol, event.source, event.eventType].some((value) => value?.toLowerCase().includes(search.trim().toLowerCase())))), [eventType, events, search]);
  const active = eventType === "all" ? [] : [{ key: "type", label: `Event: ${formatStatusLabel(eventType)}`, onRemove: () => setEventType("all") }];
  const open = (event: MarketDiaryEvent, element: HTMLElement) => { setSelected(event); setOpener(element); };
  const identity = (event: MarketDiaryEvent) => <div><Text component="h3" fw={800}>{event.symbol ?? formatStatusLabel(event.eventType)}</Text><Text size="xs" c="dimmed">{formatDate(event.createdAt)} · {event.source}</Text></div>;
  const fields = (event: MarketDiaryEvent): SummaryField[] => [{ label: "Observation", value: event.summary }, { label: "Event", value: formatStatusLabel(event.eventType) }, { label: "Notes", value: optional(event.details) }];
  const wide = (items: readonly MarketDiaryEvent[]) => <DataTable caption="Market diary entries" captionHidden density="compact"><Table.Thead><Table.Tr><Table.Th>Session record</Table.Th><Table.Th>Event</Table.Th><Table.Th>Observation</Table.Th><Table.Th>Source</Table.Th><Table.Th>Recorded</Table.Th><Table.Th>Actions</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{items.map((event) => <Fragment key={event.id}><Table.Tr><Table.Td>{identity(event)}</Table.Td><Table.Td><StatusBadge status={event.eventType} label={formatStatusLabel(event.eventType)} tone={tone(event.eventType)} size="compact" /></Table.Td><Table.Td className={classes.summary}>{event.summary}</Table.Td><Table.Td>{event.source}</Table.Td><Table.Td>{formatDate(event.createdAt)}</Table.Td><Table.Td><Button variant="default" size="compact-sm" aria-expanded={expandedId === event.id} onClick={() => setExpandedId(expandedId === event.id ? null : event.id)}>Details</Button></Table.Td></Table.Tr>{expandedId === event.id && <Table.Tr><Table.Td colSpan={6}><EventDetails event={event} /></Table.Td></Table.Tr>}</Fragment>)}</Table.Tbody></DataTable>;
  const clear = () => { setSearch(""); setEventType("all"); };
  return <main className={classes.page}><Stack gap="lg">
    <Group justify="space-between" align="flex-end" className={classes.header}><div><Title order={1} size="h2">Market Diary</Title><Text c="dimmed" size="sm">Chronological market context and observations used by n8n workflows.</Text></div><Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { void marketStateQuery.refetch(); void diaryQuery.refetch(); }} loading={marketStateQuery.isFetching || diaryQuery.isFetching}>Refresh</Button></Group>
    <Card withBorder radius="lg" p="lg"><Stack gap="md"><div><Title order={2} size="h4">Current market state</Title><Text c="dimmed" size="sm">Backend source of truth for the active market context.</Text></div>{marketStateQuery.isLoading ? <DataState state="loading" message="Loading market state…" /> : marketStateQuery.isError ? <DataState state="error" title="Unable to load market state" onRetry={() => void marketStateQuery.refetch()} /> : !marketStateQuery.data ? <DataState state="empty" title="No market state" message="No current market-state record is available." /> : <CurrentState state={marketStateQuery.data} />}</Stack></Card>
    <Card withBorder radius="lg" p="lg"><Stack gap="md"><div><Title order={2} size="h4">Recent diary entries</Title><Text c="dimmed" size="sm">Newest observations first · up to 25 records from the diary endpoint.</Text></div><ResponsiveFilterToolbar primary={<TextInput aria-label="Search diary" placeholder="Search observations" leftSection={<IconSearch size={16} />} value={search} onChange={(event) => setSearch(event.currentTarget.value)} />} secondary={<Select label="Event type" value={eventType} onChange={(value) => setEventType(value ?? "all")} data={[{ value: "all", label: "All event types" }, ...types.map((value) => ({ value, label: formatStatusLabel(value) }))]} />} activeFilters={active} onClearAll={clear} />
    {diaryQuery.isLoading ? <DataState state="loading" message="Loading diary entries…" /> : diaryQuery.isError ? <DataState state="error" title="Unable to load diary entries" onRetry={() => void diaryQuery.refetch()} /> : filtered.length === 0 ? <DataState state="empty" title={events.length ? "No matching diary entries" : "No diary entries"} message={events.length ? "Clear or change the current filters." : "No diary observations have been recorded yet."} action={events.length ? { label: "Clear filters", onClick: clear } : undefined} /> : <ResponsiveDataView records={filtered} getRecordId={(event) => event.id} wide={wide} compact={(items) => <CompactRecordList records={items} getRecordId={(event) => event.id} renderIdentity={identity} renderFields={fields} renderDetails={(event) => <EventDetails event={event} />} expandedId={expandedId} onExpandedChange={(id) => setExpandedId(id as number | null)} />} narrow={(items) => <MobileRecordCard records={items} getRecordId={(event) => event.id} renderIdentity={identity} renderStatus={(event) => <Badge variant="light">{formatStatusLabel(event.eventType)}</Badge>} renderFields={fields} onDetails={open} />} aria-label="Market diary entries" />}</Stack></Card>
  </Stack><ResponsiveDetails opened={Boolean(selected)} title={selected ? `${selected.symbol ?? formatStatusLabel(selected.eventType)} diary entry` : "Diary entry"} onClose={() => setSelected(null)} returnFocusTo={opener}>{selected && <EventDetails event={selected} />}</ResponsiveDetails></main>;
}
