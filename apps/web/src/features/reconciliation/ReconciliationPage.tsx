import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";

import { getAdminToken } from "../../lib/api";
import { useRunReconciliation } from "./hooks";
import type { ReconciliationFinding } from "./api";

function getSeverityColor(severity: string) {
  switch (severity) {
    case "critical":
      return "red";
    case "warn":
      return "yellow";
    default:
      return "blue";
  }
}

function FindingDetails({ finding }: { finding: ReconciliationFinding }) {
  const details = finding.details ?? {};

  if (Object.keys(details).length === 0 && !finding.attentionCode) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }

  return (
    <Stack gap={4}>
      {finding.attentionCode && (
        <Text size="xs" c="dimmed">
          Attention: <Code>{finding.attentionCode}</Code>
        </Text>
      )}

      {Object.keys(details).length > 0 && (
        <Code block>{JSON.stringify(details, null, 2)}</Code>
      )}
    </Stack>
  );
}

export function ReconciliationPage() {
  const [token] = useState(() => getAdminToken());
  const runMutation = useRunReconciliation(token);
  const result = runMutation.data;

  function runDryRun() {
    runMutation.mutate({
      persistEvents: false,
      persistAttention: false,
    });
  }

  function runPersisted() {
    runMutation.mutate({
      persistEvents: true,
    });
  }

  return (
    <Stack gap="md">
      <div>
        <Title order={2}>Reconciliation</Title>
        <Text c="dimmed">
          Compare backend tracked positions and exit state against broker
          positions and open orders.
        </Text>
      </div>

      <Card withBorder>
        <Stack gap="md">
          <Group>
            <Button
              variant="light"
              onClick={runDryRun}
              loading={runMutation.isPending}
            >
              Run dry check
            </Button>

            <Button
              color="red"
              variant="light"
              onClick={runPersisted}
              loading={runMutation.isPending}
            >
              Persist events + attention
            </Button>
          </Group>

          <Text size="sm" c="dimmed">
            Dry checks return findings only. Persisted checks create SystemEvents
            and apply exit attention states for critical tracked-position
            findings.
          </Text>
        </Stack>
      </Card>

      {runMutation.isError && (
        <Alert color="red" title="Reconciliation failed">
          {runMutation.error instanceof Error
            ? runMutation.error.message
            : "Unknown reconciliation error."}
        </Alert>
      )}

      {result && (
        <Card withBorder>
          <Stack gap="md">
            <Group>
              <Badge color={result.dryRun ? "blue" : "green"}>
                {result.dryRun ? "Dry run" : "Persisted"}
              </Badge>

              <Badge color="gray">
                {result.findings.length} finding
                {result.findings.length !== 1 ? "s" : ""}
              </Badge>

              <Badge color="gray">{result.eventCount} event(s)</Badge>

              <Badge color="gray">
                {result.attentionUpdateCount} attention update(s)
              </Badge>

              <Badge color="gray">
                {result.skippedDuplicateEventCount} duplicate event(s) skipped
              </Badge>
            </Group>

            {result.findings.length === 0 ? (
              <Alert color="green" title="No reconciliation findings">
                Backend tracked positions, broker positions, and broker orders
                appear consistent for the current checks.
              </Alert>
            ) : (
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Severity</Table.Th>
                    <Table.Th>Code</Table.Th>
                    <Table.Th>Symbol</Table.Th>
                    <Table.Th>Entity</Table.Th>
                    <Table.Th>Message</Table.Th>
                    <Table.Th>Details</Table.Th>
                  </Table.Tr>
                </Table.Thead>

                <Table.Tbody>
                  {result.findings.map((finding, index) => (
                    <Table.Tr
                      key={`${finding.code}-${finding.entityId}-${index}`}
                    >
                      <Table.Td>
                        <Badge color={getSeverityColor(finding.severity)}>
                          {finding.severity}
                        </Badge>
                      </Table.Td>

                      <Table.Td>
                        <Code>{finding.code}</Code>
                      </Table.Td>

                      <Table.Td>{finding.symbol}</Table.Td>

                      <Table.Td>
                        <Text size="sm">{finding.entityType}</Text>
                        <Text size="xs" c="dimmed">
                          {finding.entityId}
                        </Text>
                      </Table.Td>

                      <Table.Td>{finding.message}</Table.Td>

                      <Table.Td>
                        <FindingDetails finding={finding} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}