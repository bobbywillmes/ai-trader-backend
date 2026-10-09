import { useState } from "react";
import { Accordion, Alert, Badge, Button, Card, Checkbox, Group, Modal, Radio, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMarketPolicyActions, useStrategyMarketPolicy } from "./hooks";
import type { MarketPolicyDimension, MarketPolicyRule, MarketPolicyValidation } from "./types";

const label = (value: string) => value.replaceAll("_", " ");
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

function RuleEditor({ strategyId, revisionId, rule, vocabulary, disabled, onSave }: { strategyId: number; revisionId: number; rule: MarketPolicyRule; vocabulary: readonly string[]; disabled: boolean; onSave: (value: { id: number; revisionId: number; dimension: MarketPolicyDimension; requirement: "REQUIRED" | "IGNORED"; allowedStates: string[] }) => Promise<unknown> }) {
  const [requirement, setRequirement] = useState(rule.requirement);
  const [states, setStates] = useState(rule.allowedStates.map(item => item.state));
  const effectiveStates = requirement === "IGNORED" ? [] : states;
  return <Card withBorder padding="sm"><Stack gap="sm">
    <Group justify="space-between"><div><Text fw={700}>{label(rule.dimension)}</Text><Text size="xs" ff="monospace" c="dimmed">{rule.algorithmVersion}</Text></div><Badge color={requirement === "REQUIRED" ? "blue" : "gray"}>{requirement}</Badge></Group>
    <Radio.Group value={requirement} onChange={(value) => { const next = value as "REQUIRED" | "IGNORED"; setRequirement(next); if (next === "IGNORED") setStates([]); }}><Group><Radio value="REQUIRED" label="Required" /><Radio value="IGNORED" label="Ignored" /></Group></Radio.Group>
    {requirement === "REQUIRED" && <Checkbox.Group value={states} onChange={setStates} label="Allowed effective states" description="At least one state is required."><Group mt="xs">{vocabulary.map(state => <Checkbox key={state} value={state} label={state} />)}</Group></Checkbox.Group>}
    <Group justify="flex-end"><Button size="xs" variant="light" disabled={disabled || (requirement === "REQUIRED" && effectiveStates.length === 0)} onClick={() => void onSave({ id: strategyId, revisionId, dimension: rule.dimension, requirement, allowedStates: effectiveStates })}>Save dimension</Button></Group>
  </Stack></Card>;
}

export function StrategyMarketPolicyPanel({ strategyId, token, isOwner }: { strategyId: number; token: string | null; isOwner: boolean }) {
  const query = useStrategyMarketPolicy(strategyId, token); const actions = useMarketPolicyActions(token);
  const [validation, setValidation] = useState<MarketPolicyValidation | null>(null); const [confirming, setConfirming] = useState(false);
  const policy = query.data?.policy; const active = policy?.revisions.find(item => item.status === "ACTIVE"); const prepared = policy?.revisions.find(item => item.status === "PREPARED");
  const busy = actions.create.isPending || actions.prepare.isPending || actions.saveRule.isPending || actions.validate.isPending || actions.activate.isPending;
  const notifyError = (error: unknown) => notifications.show({ title: "Market policy update failed", message: error instanceof Error ? error.message : "Unable to update policy.", color: "red" });
  async function validate() { if (!prepared) return; try { const result = await actions.validate.mutateAsync({ id: strategyId, revisionId: prepared.id }); setValidation(result); if (result.valid) notifications.show({ message: `Revision ${result.revision} is valid and ready to activate.`, color: "teal" }); } catch (error) { notifyError(error); } }
  async function activate() { if (!prepared) return; try { await actions.activate.mutateAsync({ id: strategyId, revisionId: prepared.id }); setConfirming(false); setValidation(null); notifications.show({ message: `Revision ${prepared.revision} activated in shadow-only mode.`, color: "teal" }); } catch (error) { notifyError(error); } }
  if (query.isLoading) return <Card withBorder><Text>Loading market eligibility policy…</Text></Card>;
  if (query.isError || !query.data) return <Alert color="red">{query.error instanceof Error ? query.error.message : "Unable to load market eligibility policy."}</Alert>;
  return <Card withBorder><Stack gap="md">
    <Group justify="space-between" align="flex-start"><div><Title order={3} size="h4">Market eligibility policy</Title><Text size="sm" c="dimmed">Versioned strategy-owned market-state configuration. This milestone does not evaluate or enforce eligibility.</Text></div><Badge color="violet">SHADOW ONLY</Badge></Group>
    {!policy ? <Alert color="blue" title="No market policy"><Text size="sm">A missing active policy will later mean insufficient evidence in shadow evaluation.</Text>{isOwner && <Button mt="sm" size="xs" loading={actions.create.isPending} onClick={() => void actions.create.mutateAsync(strategyId).catch(notifyError)}>Create policy</Button>}</Alert> : <>
      <Card withBorder bg="var(--mantine-color-dark-7)"><Group justify="space-between"><div><Text size="xs" c="dimmed">ACTIVE REVISION</Text><Text fw={700}>{active ? `Revision ${active.revision}` : "No active revision"}</Text><Text size="xs" c="dimmed">{active ? `Activated ${dateTime(active.activatedAt)}` : "Shadow evaluation will later report insufficient evidence."}</Text></div>{isOwner && !prepared && <Button size="xs" variant="light" loading={actions.prepare.isPending} onClick={() => void actions.prepare.mutateAsync(strategyId).catch(notifyError)}>Prepare new revision</Button>}</Group></Card>
      {prepared && <Stack gap="sm"><Group justify="space-between"><div><Text fw={700}>Prepared revision {prepared.revision}</Text><Text size="xs" c="dimmed">Only this revision is editable.</Text></div><Group><Button size="xs" variant="default" onClick={() => void validate()} loading={actions.validate.isPending}>Validate</Button><Button size="xs" disabled={!validation?.valid} onClick={() => setConfirming(true)}>Activate</Button></Group></Group>
        {validation && !validation.valid && <Alert color="red" title="Resolve validation errors before activation">{validation.errors.map((error, i) => <Text size="sm" key={`${error.code}-${i}`}>{error.dimension ? `${label(error.dimension)}: ` : ""}{error.message}</Text>)}</Alert>}
        {prepared.dimensionRules.map(rule => <RuleEditor key={rule.id} strategyId={strategyId} revisionId={prepared.id} rule={rule} vocabulary={query.data.supportedDimensions.find(item => item.dimension === rule.dimension)?.allowedStates ?? []} disabled={!isOwner || busy} onSave={async value => { try { await actions.saveRule.mutateAsync(value); setValidation(null); notifications.show({ message: `${label(value.dimension)} saved.`, color: "teal" }); } catch (error) { notifyError(error); } }} />)}
      </Stack>}
      <Accordion variant="contained"><Accordion.Item value="history"><Accordion.Control>Revision history ({policy.revisions.length})</Accordion.Control><Accordion.Panel><Stack gap="xs">{policy.revisions.map(revision => <Card key={revision.id} withBorder padding="sm"><Group justify="space-between"><Text fw={600}>Revision {revision.revision}</Text><Badge color={revision.status === "ACTIVE" ? "teal" : revision.status === "PREPARED" ? "blue" : "gray"}>{revision.status}</Badge></Group><Text size="xs" c="dimmed">Created {dateTime(revision.createdAt)} · Activated {dateTime(revision.activatedAt)} · Retired {dateTime(revision.retiredAt)}</Text><Text size="sm" mt="xs">{revision.dimensionRules.map(rule => `${label(rule.dimension)}: ${rule.requirement}${rule.requirement === "REQUIRED" ? ` (${rule.allowedStates.map(item => item.state).join(", ")})` : ""}`).join(" · ")}</Text></Card>)}</Stack></Accordion.Panel></Accordion.Item></Accordion>
    </>}
    <Modal opened={confirming} onClose={() => !actions.activate.isPending && setConfirming(false)} title={`Activate revision ${prepared?.revision ?? ""}?`} centered><Stack><Alert color="violet">This activates SHADOW ONLY configuration. It creates no decision records and changes no trading behavior.</Alert><Text size="sm">The currently active revision, if any, will be retired atomically. Activated policy evidence is immutable.</Text><Group justify="flex-end"><Button variant="default" onClick={() => setConfirming(false)}>Cancel</Button><Button loading={actions.activate.isPending} onClick={() => void activate()}>Confirm activation</Button></Group></Stack></Modal>
  </Stack></Card>;
}
