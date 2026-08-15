import { useState } from "react";
import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useGrantLiveWriteApproval, useLiveWriteApprovals, useRevokeLiveWriteApproval } from "../../../hooks";
import type { LiveWriteCapability, TradingAccountReadinessAssessment } from "../../../types";

function CapabilityCard({ accountId, token, capability, latest }: {
  accountId: number; token: string | null; capability: LiveWriteCapability;
  latest: TradingAccountReadinessAssessment | null;
}) {
  const state = useLiveWriteApprovals(accountId, token);
  const grant = useGrantLiveWriteApproval(accountId, token);
  const revoke = useRevokeLiveWriteApproval(accountId, token);
  const item = state.data?.capabilities.find((candidate) => candidate.capability === capability);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const revision = item?.approval?.revision ?? 0;
  const canGrant = Boolean(state.data?.deploymentCanWrite && latest && item?.fingerprints);

  return <Card withBorder>
    <Group justify="space-between"><Title order={4}>{capability.replace("_", " ")}</Title>
      <Badge color={item?.effective ? "green" : "red"}>{item?.effective ? "Effective" : item?.reason ?? "Missing"}</Badge>
    </Group>
    <Text size="sm" mt="xs">Stored status: {item?.approval?.status ?? "NONE"} · revision {revision}</Text>
    <Text size="sm">Granted: {item?.approval?.grantedAt ? new Date(item.approval.grantedAt).toLocaleString() : "never"}</Text>
    <Text size="sm">Expires: {item?.approval?.expiresAt ? new Date(item.approval.expiresAt).toLocaleString() : "no expiration"}</Text>
    {item?.approval?.invalidationReason && <Alert color="yellow" mt="sm">{item.approval.invalidationReason}</Alert>}
    {state.data?.deploymentCanWrite && <Stack gap="xs" mt="md">
      <TextInput label="Reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
      <TextInput label={`Type APPROVE LIVE ${capability}`} value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} />
      {capability === "ENTRY" && <TextInput type="datetime-local" label="Expiration" value={expiresAt} onChange={(event) => setExpiresAt(event.currentTarget.value)} />}
      <Group>
        <Button disabled={!canGrant || !reason} loading={grant.isPending} onClick={() => item?.fingerprints && latest && grant.mutate({ capability, payload: {
          reason, typedConfirmation: confirmation, readinessAssessmentId: latest.id,
          expectedConfigurationFingerprint: item.fingerprints.configurationFingerprint,
          expectedCredentialFingerprint: item.fingerprints.credentialFingerprint,
          expectedRevision: revision,
          ...(capability === "ENTRY" ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        } })}>Grant</Button>
        <Button color="red" variant="outline" disabled={!item?.approval || !reason} loading={revoke.isPending}
          onClick={() => revoke.mutate({ capability, payload: { reason, expectedRevision: revision } })}>Revoke</Button>
      </Group>
    </Stack>}
    {(grant.isError || revoke.isError) && <Alert color="red" mt="sm">{(grant.error ?? revoke.error)?.message}</Alert>}
  </Card>;
}

export function LiveWriteAuthorizationCard({ accountId, token, latest }: {
  accountId: number; token: string | null; latest: TradingAccountReadinessAssessment | null;
}) {
  const state = useLiveWriteApprovals(accountId, token);
  return <Stack gap="md">
    <Card withBorder>
      <Title order={3}>Live Write Authorization</Title>
      <Text size="sm" c="dimmed">Account-scoped authorization is separate from deployment policy and activation.</Text>
      {state.data?.deploymentRole === "OBSERVATION_ONLY" && <Alert color="blue" title="Observation Only" mt="sm">
        This deployment cannot grant approvals or perform Live broker writes.
      </Alert>}
    </Card>
    <SimpleGrid cols={{ base: 1, lg: 2 }}>
      <CapabilityCard accountId={accountId} token={token} capability="RISK_REDUCING" latest={latest} />
      <CapabilityCard accountId={accountId} token={token} capability="ENTRY" latest={latest} />
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
