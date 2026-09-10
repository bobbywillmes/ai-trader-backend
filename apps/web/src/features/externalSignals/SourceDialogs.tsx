import { useState } from "react";
import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { providerLabels } from "./presentation";
import { providers, type CreateSource, type Source, type UpdateSource } from "./types";

export function SourceEditor({ source, pending, error, submit, close }: {
  source: Source | null; pending: boolean; error: string | null;
  submit: (input: CreateSource | UpdateSource) => void; close: () => void;
}) {
  const [name, setName] = useState(source?.name ?? "");
  const [provider, setProvider] = useState<CreateSource["provider"]>("GENERIC_WEBHOOK");
  const [enabled, setEnabled] = useState(true);
  return <Modal opened onClose={() => !pending && close()} title={source ? "Rename source" : "Create source"} centered closeOnClickOutside={!pending} closeOnEscape={!pending} withCloseButton={!pending}>
    <form onSubmit={event => { event.preventDefault(); if (name.trim()) submit(source ? { name: name.trim() } : { name: name.trim(), provider, enabled }); }}>
      <Stack>
        <TextInput label="Source name" required maxLength={200} value={name} onChange={event => setName(event.currentTarget.value)} data-autofocus disabled={pending} />
        {!source && <><Select label="Provider" required value={provider} data={providers.map(value => ({ value, label: providerLabels[value] }))} onChange={value => value && setProvider(value as CreateSource["provider"])} disabled={pending} />
          <Text size="xs" c="dimmed">All providers use the same canonical envelope. This does not configure a provider adapter.</Text>
          <Checkbox label="Enable this source" checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} disabled={pending} />
          <Text size="sm">Your stable webhook URL will remain available in source detail.</Text></>}
        {error && <Alert color="red" role="alert">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={close} disabled={pending}>Cancel</Button><Button type="submit" loading={pending} disabled={!name.trim() || (source !== null && name.trim() === source.name)}>{source ? "Save name" : "Create source"}</Button></Group>
      </Stack>
    </form>
  </Modal>;
}
export function SourceConfirmation({ source, action, pending, error, confirm, close }: { source: Source; action: "regenerate" | "toggle"; pending: boolean; error: string | null; confirm: () => void; close: () => void }) {
  const title = action === "regenerate" ? "Regenerate webhook URL?" : `${source.enabled ? "Disable" : "Enable"} source?`;
  return <Modal opened onClose={() => !pending && close()} title={title} centered closeOnClickOutside={!pending} closeOnEscape={!pending} withCloseButton={!pending}><Stack>
    <Text fw={600}>{source.name}</Text>
    <Text size="sm">{action === "regenerate" ? "Regenerating this URL immediately invalidates the current webhook URL. Every external alert using the old URL must be updated. This should normally be done only if the URL has been compromised or must be invalidated." : source.enabled ? "New deliveries from this source will be rejected. Existing Signals and Deliveries remain unchanged." : "Future valid events from enabled bindings can be recorded. This grants no trading authority."}</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Group justify="flex-end"><Button variant="default" onClick={close} disabled={pending}>Cancel</Button><Button color={action === "regenerate" || source.enabled ? "orange" : "teal"} onClick={confirm} loading={pending}>{action === "regenerate" ? "Regenerate URL" : `Confirm ${source.enabled ? "disable" : "enable"}`}</Button></Group>
  </Stack></Modal>;
}
