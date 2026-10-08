import { Alert, Anchor, Card, Group, SimpleGrid, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { DataState } from "../../components/data-display";
import { DimensionSummaryCard } from "./DimensionSummaryCard";
import { useMarketIntelligenceSummary } from "./hooks";
import type { DimensionKey } from "./types";
const names: Record<DimensionKey, string> = { trend: "Trend", volatility: "Volatility", breadth: "Breadth", participation: "Participation", intradayStress: "Intraday Stress" };
export function DashboardMarketIntelligence({ enabled }: { enabled: boolean }) {
  const query = useMarketIntelligenceSummary(enabled); const data = query.data; if (!enabled) return null;
  return <Card withBorder p="md"><Group justify="space-between" mb="md"><div><Text fw={700}>Market Intelligence</Text><Text size="xs" c="dimmed">Independent production observations · no trading authority</Text></div><Anchor component={Link} to="/market-intelligence">View details</Anchor></Group>
    {query.isLoading ? <DataState state="loading" message="Loading intelligence…" /> : query.isError ? <Alert color="red" title="Market intelligence unavailable">{query.error.message}</Alert> : data ? <SimpleGrid cols={{ base: 1, xs: 2, lg: 5 }}>{(Object.keys(names) as DimensionKey[]).map(key => <DimensionSummaryCard key={key} dimension={key} compact title={names[key]} summary={data.dimensions[key]} />)}</SimpleGrid> : <DataState state="empty" title="Market intelligence unavailable" />}
  </Card>;
}
