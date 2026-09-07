import { useState } from "react";
import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { DataState } from "../../components/data-display";
import { useCatalogs } from "./hooks";
import type { Binding, CreateBinding, UpdateBinding } from "./types";
import { isValidNewStrategyKey, normalizeNewStrategyKey } from "./strategyKey";

export function BindingEditor({ binding, token, pending, error, submit, close }: {
  binding: Binding | null; token: string | null; pending: boolean; error: string | null;
  submit: (input: CreateBinding | UpdateBinding) => void; close: () => void;
}) {
  const catalogs = useCatalogs(token);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [strategyId, setStrategyId] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [revision, setRevision] = useState(binding?.expectedRevision ?? "");
  const [enabled, setEnabled] = useState(binding?.enabled ?? true);
  const [acknowledged, setAcknowledged] = useState(false);
  const changed = !binding || revision.trim() !== binding.expectedRevision || enabled !== binding.enabled;
  const catalogReady = Boolean(catalogs.sources.data && catalogs.strategies.data && !catalogs.sources.isError && !catalogs.strategies.isError);
  const normalizedKey = normalizeNewStrategyKey(key);
  const validKey = isValidNewStrategyKey(normalizedKey);
  const valid = revision.trim() && changed && (binding ? acknowledged : sourceId && strategyId && validKey && catalogReady);
  return <Modal opened onClose={() => !pending && close()} title={binding ? "Edit strategy binding" : "Create strategy binding"} centered size="lg" closeOnClickOutside={!pending} closeOnEscape={!pending} withCloseButton={!pending}>
    <form onSubmit={event => {
      event.preventDefault(); if (!valid) return;
      const mutable = { expectedRevision: revision.trim(), enabled };
      submit(binding ? mutable : { ...mutable, signalSourceId: Number(sourceId), strategyId: Number(strategyId), externalStrategyKey: normalizedKey });
    }}><Stack>
      {binding ? <Alert color="blue"><Text size="sm">{catalogs.sourceName(binding.signalSourceId)} → {catalogs.strategyName(binding.strategyId)}</Text><Text size="sm" style={{ overflowWrap: "anywhere" }}>{binding.externalStrategyKey}</Text><Text size="xs" mt="xs">Source, Strategy, and external key are fixed for this binding.</Text></Alert> : <>
        {catalogs.sources.isPending || catalogs.strategies.isPending ? <DataState state="loading" message="Loading source and Strategy choices…" /> : !catalogReady ? <DataState state="error" title="Unable to load configuration choices" onRetry={() => { void catalogs.sources.refetch(); void catalogs.strategies.refetch(); }} /> : !catalogs.sources.data?.length || !catalogs.strategies.data?.length ? <Alert color="blue">An existing source and Strategy are required. Create a source first if needed.</Alert> : null}
        <Select label="Source" required searchable value={sourceId} onChange={setSourceId} disabled={pending || !catalogReady} data={(catalogs.sources.data ?? []).map(source => ({ value: String(source.id), label: `${source.name} (#${source.id})${source.enabled ? "" : " · Disabled"}` }))} />
        <Select label="Internal Strategy" required searchable value={strategyId} onChange={setStrategyId} disabled={pending || !catalogReady} data={(catalogs.strategies.data ?? []).map(strategy => ({ value: String(strategy.id), label: `${strategy.name} (#${strategy.id})` }))} />
        <TextInput label="External strategy key" required value={key} maxLength={200} onChange={event => setKey(event.currentTarget.value)} disabled={pending}
          error={key && !validKey ? "Use letters, digits, spaces, hyphens, or underscores; the normalized key must not be empty." : undefined} />
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>Key to create: <Text component="span" fw={600}>{validKey ? normalizedKey : "Enter a valid key"}</Text></Text>
        <Text size="xs" c="dimmed">Lowercase; whitespace becomes hyphens and repeated hyphens collapse. Use this exact normalized key in webhook envelopes.</Text>
      </>}
      <TextInput label="Expected revision" required maxLength={200} value={revision} onChange={event => { setRevision(event.currentTarget.value); setAcknowledged(false); }} disabled={pending} />
      <Text size="sm" c="dimmed">Changing the expected revision affects future signal acceptance. Historical Signals are never rewritten.</Text>
      <Checkbox label="Enable this binding" checked={enabled} onChange={event => { setEnabled(event.currentTarget.checked); setAcknowledged(false); }} disabled={pending} />
      {binding && <Checkbox label="I understand these changes apply to future deliveries." checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} disabled={pending} />}
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <Group justify="flex-end"><Button variant="default" onClick={close} disabled={pending}>Cancel</Button><Button type="submit" loading={pending} disabled={!valid}>{binding ? "Save binding" : "Create binding"}</Button></Group>
    </Stack></form>
  </Modal>;
}
