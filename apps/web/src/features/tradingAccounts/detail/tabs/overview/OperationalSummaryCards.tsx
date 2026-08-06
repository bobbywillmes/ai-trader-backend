import { Alert, Badge, Button, Card, Group, Loader, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useLatestTradingAccountReadiness, useTradingAccountAllocations } from "../../../hooks";
import type { TradingAccount } from "../../../types";
import { DetailItem } from "../../components/DetailItem";
import { formatDateTime, formatMoney } from "../../utils/formatters";
import classes from "./OperationalSummaryCards.module.css";

export function OperationalSummaryCards({ account, token }: { account: TradingAccount; token: string | null }) {
  const readiness = useLatestTradingAccountReadiness(account.environment === "LIVE" ? account.id : undefined, token);
  const allocations = useTradingAccountAllocations(account.id, token);
  const assessment = readiness.data?.assessment ?? null;
  const buckets = allocations.data?.allocations ?? [];
  const entryCapable = buckets.reduce((total, bucket) => total + bucket.entryEnabledSubscriptionCount, 0);
  const primaryBlocker = assessment?.blockers[0];
  const allocationWarning = account.maxDeployableNotional !== null && account.enabledAllocatedNotional > account.maxDeployableNotional
    ? "Enabled allocation budgets exceed deployable capital."
    : buckets.some((bucket) => bucket.enabled && bucket.remainingAllocatedNotional !== null && bucket.remainingAllocatedNotional < 0)
      ? "At least one enabled allocation is over capacity."
      : null;

  return <SimpleGrid cols={{ base: 1, lg: 2 }}>
    <Card withBorder radius="md" p="lg"><Stack gap="md">
      <Group justify="space-between" align="flex-start"><div><Title order={3}>Entry &amp; Readiness</Title><Text size="sm" c="dimmed">Latest authoritative activation assessment.</Text></div>
        {assessment && <Group gap="xs"><Badge color={assessment.result === "PASSED" ? "green" : assessment.result === "BLOCKED" ? "red" : "yellow"}>{assessment.result}</Badge><Badge color={assessment.validity === "CURRENT" ? "green" : assessment.validity === "STALE" ? "yellow" : "red"}>{assessment.validity}</Badge></Group>}
      </Group>
      {account.environment !== "LIVE" ? <Alert color="gray" title="Not applicable">Live activation assessments are not required for paper accounts.</Alert>
        : readiness.isLoading ? <Group gap="sm"><Loader size="sm" /><Text size="sm" c="dimmed">Loading readiness summary…</Text></Group>
        : readiness.isError ? <Alert color="red" title="Readiness unavailable">The latest assessment could not be loaded.</Alert>
        : !assessment ? <Alert color="blue">No readiness assessment has been recorded.</Alert>
        : <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <DetailItem label="Current result" value={assessment.result} /><DetailItem label="Evidence state" value={assessment.validity} />
          <DetailItem label="Primary blocker" value={primaryBlocker?.message ?? "None"} /><DetailItem label="Blocking stage" value={assessment.stages.find((stage) => stage.blockerCount > 0)?.summary ?? "None"} />
          <DetailItem label="Evaluated" value={formatDateTime(assessment.completedAt)} /><DetailItem label="Expires" value={formatDateTime(assessment.expiresAt)} />
        </SimpleGrid>}
      <Button component="a" href="?tab=readiness" variant="subtle" className={classes.link}>View Readiness</Button>
    </Stack></Card>
    <Card withBorder radius="md" p="lg"><Stack gap="md">
      <Group justify="space-between" align="flex-start"><div><Title order={3}>Allocation Summary</Title><Text size="sm" c="dimmed">Current deployable capital assignment.</Text></div><Badge color={allocationWarning ? "yellow" : "blue"}>{buckets.length} {buckets.length === 1 ? "bucket" : "buckets"}</Badge></Group>
      {allocations.isLoading ? <Group gap="sm"><Loader size="sm" /><Text size="sm" c="dimmed">Loading allocation summary…</Text></Group>
        : allocations.isError ? <Alert color="red" title="Allocations unavailable">Allocation capacity could not be loaded.</Alert>
        : <><SimpleGrid cols={{ base: 1, sm: 2 }}>
          <DetailItem label="Enabled allocation budget" value={formatMoney(account.enabledAllocatedNotional, account.baseCurrency)} />
          <DetailItem label="Remaining deployable capacity" value={formatMoney(account.remainingDeployableNotional, account.baseCurrency)} />
          <DetailItem label="Assigned, entry-capable subscriptions" value={entryCapable.toLocaleString()} />
          <DetailItem label="Allocation buckets" value={buckets.length.toLocaleString()} />
        </SimpleGrid>{allocationWarning && <Alert color="yellow" title="Allocation warning">{allocationWarning}</Alert>}</>}
      <Group gap="xs"><Button component="a" href="?tab=configuration" variant="subtle" className={classes.link}>View Configuration</Button><Button component="a" href="?tab=subscriptions" variant="subtle" className={classes.link}>View Subscriptions</Button></Group>
    </Stack></Card>
  </SimpleGrid>;
}
