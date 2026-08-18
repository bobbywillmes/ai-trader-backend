import { useState } from "react";
import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useGrantLiveWriteApproval, useLiveWriteApprovals, useRevokeLiveWriteApproval } from "../../../hooks";
import type { LiveWriteCapability, TradingAccount, TradingAccountReadinessAssessment } from "../../../types";

function CapabilityCard({ account, token, capability, latest }: {
  account: Pick<TradingAccount, "id" | "status" | "tradingEnabled" | "killSwitchEnabled">;
  token: string | null; capability: LiveWriteCapability;
  latest: TradingAccountReadinessAssessment | null;
}) {
  const state = useLiveWriteApprovals(account.id, token);
  const grant = useGrantLiveWriteApproval(account.id, token);
  const revoke = useRevokeLiveWriteApproval(account.id, token);
  const item = state.data?.capabilities.find((candidate) => candidate.capability === capability);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [expirationIsFuture, setExpirationIsFuture] = useState(false);
  const revision = item?.approval?.revision ?? 0;
  const expectedConfirmation = `APPROVE LIVE ${capability}`;
  const expiration = expiresAt ? new Date(expiresAt) : null;
  const isDisarmedLatch = !account.tradingEnabled && account.killSwitchEnabled;
  const readinessMatches = capability === "ENTRY"
    ? latest?.purpose === "LIVE_ENTRY_ARMING" &&
      latest.evidence.prerequisitesForEntryGrantPassed === true
    : (account.status === "PAUSED" &&
        isDisarmedLatch &&
        latest?.purpose === "LIVE_ACTIVATION") ||
      (account.status === "ACTIVE" &&
        isDisarmedLatch &&
        latest?.purpose === "LIVE_ENTRY_ARMING" &&
        latest.evidence.prerequisitesForRiskReducingGrantPassed === true);
  const canGrant = Boolean(
    state.data?.deploymentCanWrite === true &&
    latest?.validity === "CURRENT" &&
    item?.fingerprints &&
    reason.trim() &&
    confirmation === expectedConfirmation &&
    !grant.isPending &&
    !revoke.isPending &&
    isDisarmedLatch &&
    readinessMatches &&
    (capability !== "ENTRY" || expirationIsFuture),
  );
  const clearForm = () => {
    setReason("");
    setConfirmation("");
    setExpiresAt("");
    setExpirationIsFuture(false);
  };
  const resetErrors = () => {
    grant.reset();
    revoke.reset();
  };
  const grantRequirements = [
    ["Deployment permits Live writes", state.data?.deploymentCanWrite === true],
    ["Account is entry-disarmed", isDisarmedLatch],
    ["Lifecycle-appropriate readiness is selected", readinessMatches],
    ["Readiness is current", latest?.validity === "CURRENT"],
    ["Expected fingerprints are available", Boolean(item?.fingerprints)],
    ["Reason is entered", Boolean(reason.trim())],
    [`Exact ${expectedConfirmation} confirmation is entered`, confirmation === expectedConfirmation],
    ...(capability === "ENTRY" ? [["Expiration is valid and in the future", expirationIsFuture] as const] : []),
    ["No approval operation is pending", !grant.isPending && !revoke.isPending],
  ] as const;

  return <Card withBorder>
    <Group justify="space-between"><Title order={4}>{capability.replace("_", " ")}</Title>
      <Badge color={item?.effective ? "green" : "red"}>{item?.effective ? "Effective" : item?.reason ?? "Missing"}</Badge>
    </Group>
    <Text size="sm" mt="xs">Stored status: {item?.approval?.status ?? "NONE"} · revision {revision}</Text>
    <Text size="sm">Granted: {item?.approval?.grantedAt ? new Date(item.approval.grantedAt).toLocaleString() : "never"}</Text>
    <Text size="sm">Expires: {item?.approval?.expiresAt ? new Date(item.approval.expiresAt).toLocaleString() : "no expiration"}</Text>
    {item?.approval?.invalidationReason && <Alert color="yellow" mt="sm">{item.approval.invalidationReason}</Alert>}
    {state.data?.deploymentCanWrite && <Stack gap="xs" mt="md">
      <TextInput label="Reason" value={reason} onChange={(event) => { resetErrors(); setReason(event.currentTarget.value); }} />
      <TextInput label={`Type ${expectedConfirmation}`} value={confirmation} onChange={(event) => { resetErrors(); setConfirmation(event.currentTarget.value); }} />
      {capability === "ENTRY" && <TextInput type="datetime-local" label="Expiration" value={expiresAt} onChange={(event) => {
        resetErrors();
        const value = event.currentTarget.value;
        const parsed = new Date(value);
        setExpiresAt(value);
        setExpirationIsFuture(Boolean(value && !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()));
      }} />}
      <Card withBorder><Text fw={700} size="sm">Requirements to Grant</Text>{grantRequirements.map(([label, met]) => <Text size="sm" c={met ? "green" : "dimmed"} key={label}>{met ? "✓" : "○"} {label}</Text>)}</Card>
      <Group>
        <Button disabled={!canGrant} loading={grant.isPending} onClick={() => item?.fingerprints && latest && grant.mutate({ capability, payload: {
          reason, typedConfirmation: confirmation, readinessAssessmentId: latest.id,
          expectedConfigurationFingerprint: item.fingerprints.configurationFingerprint,
          expectedCredentialFingerprint: item.fingerprints.credentialFingerprint,
          expectedRevision: revision,
          ...(capability === "ENTRY" ? { expiresAt: expiration!.toISOString() } : {}),
        } }, { onSuccess: () => { clearForm(); resetErrors(); } })}>Grant</Button>
        <Button color="red" variant="outline" disabled={!item?.approval || !reason.trim() || grant.isPending || revoke.isPending} loading={revoke.isPending}
          onClick={() => revoke.mutate({ capability, payload: { reason, expectedRevision: revision } }, { onSuccess: () => { clearForm(); resetErrors(); } })}>Revoke</Button>
      </Group>
    </Stack>}
    {(grant.isError || revoke.isError) && <Alert color="red" mt="sm">{(grant.error ?? revoke.error)?.message}</Alert>}
  </Card>;
}

export function LiveWriteAuthorizationCard({ account, token, latest }: {
  account: Pick<TradingAccount, "id" | "status" | "tradingEnabled" | "killSwitchEnabled">;
  token: string | null; latest: TradingAccountReadinessAssessment | null;
}) {
  const state = useLiveWriteApprovals(account.id, token);
  return <Stack gap="md">
    <Card withBorder>
      <Title order={3}>Live Write Authorization</Title>
      <Text size="sm" c="dimmed">Account-scoped authorization is separate from deployment policy and activation.</Text>
      {state.data?.deploymentRole === "OBSERVATION_ONLY" && <Alert color="blue" title="Observation Only" mt="sm">
        This deployment cannot grant approvals or perform Live broker writes.
      </Alert>}
    </Card>
    <SimpleGrid cols={{ base: 1, lg: 2 }}>
      <CapabilityCard account={account} token={token} capability="RISK_REDUCING" latest={latest} />
      <CapabilityCard account={account} token={token} capability="ENTRY" latest={latest} />
    </SimpleGrid>
    <Card withBorder><Title order={4} mb="sm">Approval history</Title>
      <Table striped><Table.Thead><Table.Tr><Table.Th>Time</Table.Th><Table.Th>Capability</Table.Th><Table.Th>Decision</Table.Th><Table.Th>Actor</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{(state.data?.history ?? []).map((decision) => <Table.Tr key={decision.id}>
          <Table.Td>{new Date(decision.createdAt).toLocaleString()}</Table.Td><Table.Td>{decision.capability}</Table.Td>
          <Table.Td>{decision.action}</Table.Td><Table.Td>{decision.actorUser?.name ?? decision.actorUser?.email ?? "System"}</Table.Td><Table.Td>{decision.reason}</Table.Td>
        </Table.Tr>)}</Table.Tbody></Table>
    </Card>
  </Stack>;
}
