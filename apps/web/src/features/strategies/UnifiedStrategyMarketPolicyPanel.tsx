import { useState } from "react";
import { Accordion, Alert, Badge, Button, Card, Checkbox, Group, Modal, Radio, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMarketPolicyActions, useStrategyMarketPolicy } from "./hooks";
import type { MarketPolicyDimension, MarketPolicyRevision, MarketPolicyRuleDraft, MarketPolicyValidation } from "./types";

const label = (value: string) => value.replaceAll("_", " ");
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const persistedDraft = (revision: MarketPolicyRevision): MarketPolicyRuleDraft[] => revision.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.requirement, allowedStates: rule.allowedStates.map(item => item.state).sort() }));
const effectiveRule = (rule: MarketPolicyRuleDraft) => ({ ...rule, allowedStates: rule.requirement === "REQUIRED" ? [...new Set(rule.allowedStates)].sort() : [] });
const canonicalRule = (rule: MarketPolicyRuleDraft) => JSON.stringify(effectiveRule(rule));
const ruleSummary = (rule: MarketPolicyRuleDraft) => rule.requirement === "IGNORED"
  ? "IGNORED"
  : `REQUIRED · Allowed: ${effectiveRule(rule).allowedStates.join(", ") || "none"}`;

function ConfigurationSummary({ revision }: { revision: MarketPolicyRevision }) {
  return <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">{revision.dimensionRules.map(rule => <Card key={rule.dimension} withBorder padding="sm">
    <Group justify="space-between"><Text fw={600}>{label(rule.dimension)}</Text><Badge color={rule.requirement === "REQUIRED" ? "blue" : "gray"}>{rule.requirement}</Badge></Group>
    <Text size="xs" ff="monospace" c="dimmed">{rule.algorithmVersion}</Text>
    <Text size="sm" mt={4}>{rule.requirement === "REQUIRED" ? `Allowed: ${rule.allowedStates.map(item => item.state).join(", ")}` : "Ignored; contributes no eligibility."}</Text>
  </Card>)}</SimpleGrid>;
}

export function StrategyMarketPolicyPanel({ strategyId, token, isOwner }: { strategyId: number; token: string | null; isOwner: boolean }) {
  const query = useStrategyMarketPolicy(strategyId, token); const actions = useMarketPolicyActions(token);
  const [draft, setDraft] = useState<MarketPolicyRuleDraft[]>([]);
  const [baseline, setBaseline] = useState<MarketPolicyRuleDraft[]>([]);
  const [retainedStates, setRetainedStates] = useState<Partial<Record<MarketPolicyDimension, string[]>>>({});
  const [validation, setValidation] = useState<MarketPolicyValidation | null>(null); const [confirming, setConfirming] = useState(false);
  const policy = query.data?.policy; const active = policy?.revisions.find(item => item.status === "ACTIVE"); const prepared = policy?.revisions.find(item => item.status === "PREPARED");
  const preparedConfigurationKey = prepared ? `${prepared.id}:${prepared.configurationFingerprint}` : null;
  const [loadedConfigurationKey, setLoadedConfigurationKey] = useState<string | null>(null);
  if (loadedConfigurationKey !== preparedConfigurationKey) {
    setLoadedConfigurationKey(preparedConfigurationKey);
    const next = prepared ? persistedDraft(prepared) : [];
    setDraft(next);
    setBaseline(next);
    setRetainedStates(Object.fromEntries(next.map(rule => [rule.dimension, rule.allowedStates])));
    setValidation(null);
  }
  const persistedRules = baseline;
  const changedDimensions = draft.filter(rule => {
    const persisted = persistedRules.find(item => item.dimension === rule.dimension);
    return Boolean(persisted) && canonicalRule(rule) !== canonicalRule(persisted!);
  }).map(rule => rule.dimension);
  const dirty = changedDimensions.length > 0;
  const draftErrors = Object.fromEntries(draft.flatMap(rule => {
    if (rule.requirement === "IGNORED") return [];
    const vocabulary = query.data?.supportedDimensions.find(item => item.dimension === rule.dimension)?.allowedStates ?? [];
    if (rule.allowedStates.length === 0) return [[rule.dimension, "Select at least one allowed effective state."]];
    const invalidStates = rule.allowedStates.filter(state => !vocabulary.includes(state));
    return invalidStates.length > 0 ? [[rule.dimension, `Invalid effective state: ${invalidStates.join(", ")}.`]] : [];
  })) as Partial<Record<MarketPolicyDimension, string>>;
  const draftValid = Object.keys(draftErrors).length === 0;
  const activationReady = Boolean(prepared && validation?.valid && validation.configurationFingerprint === prepared.configurationFingerprint && !dirty);
  const busy = actions.create.isPending || actions.prepare.isPending || actions.saveRevision.isPending || actions.validate.isPending || actions.activate.isPending;
  const notifyError = (error: unknown) => notifications.show({ title: "Market policy update failed", message: error instanceof Error ? error.message : "Unable to update policy.", color: "red" });
  function changeRule(dimension: MarketPolicyDimension, update: (rule: MarketPolicyRuleDraft) => MarketPolicyRuleDraft) { setDraft(current => current.map(rule => rule.dimension === dimension ? update(rule) : rule)); setValidation(null); }
  function discard() { if (!prepared) return; const next = baseline; setDraft(next); setRetainedStates(Object.fromEntries(next.map(rule => [rule.dimension, rule.allowedStates]))); setValidation(null); }
  async function save() {
    if (!prepared || !dirty || !draftValid || prepared.status !== "PREPARED") return;
    try {
      const rules = draft.map(rule => ({ ...rule, allowedStates: rule.requirement === "REQUIRED" ? rule.allowedStates : [] }));
      const saved = await actions.saveRevision.mutateAsync({ id: strategyId, revisionId: prepared.id, expectedConfigurationFingerprint: prepared.configurationFingerprint, rules });
      const next = persistedDraft(saved); setDraft(next); setBaseline(next); setRetainedStates(Object.fromEntries(next.map(rule => [rule.dimension, rule.allowedStates]))); setValidation(null);
      notifications.show({ message: `Revision ${saved.revision} saved atomically.`, color: "teal" });
    } catch (error) { notifyError(error); }
  }
  async function validate() { if (!prepared || dirty) return; try { const result = await actions.validate.mutateAsync({ id: strategyId, revisionId: prepared.id }); setValidation(result); if (result.valid) notifications.show({ message: `Revision ${result.revision} is valid and ready to activate.`, color: "teal" }); } catch (error) { notifyError(error); } }
  async function activate() { if (!prepared || !activationReady || !validation) return; try { await actions.activate.mutateAsync({ id: strategyId, revisionId: prepared.id, expectedConfigurationFingerprint: validation.configurationFingerprint }); setConfirming(false); setValidation(null); notifications.show({ message: `Revision ${prepared.revision} activated in shadow-only mode.`, color: "teal" }); } catch (error) { setConfirming(false); setValidation(null); notifyError(error); } }
  if (query.isLoading) return <Card withBorder><Text>Loading market eligibility policy…</Text></Card>;
  if (query.isError || !query.data) return <Alert color="red">{query.error instanceof Error ? query.error.message : "Unable to load market eligibility policy."}</Alert>;
  return <Card withBorder><Stack gap="md">
    <Group justify="space-between" align="flex-start"><div><Title order={3} size="h4">Market eligibility policy</Title><Text size="sm" c="dimmed">Versioned strategy-owned market-state configuration. This milestone does not evaluate or enforce eligibility.</Text></div><Badge color="violet">SHADOW ONLY</Badge></Group>
    {!policy ? <Alert color="blue" title="No market policy"><Text size="sm">A missing active policy will later mean insufficient evidence in shadow evaluation.</Text>{isOwner && <Button mt="sm" size="xs" loading={actions.create.isPending} onClick={() => void actions.create.mutateAsync(strategyId).catch(notifyError)}>Create policy</Button>}</Alert> : <>
      <Card withBorder><Group justify="space-between"><div><Text size="xs" c="dimmed">ACTIVE REVISION</Text><Text fw={700}>{active ? `Revision ${active.revision}` : "No active revision"}</Text><Text size="xs" c="dimmed">{active ? `Activated ${dateTime(active.activatedAt)}` : "Shadow evaluation will later report insufficient evidence."}</Text></div>{isOwner && !prepared && <Button size="xs" variant="light" loading={actions.prepare.isPending} onClick={() => void actions.prepare.mutateAsync(strategyId).catch(notifyError)}>Prepare new revision</Button>}</Group></Card>
      {prepared && <Stack gap="sm"><Group justify="space-between" align="flex-start"><div><Group gap="xs"><Text fw={700}>Prepared revision {prepared.revision}</Text>{dirty && <Badge color="yellow">{changedDimensions.length} {changedDimensions.length === 1 ? "dimension" : "dimensions"} changed</Badge>}</Group><Text size="xs" c="dimmed">All five dimensions save together as one atomic revision.</Text></div><Group><Button size="xs" variant="default" disabled={!dirty || busy} onClick={discard}>Discard changes</Button><Button size="xs" disabled={!dirty || !draftValid || busy || !isOwner || prepared.status !== "PREPARED"} loading={actions.saveRevision.isPending} onClick={() => void save()}>Save revision</Button><Button size="xs" variant="default" disabled={dirty || busy} onClick={() => void validate()} loading={actions.validate.isPending}>Validate</Button><Button size="xs" disabled={!activationReady || busy} onClick={() => setConfirming(true)}>Activate</Button></Group></Group>
        {dirty && <Alert color="yellow" title={`${changedDimensions.length} unsaved ${changedDimensions.length === 1 ? "dimension" : "dimensions"}`}>Validate and Activate are unavailable until the complete revision is saved.</Alert>}
        {!draftValid && <Alert color="red" title="Draft validation errors">Complete every REQUIRED dimension before saving. All-IGNORED drafts may still be saved, but cannot be activated.</Alert>}
        {validation && !validation.valid && <Alert color="red" title="Resolve validation errors before activation">{validation.errors.map((error, i) => <Text size="sm" key={`${error.code}-${i}`}>{error.dimension ? `${label(error.dimension)}: ` : ""}{error.message}</Text>)}</Alert>}
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">{draft.map(rule => { const vocabulary = query.data.supportedDimensions.find(item => item.dimension === rule.dimension)?.allowedStates ?? []; const persisted = persistedRules.find(item => item.dimension === rule.dimension); const changed = changedDimensions.includes(rule.dimension); return <Card key={rule.dimension} withBorder padding="sm"><Stack gap="sm">
          <Group justify="space-between"><div><Group gap="xs"><Text fw={700}>{label(rule.dimension)}</Text>{changed && <Badge color="yellow" variant="light">Changed</Badge>}</Group><Text size="xs" ff="monospace" c="dimmed">{rule.algorithmVersion}</Text></div><Badge color={rule.requirement === "REQUIRED" ? "blue" : "gray"}>{rule.requirement}</Badge></Group>
          {changed && persisted && <Text size="xs" c="dimmed"><Text component="span" inherit fw={600}>Before:</Text> {ruleSummary(persisted)}<br /><Text component="span" inherit fw={600}>After:</Text> {ruleSummary(rule)}</Text>}
          <Radio.Group value={rule.requirement} onChange={(value) => { const requirement = value as "REQUIRED" | "IGNORED"; changeRule(rule.dimension, current => ({ ...current, requirement, allowedStates: requirement === "REQUIRED" ? (retainedStates[rule.dimension] ?? current.allowedStates) : current.allowedStates })); }}><Group><Radio value="REQUIRED" label="Required" disabled={!isOwner} /><Radio value="IGNORED" label="Ignored" disabled={!isOwner} /></Group></Radio.Group>
          {rule.requirement === "REQUIRED" ? <Checkbox.Group value={rule.allowedStates} onChange={states => { setRetainedStates(current => ({ ...current, [rule.dimension]: states })); changeRule(rule.dimension, current => ({ ...current, allowedStates: states })); }} label="Allowed effective states" description="At least one state is required." error={draftErrors[rule.dimension]}><Group mt="xs">{vocabulary.map(state => <Checkbox key={state} value={state} label={state} disabled={!isOwner} />)}</Group></Checkbox.Group> : <Text size="sm" c="dimmed">Ignored dimensions do not grant eligibility. In-progress selections return if you switch back to REQUIRED before saving or discarding.</Text>}
        </Stack></Card>; })}</SimpleGrid>
      </Stack>}
      <Accordion variant="contained"><Accordion.Item value="history"><Accordion.Control>Revision history ({policy.revisions.length})</Accordion.Control><Accordion.Panel><Stack gap="md">{policy.revisions.map(revision => <Card key={revision.id} withBorder padding="sm"><Group justify="space-between"><div><Text fw={600}>Revision {revision.revision}</Text><Text size="xs" c="dimmed">Activated {dateTime(revision.activatedAt)} · Retired {dateTime(revision.retiredAt)}</Text></div><Group><Badge color="violet">SHADOW ONLY</Badge><Badge color={revision.status === "ACTIVE" ? "teal" : revision.status === "PREPARED" ? "blue" : "gray"}>{revision.status}</Badge></Group></Group><ConfigurationSummary revision={revision} /></Card>)}</Stack></Accordion.Panel></Accordion.Item></Accordion>
    </>}
    <Modal opened={confirming} onClose={() => !actions.activate.isPending && setConfirming(false)} title={`Activate revision ${prepared?.revision ?? ""}?`} centered size="xl"><Stack><Alert color="violet">This activates SHADOW ONLY configuration. It creates no decision records and changes no trading behavior.</Alert>{prepared && <ConfigurationSummary revision={prepared} />}<Text size="sm">The currently active revision, if any, will be retired atomically. This exact validated configuration becomes immutable.</Text><Group justify="flex-end"><Button variant="default" onClick={() => setConfirming(false)}>Cancel</Button><Button loading={actions.activate.isPending} onClick={() => void activate()}>Confirm activation</Button></Group></Stack></Modal>
  </Stack></Card>;
}
