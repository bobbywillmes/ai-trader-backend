import { useState } from "react";
import { Button, Card, Group, Stack, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";
import { DataState, ResponsiveDetails } from "../../components/data-display";
import { changeExternalParams, clearExternalFilters, readExternalParams } from "./url";
import { useExternalDetail, useExternalList, useCatalogs } from "./hooks";
import { EvidenceBadge, ListFooter, Records, ShortValue, StrategyLink } from "./components";
import { stamp } from "./presentation";
import { Filters } from "./Filters";
import { DeliveryDetails, SignalDetails } from "./EvidenceDetails";
import type { Delivery, Signal } from "./types";

export function EvidenceTab({ section, token }: { section: "signals" | "deliveries"; token: string | null }) {
  const [params, setParams] = useSearchParams();
  const state = readExternalParams(params);
  const change = (values: Record<string, string | null>, reset = true) => setParams(current => changeExternalParams(current, values, reset));
  const list = useExternalList(section, state.query.toString(), token);
  const detail = useExternalDetail(section, state.detail, token);
  const catalogs = useCatalogs(token);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const open = (id: number, element: HTMLElement) => { setOpener(element); change({ detail: String(id) }, false); };
  const records = list.data?.[section] ?? [];
  return <>
    <Card withBorder radius="md"><Stack>
      <Group justify="space-between"><Text size="sm" c="dimmed">{section === "signals" ? "Recognized strategy events, independent of accounts and execution." : "Terminal delivery history, including retries and validation rejections."}</Text><Button variant="default" leftSection={<IconRefresh size={16} />} loading={list.isFetching} onClick={() => void list.refetch()}>Refresh</Button></Group>
      <Filters key={state.query.toString()} section={section} query={state.query} token={token} apply={change} clear={() => setParams(clearExternalFilters)} />
      {list.isPending ? <DataState state="loading" message={`Loading ${section}…`} /> : list.isError ? <DataState state="error" title={`Unable to load ${section}`} onRetry={() => void list.refetch()} /> : !records.length ? <DataState state="empty" title={`No ${section} found`} message={`No ${section} match this view. Adjust filters or wait for a new delivery.`} /> : section === "signals" ?
        <Records title="Signals" records={records as Signal[]} open={open} identity={item => <Group gap="xs"><Text fw={700}>{item.symbol}</Text><Text size="sm">{item.timeframe}</Text></Group>} status={item => <EvidenceBadge value={item.event} />} columns={[
          { label: "Signal time", value: item => stamp(item.signalTime) }, { label: "Symbol / event", value: item => <Stack gap={4}><Text fw={600}>{item.symbol}</Text><EvidenceBadge value={item.event} /></Stack> },
          { label: "Strategy", value: item => <StrategyLink id={item.strategyId} name={catalogs.strategyName(item.strategyId)} /> },
          { label: "Source", value: item => <ShortValue value={catalogs.sourceName(item.signalSourceId)} /> },
          { label: "Timeframe / revision", value: item => <Stack gap={2}><Text size="sm">{item.timeframe}</Text><ShortValue value={item.strategyRevision !== null ? `Revision ${item.strategyRevision}` : `Legacy: ${item.legacyStrategyRevision}`} /></Stack> }, { label: "Created", value: item => stamp(item.createdAt) },
        ]} /> :
        <Records title="Deliveries" records={records as Delivery[]} open={open} identity={item => <Text fw={700}>Delivery #{item.id}</Text>} status={item => <EvidenceBadge value={item.status} />} columns={[
          { label: "Received", value: item => stamp(item.receivedAt) }, { label: "Source", value: item => <ShortValue value={catalogs.sourceName(item.signalSourceId)} /> },
          { label: "Status", value: item => <EvidenceBadge value={item.status} /> }, { label: "Rejection", value: item => <Text size="xs" c={item.rejectionCode ? "orange" : "dimmed"}>{item.rejectionCode ?? "None"}</Text> },
          { label: "Request ID", value: item => <ShortValue value={item.requestId} /> },
          { label: "Signal", value: item => item.signalId ? <Button variant="subtle" size="compact-xs" onClick={() => change({ section: "signals", detail: String(item.signalId) })}>#{item.signalId}</Button> : <Text size="sm" c="dimmed">Not normalized</Text> },
          { label: "Processed", value: item => stamp(item.processedAt) },
        ]} />}
      {list.data && <ListFooter pagination={list.data.pagination} page={state.page} pageSize={state.pageSize} change={change} />}
    </Stack></Card>
    <ResponsiveDetails opened={Boolean(state.detail)} onClose={() => change({ detail: null }, false)} title={`${section === "signals" ? "Signal" : "Delivery"} #${state.detail}`} returnFocusTo={opener}>
      {detail.isPending ? <DataState state="loading" /> : detail.isError ? <DataState state="error" title={`Unable to load ${section === "signals" ? "Signal" : "Delivery"}`} onRetry={() => void detail.refetch()} /> : detail.data ? section === "signals" ? <SignalDetails signal={detail.data as Signal} token={token} navigate={change} /> : <DeliveryDetails delivery={detail.data as Delivery} token={token} navigate={change} /> : <DataState state="empty" title="Record not found" />}
    </ResponsiveDetails>
  </>;
}
