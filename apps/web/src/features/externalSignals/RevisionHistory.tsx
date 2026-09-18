import { useState } from "react";
import { Alert, Badge, Button, Card, Group, Modal, Stack, Text, Textarea, Select, Checkbox } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { DataState } from "../../components/data-display";
import { useRevisions, useRevisionMutation } from "./hooks";
import { CopyValue } from "./components";
import { stamp } from "./presentation";
import { authorityModes, type AuthorityMode, type Binding, type Revision } from "./types";

export function RevisionHistory({ binding, token }: { binding: Binding; token: string | null }) {
  const history = useRevisions(binding.id, token);
  const [dialog, setDialog] = useState<{ action: "prepare" | "activate" | "retire" | "authority"; revision?: Revision } | null>(null);
  const [note, setNote] = useState("");
  const [authorityMode, setAuthorityMode] = useState<AuthorityMode>("EVIDENCE_ONLY");
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useRevisionMutation(binding.id, token);
  const submit = () => dialog && mutation.mutate({ action: dialog.action, revisionId: dialog.revision?.id ?? null, changeNote: note, ...((dialog.action === "prepare" || dialog.action === "authority") ? { authority: { authorityMode, confirmTradeEligible: confirmed } } : {}) }, {
    onSuccess: () => { setDialog(null); setNote(""); notifications.show({ color: "teal", message: "Revision lifecycle updated." }); },
    onError: () => { void history.refetch(); },
  });
  const active = history.data?.find(row => row.status === "ACTIVE");
  const prepared = history.data?.find(row => row.status === "PREPARED");
  const next = (history.data?.[0]?.revision ?? 0) + 1;
  const open = (action: "prepare" | "activate" | "retire" | "authority", revision?: Revision) => { mutation.reset(); setNote(""); setConfirmed(false); setAuthorityMode(revision?.authorityMode ?? active?.authorityMode ?? "EVIDENCE_ONLY"); setDialog({ action, revision }); };
  const editingAuthority = dialog?.action === "prepare" || dialog?.action === "authority";
  const requiresConfirmation = (editingAuthority && authorityMode === "TRADE_ELIGIBLE" && authorityMode !== (dialog?.revision?.authorityMode ?? active?.authorityMode)) || (dialog?.action === "activate" && dialog.revision?.authorityMode === "TRADE_ELIGIBLE");
  return <Stack>
    <Text fw={600}>Revision history</Text>
    {history.isPending ? <DataState state="loading" message="Loading revisions…" /> : history.isError ? <DataState state="error" title="Unable to load revisions" onRetry={() => void history.refetch()} /> : <>
      <Text size="sm">Active revision: {active ? `Revision ${active.revision}` : "Unavailable — ingress fails closed"}</Text>
      {prepared && <Text size="sm">Prepared revision: Revision {prepared.revision}</Text>}
      <Button variant="light" disabled={Boolean(prepared) || !active} onClick={() => open("prepare")}>Prepare new revision</Button>
      {history.data.map(row => <Card withBorder key={row.id} padding="sm"><Stack gap="xs">
        <Group justify="space-between"><Text fw={600}>Revision {row.revision}</Text><Badge color={row.status === "ACTIVE" ? "teal" : row.status === "PREPARED" ? "blue" : "gray"}>{row.status}</Badge></Group>
        <Badge variant="light">{row.authorityMode}</Badge>
        <Text size="xs" c="dimmed">Created {stamp(row.createdAt)}{row.activatedAt && ` · Activated ${stamp(row.activatedAt)}`}{row.retiredAt && ` · Retired ${stamp(row.retiredAt)}`}</Text>
        {row.changeNote && <Text size="sm" style={{ overflowWrap: "anywhere" }}>{row.changeNote}</Text>}
        {row.status !== "RETIRED" && <CopyValue name="signal configuration" value={JSON.stringify({ externalStrategyKey: binding.externalStrategyKey, strategyRevision: row.revision }, null, 2)} />}
        {row.status === "PREPARED" && <><Text size="xs" c="dimmed">Configure your external sender with this identity before activation. Prepared revisions are not accepted yet.</Text><Group><Button variant="light" onClick={() => open("authority", row)}>Change authority</Button><Button onClick={() => open("activate", row)}>Activate revision {row.revision}</Button><Button variant="subtle" color="gray" onClick={() => open("retire", row)}>Abandon revision {row.revision}</Button></Group></>}
      </Stack></Card>)}
    </>}
    <Modal opened={Boolean(dialog)} onClose={() => !mutation.isPending && setDialog(null)} title={dialog?.action === "prepare" ? "Prepare new revision" : dialog?.action === "authority" ? "Change prepared authority" : `${dialog?.action === "activate" ? "Activate" : "Abandon"} revision ${dialog?.revision?.revision}`} centered closeOnClickOutside={!mutation.isPending} closeOnEscape={!mutation.isPending} withCloseButton={!mutation.isPending}>
      <Stack>
        {dialog?.action === "prepare" ? <><Text fw={600}>New revision</Text><Text>Revision {next} will be prepared.</Text><Text size="sm" c="dimmed">AI Trader assigns the number when saved. Prepare, configure your external sender, then activate.</Text><Textarea label="Change note" description="Optional historical context. Do not include credentials." maxLength={500} value={note} onChange={event => setNote(event.currentTarget.value)} disabled={mutation.isPending} /></> : dialog?.action === "activate" ? <Text>Revision {dialog.revision?.revision} will become the only accepted revision for future signals. Revision {active?.revision} will be retired immediately. Signals still sending revision {active?.revision} will be rejected. Historical Signals are not changed.</Text> : dialog?.action === "authority" ? <Text>Only this prepared revision can change authority. Activation freezes the selected authority.</Text> : <Text>This prepared revision will be retired without activation. Its number will never be reused. The active revision and historical Signals are not changed.</Text>}
        {editingAuthority && <><Text size="sm">Inherited authority: {active?.authorityMode}. Authority controls routing only in this phase.</Text><Select label="Authority mode" data={[...authorityModes]} value={authorityMode} onChange={value => { setAuthorityMode(value as AuthorityMode); setConfirmed(false); }} disabled={mutation.isPending} allowDeselect={false} /><Text size="sm">EVIDENCE_ONLY stops before fan-out. EVALUATION_ONLY and TRADE_ELIGIBLE record account routes and stop.</Text></>}
        {requiresConfirmation && <Alert color="orange" title="Future trading authority"><Text size="sm">This revision may be allowed to reach trading in a future phase after additional gates. The current implementation still cannot create trades and stops at routing evidence.</Text><Checkbox mt="sm" label="I deliberately confirm TRADE_ELIGIBLE authority" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} disabled={mutation.isPending} /></Alert>}
        {mutation.isError && <Alert color="red" role="alert">Unable to change revision. Refresh history and check that another operator has not changed its state. Notes must not contain credentials.</Alert>}
        <Group justify="flex-end"><Button variant="default" disabled={mutation.isPending} onClick={() => setDialog(null)}>Cancel</Button><Button loading={mutation.isPending} disabled={Boolean(requiresConfirmation && !confirmed)} onClick={submit}>{dialog?.action === "prepare" ? "Prepare revision" : dialog?.action === "authority" ? "Save authority" : dialog?.action === "activate" ? "Confirm activation" : "Confirm abandonment"}</Button></Group>
      </Stack>
    </Modal>
  </Stack>;
}
