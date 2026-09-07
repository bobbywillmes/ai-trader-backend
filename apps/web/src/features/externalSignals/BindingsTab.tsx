import { useState } from "react";
import { Button, Card, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useSearchParams } from "react-router-dom";
import { IconPlus, IconRefresh } from "@tabler/icons-react";
import { DataState, RecordDetailsGrid, ResponsiveDetails } from "../../components/data-display";
import { useBindingMutations, useExternalDetail, useExternalList, useCatalogs } from "./hooks";
import { changeExternalParams, clearExternalFilters, readExternalParams } from "./url";
import { CopyValue, EnabledBadge, ListFooter, Records, ShortValue, StrategyLink } from "./components";
import { stamp } from "./presentation";
import { BindingEditor } from "./BindingEditor";
import { Filters } from "./Filters";
import type { Binding, CreateBinding, UpdateBinding } from "./types";

export function BindingsTab({ token }: { token: string | null }) {
  const [params, setParams] = useSearchParams();
  const state = readExternalParams(params);
  const change = (values: Record<string, string | null>, reset = true) => setParams(current => changeExternalParams(current, values, reset));
  const list = useExternalList("bindings", state.query.toString(), token);
  const detail = useExternalDetail("bindings", state.detail, token);
  const catalogs = useCatalogs(token);
  const [editor, setEditor] = useState<{ binding: Binding | null } | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutations = useBindingMutations(token);
  async function save(input: CreateBinding | UpdateBinding) {
    setError(null);
    try {
      if (editor?.binding) await mutations.update.mutateAsync({ id: editor.binding.id, input });
      else await mutations.create.mutateAsync(input as CreateBinding);
      setEditor(null); notifications.show({ color: "teal", message: "Strategy binding saved." });
    } catch { const message = "Unable to save binding. Check the source/key is unique and try again."; setError(message); notifications.show({ color: "red", message }); }
  }
  const binding = detail.data;
  return <>
    <Card withBorder radius="md"><Stack>
      <Group justify="space-between"><Text size="sm" c="dimmed">Authoritative strategy mappings and the revisions accepted next.</Text><Group gap="xs"><Button variant="default" leftSection={<IconRefresh size={16} />} loading={list.isFetching} onClick={() => void list.refetch()}>Refresh</Button><Button leftSection={<IconPlus size={16} />} onClick={() => { setError(null); setEditor({ binding: null }); }}>Create binding</Button></Group></Group>
      <Filters key={state.query.toString()} section="bindings" query={state.query} token={token} apply={change} clear={() => setParams(clearExternalFilters)} />
      {list.isPending ? <DataState state="loading" message="Loading strategy bindings…" /> : list.isError ? <DataState state="error" title="Unable to load strategy bindings" onRetry={() => void list.refetch()} /> : !list.data.bindings.length ? <DataState state="empty" title="No strategy bindings found" message="Create a mapping or adjust your filters." /> : <Records title="Strategy bindings" records={list.data.bindings} identity={item => <Text fw={600} style={{ overflowWrap: "anywhere" }}>{item.externalStrategyKey}</Text>} status={item => <EnabledBadge enabled={item.enabled} />} open={(id, element) => { setOpener(element); change({ detail: String(id) }, false); }} columns={[
        { label: "Source", value: item => <ShortValue value={catalogs.sourceName(item.signalSourceId)} /> },
        { label: "External key", value: item => <ShortValue value={item.externalStrategyKey} /> },
        { label: "Strategy", value: item => <StrategyLink id={item.strategyId} name={catalogs.strategyName(item.strategyId)} /> },
        { label: "Expected revision", value: item => <ShortValue value={item.expectedRevision} /> },
        { label: "Status", value: item => <EnabledBadge enabled={item.enabled} /> },
        { label: "Created", value: item => stamp(item.createdAt) }, { label: "Updated", value: item => stamp(item.updatedAt) },
      ]} />}
      {list.data && <ListFooter pagination={list.data.pagination} page={state.page} pageSize={state.pageSize} change={change} />}
    </Stack></Card>
    <ResponsiveDetails opened={Boolean(state.detail)} onClose={() => change({ detail: null }, false)} title={`Strategy binding #${state.detail}`} returnFocusTo={opener}>
      {detail.isPending ? <DataState state="loading" /> : detail.isError ? <DataState state="error" title="Unable to load binding" onRetry={() => void detail.refetch()} /> : binding && <Stack>
        <EnabledBadge enabled={binding.enabled} />
        <RecordDetailsGrid sections={[{ items: [{ label: "Source", value: catalogs.sourceName(binding.signalSourceId) }, { label: "Strategy", value: <StrategyLink id={binding.strategyId} name={catalogs.strategyName(binding.strategyId)} /> }, { label: "External strategy key", value: <CopyValue value={binding.externalStrategyKey} name="external key" /> }, { label: "Expected revision", value: binding.expectedRevision }, { label: "Created", value: stamp(binding.createdAt) }, { label: "Updated", value: stamp(binding.updatedAt) }] }]} />
        <Text size="sm" c="dimmed">Source, Strategy, and external key form a fixed identity. Revision and enabled status apply prospectively.</Text>
        <Button variant="light" onClick={() => { setError(null); setEditor({ binding }); }}>Edit binding</Button>
      </Stack>}
    </ResponsiveDetails>
    {editor && <BindingEditor binding={editor.binding} token={token} pending={mutations.create.isPending || mutations.update.isPending} error={error} submit={input => void save(input)} close={() => setEditor(null)} />}
  </>;
}
