import { useState } from "react";
import { Alert, Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useSearchParams } from "react-router-dom";
import { IconPlus, IconRefresh } from "@tabler/icons-react";
import { DataState, RecordDetailsGrid, ResponsiveDetails } from "../../components/data-display";
import { useExternalDetail, useExternalList, useSourceMutations } from "./hooks";
import { changeExternalParams, clearExternalFilters, readExternalParams } from "./url";
import { EnabledBadge, ListFooter, Records, ShortValue } from "./components";
import { providerLabels, stamp } from "./presentation";
import { SourceConfirmation, SourceEditor } from "./SourceDialogs";
import { CredentialDialog } from "./CredentialDialog";
import type { CreateSource, Credential, Source, UpdateSource } from "./types";

export function SourcesTab({ token }: { token: string | null }) {
  const [params, setParams] = useSearchParams();
  const state = readExternalParams(params);
  const change = (values: Record<string, string | null>, reset = true) => setParams(current => changeExternalParams(current, values, reset));
  const list = useExternalList("sources", state.query.toString(), token);
  const detail = useExternalDetail("sources", state.detail, token);
  const [editor, setEditor] = useState<{ source: Source | null } | null>(null);
  const [confirmation, setConfirmation] = useState<{ source: Source; action: "rotate" | "toggle" } | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutations = useSourceMutations(token, setCredential);
  const pending = mutations.create.isPending || mutations.update.isPending || mutations.rotate.isPending;
  const source = detail.data;
  function fail() { const message = "The source change could not be saved. Refresh and try again."; setError(message); notifications.show({ color: "red", message }); }
  async function save(input: CreateSource | UpdateSource) {
    setError(null);
    try {
      if (editor?.source) await mutations.update.mutateAsync({ id: editor.source.id, input });
      else await mutations.create.mutateAsync(input as CreateSource);
      setEditor(null); notifications.show({ color: "teal", message: "Source saved." });
    } catch { fail(); }
  }
  async function confirm() {
    if (!confirmation) return; setError(null);
    try {
      if (confirmation.action === "rotate") await mutations.rotate.mutateAsync(confirmation.source.id);
      else await mutations.update.mutateAsync({ id: confirmation.source.id, input: { enabled: !confirmation.source.enabled } });
      setConfirmation(null); notifications.show({ color: "teal", message: confirmation.action === "rotate" ? "Webhook credential rotated." : "Source status updated." });
    } catch { fail(); }
  }
  return <>
    <Card withBorder radius="md"><Stack>
      <Group justify="space-between"><Text size="sm" c="dimmed">Configured origins and their current authentication settings.</Text><Group gap="xs"><Button variant="default" leftSection={<IconRefresh size={16} />} loading={list.isFetching} onClick={() => void list.refetch()}>Refresh</Button><Button leftSection={<IconPlus size={16} />} onClick={() => { setError(null); setEditor({ source: null }); }}>Create source</Button></Group></Group>
      {state.query.has("signalSourceId") && <Group><Text size="sm">Filtered to Source #{state.query.get("signalSourceId")}</Text><Button variant="subtle" size="compact-xs" onClick={() => setParams(clearExternalFilters)}>Clear source filter</Button></Group>}
      {list.isPending ? <DataState state="loading" message="Loading sources…" /> : list.isError ? <DataState state="error" title="Unable to load sources" onRetry={() => void list.refetch()} /> : !list.data.sources.length ? <DataState state="empty" title="No sources yet" message="Create a source to receive external strategy evidence." /> : <Records title="Sources" records={list.data.sources} identity={item => <Text fw={600}>{item.name}</Text>} status={item => <EnabledBadge enabled={item.enabled} />} open={(id, element) => { setOpener(element); change({ detail: String(id) }, false); }} columns={[
        { label: "Name", value: item => <ShortValue value={item.name} /> }, { label: "Provider", value: item => <Badge variant="light" color="gray">{providerLabels[item.provider]}</Badge> },
        { label: "Status", value: item => <EnabledBadge enabled={item.enabled} /> }, { label: "Authentication", value: () => "URL token" },
        { label: "Created", value: item => stamp(item.createdAt) }, { label: "Updated", value: item => stamp(item.updatedAt) },
      ]} />}
      {list.data && <ListFooter pagination={list.data.pagination} page={state.page} pageSize={state.pageSize} change={change} />}
    </Stack></Card>
    <ResponsiveDetails opened={Boolean(state.detail)} onClose={() => change({ detail: null }, false)} title={`Source #${state.detail}`} returnFocusTo={opener}>
      {detail.isPending ? <DataState state="loading" /> : detail.isError ? <DataState state="error" title="Unable to load source" onRetry={() => void detail.refetch()} /> : source && <Stack>
        <Group><Text fw={700}>{source.name}</Text><EnabledBadge enabled={source.enabled} /></Group>
        <RecordDetailsGrid sections={[{ items: [{ label: "ID", value: source.id }, { label: "Provider", value: providerLabels[source.provider] }, { label: "Authentication", value: "URL token" }, { label: "Created", value: stamp(source.createdAt) }, { label: "Updated", value: stamp(source.updatedAt) }] }]} />
        <Alert color="blue">The current token cannot be retrieved. Rotate it if a replacement is needed.</Alert>
        <Group><Button variant="default" onClick={() => { setError(null); setEditor({ source }); }}>Rename source</Button><Button variant="light" color={source.enabled ? "orange" : "teal"} onClick={() => { setError(null); setConfirmation({ source, action: "toggle" }); }}>{source.enabled ? "Disable source" : "Enable source"}</Button><Button variant="default" onClick={() => { setError(null); setConfirmation({ source, action: "rotate" }); }}>Rotate webhook token</Button></Group>
        <Button variant="subtle" onClick={() => change({ section: "bindings", signalSourceId: String(source.id), detail: null })}>View strategy bindings</Button>
      </Stack>}
    </ResponsiveDetails>
    {editor && <SourceEditor source={editor.source} pending={pending} error={error} submit={input => void save(input)} close={() => setEditor(null)} />}
    {confirmation && <SourceConfirmation {...confirmation} pending={pending} error={error} confirm={() => void confirm()} close={() => setConfirmation(null)} />}
    {credential && <CredentialDialog credential={credential} onClose={() => { setCredential(null); mutations.create.reset(); mutations.rotate.reset(); }} />}
  </>;
}
